#!/bin/bash
# Tests for scripts/memory-status.sh — the shared-server status report.
# Run directly: ./test-memory-status.sh
# Drives the script in a sandbox (fake vault/cache, no real config) and asserts
# it reports the shared HTTP transport, resolved paths, probe health, and the
# bearer-token state, and always exits 0. No server, no network.
#
# The token assertion is the load-bearing one. A missing token makes Claude Code
# reject the memory MCP outright before any server starts, and that is the single
# most common "memory is broken" cause on a fresh install — so the diagnostic
# tool has to name it. It previously said the opposite (no port, no token,
# nothing to probe), which sent a user with exactly that failure in circles.

set -u
HOOKS="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HOOKS/.." && pwd)"
STATUS="$REPO_ROOT/scripts/memory-status.sh"
PASS=0
FAIL=0

SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/vault" "$SANDBOX/cache"

run_status() {
  env WORKBENCH_MEMORY_PATH="$SANDBOX/vault" \
      WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" \
      WORKBENCH_MCP_SERVER_NAME="test-vault" \
      WORKBENCH_CONFIG_FILE="$SANDBOX/nope.json" \
      CLAUDE_PLUGIN_ROOT="$REPO_ROOT" \
      bash "$STATUS" "$@" 2>&1
}

assert_contains() {
  local desc="$1" output="$2" needle="$3"
  if printf '%s' "$output" | grep -qF "$needle"; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected: $needle"
  fi
}

assert_missing() {
  local desc="$1" output="$2" needle="$3"
  if printf '%s' "$output" | grep -qiF "$needle"; then
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — should NOT contain: $needle"
  else
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  fi
}

echo "status: reports the shared transport and resolved facts, exits 0:"
OUT=$(run_status); RC=$?
assert_contains "reports the shared HTTP transport" "$OUT" "shared HTTP"
assert_contains "reports the vault path"            "$OUT" "$SANDBOX/vault"
assert_contains "reports the cache path"            "$OUT" "$SANDBOX/cache"
assert_contains "reports the configured server name" "$OUT" "test-vault"
assert_contains "reports probe health"              "$OUT" "health"
assert_contains "reports live session refs"         "$OUT" "live session refs"
assert_contains "reports git sync state"            "$OUT" "git sync"
[ "$RC" -eq 0 ] && { PASS=$((PASS+1)); echo "  ✅ exits 0"; } || { FAIL=$((FAIL+1)); echo "  ❌ non-zero exit ($RC)"; }

# The whole point of the report on a fresh install.
echo "the bearer token is reported, and its absence names the fix:"
assert_contains "flags a missing token" "$OUT" "bearer token     : MISSING"
assert_contains "names setup as the fix" "$OUT" "/workbench-core:setup"
assert_contains "says relaunch, not just a new session" "$OUT" "QUIT and relaunch"

printf 'deadbeef' > "$SANDBOX/cache/server.token"
OUT_TOK=$(run_status)
assert_contains "reports a present token" "$OUT_TOK" "bearer token     : present"
assert_missing  "does not still claim MISSING" "$OUT_TOK" "bearer token     : MISSING"
rm -f "$SANDBOX/cache/server.token"

echo "start/stop point at the scripts that own those operations:"
OUT=$(run_status stop)
assert_contains "stop names the down script"   "$OUT" "memory-server-down.sh"
assert_contains "stop mentions the idle grace" "$OUT" "grace period"
OUT=$(run_status start)
assert_contains "start names the up script"    "$OUT" "memory-server-up.sh"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
