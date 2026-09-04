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
# Exit codes: 0 = allow (default). 2 = block; stderr is surfaced to the model
# on a blocking PreToolUse hook.

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

REASON=$(printf '%s' "$COMMAND" | python3 "$CHECKER" "$CWD" "$MEMORY_PATH" 2>/dev/null)
STATUS=$?

if [ "$STATUS" = "1" ] && [ -n "$REASON" ]; then
  printf '🛑 Blocked by vault-git-guard: %s\n' "$REASON" >&2
  printf '💡 The vault'"'"'s git belongs to the memory server, which commits and\n' >&2
  printf '   pushes on its own deferred queue. A staged change gets swept into\n' >&2
  printf '   the next unrelated write commit, under that write'"'"'s message.\n' >&2
  printf '   Use the memory MCP instead: delete, edit, write, append, rename,\n' >&2
  printf '   or git_sync to force a sync. Read-only git here is fine.\n' >&2
  exit 2
fi

exit 0
