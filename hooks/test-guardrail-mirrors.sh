#!/bin/bash
# Guards the guardrail set against landing a rule in one mirror and missing the
# rest. Run directly: ./test-guardrail-mirrors.sh
#
# WHY THIS EXISTS
#
# The guardrails are mirrored across four files, and they are not copies of each
# other. Each one reaches the model by a different route, in a different
# register:
#
#   references/guardrails.md              full text with ❌/✅ examples, read on
#                                         demand and by the interview skills
#   references/guardrails-inline.md       one line per rule, injected into
#                                         context by hooks/session-warmup.sh
#   references/behavioral-overrides.md    terse overrides, rendered onto disk
#                                         into ~/.claude/system-overrides.md and
#                                         the managed ~/.claude/CLAUDE.md block
#   assets/personas/clear/output-style.md the shipped persona's own voice, plus
#                                         the drift test it runs before sending
#
# A rule added to one of them and missed in the others is present in the repo
# and absent from the session that needed it — and the two injected copies are
# the ones that actually reach a running session, so the silent half is the
# expensive half.
#
# These checks assert the rules that must be everywhere are everywhere. They do
# NOT compare wording: each mirror is deliberately written in its own register,
# and a test demanding identical prose would force the four files to converge
# into one, which is the thing the split exists to avoid.

set -u
HOOKS="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HOOKS/.." && pwd)"
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); echo "  ✅ $1"; }
no() { FAIL=$((FAIL + 1)); echo "  ❌ $1 — $2"; }

FULL="$ROOT/references/guardrails.md"
INLINE="$ROOT/references/guardrails-inline.md"
OVERRIDES="$ROOT/references/behavioral-overrides.md"
STYLE="$ROOT/assets/personas/clear/output-style.md"

for f in "$FULL" "$INLINE" "$OVERRIDES" "$STYLE"; do
  [ -r "$f" ] || { echo "FAIL: unreadable mirror: $f"; exit 1; }
done

# Every mirror wraps its prose at a different width, so a sentence breaks in a
# different place in each one. Match against a whitespace-flattened copy: a
# line-oriented grep would pass or fail on where the wrap happens to land, which
# is not a property worth testing.
flat() { tr '\n' ' ' < "$1" | tr -s ' '; }

has() { # desc, file, extended-regex
  if printf '%s' "$(flat "$2")" | grep -qiE -- "$3"; then
    ok "$1"
  else
    no "$1" "no match for: $3"
  fi
}

# ── Guardrail 11: question delivery ──────────────────────────────────────────
#
# Rule 1 requires three options and a recommendation, and said nothing about
# where the user reads them. Questions landed mid-response and scrolled away
# under the output that followed, so work stalled on an answer nobody knew was
# wanted. Rule 11 names the channel, and it is worth three checks per mirror
# because it has three separable halves — any one of them dropped leaves the
# original failure in place.
#
# The rule is prose, not a hook: detecting an unanswered question in free text
# is semantic, and the one classifier this repo built and measured (see
# hooks/agent-dispatch-gate.sh) topped out at 33% precision. Mirrors plus these
# checks are the enforcement that is actually available.
echo "guardrail 11 — question delivery reaches every mirror:"
for f in "$FULL" "$INLINE" "$OVERRIDES" "$STYLE"; do
  m="$(basename "$f")"
  # Half 1 — the primary channel is the tool, which renders as a prompt.
  has "$m names AskUserQuestion as the channel" "$f" 'AskUserQuestion'
  # Half 2 — the fallback exists, and it is a marked block with a fixed heading.
  # Without this an open-ended question has nowhere to go and stays buried.
  has "$m specifies the ❓ Open questions fallback block" "$f" '❓ Open questions'
  # Half 3 — placement. A questions block above the verdict is buried by the
  # verdict, so "last" is the whole point of the rule.
  has "$m places that block last in the response" "$f" \
    '(last thing in the response|end of the response)'
done

# ── Guardrail 12: a finding carries a verdict ────────────────────────────────
#
# Rule 1 governs changes, and it scopes itself to action boundaries in its own
# ✅ example. Rule 11 governs open questions. A finding that proposes no action
# and asks no question satisfies both by triggering neither, so it reaches the
# user as a bare fact. That shipped while closing a release: two real findings
# went out with no verdict, no options and no recommendation, and the user had
# to ask what to do with them. Rule 12 closes the gap. It is worth three checks
# per mirror because it has three separable halves, and a mirror carrying only
# one of them leaves most of the original failure in place.
echo
echo "guardrail 12: a finding carries a verdict and a recommendation:"
for f in "$FULL" "$INLINE" "$OVERRIDES" "$STYLE"; do
  m="$(basename "$f")"
  # Half 1 is the requirement, with both halves named. A verdict alone still
  # leaves the user to work out what to do, and a recommendation alone skips
  # the question of whether there is a problem at all.
  has "$m requires a verdict and a recommendation" "$f" \
    'verdict and a recommendation'
  # Half 2 is that severity does not substitute for a verdict. "Neither is urgent"
  # is the exact sentence that shipped in place of one, and a later session
  # made the same substitution with "unknown".
  has "$m rejects severity standing in for a verdict" "$f" \
    'severity is not a verdict'
  # Half 3 is that "no action needed" is itself a verdict and gets stated. Without
  # this the rule reads as "report problems", and the findings that need
  # nothing are dropped instead of closed.
  has "$m keeps \"no action needed\" a stated verdict" "$f" \
    'no action needed'
done

# ── Guardrail 13: a question carries its situation, options, recommendation ──
#
# Rule 11 named the channel a question travels down and said nothing about what
# travels down it, so a bare numbered list of questions satisfied every rule
# then written. Three failures shipped that way, and they are separable: a fact
# was stated where the next step depended on an answer and no question was ever
# asked; a fork with no defect behind it was framed as a problem; and questions
# arrived with no situation attached, leaving the reader to reconstruct what
# each one was about. Rule 1 carried the shape already, and scopes itself to
# "before making changes", so a question about anything else inherited none of
# it. Rule 13 binds all three, in whichever channel rule 11 selects.
#
# Four checks per mirror, not three. Recognize and Shape are one assertion each.
# Frame is two: "lead with the situation" and "a fork is not a defect" fail
# independently, and a mirror keeping one of them still reproduces one of the
# three original complaints.
echo
echo "guardrail 13 — every question carries situation, options, recommendation:"
for f in "$FULL" "$INLINE" "$OVERRIDES" "$STYLE"; do
  m="$(basename "$f")"
  # Recognize — a fact the reader must convert into a question was never asked.
  has "$m turns a blocking fact into a stated question" "$f" \
    'state it as a question'
  # Frame, part 1 — the question leads with what produced it. Without this the
  # rule permits the bare numbered list that prompted it.
  has "$m opens the question with its situation" "$f" \
    'opens? with the situation'
  # Frame, part 2 — a fork is not a defect. Rule 12's report order is written
  # for something that might be a problem, and a mirror dropping this clause
  # leaves a neutral choice no honest shape to be reported in.
  has "$m keeps a fork from being framed as a problem" "$f" \
    'a choice is not a problem'
  # Shape — options AND a recommendation AND its reason. Matching on "three
  # options and a recommendation" alone would pass on output-style.md's hard
  # rule 1, which already carries that phrase, so the reason is part of the
  # anchor rather than assumed.
  has "$m requires three options and a reasoned recommendation" "$f" \
    'three options,? and a recommendation with its reason'
done

# ── Guardrail 14: every option set is laid out the same way ──────────────────
#
# Rules 1, 12 and 13 all demand three options and a recommendation, and none of
# them said what that looks like on the page. So the layout was reinvented per
# reply. The last drift put a different medal glyph on each option, shortened
# the titles to fragments, and folded the recommendation into the option it
# picked, which the user reported as hard to read against a form that used to
# be clean. Rule 14 pins the shape.
#
# Six checks per mirror, because the rule has six separable halves and dropping
# any one of them brings back a piece of the original defect. The marker and
# its invariance are counted apart on purpose: a mirror can name 🔹 and still
# permit a different glyph per option, which is the exact inconsistency that
# started this — 🅰️ and 🅱️ render red as blood-type emoji while 🅲 (U+1F172)
# has no emoji presentation and falls back to gray.
echo
echo "guardrail 14 — option-set layout reaches every mirror:"
for f in "$FULL" "$INLINE" "$OVERRIDES" "$STYLE"; do
  m="$(basename "$f")"
  # Half 1 — the marker itself. 🔹 is U+1F539: natively Wide, no variation
  # selector, so it is not in the class Terminal.app miscounts.
  has "$m names 🔹 as the option marker" "$f" '🔹'
  # Half 2 — the marker is the same on every option. Without this the rule
  # permits a per-option glyph set, which is the defect it was written for.
  has "$m keeps the marker identical across options" "$f" \
    '(never var(y|ies) the glyph|the glyph carries nothing)'
  # Half 3 — each option is a heading carrying a spelled-out letter. A bold
  # line in a paragraph loses the color the renderer gives a real heading, and
  # the color is what makes the set scannable.
  has "$m spells the option letter out in a heading" "$f" 'Option A'
  # Half 4 — pros AND cons under each option. Pros alone is the presentation
  # rule 9 already forbids, and this is where it becomes a layout slot.
  has "$m requires pros and cons under each option" "$f" \
    'pros and( its)? cons'
  # Half 5 — the recommendation stands alone after all three options. Folded
  # into the winning option, it is the form the user reported as unreadable.
  has "$m puts the recommendation in a separate paragraph" "$f" \
    'separate paragraph'
  # Half 6 — the tiebreak. Without it a recommendation can be argued from
  # convenience and no rule contradicts it.
  has "$m ties the recommendation to architectural correctness" "$f" \
    'architecturally correct'
done

# ── Cons before pros: ordering is not labelling ──────────────────────────────
#
# "Lead with what is wrong or risky" is an ordering instruction, and nothing
# said it was ONLY an ordering instruction. Three sub-agent findings were
# relayed as three costs when one was an improvement and one was a fix, so
# three commits of good work read as a list of concessions. The clause that
# fixes it makes two assertions, and a mirror carrying only the first is back
# where it started.
echo
echo "ordering is distinguished from labelling in every mirror:"
for f in "$FULL" "$INLINE" "$OVERRIDES" "$STYLE"; do
  m="$(basename "$f")"
  has "$m separates ordering from labelling" "$f" 'label by fact'
  has "$m defines a cost by the reader's position" "$f" 'worse off for'
done

# ── Numbering is append-only ─────────────────────────────────────────────────
#
# Rules are cited by number in the README, in skills/define-soul, in
# skills/define-profile, and in the user's own ~/.claude configuration. A
# renumber breaks every one of those references silently — nothing errors, the
# citation just points at a different rule. New rules therefore append.
echo
echo "existing guardrail numbers are stable (citations point at them by number):"
anchor() { # desc, extended-regex, file
  if grep -qE -- "$2" "$3"; then ok "$1"; else no "$1" "anchor moved or renamed"; fi
}
anchor "guardrails.md rule 1 is still the three-options rule" \
  '^1\. \*\*Always present three options' "$FULL"
anchor "guardrails.md rule 10 is still the delegation rule" \
  '^10\. \*\*Delegate work to sub-agents' "$FULL"
anchor "guardrails-inline.md rule 1 is still the three-options rule" \
  '^1\. \*\*Always present three options' "$INLINE"
anchor "guardrails-inline.md rule 10 is still the delegation rule" \
  '^10\. \*\*Delegate work to sub-agents' "$INLINE"
anchor "guardrails.md rule 12 is still the finding-verdict rule" \
  '^12\. \*\*Every finding carries' "$FULL"
anchor "guardrails-inline.md rule 12 is still the finding-verdict rule" \
  '^12\. \*\*Every finding carries' "$INLINE"
anchor "guardrails.md rule 13 is still the question-contents rule" \
  '^13\. \*\*Every question carries' "$FULL"
anchor "guardrails-inline.md rule 13 is still the question-contents rule" \
  '^13\. \*\*Every question carries' "$INLINE"
anchor "guardrails.md rule 14 is still the option-layout rule" \
  '^14\. \*\*Lay every option set' "$FULL"
anchor "guardrails-inline.md rule 14 is still the option-layout rule" \
  '^14\. \*\*Lay every option set' "$INLINE"

# ── The inline copy condenses the full text, so the rule counts must agree ────
#
# This is the general form of the failure above: whatever rule is added next,
# the condensed copy is the one that actually gets injected every session, and
# it is the easy one to forget. Counting is register-agnostic, so it keeps
# working without anyone teaching it the new rule's wording.
echo
echo "the injected copy carries every rule the full text does:"
rule_count() { grep -cE '^[0-9]+\. \*\*' "$1"; }
FULL_N="$(rule_count "$FULL")"
INLINE_N="$(rule_count "$INLINE")"
if [ "$FULL_N" -eq "$INLINE_N" ] && [ "$FULL_N" -gt 0 ]; then
  ok "guardrails.md and guardrails-inline.md both carry $FULL_N rules"
else
  no "guardrails.md and guardrails-inline.md carry the same rule count" \
     "full text has $FULL_N, inline has $INLINE_N"
fi

# ── The persona runs its drift test before sending ───────────────────────────
#
# The output style's drift test is the last gate before a reply goes out, so a
# rule about where a question sits is only enforced if the drift test asks about
# it. Trimming the test back to four checks would silently un-enforce hard rule
# 9, trimming it back to five would do the same to hard rule 10, and trimming it
# back to six would do the same to hard rule 11 — which spends two of the checks,
# because its two failure modes are independent. Trimming it back to eight would
# do the same to hard rule 12. All four rules need the cover for one reason: a
# finding reported as a bare fact, a question with no options, a fork labelled a
# problem, and an option set laid out however this reply felt like laying it out
# are send-time failures, and the drift test is the only thing that reads the
# whole reply before it goes out.
echo
echo "the persona's drift test checks question placement, question contents, finding verdicts, and option layout:"
if printf '%s' "$(flat "$STYLE")" | grep -qiE 'Is every open question'; then
  ok "output-style.md drift test asks where the open questions are"
else
  no "output-style.md drift test asks where the open questions are" \
     "the drift test no longer mentions open questions"
fi
if printf '%s' "$(flat "$STYLE")" | grep -qiE 'Does every finding carry'; then
  ok "output-style.md drift test asks whether findings carry a verdict"
else
  no "output-style.md drift test asks whether findings carry a verdict" \
     "the drift test no longer mentions findings"
fi
# Hard rule 11 needs two send-time questions, not one. "Did you attach options?"
# and "did you call a fork a fork?" fail independently, and the second is the
# one a reply can get wrong while looking complete.
if printf '%s' "$(flat "$STYLE")" | grep -qiE 'Does every question carry its situation'; then
  ok "output-style.md drift test asks whether questions carry situation and options"
else
  no "output-style.md drift test asks whether questions carry situation and options" \
     "the drift test no longer mentions what a question contains"
fi
if printf '%s' "$(flat "$STYLE")" | grep -qiE 'fork .{0,40}(as a fork|rather than as a problem)'; then
  ok "output-style.md drift test asks whether a fork was stated as a fork"
else
  no "output-style.md drift test asks whether a fork was stated as a fork" \
     "the drift test no longer separates a fork from a problem"
fi
# Hard rule 12 is a send-time check like the three above it: the layout is wrong
# only once the reply is written, and nothing earlier in the turn can see it.
if printf '%s' "$(flat "$STYLE")" | grep -qiE 'Does every option set'; then
  ok "output-style.md drift test asks whether options use the 🔹 heading layout"
else
  no "output-style.md drift test asks whether options use the 🔹 heading layout" \
     "the drift test no longer mentions option layout"
fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
