#!/usr/bin/env bash
#
# find-workbench-skill.sh — find the installed SKILL.md of a claude-workbench
# plugin skill, for /workbench-core:compact-learnings.
#
# Claude Code records every installed plugin in
# ~/.claude/plugins/installed_plugins.json, keyed "<plugin>@<marketplace>", and
# each entry carries an installPath under ~/.claude/plugins/cache. The skill
# used to glob ~/.claude/plugins/installed/*claude-workbench*, a directory that
# does not exist, so every skill was classed "other" and the integrate path
# never ran. Reading the registry is the only source that says where a plugin
# actually lives.
#
# Usage:
#   find-workbench-skill.sh <skill-name>
#
# Prints one tab-separated line per install that ships the skill:
#   <plugin-name>  <repository URL, or empty>  <absolute SKILL.md path>
#
# Exit status:
#   0  at least one claude-workbench plugin ships the skill
#   1  none does, so the skill is not a workbench plugin skill
#   2  the question cannot be answered: bad argument, no jq, or an unreadable
#      registry. That is NOT "not a workbench skill" — treating it as one is
#      how the old glob hid every skill — so the caller stops and reports.

set -u

NAME="${1:-}"
# A plugin-qualified name ("workbench-core:memory-lint") names the same skill.
NAME="${NAME##*:}"
case "$NAME" in
  '' | . | .. | *[!A-Za-z0-9._-]*)
    echo "find-workbench-skill: usage: find-workbench-skill.sh <skill-name>" >&2
    exit 2 ;;
esac

command -v jq >/dev/null 2>&1 || {
  echo "find-workbench-skill: jq is required to read the plugin registry" >&2
  exit 2
}

REGISTRY="$HOME/.claude/plugins/installed_plugins.json"
PLUGINS=$(jq -r '
  .plugins | to_entries[]
  | select(.key | endswith("@claude-workbench"))
  | (.key | sub("@claude-workbench$"; "")) as $name
  | .value[] | select(.installPath | type == "string")
  | [$name, .installPath] | @tsv' "$REGISTRY" 2>/dev/null) || {
  echo "find-workbench-skill: cannot read the plugin registry at $REGISTRY" >&2
  exit 2
}

FOUND=1
while IFS=$'\t' read -r plugin path; do
  [ -n "$path" ] || continue
  skill="$path/skills/$NAME/SKILL.md"
  [ -f "$skill" ] || continue
  repo=$(jq -r '.repository // "" | if type == "object" then .url // "" else . end' \
    "$path/.claude-plugin/plugin.json" 2>/dev/null)
  printf '%s\t%s\t%s\n' "$plugin" "$repo" "$skill"
  FOUND=0
done <<<"$PLUGINS"

exit "$FOUND"
