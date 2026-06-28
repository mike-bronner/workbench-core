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
echo 18760 > "$PORT_COUNTER"
next_port() {
  local n
  n=$(( $(cat "$PORT_COUNTER") + 1 ))
  echo "$n" > "$PORT_COUNTER"
  echo "$n"
}

# start_fake <port> <server_name> [extra env...] — launch the fixture and wait
# for it to actually accept connections (bounded), so the test never races bind.
start_fake() {
  local port="$1" name="$2"; shift 2
  MARKDOWN_VAULT_MCP_SERVER_NAME="$name" "$@" \
    bash "$FAKE" serve --transport http --host 127.0.0.1 --port "$port" --http-path /mcp \
    >/dev/null 2>&1 &
  local pid=$!
  FAKE_PIDS+=("$pid")
  # Wait up to ~3s for the port to open.
  local i=0
  while [ "$i" -lt 60 ]; do
    if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then exec 3>&- 2>/dev/null; return 0; fi
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

echo "bearer token is sent — probe still matches identity when auth is required:"
CACHE="$SANDBOX/auth"; mkdir -p "$CACHE"; printf 'secrettoken' > "$CACHE/server.token"
P=$(next_port); start_fake "$P" myvault; touch "$CACHE/vault-index.sqlite"
assert_status "token present, identity match → UP" "$(probe "$CACHE" "$P" myvault)" "UP"

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
