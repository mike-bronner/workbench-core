#!/bin/bash
# Tests for outbound-prose-guard.sh. Run directly: ./test-outbound-prose-guard.sh
# The guard is a PreToolUse hook that blocks prose leaving the machine when it
# breaks the mechanical rules of the Clear standard. It covers `gh` pull request,
# issue, and release bodies plus the same text posted through a project board MCP.
#
# The allow cases carry the weight here. A style gate that blocks a legitimate
# body is worse than one that misses a violation, so every exemption the guard
# claims (code spans, checklist boilerplate, bot regions, unparseable commands)
# gets a test that goes red if the exemption stops working.

set -u
GUARD="$(cd "$(dirname "$0")" && pwd)/outbound-prose-guard.sh"
PASS=0
FAIL=0
SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT
STDERR="$SANDBOX/stderr"

# Prose that satisfies every mechanical rule: emoji present, no em dash, no
# semicolon, every sentence under twenty words, no paragraph past six sentences.
CLEAN='🐛 Fixed the list loader.

The form now reads stored values on edit. Saving keeps them.'

run_bash() {
  local cmd="$1"
  jq -cn --arg c "$cmd" --arg d "$SANDBOX" \
    '{tool_name:"Bash", cwd:$d, tool_input:{command:$c}}' \
    | bash "$GUARD" 2>"$STDERR"
}

run_mcp() {
  local tool="$1" json="$2"
  jq -cn --arg t "$tool" --argjson i "$json" \
    '{tool_name:$t, cwd:".", tool_input:$i}' \
    | bash "$GUARD" 2>"$STDERR"
}

assert_blocked() {
  local desc="$1"
  shift
  if "$@"; [ "$?" -eq 2 ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc (expected block, exit 2)"
  fi
}

assert_allowed() {
  local desc="$1"
  shift
  if "$@"; [ "$?" -eq 0 ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc (expected allow, exit 0)"
    sed 's/^/       /' "$STDERR"
  fi
}

assert_names() {
  local desc="$1" needle="$2"
  if grep -q "$needle" "$STDERR"; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc (stderr never mentions '$needle')"
  fi
}

echo "commands that carry no prose are never touched:"
assert_allowed "gh pr view"          run_bash 'gh pr view 21665 --json body'
assert_allowed "gh pr merge"         run_bash 'gh pr merge 21665 --squash'
assert_allowed "gh pr edit, label only" run_bash 'gh pr edit 21665 --add-label bug'
assert_allowed "a command without gh" run_bash 'git commit -m "fix: something"'
assert_allowed "an empty body"       run_bash 'gh pr comment 1 --body ""'

echo
echo "prose that meets the standard passes:"
assert_allowed "clean pr body"       run_bash "gh pr create --title t --body $(printf '%q' "$CLEAN")"
assert_allowed "clean issue comment" run_bash "gh issue comment 5 -b $(printf '%q' "$CLEAN")"

echo
echo "each rule blocks on its own:"
assert_blocked "em dash in prose" \
  run_bash 'gh pr comment 1 --body "🐛 The list was never lost — the form never asked."'
assert_names   "the block names the em-dash rule" "em-dash"

assert_blocked "semicolon in prose" \
  run_bash 'gh pr comment 1 --body "🐛 The list was safe; the form never asked."'
assert_names   "the block names the semicolon rule" "semicolon"

assert_blocked "a sentence past twenty words" \
  run_bash 'gh pr comment 1 --body "🐛 Editing a list in the List Manager showed an empty textarea whether the list was created new or upgraded from a rule."'
assert_names   "the block names the sentence-length rule" "long-sent"

assert_blocked "forty words of prose with no emoji" \
  run_bash 'gh pr comment 1 --body "The list itself was never lost. It sat on S3 the whole time. The form did not ask for it. Editing showed a blank box. Saving then failed on validation. No list could be edited at all. Retyping every value was the only path."'
assert_names   "the block names the emoji rule" "no-emoji"

assert_blocked "a paragraph past six sentences" \
  run_bash 'gh pr comment 1 --body "🐛 One broke. Two broke. Three broke. Four broke. Five broke. Six broke. Seven broke."'
assert_names   "the block names the paragraph rule" "long-para"

echo
echo "every surface that carries a body is covered:"
assert_blocked "gh pr create --body" \
  run_bash 'gh pr create --title t --body "🐛 A body with an em dash — right here."'
assert_blocked "gh pr review --body" \
  run_bash 'gh pr review 1 --request-changes --body "🐛 Please fix this — it is wrong."'
assert_blocked "gh issue create --body" \
  run_bash 'gh issue create --title t --body "🐛 A body with an em dash — right here."'
assert_blocked "gh release create --notes" \
  run_bash 'gh release create v1.0 --notes "🐛 Shipped the fix — at last."'
assert_blocked "a project board MCP comment" \
  run_mcp 'mcp__the-index__add_comment' '{"item_id":"PVTI_x","body":"🐛 Bounced — the tests do not discriminate."}'
assert_blocked "a project board MCP review" \
  run_mcp 'mcp__the-index__submit_review' '{"id":"1","event":"REQUEST_CHANGES","body":"🐛 The fix is wrong — see below."}'

echo
echo "identifier fields in an MCP payload are not prose:"
assert_allowed "an id-only payload" \
  run_mcp 'mcp__the-index__move' '{"item_id":"PVTI_x","status":"In Review","url":"https://x.test/a;b"}'
assert_allowed "a clean MCP comment" \
  run_mcp 'mcp__the-index__add_comment' "$(jq -cn --arg b "$CLEAN" '{item_id:"PVTI_x",body:$b}')"

echo
echo "text the author does not control is exempt:"
printf '```php\n$a = 1; $b = 2;\n```\n\n🐛 Both lines run.\n' > "$SANDBOX/fenced.md"
assert_allowed "a semicolon inside a fenced code block" \
  run_bash "gh pr create --title t --body-file $SANDBOX/fenced.md"

printf '🐛 Run `$a = 1;` first.\n' > "$SANDBOX/inline.md"
assert_allowed "a semicolon inside an inline code span" \
  run_bash "gh pr create --title t --body-file $SANDBOX/inline.md"

# Verbatim from decisioncloud's .github/PULL_REQUEST_TEMPLATE.md. Its second
# sentence runs 25 words and carries a semicolon-free but comma-spliced clause,
# so this fixture goes red the moment the checklist exemption stops working.
printf '🐛 Fixed it.\n\n- [ ] I have addressed all GitHub linter comments. Each linter comment must have a resolution description in order to resolve, unless the concern has been addressed, and the comment is marked as "outdated".\n' > "$SANDBOX/checklist.md"
assert_allowed "a long sentence inside a template checklist line" \
  run_bash "gh pr create --title t --body-file $SANDBOX/checklist.md"

printf '🐛 Fixed it.\n\n<!-- This is an auto-generated comment: release notes by coderabbit.ai -->\n\n## Summary by CodeRabbit\n\nImproved list editing — preserves saved values.\n\n<!-- end of auto-generated comment: release notes by coderabbit.ai -->\n' > "$SANDBOX/bot.md"
assert_allowed "an em dash inside a bot-generated region" \
  run_bash "gh pr create --title t --body-file $SANDBOX/bot.md"

echo
echo "unreadable input fails OPEN, never blocking the session:"
assert_allowed "a command substitution body" \
  run_bash 'gh pr create --title t --body "$(cat notes.md)"'
assert_allowed "a body file read from stdin"  run_bash 'gh pr create --title t --body-file -'
assert_allowed "a body file that is missing" run_bash "gh pr create --title t --body-file $SANDBOX/absent.md"
assert_allowed "an unbalanced quote"         run_bash 'gh pr create --body "unclosed'
assert_allowed "a malformed payload"         bash -c 'printf "not json" | bash "'"$GUARD"'" 2>/dev/null'
assert_allowed "an empty payload"            bash -c 'printf "" | bash "'"$GUARD"'" 2>/dev/null'

echo
echo "a real offending body is caught, and a real clean one is not:"
BAD="$SANDBOX/real-bad.md"
printf 'Editing a list in List Manager showed an empty textarea, whether the list was created new or upgraded from an Advanced Lead Rule.\n\nThe list itself was never lost. It was on S3 and read back correctly the whole time — the form just never asked for it.\n' > "$BAD"
assert_blocked "the body from decisioncloud#21665" \
  run_bash "gh pr edit 21665 --body-file $BAD"
assert_names   "it reports the em dash"        "em-dash"
assert_names   "it reports the long sentence"  "long-sent"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
