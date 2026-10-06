#!/usr/bin/env bash
#
# skill-learnings: PreToolUse(Skill) hook that hands a skill its learnings file.
#
# Every skill can accumulate learnings in the vault, at
# skills/<skill-name>.learnings.md: corrections, failures and confirmed
# approaches from past runs. This used to be prose. The warmup told every session
# to read identity/skills-protocol.md, and nine SKILL.md files restated the
# rule in their first line. So the protocol cost a read before every skill, and
# the one limit it stated, 30 entries, was checked by nobody:
# memory-lint.learnings.md reached 86 entries and 68 KB before anyone noticed.
#
# This hook does the mechanical half instead. When the Skill tool is about to
# run, it looks for the skill's learnings file on disk. No file: silent, and no
# cost at all. A file: its text goes to the model as additionalContext, with the
# rule for adding to it.
#
# The 30-entry limit is no longer the model's to report. A file past it used to
# carry a warning here, telling the model to tell the user. The count now goes
# to the status line instead (hooks/register.ts runs scripts/learnings-count.sh
# after each Skill call), where Mike sees it without a token spent.
#
# A file too large for one hook message is not truncated. Claude Code cuts a hook
# output past 10,000 characters, so the tail would be lost silently. The budget
# is measured on the JSON this hook actually prints, not on the file: escaping
# every newline and quote grows the text, and an 8,944-byte file once came out
# at 10,686 characters. Past MAX_OUTPUT the hook sends the file's vault path
# instead, and tells the model to read the whole file through the memory MCP.
#
# Fail open: this hook only adds context, so any error is silence.

set -u

MAX_OUTPUT=9000  # characters of printed JSON, with headroom under 10,000

PAYLOAD=""
if [ ! -t 0 ]; then
  PAYLOAD=$(cat)
fi
[ -n "$PAYLOAD" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

[ "$(printf '%s' "$PAYLOAD" | jq -r '.tool_name // empty' 2>/dev/null)" = "Skill" ] || exit 0
SKILL=$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.skill // empty' 2>/dev/null)

# The file is keyed by the bare skill name: `workbench-core:memory-lint` and
# `memory-lint` both read skills/memory-lint.learnings.md. The name comes from
# the tool call, so it may not leave the skills folder: a name that is empty,
# starts with a dot, or holds anything but a letter, digit, `.`, `_` or `-` is
# not a skill name, and the hook stays silent.
NAME=${SKILL##*:}
case "$NAME" in
  '' | .* | *[!A-Za-z0-9._-]*) exit 0 ;;
esac

HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=hooks/lib/memory-env.sh
. "$HOOKS_DIR/lib/memory-env.sh" 2>/dev/null || exit 0
REL="skills/$NAME.learnings.md"  # vault-relative, as the memory MCP takes it
FILE="$(memory_resolve_memory_path)/$REL"
[ -f "$FILE" ] && [ -r "$FILE" ] || exit 0

RULE="Add to this file only when this run taught something a future run needs: the user corrected the approach, something failed and you learned why, or the user confirmed a non-obvious approach. Append it through the memory MCP as \`## YYYY-MM-DD - short title\` followed by what to do next time. A routine run adds nothing."

emit() { jq -nc --arg c "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$c}}'; }

OUT=$(emit "Learnings for the \`$NAME\` skill, recorded from its past runs at \`$REL\` in the memory vault. Apply them to this run.

$(cat "$FILE")

$RULE")

if [ "${#OUT}" -gt "$MAX_OUTPUT" ]; then
  OUT=$(emit "The \`$NAME\` skill has learnings from its past runs, too large to include here. Read the whole file with the memory MCP \`read\` tool, at the vault path \`$REL\`, before you start, and apply it to this run. $RULE")
fi

printf '%s\n' "$OUT"
exit 0
