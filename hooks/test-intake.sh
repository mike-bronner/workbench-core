#!/bin/bash
# Tests for the intake routine: the one source of it (skills/intake/SKILL.md)
# and hooks/intake-nudge.sh, the PreToolUse reminder on Edit.
# Run directly: ./test-intake.sh
#
# The nudge cases each build a synthetic transcript, in the record shapes
# Claude Code writes, and feed one PreToolUse payload on stdin. Each asserts one
# of two verdicts: nudge (additionalContext, and NO permissionDecision) or
# silent (no output). There is no third verdict. The hook never denies, and a
# block further down asserts that across every output this suite produced.

set -u
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HOOKS_DIR/.." && pwd)"
HOOK="$HOOKS_DIR/intake-nudge.sh"
SKILL="$ROOT/skills/intake/SKILL.md"
STYLE="$ROOT/assets/personas/clear/output-style.md"
HOOKS_JSON="$HOOKS_DIR/hooks.json"
README="$ROOT/README.md"
PASS=0
FAIL=0

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/intake-nudge.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT
FAKE_HOME="$SANDBOX/home"
mkdir -p "$FAKE_HOME"
ALL_OUTPUT="$SANDBOX/all-output"
: > "$ALL_OUTPUT"

ok() { PASS=$((PASS + 1)); echo "  ✅ $1"; }
no() { FAIL=$((FAIL + 1)); echo "  ❌ $1: $2"; }

assert_grep() { # desc, fixed string, file
  if grep -qF -- "$2" "$3" 2>/dev/null; then ok "$1"; else no "$1" "missing: $2"; fi
}
assert_no_grep() { # desc, fixed string, file
  if grep -qF -- "$2" "$3" 2>/dev/null; then no "$1" "found: $2"; else ok "$1"; fi
}

# ── Transcript records ────────────────────────────────────────────────────────
# Each helper prints one JSONL record. A human prompt carries the origin stamp
# the hook keys on. Every other record is written without it, as Claude Code
# writes them.
human() { # uuid, text
  jq -nc --arg u "$1" --arg t "$2" \
    '{type:"user", origin:{kind:"human"}, uuid:$u, message:{role:"user", content:$t}}'
}
other_origin() { # uuid, kind, text
  jq -nc --arg u "$1" --arg k "$2" --arg t "$3" \
    '{type:"user", origin:{kind:$k}, uuid:$u, message:{role:"user", content:$t}}'
}
say() { # uuid, text
  jq -nc --arg u "$1" --arg t "$2" \
    '{type:"assistant", uuid:$u, message:{role:"assistant", content:[{type:"text", text:$t}]}}'
}
edit_call() { # uuid, new_string
  jq -nc --arg u "$1" --arg n "$2" \
    '{type:"assistant", uuid:$u, message:{role:"assistant", content:[{type:"tool_use", id:("t-" + $u), name:"Edit", input:{file_path:"/x/a.md", old_string:"a", new_string:$n}}]}}'
}
result() { # uuid
  jq -nc --arg u "$1" \
    '{type:"user", uuid:$u, message:{role:"user", content:[{type:"tool_result", tool_use_id:"t-x", content:"ok"}]}}'
}

INTAKE_BLOCK='## 🎯 Intake
**Goal:** Stop the guard matching .envrc.
**Context:** The guard matches by substring.
**Acceptance:**
- AC1: A path containing .envrc passes.'

# ── Running the hook ──────────────────────────────────────────────────────────
payload() { # session, transcript, [tool], [agent_id], [agent_type]
  local obj
  obj=$(jq -nc --arg s "$1" --arg t "$2" --arg tool "${3:-Edit}" \
    '{hook_event_name:"PreToolUse", tool_name:$tool, session_id:$s, transcript_path:$t,
      tool_input:{file_path:"/x/a.md", old_string:"a", new_string:"b"}}')
  [ -n "${4:-}" ] && obj=$(printf '%s' "$obj" | jq -c --arg v "$4" '.agent_id = $v')
  [ -n "${5:-}" ] && obj=$(printf '%s' "$obj" | jq -c --arg v "$5" '.agent_type = $v')
  printf '%s' "$obj"
}

nudge() { # stdin: payload
  local out
  out=$(env HOME="$FAKE_HOME" bash "$HOOK" 2>"$SANDBOX/stderr")
  printf '%s\n' "$out" >> "$ALL_OUTPUT"
  printf '%s' "$out"
}

verdict_of() {
  if printf '%s' "$1" | grep -q '"permissionDecision"'; then
    printf 'decision'
  elif printf '%s' "$1" | grep -q '"additionalContext"'; then
    printf 'nudge'
  elif [ -z "$1" ]; then
    printf 'silent'
  else
    printf 'other'
  fi
}

check() { # desc, output, expected
  local got
  got="$(verdict_of "$2")"
  if [ "$got" = "$3" ]; then ok "$1"; else no "$1" "expected $3, got $got"; fi
}

# A fresh session per case, so one case's state file never decides another's.
N=0
new_session() { N=$((N + 1)); SESSION="sess-$N"; T="$SANDBOX/$SESSION.jsonl"; : > "$T"; }
edit_now() { payload "$SESSION" "$T" | nudge; }

# ── 1. The skill is the one source of the routine ─────────────────────────────
echo "the skill carries the routine:"
[ -r "$SKILL" ] || { echo "FAIL: unreadable skill: $SKILL"; exit 1; }
FLAT="$(tr '\n' ' ' < "$SKILL" | tr -s ' ')"
has() { # desc, extended regex
  if printf '%s' "$FLAT" | grep -qE -- "$2"; then ok "$1"; else no "$1" "no match for: $2"; fi
}
has "frontmatter names the skill"                    '^--- name: intake '
has "the description says when to run it"            'description: The task-intake routine for an interactive session'
has "the description names both skips"               'Skip it for trivial asks and for pure questions'
has "step 1 states the goal"                         '### 1\. Goal'
has "step 2 gathers context before asking"           '### 2\. Context Gather it before you ask for any of it'
has "step 2 reads the repo and the vault"            'Read the repo.*Search the memory vault'
has "step 3 interviews only the real gaps"           '### 3\. Interview: only the real gaps'
has "the gap test is written out"                    'passes the \*\*gap test\*\* only when all three hold'
has "the gap test asks whether the agent can fill it" 'The prompt, the repo, and the vault cannot answer it'
has "the gap test weighs the cost of a wrong guess"  'A wrong guess wastes real work or is hard to undo'
has "a failed gap test is assumed, not asked"        'A question that fails any of the three is not asked'
has "the interview goes through AskUserQuestion"     'Ask every question that passes through `AskUserQuestion`'
has "no gap means no question"                       'When no question passes the test, ask nothing'
has "step 4 derives acceptance criteria"             '### 4\. Acceptance criteria Derive them from the goal and the context'
has "each criterion is observable"                   'check without asking you'
has "step 5 shows the block every time"              'Show it before any work starts, every time, even when you asked nothing'
has "the block is capped at about 12 rows"          'Keep the block to about 12 rows at 80 columns'
has "the block gives each criterion one line"        'Give each criterion one line'
has "the block carries goal, context, and criteria"  '## 🎯 Intake \*\*Goal:\*\*.*\*\*Context:\*\*.*\*\*Acceptance:\*\*'
has "assumptions are marked in the block"            'Mark each guess "Assumed:"'
has "step 6 asks for three angles"                   '### 6\. Three options, each from a different angle'
has "the distinctness check is written"              '\*\*Distinctness check\.\*\* Write it down before you grade'
has "the check names the angle of each option"       'Name each option.s angle in a short phrase'
has "the check turns one option into another"        'what would have to change to turn one into the other'
has "a variant is named and replaced"                'the two are variants of one angle\. Replace one of them'
has "two real angles are reported, not padded"       'If you can find only two real angles, say so'
has "step 7 grades against every criterion"          '### 7\. Grade every option against every criterion'
has "the recommendation cites every grade"           'The recommendation cites its grade on every criterion'
has "correctness breaks a tie"                       'the more correct option beats the faster one'
has "a real fork goes through AskUserQuestion"       'Put the options to Mike through `AskUserQuestion` only at a real fork'
has "a grade short of met names its criterion"     'names each criterion short of met by its number and a few words'
has "each option description carries grade and warning" "Each option.s description carries its grade and any warning Mike needs"
has "every decision goes through the tool"           'This holds for every decision Mike must make'
has "prose is the fallback only when the tool does not fit" 'Fall back to the output style.s `## ❓ Open questions` block only when the tool does not fit'
has "otherwise the agent proceeds and says so"       'Otherwise proceed on the top-graded option, and say so in one line'
has "the proceed line carries each grade"            'names the option and its grade on each criterion'
has "trivial asks skip it, and a hook does not decide" 'You decide that threshold, not a hook'
has "the nudge is named as never blocking"           'It never blocks the edit'
has "sub-agents never interview"                     'Other lanes never interview'
has "a sub-agent takes the brief as its intake"      'The brief is the intake'
has "the pipeline and scheduled ticks never interview" 'Index pipeline and scheduled ticks\.\*\* No interview and no nudge'
has "a dispatch carries the criteria"                'copies them into its `Acceptance:` slot'
has "the report maps to the criteria"                'The report maps to the criteria'

echo
echo "the output style points at the skill and does not copy it:"
assert_grep "the style points at the skill"      '/workbench-core:intake' "$STYLE"
assert_grep "the style names the skill as the one copy" 'That skill is the one copy of the routine' "$STYLE"
# Each needle is a phrase only the routine carries. One of them in the style
# means a second copy has started, and the two will drift.
for needle in 'gap test' 'Distinctness check' '## 🎯 Intake' 'variants of one angle' 'Assumed:'; do
  assert_no_grep "the style does not restate '$needle'" "$needle" "$STYLE"
done
# Rule 6 grades a recommendation against the criteria when a task has them.
# That is the one place the style and the routine meet, and it points one way.
assert_grep "rule 6 grades the recommendation against the criteria" \
  "grade against every one of them" "$STYLE"

echo
echo "the block the skill prescribes is the block the hook recognises:"
# Extracted from the skill, never retyped here. If the skill's heading drifts
# from what the hook looks for, this goes red instead of every task drawing a
# nudge the agent already satisfied.
SKILL_BLOCK="$(awk '/^```$/ && !f {f=1; next} f && /^```$/ {exit} f' "$SKILL")"
if printf '%s' "$SKILL_BLOCK" | grep -q 'Intake'; then
  ok "the skill's block is extractable"
else
  no "the skill's block is extractable" "no fenced block naming Intake"
fi
new_session
{ human p1 "Fix the guard."; say a1 "$SKILL_BLOCK"; } > "$T"
check "the skill's own block silences the nudge" "$(edit_now)" silent

# ── 2. The nudge ──────────────────────────────────────────────────────────────
echo
echo "the first Edit of a task with no intake block is nudged:"
new_session
human p1 "Fix the guard." > "$T"
OUT="$(edit_now)"
check "an Edit straight after the prompt" "$OUT" nudge
if printf '%s' "$OUT" | jq -e '.hookSpecificOutput.hookEventName == "PreToolUse"' >/dev/null 2>&1; then
  ok "the nudge declares the PreToolUse event"
else
  no "the nudge declares the PreToolUse event" "$OUT"
fi
NUDGE_TEXT="$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.additionalContext')"
for needle in "/workbench-core:intake" "nothing was blocked" "acceptance criteria" "If the task is trivial, carry on"; do
  if printf '%s' "$NUDGE_TEXT" | grep -qF -- "$needle"; then ok "the nudge says '$needle'"; else no "the nudge says '$needle'" "$NUDGE_TEXT"; fi
done
[ ! -s "$SANDBOX/stderr" ] && ok "the nudge path writes nothing to stderr" || no "the nudge path writes nothing to stderr" "$(cat "$SANDBOX/stderr")"

echo
echo "it fires once per task, not once per Edit:"
edit_call e1 "b" >> "$T"; result r1 >> "$T"
check "a second Edit on the same prompt is silent" "$(edit_now)" silent
check "and a third" "$(edit_now)" silent
human p2 "Now do the other guard." >> "$T"
check "a new prompt opens a new task, and is nudged" "$(edit_now)" nudge
check "which again fires only once" "$(edit_now)" silent

echo
echo "only a human prompt opens a task:"
# Sub-agent hand-backs and background-task notifications land in the main
# session as user records. Neither is Mike asking for something new.
new_session
human p1 "Fix the guard." > "$T"
check "the task's first Edit is nudged" "$(edit_now)" nudge
other_origin n1 task-notification "<task-notification>done</task-notification>" >> "$T"
check "a task notification does not reopen it" "$(edit_now)" silent
other_origin n2 peer "[Subagent hand-back] report" >> "$T"
check "a sub-agent hand-back does not reopen it" "$(edit_now)" silent
# A meta record carrying the human stamp is still not a prompt. The first case
# goes red if meta records open a task. The second goes red if a meta record
# hides the real prompt above it.
new_session
human p1 "Fix the guard." > "$T"
check "the task's first Edit is nudged" "$(edit_now)" nudge
jq -nc '{type:"user", origin:{kind:"human"}, isMeta:true, uuid:"m1", message:{role:"user", content:"caveat"}}' >> "$T"
check "a meta record stamped human does not reopen it" "$(edit_now)" silent
new_session
{ human p1 "Fix the guard."; jq -nc '{type:"user", origin:{kind:"human"}, isMeta:true, uuid:"m1", message:{role:"user", content:"caveat"}}'; } > "$T"
check "a meta record does not hide the prompt above it" "$(edit_now)" nudge

echo
echo "an intake block on screen keeps it silent:"
new_session
{ human p1 "Fix the guard."; say a1 "$INTAKE_BLOCK"; } > "$T"
check "the block shown after the prompt" "$(edit_now)" silent
new_session
{ human p1 "Fix the guard."; say a1 "Some reading first."; edit_call e0 "x"; result r0; say a2 "$INTAKE_BLOCK"; } > "$T"
check "the block shown after some tool calls" "$(edit_now)" silent
new_session
{ human p1 "Fix the guard."; say a1 "### Intake
Goal: fix it."; } > "$T"
check "a heading without the emoji" "$(edit_now)" silent
new_session
{ human p1 "Fix the guard."; say a1 "# intake"; } > "$T"
check "a lower-case heading" "$(edit_now)" silent

echo
echo "only a real intake heading in assistant text counts:"
new_session
{ human p1 "Fix the guard."; say a1 "I will skip the intake for this one."; } > "$T"
check "the word in prose is not a block" "$(edit_now)" nudge
new_session
{ human p1 "Fix the guard."; say a1 "## Intakes and outtakes"; } > "$T"
check "a heading with Intake only as part of a longer word" "$(edit_now)" nudge
new_session
{ human p1 "Fix the guard."; edit_call e1 "$INTAKE_BLOCK"; result r1; } > "$T"
check "the heading inside Edit input is not a block" "$(edit_now)" nudge
new_session
{ human p0 "Earlier."; say a0 "$INTAKE_BLOCK"; say a0b "Done."; edit_call e0 "x"; result r0; say a0c "Report."; human p1 "Next task."; } > "$T"
check "a block from an earlier task's start does not count" "$(edit_now)" nudge

echo
echo "an approved intake is not nudged again:"
# The common flow: show the block, end the turn on a question, get "yes". The
# block closed the turn before this prompt, so it is on screen for this task.
new_session
{ human p1 "Fix the guard."; edit_call e0 "x"; result r0; say a1 "$INTAKE_BLOCK"; say a2 "Proceed on Option B?"; human p2 "yes"; } > "$T"
check "the block that closed the previous turn counts" "$(edit_now)" silent
new_session
{ human p1 "Fix the guard."; say a1 "$INTAKE_BLOCK"; edit_call e0 "x"; result r0; say a2 "Proceed?"; human p2 "yes"; } > "$T"
check "a block followed by a tool call did not close the turn" "$(edit_now)" nudge
# A Stop hook (the memory capture checkpoint) wakes the agent after its closing
# question, and the agent writes a vault note before the human answers. Those
# tool calls do not reopen the turn. The CLI writes the Stop hook as a meta user
# record and as an attachment, and each shape is pinned on its own.
stop_feedback() { jq -nc --arg u "$1" '{type:"user", isMeta:true, uuid:$u, message:{role:"user", content:"Stop hook feedback:\n💾 Memory capture checkpoint (automatic, not from the user)."}}'; }
stop_attachment() { jq -nc --arg u "$1" '{type:"attachment", uuid:$u, attachment:{type:"hook_blocking_error", hookName:"Stop", hookEvent:"Stop"}}'; }
new_session
{ human p1 "Fix the guard."; say a1 "$INTAKE_BLOCK"; say a2 "Proceed on Option B?"; stop_feedback s1; edit_call e0 "note"; result r0; say a3 "Saved one note."; human p2 "yes"; } > "$T"
check "a vault write after a Stop hook feedback record keeps the block" "$(edit_now)" silent
new_session
{ human p1 "Fix the guard."; say a1 "$INTAKE_BLOCK"; say a2 "Proceed on Option B?"; stop_attachment s1; edit_call e0 "note"; result r0; say a3 "Saved one note."; human p2 "yes"; } > "$T"
check "a vault write after a Stop hook attachment keeps the block" "$(edit_now)" silent
# The control: the same tool calls with no Stop hook before them close the turn
# on "Saved one note.", and the block no longer counts.
new_session
{ human p1 "Fix the guard."; say a1 "$INTAKE_BLOCK"; say a2 "Proceed on Option B?"; edit_call e0 "note"; result r0; say a3 "Saved one note."; human p2 "yes"; } > "$T"
check "the same tool calls without a Stop hook still reset it" "$(edit_now)" nudge
# A meta record that is not a Stop hook does not count as one.
new_session
{ human p1 "Fix the guard."; say a1 "$INTAKE_BLOCK"; jq -nc '{type:"user", isMeta:true, uuid:"m1", message:{role:"user", content:"<local-command-caveat>x</local-command-caveat>"}}'; edit_call e0 "x"; result r0; say a3 "Done."; human p2 "yes"; } > "$T"
check "another meta record does not stand in for a Stop hook" "$(edit_now)" nudge

echo
echo "lanes that never see it:"
new_session
human p1 "Fix the guard." > "$T"
check "a sub-agent (agent_id and agent_type)" "$(payload "$SESSION" "$T" Edit a79d47fc851cc123f general-purpose | nudge)" silent
check "agent_id alone" "$(payload "$SESSION" "$T" Edit a79d47fc851cc123f | nudge)" silent
check "a top-level --agent run, which is the Index pipeline" "$(payload "$SESSION" "$T" Edit "" watson | nudge)" silent
new_session
human p0 '<scheduled-task name="dispatch" file="/x/SKILL.md">Run the tick.</scheduled-task>' > "$T"
check "the scheduled tick's own prompt" "$(edit_now)" silent
# A session that began as a tick can go on to take a typed task. That task is
# nudged like any other: only the current prompt decides.
human p1 "Fix the guard." >> "$T"
check "a typed task after a scheduled tick is nudged" "$(edit_now)" nudge
new_session
{ human p0 "Hello."; say a0 "Hi."; human p1 '<scheduled-task name="loop" file="/x/SKILL.md">Check the queue.</scheduled-task>'; } > "$T"
check "a scheduled prompt inside a session" "$(edit_now)" silent
# The control for both: the same session is nudged once the prompt is human.
human p2 "Fix the guard." >> "$T"
check "the same session's human prompt is nudged" "$(edit_now)" nudge

echo
echo "tools other than Edit are out of scope:"
new_session
human p1 "Fix the guard." > "$T"
for tool in Write Bash Read NotebookEdit; do
  check "$tool is silent" "$(payload "$SESSION" "$T" "$tool" | nudge)" silent
done
check "and Edit still fires on the same transcript" "$(edit_now)" nudge

echo
echo "every failure is silence:"
new_session
human p1 "Fix the guard." > "$T"
check "no transcript path" "$(payload "$SESSION" "" | nudge)" silent
check "a transcript that does not exist" "$(payload "$SESSION" "$SANDBOX/nope.jsonl" | nudge)" silent
check "a session id that cannot name a state file" "$(payload "../evil" "$T" | nudge)" silent
check "an empty payload" "$(printf '' | nudge)" silent
check "a payload that is not JSON" "$(printf 'not json' | nudge)" silent
new_session
say a0 "Nothing human yet." > "$T"
check "a transcript with no human prompt" "$(edit_now)" silent
new_session
jq -nc '{type:"user", origin:{kind:"human"}, message:{role:"user", content:"Fix the guard."}}' > "$T"
mkdir -p "$FAKE_HOME/.claude-workbench/intake-nudge"
printf 'stale-uuid' > "$FAKE_HOME/.claude-workbench/intake-nudge/$SESSION"
check "a prompt with no uuid is left alone" "$(edit_now)" silent
# State that cannot be written: HOME is a file, so the state dir cannot exist.
new_session
human p1 "Fix the guard." > "$T"
: > "$SANDBOX/home-is-a-file"
out=$(payload "$SESSION" "$T" | env HOME="$SANDBOX/home-is-a-file" bash "$HOOK" 2>/dev/null)
printf '%s\n' "$out" >> "$ALL_OUTPUT"
check "state that cannot be written is silent, not a nudge on every Edit" "$out" silent
# jq missing.
NOJQ_BIN="$SANDBOX/nojq-bin"
mkdir -p "$NOJQ_BIN"
for tool in bash cat grep sed tr cut tail dirname mkdir; do
  src="$(command -v "$tool" 2>/dev/null)" && ln -sf "$src" "$NOJQ_BIN/$tool"
done
out=$(payload "$SESSION" "$T" | env HOME="$FAKE_HOME" PATH="$NOJQ_BIN" bash "$HOOK" 2>/dev/null)
check "jq missing" "$out" silent
# A line that is not JSON, such as a record still being written, is skipped.
new_session
{ human p1 "Fix the guard."; printf '{"type":"assistant","trunc\n'; say a1 "$INTAKE_BLOCK"; } > "$T"
check "a torn line does not hide the block after it" "$(edit_now)" silent
new_session
{ human p1 "Fix the guard."; printf '{"type":"assistant","trunc\n'; } > "$T"
check "a torn line does not suppress the nudge" "$(edit_now)" nudge

echo
echo "state older than three days is swept:"
STATE="$FAKE_HOME/.claude-workbench/intake-nudge"
mkdir -p "$STATE"
printf 'old' > "$STATE/sess-old"
touch -t 202001010000 "$STATE/sess-old"
printf 'recent' > "$STATE/sess-recent"
new_session
human p1 "Fix the guard." > "$T"
edit_now >/dev/null
[ ! -e "$STATE/sess-old" ] && ok "a state file older than three days is removed" || no "a state file older than three days is removed" "still there"
[ -e "$STATE/sess-recent" ] && ok "a recent state file of another session is kept" || no "a recent state file of another session is kept" "gone"

echo
echo "it never denies:"
# Every output this suite collected, from every case above. One permission
# decision anywhere, allow included, fails this.
if grep -q '"permissionDecision"' "$ALL_OUTPUT"; then
  no "no output carries a permissionDecision" "$(grep -m1 permissionDecision "$ALL_OUTPUT")"
else
  ok "no output carries a permissionDecision ($(grep -c additionalContext "$ALL_OUTPUT") nudges checked)"
fi
assert_no_grep "the script never writes a deny" '"deny"' "$HOOK"
assert_no_grep "the script never names a permission decision" 'permissionDecision' "$HOOK"

echo
echo "the hook is registered in hooks.json:"
matcher=$(jq -r '[.hooks.PreToolUse[] | select(.hooks[].command | test("intake-nudge.sh")) | .matcher] | join(",")' "$HOOKS_JSON")
[ "$matcher" = "Edit" ] && ok "matcher is exactly Edit" || no "matcher is exactly Edit" "got [$matcher]"
count=$(jq '[.hooks.PreToolUse[].hooks[] | select(.command | test("intake-nudge.sh"))] | length' "$HOOKS_JSON")
[ "$count" = "1" ] && ok "registered exactly once" || no "registered exactly once" "got $count"
# The harness expands ${CLAUDE_PLUGIN_ROOT} into a shell line. An unquoted
# expansion word-splits on a path with a space, and the hook never runs.
CMD_TEMPLATE="$(jq -r '[.hooks.PreToolUse[].hooks[] | select(.command | test("intake-nudge.sh")) | .command][0] // ""' "$HOOKS_JSON")"
SPACED_ROOT="$SANDBOX/plugin root"
mkdir -p "$SPACED_ROOT/hooks/lib"
cp "$HOOK" "$SPACED_ROOT/hooks/intake-nudge.sh"
new_session
human p1 "Fix the guard." > "$T"
out=$(payload "$SESSION" "$T" | env HOME="$FAKE_HOME" CLAUDE_PLUGIN_ROOT="$SPACED_ROOT" sh -c "${CMD_TEMPLATE:-false}")
check "the hook fires when the plugin path contains a space" "$out" nudge

echo
echo "the README documents both halves:"
assert_grep "README names the skill"      'skills/intake/SKILL.md' "$README"
assert_grep "README names the hook"       'hooks/intake-nudge.sh' "$README"
assert_grep "README names this suite"     'hooks/test-intake.sh' "$README"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
