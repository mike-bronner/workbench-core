#!/bin/bash
# Tests for scripts/setup-config.sh — the steps of /workbench-core:setup that
# need no judgment. Run directly: ./test-setup-config.sh
# Each case points the script at a sandbox HOME, config.json and settings.json
# (WORKBENCH_CONFIG_FILE, WORKBENCH_SETTINGS_FILE) and asserts the files after.

set -u
SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/setup-config.sh"
PASS=0
FAIL=0

SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

ok() { PASS=$((PASS + 1)); echo "  ✅ $1"; }
no() { FAIL=$((FAIL + 1)); echo "  ❌ $1"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else no "$1 — expected [$3], got [$2]"; fi; }

HOME_DIR="$SANDBOX/home"
CONFIG="$SANDBOX/config.json"
SETTINGS="$SANDBOX/settings.json"
DATA="$HOME_DIR/.claude/plugins/data"

setup() {
  env HOME="$HOME_DIR" WORKBENCH_CONFIG_FILE="$CONFIG" WORKBENCH_SETTINGS_FILE="$SETTINGS" bash "$SCRIPT" "$@"
}
# GNU stat first: on Linux, `stat -f` reads the file system and succeeds.
mode_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }
fresh() { rm -rf "${SANDBOX:?}/home" "${SANDBOX:?}/cache" "$CONFIG" "$SETTINGS"; mkdir -p "$HOME_DIR"; }

FIELDS=(--agent-name Watson --memory-path /v --memory-cache /c --mcp-name Watson-memory --summary-model sonnet --auto-summarize true)

echo "migrate (Step 0):"
fresh
mkdir -p "$DATA/workbench-claude-workbench"
printf '{"agent_name":"Old"}' > "$DATA/workbench-claude-workbench/config.json"
OUT=$(setup migrate)
check "the legacy directory moves to the new path" "$(jq -r .agent_name "$DATA/workbench-core-claude-workbench/config.json")" "Old"
[ ! -e "$DATA/workbench-claude-workbench" ] && ok "and is gone from the old path" || no "and is gone from the old path"
case "$OUT" in migrated*) ok "it says it migrated" ;; *) no "it says it migrated — got: $OUT" ;; esac
mkdir -p "$DATA/workbench-claude-workbench"
OUT=$(setup migrate)
[ -d "$DATA/workbench-claude-workbench.legacy-$(date +%Y%m%d)" ] && ok "with both present, the old one is archived" || no "with both present, the old one is archived"
check "and the new one wins" "$(jq -r .agent_name "$DATA/workbench-core-claude-workbench/config.json")" "Old"
OUT=$(setup migrate); RC=$?
check "with nothing to migrate it prints nothing" "$OUT" ""
check "and exits 0" "$RC" "0"

echo "write-config (Step 2):"
fresh
setup write-config "${FIELDS[@]}" --memory-port 8765 >/dev/null
check "fields are written" "$(jq -c '[.agent_name,.memory_path,.memory_cache,.memory_mcp_server_name,.summary_model,.auto_summarize]' "$CONFIG")" '["Watson","/v","/c","Watson-memory","sonnet",true]'
check "the default port is left out" "$(jq -r 'has("memory_port")' "$CONFIG")" "false"
setup write-config "${FIELDS[@]}" --memory-port 9123 >/dev/null
check "a non-default port is written as a number" "$(jq '.memory_port' "$CONFIG")" "9123"
setup write-config "${FIELDS[@]}" --memory-port 8765 >/dev/null
check "going back to the default removes it" "$(jq -r 'has("memory_port")' "$CONFIG")" "false"
printf '{"persona":"clear","output_style":"Clear","identity_files":["x"],"other":1}' > "$CONFIG"
setup write-config "${FIELDS[@]}" --memory-port 8765 >/dev/null
check "keys it does not set are kept" "$(jq -c '[.persona,.output_style,.other]' "$CONFIG")" '["clear","Clear",1]'
check "identity_files is deleted" "$(jq -r 'has("identity_files")' "$CONFIG")" "false"
BEFORE=$(cat "$CONFIG")
setup write-config "${FIELDS[@]}" --memory-port 8765 >/dev/null
check "a second run writes the same bytes" "$(cat "$CONFIG")" "$BEFORE"
setup write-config --agent-name Watson --memory-path /v --memory-cache /c --mcp-name m --summary-model sonnet --auto-summarize false --memory-port 8765 >/dev/null
check "auto_summarize false is written as false" "$(jq '.auto_summarize' "$CONFIG")" "false"

echo "write-config refuses what a field cannot take, and writes nothing:"
BEFORE=$(cat "$CONFIG")
for bad in "--auto-summarize yes" "--auto-summarize 1" "--memory-port 0" "--memory-port 65536" "--memory-port 08765" "--memory-port abc" "--memory-port 1e3"; do
  # shellcheck disable=SC2086
  if setup write-config --agent-name W --memory-path /v --memory-cache /c --mcp-name m --summary-model s --auto-summarize true --memory-port 8765 $bad >/dev/null 2>&1; then
    no "refused: $bad"
  else
    ok "refused: $bad"
  fi
done
if setup write-config --agent-name W --memory-path /v --memory-cache /c --mcp-name m --auto-summarize true --memory-port 8765 >/dev/null 2>&1; then
  no "refused: a missing field"
else
  ok "refused: a missing field"
fi
check "config.json is untouched by every refusal" "$(cat "$CONFIG")" "$BEFORE"
printf '[1,2]' > "$CONFIG"
setup write-config "${FIELDS[@]}" --memory-port 8765 >/dev/null 2>&1 && no "a config.json that is not an object is refused" || ok "a config.json that is not an object is refused"
check "and left as it was" "$(cat "$CONFIG")" "[1,2]"

echo "provision-token (Step 2b):"
fresh
printf '{"env":{"KEEP":"1"},"model":"opus"}' > "$SETTINGS"
setup provision-token --memory-cache "$SANDBOX/cache" --memory-port 8765 >/dev/null
TOKEN=$(cat "$SANDBOX/cache/server.token")
[[ "$TOKEN" =~ ^[0-9a-f]{64}$ ]] && ok "a 64-hex-digit token is minted" || no "a 64-hex-digit token is minted — got: $TOKEN"
check "the token file is 0600" "$(mode_of "$SANDBOX/cache/server.token")" "600"
check "the cache directory is 0700" "$(mode_of "$SANDBOX/cache")" "700"
check "settings.json carries the token" "$(jq -r '.env.WORKBENCH_MEMORY_TOKEN' "$SETTINGS")" "$TOKEN"
check "with no trailing newline" "$(jq -r '.env.WORKBENCH_MEMORY_TOKEN | length' "$SETTINGS")" "64"
check "every other setting is kept" "$(jq -c '[.env.KEEP,.model]' "$SETTINGS")" '["1","opus"]'
check "settings.json is 0600" "$(mode_of "$SETTINGS")" "600"
check "the default port is left out" "$(jq -r '.env | has("WORKBENCH_MEMORY_PORT")' "$SETTINGS")" "false"
setup provision-token --memory-cache "$SANDBOX/cache" --memory-port 9123 >/dev/null
check "a second run reuses the token" "$(cat "$SANDBOX/cache/server.token")" "$TOKEN"
check "a non-default port is written as a string" "$(jq -c '.env.WORKBENCH_MEMORY_PORT' "$SETTINGS")" '"9123"'
setup provision-token --memory-cache "$SANDBOX/cache" --memory-port 8765 >/dev/null
check "going back to the default removes it" "$(jq -r '.env | has("WORKBENCH_MEMORY_PORT")' "$SETTINGS")" "false"
rm -f "$SETTINGS"
setup provision-token --memory-cache "$SANDBOX/cache" --memory-port 8765 >/dev/null
check "an absent settings.json is created" "$(jq -r '.env.WORKBENCH_MEMORY_TOKEN' "$SETTINGS")" "$TOKEN"
printf 'not json' > "$SETTINGS"
setup provision-token --memory-cache "$SANDBOX/cache" --memory-port 8765 >/dev/null 2>&1 && no "a malformed settings.json is refused" || ok "a malformed settings.json is refused"
check "and left as it was" "$(cat "$SETTINGS")" "not json"
setup provision-token --memory-cache "$SANDBOX/cache" --memory-port 99999 >/dev/null 2>&1 && no "a bad port is refused" || ok "a bad port is refused"

echo "leftover-asks (Step 2c.3):"
fresh
printf '{"permissions":{"ask":["Bash(npm publish:*)"]}}' > "$SETTINGS"
case "$(setup leftover-asks)" in "✅ No leftover"*) ok "none found says so" ;; *) no "none found says so" ;; esac
printf '{"permissions":{"ask":["Bash(rm -rf:*)","Bash(git stash drop:*)","Bash(npm publish:*)"]}}' > "$SETTINGS"
BEFORE=$(cat "$SETTINGS")
OUT=$(setup leftover-asks)
case "$OUT" in "⚠  2 leftover"*) ok "two found are counted" ;; *) no "two found are counted — got: $OUT" ;; esac
check "it removes nothing" "$(cat "$SETTINGS")" "$BEFORE"

echo "cap-mcp-output (Step 2g):"
fresh
setup cap-mcp-output >/dev/null
check "an absent key is set to 15000" "$(jq -r '.env.MAX_MCP_OUTPUT_TOKENS' "$SETTINGS")" "15000"
check "settings.json is 0600" "$(mode_of "$SETTINGS")" "600"
printf '{"env":{"MAX_MCP_OUTPUT_TOKENS":"40000"}}' > "$SETTINGS"
setup cap-mcp-output >/dev/null
check "a value the user set is kept" "$(jq -r '.env.MAX_MCP_OUTPUT_TOKENS' "$SETTINGS")" "40000"
printf '"a string"' > "$SETTINGS"
OUT=$(setup cap-mcp-output); RC=$?
check "a settings.json that is not an object fails" "$RC" "1"
case "$OUT" in *"by hand"*) ok "and says to set it by hand" ;; *) no "and says to set it by hand" ;; esac
check "and is left as it was" "$(cat "$SETTINGS")" '"a string"'

echo "usage:"
setup bogus >/dev/null 2>&1; check "an unknown subcommand exits 2" "$?" "2"
setup >/dev/null 2>&1; check "no subcommand exits 2" "$?" "2"
setup migrate extra >/dev/null 2>&1; check "an extra argument exits 2" "$?" "2"

echo "the setup skill runs each step through the script:"
SKILL="$(cd "$(dirname "$0")/.." && pwd)/skills/setup/SKILL.md"
for sub in migrate write-config provision-token leftover-asks cap-mcp-output; do
  grep -q "scripts/setup-config.sh\" $sub" "$SKILL" && ok "setup runs $sub" || no "setup runs $sub"
done
grep -qF '${CLAUDE_PLUGIN_ROOT}/skills/setup/references/git-sync.md' "$SKILL" \
  && ok "setup links to the git-sync reference" || no "setup links to the git-sync reference"
[ -f "$(dirname "$SKILL")/references/git-sync.md" ] \
  && ok "and the reference is there" || no "and the reference is there"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
