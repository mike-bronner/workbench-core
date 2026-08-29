#!/bin/bash
# Tests for scripts/settings-hooks.sh and hooks/workbench-stale-bundle-guard.sh.
# Run directly: ./test-stale-bundle-guard.sh
# Each case points the merger at a sandbox settings.json via
# WORKBENCH_SETTINGS_FILE and a sandbox hooks dir via WORKBENCH_HOOKS_DIR.
# Pure file merging plus stdin/stdout on the guard — no network, no server.

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MERGER="$ROOT/scripts/settings-hooks.sh"
GUARD="$ROOT/hooks/workbench-stale-bundle-guard.sh"
PASS=0
FAIL=0

SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

ok()   { PASS=$((PASS+1)); printf '  ✅ %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  ❌ %s\n     %s\n' "$1" "${2:-}"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$3] got [$2]"; fi; }

fresh_settings() {
  cat > "$SANDBOX/settings.json" <<'EOF'
{
  "theme": "dark",
  "permissions": { "deny": ["Bash(sudo:*)"] },
  "hooks": {
    "PostToolUse": [
      { "matcher": "ExitPlanMode", "hooks": [{ "type": "command", "command": "echo hi" }] }
    ]
  }
}
EOF
}

export WORKBENCH_SETTINGS_FILE="$SANDBOX/settings.json"
export WORKBENCH_HOOKS_DIR="$SANDBOX/hooks"

echo "settings-hooks.sh — merge semantics"

fresh_settings
"$MERGER" >/dev/null 2>&1
check "adds the UserPromptSubmit entry" \
  "$(jq '.hooks.UserPromptSubmit | length' "$WORKBENCH_SETTINGS_FILE")" "1"
check "adds the PreToolUse(Skill) entry — the prose path" \
  "$(jq '[.hooks.PreToolUse[]? | select(.matcher=="Skill")] | length' "$WORKBENCH_SETTINGS_FILE")" "1"
check "adds the SessionStart entry — the nothing-invoked path" \
  "$(jq '.hooks.SessionStart | length' "$WORKBENCH_SETTINGS_FILE")" "1"
check "preserves the pre-existing PostToolUse entry" \
  "$(jq '.hooks.PostToolUse | length' "$WORKBENCH_SETTINGS_FILE")" "1"

check "entry points at the deployed user path (not the plugin root)" \
  "$(jq -r '.hooks.UserPromptSubmit[0].hooks[0].command' "$WORKBENCH_SETTINGS_FILE")" \
  "$WORKBENCH_HOOKS_DIR/workbench-stale-bundle-guard.sh"

check "no unsubstituted placeholder survives" \
  "$(grep -c '__WORKBENCH_HOOKS_DIR__' "$WORKBENCH_SETTINGS_FILE" || true)" "0"

check "deployed script is executable" \
  "$([ -x "$WORKBENCH_HOOKS_DIR/workbench-stale-bundle-guard.sh" ] && echo yes || echo no)" "yes"

"$MERGER" >/dev/null 2>&1
check "idempotent — second run adds no duplicate" \
  "$(jq '.hooks.UserPromptSubmit | length' "$WORKBENCH_SETTINGS_FILE")" "1"

check "pre-existing PostToolUse hook preserved" \
  "$(jq -r '.hooks.PostToolUse[0].matcher' "$WORKBENCH_SETTINGS_FILE")" "ExitPlanMode"
check "unrelated settings keys preserved" \
  "$(jq -r '[.theme, (.permissions.deny[0])] | join(",")' "$WORKBENCH_SETTINGS_FILE")" \
  "dark,Bash(sudo:*)"

# A user's own UserPromptSubmit hook must survive the merge.
fresh_settings
jq '.hooks.UserPromptSubmit = [{"hooks":[{"type":"command","command":"my-own.sh"}]}]' \
  "$WORKBENCH_SETTINGS_FILE" > "$SANDBOX/t" && mv "$SANDBOX/t" "$WORKBENCH_SETTINGS_FILE"
"$MERGER" >/dev/null 2>&1
check "user's own UserPromptSubmit hook is not clobbered" \
  "$(jq -r '.hooks.UserPromptSubmit[0].hooks[0].command' "$WORKBENCH_SETTINGS_FILE")" "my-own.sh"
check "ours is appended alongside it" \
  "$(jq '.hooks.UserPromptSubmit | length' "$WORKBENCH_SETTINGS_FILE")" "2"

echo 'NOT JSON' > "$WORKBENCH_SETTINGS_FILE"
if "$MERGER" >/dev/null 2>&1; then bad "refuses malformed settings.json" "exited 0"; else ok "refuses malformed settings.json"; fi

rm -f "$WORKBENCH_SETTINGS_FILE"
"$MERGER" >/dev/null 2>&1
check "bootstraps an absent settings.json" \
  "$(jq -r '.hooks | has("UserPromptSubmit")' "$WORKBENCH_SETTINGS_FILE")" "true"

fresh_settings
before="$(cksum < "$WORKBENCH_SETTINGS_FILE")"
"$MERGER" --dry-run >/dev/null 2>&1
check "--dry-run writes nothing" "$(cksum < "$WORKBENCH_SETTINGS_FILE")" "$before"

echo
echo "workbench-stale-bundle-guard.sh — matching"

out=$(printf '{"prompt":"why is the sky blue"}' | "$GUARD")
check "silent on a non-workbench prompt" "${out:-EMPTY}" "EMPTY"

out=$(printf '{"prompt":"/workbench-nonexistent:foo"}' | "$GUARD")
check "silent on an unknown plugin" "${out:-EMPTY}" "EMPTY"

out=$(printf '{"prompt":""}' | "$GUARD")
check "silent on an empty prompt" "${out:-EMPTY}" "EMPTY"

# Only assert JSON validity when the host actually has the plugin installed —
# the guard is correctly silent otherwise, so this must not be a hard failure.
if [ -f "$HOME/.claude/plugins/installed_plugins.json" ]; then
  out=$(printf '{"prompt":"/workbench-core:setup"}' | "$GUARD")
  if [ -n "$out" ]; then
    if printf '%s' "$out" | jq empty 2>/dev/null; then ok "emits valid JSON on drift"; else bad "emits valid JSON on drift" "$out"; fi
    check "uses the UserPromptSubmit event name" \
      "$(printf '%s' "$out" | jq -r '.hookSpecificOutput.hookEventName')" "UserPromptSubmit"
  else
    ok "no drift on this host — guard correctly silent"
  fi
else
  ok "no plugin registry on this host — skipped drift case"
fi


echo
echo "workbench-stale-bundle-guard.sh — PreToolUse(Skill), the prose path"

# A deterministic fixture: a registry holding workbench-core 0.18.0 and a served
# bundle manifest pinned at 0.13.2. Without this the drift assertions depend on
# whatever this host has installed, and silently skip when the versions agree —
# which let three mutations survive on 2026-08-28.
FIX="$SANDBOX/fix"
mkdir -p "$FIX/install" "$FIX/sessions/s1/rpm/p-core/.claude-plugin"
cat > "$FIX/registry.json" <<'EOF'
{ "plugins": { "workbench-core@claude-workbench": [
    { "installPath": "__INSTALL__", "version": "0.18.0" } ] } }
EOF
sed -i.bak "s|__INSTALL__|$FIX/install|" "$FIX/registry.json" && rm -f "$FIX/registry.json.bak"
printf '{"plugins":[{"name":"workbench-core","id":"p-core"}]}' > "$FIX/sessions/s1/rpm/manifest.json"
printf '{"version":"0.13.2"}' > "$FIX/sessions/s1/rpm/p-core/.claude-plugin/plugin.json"

guard() {  # guard <json-payload>
  printf '%s' "$1" | WORKBENCH_REGISTRY_FILE="$FIX/registry.json" \
    WORKBENCH_SESSIONS_DIR="$FIX/sessions" "$GUARD"
}
skillp() { printf '{"hook_event_name":"PreToolUse","tool_name":"Skill","tool_input":{"skill":"%s"}}' "$1"; }

# --- the regression this exists for -------------------------------------
out=$(guard "$(skillp workbench-core:memory-lint)")
if printf '%s' "$out" | jq empty 2>/dev/null; then ok "emits valid JSON on drift"; else bad "emits valid JSON on drift" "${out:-EMPTY}"; fi
check "uses the PreToolUse event name" \
  "$(printf '%s' "$out" | jq -r '.hookSpecificOutput.hookEventName')" "PreToolUse"
check "allows the call rather than denying it" \
  "$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision')" "allow"
check "carries the warning as a systemMessage" \
  "$(printf '%s' "$out" | jq -r 'if .systemMessage then "present" else "MISSING" end')" "present"
check "names both versions in the message" \
  "$(printf '%s' "$out" | jq -r '.systemMessage | if test("0.13.2") and test("0.18.0") then "both" else "incomplete" end')" "both"

# --- scope: must not fire on anything else ------------------------------
out=$(guard '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"skill":"workbench-core:memory-lint"}}')
check "silent on a non-Skill tool even when the input carries a skill key" "${out:-EMPTY}" "EMPTY"

out=$(guard "$(skillp dataviz)")
check "silent on a bare non-workbench skill" "${out:-EMPTY}" "EMPTY"

out=$(guard "$(skillp other-plugin:memory-lint)")
check "silent on a non-workbench plugin skill" "${out:-EMPTY}" "EMPTY"

# The registry lookup alone is not enough scope. A non-workbench plugin can live in
# the same marketplace — none do today, but the guard is about the workbench freeze
# and must not speak for anything else. Registered here so the check stays honest.
cat > "$FIX/registry.json" <<'EOF'
{ "plugins": {
    "workbench-core@claude-workbench": [ { "installPath": "__INSTALL__", "version": "0.18.0" } ],
    "pdf-viewer@claude-workbench":     [ { "installPath": "__INSTALL__", "version": "9.9.9" } ] } }
EOF
sed -i.bak "s|__INSTALL__|$FIX/install|g" "$FIX/registry.json" && rm -f "$FIX/registry.json.bak"
printf '{"plugins":[{"name":"workbench-core","id":"p-core"},{"name":"pdf-viewer","id":"p-pdf"}]}' \
  > "$FIX/sessions/s1/rpm/manifest.json"
mkdir -p "$FIX/sessions/s1/rpm/p-pdf/.claude-plugin"
printf '{"version":"1.0.0"}' > "$FIX/sessions/s1/rpm/p-pdf/.claude-plugin/plugin.json"

out=$(guard "$(skillp pdf-viewer:open)")
check "silent on a drifted NON-workbench plugin in the same marketplace" "${out:-EMPTY}" "EMPTY"

out=$(guard "$(skillp workbench-core:memory-lint)")
check "still fires for workbench-core alongside it" \
  "$(printf '%s' "$out" | jq -r '.hookSpecificOutput.hookEventName')" "PreToolUse"

printf '{"plugins":[{"name":"workbench-core","id":"p-core"}]}' > "$FIX/sessions/s1/rpm/manifest.json"

out=$(guard '{"hook_event_name":"PreToolUse","tool_name":"Skill","tool_input":{}}')
check "silent when the skill name is absent" "${out:-EMPTY}" "EMPTY"

# --- no drift -> no noise ------------------------------------------------
printf '{"version":"0.18.0"}' > "$FIX/sessions/s1/rpm/p-core/.claude-plugin/plugin.json"
out=$(guard "$(skillp workbench-core:memory-lint)")
check "silent when the served bundle matches the install" "${out:-EMPTY}" "EMPTY"
printf '{"version":"0.13.2"}' > "$FIX/sessions/s1/rpm/p-core/.claude-plugin/plugin.json"

# --- the UserPromptSubmit path still works on the same fixture -----------
out=$(guard '{"hook_event_name":"UserPromptSubmit","prompt":"/workbench-core:setup"}')
check "UserPromptSubmit still emits its own envelope" \
  "$(printf '%s' "$out" | jq -r '.hookSpecificOutput.hookEventName')" "UserPromptSubmit"
check "UserPromptSubmit uses additionalContext" \
  "$(printf '%s' "$out" | jq -r 'if .hookSpecificOutput.additionalContext then "present" else "MISSING" end')" "present"

out=$(guard '{"hook_event_name":"UserPromptSubmit","prompt":"run the memory lint"}')
check "prose still silent on UserPromptSubmit — that is why PreToolUse exists" "${out:-EMPTY}" "EMPTY"

echo
echo "workbench-stale-bundle-guard.sh — SessionStart, the nothing-invoked path"

# Its own fixture rather than reusing the one above: this path sweeps the WHOLE
# registry, so the set of plugins in it is the thing under test and must not be
# whatever a previous case happened to leave behind.
S="$SANDBOX/ss"
mkdir -p "$S/install" "$S/sessions/s1/rpm"
for p in p-core p-bujo p-pdf p-solo; do mkdir -p "$S/sessions/s1/rpm/$p/.claude-plugin"; done

ssreg()      { printf '{ "plugins": %s }' "$1" | sed "s|__I__|$S/install|g" > "$S/registry.json"; }
ssmanifest() { printf '%s' "$1" > "$S/sessions/s1/rpm/manifest.json"; }
ssver()      { printf '{"version":"%s"}' "$2" > "$S/sessions/s1/rpm/$1/.claude-plugin/plugin.json"; }
sguard()     { printf '{"hook_event_name":"SessionStart","source":"startup"}' \
                 | WORKBENCH_REGISTRY_FILE="$S/registry.json" \
                   WORKBENCH_SESSIONS_DIR="$S/sessions" "$GUARD"; }
ctx()        { printf '%s' "$1" | jq -r '.hookSpecificOutput.additionalContext // ""'; }

# --- the regression this exists for: drift with nothing invoked ----------
ssreg '{"workbench-core@claude-workbench":[{"installPath":"__I__","version":"0.18.2"}]}'
ssmanifest '{"plugins":[{"name":"workbench-core","id":"p-core"}]}'
ssver p-core 0.13.2

out=$(sguard)
if printf '%s' "$out" | jq empty 2>/dev/null; then ok "emits valid JSON on drift"; else bad "emits valid JSON on drift" "${out:-EMPTY}"; fi
check "uses the SessionStart event name" \
  "$(printf '%s' "$out" | jq -r '.hookSpecificOutput.hookEventName')" "SessionStart"
check "carries the warning as additionalContext" \
  "$(printf '%s' "$out" | jq -r 'if .hookSpecificOutput.additionalContext then "present" else "MISSING" end')" "present"
# Match the LIST ENTRY, not the bare name: the static prose in the message also
# says "workbench-core 0.13.2", so grepping the name alone passes even when the
# drift list is empty or truncated. Cost one surviving mutation to learn.
check "names the plugin and both versions" \
  "$(ctx "$out" | grep -qF 'workbench-core (serving 0.13.2, installed 0.18.2)' && echo all || echo incomplete)" "all"
check "names the remedy that actually works" \
  "$(ctx "$out" | grep -qi 'full reinstall' && echo yes || echo no)" "yes"

# --- sweeps the CLASS, not just the plugin that bit ----------------------
# The whole point of this entry point. A guard that reports only the first
# drifted plugin leaves the rest silently stale.
ssreg '{"workbench-core@claude-workbench":[{"installPath":"__I__","version":"0.18.2"}],
        "workbench-bujo@claude-workbench":[{"installPath":"__I__","version":"0.14.0"}]}'
ssmanifest '{"plugins":[{"name":"workbench-core","id":"p-core"},{"name":"workbench-bujo","id":"p-bujo"}]}'
ssver p-core 0.13.2
ssver p-bujo 0.12.2

out=$(sguard)
check "reports EVERY drifted workbench plugin, not just the first" \
  "$(ctx "$out" | grep -qF 'workbench-core (serving' && ctx "$out" | grep -qF 'workbench-bujo (serving' && echo both || echo partial)" "both"
check "carries each plugin's own served and installed version" \
  "$(ctx "$out" | grep -qF 'workbench-bujo (serving 0.12.2, installed 0.14.0)' \
     && ctx "$out" | grep -qF 'workbench-core (serving 0.13.2, installed 0.18.2)' && echo both || echo partial)" "both"

# --- scope: same marketplace, non-workbench plugin ----------------------
ssreg '{"workbench-core@claude-workbench":[{"installPath":"__I__","version":"0.18.2"}],
        "pdf-viewer@claude-workbench":[{"installPath":"__I__","version":"9.9.9"}]}'
ssmanifest '{"plugins":[{"name":"workbench-core","id":"p-core"},{"name":"pdf-viewer","id":"p-pdf"}]}'
ssver p-pdf 1.0.0

out=$(sguard)
check "excludes a drifted NON-workbench plugin in the same marketplace" \
  "$(ctx "$out" | grep -q 'pdf-viewer' && echo leaked || echo excluded)" "excluded"
check "still reports workbench-core alongside it" \
  "$(ctx "$out" | grep -qF 'workbench-core (serving' && echo yes || echo no)" "yes"

# --- scope: workbench-named plugin from a DIFFERENT marketplace ---------
# The key is "<plugin>@<marketplace>"; matching on the plugin prefix alone would
# let another marketplace's workbench-* plugin in.
ssreg '{"workbench-solo@other-market":[{"installPath":"__I__","version":"5.0.0"}]}'
ssmanifest '{"plugins":[{"name":"workbench-solo","id":"p-solo"}]}'
ssver p-solo 1.0.0

out=$(sguard)
check "silent for a workbench-* plugin from another marketplace" "${out:-EMPTY}" "EMPTY"

# --- no drift -> no noise ------------------------------------------------
ssreg '{"workbench-core@claude-workbench":[{"installPath":"__I__","version":"0.18.2"}]}'
ssmanifest '{"plugins":[{"name":"workbench-core","id":"p-core"}]}'
ssver p-core 0.18.2
out=$(sguard)
check "silent when the served bundle matches the install" "${out:-EMPTY}" "EMPTY"

# --- served-by-nothing is not drift -------------------------------------
# A CLI-only session serves no bundle. Reporting "installed 0.18.2, serving
# nothing" as drift would fire on every terminal session forever.
ssmanifest '{"plugins":[]}'
out=$(sguard)
check "silent when the plugin is in no served bundle" "${out:-EMPTY}" "EMPTY"

rm -f "$S/sessions/s1/rpm/manifest.json"
out=$(sguard)
check "silent when no bundle manifest exists at all" "${out:-EMPTY}" "EMPTY"

# --- absent registry ------------------------------------------------------
out=$(printf '{"hook_event_name":"SessionStart","source":"startup"}' \
        | WORKBENCH_REGISTRY_FILE="$S/nope.json" WORKBENCH_SESSIONS_DIR="$S/sessions" "$GUARD")
check "silent when the registry is absent" "${out:-EMPTY}" "EMPTY"

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]
