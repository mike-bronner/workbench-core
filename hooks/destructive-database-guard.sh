#!/usr/bin/env bash
#
# destructive-database-guard: PreToolUse guard that blocks the shell commands
# which destroy a database — Artisan resets, dropdb, volume-deleting Docker
# commands, ddev/lando/wp-env project teardown, and destructive SQL, whether it
# arrives inline or in a file — before the call runs.
#
# It exists because of a real loss. On 2026-09-04, in an unrelated Laravel repo,
# Claude ran `php artisan db:wipe --database=pgsql --force`, believing `pgsql`
# named the testing database. It does not. phpunit.xml only overrides
# DB_DATABASE=testing inside a test run, so an Artisan command typed at the shell
# resolves `pgsql` against .env — the development database. Every table was
# dropped and several hours of imported data went with them. No permission rule
# matched, so nothing prompted: assets/permissions/rails.json guarded disks, git
# history, and rm, and said nothing at all about databases.
#
# WHY A HOOK AND NOT ONLY A DENY RULE:
# A deny rule matches a command PREFIX. The incident shape was `cd /repo && php
# artisan db:wipe`, where the destructive verb is not at the front, and the same
# command reaches a database through `sail`, `docker compose exec`, `ssh host
# "..."`, and `bash -c "..."`. A prefix rule sees none of those. This hook
# tokenises the command instead, so it reads the verb SLOT. rails.json still
# carries the matching deny rules as the declarative layer, visible in /config —
# the two are belt and braces, not duplicates.
#
# HARD BLOCK, NO PROMPT, NO OVERRIDE:
# A PreToolUse hook exiting 2 blocks before permission rules are evaluated, so no
# allow rule and no permission mode reaches it. That is deliberate. An agent has
# no routine reason to destroy a database. When a reset is genuinely needed, the
# human runs it with the ! prefix.
#
# The exemptions are about scope, not trust. An Artisan reset carrying
# --env=testing or --database=testing is allowed, because rebuilding the testing
# database is ordinary work and the incident was a wrong TARGET rather than a
# wrong verb. A bare `migrate:fresh` still blocks, since bare inherits .env.
# `docker compose down` is allowed for the same kind of reason: it leaves named
# volumes alone, and only the --volumes form destroys the data. The reasoning,
# and the hole in the Artisan exemption, are in hooks/lib/destructive-db-check.py.
#
# FAIL OPEN, for a different reason than credential-guard.sh gives:
# There is no adversary here. The threat is a confidently wrong agent, not a
# crafted payload. A command that actually destroys data has to be valid shell to
# run at all, so it parses. Anything unparseable is something bash would likely
# reject too, and blocking it would break ordinary quoted one-liners for nothing.
# As with credential-guard.sh, this guards Claude's own tool calls and is not an
# OS boundary — `/sandbox` enforces in the kernel, for every subprocess.
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

CHECKER="$(cd "$(dirname "$0")" && pwd)/lib/destructive-db-check.py"
[ -f "$CHECKER" ] || exit 0

COMMAND=$(printf '%s' "$PAYLOAD" | jq -r '
  if (.tool_name // "") == "Bash"
  then ((.tool_input // {}).command // "") | tostring
  else "" end
  ' 2>/dev/null)
[ -n "$COMMAND" ] || exit 0

# The call's working directory, which is what a relative path in the command
# resolves against. `psql -f db/reset.sql` names a file the checker reads, and
# reading the wrong one is how a guard produces a false block. Absent, the
# checker reads no files at all.
CWD=$(printf '%s' "$PAYLOAD" | jq -r '.cwd // ""' 2>/dev/null)

REASON=$(printf '%s' "$COMMAND" | python3 "$CHECKER" "$CWD" 2>/dev/null)
STATUS=$?

if [ "$STATUS" = "1" ] && [ -n "$REASON" ]; then
  printf '🛑 Blocked by destructive-database-guard: %s\n' "$REASON" >&2
  printf '💡 Nothing an agent does should destroy a database. If this reset is\n' >&2
  printf '   genuinely needed, run it yourself with the ! prefix.\n' >&2
  exit 2
fi

exit 0
