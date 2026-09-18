#!/bin/bash
# Tests for memory-capture-stop.sh. Run directly: ./test-memory-capture-stop.sh
# Each case feeds a synthetic Stop payload on stdin inside a sandbox state dir
# and asserts whether the blocking capture instruction is emitted, that the
# throttle holds and resets, that the loop/sub-agent/scheduled guards close, and
# that bad input never breaks the session.

set -u
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
STOP="$HOOKS_DIR/memory-capture-stop.sh"
NUDGE="$HOOKS_DIR/memory-capture-nudge.sh"
PASS=0
FAIL=0

SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

# A canary unique to the capture instruction — asserting on it proves it fired.
CAPTURE_CANARY="Memory capture checkpoint"

# The throttle has TWO thresholds: the turn end of the first fire, and the gap
# between later ones. Tests drive both with small values; production defaults
# (5 and 40) are asserted separately at the end.
FIRST=3
REPEAT=5

# run: pipe a Stop payload into the hook against the shared sandbox state dir.
# Args: <session_id> [stop_hook_active] [agent_id] [extra env...]
run() {
  local sid="$1" active="${2:-false}" agent="${3:-}"
  shift 3 2>/dev/null || shift $#
  printf '{"session_id":"%s","hook_event_name":"Stop","stop_hook_active":%s%s}' \
    "$sid" "$active" \
    "$([ -n "$agent" ] && printf ',"agent_id":"%s"' "$agent")" | \
    env HOME="$SANDBOX/home" \
      WORKBENCH_MEMORY_NUDGE_STATE="$SANDBOX/state" \
      WORKBENCH_CAPTURE_STOP_FIRST="$FIRST" \
      WORKBENCH_CAPTURE_STOP_INTERVAL="$REPEAT" \
      "$@" \
      bash "$STOP" 2>/dev/null
}

# Drive turn ends until the NEXT one is due to fire. Guard cases use this to
# reach the brink, so a silent result proves the guard and not a cold counter.
# A guarded turn exits before the counter is touched, so it never consumes one.
wind_up() {
  local sid="$1" n="${2:-$FIRST}" i=1
  while [ "$i" -lt "$n" ]; do
    run "$sid" >/dev/null
    i=$((i + 1))
  done
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

# (a) The first fire lands ON the FIRST-th turn end, not the one after it. This
# is the assertion the whole retune turns on: a backstop that fires late never
# fires at all, because 84% of this project's sessions end before turn 21.
echo "first fire — lands on the FIRST-th turn end:"
OUT=$(run early); assert_empty    "turn 1 silent" "$OUT"
OUT=$(run early); assert_empty    "turn 2 silent" "$OUT"
OUT=$(run early); assert_contains "turn 3 fires (FIRST=3)" "$OUT" "$CAPTURE_CANARY"

# (b) After that first fire the session settles onto the SPARSE repeat, which is
# a different and longer threshold. Firing again at FIRST would make the early
# first fire a per-N-turns reminder, which is what this retune replaced.
echo "repeat — the later interval is sparse, not the first one again:"
OUT=$(run early); assert_empty "turn 4 silent" "$OUT"
OUT=$(run early); assert_empty "turn 5 silent" "$OUT"
OUT=$(run early); assert_empty "turn 6 silent (would have fired at FIRST=3)" "$OUT"
OUT=$(run early); assert_empty "turn 7 silent" "$OUT"
OUT=$(run early); assert_contains "turn 8 fires (REPEAT=5 after the first)" "$OUT" "$CAPTURE_CANARY"
OUT=$(run early); assert_empty "turn after the repeat is silent (counter reset)" "$OUT"

# A fresh session starts over at FIRST — the "already fired" state is per-session.
echo "first fire — a new session gets its own early fire:"
OUT=$(run fresh); assert_empty    "turn 1 silent" "$OUT"
OUT=$(run fresh); assert_empty    "turn 2 silent" "$OUT"
OUT=$(run fresh); assert_contains "turn 3 fires" "$OUT" "$CAPTURE_CANARY"

# (c) What it emits is a Stop BLOCK — the only channel that reaches a live model.
echo "the fired payload is a Stop block carrying the instruction:"
wind_up blk
OUT=$(run blk)
assert_contains "decision is block"              "$OUT" '"decision":"block"'
assert_contains "instruction is the block reason" "$OUT" '"reason"'
assert_contains "names the vault write tool"     "$OUT" "mcp__plugin_workbench-core_memory__write"
# The permission to do nothing is load-bearing: a forced turn with no escape
# manufactures a memory to justify itself.
assert_contains "permits a no-op"                "$OUT" "write nothing"

# (d) Loop guard: never block a continuation that our own block created.
echo "loop guard — a stop_hook_active turn never blocks again:"
wind_up loop
OUT=$(run loop true)
assert_empty "stop_hook_active=true emits nothing when otherwise due" "$OUT"
# Fail closed: a missing/garbled flag is treated as active, not as false.
wind_up loopx
OUT=$(printf '{"session_id":"loopx","hook_event_name":"Stop","stop_hook_active":"yes"}' | \
  env HOME="$SANDBOX/home" WORKBENCH_MEMORY_NUDGE_STATE="$SANDBOX/state" \
    WORKBENCH_CAPTURE_STOP_FIRST="$FIRST" bash "$STOP" 2>/dev/null)
assert_empty "non-boolean stop_hook_active fails closed" "$OUT"
# Negative control: the same wound-up session fires once the flag is false, so
# the two assertions above are the guard and not a dead counter.
OUT=$(run loop)
assert_contains "same session fires when not already continuing" "$OUT" "$CAPTURE_CANARY"

# (e) Sub-agent guard: findings belong to the session that dispatched it.
echo "sub-agent guard — a sub-agent turn end never blocks:"
wind_up sub
OUT=$(run sub false agent-7)
assert_empty "agent_id present emits nothing when otherwise due" "$OUT"
OUT=$(run sub)
assert_contains "same session fires on the main thread" "$OUT" "$CAPTURE_CANARY"

# (f) Scheduled-task guard: the nudge records the verdict, this hook reads it.
echo "scheduled-task guard — a tick marked by the nudge never blocks:"
SCHEDULED_PROMPT='<scheduled-task name="workbench-dev-team-dispatch" file="/x/SKILL.md">
This is an automated run of a scheduled task.'
printf '{"prompt":%s,"session_id":"sched-stop"}' \
  "$(printf '%s' "$SCHEDULED_PROMPT" | jq -Rs .)" | \
  env HOME="$SANDBOX/home" WORKBENCH_MEMORY_NUDGE_STATE="$SANDBOX/state" \
    bash "$NUDGE" >/dev/null 2>&1
if [ -f "$SANDBOX/state/sched-stop.scheduled" ]; then
  PASS=$((PASS + 1)); echo "  ✅ the nudge recorded the scheduled verdict for Stop"
else
  FAIL=$((FAIL + 1)); echo "  ❌ the nudge left no scheduled marker"
fi
wind_up sched-stop
OUT=$(run sched-stop)
assert_empty "marked scheduled session emits nothing when otherwise due" "$OUT"
# Negative control: an unmarked session at the same counter does fire.
wind_up sched-neg
OUT=$(run sched-neg)
assert_contains "unmarked session at the same point fires" "$OUT" "$CAPTURE_CANARY"

# (g) The summary-writer child is never told to capture findings of its own.
echo "summary-writer guard — the background child never blocks:"
wind_up writer
OUT=$(run writer false "" WORKBENCH_SUMMARY_WRITER=1)
assert_empty "WORKBENCH_SUMMARY_WRITER=1 emits nothing when otherwise due" "$OUT"
OUT=$(run writer)
assert_contains "same session fires without the flag" "$OUT" "$CAPTURE_CANARY"

# (g2) Nor is an unattended dev-team agent: in `claude -p` the capture reply
# would become the run's final output, which is what the dispatcher logs.
echo "dev-team pipeline guard — an unattended agent never blocks:"
wind_up pipeline
OUT=$(run pipeline false "" WORKBENCH_DEV_TEAM_PIPELINE=1)
assert_empty "WORKBENCH_DEV_TEAM_PIPELINE=1 emits nothing when otherwise due" "$OUT"
OUT=$(run pipeline)
assert_contains "same session fires without the flag" "$OUT" "$CAPTURE_CANARY"

# (h) Disable switches — both the hook's own and the family kill switch.
echo "disable switches override a due turn:"
wind_up off1
OUT=$(run off1 false "" WORKBENCH_CAPTURE_STOP=0)
assert_empty "WORKBENCH_CAPTURE_STOP=0 emits nothing" "$OUT"
wind_up off2
OUT=$(run off2 false "" WORKBENCH_MEMORY_NUDGE=0)
assert_empty "WORKBENCH_MEMORY_NUDGE=0 emits nothing" "$OUT"

# (i) Bad input → exit 0, no output, no crash. A hook that fails hard here ends
# every turn with an error for the only user of this plugin.
echo "bad input degrades silently:"
for bad in '' 'not json at all' '{"hook_event_name":"Stop"}'; do
  OUT=$(printf '%s' "$bad" | \
    env HOME="$SANDBOX/home" WORKBENCH_MEMORY_NUDGE_STATE="$SANDBOX/state" \
      WORKBENCH_CAPTURE_STOP_FIRST=1 bash "$STOP" 2>/dev/null)
  RC=$?
  assert_empty "payload [${bad:-<empty>}] emits nothing" "$OUT"
  if [ "$RC" -eq 0 ]; then
    PASS=$((PASS + 1)); echo "  ✅ payload [${bad:-<empty>}] exits 0"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ payload [${bad:-<empty>}] exited $RC"
  fi
done

# A missing jq is a supported environment, not an error path.
echo "missing jq degrades silently:"
NOJQ_BIN="$SANDBOX/nojq-bin"
mkdir -p "$NOJQ_BIN"
for tool in bash cat find tr mkdir; do
  src="$(command -v "$tool" 2>/dev/null)" && ln -sf "$src" "$NOJQ_BIN/$tool"
done
OUT=$(printf '{"session_id":"nojq","stop_hook_active":false}' | \
  env HOME="$SANDBOX/home" PATH="$NOJQ_BIN" \
    WORKBENCH_MEMORY_NUDGE_STATE="$SANDBOX/state" \
    WORKBENCH_CAPTURE_STOP_FIRST=1 bash "$STOP" 2>/dev/null)
RC=$?
assert_empty "no jq on PATH emits nothing" "$OUT"
if [ "$RC" -eq 0 ]; then
  PASS=$((PASS + 1)); echo "  ✅ no jq on PATH exits 0"
else
  FAIL=$((FAIL + 1)); echo "  ❌ no jq on PATH exited $RC"
fi

# (i2) The shipped defaults. Every case above overrides both thresholds, so
# without this the hook could ship any pair of numbers and stay green. The first
# fire is the one that decides whether the backstop works at all: measured over
# 467 transcripts of this project, turn 5 reaches 88% of sessions and turn 21
# reaches 16%.
echo "shipped defaults — early first fire, sparse repeat:"
DEFAULTS_SID=defaults
i=1
while [ "$i" -lt 5 ]; do
  OUT=$(printf '{"session_id":"%s","hook_event_name":"Stop","stop_hook_active":false}' "$DEFAULTS_SID" | \
    env HOME="$SANDBOX/home" WORKBENCH_MEMORY_NUDGE_STATE="$SANDBOX/state" bash "$STOP" 2>/dev/null)
  assert_empty "unconfigured turn $i silent" "$OUT"
  i=$((i + 1))
done
OUT=$(printf '{"session_id":"%s","hook_event_name":"Stop","stop_hook_active":false}' "$DEFAULTS_SID" | \
  env HOME="$SANDBOX/home" WORKBENCH_MEMORY_NUDGE_STATE="$SANDBOX/state" bash "$STOP" 2>/dev/null)
assert_contains "unconfigured turn 5 fires" "$OUT" "$CAPTURE_CANARY"
# ...and the repeat that follows is the sparse one, not another turn-5 gap.
i=1
while [ "$i" -lt 40 ]; do
  OUT=$(printf '{"session_id":"%s","hook_event_name":"Stop","stop_hook_active":false}' "$DEFAULTS_SID" | \
    env HOME="$SANDBOX/home" WORKBENCH_MEMORY_NUDGE_STATE="$SANDBOX/state" bash "$STOP" 2>/dev/null)
  if [ -n "$OUT" ]; then break; fi
  i=$((i + 1))
done
if [ "$i" -eq 40 ]; then
  PASS=$((PASS + 1)); echo "  ✅ unconfigured repeat is 40 turn ends"
else
  FAIL=$((FAIL + 1)); echo "  ❌ unconfigured repeat fired after $i turn ends, expected 40"
fi
# Garbage in either knob falls back to its own default rather than disabling
# the hook or firing every turn.
for bad in 0 "" abc -3; do
  rm -f "$SANDBOX/state/garbage.stopcount" "$SANDBOX/state/garbage.stopfired"
  j=1
  while [ "$j" -lt 5 ]; do
    OUT=$(printf '{"session_id":"garbage","hook_event_name":"Stop","stop_hook_active":false}' | \
      env HOME="$SANDBOX/home" WORKBENCH_MEMORY_NUDGE_STATE="$SANDBOX/state" \
        WORKBENCH_CAPTURE_STOP_FIRST="$bad" bash "$STOP" 2>/dev/null)
    j=$((j + 1))
  done
  OUT=$(printf '{"session_id":"garbage","hook_event_name":"Stop","stop_hook_active":false}' | \
    env HOME="$SANDBOX/home" WORKBENCH_MEMORY_NUDGE_STATE="$SANDBOX/state" \
      WORKBENCH_CAPTURE_STOP_FIRST="$bad" bash "$STOP" 2>/dev/null)
  assert_contains "FIRST=[${bad:-<empty>}] falls back to 5" "$OUT" "$CAPTURE_CANARY"
done

# (j) The hook is wired to the Stop event, and to no other.
echo "wiring:"
HOOKS_JSON="$HOOKS_DIR/hooks.json"
if jq -e '.hooks.Stop[].hooks[].command | select(test("memory-capture-stop.sh"))' \
    "$HOOKS_JSON" >/dev/null 2>&1; then
  PASS=$((PASS + 1)); echo "  ✅ registered on the Stop event"
else
  FAIL=$((FAIL + 1)); echo "  ❌ not registered on the Stop event"
fi
# PreCompact cannot carry it: that executor reads a hook's stdout and its
# blocked state only, and no model turn is open there to run a tool in.
if jq -e '[.hooks | to_entries[] | select(.key != "Stop") | .value[].hooks[].command]
          | map(select(test("memory-capture-stop.sh"))) | length == 0' \
    "$HOOKS_JSON" >/dev/null 2>&1; then
  PASS=$((PASS + 1)); echo "  ✅ registered on no other event"
else
  FAIL=$((FAIL + 1)); echo "  ❌ registered on an event that cannot reach a live model"
fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
