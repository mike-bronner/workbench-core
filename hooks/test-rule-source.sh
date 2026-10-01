#!/bin/bash
# Guards the one-source shape of the behavioural rules. Run directly:
# ./test-rule-source.sh
#
# WHY THIS EXISTS
#
# The rules used to load four times per main session: the output style,
# ~/.claude/system-overrides.md, the managed ~/.claude/CLAUDE.md block, and a
# guardrails payload on the warmup's stdout. The copies drifted and contradicted
# each other, and the CLAUDE.md copy reached every sub-agent, pushing rules like
# "present options" and AskUserQuestion into agents that lack the tool. A test
# then pinned all four copies against each other, which kept the duplication
# alive.
#
# This test pins the opposite shape. The rules live in
# assets/personas/clear/output-style.md and nowhere a session loads. Three
# checks carry that:
#
#   1. The source holds the approved rule set: twelve numbered rules, three
#      habits of shape, and the verify line. Each keeps the anchor that makes it
#      that rule.
#   2. The source obeys its own register. A literal model imitates the text it
#      reads, so a rule file that breaks a rule teaches the break.
#   3. Nothing the warmup writes or prints restates a rule. The needles are
#      DERIVED from the source's own rule titles, so a new or renamed rule is
#      covered without editing this file.

set -u
HOOKS="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HOOKS/.." && pwd)"
STYLE="$ROOT/assets/personas/clear/output-style.md"
WARMUP="$HOOKS/session-warmup.sh"
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); echo "  ✅ $1"; }
no() { FAIL=$((FAIL + 1)); echo "  ❌ $1: $2"; }

[ -r "$STYLE" ] || { echo "FAIL: unreadable source: $STYLE"; exit 1; }

# The body without its frontmatter, flattened so a phrase is found wherever the
# wrap happens to break it.
BODY="$(awk 'NR==1 && /^---$/ {fm=1; next} fm && /^---$/ {fm=0; next} !fm' "$STYLE")"
FLAT="$(printf '%s' "$BODY" | tr '\n' ' ' | tr -s ' ')"

has() { # desc, extended-regex
  if printf '%s' "$FLAT" | grep -qiE -- "$2"; then ok "$1"; else no "$1" "no match for: $2"; fi
}

# ── 1. The approved rule set ─────────────────────────────────────────────────
echo "the output style carries the approved rule set:"
RULE_COUNT="$(printf '%s\n' "$BODY" | grep -cE '^[0-9]+\. \*\*')"
if [ "$RULE_COUNT" -eq 12 ]; then
  ok "exactly twelve numbered rules"
else
  no "exactly twelve numbered rules" "found $RULE_COUNT"
fi
has "verify before asserting is stated"             'Verify before you assert'
has "rule 1 leads with the answer"                  '1\. \*\*Lead with the answer'
has "rule 2 requires the reason"                    '2\. \*\*Always state the reason'
has "rule 2 bounds the reason to one per point"     'one reason per point'
has "rule 3 separates ordering from labelling"      '3\. \*\*Order by risk, label by fact'
has "rule 3 defines a cost by the reader"           'worse off for'
has "rule 3 keeps a fix out of the cost column"     'correctness fix is never filed as a cost'
has "rule 4 routes every decision to the tool"     'each decision Mike must make, and each blocking question, to him through `AskUserQuestion`'
has "rule 4 puts grade and warning in the option"   "option's description carries its grade and any warning"
has "rule 4 names the fallback heading"             '## ❓ Open questions'
has "rule 4 places the fallback last"               'comes last in the reply'
has "rule 5 requires a verdict and a recommendation" 'verdict and a recommendation'
has "rule 5 keeps \"no action needed\" a verdict"   'No action needed" is a valid verdict'
has "rule 6 limits options to a real fork"          'real fork that Mike has not decided'
has "rule 6 keeps options before irreversible acts" 'outward-facing or irreversible action'
has "rule 6 hands commits and pushes to the gate"   'Commits and ordinary pushes are the exception'
# Rule 6 renders options as one table, because three headings with pros and
# cons ran 25 to 30 rows and pushed the recommendation off Mike's screen.
has "rule 6 keeps three options"                    'give options, give three'
has "rule 6 renders the options as one table"       'in one table with the columns Option, Pros, Cons, and Grade'
has "rule 6 keeps the table to 80 columns"          'the table fits 80 columns'
has "rule 6 puts the recommendation after the table" 'After the table, one or two sentences name your recommendation'
has "rule 6 sends the pick to the tool"             'If Mike must pick, ask through `AskUserQuestion`'
has "rule 6 favours correctness"                    'favours correctness over speed'
has "rule 6 grades against the criteria"            'grade against every one of them'
# The intake routine is a procedure, not a rule, so the style points at it and
# carries no copy. hooks/test-intake.sh pins the routine and the absence of a copy.
has "the style points at the intake skill"          'run the intake routine in `/workbench-core:intake`'
has "rule 7 holds and then implements"              'do not reopen it'
has "rule 7 reverses without drama"                 'reverse in one sentence'
has "rule 8 bans contractions"                      'spell out every contraction'
has "rule 8 bans the em dash and the semicolon"     'Never use an em dash or a semicolon'
has "rule 8 bans marketing adjectives"              'marketing adjectives'
has "rule 9 scopes emoji to terminal structure"     'emoji as structure in terminal replies'
has "rule 10 adopts the register, not the identity" 'adopt the register and never the identity'
# Rule 11 is the density rule. Mike's largest past problem with agents was
# outward prose too dense for a normal person to follow. It is stated rather
# than checked, because a deny on a judgement call breeds workarounds.
has "rule 11 writes outward prose for a tired reader" '11\. \*\*Write outward prose for a tired reader'
has "rule 11 says only what the reader needs to act" 'Say only what they need to act'
has "rule 11 asks for short paragraphs and plain words" 'short paragraphs and plain words'
has "rule 11 bans restated context"                 'Do not restate context'
has "rule 11 aims at one pass"                      'get the point in one pass'
# Rule 12 is the screen budget. Mike reads at 80 by 50, and a reply that
# outruns the screen scrolls away the very text a decision depends on.
has "rule 12 fits a reply on one screen"            '12\. \*\*Fit a terminal reply on one screen'
has "rule 12 sets the row budget at 80 columns"     'about 40 rows at that width'
has "rule 12 puts the item Mike acts on last"       'The item Mike acts on comes last'
has "rule 12 makes that item stand on its own"      'It stands on its own'
has "rule 12 bans pointing at text not restated"    'Never refer to earlier text that the reply does not restate'
has "the table habit is stated"                     'three or more comparable items in a table'
has "the caveat habit is stated, and is not a hedge" 'honest caveat.{0,80}It is not a hedge'
has "the synthesis habit is stated"                 'Synthesize sub-agent output'
has "the close is a verdict, not a summary"         'Close with the verdict, not a summary'

# The cuts Mike approved stay cut. Each needle is the phrase that carried the
# retired rule, so its return is a regression rather than a rewording.
echo
echo "the retired rules stay retired:"
lacks() { # desc, extended-regex
  if printf '%s' "$FLAT" | grep -qiE -- "$2"; then no "$1" "found: $2"; else ok "$1"; fi
}
lacks "no three options before every change" 'three options and a recommendation before making changes'
lacks "no hard 20-word sentence cap"         '20 words'
lacks "no emoji at the same density"         'same density'
lacks "no drift test"                        'drift test'
lacks "no delegate-by-default rule"          'delegate'
lacks "no reason that outranks brevity"     'outranks brevity'
lacks "no heading per option"               '### 🔹 Option'

# ── 2. The source obeys its own register ─────────────────────────────────────
echo
echo "the output style obeys the register it states:"
# Inline code is quoted syntax, not prose, so it is stripped before the checks.
PROSE="$(printf '%s' "$BODY" | sed 's/`[^`]*`//g')"
if printf '%s' "$PROSE" | grep -q '—'; then
  no "no em dash" "$(printf '%s' "$PROSE" | grep -m1 '—')"
else
  ok "no em dash"
fi
if printf '%s' "$PROSE" | grep -q ';'; then
  no "no semicolon" "$(printf '%s' "$PROSE" | grep -m1 ';')"
else
  ok "no semicolon"
fi
# Contractions, straight or curly apostrophe. A possessive ("Mike's") is not a
# contraction, so the pronoun forms of 's are listed rather than matched wide.
CONTRACTION="([a-z](n['’]t|['’](re|ll|ve|d|m))\b|\b(it|that|there|what|here|he|she|who|let)['’]s\b)"
if printf '%s' "$PROSE" | grep -qiE "$CONTRACTION"; then
  no "no contractions" "$(printf '%s' "$PROSE" | grep -oiE -m1 "$CONTRACTION")"
else
  ok "no contractions"
fi

# ── 3. Nothing a session loads restates a rule ───────────────────────────────
echo
echo "no loaded file restates a rule:"
# The needles: every rule title from the source, plus the tokens that only a
# rule list carries. An empty extraction would pass every absence check below,
# so it fails closed instead.
NEEDLES="$(printf '%s\n' "$BODY" | sed -n 's/^[0-9][0-9]*\. \*\*\(.*\)\*\*.*/\1/p')"
NEEDLES="$(printf '%s\n%s\n' "$NEEDLES" 'AskUserQuestion
Open questions
🔹
Verify before you assert
label by fact
Behavioral overrides
Guardrails')"
if [ "$(printf '%s\n' "$NEEDLES" | grep -c .)" -lt 10 ]; then
  echo "FAIL: extracted fewer than ten rule titles from $STYLE"; exit 1
fi

# guardrails.md was the rubric for the define-soul and define-profile interviews.
# All three were retired together on 2026-09-27: the output style is the only
# persona, and a second copy of the rules kept drifting from it.
for retired in references/behavioral-overrides.md references/guardrails-inline.md \
               references/guardrails.md skills/define-soul skills/define-profile \
               assets/templates; do
  if [ -e "$ROOT/$retired" ]; then no "$retired is gone" "it still ships"; else ok "$retired is gone"; fi
done

SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/home/.claude" "$SANDBOX/memory/identity" "$SANDBOX/cache" "$SANDBOX/cwd"
# Seed the old system-overrides.md as it shipped, so the check sees the file the
# warmup rewrites rather than an absent one it leaves alone.
printf '# Agent identity\n\n1. **Lead with the answer.**\n' > "$SANDBOX/home/.claude/system-overrides.md"

run() { # source
  (cd "$SANDBOX/cwd" && unset CLAUDE_CODE_AGENT && printf '{"source":"%s"}' "$1" | \
    HOME="$SANDBOX/home" WORKBENCH_MEMORY_PATH="$SANDBOX/memory" \
    WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" WORKBENCH_MEMORY_PORT=1 \
    CLAUDE_PLUGIN_ROOT="$ROOT" bash "$WARMUP" 2>/dev/null)
}

free_of_rules() { # desc, text
  local hit=""
  while IFS= read -r needle; do
    [ -n "$needle" ] || continue
    if printf '%s' "$2" | grep -qF -- "$needle"; then hit="$needle"; break; fi
  done <<< "$NEEDLES"
  if [ -z "$hit" ]; then ok "$1"; else no "$1" "restates: $hit"; fi
}

for src in startup clear compact resume; do
  free_of_rules "warmup stdout on $src carries no rule" "$(run "$src")"
done
free_of_rules "managed CLAUDE.md carries no rule" "$(cat "$SANDBOX/home/.claude/CLAUDE.md" 2>/dev/null)"
free_of_rules "system-overrides.md carries no rule" "$(cat "$SANDBOX/home/.claude/system-overrides.md" 2>/dev/null)"
STUB="$(find "$SANDBOX/home/.claude/projects" -name MEMORY.md 2>/dev/null | head -1)"
if [ -n "$STUB" ]; then
  free_of_rules "memory router stub carries no rule" "$(cat "$STUB")"
else
  no "memory router stub carries no rule" "the warmup wrote no stub to check"
fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
