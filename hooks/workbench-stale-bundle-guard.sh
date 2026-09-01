#!/bin/bash
# workbench-stale-bundle-guard — SessionStart + UserPromptSubmit + PreToolUse(Skill) hook.
#
# The Claude desktop app serves plugin bundles from a server-ingested rpm/ cache
# (api.anthropic.com, per-marketplaceId). That ingest can freeze weeks behind the
# CLI-installed copy, so a workbench command or skill can be expanded from stale
# code and silently overwrite state a newer version deployed.
#
# Three entry points, because staleness reaches the user by three routes:
#
#   UserPromptSubmit  — the user typed `/workbench-…`. Fires early, before Claude
#                       plans, so the warning can shape the whole turn.
#   PreToolUse(Skill) — a skill is actually being invoked. This is the one that
#                       catches PROSE. On 2026-08-28 "run the memory lint" loaded a
#                       v0.13.2 body against v0.18.0 installed, twice in one day,
#                       because the prompt carried no slash command for the
#                       UserPromptSubmit gate to match. The tool call is the event
#                       that always happens, whatever the user typed.
#   SessionStart      — nothing was invoked at all. Both gates above key on the user
#                       reaching for a skill; a frozen bundle also ships stale HOOKS
#                       and stale MCP SERVERS, which fail with no skill in sight. On
#                       2026-08-29 a frozen workbench-core 0.13.2 served a memory
#                       server whose venv layout predated the installed fix; every
#                       memory MCP in every session died, and neither gate above had
#                       anything to hook. This one sweeps EVERY workbench plugin at
#                       session start, so drift is reported before it can bite.
#
# The invocation paths resolve the authoritative install path from the CLI plugin
# registry and tell Claude to execute THAT body instead of the injected one. The
# SessionStart path has no body to redirect, so it reports the drift and the remedy.
# Silent whenever the served bundles already match the installed versions.

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

# What did this app actually serve? Resolved LAZILY and once: the find walks the
# sessions tree, and UserPromptSubmit fires on every prompt — the overwhelming
# majority of which exit before ever needing this.
# Epoch mtime, portably. GNU `stat -c` is probed FIRST because on GNU `stat -f`
# means "filesystem status" and prints something unrelated instead of failing —
# probing BSD first would yield garbage on Linux rather than falling through.
# Same ordering convention as workbench-ynab's octal-perms reads.
#
# This hook only ever finds manifests under the desktop app's bundle cache, which
# exists on macOS alone — so on Linux the find returns nothing and this is never
# called. It stays portable anyway because WORKBENCH_SESSIONS_DIR can point the
# hook at any directory, and the test suite does exactly that.
_mtime() {
  stat -c '%Y' "$1" 2>/dev/null || stat -f '%m' "$1" 2>/dev/null
}

_manifest=""
_manifest_resolved=0
_bundle_version() {  # _bundle_version <plugin-name> -> served version, or empty
  if [ "$_manifest_resolved" = "0" ]; then
    _manifest_resolved=1
    _manifest=$(find "$SESSIONS_DIR" \
      -maxdepth 5 -path "*/rpm/manifest.json" -print 2>/dev/null | while read -r m; do
        printf '%s\t%s\n' "$(_mtime "$m")" "$m"
      done | sort -rn | head -1 | cut -f2-)
  fi
  [ -n "$_manifest" ] || return 0
  local pid
  pid=$(jq -r --arg n "$1" '.plugins[]? | select(.name==$n) | .id' "$_manifest" 2>/dev/null | head -1)
  [ -n "$pid" ] || return 0
  jq -r '.version // empty' \
    "$(dirname "$_manifest")/$pid/.claude-plugin/plugin.json" 2>/dev/null
}

[ -f "$REGISTRY" ] || exit 0

# ──────────── SessionStart: sweep every workbench plugin ────────────
# No spec to resolve — nothing has been invoked. Report every drifted plugin at
# once so a single warning covers the whole freeze rather than one plugin at a time.
if [ "$event" = "SessionStart" ]; then
  drifted=""
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    plugin=${key%@*}
    # Same scope as the invocation paths: this guard speaks for the workbench
    # freeze, not for anything else sharing the marketplace.
    case "$key" in workbench-*@"$MARKETPLACE") ;; *) continue ;; esac
    version=$(jq -r --arg k "$key" '.plugins[$k][0].version // empty' "$REGISTRY" 2>/dev/null)
    [ -n "$version" ] || continue
    bundle_ver=$(_bundle_version "$plugin")
    # Not served from a bundle at all (CLI-only session) -> nothing to compare.
    [ -n "$bundle_ver" ] || continue
    [ "$bundle_ver" = "$version" ] && continue
    drifted="${drifted}${drifted:+, }${plugin} (serving ${bundle_ver}, installed ${version})"
  done <<EOF
$(jq -r '.plugins | keys[]?' "$REGISTRY" 2>/dev/null)
EOF

  [ -n "$drifted" ] || exit 0

  msg="STALE-BUNDLE GUARD - this desktop session is serving frozen plugin bundles that do not match the CLI-installed versions: ${drifted}. A frozen bundle ships stale skill bodies, commands, hooks AND MCP servers. On 2026-08-29 a frozen workbench-core 0.13.2 served a memory server whose venv layout predated the installed fix, and every memory MCP in every session failed with no warning naming the cause. Remedy: a marketplace update plus an app relaunch is NOT sufficient - that was tried and did not clear it - a full reinstall of the plugin is what evicts the frozen bundle. Until then, read any workbench skill or command body from its installed path before executing it, and treat a failing workbench MCP server as stale-bundle drift first. Do not edit anything under ~/.claude/plugins/cache - it is a read-only reference."

  jq -n --arg c "$msg" \
    '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$c}}'
  exit 0
fi

# ──────────── Invocation paths: resolve "<plugin>:<cmd>" ────────────
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

# "workbench-dev-team:setup" -> plugin=workbench-dev-team cmd=setup
plugin=${spec%%:*}
cmd=${spec#*:}
[ "$cmd" = "$spec" ] && cmd=""

install_path=$(jq -r --arg k "$plugin@$MARKETPLACE" '.plugins[$k][0].installPath // empty' "$REGISTRY" 2>/dev/null)
version=$(jq -r --arg k "$plugin@$MARKETPLACE" '.plugins[$k][0].version // empty' "$REGISTRY" 2>/dev/null)

[ -n "$install_path" ] && [ -d "$install_path" ] || exit 0

bundle_ver=$(_bundle_version "$plugin")

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
