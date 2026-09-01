#!/bin/bash
# Tests for the plugin.json memory MCP server config and its hook wiring.
# Run directly: ./test-plugin-http-config.sh
#
# Asserts the memory server is declared as the shared HTTP transport — a
# type/url/headers triple pointing at the loopback port with a bearer token —
# and that the per-session stdio launcher keys (command/args) are gone.
#
# The transport went back to shared HTTP when Cowork left scope: per-session
# stdio existed only because Cowork's remote sandbox cannot reach a loopback
# port on the host. Without that constraint the shared server is the better
# answer — one embedding model resident instead of N, one single-owner
# IndexWriter serializing writes, and one process for the git sync loop, whose
# quiescing locks are in-process and therefore need a single writer.
#
# The lifetime hooks are asserted here too, because the transport is only safe
# with them: the server must come up on demand and go away when the last session
# does. See test-memory-refs.sh for the refcount semantics themselves.

set -u
HOOKS="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HOOKS/.." && pwd)"
PLUGIN_JSON="$ROOT/.claude-plugin/plugin.json"
HOOKS_JSON="$HOOKS/hooks.json"
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
eq() { [ "$1" = "$2" ] && echo true || echo false; }
# bash 3.2 — the system bash on macOS — cannot parse a `case` inside $( ), so a
# glob test written inline as "$(case "$X" in pat) ...)" is a syntax error there
# and every such assertion reports false regardless of the value. Keeping the
# `case` inside a function body avoids the parser bug, so the suite runs on the
# maintainer's own machine and not only on CI's bash 5.
# SC2254: $2 is deliberately unquoted — callers pass a glob ('http://127.0.0.1:*')
# and quoting it would match the pattern literally, which is the opposite of the
# intent. Every caller passes a single-quoted literal, so there is no word-splitting
# risk. Patterns carrying ${...} are matched literally: $2 expands once and the
# result is not rescanned.
# shellcheck disable=SC2254
like() { case "$1" in $2) echo true ;; *) echo false ;; esac; }

echo "plugin.json is valid JSON:"
assert "valid JSON" "$(jq empty "$PLUGIN_JSON" 2>/dev/null && echo true || echo false)"

MEM='.mcpServers.memory'

echo "memory server uses the shared HTTP transport:"
assert "type == http" "$(eq "$(jq -r "$MEM.type // empty" "$PLUGIN_JSON")" "http")"

URL=$(jq -r "$MEM.url // empty" "$PLUGIN_JSON")
assert "url is loopback" "$(like "$URL" 'http://127.0.0.1:*')"
# The port must stay overridable: WORKBENCH_MEMORY_PORT in settings.json is what
# the host connects to, and a hardcoded port here would silently diverge from the
# recorded server.port — the exact drift the probe reports as PORT_DRIFT.
assert "port honours WORKBENCH_MEMORY_PORT with a default" \
  "$(like "$URL" '*${WORKBENCH_MEMORY_PORT:-8765}*')"
assert "url mounts /mcp" "$(like "$URL" '*/mcp')"

AUTH=$(jq -r "$MEM.headers.Authorization // empty" "$PLUGIN_JSON")
assert "bearer token header present" \
  "$(like "$AUTH" 'Bearer ${WORKBENCH_MEMORY_TOKEN}')"

echo "the per-session stdio launcher keys are gone:"
for key in command args; do
  HAS=$(jq -e "$MEM | has(\"$key\")" "$PLUGIN_JSON" >/dev/null 2>&1 && echo true || echo false)
  assert "no leftover '$key' key" "$(eq "$HAS" "false")"
done

echo "the server has a lifetime — it comes up on demand and goes away after:"
SS=$(jq -r '.hooks.SessionStart[0].hooks[].command' "$HOOKS_JSON")
SE=$(jq -r '.hooks.SessionEnd[0].hooks[].command' "$HOOKS_JSON")
assert "SessionStart kicks memory-server-up.sh" \
  "$(like "$SS" '*memory-server-up.sh*')"
assert "SessionEnd runs memory-server-release.sh" \
  "$(like "$SE" '*memory-server-release.sh*')"

# Ordering is load-bearing: session-warmup.sh probes the server to decide which
# health notice to print, so the hook that kicks the spawn has to run first or
# every cold start reports "Memory server starting" for a server nothing asked for.
FIRST=$(jq -r '.hooks.SessionStart[0].hooks[0].command' "$HOOKS_JSON")
assert "memory-server-up precedes session-warmup" \
  "$(like "$FIRST" '*memory-server-up.sh*')"

echo "the lifetime scripts exist and are executable:"
for f in memory-server-up.sh memory-server-release.sh memory-server-idle-stop.sh memory-server-down.sh; do
  assert "hooks/$f present"    "$([ -f "$HOOKS/$f" ] && echo true || echo false)"
  assert "hooks/$f executable" "$([ -x "$HOOKS/$f" ] && echo true || echo false)"
done
assert "hooks/lib/memory-refs.sh present" \
  "$([ -f "$HOOKS/lib/memory-refs.sh" ] && echo true || echo false)"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
