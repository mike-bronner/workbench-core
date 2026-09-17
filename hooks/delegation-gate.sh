#!/usr/bin/env bash
#
# delegation-gate: PreToolUse gate on Edit|Write|NotebookEdit that denies file
# edits made by the MAIN agent, so the main conversation stays an orchestrator
# and the file work happens in sub-agents.
#
# The rule already existed in prose — guardrail 10, "delegate by default" — and
# drifted anyway, twice. This hook is the harness-level backstop. It is
# deliberately agnostic: every install has built-in sub-agents (general-purpose,
# Explore, Plan) reachable through the Agent tool, so the gate always has
# somewhere to send the work, with or without a dev-team plugin present.
#
# The main-vs-sub-agent signal is the payload itself, verified empirically
# against a logging-only hook on Claude Code 2.1.260:
#
#   main agent (interactive or `claude -p`)  agent_id absent, agent_type absent
#   sub-agent (Task tool)                    agent_id present, agent_type present
#   top-level `claude -p --agent <name>`     agent_id ABSENT, agent_type present
#
# The third row is why agent_type alone must allow: a scheduled `claude -p
# --agent <name>` pipeline is top-level in its own session and carries no
# agent_id. Gating on agent_id alone would kill every scheduled run at its
# first file write.
#
# CLAUDE_CODE_CHILD_SESSION is NOT a usable signal — it was "1" in all three
# cases above, including a plain main session.
#
# Escape hatches, in order of scope: WORKBENCH_ORCHESTRATOR=0 in the
# environment (how an automated harness opts its own run out), and a per-session
# state file written by /workbench-core:orchestrator off. The gate is ON by
# default — an absent state file means enforcement.
#
# Fail-open by design, matching credential-guard.sh: a malformed payload, a
# missing jq, an unreadable state dir, or a session id that cannot address a
# state file all exit 0. A guard that errors must never brick a session. The
# cost is real and is documented in the README: when this script breaks,
# enforcement stops silently, and there is no second layer behind it.
#
# THE REFUSAL IS SPLIT ACROSS THE TWO CHANNELS A HOOK HAS. Measured on Claude
# Code 2.1.274 with a probe hook (insights/2026-09-17-hook-message-channels-
# measured.md in the vault): `permissionDecisionReason` becomes the tool_result
# and is the text a PERSON reads, and `additionalContext` survives a deny and
# arrives in its own block, which only the model reads. So the reason is ONE
# line naming the action that was gated, and every recovery instruction only an
# agent acts on lives in the context instead. Nothing is cut; it stops being in
# the human's way. `systemMessage` is not used: it is the purer human channel,
# but it never reached this user's client at all, so a line written only there
# would land nowhere.
#
# NO MARKDOWN EMPHASIS, ANYWHERE. Whether a client renders the reason as
# Markdown is unsettled, and the model receives the raw source either way. So
# emphasis is carried by POSITION — the action leads the line — and by
# backticks, which read as a quoted command whether or not they are rendered.
# Asterisks would show up as asterisks.
#
# Exit 0 with no output = allow (normal permission flow applies).
# Exit 0 with permissionDecision "deny" = the harness refuses the call.

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

# (a) A sub-agent is the destination this gate redirects to. It must be able to
#     edit, or the gate blocks the very work it asks for.
[ -n "$AGENT_ID" ] && exit 0

# (b) A `claude -p --agent <name>` dispatch is top-level in its own session and
#     has no agent_id. This is the scheduled-pipeline case.
[ -n "$AGENT_TYPE" ] && exit 0

# (c) Environment escape hatch, for a harness that runs headless and cannot
#     answer a deny. Core-namespaced on purpose: core must not learn the name of
#     any plugin that opts out through it.
[ "${WORKBENCH_ORCHESTRATOR:-}" = "0" ] && exit 0

# (d) The human asked for an inline exception this session. The key is the
#     payload's session_id, which equals $CLAUDE_CODE_SESSION_ID in Bash tool
#     calls (verified empirically) — that is what lets the toggle skill name
#     the file the gate looks for.
#
#     A session_id that is absent, or that holds anything outside
#     [A-Za-z0-9._-], cannot address a state file. The toggle is then
#     unreachable from inside the session, so the gate has no honest escape
#     hatch and stands down rather than trapping the human. The character
#     class also keeps a "../" from walking out of the state dir.
STATE_DIR="${WORKBENCH_ORCHESTRATOR_STATE_DIR:-${HOME:-}/.claude-workbench/orchestrator-mode}"
case "$SESSION_ID" in
  '' | *[!A-Za-z0-9._-]*) exit 0 ;;
  *) [ -e "$STATE_DIR/$SESSION_ID" ] && exit 0 ;;
esac

# (e) Defensive: the hooks.json matcher should already scope this.
case "$TOOL_NAME" in
  Edit | Write | NotebookEdit) ;;
  *) exit 0 ;;
esac

# The human line names the action and stops. The destination, the plugin that
# owns development work, and the escape hatch are all things an agent acts on,
# so they go to the model's channel. A dev-team plugin gets named there when one
# is installed — a runtime directory probe, never a build-time dependency, so
# core stays agnostic either way.
REASON='🛑 Blocked: editing a file from the main agent. File work goes to a sub-agent.'

CONTEXT='Delegation gate (workbench-core). The main conversation orchestrates and does not edit files, which is what keeps its context lean. Dispatch a sub-agent with the Agent tool to make this change.'
for candidate in "${HOME:-}"/.claude/plugins/cache/*/workbench-dev-team; do
  [ -d "$candidate" ] || continue
  CONTEXT="$CONTEXT For development work, dispatch Dr. Watson in Direct mode per /workbench-dev-team:orchestrate."
  break
done
CONTEXT="$CONTEXT Report the deny rather than routing around it. Only the human lifts the gate, by asking for /workbench-core:orchestrator off."

jq -nc --arg reason "$REASON" --arg context "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason,
    additionalContext: $context
  }
}'
