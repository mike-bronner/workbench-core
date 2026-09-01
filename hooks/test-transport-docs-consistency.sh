#!/bin/bash
# Guards user-facing docs against drifting from the actual memory transport.
# Run directly: ./test-transport-docs-consistency.sh
#
# WHY THIS EXISTS
#
# 0.19.0 flipped the transport from per-session stdio to the shared HTTP server
# and updated the README and the hook tests — but NOT skills/setup/SKILL.md.
# That skill's Step 2b said "Skip this step under the default per-session stdio
# transport", and Step 2b is the step that mints WORKBENCH_MEMORY_TOKEN. So the
# released setup skill instructed itself to skip the one action that makes
# memory work, and a fresh install failed with:
#
#   Invalid MCP server config for "memory": Missing environment variables:
#   WORKBENCH_MEMORY_TOKEN
#
# skills/memory-status — the tool a user reaches for when memory is broken —
# was stale in the same way, reporting "no port, no token, nothing to probe".
#
# Every existing test asserted behaviour. Nothing asserted that the PROSE
# telling a human what to do still matched the code, so the drift shipped.
# These checks close that gap: they read plugin.json as the source of truth for
# the transport and assert the user-facing docs agree with it.

set -u
HOOKS="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HOOKS/.." && pwd)"
PLUGIN_JSON="$ROOT/.claude-plugin/plugin.json"
PASS=0
FAIL=0

if ! command -v jq >/dev/null 2>&1; then
  echo "SKIP: jq not on PATH"
  exit 0
fi

ok()  { PASS=$((PASS + 1)); echo "  ✅ $1"; }
no()  { FAIL=$((FAIL + 1)); echo "  ❌ $1 — $2"; }

# Source of truth: what transport does plugin.json actually declare?
TRANSPORT="$(jq -r '.mcpServers.memory.type // "stdio"' "$PLUGIN_JSON")"
echo "plugin.json declares transport: $TRANSPORT"
echo

# Docs a human reads and acts on. Excludes README's history sections and code
# comments, which legitimately discuss the transport that is NOT in use.
USER_DOCS="$ROOT/skills/setup/SKILL.md $ROOT/skills/memory-status/SKILL.md"

if [ "$TRANSPORT" = "http" ]; then
  echo "under the shared HTTP transport, the setup skill must PROVISION the token:"

  # The exact failure that shipped: an instruction to skip token provisioning.
  if grep -qiE '^> \*\*Skip this step' "$ROOT/skills/setup/SKILL.md"; then
    no "setup does not tell the user to skip token provisioning" \
       "Step 2b still opens with a Skip directive"
  else
    ok "setup does not tell the user to skip token provisioning"
  fi

  # Without this the MCP config is rejected before any server is started.
  grep -q 'WORKBENCH_MEMORY_TOKEN' "$ROOT/skills/setup/SKILL.md" \
    && ok "setup still mints WORKBENCH_MEMORY_TOKEN" \
    || no "setup still mints WORKBENCH_MEMORY_TOKEN" "no mention of the token"

  # A new session does NOT re-read settings.json .env; only a relaunch does.
  # Getting this wrong sends the user in circles on a fresh install.
  grep -qiE 'relaunch|restart Claude Code' "$ROOT/skills/setup/SKILL.md" \
    && ok "setup tells the user to relaunch, not just start a new session" \
    || no "setup tells the user to relaunch" "no relaunch instruction found"

  echo
  echo "no user-facing doc may still describe the retired transport as current:"
  for f in $USER_DOCS; do
    # "per-session stdio" is only allowed in a clause that marks it as history.
    BAD=$(grep -niE 'per-session stdio|stdio server|stdio transport|stdio launcher' "$f" \
          | grep -viE 'restored|until|previously|used to|through v0\.|forced per-session|was a per-session|retired|historic' || true)
    if [ -z "$BAD" ]; then
      ok "$(basename "$(dirname "$f")")/$(basename "$f") describes the live transport"
    else
      no "$(basename "$(dirname "$f")")/$(basename "$f") describes the live transport" \
         "stale line(s): $(echo "$BAD" | head -2 | cut -c1-90)"
    fi
  done

  echo
  echo "the lifetime scripts the docs promise actually exist:"
  for f in memory-server-up.sh memory-server-release.sh memory-server-idle-stop.sh memory-server-down.sh; do
    [ -x "$HOOKS/$f" ] && ok "hooks/$f" || no "hooks/$f" "missing or not executable"
  done

elif [ "$TRANSPORT" = "stdio" ]; then
  echo "under per-session stdio, the docs must NOT demand a port or a token:"
  grep -q 'mcp-memory.sh' "$ROOT/skills/memory-status/SKILL.md" \
    && ok "memory-status names the stdio launcher" \
    || no "memory-status names the stdio launcher" "no mention of mcp-memory.sh"
else
  no "recognised transport" "plugin.json declares '$TRANSPORT'"
fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
