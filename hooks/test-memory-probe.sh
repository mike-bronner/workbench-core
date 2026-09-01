#!/bin/bash
# Tests for hooks/lib/memory-probe.sh — the identity-checked health probe.
# Run directly: ./test-memory-probe.sh
# Each case sets up a sandbox cache, optionally starts the fake server fixture on
# a free port with a chosen serverInfo.name, and asserts memory_probe's status
# word. No real server, no embeddings, no outbound network — only loopback to a
# python3 fake that binds in milliseconds.

set -u
HOOKS="$(cd "$(dirname "$0")" && pwd)"
PROBE_LIB="$HOOKS/lib/memory-probe.sh"
FAKE="$HOOKS/fixtures/fake-markdown-vault-mcp.sh"
PASS=0
FAIL=0

SANDBOX=$(mktemp -d)
FAKE_PIDS=()
cleanup() {
  for p in "${FAKE_PIDS[@]:-}"; do
    [ -n "$p" ] && kill "$p" 2>/dev/null
  done
  rm -rf "$SANDBOX"
}
trap cleanup EXIT

# Hand out a fresh loopback port per fake so cases never clash. The counter is
# file-backed: next_port runs in a command substitution (a subshell), so a
# plain shell variable increment would not persist to the parent — every call
# would return the same port. A file survives the subshell.
PORT_COUNTER="$SANDBOX/.port"
# Randomize the base. A fixed base (this was 18760) hands out the SAME ports on
# every run, so anything holding one of them — including a fake leaked by this
# suite's own earlier run — breaks it identically every time. Band chosen clear
# of the sibling suites' ranges.
echo $(( 40000 + (RANDOM % 15000) )) > "$PORT_COUNTER"
# port_is_free <port> — nothing is LISTENing on it. A connect probe is the right
# test (not a bind probe): the fixtures set SO_REUSEADDR, so a port in TIME_WAIT
# binds fine and only a live listener can actually collide.
port_is_free() {
  ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

next_port() {
  local n tries=0
  while [ "$tries" -lt 500 ]; do
    n=$(( $(cat "$PORT_COUNTER") + 1 )); echo "$n" > "$PORT_COUNTER"
    if port_is_free "$n"; then printf '%s' "$n"; return 0; fi
    tries=$((tries + 1))
  done
  # Fail closed and loudly. Handing back an occupied port produces a mystifying
  # red assertion far from here — the failure mode this guard exists to prevent.
  echo "FATAL: no free TCP port in 500 candidates" >&2
  kill -TERM $$
  return 1
}

# start_fake <port> <server_name> [VAR=value ...] — launch the fixture and wait
# for it to actually accept connections (bounded), so the test never races bind.
# Extra `VAR=value` knobs (e.g. FAKE_SERVER_SSE=1) are passed THROUGH `env`, not
# as a bash command prefix: an assignment arriving via "$@" expansion is parsed
# as a command NAME (→ "command not found"), so the fixture would never launch.
# `env VAR=value … cmd` interprets the assignments correctly.
start_fake() {
  local port="$1" name="$2"; shift 2
  env MARKDOWN_VAULT_MCP_SERVER_NAME="$name" "$@" \
    bash "$FAKE" serve --transport http --host 127.0.0.1 --port "$port" --http-path /mcp \
    >/dev/null 2>&1 &
  local pid=$!
  FAKE_PIDS+=("$pid")
  # Wait up to ~6s for the port to actually LISTEN. Use the socket table as the
  # readiness ground truth, not a bash /dev/tcp connect: /dev/tcp connects can
  # spuriously fail under a restricted-network sandbox even while the port is
  # genuinely bound, which would let the probe run before the fixture is
  # reachable. lsof ships with macOS; a stock Arch/Omarchy box has `ss` instead,
  # so probe for whichever exists rather than assuming lsof.
  local i=0
  while [ "$i" -lt 120 ]; do
    if command -v lsof >/dev/null 2>&1; then
      lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1 && return 0
    elif command -v ss >/dev/null 2>&1; then
      ss -Hltn "sport = :$port" 2>/dev/null | grep -q . && return 0
    else
      return 0   # no socket tool at all — fall through to the caller's own wait
    fi
    i=$((i + 1)); sleep 0.05
  done
  return 0
}

# probe <cache> <port> <name> — run memory_probe with the given resolved env.
probe() {
  local cache="$1" port="$2" name="$3"
  CACHE_PATH="$cache" MEMORY_PORT="$port" MCP_NAME="$name" \
    bash -c '. "'"$PROBE_LIB"'"; memory_probe'
}

assert_status() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc ($got)"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected $want, got $got"
  fi
}

echo "port allocator — hands out only free ports:"
# An occupied port here reads as a wrong probe STATUS several cases down, with
# nothing naming the real cause. Assert the allocator itself (2026-08-29).
ALLOC_PORT=$(( $(cat "$PORT_COUNTER") + 1 ))
python3 -c '
import socket, sys, time
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", int(sys.argv[1]))); s.listen(1)
print("ready", flush=True)
time.sleep(30)
' "$ALLOC_PORT" > "$SANDBOX/alloc.out" 2>/dev/null &
ALLOC_SQUAT=$!; FAKE_PIDS+=("$ALLOC_SQUAT")
disown 2>/dev/null || true
i=0; while [ "$i" -lt 100 ]; do grep -q ready "$SANDBOX/alloc.out" 2>/dev/null && break; i=$((i+1)); sleep 0.05; done
GOT=$(next_port)
assert_status "walks past an occupied port" \
  "$([ "$GOT" != "$ALLOC_PORT" ] && echo skipped || echo reused)" "skipped"
assert_status "the port it handed out is free" \
  "$(port_is_free "$GOT" && echo free || echo taken)" "free"
kill "$ALLOC_SQUAT" 2>/dev/null

echo "DOWN_NONE — nothing listening, no failure marker:"
CACHE="$SANDBOX/none"; mkdir -p "$CACHE"
assert_status "cold port reports DOWN_NONE" "$(probe "$CACHE" "$(next_port)" myvault)" "DOWN_NONE"

echo "DOWN_FAILED — nothing listening but last spawn left .server-failed:"
CACHE="$SANDBOX/failed"; mkdir -p "$CACHE"; touch "$CACHE/.server-failed"
assert_status "failed-spawn port reports DOWN_FAILED" "$(probe "$CACHE" "$(next_port)" myvault)" "DOWN_FAILED"

echo "BUILDING — our vault answers, but the index sqlite isn't on disk yet:"
CACHE="$SANDBOX/building"; mkdir -p "$CACHE"
P=$(next_port); start_fake "$P" myvault
assert_status "identity match + no index → BUILDING" "$(probe "$CACHE" "$P" myvault)" "BUILDING"

echo "UP — our vault answers and the index sqlite exists:"
touch "$CACHE/vault-index.sqlite"
assert_status "identity match + index present → UP" "$(probe "$CACHE" "$P" myvault)" "UP"

echo "DOWN_FOREIGN — a server is up but it is a DIFFERENT vault:"
CACHE="$SANDBOX/foreign"; mkdir -p "$CACHE"
P=$(next_port); start_fake "$P" some-other-vault
assert_status "serverInfo.name mismatch → DOWN_FOREIGN" "$(probe "$CACHE" "$P" myvault)" "DOWN_FOREIGN"

echo "DOWN_FOREIGN — a non-MCP process squats the port:"
CACHE="$SANDBOX/squatter"; mkdir -p "$CACHE"
P=$(next_port)
# A plain TCP listener that accepts connections but answers nothing meaningful:
# the probe's TCP pre-filter passes (port is open), but initialize gets no valid
# response → DOWN_FOREIGN. Accept in a loop with a real backlog so repeated
# connects (readiness check, then the probe itself) all succeed.
python3 -c 'import socket,sys,time
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
s.bind(("127.0.0.1",int(sys.argv[1]))); s.listen(16)
end=time.time()+10
while time.time()<end:
    s.settimeout(end-time.time())
    try:
        c,_=s.accept(); c.close()
    except OSError:
        break' "$P" >/dev/null 2>&1 &
FAKE_PIDS+=("$!")
i=0; while [ "$i" -lt 60 ]; do (exec 3<>"/dev/tcp/127.0.0.1/$P") 2>/dev/null && { exec 3>&- 2>/dev/null; break; }; i=$((i+1)); sleep 0.05; done
assert_status "non-MCP squatter → DOWN_FOREIGN" "$(probe "$CACHE" "$P" myvault)" "DOWN_FOREIGN"

echo "PORT_DRIFT — recorded server.port differs from the configured port:"
CACHE="$SANDBOX/drift"; mkdir -p "$CACHE"; echo 9999 > "$CACHE/server.port"
assert_status "server.port != MEMORY_PORT → PORT_DRIFT" "$(probe "$CACHE" 18700 myvault)" "PORT_DRIFT"

echo "SSE framing — server answers initialize as text/event-stream (event:/data:):"
# The real Streamable-HTTP transport replies with `text/event-stream`:
#   event: message
#   data: {json}
# The probe must strip the framing lines before jq, or a healthy server is
# misclassified DOWN_FOREIGN. Drive the fixture's SSE path and assert UP.
CACHE="$SANDBOX/sse"; mkdir -p "$CACHE"
P=$(next_port); start_fake "$P" myvault FAKE_SERVER_SSE=1; touch "$CACHE/vault-index.sqlite"
assert_status "SSE-framed initialize → UP (not DOWN_FOREIGN)" "$(probe "$CACHE" "$P" myvault)" "UP"

echo "bearer token actually reaches the server (token-validating fixture):"
# The fixture validates the Authorization header (FAKE_SERVER_REQUIRE_TOKEN), so
# these prove the probe's bearer token genuinely ARRIVES — not merely that the
# request succeeds. A rejected request gets a 401, which curl -fsS turns into an
# empty response, which the probe classifies DOWN_FOREIGN.
TOK='s3cr3t-probe-token'

CACHE="$SANDBOX/auth-ok"; mkdir -p "$CACHE"; printf '%s' "$TOK" > "$CACHE/server.token"
P=$(next_port); start_fake "$P" myvault FAKE_SERVER_REQUIRE_TOKEN="$TOK"; touch "$CACHE/vault-index.sqlite"
assert_status "correct token reaches the server → UP" "$(probe "$CACHE" "$P" myvault)" "UP"

CACHE="$SANDBOX/auth-missing"; mkdir -p "$CACHE"   # no server.token at all
P=$(next_port); start_fake "$P" myvault FAKE_SERVER_REQUIRE_TOKEN="$TOK"; touch "$CACHE/vault-index.sqlite"
assert_status "missing token → 401 → DOWN_FOREIGN" "$(probe "$CACHE" "$P" myvault)" "DOWN_FOREIGN"

CACHE="$SANDBOX/auth-wrong"; mkdir -p "$CACHE"; printf 'not-the-token' > "$CACHE/server.token"
P=$(next_port); start_fake "$P" myvault FAKE_SERVER_REQUIRE_TOKEN="$TOK"; touch "$CACHE/vault-index.sqlite"
assert_status "wrong token → 401 → DOWN_FOREIGN" "$(probe "$CACHE" "$P" myvault)" "DOWN_FOREIGN"

echo "no token under set -u — must not abort (bash 3.2 empty-array regression):"
# The probe is sourced by memory-server-up.sh / -spawn.sh, both `set -u`. With no
# token the auth must add NOTHING — but an empty "${auth[@]}" expansion is an
# unbound-variable abort on bash 3.2 (the macOS target; bash 4.4+ hides it, so
# Linux CI never catches it). The fix carries the token via a curl -K - stdin
# config and builds no array at all. Run the probe under `bash -u` with NO
# server.token and assert it still reaches UP instead of aborting mid-probe.
CACHE="$SANDBOX/notoken"; mkdir -p "$CACHE"
P=$(next_port); start_fake "$P" myvault; touch "$CACHE/vault-index.sqlite"
GOT=$(CACHE_PATH="$CACHE" MEMORY_PORT="$P" MCP_NAME=myvault \
  bash -uc '. "'"$PROBE_LIB"'"; memory_probe')
assert_status "no token + set -u → UP (no abort)" "$GOT" "UP"

echo "bearer token stays OFF curl argv (ps / /proc/<pid>/cmdline leak guard):"
# A -H "Authorization: Bearer <token>" argument is world-readable via ps; the
# token must travel through a curl -K - stdin config instead. Guard structurally
# so the leak cannot silently return.
# Check code only, not the explanatory comments (which name the -H form to warn
# against it).
if grep -vE '^[[:space:]]*#' "$PROBE_LIB" | grep -qE '[-]H[[:space:]].*Authorization: Bearer'; then
  FAIL=$((FAIL + 1)); echo "  ❌ token on -H argv — readable via ps"
else
  PASS=$((PASS + 1)); echo "  ✅ no Authorization token on curl argv"
fi
if grep -q -- '-K -' "$PROBE_LIB"; then
  PASS=$((PASS + 1)); echo "  ✅ token delivered via curl -K - stdin config"
else
  FAIL=$((FAIL + 1)); echo "  ❌ expected curl -K - stdin config for the token"
fi

echo "exit code mirrors health (0 for up, non-zero for down):"
CACHE="$SANDBOX/rc"; mkdir -p "$CACHE"
P=$(next_port); start_fake "$P" myvault; touch "$CACHE/vault-index.sqlite"
CACHE_PATH="$CACHE" MEMORY_PORT="$P" MCP_NAME=myvault bash -c '. "'"$PROBE_LIB"'"; memory_probe >/dev/null'
[ "$?" -eq 0 ] && { PASS=$((PASS+1)); echo "  ✅ UP exits 0"; } || { FAIL=$((FAIL+1)); echo "  ❌ UP should exit 0"; }
CACHE_PATH="$SANDBOX/none" MEMORY_PORT=18701 MCP_NAME=myvault bash -c '. "'"$PROBE_LIB"'"; memory_probe >/dev/null'
[ "$?" -ne 0 ] && { PASS=$((PASS+1)); echo "  ✅ DOWN exits non-zero"; } || { FAIL=$((FAIL+1)); echo "  ❌ DOWN should exit non-zero"; }

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
