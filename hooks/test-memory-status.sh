#!/bin/bash
# Tests for scripts/memory-status.sh — the per-session stdio status report.
# Run directly: ./test-memory-status.sh
# Drives the script in a sandbox (fake vault/cache, no real config) and asserts
# it reports the stdio transport, resolved paths, and launcher presence, carries
# no leftover HTTP/port/token vocabulary, and always exits 0. No server, no net.

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

echo "status: reports the stdio transport and resolved facts, exits 0:"
OUT=$(run_status); RC=$?
assert_contains "reports per-session stdio transport"         "$OUT" "per-session stdio"
assert_contains "reports the vault path"                      "$OUT" "$SANDBOX/vault"
assert_contains "reports the cache path"                      "$OUT" "$SANDBOX/cache"
assert_contains "reports the configured server name"          "$OUT" "test-vault"
assert_contains "reports the launcher present"                "$OUT" "mcp-memory.sh (present)"
assert_contains "says there is no shared server to start/stop" "$OUT" "no shared server to start or stop"
[ "$RC" -eq 0 ] && { PASS=$((PASS+1)); echo "  ✅ exits 0"; } || { FAIL=$((FAIL+1)); echo "  ❌ non-zero exit ($RC)"; }

echo "no leftover shared-HTTP vocabulary in the report:"
assert_missing "no bearer-token wording" "$OUT" "bearer"
assert_missing "no hardcoded 8765 port"  "$OUT" "8765"

echo "start/stop: prints the not-applicable note and still shows status:"
OUT=$(run_status stop)
assert_contains "explains stop is N/A under stdio"  "$OUT" "does not apply to the per-session stdio server"
assert_contains "still shows status after the note" "$OUT" "per-session stdio"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
