#!/bin/bash
# Tests for the intake routine: the one source of it (skills/intake/SKILL.md).
# Run directly: ./test-intake.sh
#
# The nudge that reminds the main agent of it, on a task's first Edit, lives in
# the hooks module (hooks/mods/intake.ts, hooks/register.ts), and
# tests/intake.test.ts covers it.

set -u
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HOOKS_DIR/.." && pwd)"
SKILL="$ROOT/skills/intake/SKILL.md"
STYLE="$ROOT/assets/personas/clear/output-style.md"
README="$ROOT/README.md"
PASS=0
FAIL=0


ok() { PASS=$((PASS + 1)); echo "  ✅ $1"; }
no() { FAIL=$((FAIL + 1)); echo "  ❌ $1: $2"; }

assert_grep() { # desc, fixed string, file
  if grep -qF -- "$2" "$3" 2>/dev/null; then ok "$1"; else no "$1" "missing: $2"; fi
}
assert_no_grep() { # desc, fixed string, file
  if grep -qF -- "$2" "$3" 2>/dev/null; then no "$1" "found: $2"; else ok "$1"; fi
}


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
has "the context sits right above the call"          'Write the context the question needs in prose immediately above the call, in the same message'
has "a question with no fixed choices uses the tool"  'A question with no fixed choices still goes through the tool'
# A question goes right after its context first appears, not held for the end
# of the reply with that context restated. Mike set this on 2026-10-06.
has "the question follows its context at once"      'Ask it right after that context first appears, and do not hold it for the end of the reply'
# Both files are hard-wrapped, so each check reads a flattened copy, and a
# returning clause is caught wherever a line break splits it. The needles are
# each file's own old wording: the skill echoed the style's clause, and the
# README said the item "comes last and stands on its own".
README_FLAT="$(tr '\n' ' ' < "$README" | tr -s ' ')"
lacks_in() { # desc, flattened text, fixed string
  if printf '%s' "$2" | grep -qF -- "$3"; then no "$1" "found: $3"; else ok "$1"; fi
}
for needle in 'item Mike acts on comes last' 'stands on its own, so it restates'; do
  lacks_in "the skill does not hold the question for the end ('$needle')" "$FLAT" "$needle"
done
for needle in 'item Mike acts on comes last' 'comes last and stands on its own'; do
  lacks_in "the README does not hold the question for the end ('$needle')" "$README_FLAT" "$needle"
done
if printf '%s' "$README_FLAT" | grep -qF -- 'Each question is asked right after the context it depends on first appears, and is not held for the end of the reply with that context restated.'; then
  ok "the README asks right after the context appears"
else
  no "the README asks right after the context appears" "missing the placement sentence"
fi
# The prose fallback was retired on 2026-10-05: every question goes through the
# tool, and the workbench-core mod re-prompts a reply that leaves one in prose.
if printf '%s' "$FLAT" | grep -q 'Open questions'; then
  no "the skill offers no prose fallback" "found: Open questions"
else
  ok "the skill offers no prose fallback"
fi
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

echo
echo "the block the skill prescribes is the block the nudge recognises:"
# Extracted from the skill, never retyped here. hooks/mods/intake.ts counts an
# intake block as shown when a markdown heading names Intake. If the skill's
# block drifts from that, every task draws a nudge the agent already satisfied.
SKILL_BLOCK="$(awk '/^```$/ && !f {f=1; next} f && /^```$/ {exit} f' "$SKILL")"
if printf '%s\n' "$SKILL_BLOCK" | grep -Eiq '^[[:space:]]*#{1,6}[[:space:]]+.*intake'; then
  ok "the skill's block opens under a heading that names Intake"
else
  no "the skill's block opens under a heading that names Intake" "$SKILL_BLOCK"
fi

echo
echo "the README documents both halves:"
assert_grep "README names the skill"      'skills/intake/SKILL.md' "$README"
assert_grep "README names the nudge"      'hooks/mods/intake.ts' "$README"
assert_grep "README names this suite"     'hooks/test-intake.sh' "$README"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
