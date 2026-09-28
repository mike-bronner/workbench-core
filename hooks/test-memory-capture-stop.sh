#!/bin/bash
# Tests for memory-capture-stop.sh. Run directly: ./test-memory-capture-stop.sh
# Each case feeds a synthetic Stop payload on stdin inside a sandbox state dir
# and asserts whether the capture instruction is emitted, that the
# throttle holds and resets, that the loop/sub-agent/scheduled guards close, and
# that bad input never breaks the session.

set -u
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
STOP="$HOOKS_DIR/memory-capture-stop.sh"
PASS=0
FAIL=0

SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

# A canary unique to the capture instruction — asserting on it proves it fired.
CAPTURE_CANARY="Memory capture checkpoint"
# The header line: the whole of what the user sees when the hook fires.
HEADER="💾 Memory capture checkpoint (automatic, not from the user)."

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
      bash "$STOP" 2>&1
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

# (c) How it fires: hooks.json registers it with asyncRewake, so a fire is exit 2
# with the instruction on stderr. The CLI hands stderr to the model and shows the
# user only the rewakeSummary line. Anything on stdout, or any other exit code,
# wakes nothing.
echo "a fire is exit 2 with the instruction on stderr and nothing on stdout:"
wind_up blk
STDOUT_FILE="$SANDBOX/blk.stdout"
OUT=$(printf '{"session_id":"blk","hook_event_name":"Stop","stop_hook_active":false}' | \
  env HOME="$SANDBOX/home" WORKBENCH_MEMORY_NUDGE_STATE="$SANDBOX/state" \
    WORKBENCH_CAPTURE_STOP_FIRST="$FIRST" WORKBENCH_CAPTURE_STOP_INTERVAL="$REPEAT" \
    bash "$STOP" 2>&1 >"$STDOUT_FILE")
RC=$?
if [ "$RC" -eq 2 ]; then
  PASS=$((PASS + 1)); echo "  ✅ a fire exits 2"
else
  FAIL=$((FAIL + 1)); echo "  ❌ a fire exits 2 — got $RC"
fi
assert_empty "a fire writes nothing to stdout" "$(cat "$STDOUT_FILE")"
assert_contains "names the vault write tool"     "$OUT" "mcp__plugin_workbench-core_memory__write"
# The permission to do nothing is load-bearing: a forced turn with no escape
# manufactures a memory to justify itself.
assert_contains "permits a no-op"                "$OUT" "write nothing"
assert_contains "permits a one-line reply"       "$OUT" "say so in one line"
assert_contains "keeps the standing authorization" "$OUT" "Do not ask first."

# (c2) The instruction stays short: the header plus ONE instruction line. The old
# nine-sentence reason fails both the line count and the size ceiling.
echo "the instruction is the header plus one line:"
REASON="$OUT"
LINES=$(printf '%s\n' "$REASON" | wc -l | tr -d ' ')
if [ "$LINES" = "2" ]; then
  PASS=$((PASS + 1)); echo "  ✅ instruction is exactly 2 lines"
else
  FAIL=$((FAIL + 1)); echo "  ❌ instruction is exactly 2 lines — got $LINES"
fi
if [ "$(printf '%s\n' "$REASON" | head -n 1)" = "$HEADER" ]; then
  PASS=$((PASS + 1)); echo "  ✅ line 1 is the header, verbatim"
else
  FAIL=$((FAIL + 1)); echo "  ❌ line 1 is the header, verbatim — got: $(printf '%s\n' "$REASON" | head -n 1)"
fi
SIZE=$(printf '%s' "$REASON" | wc -c | tr -d ' ')
if [ "$SIZE" -le 400 ]; then
  PASS=$((PASS + 1)); echo "  ✅ instruction is at most 400 bytes ($SIZE)"
else
  FAIL=$((FAIL + 1)); echo "  ❌ instruction is at most 400 bytes — got $SIZE"
fi

# (c3) A silent turn exits 0. Under asyncRewake, exit 2 is the fire, so a silent
# path that exited 2 would wake the model with an empty instruction.
echo "a silent turn exits 0:"
printf '{"session_id":"quiet","hook_event_name":"Stop","stop_hook_active":false}' | \
  env HOME="$SANDBOX/home" WORKBENCH_MEMORY_NUDGE_STATE="$SANDBOX/state" \
    WORKBENCH_CAPTURE_STOP_FIRST="$FIRST" bash "$STOP" >/dev/null 2>&1
RC=$?
if [ "$RC" -eq 0 ]; then
  PASS=$((PASS + 1)); echo "  ✅ turn 1 exits 0"
else
  FAIL=$((FAIL + 1)); echo "  ❌ turn 1 exits 0 — got $RC"
fi

# (c4) The wiring that makes the user see only the header. Without asyncRewake
# the CLI treats exit 2 as an ordinary Stop blocking error and shows the user
# all of stderr. Without rewakeSummary the user sees "Stop hook feedback".
echo "wiring — asyncRewake, with the header as the only user-visible line:"
ENTRY=$(jq -c '.hooks.Stop[].hooks[] | select(.command | test("memory-capture-stop.sh"))' "$HOOKS_DIR/hooks.json")
assert_contains "registered with asyncRewake true" "$(printf '%s' "$ENTRY" | jq -r '.asyncRewake')" "true"
if [ "$(printf '%s' "$ENTRY" | jq -r '.rewakeSummary')" = "$HEADER" ]; then
  PASS=$((PASS + 1)); echo "  ✅ rewakeSummary is the header, verbatim"
else
  FAIL=$((FAIL + 1)); echo "  ❌ rewakeSummary is the header, verbatim — got: $(printf '%s' "$ENTRY" | jq -r '.rewakeSummary')"
fi
# The default rewake prefix names the hook command, which carries the plugin
# path. A custom prefix keeps the path out of the model's context.
assert_contains "rewakeMessage is set" "$(printf '%s' "$ENTRY" | jq -r '.rewakeMessage // empty')" "Memory capture checkpoint"

# The reason points at the warmup rule by name instead of restating it, so that
# rule has to exist under that name. Renaming the warmup block would leave the
# pointer dangling with every other test still green.
echo "the rule the reason points at exists in the warmup:"
assert_contains "reason names the Memory routing capture rule" "$REASON" "Memory routing capture rule"
WARMUP="$HOOKS_DIR/session-warmup.sh"
assert_contains "warmup carries the Memory routing heading" "$(grep -F "printf '## Memory routing" "$WARMUP")" "## Memory routing"
assert_contains "warmup carries the CAPTURE rule" "$(grep -F 'Proactively CAPTURE durable knowledge' "$WARMUP")" "Do NOT ask first"

# (d) Loop guard: never fire in a continuation that our own wake created.
echo "loop guard — a stop_hook_active turn never fires again:"
wind_up loop
OUT=$(run loop true)
assert_empty "stop_hook_active=true emits nothing when otherwise due" "$OUT"
# Fail closed: a missing/garbled flag is treated as active, not as false.
wind_up loopx
OUT=$(printf '{"session_id":"loopx","hook_event_name":"Stop","stop_hook_active":"yes"}' | \
  env HOME="$SANDBOX/home" WORKBENCH_MEMORY_NUDGE_STATE="$SANDBOX/state" \
    WORKBENCH_CAPTURE_STOP_FIRST="$FIRST" bash "$STOP" 2>&1)
assert_empty "non-boolean stop_hook_active fails closed" "$OUT"
# Negative control: the same wound-up session fires once the flag is false, so
# the two assertions above are the guard and not a dead counter.
OUT=$(run loop)
assert_contains "same session fires when not already continuing" "$OUT" "$CAPTURE_CANARY"

# (d2) The turn our own wake causes never fires, even if the CLI does not mark
# it stop_hook_active. At the shortest interval (1) the counter alone would
# fire on it, so this is the case that proves the second guard.
echo "loop guard — the turn a fire caused never fires, at any interval:"
run_i1() {
  printf '{"session_id":"wake","hook_event_name":"Stop","stop_hook_active":false}' | \
    env HOME="$SANDBOX/home" WORKBENCH_MEMORY_NUDGE_STATE="$SANDBOX/state" \
      WORKBENCH_CAPTURE_STOP_FIRST=1 WORKBENCH_CAPTURE_STOP_INTERVAL=1 \
      bash "$STOP" 2>&1
}
OUT=$(run_i1); assert_contains "turn 1 fires (FIRST=1)" "$OUT" "$CAPTURE_CANARY"
OUT=$(run_i1); assert_empty "the wake turn after it is silent (INTERVAL=1, flag false)" "$OUT"
OUT=$(run_i1); assert_contains "the turn after the wake fires again (INTERVAL=1)" "$OUT" "$CAPTURE_CANARY"
OUT=$(run_i1); assert_empty "the next wake turn is silent too" "$OUT"

# (e) Sub-agent guard: findings belong to the session that dispatched it.
echo "sub-agent guard — a sub-agent turn end never fires:"
wind_up sub
OUT=$(run sub false agent-7)
assert_empty "agent_id present emits nothing when otherwise due" "$OUT"
OUT=$(run sub)
assert_contains "same session fires on the main thread" "$OUT" "$CAPTURE_CANARY"

# (f) Scheduled-task guard: the verdict is read from the transcript's first user
#     record, because a Stop payload carries no prompt.
echo "scheduled-task guard — a scheduled tick never fires:"
SCHEDULED_PROMPT='<scheduled-task name="workbench-dev-team-dispatch" file="/x/SKILL.md">
This is an automated run of a scheduled task.'
mk_transcript() {  # <file> <first-user-content-json>
  { printf '{"type":"system","content":"hook output"}\n'
    printf '{"type":"user","message":{"role":"user","content":%s}}\n' "$2"
    printf '{"type":"user","message":{"role":"user","content":"a later human line"}}\n'
  } > "$1"
}
mk_transcript "$SANDBOX/sched-string.jsonl" "$(printf '%s' "$SCHEDULED_PROMPT" | jq -Rs .)"
mk_transcript "$SANDBOX/sched-array.jsonl" \
  "$(printf '%s' "$SCHEDULED_PROMPT" | jq -cRs '[{type:"text",text:.}]')"
mk_transcript "$SANDBOX/human.jsonl" '"please fix the scope guard"'
run_t() {  # <session_id> <transcript_path>
  printf '{"session_id":"%s","hook_event_name":"Stop","stop_hook_active":false,"transcript_path":"%s"}' "$1" "$2" | \
    env HOME="$SANDBOX/home" WORKBENCH_MEMORY_NUDGE_STATE="$SANDBOX/state" \
      WORKBENCH_CAPTURE_STOP_FIRST="$FIRST" WORKBENCH_CAPTURE_STOP_INTERVAL="$REPEAT" \
      bash "$STOP" 2>&1
}
wind_up sched-str
OUT=$(run_t sched-str "$SANDBOX/sched-string.jsonl")
assert_empty "scheduled prompt as a string emits nothing when otherwise due" "$OUT"
wind_up sched-arr
OUT=$(run_t sched-arr "$SANDBOX/sched-array.jsonl")
assert_empty "scheduled prompt as a text block emits nothing when otherwise due" "$OUT"
# The verdict is recorded, so a scheduled session reads its transcript once and
# never again. Without the record every turn from the threshold on re-read it.
# A grep shim logs every read of this transcript.
mkdir -p "$SANDBOX/grep-shim"
printf '#!/bin/bash\nfor a in "$@"; do [ "$a" = "%s" ] && echo read >> "%s"; done\nexec "%s" "$@"\n' \
  "$SANDBOX/sched-once.jsonl" "$SANDBOX/grep-shim/reads" "$(command -v grep)" > "$SANDBOX/grep-shim/grep"
chmod +x "$SANDBOX/grep-shim/grep"
cp "$SANDBOX/sched-string.jsonl" "$SANDBOX/sched-once.jsonl"
: > "$SANDBOX/grep-shim/reads"
wind_up sched-once
ONCE_OUT=""
for _ in 1 2 3 4 5 6 7 8; do
  ONCE_OUT="$ONCE_OUT$(PATH="$SANDBOX/grep-shim:$PATH" run_t sched-once "$SANDBOX/sched-once.jsonl")"
done
assert_empty "a scheduled session stays silent for 8 turns past the threshold" "$ONCE_OUT"
READS=$(grep -c . "$SANDBOX/grep-shim/reads" 2>/dev/null)
if [ "$READS" = "1" ]; then
  PASS=$((PASS + 1)); echo "  ✅ the transcript was read once across those 8 turns"
else
  FAIL=$((FAIL + 1)); echo "  ❌ the transcript was read $READS times across 8 turns, expected 1"
fi
# Negative controls: a human transcript, and one that cannot be read, both fire.
wind_up sched-neg
OUT=$(run_t sched-neg "$SANDBOX/human.jsonl")
assert_contains "human transcript at the same point fires" "$OUT" "$CAPTURE_CANARY"
wind_up sched-missing
OUT=$(run_t sched-missing "$SANDBOX/does-not-exist.jsonl")
assert_contains "unreadable transcript fails open and fires" "$OUT" "$CAPTURE_CANARY"

# (g) The summary-writer child is never told to capture findings of its own.
echo "summary-writer guard — the background child never fires:"
wind_up writer
OUT=$(run writer false "" WORKBENCH_SUMMARY_WRITER=1)
assert_empty "WORKBENCH_SUMMARY_WRITER=1 emits nothing when otherwise due" "$OUT"
OUT=$(run writer)
assert_contains "same session fires without the flag" "$OUT" "$CAPTURE_CANARY"

# (g2) Nor is an unattended dev-team agent: in `claude -p` the capture reply
# would become the run's final output, which is what the dispatcher logs.
echo "dev-team pipeline guard — an unattended agent never fires:"
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
      WORKBENCH_CAPTURE_STOP_FIRST=1 bash "$STOP" 2>&1)
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
    WORKBENCH_CAPTURE_STOP_FIRST=1 bash "$STOP" 2>&1)
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
    env HOME="$SANDBOX/home" WORKBENCH_MEMORY_NUDGE_STATE="$SANDBOX/state" bash "$STOP" 2>&1)
  assert_empty "unconfigured turn $i silent" "$OUT"
  i=$((i + 1))
done
OUT=$(printf '{"session_id":"%s","hook_event_name":"Stop","stop_hook_active":false}' "$DEFAULTS_SID" | \
  env HOME="$SANDBOX/home" WORKBENCH_MEMORY_NUDGE_STATE="$SANDBOX/state" bash "$STOP" 2>&1)
assert_contains "unconfigured turn 5 fires" "$OUT" "$CAPTURE_CANARY"
# ...and the repeat that follows is the sparse one, not another turn-5 gap.
i=1
while [ "$i" -lt 40 ]; do
  OUT=$(printf '{"session_id":"%s","hook_event_name":"Stop","stop_hook_active":false}' "$DEFAULTS_SID" | \
    env HOME="$SANDBOX/home" WORKBENCH_MEMORY_NUDGE_STATE="$SANDBOX/state" bash "$STOP" 2>&1)
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
        WORKBENCH_CAPTURE_STOP_FIRST="$bad" bash "$STOP" 2>&1)
    j=$((j + 1))
  done
  OUT=$(printf '{"session_id":"garbage","hook_event_name":"Stop","stop_hook_active":false}' | \
    env HOME="$SANDBOX/home" WORKBENCH_MEMORY_NUDGE_STATE="$SANDBOX/state" \
      WORKBENCH_CAPTURE_STOP_FIRST="$bad" bash "$STOP" 2>&1)
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
