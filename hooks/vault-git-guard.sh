#!/usr/bin/env bash
#
# vault-git-guard: PreToolUse guard that blocks git WRITE commands aimed at the
# memory vault, before the call runs. The vault's git is not the agent's.
#
# It exists because of a real loss of provenance. On 2026-09-04 an agent deleted
# a memory note with `git -C ~/Documents/Claude/Memory rm identity/profile.md`.
# That is a Bash call, so it staged a deletion in the vault's index and stopped.
# But the memory MCP server owns that repository and runs a deferred-commit
# queue over it, so on its next write it swept the staged deletion into commit
# 014f51b1 — whose message reads `write: insights/credential-guard-blocks-prose-
# about-dotenv.md`. A profile deletion is now filed in vault history under a
# message about an unrelated note. Nothing in that commit records what was lost.
#
# The right tool was there the whole time. The memory MCP has `delete`, which
# produces its own accurately-named commit, plus `edit`, `write`, `append`,
# `rename`, and `git_sync`. It went unused because nothing told the agent the
# vault's git was off limits: references/vault-conventions.md ran to 76 lines
# and did not contain the word "git" once. This hook is the enforcing half of
# that gap. The reference document, now carrying a git section, is the
# explaining half — a rule with no incident attached gets relaxed later.
#
# WHY A HOOK AND NOT A DENY RULE:
# A deny rule matches a command PREFIX. `Bash(git rm:*)` would block `git rm` in
# every repository on this machine, which is ordinary work, and would still miss
# the incident: `git -C <path> rm` puts the verb in the fourth slot. The verdict
# here turns on WHICH REPOSITORY the command resolves to, and no prefix rule can
# express that. So the command is tokenised and the target directory resolved —
# through `git -C`, through a leading `cd`, through `--git-dir`/`--work-tree`,
# or from the payload's own cwd — and only a target inside the vault blocks.
#
# READ-ONLY GIT IN THE VAULT STAYS ALLOWED, deliberately and as the priority.
# `git status`, `log`, `show`, `diff`, `ls-files`, `rev-parse`, `blame` and the
# rest are how the incident was investigated in the first place, and a guard
# that broke them would cost more than it saved. The rule set is a BLOCK list:
# anything unlisted passes. Its stated limit, in hooks/lib/vault-git-check.py.
#
# CODE SHARED WITH THE DATABASE GUARD, AND CODE DELIBERATELY NOT:
# The tokeniser, statement splitting, and no-op-prefix stripping live in
# hooks/lib/shell_parse.py, shared with hooks/lib/destructive-db-check.py. The
# verb tables are not shared, and neither is unwrap(): that guard follows a
# command THROUGH `ssh`, because a database on another host is still a database
# being destroyed, while this one STOPS at ssh, because another machine's vault
# is not this vault and judging it could only produce a false block.
#
# FAIL OPEN, matching both existing guards, and for the reason the database
# guard gives rather than the one credential-guard.sh gives: there is no
# adversary here. The threat is a confidently wrong agent, not a crafted
# payload. A command that actually writes to the vault must be valid shell to
# run at all, so it tokenises. Anything unparseable is something bash would
# likely reject too. A command whose target cannot be resolved passes for the
# same reason — guessing at it is how this guard would block an unrelated repo.
#
# WHY THE JSON DENY RATHER THAN exit 2, WHICH THIS GUARD USED TO USE:
# Measured on Claude Code 2.1.274 (insights/2026-09-17-hook-message-channels-
# measured.md in the vault), exit 2 prefixes the model's message with this
# script's absolute filesystem path and silently discards stdout. That is a path
# in a message meant for a person, and it takes the first line away from the
# author. The JSON deny gives both back, and it is the only mechanism that can
# carry additionalContext. Both refuse the call equally hard: no allow rule and
# no permission mode reaches a deny, bypassPermissions included.
#
# THE REFUSAL IS SPLIT ACROSS THE TWO CHANNELS THAT MEASUREMENT FOUND.
# `permissionDecisionReason` becomes the tool_result and is the text a PERSON
# reads, so it is ONE line naming the action that was gated. `additionalContext`
# survives a deny and arrives in its own block, which only the model reads, so
# the vault path, the sweep story, and the list of MCP tools live there. The
# checker supplies both halves: line 1 is the label, line 2 is the detail.
#
# NO MARKDOWN EMPHASIS, ANYWHERE. Whether a client renders the reason as Markdown
# is unsettled, and the model receives the raw source either way. So emphasis is
# carried by POSITION — the action leads the line — and by backticks, which read
# as a quoted command whether or not they are rendered.
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
command -v python3 >/dev/null 2>&1 || exit 0

HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
CHECKER="$HOOKS_DIR/lib/vault-git-check.py"
[ -f "$CHECKER" ] || exit 0

COMMAND=$(printf '%s' "$PAYLOAD" | jq -r '
  if (.tool_name // "") == "Bash"
  then ((.tool_input // {}).command // "") | tostring
  else "" end
  ' 2>/dev/null)
[ -n "$COMMAND" ] || exit 0

# Cheap exit before anything expensive. This hook runs on EVERY Bash call, and
# resolving the vault path costs a config read; a command with no "git" in its
# text cannot invoke git, so it should pay nothing at all. Substring rather than
# word match on purpose: `sudo git`, `/usr/bin/git`, and `bash -c "git …"` all
# have to reach the checker.
case "$COMMAND" in
  *git*) ;;
  *) exit 0 ;;
esac

# The vault's location, resolved exactly the way every other hook resolves it:
# WORKBENCH_MEMORY_PATH → config.json `.memory_path` → the default. Reading it
# here rather than hardcoding is what keeps the guard correct for a user who
# moved their vault.
# shellcheck source=hooks/lib/memory-env.sh
. "$HOOKS_DIR/lib/memory-env.sh" 2>/dev/null || exit 0
memory_load_env 2>/dev/null || exit 0
[ -n "${MEMORY_PATH:-}" ] || exit 0
[ -d "$MEMORY_PATH" ] || exit 0

# The call's working directory. A bare `git commit` acts on whatever repository
# the cwd sits in, so without this the incident's third shape is invisible.
CWD=$(printf '%s' "$PAYLOAD" | jq -r '.cwd // ""' 2>/dev/null)

FINDING=$(printf '%s' "$COMMAND" | python3 "$CHECKER" "$CWD" "$MEMORY_PATH" 2>/dev/null)
STATUS=$?

if [ "$STATUS" = "1" ] && [ -n "$FINDING" ]; then
  # Line 1 is the action label, the rest is the detail. See the checker's
  # docstring for the contract.
  LABEL=${FINDING%%$'\n'*}
  DETAIL=${FINDING#*$'\n'}
  jq -nc \
    --arg reason "🛑 Blocked: $LABEL. Use the memory MCP instead." \
    --arg context "Vault-git guard (workbench-core). $DETAIL The vault's git belongs to the memory server, which commits and pushes on its own deferred queue, so a staged change gets swept into the next unrelated write commit under that write's message. Use the memory MCP instead: delete, edit, write, append, rename, or git_sync to force a sync. Read-only git here is fine." '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason,
      additionalContext: $context
    }
  }'
fi

exit 0
