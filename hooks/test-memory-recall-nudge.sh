#!/bin/bash
# Tests for memory-recall-nudge.sh. Run directly: ./test-memory-recall-nudge.sh
# Each case feeds a synthetic UserPromptSubmit payload on stdin inside a sandbox
# state dir and asserts whether the nudge JSON is emitted, that the heartbeat
# floor fires on the Nth turn and resets, that no signal verdict can suppress
# that floor, and that bad input never breaks the hook.

set -u
NUDGE="$(cd "$(dirname "$0")" && pwd)/memory-recall-nudge.sh"
PASS=0
FAIL=0

SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

# A canary unique to the nudge payload — asserting on it proves the line fired.
NUDGE_CANARY="Recall check"

# run: pipe a payload into the hook with a fresh-or-shared sandbox state dir.
# Args: <prompt> <session_id> [interval] [extra env assignments...]
run() {
  local prompt="$1" sid="$2" interval="${3:-8}"
  shift 2                          # drop prompt + session id
  [ "$#" -gt 0 ] && shift           # drop the interval when one was passed
  printf '{"prompt":%s,"session_id":"%s"}' \
    "$(printf '%s' "$prompt" | jq -Rs .)" "$sid" | \
    env HOME="$SANDBOX/home" \
    WORKBENCH_MEMORY_RECALL_NUDGE_STATE="$SANDBOX/state" \
    WORKBENCH_MEMORY_RECALL_NUDGE_INTERVAL="$interval" \
    "$@" \
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

# (a) A recall-signal prompt emits the nudge JSON — one case per signal class.
echo "signal prompt fires the nudge:"
OUT=$(run "What is our convention for the title of a GitHub release?" sig-a)
assert_contains "convention signal emits nudge"            "$OUT" "$NUDGE_CANARY"
assert_contains "emits UserPromptSubmit additionalContext" "$OUT" "additionalContext"
OUT=$(run "How did we set up the vault on the other machine?" sig-b)
assert_contains "prior-art signal emits nudge"             "$OUT" "$NUDGE_CANARY"
OUT=$(run "Go ahead and push, then cut a release for this." sig-c)
assert_contains "recorded-procedure signal emits nudge"    "$OUT" "$NUDGE_CANARY"

# (a2) The payload carries BOTH halves of the rule. The query-forming half is
# the whole reason this hook exists — a nudge that only says "search the vault"
# restates what the agent already reads at SessionStart and adds nothing.
echo "nudge payload carries the query-forming rule:"
assert_contains "names the vault search tool"   "$OUT" "mcp__plugin_workbench-core_memory__search"
assert_contains "orders search before the scan" "$OUT" "before you scan the repo"
assert_contains "says what to query"            "$OUT" "Build the query from the TASK"
assert_contains "rules out the prompt's wording" "$OUT" "not from the wording of this prompt"

# (a3) A scheduled-task fire is skipped outright, before signal or heartbeat.
echo "scheduled-task fire is skipped:"
SCHEDULED_PROMPT='<scheduled-task name="workbench-dev-team-dispatch" file="/Users/x/.claude/scheduled-tasks/workbench-dev-team-dispatch/SKILL.md">
This is an automated run of a scheduled task. The user is not present to answer questions.
Follow the standard convention and publish a release when the board is clear.'
# The body deliberately carries strong recall signals ("convention", "standard",
# "publish", "release") — without the guard this prompt fires the nudge, so the
# assertion below is discriminating rather than incidental.
OUT=$(run "$SCHEDULED_PROMPT" sched-a)
assert_empty "scheduled fire emits nothing despite recall signals" "$OUT"
OUT=$(run "

$SCHEDULED_PROMPT" sched-ws)
assert_empty "leading blank lines do not defeat the guard" "$OUT"
# Forcing the heartbeat (interval 1) must not resurrect it either.
OUT=$(run "$SCHEDULED_PROMPT" sched-hb 1)
assert_empty "heartbeat cannot fire for a scheduled prompt" "$OUT"
# Negative control: a human asking about scheduled tasks must still be nudged.
OUT=$(run "Why does the <scheduled-task wrapper break the release prompt cache?" sched-neg)
assert_contains "human prompt mentioning the wrapper still nudges" "$OUT" "$NUDGE_CANARY"
# No per-session state should be created for a skipped fire.
if [ ! -f "$SANDBOX/state/sched-a.count" ]; then
  PASS=$((PASS + 1)); echo "  ✅ scheduled fire leaves no heartbeat counter behind"
else
  FAIL=$((FAIL + 1)); echo "  ❌ scheduled fire created a heartbeat counter"
fi

# (b) A neutral prompt below the heartbeat threshold emits nothing — the cost
# lever. Without this, every turn pays for a line it did not need.
echo "neutral prompt below threshold is silent:"
OUT=$(run "Shorten this paragraph by two sentences." neutral-1 8)
assert_empty "first neutral turn emits nothing" "$OUT"

# (c) THE FLOOR. Prompts carrying no recall signal at all still get the reminder
# on the Nth turn. This is what makes signal detection add-only: a missed signal
# costs a delay, never a lost nudge, so no classifier verdict can ever suppress
# the rule the way a gating conditional would.
echo "heartbeat floor fires on the Nth turn and resets:"
# Interval 3: turns 1,2,3 build the counter (silent), turn 4 sees count>=3.
HB=hb-session
OUT=$(run "neutral one" "$HB" 3);   assert_empty    "turn 1 silent" "$OUT"
OUT=$(run "neutral two" "$HB" 3);   assert_empty    "turn 2 silent" "$OUT"
OUT=$(run "neutral three" "$HB" 3); assert_empty    "turn 3 silent" "$OUT"
OUT=$(run "neutral four" "$HB" 3);  assert_contains "turn 4 fires with no signal present" "$OUT" "$NUDGE_CANARY"
# After firing, the counter reset to 0 — the next few turns are silent again.
OUT=$(run "neutral five" "$HB" 3);  assert_empty    "turn after heartbeat reset is silent" "$OUT"

# (d) A signal nudge also resets the counter (no heartbeat right after a signal).
echo "signal nudge resets the heartbeat counter:"
SR=signal-reset
OUT=$(run "neutral a" "$SR" 3);                          assert_empty    "turn 1 silent" "$OUT"
OUT=$(run "neutral b" "$SR" 3);                          assert_empty    "turn 2 silent" "$OUT"
OUT=$(run "Which approach did we land on here?" "$SR" 3); assert_contains "signal fires" "$OUT" "$NUDGE_CANARY"
OUT=$(run "neutral c" "$SR" 3);                          assert_empty    "post-signal turn 1 silent (counter reset)" "$OUT"

# (e) The two nudges are independent. A shared counter would let a capture nudge
# silently reset the recall heartbeat, and a shared knob would disable both at
# once — either one turns a floor into something another hook controls.
echo "recall and capture nudges hold separate state and knobs:"
OUT=$(run "neutral x" indep-1 3 WORKBENCH_MEMORY_NUDGE_INTERVAL=1)
assert_empty "capture's interval knob does not drive this heartbeat" "$OUT"
OUT=$(run "neutral y" indep-2 3 WORKBENCH_MEMORY_NUDGE=0)
assert_empty "capture's disable switch leaves this hook alone (still counting)" "$OUT"
OUT=$(run "What is the naming convention here?" indep-2 3 WORKBENCH_MEMORY_NUDGE=0)
assert_contains "and a signal still fires with capture disabled" "$OUT" "$NUDGE_CANARY"
if [ -f "$SANDBOX/state/indep-1.count" ]; then
  PASS=$((PASS + 1)); echo "  ✅ counter lands in this hook's own state dir"
else
  FAIL=$((FAIL + 1)); echo "  ❌ counter missing from this hook's own state dir"
fi

# (f) Disabling AUTOMATIC recall must not disable the reminder. With
# memory-recall.sh off, an agent-initiated search is the only recall left, so
# the reminder matters more — the two switches are deliberately separate.
echo "WORKBENCH_MEMORY_RECALL=0 does not silence the nudge:"
OUT=$(run "What is the standard release procedure?" recall-off 8 WORKBENCH_MEMORY_RECALL=0)
assert_contains "auto-recall off, reminder still fires" "$OUT" "$NUDGE_CANARY"

# (g) Malformed / empty stdin → exit 0, no output, no crash.
echo "bad input degrades silently:"
OUT=$(printf '' | HOME="$SANDBOX/home" WORKBENCH_MEMORY_RECALL_NUDGE_STATE="$SANDBOX/state" bash "$NUDGE" 2>/dev/null)
RC=$?
assert_empty "empty stdin emits nothing" "$OUT"
[ "$RC" -eq 0 ] && { PASS=$((PASS+1)); echo "  ✅ empty stdin exits 0"; } || { FAIL=$((FAIL+1)); echo "  ❌ empty stdin non-zero"; }

OUT=$(printf 'not json at all' | HOME="$SANDBOX/home" WORKBENCH_MEMORY_RECALL_NUDGE_STATE="$SANDBOX/state" bash "$NUDGE" 2>/dev/null)
RC=$?
assert_empty "malformed JSON emits nothing" "$OUT"
[ "$RC" -eq 0 ] && { PASS=$((PASS+1)); echo "  ✅ malformed JSON exits 0"; } || { FAIL=$((FAIL+1)); echo "  ❌ malformed JSON non-zero"; }

OUT=$(printf '{"prompt":"what is our release convention"}' | HOME="$SANDBOX/home" WORKBENCH_MEMORY_RECALL_NUDGE_STATE="$SANDBOX/state" bash "$NUDGE" 2>/dev/null)
assert_empty "missing session_id emits nothing" "$OUT"

# (h) WORKBENCH_MEMORY_RECALL_NUDGE=0 disables — even a signal prompt stays silent.
echo "disable switch overrides everything:"
OUT=$(printf '{"prompt":"what is our release naming convention","session_id":"dis"}' | \
  HOME="$SANDBOX/home" WORKBENCH_MEMORY_RECALL_NUDGE_STATE="$SANDBOX/state" \
  WORKBENCH_MEMORY_RECALL_NUDGE=0 bash "$NUDGE" 2>/dev/null)
assert_empty "disabled hook emits nothing on a signal prompt" "$OUT"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
