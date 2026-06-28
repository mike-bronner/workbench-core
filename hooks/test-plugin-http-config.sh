#!/bin/bash
# Tests for the plugin.json memory MCP server config. Run directly:
# ./test-plugin-http-config.sh
# Asserts the memory server is declared as an HTTP transport pointing at the
# lazy-started shared server, with the bearer-token header — and that the
# default port baked into the URL matches the library's default (so a host that
# sets no WORKBENCH_MEMORY_PORT connects where the supervisor binds).

set -u
HOOKS="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_JSON="$(cd "$HOOKS/.." && pwd)/.claude-plugin/plugin.json"
ENV_LIB="$HOOKS/lib/memory-env.sh"
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

echo "memory server uses the HTTP transport:"
TYPE=$(jq -r "$MEM.type // empty" "$PLUGIN_JSON")
assert "type == http" "$([ "$TYPE" = "http" ] && echo true || echo false)"
HAS_CMD=$(jq -e "$MEM | has(\"command\")" "$PLUGIN_JSON" >/dev/null 2>&1 && echo true || echo false)
assert "no legacy command key" "$([ "$HAS_CMD" = "false" ] && echo true || echo false)"
HAS_ARGS=$(jq -e "$MEM | has(\"args\")" "$PLUGIN_JSON" >/dev/null 2>&1 && echo true || echo false)
assert "no legacy args key" "$([ "$HAS_ARGS" = "false" ] && echo true || echo false)"

echo "url points at loopback /mcp with the port env token + 8765 default:"
URL=$(jq -r "$MEM.url // empty" "$PLUGIN_JSON")
echo "    url = $URL"
assert "url is loopback" "$(printf '%s' "$URL" | grep -q '127.0.0.1' && echo true || echo false)"
assert "url path is /mcp"  "$(printf '%s' "$URL" | grep -q '/mcp' && echo true || echo false)"
assert "url uses WORKBENCH_MEMORY_PORT env token" \
  "$(printf '%s' "$URL" | grep -q '\${WORKBENCH_MEMORY_PORT:-8765}' && echo true || echo false)"

echo "the URL's default port matches the library default (no drift):"
# Resolve the lib's default port (no override, no config) and confirm the
# literal default embedded in plugin.json equals it. A mismatch would mean a
# host with no WORKBENCH_MEMORY_PORT connects to a port the supervisor never
# binds.
LIB_DEFAULT=$(env -i HOME="/nonexistent-$$" PATH="$PATH" WORKBENCH_CONFIG_FILE="/nope-$$.json" \
  bash -c '. "'"$ENV_LIB"'"; memory_load_env; printf "%s" "$MEMORY_PORT"')
URL_DEFAULT=$(printf '%s' "$URL" | sed -n 's/.*WORKBENCH_MEMORY_PORT:-\([0-9]*\)}.*/\1/p')
echo "    lib default=$LIB_DEFAULT  url default=$URL_DEFAULT"
assert "plugin.json default == lib default" \
  "$([ -n "$URL_DEFAULT" ] && [ "$URL_DEFAULT" = "$LIB_DEFAULT" ] && echo true || echo false)"

echo "bearer-token Authorization header is present:"
AUTH=$(jq -r "$MEM.headers.Authorization // empty" "$PLUGIN_JSON")
echo "    Authorization = $AUTH"
assert "Authorization header present" "$([ -n "$AUTH" ] && echo true || echo false)"
assert "header carries the token env" \
  "$(printf '%s' "$AUTH" | grep -q 'Bearer \${WORKBENCH_MEMORY_TOKEN}' && echo true || echo false)"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
