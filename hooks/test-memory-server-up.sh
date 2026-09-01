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

# port_is_free <port> — nothing is LISTENing on it. A connect probe is the right
# test (not a bind probe): the fixture is a python http.server, which sets
# allow_reuse_address, so a port in TIME_WAIT binds fine and only a live listener
# can actually collide. Same /dev/tcp idiom the squatter case below uses.
port_is_free() {
  ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

# port_owner <port> — who is LISTENing, as "cmd/pid" pairs. Empty when nobody is.
# Used only to make a failure name its own cause.
#
# lsof ships with macOS but is NOT installed on a stock Arch/Omarchy system, where
# `ss` is the equivalent. Without a fallback every port assertion here reported
# "nothing listening" on Linux regardless of the truth — a harness gap that reads
# as a product failure. Prefer lsof when present, else ss.
port_owner() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | tail -n +2 | awk '{print $1"/"$2}' | tr '\n' ' '
  elif command -v ss >/dev/null 2>&1; then
    # ss -H omits the header; users:(("cmd",pid=123,fd=4)) carries the owner.
    ss -Hltnp "sport = :$1" 2>/dev/null \
      | grep -oE '\(\("[^"]+",pid=[0-9]+' \
      | sed -E 's/\(\("([^"]+)",pid=([0-9]+)/\1\/\2/' | tr '\n' ' '
  fi
}

# listener_pids <port> — pids LISTENing on the port, one per line.
listener_pids() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null
  elif command -v ss >/dev/null 2>&1; then
    ss -Hltnp "sport = :$1" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2
  fi
}

# next_port — the next port in this run's sequence that is genuinely free.
# Randomizing the base alone is not enough: the band holds real listeners on any
# developer machine, and handing out an occupied port produces exactly the shapes
# these tests assert against (a probe matching a foreign server, or two listeners
# where the lock guarantees one). Walk forward past anything already in use.
next_port() {
  local n tries=0
  while [ "$tries" -lt 500 ]; do
    n=$(( $(cat "$PORT_COUNTER") + 1 )); echo "$n" > "$PORT_COUNTER"
    if port_is_free "$n"; then printf '%s' "$n"; return 0; fi
    tries=$((tries + 1))
  done
  # Fail closed and loudly. Handing back an occupied port would produce a
  # mystifying red assertion somewhere far from here — which is the whole
  # failure mode this function exists to prevent.
  echo "FATAL: no free TCP port in 500 candidates from $PORT_BASE" >&2
  kill -TERM $$
  return 1
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

# wait_reparented <pid> — the supervisor re-parents the server once it exits
# itself, just after lock release. Poll (bounded) until that has happened.
#
# "Reparented == PPID 1" holds on macOS, where orphans go to launchd at pid 1.
# It is WRONG on Linux: the kernel hands an orphan to the nearest ancestor marked
# PR_SET_CHILD_SUBREAPER, and under systemd every user session runs a
# `systemd --user` that sets it — so a correctly detached server lands on that
# manager's pid, not 1, and this asserted a detach failure that had not happened.
# The same wrong assumption was live in the orphan sweep itself; see
# _parent_is_reaper in memory-server-spawn.sh.
#
# So accept either: pid 1, or a parent that IS an init/subreaper by name.
wait_reparented() {
  local pid="$1" i=0 ppid comm
  while [ "$i" -lt 80 ]; do
    ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    if [ "$ppid" = "1" ]; then return 0; fi
    if [ -n "$ppid" ]; then
      comm=$(ps -o comm= -p "$ppid" 2>/dev/null | tr -d ' ')
      case "${comm##*/}" in systemd|init|launchd) return 0 ;; esac
    fi
    i=$((i + 1)); sleep 0.1
  done
  return 1
}

ok()   { PASS=$((PASS + 1)); echo "  ✅ $1"; }
no()   { FAIL=$((FAIL + 1)); echo "  ❌ $1"; }

# ──────────── 0. the harness's own port allocator ────────────
# The allocator is test infrastructure, but a wrong port here surfaces as a red
# assertion in a case far below — "server never came up", or two listeners where
# the lock guarantees one — with nothing pointing back at the real cause. That is
# what made the 2026-08-29 flake opaque, so the allocator gets its own case.
echo "port allocator hands out only free ports:"
ALLOC_PORT=$(( $(cat "$PORT_COUNTER") + 1 ))
python3 -c '
import socket, sys, time
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", int(sys.argv[1]))); s.listen(1)
print("ready", flush=True)
time.sleep(30)
' "$ALLOC_PORT" > "$SANDBOX/squat.out" 2>/dev/null &
ALLOC_SQUAT=$!; STARTED_PIDS+=("$ALLOC_SQUAT")
disown 2>/dev/null || true   # silence the job-control "Terminated" notice on kill
i=0; while [ "$i" -lt 100 ]; do grep -q ready "$SANDBOX/squat.out" 2>/dev/null && break; i=$((i+1)); sleep 0.05; done

if grep -q ready "$SANDBOX/squat.out" 2>/dev/null; then
  GOT=$(next_port)
  [ "$GOT" != "$ALLOC_PORT" ] \
    && ok "walks past an occupied port ($ALLOC_PORT taken → handed $GOT)" \
    || no "handed out the occupied port $ALLOC_PORT"
  port_is_free "$GOT" && ok "the port it handed out is genuinely free" \
    || no "handed out $GOT, which is in use by: $(port_owner "$GOT")"
  port_owner "$ALLOC_PORT" | grep -q . && ok "port_owner names a live holder" \
    || no "port_owner reported nothing for the squatted port $ALLOC_PORT"
else
  no "could not stand up the squatter fixture on :$ALLOC_PORT"
fi
kill "$ALLOC_SQUAT" 2>/dev/null

# ──────────── 1. cold start spawns exactly one server ────────────
echo "cold start: kicker brings up exactly one server, lock released:"
D="$SANDBOX/cold"; P=$(next_port)
OUT=$(kick "$D" "$P" cold-vault)
[ -z "$OUT" ] && ok "kicker stdout is empty" || no "kicker emitted stdout: $OUT"
if wait_up "$D/cache" "$P" cold-vault; then ok "server came up"; else no "server never came up on :$P (port held by: $(port_owner "$P"))"; fi
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
LISTENERS=$(listener_pids "$P" | sort -u | grep -c .)
[ "$LISTENERS" -eq 1 ] && ok "exactly one process listening on the port" \
  || no "expected 1 listener on :$P, found $LISTENERS — holders: $(port_owner "$P")"
PIDF="$D/cache/server.pid"
if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then
  ok "recorded server.pid is live"
else
  no "recorded server.pid is not live"
fi
# And exactly one supervisor logged a spawn — the lock guaranteed a single
# winner. (Read after lock release so the log has settled.)
STARTS=$(grep -c "spawn starting" "$D/cache/server.log" 2>/dev/null)
[ "${STARTS:-0}" -eq 1 ] && ok "exactly one 'spawn starting' log line" \
  || no "expected 1 spawn on :$P, log shows ${STARTS:-0} — $(grep -c . "$D/cache/server.log" 2>/dev/null || echo 0) log lines, holders: $(port_owner "$P")"

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
if wait_up "$D/cache" "$P" dead-vault; then ok "server spawned after stealing stale lock"; else no "no respawn after stale lock on :$P (port held by: $(port_owner "$P"))"; fi
wait_lock_released "$D/cache" && ok "stolen lock released after spawn" || no "lock left behind"

# ──────────── 5b. wedged lock (killed mid-kick, no claimer pid) self-heals ──
echo "a wedged lock with no claimer pid (kicker killed mid-kick) self-heals:"
D="$SANDBOX/wedged"; P=$(next_port); mkdir -p "$D/cache" "$D/vault"
# Simulate a kicker SIGKILLed after mkdir but before it wrote any claimer pid.
mkdir -p "$D/cache/server.lock"   # lock dir exists, claimer.pid absent
OUT=$(kick "$D" "$P" wedged-vault)
[ -z "$OUT" ] && ok "kick stdout empty" || no "kick emitted: $OUT"
if wait_up "$D/cache" "$P" wedged-vault; then ok "server spawned (wedged lock stolen)"; else no "no respawn over wedged lock on :$P (port held by: $(port_owner "$P"))"; fi
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
  ok "server reparented to init/subreaper (survives kicker pgroup signals)"
else
  no "server never reparented to init/subreaper (not detached)"
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

echo "generation nonce — release_lock only removes OUR generation's lock:"
# Source the supervisor's helpers (MEMORY_SPAWN_LIB_ONLY=1 returns before the
# body runs) and drive release_lock with controlled nonces. The hazard: a stale
# gen-1 supervisor whose lock was stolen and re-created by gen-2 must NOT delete
# gen-2's lock (same fixed path). WORKBENCH_MEMORY_CACHE overrides CACHE_PATH so
# LOCK_DIR/NONCE_FILE point into the sandbox regardless of real config.
SPAWN="$HOOKS/memory-server-spawn.sh"
release_lock_in() {  # <cache-dir> <captured-nonce>
  ( export HOME="$1/home" CLAUDE_PLUGIN_ROOT="$REPO_ROOT" \
      WORKBENCH_MEMORY_CACHE="$1/cache" WORKBENCH_MEMORY_PATH="$1/vault" \
      MEMORY_SPAWN_LIB_ONLY=1
    # GEN_NONCE is consumed by release_lock, sourced from $SPAWN on this line.
    # shellcheck source=hooks/memory-server-spawn.sh disable=SC2034
    . "$SPAWN"; GEN_NONCE="$2"; release_lock ) >/dev/null 2>&1
}

D="$SANDBOX/nonce-match"; mkdir -p "$D/cache/server.lock" "$D/home"
printf 'GEN-A' > "$D/cache/server.lock/nonce"
release_lock_in "$D" 'GEN-A'
if [ ! -d "$D/cache/server.lock" ]; then ok "matching nonce releases the lock"; else no "matching nonce should release the lock"; fi

D="$SANDBOX/nonce-changed"; mkdir -p "$D/cache/server.lock" "$D/home"
printf 'GEN-B' > "$D/cache/server.lock/nonce"   # a newer generation took over
release_lock_in "$D" 'GEN-A'                     # stale gen-1 supervisor releases
if [ -d "$D/cache/server.lock" ] && [ "$(cat "$D/cache/server.lock/nonce" 2>/dev/null)" = "GEN-B" ]; then
  ok "changed nonce → newer generation's lock survives"
else
  no "stale supervisor deleted a newer generation's lock"
fi

D="$SANDBOX/nonce-legacy"; mkdir -p "$D/cache/server.lock" "$D/home"  # no nonce file
release_lock_in "$D" ''
if [ ! -d "$D/cache/server.lock" ]; then ok "legacy empty nonce still releases (no wedge)"; else no "legacy empty nonce should still release"; fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
