#!/bin/bash
# Pins which memory work hooks/hooks.json still runs as command hooks, and
# which moved into the hooks module (hooks/register.ts). Run directly:
# ./test-memory-module-hooks.sh
#
# Vault work must never show Mike a turn or ask him anything (vault:
# feedback/memory-vault-activity-fully-transparent). The Stop hook that woke
# the model for a memory capture showed one, so it must stay gone, and so must
# the bash recall, learnings and intake hooks the module replaced: a second
# copy would inject everything twice. The log writers stay: session-log.sh is
# the one writer of the log and its checkpoint, on PreCompact and SessionEnd,
# and the module runs it on every turn as well.

set -u
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOKS_JSON="$HOOKS_DIR/hooks.json"
PASS=0
FAIL=0

eq() { if [ "$2" = "$3" ]; then PASS=$((PASS + 1)); echo "  ✅ $1"; else FAIL=$((FAIL + 1)); echo "  ❌ $1 — got '$2', want '$3'"; fi; }
count() { jq -r --arg h "$1" '[.hooks[]?[]?.hooks[]? | select(.command | test($h))] | length' "$HOOKS_JSON"; }

echo "the hooks module is loaded:"
eq "hooks.json names register.ts" "$(jq -r '.modules | join(",")' "$HOOKS_JSON")" "./register.ts"

echo "no command hook shows a turn or injects what the module injects:"
eq "no Stop hook (the capture checkpoint's visible wake)" "$(jq -r '.hooks.Stop // [] | length' "$HOOKS_JSON")" 0
eq "no asyncRewake hook anywhere" "$(jq -r '[.. | objects | select(has("asyncRewake"))] | length' "$HOOKS_JSON")" 0
eq "no UserPromptSubmit recall" "$(jq -r '.hooks.UserPromptSubmit // [] | length' "$HOOKS_JSON")" 0
eq "no PostToolUse scan recall" "$(jq -r '.hooks.PostToolUse // [] | length' "$HOOKS_JSON")" 0
for script in memory-capture-stop.sh memory-recall.sh memory-scan-recall.sh skill-learnings.sh intake-nudge.sh; do
  eq "$script is not registered" "$(count "$script")" 0
  eq "$script is not shipped" "$([ -e "$HOOKS_DIR/$script" ] && echo shipped || echo gone)" gone
done

echo "the log writers stay:"
eq "session-log.sh runs on PreCompact" "$(jq -r '[.hooks.PreCompact[].hooks[].command | select(test("session-log.sh"))] | length' "$HOOKS_JSON")" 1
eq "session-log.sh runs on SessionEnd" "$(jq -r '[.hooks.SessionEnd[].hooks[].command | select(test("session-log.sh"))] | length' "$HOOKS_JSON")" 1

# The guards moved into the module too. Not one hook in hooks.json may run a
# ported guard, and no hooks/<guard>.sh may come back beside its port.
echo "no bash hook runs a guard that moved into the module:"
for guard in credential-guard provisioning-guard summary-writer-guard peer-message-gate \
             destructive-scope-guard destructive-database-guard vault-git-guard outbound-prose-guard \
             delegation-gate; do
  if grep -q "$guard" "$HOOKS_JSON" || [ -e "$HOOKS_DIR/$guard.sh" ]; then
    FAIL=$((FAIL + 1)); echo "  ❌ $guard is still a bash hook"
  else
    PASS=$((PASS + 1)); echo "  ✅ $guard is not a bash hook"
  fi
done

echo
echo "memory-module-hooks: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
