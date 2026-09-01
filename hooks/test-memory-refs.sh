#!/bin/bash
# Tests for the shared-server session refcount: lib/memory-refs.sh +
# memory-server-release.sh + memory-server-idle-stop.sh.
# Run directly: ./test-memory-refs.sh
#
# Covers the contract that decides when the shared HTTP server may be reaped:
# register/release, idempotence, the pid sweep that survives a crashed session,
# the "last one out schedules the reaper" rule, and the reaper's own
# grace/settle/self-correct behaviour.
#
# No real server and no network: liveness is asserted against `sleep` processes
# this test owns, and the reap path is pointed at a stub down/up script so the
# reaper's decisions can be observed without killing anything.

set -u
HOOKS="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0

SANDBOX=$(mktemp -d)
OWNED_PIDS=()
cleanup() {
  for p in "${OWNED_PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
  rm -rf "$SANDBOX"
}
trap cleanup EXIT

export CACHE_PATH="$SANDBOX/cache"
export WORKBENCH_MEMORY_REFS_DIR="$CACHE_PATH/refs"
mkdir -p "$CACHE_PATH"

# shellcheck source=hooks/lib/memory-refs.sh
. "$HOOKS/lib/memory-refs.sh"

ok()   { PASS=$((PASS + 1)); echo "  ✅ $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "  ❌ $1 — $2"; }
is()   { [ "$2" = "$3" ] && ok "$1" || bad "$1" "expected '$3', got '$2'"; }

# spawn_owner: a long-lived process we can point a ref at, and kill on demand.
#
# stdout/stderr MUST be redirected: this runs inside $(...), and a background job
# that inherits the command-substitution pipe holds its write end open, so the
# substitution blocks until the job exits rather than returning the pid.
spawn_owner() {
  sleep 300 >/dev/null 2>&1 &
  local p=$!
  OWNED_PIDS+=("$p")
  printf '%s' "$p"
}

echo "register / count / release:"
is "empty registry counts zero" "$(memory_refs_count)" "0"
A=$(spawn_owner); memory_ref_register "sess-a" "$A"
is "one ref counts one" "$(memory_refs_count)" "1"
B=$(spawn_owner); memory_ref_register "sess-b" "$B"
is "two refs count two" "$(memory_refs_count)" "2"
memory_ref_release "sess-a"
is "release drops the count" "$(memory_refs_count)" "1"
memory_ref_release "sess-b"
is "releasing all returns to zero" "$(memory_refs_count)" "0"

echo "registration is idempotent (SessionStart can fire more than once):"
C=$(spawn_owner)
memory_ref_register "sess-c" "$C"
memory_ref_register "sess-c" "$C"
memory_ref_register "sess-c" "$C"
is "re-registering does not inflate the count" "$(memory_refs_count)" "1"
memory_ref_release "sess-c"

echo "the pid sweep reclaims a crashed session's ref:"
D=$(spawn_owner); memory_ref_register "sess-d" "$D"
E=$(spawn_owner); memory_ref_register "sess-e" "$E"
is "both live" "$(memory_refs_count)" "2"
kill "$D" 2>/dev/null; wait "$D" 2>/dev/null
# A crashed session never runs SessionEnd — the sweep is what stops its ref from
# pinning the server on forever. This is the whole reason refs record a pid.
is "dead owner's ref is swept" "$(memory_refs_count)" "1"
if [ ! -f "$WORKBENCH_MEMORY_REFS_DIR/s-sess-d.ref" ]; then
  ok "swept ref file is actually removed"
else
  bad "swept ref file is actually removed" "sess-d.ref still present"
fi
memory_ref_release "sess-e"

echo "malformed refs cannot pin the server:"
mkdir -p "$WORKBENCH_MEMORY_REFS_DIR"
: > "$WORKBENCH_MEMORY_REFS_DIR/empty.ref"
printf 'not-a-pid' > "$WORKBENCH_MEMORY_REFS_DIR/garbage.ref"
is "empty and malformed refs sweep to zero" "$(memory_refs_count)" "0"

echo "session ids are sanitized before becoming filenames:"
F=$(spawn_owner)
memory_ref_register "../../etc/passwd" "$F"
if [ -z "$(find "$WORKBENCH_MEMORY_REFS_DIR" -name '*passwd*' -maxdepth 1 2>/dev/null | grep -v '_' )" ]; then
  ok "path traversal in a session id is neutralized"
else
  bad "path traversal in a session id is neutralized" "unsanitized name written"
fi
is "sanitized ref still counts" "$(memory_refs_count)" "1"
memory_ref_release "../../etc/passwd"
is "sanitized ref releases by the same key" "$(memory_refs_count)" "0"

# ──────────────────────────────────────────────────────────────────────────
# Reaper behaviour. Point the reaper at stub down/up scripts so we observe its
# decisions rather than killing a real server.
# ──────────────────────────────────────────────────────────────────────────
STUBS="$SANDBOX/stubs"
mkdir -p "$STUBS/lib"
cp "$HOOKS/lib/memory-refs.sh" "$STUBS/lib/"
cat > "$STUBS/lib/memory-env.sh" <<EOF
memory_load_env() { CACHE_PATH="$CACHE_PATH"; export CACHE_PATH; }
EOF
cp "$HOOKS/memory-server-idle-stop.sh" "$STUBS/"
cat > "$STUBS/memory-server-down.sh" <<EOF
#!/usr/bin/env bash
echo stopped >> "$SANDBOX/down.calls"
EOF
cat > "$STUBS/memory-server-up.sh" <<EOF
#!/usr/bin/env bash
echo restarted >> "$SANDBOX/up.calls"
EOF
chmod +x "$STUBS"/*.sh

reap() {  # reap <grace> <settle>
  rm -f "$SANDBOX/down.calls" "$SANDBOX/up.calls"
  WORKBENCH_MEMORY_IDLE_GRACE="$1" WORKBENCH_MEMORY_IDLE_SETTLE="$2" \
    CLAUDE_PLUGIN_ROOT="" WORKBENCH_MEMORY_REFS_DIR="$WORKBENCH_MEMORY_REFS_DIR" \
    bash "$STUBS/memory-server-idle-stop.sh" 2>/dev/null
}

echo "the reaper stops the server only when no session is live:"
reap 1 1
is "reaps when the registry is empty" "$(cat "$SANDBOX/down.calls" 2>/dev/null)" "stopped"

G=$(spawn_owner); memory_ref_register "sess-g" "$G"
reap 1 1
is "does NOT reap while a session is live" "$(cat "$SANDBOX/down.calls" 2>/dev/null)" ""
memory_ref_release "sess-g"

echo "the reaper can be disabled outright:"
reap 0 1
is "grace=0 disables the reaper" "$(cat "$SANDBOX/down.calls" 2>/dev/null)" ""

echo "a session arriving during the settle window cancels the reap:"
rm -f "$SANDBOX/down.calls"
H=$(spawn_owner)
( sleep 1; memory_ref_register "sess-h" "$H" ) &
OWNED_PIDS+=("$!")
WORKBENCH_MEMORY_IDLE_GRACE=1 WORKBENCH_MEMORY_IDLE_SETTLE=3 \
  CLAUDE_PLUGIN_ROOT="" WORKBENCH_MEMORY_REFS_DIR="$WORKBENCH_MEMORY_REFS_DIR" \
  bash "$STUBS/memory-server-idle-stop.sh" 2>/dev/null
is "settle check catches the late arrival" "$(cat "$SANDBOX/down.calls" 2>/dev/null)" ""
memory_ref_release "sess-h"

echo "two reapers cannot both drive a stop:"
rm -f "$SANDBOX/down.calls"
reap 1 1 & P1=$!
reap 1 1 & P2=$!
wait "$P1" "$P2" 2>/dev/null
# Both racing reapers see an empty registry, but stop.lock admits exactly one.
COUNT=$(grep -c stopped "$SANDBOX/down.calls" 2>/dev/null || echo 0)
if [ "$COUNT" -le 1 ]; then
  ok "stop lock serializes concurrent reapers (stops: $COUNT)"
else
  bad "stop lock serializes concurrent reapers" "stopped $COUNT times"
fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
