#!/usr/bin/env bash
#
# delegation-gate: PreToolUse hook on Write|NotebookEdit that reminds the MAIN
# agent, once per session, to delegate whole-file work to a sub-agent, so the
# main conversation stays an orchestrator.
#
# IT NEVER DENIES, SINCE 2026-10-05. It used to deny every main-agent whole-file
# write outside the scratchpads. Plan mode lets the main agent write exactly one
# file, its plan under ~/.claude/plans/, and the deny refused that write, so plan
# mode was unusable while the gate was on. Mike decided the main agent may write
# a file when it needs to, and that delegation stays advice. So the output
# carries additionalContext and no permission verdict of any kind: the write
# goes through the normal permission flow exactly as it would without this hook.
# An "allow" verdict would skip the permission prompt, which this hook has no
# business granting.
#
# THE REMINDER FIRES AT MOST ONCE PER SESSION. A reminder on every write spends
# tokens on every turn, and cutting tokens is the point of delegating. The first
# reminded write creates a marker file keyed by session id, with noclobber, so
# two writes racing each other still produce one reminder. If the marker cannot
# be created, the hook stays silent rather than risk repeating itself.
#
# It is deliberately agnostic: every install has built-in sub-agents
# (general-purpose, Explore, Plan) reachable through the Agent tool, so the
# reminder always has somewhere to point, with or without a dev-team plugin.
#
# EDIT IS NOT GATED, since 2026-09-27. The gates audit that day measured a
# delegated one-line edit at tens of thousands of tokens, against about 200 for
# the same Edit inline. The old deny also pushed the model toward `sed -i` and
# heredocs through Bash, which reach the same file past this gate anyway. A
# whole-file Write is where the main context actually grows, so that is what
# the reminder is about. The hooks.json matcher does not send Edit here, and
# branch (e) below stays silent if anything else does.
#
# The main-vs-sub-agent signal is the payload itself, verified empirically
# against a logging-only hook on Claude Code 2.1.260:
#
#   main agent (interactive or `claude -p`)  agent_id absent, agent_type absent
#   sub-agent (Task tool)                    agent_id present, agent_type present
#   top-level `claude -p --agent <name>`     agent_id ABSENT, agent_type present
#
# The third row is why agent_type alone stays silent: a scheduled `claude -p
# --agent <name>` pipeline is top-level in its own session and carries no
# agent_id, and a reminder to delegate means nothing to it.
#
# CLAUDE_CODE_CHILD_SESSION is NOT a usable signal — it was "1" in all three
# cases above, including a plain main session.
#
# Silencers, in order of scope: WORKBENCH_ORCHESTRATOR=0 in the environment
# (how an automated harness opts its own run out), and a per-session state file
# written by the /orchestrator off command (hooks/register.ts). The reminder
# is ON by default.
# Two kinds of target never draw it: a file in a scratchpad, and a plan under
# ~/.claude/plans/, branch (f) below.
#
# Fail-silent by design: a malformed payload, a missing jq, an unreadable state
# dir, a session id that cannot address a state file, or a marker that cannot
# be written all exit 0 with no output. The write goes ahead either way, so the
# only cost of a broken hook is a missing reminder.
#
# THE REMINDER GOES TO THE MODEL ONLY. Measured on Claude Code 2.1.274 with a
# probe hook (insights/2026-09-17-hook-message-channels-measured.md in the
# vault): `additionalContext` arrives in its own block, which only the model
# reads. A person has nothing to act on here, so nothing is written for one.
# No Markdown emphasis: the model receives the raw source, so asterisks would
# show up as asterisks.
#
# Exit 0 with no output = allow, silently (normal permission flow applies).
# Exit 0 with additionalContext and NO permissionDecision = allow, with the
# reminder (normal permission flow still applies).

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

# (a) A sub-agent is where the reminder points. Reminding it to delegate would
#     be noise.
[ -n "$AGENT_ID" ] && exit 0

# (b) A `claude -p --agent <name>` dispatch is top-level in its own session and
#     has no agent_id. This is the scheduled-pipeline case.
[ -n "$AGENT_TYPE" ] && exit 0

# (c) Environment silencer, for a harness that runs headless and has no use for
#     the reminder. Core-namespaced on purpose: core must not learn the name of
#     any plugin that opts out through it.
[ "${WORKBENCH_ORCHESTRATOR:-}" = "0" ] && exit 0

# (d) The human turned the reminder off for this session. The key is the
#     payload's session_id, which equals $CLAUDE_CODE_SESSION_ID in Bash tool
#     calls (verified empirically) — that is what lets the toggle skill name
#     the file the gate looks for.
#
#     A session_id that is absent, or that holds anything outside
#     [A-Za-z0-9._-], cannot address a state file, and cannot key the
#     once-per-session marker either, so the hook stays silent. The character
#     class also keeps a "../" from walking out of either dir.
STATE_DIR="${WORKBENCH_ORCHESTRATOR_STATE_DIR:-${HOME:-}/.claude-workbench/orchestrator-mode}"
case "$SESSION_ID" in
  '' | *[!A-Za-z0-9._-]*) exit 0 ;;
  # Off is a regular file that is not a symbolic link, as /orchestrator writes
  # it. A directory or a link planted at the path switches nothing off.
  *) [ -f "$STATE_DIR/$SESSION_ID" ] && [ ! -L "$STATE_DIR/$SESSION_ID" ] && exit 0 ;;
esac

# (e) Only a whole-file write draws the reminder. Edit never does (see the
#     header). The hooks.json matcher should already scope this.
case "$TOOL_NAME" in
  Write | NotebookEdit) ;;
  *) exit 0 ;;
esac

# (f) A scratch file or a plan is not file work, so it draws no reminder.
#     CLAUDE.md and the dev-team git-commit skill tell the main session to write
#     a multi-line commit message or a PR body to a file in the scratchpad and
#     pass it with `git commit -F`. Plan mode writes the session's plan under
#     ~/.claude/plans/, the one file it lets the main agent write. While this
#     gate still denied, those two kinds of file were nearly every denial.
#
#     The roots are the two scratchpads the destructive-scope guard
#     (hooks/lib/destructive-scope-check.py) already trusts, resolved the same
#     way, plus the plans folder. hooks/lib/scratch-roots.sh holds the one
#     resolver, which $.workbench.scratchRoots() in hooks/register.ts runs too,
#     and its header says how each root is found.
#     The target is compared physically: its deepest existing ancestor is
#     resolved with `cd -P`, so `<root>/link/x` and `<root>/../x` cannot pass a
#     prefix test. A target that is itself a symlink is refused, because Write
#     writes through it to wherever it points.
#
#     Everything this cannot settle falls through to the reminder below. The
#     write goes ahead either way, so a wrong answer here costs one reminder.
#     That includes a resolver that cannot be sourced: physical_dir is then
#     undefined, physical_target fails, and the reminder fires.
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hooks/lib/scratch-roots.sh
. "$GATE_DIR/lib/scratch-roots.sh" 2>/dev/null || true

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
  done <<<"$(scratch_roots "$SESSION_ID")"
fi

# Once per session. `set -C` makes the redirect fail when the marker already
# exists, and the create is atomic, so exactly one write per session wins the
# reminder. One file per session, swept after 3 days like the sibling state
# dirs (intake-nudge.sh, memory-scan-recall.sh).
[ -n "${HOME:-}" ] || exit 0
MARK_DIR="$HOME/.claude-workbench/delegation-reminder"
mkdir -p "$MARK_DIR" 2>/dev/null || exit 0
find "$MARK_DIR" -type f -mtime +3 -delete 2>/dev/null
(set -C; : >"$MARK_DIR/$SESSION_ID") 2>/dev/null || exit 0

# A dev-team plugin gets named when one is installed — a runtime directory
# probe, never a build-time dependency, so core stays agnostic either way.
CONTEXT='Delegation reminder (workbench-core, advisory, this write goes ahead). The main conversation orchestrates, and its context stays lean when whole-file work goes to a sub-agent dispatched with the Agent tool. Use Edit for a partial change.'
for candidate in "$HOME"/.claude/plugins/cache/*/workbench-dev-team; do
  [ -d "$candidate" ] || continue
  CONTEXT="$CONTEXT For development work, dispatch Dr. Watson in Direct mode per /workbench-dev-team:orchestrate."
  break
done
CONTEXT="$CONTEXT This reminder shows once per session."

jq -nc --arg context "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    additionalContext: $context
  }
}'
