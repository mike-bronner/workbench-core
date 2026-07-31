#!/bin/bash
# Tests for memory-capture-nudge.sh. Run directly: ./test-memory-capture-nudge.sh
# Each case feeds a synthetic UserPromptSubmit payload on stdin inside a sandbox
# state dir and asserts whether the nudge JSON is emitted, that the heartbeat
# fires on the Nth turn and resets, and that bad input never breaks the hook.

set -u
NUDGE="$(cd "$(dirname "$0")" && pwd)/memory-capture-nudge.sh"
PASS=0
FAIL=0

SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

# A canary unique to the nudge payload — asserting on it proves the line fired.
NUDGE_CANARY="Capture check"

# run: pipe a payload into the hook with a fresh-or-shared sandbox state dir.
# Args: <prompt> <session_id> [interval] [extra env assignments...]
run() {
  local prompt="$1" sid="$2" interval="${3:-8}"
  printf '{"prompt":%s,"session_id":"%s"}' \
    "$(printf '%s' "$prompt" | jq -Rs .)" "$sid" | \
    HOME="$SANDBOX/home" \
    WORKBENCH_MEMORY_NUDGE_STATE="$SANDBOX/state" \
    WORKBENCH_MEMORY_NUDGE_INTERVAL="$interval" \
    bash "$NUDGE" 2>/dev/null
}

assert_contains() {
  local desc="$1" output="$2" needle="$3"
  if printf '%s' "$output" | grep -qF "$needle"; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected to find: $needle"
  fi
}

assert_empty() {
  local desc="$1" output="$2"
  if [ -z "$output" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected no output, got: $output"
  fi
}

# (a) A capture-signal prompt emits the nudge JSON.
echo "signal prompt fires the nudge:"
OUT=$(run "Let's always run the linter before pushing, going forward." sig-a)
assert_contains "decision/feedback signal emits nudge"     "$OUT" "$NUDGE_CANARY"
assert_contains "emits UserPromptSubmit additionalContext" "$OUT" "additionalContext"
OUT=$(run "We discussed this yesterday and it's still broken." sig-b)
assert_contains "recurrence signal emits nudge"            "$OUT" "$NUDGE_CANARY"

# (a2) A scheduled-task fire is skipped outright, before signal or heartbeat.
echo "scheduled-task fire is skipped:"
SCHEDULED_PROMPT='<scheduled-task name="workbench-dev-team-dispatch" file="/Users/x/.claude/scheduled-tasks/workbench-dev-team-dispatch/SKILL.md">
This is an automated run of a scheduled task. The user is not present to answer questions.
We decided the root cause is the loader; the fix is to always validate first.'
# The body deliberately carries strong capture signals ("decided", "root cause",
# "the fix is", "always") — without the guard this prompt fires the nudge, so
# the assertion below is discriminating rather than incidental.
OUT=$(run "$SCHEDULED_PROMPT" sched-a)
assert_empty "scheduled fire emits nothing despite capture signals" "$OUT"
OUT=$(run "

$SCHEDULED_PROMPT" sched-ws)
assert_empty "leading blank lines do not defeat the guard" "$OUT"
# Forcing the heartbeat (interval 1) must not resurrect it either.
OUT=$(run "$SCHEDULED_PROMPT" sched-hb 1)
assert_empty "heartbeat cannot fire for a scheduled prompt" "$OUT"
# Negative control: a human asking about scheduled tasks must still be nudged.
OUT=$(run "We decided the <scheduled-task wrapper is the only usable signal." sched-neg)
assert_contains "human prompt mentioning the wrapper still nudges" "$OUT" "$NUDGE_CANARY"
# No per-session state should be created for a skipped fire.
if [ ! -f "$SANDBOX/state/sched-a.count" ]; then
  PASS=$((PASS + 1)); echo "  ✅ scheduled fire leaves no heartbeat counter behind"
else
  FAIL=$((FAIL + 1)); echo "  ❌ scheduled fire created a heartbeat counter"
fi

# (b) A neutral prompt below the heartbeat threshold emits nothing.
echo "neutral prompt below threshold is silent:"
OUT=$(run "Please rename the variable foo to bar in this file." neutral-1 8)
assert_empty "first neutral turn emits nothing" "$OUT"

# (c) Neutral prompts on the Nth turn fire via heartbeat and reset.
echo "heartbeat fires on the Nth turn and resets:"
# Interval 3: turns 1,2,3 build the counter (silent), turn 4 sees count>=3.
HB=hb-session
OUT=$(run "neutral one" "$HB" 3);   assert_empty    "turn 1 silent" "$OUT"
OUT=$(run "neutral two" "$HB" 3);   assert_empty    "turn 2 silent" "$OUT"
OUT=$(run "neutral three" "$HB" 3); assert_empty    "turn 3 silent" "$OUT"
OUT=$(run "neutral four" "$HB" 3);  assert_contains "turn 4 fires via heartbeat" "$OUT" "$NUDGE_CANARY"
# After firing, the counter reset to 0 — the next few turns are silent again.
OUT=$(run "neutral five" "$HB" 3);  assert_empty    "turn after heartbeat reset is silent" "$OUT"

# A signal nudge also resets the counter (no heartbeat right after a signal).
echo "signal nudge resets the heartbeat counter:"
SR=signal-reset
OUT=$(run "neutral a" "$SR" 3);                 assert_empty    "turn 1 silent" "$OUT"
OUT=$(run "neutral b" "$SR" 3);                 assert_empty    "turn 2 silent" "$OUT"
OUT=$(run "the fix is to bump the timeout" "$SR" 3); assert_contains "signal fires" "$OUT" "$NUDGE_CANARY"
OUT=$(run "neutral c" "$SR" 3);                 assert_empty    "post-signal turn 1 silent (counter reset)" "$OUT"

# (d) Malformed / empty stdin → exit 0, no output, no crash.
echo "bad input degrades silently:"
OUT=$(printf '' | HOME="$SANDBOX/home" WORKBENCH_MEMORY_NUDGE_STATE="$SANDBOX/state" bash "$NUDGE" 2>/dev/null)
RC=$?
assert_empty "empty stdin emits nothing" "$OUT"
[ "$RC" -eq 0 ] && { PASS=$((PASS+1)); echo "  ✅ empty stdin exits 0"; } || { FAIL=$((FAIL+1)); echo "  ❌ empty stdin non-zero"; }

OUT=$(printf 'not json at all' | HOME="$SANDBOX/home" WORKBENCH_MEMORY_NUDGE_STATE="$SANDBOX/state" bash "$NUDGE" 2>/dev/null)
RC=$?
assert_empty "malformed JSON emits nothing" "$OUT"
[ "$RC" -eq 0 ] && { PASS=$((PASS+1)); echo "  ✅ malformed JSON exits 0"; } || { FAIL=$((FAIL+1)); echo "  ❌ malformed JSON non-zero"; }

OUT=$(printf '{"prompt":"decided to ship"}' | HOME="$SANDBOX/home" WORKBENCH_MEMORY_NUDGE_STATE="$SANDBOX/state" bash "$NUDGE" 2>/dev/null)
assert_empty "missing session_id emits nothing" "$OUT"

# (e) WORKBENCH_MEMORY_NUDGE=0 disables — even a signal prompt stays silent.
echo "disable switch overrides everything:"
OUT=$(printf '{"prompt":"decided: the root cause is X","session_id":"dis"}' | \
  HOME="$SANDBOX/home" WORKBENCH_MEMORY_NUDGE_STATE="$SANDBOX/state" \
  WORKBENCH_MEMORY_NUDGE=0 bash "$NUDGE" 2>/dev/null)
assert_empty "disabled hook emits nothing on a signal prompt" "$OUT"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
