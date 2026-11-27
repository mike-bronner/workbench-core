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
#   1. The source holds the approved rule set: the numbered rules, three
#      habits of shape, and the verify line. Each keeps the anchor that makes it
#      that rule.
#   2. The source obeys its own register. A literal model imitates the text it
#      reads, so a rule file that breaks a rule teaches the break.
#   3. Nothing the warmup writes or prints, and none of the workbench sections
#      the hooks module puts in the system prompt, restates a rule. The needles
#      are DERIVED from the source's own rule titles, so a new or renamed rule
#      is covered without editing this file.

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
if [ "$RULE_COUNT" -eq 15 ]; then
  ok "exactly fifteen numbered rules"
else
  no "exactly fifteen numbered rules" "found $RULE_COUNT"
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
has "rule 4 leaves no question in prose"            'never leave one in prose'
has "rule 4 checks before it asks"                  'Before each `AskUserQuestion` call, verify the facts in every option, and confirm that the prompt, the repo, the vault and the docs cannot answer the question'
has "rule 4 puts the context above the call"        'context the question needs in prose immediately above the call, in the same message'
has "rule 4 lets a question that carries it all stand alone" 'A question that carries all of it needs no prose above it'
has "rule 4 fits a question with no fixed choices"  'no fixed choices still fits the tool, because the dialog always offers Other'
has "rule 4 renders every option it leans on"       'needs it in the prose right above the call: every option the question names, with its grade and your recommendation'
has "rule 4 includes a sub-agent's options"         'options a sub-agent handed back, because Mike never sees the hand-back'
has "rule 4 names options in plain words"           "label names what the option does in plain words, never only a letter or \"Option N\""
has "rule 5 requires a verdict and a recommendation" 'verdict and a recommendation'
has "rule 5 keeps \"no action needed\" a verdict"   'No action needed" is a valid verdict'
has "rule 6 limits options to a real fork"          'real fork that Mike has not decided'
has "rule 6 keeps options before irreversible acts" 'outward-facing or irreversible action'
has "rule 6 exempts commits and pushes from options" 'Commits and ordinary pushes are the exception'
has "rule 6 asks one approval question"             'one approval question, not three options'
has "rule 6 points at the session commit rules"     'The commit rules in the session.s system prompt \("Commits and code comments"\) say when a request or a pick approves one, and what to ask'
has "rule 6 makes a branch sync no fork"            'How to sync a branch with its own remote is no fork, and the same rules give its steps'
has "rule 6 asks each approval alone"               'Ask each such question through `AskUserQuestion`, on its own'
has "rule 6 runs a commit and a feature-branch merge with no question" 'A commit, and a local merge or a pull that does not rebase onto a feature branch, gets no question at all: run it'
has "rule 6 commits a sub-agent's tree with no question" 'A tree a sub-agent hands back commits with no question, and a plain push of a feature branch needs none'
has "rule 6 frees a default-branch push of green commits" 'A plain push of the default branch needs none either when every commit it sends was made from the exact tree a green `Final suite run:` saw'
has "rule 6 lets a sub-agent commit and push after green" 'A sub-agent may run that commit and push itself after the green run, and nobody runs the full suite just to commit'
has "rule 6 never takes a prompt as the approval"    'A permission prompt is never the approval, because a prompt that appears mid-flow gets answered without a review'
has "rule 6 keeps the Index pipeline silent"        'An Index pipeline run never asks to commit or push'
if grep -qF '## Commits and code comments' "$ROOT/hooks/mods/prompt-rules.ts"; then
  ok "the section rule 6 points at is in the system prompt"
else
  no "the section rule 6 points at is in the system prompt" "hooks/mods/prompt-rules.ts has no Commits and code comments section"
fi
# Rule 6 renders options as one table, because three headings with pros and
# cons ran 25 to 30 rows and pushed the recommendation off Mike's screen.
has "rule 6 keeps three options"                    'give options, give three'
has "rule 6 renders the options as one table"       'in one table with the columns Option, Pros, Cons, and Grade'
has "rule 6 keeps the table to 80 columns"          'the table fits 80 columns'
has "rule 6 puts the recommendation after the table" 'After the table, one or two sentences name your recommendation'
has "rule 6 sends the pick to the tool"             'If Mike must pick, ask through `AskUserQuestion`'
has "rule 6 favours correctness"                    'favours correctness over speed'
has "rule 6 recommends running an approved step"    "When a step needs Mike's approval and you can run it, ask him for the decision and recommend the option where you run the step"
has "rule 6 hands Mike only steps for his hands"    'Hand Mike only the steps that need his hands, such as a password, a browser consent or a one-time code'
has "rule 6 names the callback sign-ins"            'Some CLI sign-ins wait for a browser callback, such as `gh auth login` or `gcloud auth login`'
has "rule 6 starts a sign-in in a visible tab"      'Start such a sign-in in a visible Terminal tab, not in background Bash'
has "rule 6 gives the reason for the visible tab"   'In background Bash, the sign-in can miss its callback and save no credentials, so the next step fails'
has "rule 6 reads the sign-in success line"         "Read the sign-in's success line in the tab before you run the next step"
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
has "rule 9 leads every heading and status line"    'An emoji leads every section heading and every status line'
has "rule 9 names five status emoji"                'A status line takes one of these five: - ✅ done or passing - ❌ failed or blocked - 🟡 a risk, or a caveat that changes what Mike does - ⏳ waiting or still running - 👉 a step Mike must take'
has "rule 9 keeps emoji out of table cells"         'Keep emoji out of table cells'
has "rule 10 adopts the register, not the identity" 'adopt the register and never the identity'
# Rule 11 is the density rule. Mike's largest past problem with agents was
# outward prose too dense for a normal person to follow. It is stated rather
# than checked, because a deny on a judgement call breeds workarounds.
has "rule 11 writes outward prose for a tired reader" '11\. \*\*Write outward prose for a tired reader'
has "rule 11 says only what the reader needs to act" 'Say only what they need to act'
has "rule 11 asks for short paragraphs and plain words" 'short paragraphs and plain words'
has "rule 11 bans restated context"                 'Do not restate context'
has "rule 11 aims at one pass"                      'get the point in one pass'
# A reader sees only the text in front of them. Mike set this on 2026-10-07:
# outward prose never points at a plan, a scratchpad file, or a vault note for
# content, and hooks/mods/outbound-prose.ts refuses a gh body that does.
has "rule 11 restates what the reader needs"        'The reader sees only that text, so restate in it what they need'
has "rule 11 bans pointing at an unseen file"       'Never point at a file they cannot open from where they read, such as a plan, a scratchpad file, or a vault note'
has "rule 11 keeps a path the reader acts on"       'A path may still appear as a location the reader acts on, such as a file the change edits or a command to run'
has "rule 11 never lets a path stand in for content" 'It never stands in for content the reader needs to understand the point'
has "rule 11 covers commit bodies and messages"     'a commit body and a message to another session'
# Rule 12 is the screen budget. Mike reads at 80 by 50, and a reply that
# outruns the screen scrolls away the very text a decision depends on.
has "rule 12 fits a reply on one screen"            '12\. \*\*Fit a terminal reply on one screen'
has "rule 12 sets the row budget at 80 columns"     'about 40 rows at that width'
has "rule 12 wins over rules 3, 5 and 15"           'This budget wins over rules 3, 5 and 15: restate each finding, reason, caveat or risk in one line, not a block'
has "rule 12 allows one table at most"              'Use one table at most per reply'
has "rule 12 keeps a caveat that changes the act"   'Give a caveat only when it changes what Mike does'
has "rule 12 bans a recap block"                    'Write no recap and no "what changed" block'
has "rule 12 never drops what Mike acts on"         'The budget never drops a decision, a question or a command Mike must run'
# A question goes right after its context, not held for the end with that
# context restated. Mike set this on 2026-10-06. A verdict can still close.
has "rule 12 asks right after the context appears"  'Ask each question right after the context it depends on first appears'
has "rule 12 does not hold the question for the end" 'Do not hold it for the end of the reply and restate that context there'
has "rule 12 lets a verdict still close the reply"  'A verdict with no question can still close the reply'
has "rule 12 bans pointing at text not restated"    'Never refer to earlier text that the reply does not restate'
has "rule 12 shows every command Mike must run"     'Show every command Mike must run in full, in a bash block in the closing reply or in backticks inside the `AskUserQuestion` text'
has "rule 12 keeps a command out of mid-turn text"  'Never leave it only in mid-turn text, because text written before the end of a turn can reach him cut down or folded'
has "rule 12 bans a positional pointer at a command" 'Never point at a command or a step by its position, such as "listed above" or "the steps earlier"\. Repeat it in the reply instead'
has "rule 12 bans pointing at an unseen file"       'Never point at a file for content the reply does not show'
has "rule 12 shows a proposed commit message"       'Show a proposed commit message or body in the reply itself, not the name of the scratch file that holds it'
has "rule 12 keeps a path Mike acts on"             'A path still fits as a location Mike acts on'
has "rule 13 holds one point of view"                 '13\. \*\*Hold one point of view in a reply'
has "rule 13 fixes I and you in a reply"              'In a terminal reply, "I" means you, the agent, and "you" means Mike'
has "rule 13 bans Mike or he for the addressee"       'Never call him "Mike" or "he" while you address him'
has "rule 13 bans you for the agent"                  'Never use "you" for yourself'
has "rule 13 re-voices relayed text"                  'Hook text, skill text and sub-agent reports each speak from their own point of view. Re-voice each one before you pass it on'
has "rule 13 credits another agent by name"           'Credit work another agent did to that agent by name'
has "rule 13 bans we and names the actor"             'Do not use "we" in a reply, because it hides who acted. Name the actor instead'
has "rule 13 keeps I out of outward prose"            'Outward prose, such as a pull request, an issue, a commit or a message, avoids "I". Use neutral phrasing there'
has "rule 13 keeps rule 10"                           'That keeps rule 10'
has "rule 13 anchors with a right and wrong pair"     'Wrong: "I fixed the gate, so Mike can merge\." Right: "Watson fixed the gate, so you can merge\."'
has "rule 13 holds the frame in a dialog"             'An `AskUserQuestion` dialog uses the same frame as a reply, with "I" as you and "you" as Mike'
has "rule 13 covers question, labels and descriptions" 'This holds for the question, every option label and every description'
has "rule 13 keeps the picker voice out of a label"   'A label does not take the voice of the person who picks it'
has "rule 13 makes each label name its actor"         'Each label names its actor, so it reads right when Mike sees it alone'
has "rule 13 anchors a dialog label pair"             'Wrong: "You run it" for an update that you run, beside "I run it myself" for one that Mike runs\. Right: "I run the update" and "You run it with the ! prefix"\.'
has "rule 14 shows the result, not the work"          '14\. \*\*Show the result, not the work'
has "rule 14 leaves the work out by default"          'By default, leave code, diffs, command lines, logs and step-by-step working-out out of a reply'
has "rule 14 gives the result, verdict and reason"    'Give the result, the verdict and the reason instead'
has "rule 14 keeps the work in tool calls and thinking" 'The work stays in the tool calls and the thinking\. Claude Code folds both, and Mike opens them with Ctrl\+O'
has "rule 14 says nothing in a reply folds"           'Nothing in a reply can fold'
has "rule 14 bans a details block"                    'shows as raw text in the terminal, so never use one'
has "rule 14 points at the folded output when it helps" 'When it helps, say in one short line that the detail is in the folded tool output'
has "rule 14 shows the work when Mike asks"           '- Mike asks to see it\.'
has "rule 14 shows what is being decided on"          'The content is the thing being decided on'
has "rule 14 keeps the proposed commit message"       'It is a proposed commit message \(rule 12\)'
has "rule 14 shows a command Mike must run"           'It is a command Mike must run \(rule 12\)'
has "rule 14 keeps a quoted line as evidence"         'a short quoted line that is itself the evidence'
has "rule 14 keeps output asked for in full"          'It is output Mike asked for in full \(rule 12\)'
has "rule 15 restates what Mike cannot see"           '15\. \*\*Restate what Mike cannot see'
has "rule 15 states that Mike sees only the reply"    'Mike sees only the text of your reply'
has "rule 15 names every unseen source"               "He never sees a sub-agent's hand-back, a message from a peer session, a task notification, or the output of a tool call"
has "rule 15 counts folded tool output as unseen"     'Tool output is folded \(rule 14\), so it counts as unseen too'
has "rule 15 restates what a decision or finding needs" 'When a decision or a finding needs anything from it, restate that in the reply: the finding, its reason, the test results, the risks, and each option with its grade'
has "rule 15 bans a pointer at the source alone"      'Never point at it by its source alone'
has "rule 15 keeps each restatement to one line"      'Keep each to one line or one table row \(rule 12\)'
has "the table habit is stated"                     'three or more comparable items in a table, and use one table at most'
has "the caveat habit is stated, and is not a hedge" 'honest caveat only when it changes what Mike does.{0,60}It is not a hedge'
has "the synthesis habit is stated"                 'Synthesize sub-agent output'
has "the close is a verdict, not a summary"         'Close with the verdict, not a summary'
has "the style shows a reply in the target shape"   'A reply in the target shape'

echo
echo "the sample reply keeps the rules it shows:"
SAMPLE="$(printf '%s\n' "$BODY" | awk '/^````markdown$/ {on = 1; next} on && /^````$/ {exit} on')"
SAMPLE_ROWS="$(printf '%s\n' "$SAMPLE" | grep -c '')"
if [ -n "$SAMPLE" ] && [ "$SAMPLE_ROWS" -le 40 ]; then
  ok "the sample fits the 40-row budget ($SAMPLE_ROWS rows)"
else
  no "the sample fits the 40-row budget" "found ${SAMPLE_ROWS} rows, or no sample"
fi
if printf '%s\n' "$SAMPLE" | head -1 | grep -qE '^(✅|❌|🟡|⏳|👉) '; then
  ok "the sample leads with a status line"
else
  no "the sample leads with a status line" "$(printf '%s\n' "$SAMPLE" | head -1)"
fi
BARE_HEADING="$(printf '%s\n' "$SAMPLE" | grep -E '^#+ ' | grep -vE '^#+ [^A-Za-z0-9 ]')"
if [ -n "$SAMPLE" ] && printf '%s\n' "$SAMPLE" | grep -qE '^#+ ' && [ -z "$BARE_HEADING" ]; then
  ok "every sample heading leads with an emoji"
else
  no "every sample heading leads with an emoji" "no heading, or: $BARE_HEADING"
fi
BARE_STATUS="$(printf '%s\n' "$SAMPLE" | grep -E '^- ' | grep -vE '^- (✅|❌|🟡|⏳|👉) ')"
if [ -n "$SAMPLE" ] && printf '%s\n' "$SAMPLE" | grep -qE '^- ' && [ -z "$BARE_STATUS" ]; then
  ok "every sample status line leads with a status emoji"
else
  no "every sample status line leads with a status emoji" "no status line, or: $BARE_STATUS"
fi
if [ "$(printf '%s\n' "$SAMPLE" | grep -cE '^\|[ :-]*-[ :|-]*\|$')" -le 1 ]; then
  ok "the sample holds one table at most"
else
  no "the sample holds one table at most" "more than one table"
fi
if printf '%s\n' "$SAMPLE" | grep -qiE 'what changed|recap|summary'; then
  no "the sample has no recap block" "$(printf '%s\n' "$SAMPLE" | grep -iE -m1 'what changed|recap|summary')"
else
  ok "the sample has no recap block"
fi

# The cuts Mike approved stay cut. Each needle is the phrase that carried the
# retired rule, so its return is a regression rather than a rewording.
echo
echo "the retired rules stay retired:"
lacks() { # desc, extended-regex
  if printf '%s' "$FLAT" | grep -qiE -- "$2"; then no "$1" "found: $2"; else ok "$1"; fi
}
lacks "no three options before every change" 'three options and a recommendation before making changes'
lacks "no typed request refused as approval" 'typed "commit it"[^.]*(does not|no longer) count'
lacks "no hard 20-word sentence cap"         '20 words'
lacks "no emoji at the same density"         'same density'
lacks "no drift test"                        'drift test'
lacks "no delegate-by-default rule"          'delegate'
lacks "no reason that outranks brevity"     'outranks brevity'
lacks "no question held for the end"         'item Mike acts on comes last'
lacks "no question restated to stand alone"  'stands on its own, so it restates'
lacks "no heading per option"               '### 🔹 Option'
lacks "no permission prompt as the approval" 'because the approval gate prompts'
lacks "no prose fallback for questions"     'Open questions'
lacks "no caveat wherever one exists"       'caveat wherever one exists'

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
  (cd "$SANDBOX/cwd" && unset CLAUDE_CODE_AGENT CLAUDE_CONFIG_DIR && printf '{"source":"%s"}' "$1" | \
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
mkdir -p "$SANDBOX/home/.claude/output-styles"
{ cat "$STYLE"; printf 'STALE-CANARY\n'; } > "$SANDBOX/home/.claude/output-styles/clear.md"
DRIFT_OUT="$(run startup)"
if printf '%s' "$DRIFT_OUT" | grep -qF "Stale output style"; then
  ok "a stale live style puts its notice on stdout"
else
  no "a stale live style puts its notice on stdout" "stdout lacks the notice"
fi
free_of_rules "the stale-style notice on stdout carries no rule" "$DRIFT_OUT"
rm -rf "$SANDBOX/home/.claude/output-styles"
if [ -e "$SANDBOX/home/.claude/CLAUDE.md" ]; then
  no "the warmup writes no CLAUDE.md" "it wrote $SANDBOX/home/.claude/CLAUDE.md"
else
  ok "the warmup writes no CLAUDE.md"
fi
free_of_rules "system-overrides.md carries no rule" "$(cat "$SANDBOX/home/.claude/system-overrides.md" 2>/dev/null)"
if [ -n "$(find "$SANDBOX/home/.claude/projects" -name MEMORY.md 2>/dev/null | head -1)" ]; then
  no "the warmup writes no memory router stub" "it wrote one"
else
  ok "the warmup writes no memory router stub"
fi
# The workbench rules the system prompt carries (gates, scratch roots, memory
# routing) reach every agent, sub-agents included, so they hold no output-style
# rule either. The needles are read against the whole source file.
PROMPT_RULES="$ROOT/hooks/mods/prompt-rules.ts"
if [ -r "$PROMPT_RULES" ]; then
  free_of_rules "the system-prompt sections carry no rule" "$(cat "$PROMPT_RULES")"
else
  no "the system-prompt sections carry no rule" "unreadable: $PROMPT_RULES"
fi

echo
echo "the memory routing makes the vault the hand-off store:"
ROUTING="$(awk '/^export const MEMORY = `/ {on = 1} on {print} on && /`$/ && !/^export const MEMORY = `/ {exit}' "$PROMPT_RULES" | sed 's/\\`/`/g' | tr '\n' ' ')"
routes() { # desc, fixed string
  if printf '%s' "$ROUTING" | grep -qF -- "$2"; then ok "$1"; else no "$1" "the routing lacks: $2"; fi
}
routes "a resumable task gets a progress note right away" 'When a task may be resumed by another or a later session (multi-step work, a challenge, an investigation in progress, or facts derived from files, recordings or sessions), `write` one progress note right away'
routes "the progress note is kept current"                'Keep it current as the task moves'
routes "the progress note carries sources and tags"      'Give it `sources:` and `[^id]` footnotes per the sources rule below.'
routes "a child note names its hub in parent:"           "give the child note \`parent:\` with the hub's vault path, such as \`parent: progress/<hub>.md\`."
routes "an ended task updates its hub note"               'Set `task_status: ended` when the task ends, and in the same step update any parent or hub progress note the task belongs to'
routes "every note carries labelled sources"              'every vault note carries a `sources:` list in its frontmatter whenever any source can be named'
routes "each source is one entry"                         'Give one entry each in the OKF shape `{id, title, resource}`'
routes "two or more sources tag every fact"               'With two or more sources, end each fact with the OKF footnote `[^id]` of its source'
routes "a task with history is searched before re-deriving" 'Before you re-derive anything on a task that has history, `search` the vault for it'
routes "a peer session is not a store"                    "A peer session's context is not a store"
routes "a message coordinates and the vault stores"       'A message coordinates, and the vault stores.'

echo
echo "every statement of the commit approval rule leaves commits and feature-branch merges free:"
DENIED='nothing approved is denied|no request or pick approved is denied|no typed request and no pick is denied'
for source in "$ROOT/README.md" "$ROOT/hooks/mods/prompt-rules.ts"; do
  stated="$(grep -cE "$DENIED" "$source")"
  gated="$(grep -E "$DENIED" "$source" | grep -cE 'a commit outside a ledger unit worktree|a local merge or pull that lands a unit branch')"
  if [ "$stated" -gt 0 ] && [ "$gated" -eq 0 ]; then
    ok "${source#"$ROOT"/} denies no commit and no unit landing in any of its $stated statements"
  else
    no "${source#"$ROOT"/} denies no commit and no unit landing in any statement" "$gated of $stated statements still deny one"
  fi
  if grep -qE '[Ee]very (main-session )?\\?`git commit\\?` runs with no question' "$source" && ! grep -qE 'counts as a commit in every tree|Ask the commit question alone|brings back the commit question' "$source"; then
    ok "${source#"$ROOT"/} says every main-session commit runs with no question, and asks no commit question"
  else
    no "${source#"$ROOT"/} says every main-session commit runs with no question, and asks no commit question" "no statement of the free commit, or a stale commit question"
  fi
  if grep -qE 'onto a feature branch runs with no question, whatever it merges' "$source"; then
    ok "${source#"$ROOT"/} says a local merge or pull onto a feature branch runs with no question, a unit landing included"
  else
    no "${source#"$ROOT"/} says a local merge or pull onto a feature branch runs with no question, a unit landing included" "no statement of the free feature-branch merge"
  fi
  if grep -qE 'own upstream.{0,250}\\?`git pull origin main\\?`' "$source" && ! grep -qF 'stays a merge and needs a merge approval' "$source"; then
    ok "${source#"$ROOT"/} says a catch-up of the default branch from its own upstream runs with no question"
  else
    no "${source#"$ROOT"/} says a catch-up of the default branch from its own upstream runs with no question" "no statement of the default-branch catch-up, or the old rule that every merge into it asks"
  fi
  if grep -qE 'run \\?`git fetch --all\\?`, then \\?`git pull\\?`, then \\?`git push\\?`, each as a line of its own' "$source" \
    && grep -qE 'ask which way to sync' "$source" \
    && grep -qE '(Never rebase to sync a branch, and never run|A rebase and a hand-run) \\?`git merge origin/<branch>\\?`' "$source" \
    && grep -qE '(covers only a branch and its own remote|covers a branch and its own remote only)' "$source"; then
    ok "${source#"$ROOT"/} says a branch syncs with its own remote by fetch --all, pull and push, never a rebase or a hand-run merge"
  else
    no "${source#"$ROOT"/} says a branch syncs with its own remote by fetch --all, pull and push, never a rebase or a hand-run merge" "no statement of the three sync steps, the no-question rule, the rebase and merge ban, or its scope"
  fi
  if grep -qE 'pull\\?`? that does not rebase runs with no question on a feature branch, and on the default branch only when it is the catch-up' "$source" \
    && ! grep -qE 'The fetch and the pull run with no question|\\?`git pull\\?` runs with no question on a feature branch' "$source"; then
    ok "${source#"$ROOT"/} frees only a sync pull that does not rebase, and on the default branch only the catch-up"
  else
    no "${source#"$ROOT"/} frees only a sync pull that does not rebase, and on the default branch only the catch-up" "no limit on the free pull, or the old claim that every pull runs with no question"
  fi
  if grep -qE "A sub-agent's \\\\?\`git merge\\\\?\` or \\\\?\`git pull\\\\?\` that may make a commit (is refused whatever it merges|gets the commit guard's sub-agent refusal)" "$source"; then
    ok "${source#"$ROOT"/} says a sub-agent's merge that makes a commit is refused whatever it merges"
  else
    no "${source#"$ROOT"/} says a sub-agent's merge that makes a commit is refused whatever it merges" "no statement of the sub-agent merge rule"
  fi
done
if grep -qF 'A catch-up is a merge, never a rebase' "$ROOT/README.md" \
  && grep -qF 'A pull with `--rebase` in any value but `false`, or `-r`, is no catch-up, and neither is a plain pull when `branch.<name>.rebase`, or else `pull.rebase`, is set to anything but a false value.' "$ROOT/README.md"; then
  ok "README.md says a pull that would rebase is never a catch-up"
else
  no "README.md says a pull that would rebase is never a catch-up" "no statement that a rebasing pull, by option or by config, is no catch-up"
fi
if grep -qF "On any branch, such a pull, one whose rebase config the gate cannot read, and one whose directory it cannot place without \\\`--no-rebase\\\` is a history rewrite and asks." "$ROOT/hooks/mods/prompt-rules.ts" \
  && grep -qF 'One that also merges into the default branch needs a merge pick first and then a pick of its line, each asked alone.' "$ROOT/hooks/mods/prompt-rules.ts" \
  && grep -qF '**A pull that would rebase is a history rewrite.**' "$ROOT/README.md" \
  && grep -qF 'A config it cannot read counts as a rebase too' "$ROOT/README.md" \
  && grep -qF 'counts as a rebase unless it carries `--no-rebase`' "$ROOT/README.md" \
  && grep -qF 'A pull into the default branch that would rebase is never the catch-up, so it asks both the merge and the history rewrite.' "$ROOT/README.md" \
  && grep -qF 'A unit-landing pull that would rebase asks only the history rewrite.' "$ROOT/README.md" \
  && grep -qF 'a `git pull` that would rebase, in Mike' "$ROOT/README.md" \
  && ! grep -qE 'keeps that question alone|keeps its merge question alone|On a feature branch, a pull that would rebase is a history rewrite' "$ROOT/README.md"; then
  ok "README.md and the commit rules say a pull that would rebase, on any branch or in an unplaced directory, asks as a history rewrite beside its merge"
else
  no "README.md and the commit rules say a pull that would rebase, on any branch or in an unplaced directory, asks as a history rewrite beside its merge" "no statement of the rebase pull on every branch, the unplaced directory, the two picks, or its place in the rewrite list"
fi
if grep -qF '**The merge gate guards against mistakes, not against evasion**' "$ROOT/README.md" \
  && grep -qF 'a second name for a unit tip, made with `git branch x unit/a` or `git tag t unit/a`, and a merge of that name' "$ROOT/README.md" \
  && grep -qF 'a remote, added on an earlier line, that points at the repository itself' "$ROOT/README.md"; then
  ok "README.md scopes the merge gate to mistakes and names the alias and self-remote routes"
else
  no "README.md scopes the merge gate to mistakes and names the alias and self-remote routes" "no scope statement, or a route left out"
fi
if grep -qF '**A history rewrite writes or replaces commits.**' "$ROOT/README.md" \
  && grep -qF '**A branch reset moves a branch pointer and replaces no commit.**' "$ROOT/README.md" \
  && grep -qF '**A remote-tracking ref update changes only refs under `refs/remotes/`.**' "$ROOT/README.md" \
  && grep -qF 'say whether the old tip stays reachable from another ref' "$ROOT/hooks/mods/prompt-rules.ts" \
  && grep -qF 'say whether the old tip stays reachable from another ref' "$ROOT/hooks/mods/commit-approval.ts" \
  && grep -qF 'so they run with no question on a line of their own. Beside a merge or pull, a fetch with any option or refspec makes that merge or pull no catch-up.' "$ROOT/hooks/mods/prompt-rules.ts" \
  && grep -qF 'an assignment or a wrapper such as \`env\` in front of it, a \`git config\` or \`git remote\` write or an \`export\` on its line' "$ROOT/hooks/mods/prompt-rules.ts" \
  && grep -qF 'with an assignment such as `HOME=`, `XDG_CONFIG_HOME=` or a `GIT_` variable, or a wrapper such as `env`' "$ROOT/README.md" \
  && ! grep -qF 'a branch, fetch or push that moves a ref' "$ROOT/hooks/mods/prompt-rules.ts" \
  && ! grep -qE 'are history rewrites\.|\(a push and a rewrite\)' "$ROOT/README.md"; then
  ok "README.md, the commit rules and the gate call a history rewrite, a branch reset and a remote-tracking ref update each by its own name"
else
  no "README.md, the commit rules and the gate call a history rewrite, a branch reset and a remote-tracking ref update each by its own name" "a term is missing, or the old wording that calls a ref move a history rewrite is back"
fi
lacks "rule 6 leaves the approval policy to the system prompt" 'ledger|catch-up merge|history rewrite|gh alias set|approves the actions it names|His answer is the approval|A plan file needs no question'
lacks "rule 6 asks no commit question" 'Without that green run, the tree is work Mike did not ask to commit|A commit, a push, a merge into the default branch or a release gets one approval question'

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
