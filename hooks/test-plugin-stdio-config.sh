#!/bin/bash
# Tests for the plugin.json memory MCP server config. Run directly:
# ./test-plugin-stdio-config.sh
# Asserts the memory server is declared as a per-session STDIO launcher — a
# `command`/`args` pair invoking hooks/mcp-memory.sh via ${CLAUDE_PLUGIN_ROOT} —
# and that none of the legacy shared-HTTP transport keys (type/url/headers)
# remain. Since v0.13.0 the transport reverted from the shared HTTP server to a
# per-session stdio server (works in Cowork's remote sandbox, where nothing
# listens on the host's loopback port). The HTTP machinery is retained but no
# longer wired; see README "Memory server transport" for re-enable steps.

set -u
HOOKS="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_JSON="$(cd "$HOOKS/.." && pwd)/.claude-plugin/plugin.json"
PASS=0
FAIL=0

if ! command -v jq >/dev/null 2>&1; then
  echo "SKIP: jq not on PATH"
  exit 0
fi

assert() {
  local desc="$1" cond="$2"
  if [ "$cond" = "true" ]; then PASS=$((PASS + 1)); echo "  ✅ $desc"
  else FAIL=$((FAIL + 1)); echo "  ❌ $desc"; fi
}

echo "plugin.json is valid JSON:"
if jq empty "$PLUGIN_JSON" 2>/dev/null; then assert "valid JSON" true; else assert "valid JSON" false; fi

MEM='.mcpServers.memory'

echo "memory server uses the stdio command launcher:"
CMD=$(jq -r "$MEM.command // empty" "$PLUGIN_JSON")
assert "command == bash" "$([ "$CMD" = "bash" ] && echo true || echo false)"
ARG0=$(jq -r "$MEM.args[0] // empty" "$PLUGIN_JSON")
echo "    args[0] = $ARG0"
assert "args[0] invokes mcp-memory.sh via CLAUDE_PLUGIN_ROOT" \
  "$([ "$ARG0" = '${CLAUDE_PLUGIN_ROOT}/hooks/mcp-memory.sh' ] && echo true || echo false)"

echo "the referenced launcher exists and is executable:"
LAUNCHER="$HOOKS/mcp-memory.sh"
assert "hooks/mcp-memory.sh present"    "$([ -f "$LAUNCHER" ] && echo true || echo false)"
assert "hooks/mcp-memory.sh executable" "$([ -x "$LAUNCHER" ] && echo true || echo false)"

echo "no legacy shared-HTTP transport keys remain:"
for key in type url headers; do
  HAS=$(jq -e "$MEM | has(\"$key\")" "$PLUGIN_JSON" >/dev/null 2>&1 && echo true || echo false)
  assert "no legacy '$key' key" "$([ "$HAS" = "false" ] && echo true || echo false)"
done

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
