#!/usr/bin/env bash
#
# agent-dispatch-gate: PreToolUse gate on the Agent tool that denies a MAIN-agent
# sub-agent dispatch whose prompt does not use the five-slot brief, and attaches
# an advisory note when a brief dictates method instead of outcome.
#
# The rule already existed in prose and drifted anyway, which is the same story
# delegation-gate.sh tells. This hook is the harness-level backstop for the
# handoff itself rather than for the file write at the other end.
#
# WHAT THIS GATE CHECKS, AND WHAT IT DELIBERATELY DOES NOT
#
# It checks ONE thing: are the five slot headers present. That is a structural
# question a shell script can answer exactly. It is not a judgement about
# whether the work is code work, and not a judgement about whether `Goal:`
# states an outcome rather than a numbered script. Both of those are questions
# about substance, and they belong to the agent that receives the brief.
#
# That split was not a style preference. Three prompt-classifying heuristics
# were built and measured against 14 days of real dispatches (97 main-agent
# dispatches to generic sub-agents, 19 of which genuinely wrote source):
#
#   narrow   6 fired,  5 right,  1 wrong, 14 missed   83% precision, 26% recall
#   medium  39 fired, 13 right, 26 wrong,  6 missed   33% precision, 68% recall
#   broad   47 fired, 16 right, 31 wrong,  3 missed   34% precision, 84% recall
#
# The wrong ones were not tunable. They were prose tasks that name source files
# without writing them ("read gt7_optimize.py, then fix only the Markdown") and
# read-only audits that name every file they inspect. Separating those needs the
# write-target-versus-read-target distinction, which is semantic. A structural
# check has no false-positive problem at all, which is why it replaced them.
#
# Because the check is structural, it applies to EVERY dispatch from the main
# session, research included. That universality is load-bearing: it is precisely
# what removes the need to guess which dispatches are code work.
#
# `Context:` presence is required; its VALUE is never inspected. The plugin that
# owns the brief has since settled that `Constraints:` may read "none" and
# `Context:` may not, and that rule is enforced by the receiving agent. This gate
# deliberately encodes neither answer: header presence is true under both, so a
# future reversal needs no change here.
#
# No length is enforced, anywhere. A brief carrying a prose `Context:` slot runs
# long by design; measured median is 4,788 characters. A ceiling would deny
# essentially every well-formed brief.
#
# The main-vs-sub-agent signal is the payload itself, verified empirically
# against a logging-only hook on Claude Code 2.1.260 and reused verbatim from
# delegation-gate.sh:
#
#   main agent (interactive or `claude -p`)  agent_id absent, agent_type absent
#   sub-agent (Agent tool)                   agent_id present, agent_type present
#   top-level `claude -p --agent <name>`     agent_id ABSENT, agent_type present
#
# Row three is why agent_type alone must allow. It is also what exempts the
# review-lens fan-out: an agent session runs its own blind lenses as top-level
# dispatches, 422 of them in the same 14 days, and every one carries agent_type.
#
# Escape hatches match delegation-gate.sh exactly, so one mental model covers
# both: WORKBENCH_ORCHESTRATOR=0 in the environment, and the per-session state
# file written by /workbench-core:orchestrator off. The gate is ON by default.
#
# Fail-open by design. A malformed payload, a missing jq, an absent prompt, or a
# session id that cannot address a state file all exit 0. A guard that errors
# must never brick a session. The cost is real and documented in the README:
# when this script breaks, enforcement stops silently.
#
# Exit 0 with no output = allow (normal permission flow applies).
# Exit 0 with permissionDecision "deny" = the harness refuses the call.
# Exit 0 with additionalContext and NO permissionDecision = allow, with a note.
#   Omitting permissionDecision is deliberate: the harness only touches
#   permission behaviour when that key is present (verified against the 2.1.263
#   binary), so the hint path cannot silently grant a permission the call would
#   otherwise have had to ask for.

set -u

PAYLOAD=""
if [ ! -t 0 ]; then
  PAYLOAD=$(cat)
fi
[ -n "$PAYLOAD" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

# Joined on US (0x1f), never on a tab. Bash treats space, tab, and newline in
# IFS as "IFS whitespace" and collapses runs of them, so a tab-separated record
# whose first fields are empty — exactly the main-agent case this gate exists
# for — silently shifts every value one slot left. US is not IFS whitespace, so
# empty leading fields survive. No hook payload field can contain it.
FIELDS=$(printf '%s' "$PAYLOAD" | jq -r '
  [ (.agent_id // "" | tostring),
    (.agent_type // "" | tostring),
    (.tool_name // "" | tostring),
    (.session_id // "" | tostring) ] | join("\u001f")' 2>/dev/null) || exit 0
IFS=$'\x1f' read -r AGENT_ID AGENT_TYPE TOOL_NAME SESSION_ID <<<"$FIELDS"

# (a) A sub-agent dispatching its own helper is not the main session. This is
#     the branch that keeps a review fan-out working.
[ -n "$AGENT_ID" ] && exit 0

# (b) A `claude -p --agent <name>` dispatch is top-level in its own session and
#     has no agent_id. Scheduled pipelines and agent sessions both land here.
[ -n "$AGENT_TYPE" ] && exit 0

# (c) Environment escape hatch, for a harness that runs headless and cannot
#     answer a deny. Core-namespaced on purpose: core must not learn the name of
#     any plugin that opts out through it.
[ "${WORKBENCH_ORCHESTRATOR:-}" = "0" ] && exit 0

# (d) The human asked for an inline exception this session. Shared with
#     delegation-gate.sh: one toggle stands both gates down, so the human never
#     has to remember which gate refused them.
#
#     A session_id that is absent, or that holds anything outside
#     [A-Za-z0-9._-], cannot address a state file. The toggle is then
#     unreachable from inside the session, so the gate has no honest escape
#     hatch and stands down rather than trapping the human. The character class
#     also keeps a "../" from walking out of the state dir.
STATE_DIR="${WORKBENCH_ORCHESTRATOR_STATE_DIR:-${HOME:-}/.claude-workbench/orchestrator-mode}"
case "$SESSION_ID" in
  '' | *[!A-Za-z0-9._-]*) exit 0 ;;
  *) [ -e "$STATE_DIR/$SESSION_ID" ] && exit 0 ;;
esac

# (e) Defensive: the hooks.json matcher should already scope this.
[ "$TOOL_NAME" = "Agent" ] || exit 0

PROMPT=$(printf '%s' "$PAYLOAD" | jq -r '
  .tool_input.prompt // "" | if type == "string" then . else "" end' 2>/dev/null) || exit 0

# (f) No prompt to judge. Fail open rather than deny on a payload shape this
#     gate does not understand.
#
#     grep, not "${PROMPT//[[:space:]]/}". Bash pattern-substitution over a
#     multi-kilobyte string is quadratic: measured on real briefs, 5.7 KB took
#     10s, 6.9 KB took 18s, and 8.0 KB took 29s. A brief's measured median is
#     4,788 characters, so the expansion form stalled essentially every dispatch
#     for tens of seconds. grep streams and stays flat. The same rule is why the
#     fixed-shape check below anchors with grep instead of trimming in bash.
printf '%s' "$PROMPT" | grep -q '[^[:space:]]' || exit 0

# (g) Fixed machine-built dispatch shapes. These are assembled by a script from
#     a board id or a repo slug, not composed by an orchestrator, so there is no
#     brief to write and an unscoped rule would kill the run at its first
#     dispatch.
#
#       Item ID: <n>              workbench-dev-team bin/dispatch-agent.sh:98
#       Repo sweep: <owner/repo>  workbench-dev-team bin/dispatch-agent.sh:94
#       Process pending session summary.
#                                 workbench-core skills/process-pending-summaries
#
#     The first two are named in the interface contract, and each is the WHOLE
#     prompt at its source — so each is matched whole, anchored at both ends.
#     Matching a leading line instead would let any brief bypass the gate by
#     opening with "Item ID: 12" and continuing in free prose.
#
#     The third is core's own memory pipeline: a fixed preamble followed by
#     key/value lines, so it is the one shape matched on its opening line.
#     Omitting it would make this gate break the plugin that ships it.
#     "Whole prompt" is expressed to grep as: the file has exactly one
#     non-blank line, and that line is the shape. `grep -c` counts the non-blank
#     lines, so a second line of free prose defeats the exemption without any
#     trimming of the prompt in bash.
NONBLANK=$(printf '%s' "$PROMPT" | grep -c '[^[:space:]]')
if [ "${NONBLANK:-0}" -eq 1 ]; then
  printf '%s' "$PROMPT" | grep -qE '^[[:space:]]*Item ID:[[:space:]]*[0-9]+[[:space:]]*$' && exit 0
  printf '%s' "$PROMPT" | grep -qE '^[[:space:]]*Repo sweep:[[:space:]]*[^[:space:]/]+/[^[:space:]/]+[[:space:]]*$' && exit 0
fi
#     The summary-writer shape keeps its opening-line semantics: it is a fixed
#     preamble followed by key/value lines, so only line 1 is consulted. Reading
#     the whole prompt would exempt any brief that quoted the sentinel anywhere.
printf '%s' "$PROMPT" | head -n 1 | grep -qE '^[[:space:]]*Process pending session summary\.' && exit 0

# The five slots. Presence only: a header at the start of a line, case
# insensitive, with flexible spacing inside "Done when". Slot ORDER is not
# checked — a brief carrying all five in a different order still uses the
# template, and refusing it would cost a real dispatch for no gain.
MISSING=""
add_missing() { MISSING="${MISSING:+$MISSING, }$1"; }
printf '%s' "$PROMPT" | grep -qiE '^[[:space:]]*Repo:'             || add_missing "Repo:"
printf '%s' "$PROMPT" | grep -qiE '^[[:space:]]*Goal:'             || add_missing "Goal:"
printf '%s' "$PROMPT" | grep -qiE '^[[:space:]]*Context:'          || add_missing "Context:"
printf '%s' "$PROMPT" | grep -qiE '^[[:space:]]*Constraints:'      || add_missing "Constraints:"
printf '%s' "$PROMPT" | grep -qiE '^[[:space:]]*Done[[:space:]]+when:' || add_missing "Done when:"

# A plugin that owns the brief gets named, but only when one is installed. A
# runtime directory probe, never a build-time dependency, so core stays agnostic
# either way. The wording names the team rather than one agent: routing to the
# right specialist covers triage and review as well as development.
PLUGIN_LINE=""
for candidate in "${HOME:-}"/.claude/plugins/cache/*/workbench-dev-team; do
  [ -d "$candidate" ] || continue
  PLUGIN_LINE=" The dev-team specialists and the brief they expect are in /workbench-dev-team:orchestrate."
  break
done

if [ -n "$MISSING" ]; then
  REASON="🚦 Dispatch gate: every Agent dispatch from the main session uses the five-slot brief, research included. Missing: ${MISSING}. Slots: Repo: (absolute path), Goal: (one or two sentences), Context: (why the task exists, and what the agent cannot derive), Constraints: (hard limits, or none), Done when: (observable finish line). Add the missing slots and dispatch again.${PLUGIN_LINE} To dispatch without the brief in this session, run /workbench-core:orchestrator off."
  jq -nc --arg reason "$REASON" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
fi

# The brief is well formed. The remaining check is advisory and NEVER blocks:
# over-specified method wastes the sub-agent's judgement, but it does not break
# anything the way a missing slot does. Measured across 70 real briefs: fenced
# blocks 40%, three-or-more numbered steps 51%. A marker that common cannot sit
# behind a refusal, so it sits behind a note instead.
#
# Line-anchored on purpose. A shell command matched anywhere in the text fires
# on 91% of briefs, including prose that merely mentions `git log`, which is a
# note nobody would read twice.
MARKERS=""
add_marker() { MARKERS="${MARKERS:+$MARKERS, }$1"; }
printf '%s' "$PROMPT" | grep -qE '^[[:space:]]*```' && add_marker "a fenced code block"
# The command list deliberately omits `go`, `make`, `sh`, and `touch`. Each is
# an ordinary English word that opens a sentence, and "make sure the suite is
# green" or "touch only these files" are both real brief lines. A hint that
# fires on those gets ignored, and an ignored hint is worse than none.
printf '%s' "$PROMPT" | grep -qE '^[[:space:]]*(\$[[:space:]]+)?(git|gh|npm|npx|yarn|pnpm|composer|php|python3?|pytest|cargo|rustc|bash|zsh|sed|awk|grep|rg|jq|cp|mv|rm|mkdir|chmod|ln|curl|docker)[[:space:]]+[^[:space:]]' \
  && add_marker "a shell command on its own line"
STEPS=$(printf '%s' "$PROMPT" | grep -cE '^[[:space:]]{0,3}[0-9]+[.)][[:space:]]+[^[:space:]]')
[ "${STEPS:-0}" -ge 3 ] && add_marker "$STEPS numbered steps"

[ -n "$MARKERS" ] || exit 0

HINT="📐 Dispatch hint (advisory, nothing was blocked): this brief carries ${MARKERS}. A brief states the outcome and lets the sub-agent pick the method. The sub-agent has the repo in front of it and you do not. Prefer moving that detail into Done when: as an observable result, or into Constraints: as a hard limit. Send it as-is if the detail is genuinely a constraint rather than a recipe."

jq -nc --arg c "$HINT" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    additionalContext: $c
  }
}'
