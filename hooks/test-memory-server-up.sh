#!/bin/bash
# Tests for the lazy-start machinery: memory-server-up.sh (kicker) +
# memory-server-spawn.sh (supervisor), exercised end-to-end against the fake
# server fixture. Run directly: ./test-memory-server-up.sh
#
# Covers the spawn/lock/concurrency contract: already-up fast path, single-
# spawn under parallel kicks, stale-vs-live claimer handling, self-healing after
# a killed kick, the perl-setsid detach, refuse-to-bind failure recording,
# foreign-squatter conflict, and the always-exit-0 / always-empty-stdout rule.
#
# No real server, no embeddings, no outbound network: the fixture is a python3
# loopback stub that binds in milliseconds and answers MCP initialize.

set -u
HOOKS="$(cd "$(dirname "$0")" && pwd)"
UP="$HOOKS/memory-server-up.sh"
FAKE="$HOOKS/fixtures/fake-markdown-vault-mcp.sh"
REPO_ROOT="$(cd "$HOOKS/.." && pwd)"
PASS=0
FAIL=0

SANDBOX=$(mktemp -d)
STARTED_PIDS=()
cleanup() {
  # Kill any fake servers we spawned (recorded server.pid files + tracked pids).
  for f in "$SANDBOX"/*/cache/server.pid; do
    [ -f "$f" ] && kill "$(cat "$f" 2>/dev/null)" 2>/dev/null
  done
  for p in "${STARTED_PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
  rm -rf "$SANDBOX"
}
trap cleanup EXIT

# File-backed port counter (a plain var would not survive the $() subshell).
# Randomize the base per run so a server leaked by a previously crashed/killed
# run can't squat a port this run expects to be free (which would make a probe
# match the leftover and skip a spawn we're asserting on). Range stays in the
# high ephemeral band, well clear of the plugin's 8765 default.
PORT_BASE=$(( 20000 + (RANDOM % 20000) ))
PORT_COUNTER="$SANDBOX/.port"; echo "$PORT_BASE" > "$PORT_COUNTER"
next_port() {
  local n; n=$(( $(cat "$PORT_COUNTER") + 1 )); echo "$n" > "$PORT_COUNTER"; echo "$n"
}

# kick <case-dir> <port> <name> [extra env...] — run the kicker in a sandboxed
# env pointing at the fake server. Echoes the kicker's stdout (must be empty).
kick() {
  local dir="$1" port="$2" name="$3"; shift 3
  mkdir -p "$dir/cache" "$dir/vault"
  env -i HOME="$dir/home" PATH="$PATH" \
    CLAUDE_PLUGIN_ROOT="$REPO_ROOT" \
    WORKBENCH_MEMORY_CACHE="$dir/cache" \
    WORKBENCH_MEMORY_PATH="$dir/vault" \
    WORKBENCH_MCP_SERVER_NAME="$name" \
    WORKBENCH_MEMORY_PORT="$port" \
    WORKBENCH_MEMORY_SERVER_BIN="$FAKE" \
    "$@" \
    bash "$UP" 2>/dev/null
}

# wait_up <cache> <port> <name> — block (bounded) until the probe reports the
# server serving, so assertions don't race the detached supervisor.
wait_up() {
  local cache="$1" port="$2" name="$3" i=0
  while [ "$i" -lt 80 ]; do
    local s
    s=$(CACHE_PATH="$cache" MEMORY_PORT="$port" MCP_NAME="$name" \
      bash -c '. "'"$HOOKS"'/lib/memory-probe.sh"; memory_probe')
    case "$s" in UP|BUILDING) return 0 ;; esac
    i=$((i + 1)); sleep 0.1
  done
  return 1
}

# wait_lock_released <cache> — the supervisor releases the lock AFTER the server
# is ready, so a probe-based wait_up can return slightly before lock release.
# Poll for the lock to disappear (bounded) before asserting on it.
wait_lock_released() {
  local cache="$1" i=0
  while [ "$i" -lt 80 ]; do
    [ ! -d "$cache/server.lock" ] && return 0
    i=$((i + 1)); sleep 0.1
  done
  return 1
}

# wait_reparented <pid> — the server's parent (the supervisor) re-parents the
# server to init only once the supervisor itself exits, which happens just after
# lock release. Poll until PPID is 1 (bounded).
wait_reparented() {
  local pid="$1" i=0 ppid
  while [ "$i" -lt 80 ]; do
    ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    [ "$ppid" = "1" ] && return 0
    i=$((i + 1)); sleep 0.1
  done
  return 1
}

ok()   { PASS=$((PASS + 1)); echo "  ✅ $1"; }
no()   { FAIL=$((FAIL + 1)); echo "  ❌ $1"; }

# ──────────── 1. cold start spawns exactly one server ────────────
echo "cold start: kicker brings up exactly one server, lock released:"
D="$SANDBOX/cold"; P=$(next_port)
OUT=$(kick "$D" "$P" cold-vault)
[ -z "$OUT" ] && ok "kicker stdout is empty" || no "kicker emitted stdout: $OUT"
if wait_up "$D/cache" "$P" cold-vault; then ok "server came up"; else no "server never came up"; fi
[ -f "$D/cache/server.pid" ] && ok "server.pid written" || no "no server.pid"
wait_lock_released "$D/cache" && ok "spawn lock released" || no "spawn lock left behind"
[ -s "$D/cache/server.token" ] && ok "bearer token minted (0600)" || no "no token minted"
# GNU stat (`-c`) first — it fails cleanly on macOS, so the BSD (`-f`) fallback
# fires there. The reverse order is unsafe: BSD's `-f` means --file-system on
# GNU and *succeeds* with filesystem stats, swallowing the real mode.
PERM=$(stat -c '%a' "$D/cache/server.token" 2>/dev/null || stat -f '%Lp' "$D/cache/server.token" 2>/dev/null)
[ "$PERM" = "600" ] && ok "token is 0600" || no "token perms are $PERM, expected 600"

# ──────────── 2. already-up fast path: no second spawn ────────────
echo "already-up fast path: a second kick does NOT spawn a second server:"
FIRST_PID=$(cat "$D/cache/server.pid")
OUT=$(kick "$D" "$P" cold-vault)
[ -z "$OUT" ] && ok "second kick stdout empty" || no "second kick emitted: $OUT"
SECOND_PID=$(cat "$D/cache/server.pid")
[ "$FIRST_PID" = "$SECOND_PID" ] && ok "server.pid unchanged (no respawn)" || no "pid changed $FIRST_PID → $SECOND_PID"

# ──────────── 3. five parallel kicks → exactly one server ────────────
echo "five parallel kicks race → exactly one server, one spawn:"
D="$SANDBOX/race"; P=$(next_port)
mkdir -p "$D/cache" "$D/vault"
for _ in 1 2 3 4 5; do
  kick "$D" "$P" race-vault FAKE_SERVER_BIND_DELAY_MS=800 &
  STARTED_PIDS+=("$!")
done
wait
# Wait for the server up AND the supervisor to finish (lock released) — only then
# is the server.log fully written, so the spawn-count read isn't racy.
wait_up "$D/cache" "$P" race-vault || true
wait_lock_released "$D/cache" || true
# Exactly one server: precisely one process listening on the port (the real
# invariant — a single mkdir winner means a single launched server). lsof is the
# ground truth; the recorded server.pid must be that live process.
LISTENERS=$(lsof -nP -iTCP:"$P" -sTCP:LISTEN -t 2>/dev/null | sort -u | grep -c .)
[ "$LISTENERS" -eq 1 ] && ok "exactly one process listening on the port" || no "expected 1 listener, found $LISTENERS"
PIDF="$D/cache/server.pid"
if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then
  ok "recorded server.pid is live"
else
  no "recorded server.pid is not live"
fi
# And exactly one supervisor logged a spawn — the lock guaranteed a single
# winner. (Read after lock release so the log has settled.)
STARTS=$(grep -c "spawn starting" "$D/cache/server.log" 2>/dev/null)
[ "${STARTS:-0}" -eq 1 ] && ok "exactly one 'spawn starting' log line" || no "expected 1 spawn, log shows ${STARTS:-0}"

# ──────────── 4. live claimer held → no second spawn ────────────
echo "a live claimer holds the lock → a concurrent kick does not spawn:"
D="$SANDBOX/liveclaim"; P=$(next_port); mkdir -p "$D/cache" "$D/vault"
# Simulate an in-flight spawn: a live process owns the lock dir + claimer.pid.
mkdir -p "$D/cache/server.lock"
sleep 30 & HOLDER=$!; STARTED_PIDS+=("$HOLDER")
echo "$HOLDER" > "$D/cache/server.lock/claimer.pid"
OUT=$(kick "$D" "$P" live-vault)
[ -z "$OUT" ] && ok "kick stdout empty" || no "kick emitted: $OUT"
sleep 0.5
[ ! -f "$D/cache/server.pid" ] && ok "no server spawned (lock respected)" || no "spawned despite live claimer"
[ -d "$D/cache/server.lock" ] && ok "live claimer's lock untouched" || no "live lock was stolen"
kill "$HOLDER" 2>/dev/null

# ──────────── 5. dead claimer → lock stolen, server spawned ────────────
echo "a dead claimer's stale lock is stolen and the server is spawned:"
D="$SANDBOX/deadclaim"; P=$(next_port); mkdir -p "$D/cache" "$D/vault"
mkdir -p "$D/cache/server.lock"
# A PID that is not alive: spawn then reap a throwaway process.
sleep 0.01 & DEAD=$!; wait "$DEAD" 2>/dev/null
echo "$DEAD" > "$D/cache/server.lock/claimer.pid"
OUT=$(kick "$D" "$P" dead-vault)
[ -z "$OUT" ] && ok "kick stdout empty" || no "kick emitted: $OUT"
if wait_up "$D/cache" "$P" dead-vault; then ok "server spawned after stealing stale lock"; else no "no respawn after stale lock"; fi
wait_lock_released "$D/cache" && ok "stolen lock released after spawn" || no "lock left behind"

# ──────────── 5b. wedged lock (killed mid-kick, no claimer pid) self-heals ──
echo "a wedged lock with no claimer pid (kicker killed mid-kick) self-heals:"
D="$SANDBOX/wedged"; P=$(next_port); mkdir -p "$D/cache" "$D/vault"
# Simulate a kicker SIGKILLed after mkdir but before it wrote any claimer pid.
mkdir -p "$D/cache/server.lock"   # lock dir exists, claimer.pid absent
OUT=$(kick "$D" "$P" wedged-vault)
[ -z "$OUT" ] && ok "kick stdout empty" || no "kick emitted: $OUT"
if wait_up "$D/cache" "$P" wedged-vault; then ok "server spawned (wedged lock stolen)"; else no "no respawn over wedged lock"; fi
wait_lock_released "$D/cache" && ok "wedged lock released after spawn" || no "lock left behind"

# ──────────── 6. refuse-to-bind → .server-failed + lock released + exit 0 ──
echo "server refuses to bind → readiness times out, .server-failed, lock freed:"
D="$SANDBOX/refuse"; P=$(next_port); mkdir -p "$D/cache" "$D/vault"
kick "$D" "$P" refuse-vault FAKE_SERVER_REFUSE=1
RC=$?
[ "$RC" -eq 0 ] && ok "kicker still exits 0 on a failing server" || no "kicker exit $RC"
# Wait for the supervisor's readiness window (~10s) to elapse and record failure.
i=0; while [ "$i" -lt 80 ]; do [ -f "$D/cache/.server-failed" ] && break; i=$((i+1)); sleep 0.2; done
[ -f "$D/cache/.server-failed" ] && ok ".server-failed marker written" || no "no .server-failed after refuse"
[ ! -d "$D/cache/server.lock" ] && ok "lock released after failure" || no "lock stuck after failure"

# ──────────── 7. foreign squatter → .port-conflict, no spawn ────────────
echo "a foreign listener on the port → conflict recorded, no spawn:"
D="$SANDBOX/foreign"; P=$(next_port); mkdir -p "$D/cache" "$D/vault"
# A non-MCP listener squats the port (accepts, answers nothing useful).
python3 -c 'import socket,sys,time
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
s.bind(("127.0.0.1",int(sys.argv[1]))); s.listen(16)
end=time.time()+15
while time.time()<end:
    s.settimeout(end-time.time())
    try: c,_=s.accept(); c.close()
    except OSError: break' "$P" >/dev/null 2>&1 &
SQUAT=$!; STARTED_PIDS+=("$SQUAT")
i=0; while [ "$i" -lt 60 ]; do (exec 3<>"/dev/tcp/127.0.0.1/$P") 2>/dev/null && { exec 3>&- 2>/dev/null; break; }; i=$((i+1)); sleep 0.05; done
OUT=$(kick "$D" "$P" foreign-vault)
[ -z "$OUT" ] && ok "kick stdout empty" || no "kick emitted: $OUT"
sleep 0.5
[ -f "$D/cache/.port-conflict" ] && ok ".port-conflict recorded" || no "no .port-conflict for foreign listener"
[ ! -f "$D/cache/server.pid" ] && ok "did not spawn over a foreign listener" || no "spawned despite foreign squatter"
kill "$SQUAT" 2>/dev/null

# ──────────── 8. perl-setsid detach: server reparents away from the kicker ──
echo "perl-setsid detach: the server is reparented out of the kicker's tree:"
D="$SANDBOX/detach"; P=$(next_port)
kick "$D" "$P" detach-vault
wait_up "$D/cache" "$P" detach-vault || true
SPID=$(cat "$D/cache/server.pid" 2>/dev/null)
if wait_reparented "$SPID"; then
  ok "server PPID is 1 (reparented; survives kicker pgroup signals)"
else
  no "server PPID never became 1 (not detached)"
fi

echo "issue 2 — only the supervisor writes claimer.pid (no late-kicker clobber):"
# The kicker must NOT write claimer.pid. A late write from the ephemeral kicker
# can land in a newer lock generation (if a fast supervisor already released the
# lock), clobbering a live sibling's pid with a dead one → a third kicker reads
# the dead pid, declares the lock stale, and double-spawns. Only the supervisor,
# the lock's true owner, stamps it with its own $$. Guard structurally (code
# lines only, not the explanatory comments).
if grep -vE '^[[:space:]]*#' "$UP" | grep -qF '> "$CLAIMER_PID_FILE"'; then
  no "kicker still writes claimer.pid (late-write clobber risk)"
else
  ok "kicker does not write claimer.pid"
fi
if grep -qF 'echo "$$" > "$CLAIMER_PID_FILE"' "$HOOKS/memory-server-spawn.sh"; then
  ok "supervisor stamps claimer.pid with its own \$\$ as its first action"
else
  no "supervisor does not write claimer.pid from \$\$"
fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
