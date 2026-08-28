#!/bin/bash
# workbench-stale-bundle-guard — UserPromptSubmit + PreToolUse(Skill) hook.
#
# The Claude desktop app serves plugin bundles from a server-ingested rpm/ cache
# (api.anthropic.com, per-marketplaceId). That ingest can freeze weeks behind the
# CLI-installed copy, so a workbench command or skill can be expanded from stale
# code and silently overwrite state a newer version deployed.
#
# Two entry points, because a skill reaches execution by two routes:
#
#   UserPromptSubmit  — the user typed `/workbench-…`. Fires early, before Claude
#                       plans, so the warning can shape the whole turn.
#   PreToolUse(Skill) — a skill is actually being invoked. This is the one that
#                       catches PROSE. On 2026-08-28 "run the memory lint" loaded a
#                       v0.13.2 body against v0.18.0 installed, twice in one day,
#                       because the prompt carried no slash command for the
#                       UserPromptSubmit gate to match. The tool call is the event
#                       that always happens, whatever the user typed.
#
# Either way: resolve the authoritative install path from the CLI plugin registry
# and tell Claude to execute THAT body instead of the injected one. Silent when the
# served bundle already matches the installed version.

set -u

# Paths are overridable so the behaviour can be tested deterministically instead
# of depending on whatever this host happens to have installed. Same convention as
# scripts/settings-hooks.sh (WORKBENCH_SETTINGS_FILE).
REGISTRY="${WORKBENCH_REGISTRY_FILE:-$HOME/.claude/plugins/installed_plugins.json}"
SESSIONS_DIR="${WORKBENCH_SESSIONS_DIR:-$HOME/Library/Application Support/Claude/local-agent-mode-sessions}"
MARKETPLACE="${WORKBENCH_MARKETPLACE:-claude-workbench}"

payload=$(cat)
command -v jq >/dev/null 2>&1 || exit 0
event=$(printf '%s' "$payload" | jq -r '.hook_event_name // empty' 2>/dev/null)

# Resolve "<plugin>:<cmd>" from whichever event delivered us here.
case "$event" in
  PreToolUse)
    # The Skill tool carries `skill: "<plugin>:<name>"`, or a bare name for a
    # non-plugin skill. This path is what catches a prose invocation.
    [ "$(printf '%s' "$payload" | jq -r '.tool_name // empty' 2>/dev/null)" = "Skill" ] || exit 0
    spec=$(printf '%s' "$payload" | jq -r '.tool_input.skill // empty' 2>/dev/null)
    ;;
  *)
    prompt=$(printf '%s' "$payload" | jq -r '.prompt // empty' 2>/dev/null)
    case "$prompt" in
      /workbench-*) ;;
      *) exit 0 ;;
    esac
    spec=${prompt#/}
    spec=${spec%%[[:space:]]*}
    ;;
esac

# Only workbench plugins are served from the frozen bundle this guard protects.
case "$spec" in
  workbench-*) ;;
  *) exit 0 ;;
esac

[ -f "$REGISTRY" ] || exit 0

# "workbench-dev-team:setup" -> plugin=workbench-dev-team cmd=setup
plugin=${spec%%:*}
cmd=${spec#*:}
[ "$cmd" = "$spec" ] && cmd=""

install_path=$(jq -r --arg k "$plugin@$MARKETPLACE" '.plugins[$k][0].installPath // empty' "$REGISTRY" 2>/dev/null)
version=$(jq -r --arg k "$plugin@$MARKETPLACE" '.plugins[$k][0].version // empty' "$REGISTRY" 2>/dev/null)

[ -n "$install_path" ] && [ -d "$install_path" ] || exit 0

# What did this app actually serve? Used only to report real drift and stay quiet otherwise.
bundle_ver=""
manifest=$(find "$SESSIONS_DIR" \
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

# Each event takes its own envelope: UserPromptSubmit injects context, PreToolUse
# allows the call and attaches the warning as a systemMessage. Never deny — the
# skill should still run, just against the body this message names.
if [ "$event" = "PreToolUse" ]; then
  jq -n --arg c "$msg" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow"},systemMessage:$c}'
else
  jq -n --arg c "$msg" \
    '{hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:$c}}'
fi
