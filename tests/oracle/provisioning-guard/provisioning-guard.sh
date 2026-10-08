#!/usr/bin/env bash
#
# provisioning-guard: PreToolUse guard that stops an agent from creating a git
# worktree or a database, and from destroying a worktree it did not create,
# before the call runs.
#
# The worktrees and the development databases on this machine are provisioned by
# hand — a Herdr keybinding or a typed `git worktree add`, a typed `createdb`.
# They are the environment an agent is meant to work INSIDE. Agents kept making
# their own instead: a stray `git worktree add`, a `createdb`, a sub-agent
# dispatched with worktree isolation. Each one leaves an orphan tree or an
# orphan database to find and clean up later, and it puts the agent's work
# somewhere nobody was looking.
#
# FOUR SURFACES, BECAUSE BETWEEN THEM THEY ARE EVERY PATH AN AGENT HAS:
#
#   Bash              a shell command that creates a worktree or a database, or
#                     that destroys a worktree. Read by
#                     hooks/lib/provisioning-check.py, which tokenises rather
#                     than prefix-matches.
#   Agent             a dispatch carrying isolation: "worktree", which makes the
#                     harness provision a worktree on the sub-agent's behalf.
#   EnterWorktree     the harness's own tool. It creates a worktree and moves
#                     the session into it.
#   ExitWorktree      only with action "remove", which deletes the worktree the
#                     session is in and its branch. Action "keep" is the
#                     ordinary exit and is untouched.
#
# ExitWorktree is the one surface beyond the four that were specified, and it
# earns its place: with EnterWorktree blocked, the only worktree a session can
# be sitting in is one a human made, so "remove" can only ever destroy a
# hand-provisioned tree. That is the same blast radius as `git worktree remove`,
# which is in scope by an explicit decision. `action` is a required enum on that
# tool with no default, so matching "remove" exactly leaves no silent hole.
#
# WHY A HOOK AND NOT A DENY RULE:
# A deny rule matches a command PREFIX, so `cd /repo && git worktree add x`
# walks straight past one, and so does `psql -c "CREATE DATABASE app"` because
# the verb sits inside a client payload rather than at the front. Worse, two of
# the four surfaces are not Bash calls at all. No permission rule can express
# "an Agent call whose isolation field reads worktree", and none can reach a
# built-in tool's arguments. The same argument is written out at length for
# destruction in hooks/destructive-database-guard.sh and in the `_comment` block
# of assets/permissions/rails.json; this is that argument applied to creation.
#
# HARD BLOCK, NO PROMPT, NO OVERRIDE:
# A PreToolUse hook returning permissionDecision "deny" refuses the call
# outright: no allow rule and no permission mode reaches it, bypassPermissions
# included. That is not a stylistic match with the sibling guards. A root-cause
# investigation on 2026-09-11 measured that a PreToolUse hook returning
# permissionDecision "ask" is silently auto-approved by the auto-mode
# classifier, because a hook cannot set classifierApprovable. Of the three
# verdicts a hook can return, only "deny" binds. When a worktree or a database
# is genuinely wanted, the human runs the command with the ! prefix, and the
# messages below say so.
#
# WHY THE JSON DENY RATHER THAN exit 2, WHICH THIS GUARD USED TO USE:
# Measured on Claude Code 2.1.274 (insights/2026-09-17-hook-message-channels-
# measured.md in the vault), exit 2 prefixes the model's message with this
# script's absolute filesystem path and silently discards stdout. That is a path
# in a message meant for a person, and it takes the first line away from the
# author. The JSON deny gives both back, and it is the only mechanism that can
# carry additionalContext. Both refuse the call equally hard.
#
# THE REFUSAL IS SPLIT ACROSS THE TWO CHANNELS THAT MEASUREMENT FOUND.
# `permissionDecisionReason` becomes the tool_result and is the text a PERSON
# reads, so it is ONE line naming the action that was gated.
# `additionalContext` survives a deny and arrives in its own block, which only
# the model reads, so the advice block lives there. Nothing is cut; it stops
# being in the human's way.
#
# NO MARKDOWN EMPHASIS, ANYWHERE. Whether a client renders the reason as
# Markdown is unsettled, and the model receives the raw source either way. So
# emphasis is carried by POSITION — the action leads the line — and by
# backticks, which read as a quoted command whether or not they are rendered.
#
# TWO EXCLUSIONS, DECIDED DELIBERATELY, NEITHER TO BE WIDENED. SQLite file
# creation stays allowed, because a Laravel migration creates
# database/database.sqlite implicitly and blocking that breaks ordinary test
# runs while protecting nothing. Container and project stack startup stays
# allowed for the same shape of reason: first run provisions a database volume,
# and it is also how an agent starts the environment it is meant to work in.
# Both are argued in full in hooks/lib/provisioning-check.py.
#
# FAIL OPEN, for the reason the sibling guards give rather than the one
# credential-guard.sh gives: there is no adversary here. The threat is a
# confidently wrong agent, not a crafted payload. A command that actually
# creates a worktree must be valid shell to run at all, so it tokenises.
# Anything unparseable is something bash would likely reject too, and blocking
# it would break ordinary quoted one-liners for nothing. A malformed payload, a
# missing jq, a missing python3, or an absent checker all exit 0. As with every
# guard here, this covers Claude's own tool calls and is not an OS boundary —
# `/sandbox` enforces in the kernel, for every subprocess.
#
# ONE EXCEPTION, AND IT IS THE READ CEILING: a command longer than the checker's
# MAX_INPUT is refused. An unparseable command is one the checker read and could
# not understand; a truncated one is text it never saw, and the worktree verb
# can be in the part it never saw. Until 2026-09-21 the two were
# indistinguishable, and 200KB of padding in front of `git worktree add` turned
# this deny into silence.
#
# Exit 0 with no output = allow (default).
# Exit 0 with permissionDecision "deny" = the harness refuses the call.

set -u

PAYLOAD=""
if [ ! -t 0 ]; then
  PAYLOAD=$(cat)
fi
[ -n "$PAYLOAD" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

# Joined on US (0x1f), never on a tab, for the reason measured in
# agent-dispatch-gate.sh: bash collapses runs of IFS whitespace, so a
# tab-separated record whose leading fields are empty silently shifts every
# value one slot left. US is not IFS whitespace, so empty fields survive. No
# hook payload field can contain it.
FIELDS=$(printf '%s' "$PAYLOAD" | jq -r '
  [ (.tool_name // "" | tostring),
    ((.tool_input // {}).isolation // "" | tostring),
    ((.tool_input // {}).action // "" | tostring) ] | join("\u001f")' 2>/dev/null) || exit 0
IFS=$'\x1f' read -r TOOL_NAME ISOLATION ACTION <<<"$FIELDS"

# One exit path for every surface, so the format can never drift between them.
# $1 is the ACTION the human line names, $2 is the one clause that follows it,
# and $3 is the detail the model gets. The guard's own name opens the detail
# rather than the human line: a person needs to know what they did, and only an
# agent needs to know which of nine gates said so.
deny() {
  jq -nc --arg reason "🛑 Blocked: $1. $2" --arg context "Provisioning guard (workbench-core). $3" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason,
      additionalContext: $context
    }
  }'
  exit 0
}

case "$TOOL_NAME" in
  EnterWorktree)
    deny "creating a git worktree" "Work in the directory you were given." \
"EnterWorktree creates a git worktree and moves this session into it. The worktrees on this machine are set up by hand, and an agent-made one is an orphan tree somebody has to find later. If a new worktree is genuinely needed, the human creates it with the ! prefix and starts the session there."
    ;;
  ExitWorktree)
    # "keep" is the ordinary exit and leaves the tree on disk. Only "remove"
    # deletes it, and the field is a required enum, so an absent value is a
    # malformed call rather than a default.
    [ "$ACTION" = "remove" ] || exit 0
    deny "deleting this session's worktree" "Exit with action \"keep\" instead." \
"ExitWorktree with action \"remove\" deletes this session's worktree and its branch. Exit with action \"keep\" instead: it leaves the worktree and the branch on disk, which costs nothing. Deleting a tree somebody set up by hand is the human's call, with the ! prefix."
    ;;
  Agent)
    [ "$ISOLATION" = "worktree" ] || exit 0
    deny "dispatching a sub-agent into its own worktree" "Dispatch without isolation instead." \
"An Agent dispatch with isolation: \"worktree\" makes the harness provision a git worktree for the sub-agent. Dispatch without isolation, so the sub-agent works in the tree you are already in. To put it somewhere else, pass cwd with a directory that already exists. If the work genuinely needs its own worktree, ask for one and let it be created with the ! prefix."
    ;;
  Bash) ;;
  *) exit 0 ;;
esac

COMMAND=$(printf '%s' "$PAYLOAD" | jq -r '
  (.tool_input // {}).command // "" | tostring' 2>/dev/null)
[ -n "$COMMAND" ] || exit 0

# Cheap exit before anything expensive. This hook runs on every Bash call, and
# every rule in the checker needs one of two substrings in the command text:
# "worktree" for the git rules, "create" for createdb, createuser,
# `mysqladmin create`, and CREATE DATABASE/SCHEMA. A command holding neither
# cannot match, so it should not pay for a Python start.
#
# The bracket classes are what make the match case-insensitive without a fork.
# bash 3.2 ships on macOS and has no ${var,,}, and `tr` or `grep -i` would each
# cost the fork this check exists to avoid.
case "$COMMAND" in
  *[cC][rR][eE][aA][tT][eE]* | *[wW][oO][rR][kK][tT][rR][eE][eE]*) ;;
  *) exit 0 ;;
esac

command -v python3 >/dev/null 2>&1 || exit 0
CHECKER="$(cd "$(dirname "$0")" && pwd)/lib/provisioning-check.py"
[ -f "$CHECKER" ] || exit 0

# No working directory is passed, unlike the sibling guards. Their verdict turns
# on which path a command resolves to; this one's never does, and it reads no
# files at all.
FINDING=$(printf '%s' "$COMMAND" | python3 "$CHECKER" 2>/dev/null)
STATUS=$?

if [ "$STATUS" = "1" ] && [ -n "$FINDING" ]; then
  # Line 1 is the action label, the rest is the detail. See the checker's
  # docstring for the contract.
  deny "${FINDING%%$'\n'*}" "Run it yourself with the ! prefix if you meant it." \
"${FINDING#*$'\n'} The worktrees and databases on this machine are provisioned by hand, and they are the environment you are meant to work inside. If a new one is genuinely needed, it is the human who runs the command, with the ! prefix. Read-only inspection is untouched: git worktree list, psql -c \"SELECT ...\", and mysqladmin status all still run."
fi

exit 0
