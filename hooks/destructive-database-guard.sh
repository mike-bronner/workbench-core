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
# A PreToolUse hook returning permissionDecision "deny" refuses the call outright:
# no allow rule and no permission mode reaches it, and bypassPermissions does not
# get through it either. That is deliberate. An agent has no routine reason to
# destroy a database. When a reset is genuinely needed, the human runs it with the
# ! prefix.
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
# reads, so it is ONE line naming the action that was gated. `additionalContext`
# survives a deny and arrives in its own block, which only the model reads, so
# the checker's finding and the recovery advice live there. Nothing is cut; it
# stops being in the human's way.
#
# NO MARKDOWN EMPHASIS, ANYWHERE. Whether a client renders the reason as Markdown
# is unsettled, and the model receives the raw source either way. So emphasis is
# carried by POSITION — the action leads the line — and by backticks, which read
# as a quoted command whether or not they are rendered.
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
# ONE EXCEPTION, AND IT IS THE READ CEILING: a command longer than the checker's
# MAX_INPUT is refused. An unparseable command is one the checker read and could
# not understand; a truncated one is text it never saw, and the db:wipe can be
# in the part it never saw. Until 2026-09-21 the two were indistinguishable, and
# 200KB of padding in front of `php artisan migrate:fresh` turned this deny into
# silence.
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

# One label covers every finding on exit 1, because every one of them is the
# same action: this guard blocks nothing else. The checker's sentence — which
# command, which target, which flag — is the detail, and detail is the model's
# half of the split.
#
# Exit 2 is the one finding that is NOT that action. The command was longer than
# the checker's read ceiling, so it was never read and nothing here knows what
# it does. Telling the human "destroying a database" there would send them
# hunting for a db:wipe that may not exist, so the ceiling gets its own line.
LABEL='destroying a database'
[ "$STATUS" = "2" ] && LABEL='a command too long for the database guard to read'

if { [ "$STATUS" = "1" ] || [ "$STATUS" = "2" ]; } && [ -n "$REASON" ]; then
  jq -nc \
    --arg reason "🛑 Blocked: $LABEL. Run it yourself with the ! prefix if you meant it." \
    --arg context "Destructive-database guard (workbench-core). $REASON Nothing an agent does should destroy a database, and there is no flag to clear and no path around this. If this reset is genuinely needed, it is the human who runs it, with the ! prefix. Read-only inspection is untouched." '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason,
      additionalContext: $context
    }
  }'
fi

exit 0
