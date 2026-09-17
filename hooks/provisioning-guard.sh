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
# A PreToolUse hook exiting 2 blocks before permission rules are evaluated, so
# no allow rule and no permission mode reaches it. That is not a stylistic match
# with the sibling guards. A root-cause investigation on 2026-09-11 measured
# that a PreToolUse hook returning permissionDecision "ask" is silently
# auto-approved by the auto-mode classifier, because a hook cannot set
# classifierApprovable. Only a hard block is real. When a worktree or a database
# is genuinely wanted, the human runs the command with the ! prefix, and the
# messages below say so.
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
# Exit codes: 0 = allow (default). 2 = block; stderr is surfaced to the model
# on a blocking PreToolUse hook.

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

# One exit path for every surface, so the banner and the guard's name can never
# drift between them. $1 is the finding, $2 is the advice block.
deny() {
  printf '🛑 Blocked by provisioning-guard: %s\n' "$1" >&2
  printf '%s\n' "$2" >&2
  exit 2
}

case "$TOOL_NAME" in
  EnterWorktree)
    deny "EnterWorktree creates a git worktree and moves this session into it." \
"💡 Work in the directory you were given. The worktrees on this machine are set
   up by hand, and an agent-made one is an orphan tree somebody has to find
   later. If a new worktree is genuinely needed, create it yourself with the !
   prefix and start the session there."
    ;;
  ExitWorktree)
    # "keep" is the ordinary exit and leaves the tree on disk. Only "remove"
    # deletes it, and the field is a required enum, so an absent value is a
    # malformed call rather than a default.
    [ "$ACTION" = "remove" ] || exit 0
    deny "ExitWorktree with action \"remove\" deletes this session's worktree and its branch." \
"💡 Exit with action \"keep\" instead. It leaves the worktree and the branch on
   disk, which costs nothing. Deleting a tree somebody set up by hand is the
   human's call, with the ! prefix."
    ;;
  Agent)
    [ "$ISOLATION" = "worktree" ] || exit 0
    deny "an Agent dispatch with isolation: \"worktree\" makes the harness provision a git worktree for the sub-agent." \
"💡 Dispatch without isolation, so the sub-agent works in the tree you are
   already in. To put it somewhere else, pass cwd with a directory that already
   exists. If the work genuinely needs its own worktree, ask for one and let it
   be created with the ! prefix."
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
REASON=$(printf '%s' "$COMMAND" | python3 "$CHECKER" 2>/dev/null)
STATUS=$?

if [ "$STATUS" = "1" ] && [ -n "$REASON" ]; then
  deny "$REASON" \
"💡 The worktrees and databases on this machine are provisioned by hand, and
   they are the environment you are meant to work inside. If a new one is
   genuinely needed, run the command yourself with the ! prefix. Read-only
   inspection is untouched: git worktree list, psql -c \"SELECT ...\", and
   mysqladmin status all still run."
fi

exit 0
