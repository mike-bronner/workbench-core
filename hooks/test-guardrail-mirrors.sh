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
# it. Trimming the test back to four checks would silently un-enforce rule 9.
echo
echo "the persona's drift test checks question placement:"
if printf '%s' "$(flat "$STYLE")" | grep -qiE 'Is every open question'; then
  ok "output-style.md drift test asks where the open questions are"
else
  no "output-style.md drift test asks where the open questions are" \
     "the drift test no longer mentions open questions"
fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
