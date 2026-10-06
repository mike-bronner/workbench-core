#!/usr/bin/env bash
#
# learnings-count.sh <skill> — print how many entries a skill's learnings file
# holds, or nothing when the skill has no learnings file.
#
# hooks/register.ts runs this after each Skill call. A count past 30 goes on
# the status line, so Mike sees which skill is due for
# /workbench-core:compact-learnings. The count used to ride the learnings text
# into model context, with an instruction to tell the user, which spent tokens
# on every such run to deliver a fact the status line now shows for free.
#
# The file is the one hooks/skill-learnings.sh reads: skills/<name>.learnings.md
# in the memory vault, keyed by the bare skill name, so `workbench-core:x` and
# `x` are one skill. A name that is empty, starts with a dot, or holds anything
# but a letter, digit, `.`, `_` or `-` prints nothing, so it cannot leave the
# skills folder.
#
# An entry is a `## ` heading, or a dated bullet (`- **2026-06-11** — …`), the
# two shapes learnings files are written in. Read-only. Always exits 0.

set -u

NAME="${1:-}"
NAME="${NAME##*:}"
case "$NAME" in
  '' | .* | *[!A-Za-z0-9._-]*) exit 0 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/hooks}"
HOOKS_DIR="${HOOKS_DIR:-$(cd "$SCRIPT_DIR/../hooks" && pwd)}"

# shellcheck source=hooks/lib/memory-env.sh
. "$HOOKS_DIR/lib/memory-env.sh" 2>/dev/null || exit 0
FILE="$(memory_resolve_memory_path)/skills/$NAME.learnings.md"
[ -f "$FILE" ] && [ -r "$FILE" ] || exit 0

ENTRIES=$(grep -cE '^## |^- \*\*[0-9]{4}-[0-9]{2}-[0-9]{2}' "$FILE" 2>/dev/null)
echo "${ENTRIES:-0}"
exit 0
