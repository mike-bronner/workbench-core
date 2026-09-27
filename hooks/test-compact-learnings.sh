#!/bin/bash
# Tests for scripts/find-workbench-skill.sh and its use in
# skills/compact-learnings/SKILL.md. Run directly: ./test-compact-learnings.sh
#
# The skill used to classify a skill by globbing
# ~/.claude/plugins/installed/*claude-workbench*, a directory Claude Code never
# creates. Every skill came back "other", so the integrate path was dead and
# memory-lint's learnings grew to 86 entries against a limit of 30. The cases
# below run the script against a sandbox HOME holding a real-shaped plugin
# registry, so nothing on this machine is read.

set -u
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$HOOKS_DIR/.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/find-workbench-skill.sh"
SKILL="$ROOT_DIR/skills/compact-learnings/SKILL.md"
PASS=0
FAIL=0

SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

HOME_OK="$SANDBOX/home"
CACHE="$HOME_OK/.claude/plugins/cache"
CORE="$CACHE/claude-workbench/workbench-core/1.2.3"
DEVTEAM="$CACHE/claude-workbench/workbench-dev-team/4.5.6"
FOREIGN="$CACHE/other-market/foreign/1.0.0"
mkdir -p "$CORE/skills/memory-lint" "$CORE/.claude-plugin" \
         "$DEVTEAM/skills/develop" "$DEVTEAM/.claude-plugin" \
         "$FOREIGN/skills/weekly-ritual"
touch "$CORE/skills/memory-lint/SKILL.md" "$DEVTEAM/skills/develop/SKILL.md" \
      "$FOREIGN/skills/weekly-ritual/SKILL.md"
echo '{"name":"workbench-core","repository":"https://github.com/example/core"}' \
  > "$CORE/.claude-plugin/plugin.json"
echo '{"name":"workbench-dev-team","repository":{"type":"git","url":"https://github.com/example/dev-team"}}' \
  > "$DEVTEAM/.claude-plugin/plugin.json"
cat > "$HOME_OK/.claude/plugins/installed_plugins.json" <<EOF
{
  "version": 2,
  "plugins": {
    "workbench-core@claude-workbench": [
      {"scope": "user", "installPath": "$CORE", "version": "1.2.3"}
    ],
    "workbench-dev-team@claude-workbench": [
      {"scope": "user", "installPath": "$DEVTEAM", "version": "4.5.6"}
    ],
    "foreign@other-market": [
      {"scope": "user", "installPath": "$FOREIGN", "version": "1.0.0"}
    ]
  }
}
EOF
# The path the old glob searched. A skill placed ONLY here must not count: no
# registry entry points at it, so Claude Code would never load it either.
mkdir -p "$HOME_OK/.claude/plugins/installed/x-claude-workbench/skills/ghost"
touch "$HOME_OK/.claude/plugins/installed/x-claude-workbench/skills/ghost/SKILL.md"

HOME_NONE="$SANDBOX/home-none"
mkdir -p "$HOME_NONE"
HOME_BAD="$SANDBOX/home-bad"
mkdir -p "$HOME_BAD/.claude/plugins"
echo '{not json' > "$HOME_BAD/.claude/plugins/installed_plugins.json"

OUT=""
STATUS=0
# find_skill <home> <skill-name> — sets OUT and STATUS.
find_skill() {
  OUT=$(HOME="$1" bash "$SCRIPT" "$2" 2>/dev/null)
  STATUS=$?
}

check_status() {
  local desc="$1" expected="$2"
  if [ "$STATUS" = "$expected" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected exit $expected, got $STATUS"
  fi
}

check_out() {
  local desc="$1" expected="$2"
  if [ "$OUT" = "$expected" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected [$expected], got [$OUT]"
  fi
}

assert_grep() {
  local desc="$1" needle="$2"
  if grep -qF -- "$needle" "$SKILL"; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — SKILL.md lacks: $needle"
  fi
}

refute_grep() {
  local desc="$1" needle="$2"
  if grep -qF -- "$needle" "$SKILL"; then
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — SKILL.md still has: $needle"
  else
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  fi
}

TAB=$'\t'

echo "finds a workbench plugin skill through the plugin registry:"
find_skill "$HOME_OK" memory-lint
check_status "a workbench-core skill exits 0" 0
check_out "names the plugin, its repository, and the installed SKILL.md" \
  "workbench-core${TAB}https://github.com/example/core${TAB}$CORE/skills/memory-lint/SKILL.md"
find_skill "$HOME_OK" develop
check_status "a skill in a second workbench plugin exits 0" 0
check_out "an object-shaped repository field yields its url" \
  "workbench-dev-team${TAB}https://github.com/example/dev-team${TAB}$DEVTEAM/skills/develop/SKILL.md"
find_skill "$HOME_OK" workbench-core:memory-lint
check_status "a plugin-qualified name finds the same skill" 0

echo "anything else is not a workbench plugin skill:"
find_skill "$HOME_OK" weekly-ritual
check_status "a skill from another marketplace exits 1" 1
check_out "and prints nothing" ""
find_skill "$HOME_OK" never-made
check_status "an unknown skill exits 1" 1
find_skill "$HOME_OK" ghost
check_status "a skill only under the old plugins/installed glob exits 1" 1

echo "an unanswerable question is exit 2, never a silent 'other':"
find_skill "$HOME_NONE" memory-lint
check_status "no registry at all" 2
find_skill "$HOME_BAD" memory-lint
check_status "a malformed registry" 2
find_skill "$HOME_OK" ""
check_status "no skill name" 2
find_skill "$HOME_OK" "../../../etc"
check_status "a name that walks out of skills/" 2

echo "the skill classifies through the script and batches its questions:"
assert_grep "Step 2 runs the registry script" \
  'bash "${CLAUDE_PLUGIN_ROOT}/scripts/find-workbench-skill.sh" {skill-name}'
refute_grep "the dead plugins/installed glob is gone" ".claude/plugins/installed/"
assert_grep "entries are asked through AskUserQuestion" "AskUserQuestion"
assert_grep "questions are batched up to the tool's maximum" "batched up to 4 per call"
assert_grep "integration is handed to Watson" "Dispatch Dr. Watson in Direct mode"
assert_grep "the installed copy is never written" \
  "Never write the installed copy under"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
