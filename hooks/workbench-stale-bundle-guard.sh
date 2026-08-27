#!/bin/bash
# workbench-stale-bundle-guard — UserPromptSubmit hook.
#
# The Claude desktop app serves plugin bundles from a server-ingested rpm/ cache
# (api.anthropic.com, per-marketplaceId). That ingest can freeze weeks behind the
# CLI-installed copy, so a /workbench-* command can be expanded from stale code
# and silently overwrite state a newer version deployed.
#
# On any /workbench-* prompt, resolve the authoritative install path from the CLI
# plugin registry and tell Claude to execute THAT body instead of the injected one.
# Silent when the served bundle already matches the installed version.

set -u

REGISTRY="$HOME/.claude/plugins/installed_plugins.json"
MARKETPLACE="claude-workbench"

payload=$(cat)
command -v jq >/dev/null 2>&1 || exit 0
prompt=$(printf '%s' "$payload" | jq -r '.prompt // empty' 2>/dev/null)

case "$prompt" in
  /workbench-*) ;;
  *) exit 0 ;;
esac

[ -f "$REGISTRY" ] || exit 0

# "/workbench-dev-team:setup extra args" -> plugin=workbench-dev-team cmd=setup
spec=${prompt#/}
spec=${spec%%[[:space:]]*}
plugin=${spec%%:*}
cmd=${spec#*:}
[ "$cmd" = "$spec" ] && cmd=""

install_path=$(jq -r --arg k "$plugin@$MARKETPLACE" '.plugins[$k][0].installPath // empty' "$REGISTRY" 2>/dev/null)
version=$(jq -r --arg k "$plugin@$MARKETPLACE" '.plugins[$k][0].version // empty' "$REGISTRY" 2>/dev/null)

[ -n "$install_path" ] && [ -d "$install_path" ] || exit 0

# What did this app actually serve? Used only to report real drift and stay quiet otherwise.
bundle_ver=""
manifest=$(find "$HOME/Library/Application Support/Claude/local-agent-mode-sessions" \
  -maxdepth 5 -path "*/rpm/manifest.json" -print 2>/dev/null | while read -r m; do
    printf '%s\t%s\n' "$(stat -f '%m' "$m" 2>/dev/null)" "$m"
  done | sort -rn | head -1 | cut -f2-)
if [ -n "$manifest" ]; then
  pid=$(jq -r --arg n "$plugin" '.plugins[]? | select(.name==$n) | .id' "$manifest" 2>/dev/null | head -1)
  [ -n "$pid" ] && bundle_ver=$(jq -r '.version // empty' \
    "$(dirname "$manifest")/$pid/.claude-plugin/plugin.json" 2>/dev/null)
fi

# Versions agree -> nothing to warn about.
[ -n "$bundle_ver" ] && [ "$bundle_ver" = "$version" ] && exit 0

if [ -n "$cmd" ]; then
  target="$install_path/commands/$cmd.md (command) or $install_path/skills/$cmd/SKILL.md (skill)"
else
  target="$install_path"
fi

msg="STALE-BUNDLE GUARD - ${plugin}. This desktop session was served version ${bundle_ver:-UNKNOWN} from its frozen rpm/ bundle, but the authoritative installed version is ${version}. Any command or skill body injected into this turn may be stale. Before acting: read the current body from ${target} and execute THAT, ignoring the injected text where they differ. State in one line which version you executed. Do not edit anything under ~/.claude/plugins/cache - it is a read-only reference."

jq -n --arg c "$msg" '{hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:$c}}'
