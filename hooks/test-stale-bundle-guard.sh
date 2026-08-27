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
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]
