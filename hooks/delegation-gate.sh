#!/usr/bin/env bash
#
# delegation-gate: PreToolUse gate on Write|NotebookEdit that denies whole-file
# writes made by the MAIN agent, so the main conversation stays an orchestrator
# and new files are built in sub-agents.
#
# The rule once lived only in prose, as a "delegate by default" guardrail, and
# drifted anyway, twice. This hook is the harness-level backstop. It is
# deliberately agnostic: every install has built-in sub-agents (general-purpose,
# Explore, Plan) reachable through the Agent tool, so the gate always has
# somewhere to send the work, with or without a dev-team plugin present.
#
# EDIT IS NOT GATED, since 2026-09-27. The gates audit that day measured a
# delegated one-line edit at tens of thousands of tokens, against about 200 for
# the same Edit inline. The deny also pushed the model toward `sed -i` and
# heredocs through Bash, which reach the same file past this gate anyway. A
# whole-file Write is where the main context actually grows, so that half of
# the gate stays. The hooks.json matcher no longer sends Edit here, and branch
# (e) below lets it through if anything else does.
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
# default — an absent state file means enforcement. One target is not gated at
# all: a file in a scratchpad, branch (f) below.
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
    (.session_id // "" | tostring),
    ((.tool_input // {}) | (.file_path // .notebook_path // "") | tostring)
  ] | join("\u001f")' 2>/dev/null) || exit 0
IFS=$'\x1f' read -r AGENT_ID AGENT_TYPE TOOL_NAME SESSION_ID FILE_PATH <<<"$FIELDS"

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

# (e) Only a whole-file write is gated. Edit is allowed from the main agent (see
#     the header). The hooks.json matcher should already scope this.
case "$TOOL_NAME" in
  Write | NotebookEdit) ;;
  *) exit 0 ;;
esac

# (f) A scratch file is not file work. CLAUDE.md and the dev-team git-commit
#     skill tell the main session to write a multi-line commit message or a PR
#     body to a file in the scratchpad and pass it with `git commit -F`.
#     Denying that write pushed the model into a heredoc through Bash, or into
#     a sub-agent that spent 54k tokens writing one file. Every real denial in
#     the 30 days before this branch was one of those files.
#
#     The roots are the two scratchpads the destructive-scope guard
#     (hooks/lib/destructive-scope-check.py) already trusts, resolved the same
#     way, and neither comes from anything the caller can set:
#       - this session's scratchpad, matched by session id under
#         /private/tmp/claude-*/ and /tmp/claude-*/, and refused when any level
#         of it is a symlink, because anyone can build a directory of that
#         shape and point it somewhere else;
#       - the login home's Developer/scratchpad, where the home comes from the
#         password database through `~user` expansion, never from $HOME.
#     The target is compared physically: its deepest existing ancestor is
#     resolved with `cd -P`, so `<root>/link/x` and `<root>/../x` cannot pass a
#     prefix test. A target that is itself a symlink is refused, because Write
#     writes through it to wherever it points.
#
#     Everything this cannot settle falls through to the deny below. That is
#     the gate's normal answer, so failing closed here costs nothing new.
physical_dir() {
  [ -d "$1" ] && (cd -P -- "$1" 2>/dev/null && pwd -P)
}

scratch_roots() {
  local candidate real user home
  for candidate in /private/tmp/claude-*/*/"$SESSION_ID"/scratchpad \
                   /tmp/claude-*/*/"$SESSION_ID"/scratchpad; do
    real=$(physical_dir "$candidate") || continue
    [ "$real" = "$candidate" ] && printf '%s\n' "$real"
  done
  user=$(id -un 2>/dev/null)
  case "$user" in
    '' | -* | *[!A-Za-z0-9._-]*) return 0 ;;
  esac
  eval "home=~$user"
  case "$home" in
    /*) physical_dir "$home/Developer/scratchpad" ;;
  esac
  return 0
}

# The physical path the target would land at, or failure when it cannot be
# settled: a relative path, a `.` or `..` component, a target or a missing
# component that is a symlink, or no existing ancestor at all.
physical_target() {
  local dir="${1%/*}" rest="${1##*/}" real
  case "$1" in /*) ;; *) return 1 ;; esac
  case "$rest" in '' | . | ..) return 1 ;; esac
  [ -L "$1" ] && return 1
  while [ -n "$dir" ] && [ ! -d "$dir" ]; do
    [ -L "$dir" ] && return 1
    rest="${dir##*/}/$rest"
    dir="${dir%/*}"
  done
  real=$(physical_dir "${dir:-/}") || return 1
  case "$rest" in */./* | ./* | */../* | ../*) return 1 ;; esac
  printf '%s/%s' "${real%/}" "$rest"
}

if TARGET=$(physical_target "$FILE_PATH"); then
  while IFS= read -r root; do
    [ -n "$root" ] && [ "$root" != "/" ] || continue
    case "$TARGET" in
      "$root"/*) exit 0 ;;
    esac
  done <<<"$(scratch_roots)"
fi

# The human line names the action and stops. The destination, the plugin that
# owns development work, and the escape hatch are all things an agent acts on,
# so they go to the model's channel. A dev-team plugin gets named there when one
# is installed — a runtime directory probe, never a build-time dependency, so
# core stays agnostic either way.
REASON='🛑 Blocked: writing a whole file from the main agent. New files go to a sub-agent.'

CONTEXT='Delegation gate (workbench-core). The main conversation orchestrates and does not write whole files, which is what keeps its context lean. To change part of an existing file, use Edit, which the main agent may call. To create or rewrite a file, dispatch a sub-agent with the Agent tool.'
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
