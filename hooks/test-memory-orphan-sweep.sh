#!/bin/bash
# Tests for the one-shot orphan-stdio-server sweep in memory-server-spawn.sh.
# Run directly: ./test-memory-orphan-sweep.sh
#
# The sweep reaps leaked pre-shared-server stdio servers (orphans whose parent
# died) when the first shared server comes up — but must NEVER kill a server
# whose parent is still alive (an in-flight session's server), nor itself, and
# must run exactly once (stamp guarded).
#
# We can't run the real markdown-vault-mcp, so we model "servers" as sleeper
# processes whose command line carries the resolved SERVER_BIN path (the same
# discriminator the sweep matches on) and whose ps command line contains the
# string "markdown-vault-mcp". The fake fixture (substituted as SERVER_BIN)
# stands in for the actual shared server.

set -u
HOOKS="$(cd "$(dirname "$0")" && pwd)"
SPAWN="$HOOKS/memory-server-spawn.sh"
FAKE="$HOOKS/fixtures/fake-markdown-vault-mcp.sh"
REPO_ROOT="$(cd "$HOOKS/.." && pwd)"
PASS=0
FAIL=0

SANDBOX=$(mktemp -d)
TRACK_PIDS=()
cleanup() {
  for f in "$SANDBOX"/*/cache/server.pid; do [ -f "$f" ] && kill "$(cat "$f" 2>/dev/null)" 2>/dev/null; done
  for p in "${TRACK_PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
  rm -rf "$SANDBOX"
}
trap cleanup EXIT

PORT_COUNTER="$SANDBOX/.port"; echo $(( 33000 + (RANDOM % 10000) )) > "$PORT_COUNTER"
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

ok() { PASS=$((PASS + 1)); echo "  ✅ $1"; }
no() { FAIL=$((FAIL + 1)); echo "  ❌ $1"; }

# A "stdio server" stand-in: a python sleeper whose argv carries the marker
# string the sweep matches (markdown-vault-mcp) AND the SERVER_BIN path. The
# fixture path contains "markdown-vault-mcp" already, so passing it as an argv
# token satisfies both the pgrep -f "$bin" match and the ps command-case guard.
SLEEPER_PY='import sys,time; time.sleep(40)'

# spawn_orphan <bin> — a server whose PARENT is dead (reparented to PID 1) via
# the same perl-setsid detach the kicker uses. Echoes the orphan pid.
spawn_orphan() {
  local bin="$1"
  perl -e 'use POSIX qw(setsid); setsid; exec @ARGV' -- \
    python3 -c "$SLEEPER_PY" "$bin" markdown-vault-mcp serve >/dev/null 2>&1 &
  # The perl exec keeps the pid; capture it.
  echo $!
}

# NOTE: a live-parented sleeper must be backgrounded from the MAIN shell, not a
# $() subshell — a command substitution runs in a subshell that exits right
# after, orphaning the child (reparented to PID 1) and making it look swept-
# eligible. So we background inline at the call site and read $! directly.

# run_supervisor <case-dir> <port> <name> — start the shared server (fake) via
# the supervisor and wait for it to finish (it exits after readiness + sweep).
run_supervisor() {
  local dir="$1" port="$2" name="$3"
  mkdir -p "$dir/cache" "$dir/vault" "$dir/cache/server.lock"
  echo "$$" > "$dir/cache/server.lock/claimer.pid"
  env -i HOME="$dir/home" PATH="$PATH" CLAUDE_PLUGIN_ROOT="$REPO_ROOT" \
    WORKBENCH_MEMORY_CACHE="$dir/cache" WORKBENCH_MEMORY_PATH="$dir/vault" \
    WORKBENCH_MCP_SERVER_NAME="$name" WORKBENCH_MEMORY_PORT="$port" \
    WORKBENCH_MEMORY_SERVER_BIN="$FAKE" \
    bash "$SPAWN" >/dev/null 2>&1
}

echo "port allocator hands out only free ports:"
# Same guard as the sibling suites: an occupied port here surfaces as a red
# assertion below with nothing pointing at the real cause (2026-08-29).
ALLOC_PORT=$(( $(cat "$PORT_COUNTER") + 1 ))
python3 -c '
import socket, sys, time
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", int(sys.argv[1]))); s.listen(1)
print("ready", flush=True)
time.sleep(30)
' "$ALLOC_PORT" > "$SANDBOX/alloc.out" 2>/dev/null &
ALLOC_SQUAT=$!; TRACK_PIDS+=("$ALLOC_SQUAT")
disown 2>/dev/null || true
i=0; while [ "$i" -lt 100 ]; do grep -q ready "$SANDBOX/alloc.out" 2>/dev/null && break; i=$((i+1)); sleep 0.05; done
if grep -q ready "$SANDBOX/alloc.out" 2>/dev/null; then
  GOT=$(next_port)
  [ "$GOT" != "$ALLOC_PORT" ] \
    && ok "walks past an occupied port ($ALLOC_PORT taken → handed $GOT)" \
    || no "handed out the occupied port $ALLOC_PORT"
else
  no "could not stand up the allocator fixture on :$ALLOC_PORT"
fi
kill "$ALLOC_SQUAT" 2>/dev/null

echo "first shared start reaps an orphan but spares a live-parented server:"
D="$SANDBOX/sweep"; P=$(next_port)
ORPHAN=$(spawn_orphan "$FAKE"); TRACK_PIDS+=("$ORPHAN")
# Background the live-parented sleeper inline (this main shell stays its parent).
python3 -c "$SLEEPER_PY" "$FAKE" markdown-vault-mcp serve >/dev/null 2>&1 &
LIVE=$!; TRACK_PIDS+=("$LIVE")
# Let both register and (for the orphan) reparent to PID 1.
i=0; while [ "$i" -lt 30 ]; do
  PPID_O=$(ps -o ppid= -p "$ORPHAN" 2>/dev/null | tr -d ' ')
  [ "$PPID_O" = "1" ] && break; i=$((i+1)); sleep 0.1
done
run_supervisor "$D" "$P" sweep-vault
# Give signals a beat to land.
sleep 0.5
kill -0 "$ORPHAN" 2>/dev/null && no "orphan was NOT reaped (still alive)" || ok "orphan reaped"
kill -0 "$LIVE" 2>/dev/null && ok "live-parented server spared" || no "live-parented server was wrongly killed"
[ -f "$D/cache/.shared-migration-done" ] && ok "migration stamp written" || no "no migration stamp"
SHARED_PID=$(cat "$D/cache/server.pid" 2>/dev/null)
kill -0 "$SHARED_PID" 2>/dev/null && ok "the shared server itself survived the sweep" || no "shared server was killed by its own sweep"
kill "$LIVE" 2>/dev/null

echo "the sweep is one-shot — a second start does not sweep again:"
# Spawn a NEW orphan, then start a second supervisor in the SAME cache (stamp
# present). It must NOT reap the new orphan (sweep already ran once).
D2="$D"   # same cache dir → same stamp
P2=$(next_port)
ORPHAN2=$(spawn_orphan "$FAKE"); TRACK_PIDS+=("$ORPHAN2")
i=0; while [ "$i" -lt 30 ]; do
  PPID_O=$(ps -o ppid= -p "$ORPHAN2" 2>/dev/null | tr -d ' ')
  [ "$PPID_O" = "1" ] && break; i=$((i+1)); sleep 0.1
done
# Stop the first shared server so the second supervisor actually launches.
kill "$(cat "$D2/cache/server.pid" 2>/dev/null)" 2>/dev/null
rm -f "$D2/cache/server.pid" "$D2/cache/server.port"
mkdir -p "$D2/cache/server.lock"; echo "$$" > "$D2/cache/server.lock/claimer.pid"
run_supervisor "$D2" "$P2" sweep-vault
sleep 0.5
kill -0 "$ORPHAN2" 2>/dev/null && ok "second start did NOT re-sweep (orphan still alive)" || no "second start re-swept (stamp not honored)"
kill "$ORPHAN2" 2>/dev/null

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
