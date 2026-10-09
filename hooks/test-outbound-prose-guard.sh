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

# Prose that satisfies both mechanical rules: no em dash and no semicolon.
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

echo
echo "judgement calls are the output style's, never a deny:"
# Emoji, sentence length, and paragraph length were checked here once. A deny on
# a judgement call breeds workarounds: the writer pads in an emoji or chops a
# sentence to pass the count, and the text gets no easier to read. Each fixture
# below used to block, so each goes red if its check comes back.
assert_allowed "a sentence past twenty words" \
  run_bash 'gh pr comment 1 --body "🐛 Editing a list in the List Manager showed an empty textarea whether the list was created new or upgraded from a rule."'
assert_allowed "forty words of prose with no emoji" \
  run_bash 'gh pr comment 1 --body "The list itself was never lost. It sat on S3 the whole time. The form did not ask for it. Editing showed a blank box. Saving then failed on validation. No list could be edited at all. Retyping every value was the only path."'
assert_allowed "a paragraph past six sentences" \
  run_bash 'gh pr comment 1 --body "🐛 One broke. Two broke. Three broke. Four broke. Five broke. Six broke. Seven broke."'

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
echo "a body read from standard input is checked when a heredoc feeds it:"
# The dev-team git-commit skill recommends `--body-file - <<'EOF'`, and this
# guard let every such body through until 2026-10-05. lines joins its arguments
# into one multi-line command, the way the agent sends it.
lines() { printf '%s\n' "$@"; }
assert_blocked "the recommended form, with an em dash and a semicolon" \
  run_bash "$(lines "gh pr comment 1 --body-file - <<'EOF'" '🐛 The list was safe — the form never asked; now it does.' 'EOF')"
assert_names   "the heredoc block names the em-dash rule" "em-dash"
assert_names   "the heredoc block names the semicolon rule" "semicolon"
assert_allowed "the recommended form, with a clean body" \
  run_bash "$(lines "gh pr comment 1 --body-file - <<'EOF'" "$CLEAN" 'EOF')"
assert_blocked "an unquoted delimiter" \
  run_bash "$(lines 'gh pr edit 2 --body-file - <<EOF' '🐛 Fixed it — at last.' 'EOF')"
assert_blocked "a tab-stripping <<- heredoc" \
  run_bash "$(lines 'gh issue comment 3 --body-file - <<-EOF' $'\t🐛 Fixed it — at last.' $'\tEOF')"
assert_blocked "a <<- heredoc with a space before the delimiter" \
  run_bash "$(lines 'gh issue comment 3 --body-file - <<- EOF' '🐛 Fixed it — at last.' 'EOF')"
assert_blocked "-F - on a pr comment" \
  run_bash "$(lines "gh pr comment 1 -F - <<'EOF'" '🐛 Fixed it — at last.' 'EOF')"
assert_blocked "--notes-file - on a release" \
  run_bash "$(lines "gh release create v1.0 --notes-file - <<'EOF'" '🐛 Shipped the fix — at last.' 'EOF')"
assert_blocked "a here-string" \
  run_bash "gh pr comment 1 --body-file - <<< '🐛 Fixed it — at last.'"
assert_blocked "gh api -F body=@-" \
  run_bash "$(lines "gh api repos/o/r/issues/1/comments -F body=@- <<'EOF'" '🐛 Fixed it — at last.' 'EOF')"
assert_blocked "gh api --input -" \
  run_bash "$(lines "gh api repos/o/r/issues/1/comments --input - <<'EOF'" '{"body": "🐛 Fixed it — at last."}' 'EOF')"
# Bodies are matched to their opener in order. A heredoc on an earlier non-gh
# line must take its own body, or the gh line reads the wrong one. Each pair
# goes red if the guard stops consuming bodies for stages that are not gh.
assert_allowed "an earlier heredoc's bad body is not the gh body" \
  run_bash "$(lines 'cat <<EOF >/dev/null' 'Not posted — ever.' 'EOF' "gh pr comment 1 --body-file - <<EOF" "$CLEAN" 'EOF')"
assert_blocked "a bad gh body after an earlier clean heredoc" \
  run_bash "$(lines 'cat <<EOF >/dev/null' "$CLEAN" 'EOF' "gh pr comment 1 --body-file - <<EOF" '🐛 Fixed it — at last.' 'EOF')"
assert_allowed "a heredoc gh never reads, beside a clean --body" \
  run_bash "$(lines "gh pr comment 1 --body 'Fixed it.' <<'EOF'" 'Not posted — ever.' 'EOF')"

echo
echo "a body that points at a file the reader cannot open is refused:"
# Mike set this on 2026-10-07. The reader of a pull request, an issue, or a
# comment sees only that text, so a path to a plan, a scratchpad file, or a
# vault note stands in for content they never get. Each family has a fixture
# of its own, so dropping one pattern from the checker turns one case red.
assert_blocked "a plan file, through a heredoc" \
  run_bash "$(lines "gh pr create --title t --body-file - <<'EOF'" 'Fixed the loader. The full plan is at `~/.claude/plans/loader.md`.' 'EOF')"
assert_names   "the block names the file-pointer rule" "file-pointer"
assert_names   "the reason says to restate the substance" "Restate the substance"
printf 'Fixed the loader.\n\nThe details are in scratchpad/pr-body.md.\n' > "$SANDBOX/bare-scratch.md"
assert_blocked "a bare scratchpad path, through --body-file" \
  run_bash "gh pr edit 1 --body-file $SANDBOX/bare-scratch.md"
assert_names   "the --body-file block names the file-pointer rule" "file-pointer"
assert_blocked "the persistent scratchpad, through --body" \
  run_bash "gh issue comment 5 --body 'Fixed it. Notes in ~/Developer/scratchpad/loader-notes.md.'"
assert_blocked "a session scratchpad, through a here-string" \
  run_bash "gh pr comment 1 --body-file - <<< 'Fixed it. See /private/tmp/claude-503/-Users-mike-x/abc/scratchpad/notes.md.'"
# The guard resolves the vault root through memory-env.sh, which honors
# WORKBENCH_MEMORY_PATH. Each vault case pins that root, so no case passes on
# the strength of this machine's own configured vault.
CUSTOM_VAULT="$SANDBOX/custom-vault"
mkdir -p "$CUSTOM_VAULT/decisions" "$CUSTOM_VAULT/feedback" "$CUSTOM_VAULT/insights"
# A root that cannot be listed, so the checker falls back to the known folders.
NO_VAULT="$SANDBOX/no-vault"
# A listed root with one folder the known set lacks, and none it holds.
ODD_VAULT="$SANDBOX/odd-vault"
mkdir -p "$ODD_VAULT/notebook"
run_bash_vault() {  # run_bash_vault <vault root> <command>
  WORKBENCH_MEMORY_PATH="$1" run_bash "$2"
}
assert_blocked "a vault note named in prose, under a listed root" \
  run_bash_vault "$CUSTOM_VAULT" "gh issue create --title t --body 'Per vault note decisions/2026-10-07-loader.md, the form reads stored values.'"
assert_blocked "a vault note named in prose, when the root cannot be listed" \
  run_bash_vault "$NO_VAULT" "gh issue create --title t --body 'Per vault note feedback/loader.md, the form reads stored values.'"
assert_blocked "a vault note in a folder only the listed root has" \
  run_bash_vault "$ODD_VAULT" "gh pr comment 1 --body 'Per vault note notebook/loader.md, it reads stored values.'"
assert_allowed "a known folder the listed root does not have" \
  run_bash_vault "$ODD_VAULT" "gh pr comment 1 --body 'Per vault note decisions/loader.md, it reads stored values.'"
assert_blocked "a vault note under the default root" \
  run_bash_vault "$CUSTOM_VAULT" "gh pr comment 1 --body 'Fixed it, as /Users/mike/Documents/Claude/Memory/feedback/loader.md asks.'"
assert_blocked "a vault note under a configured vault root" \
  run_bash_vault "$CUSTOM_VAULT" "gh pr comment 1 --body 'Fixed it. Background in $CUSTOM_VAULT/insights/loader.md.'"
assert_blocked "a bare session path in inline code" \
  run_bash "gh pr comment 1 --body 'Fixed it. See \`/private/tmp/claude-503/x/abc/scratchpad/notes.md\`.'"
assert_blocked "an inline-code span that starts with a path, not a command" \
  run_bash "gh pr comment 1 --body 'Fixed it. Run \`~/Developer/scratchpad/fix.sh --all\`.'"
assert_blocked "a plan file in a board MCP comment" \
  run_mcp 'mcp__the-index__add_comment' '{"item_id":"PVTI_x","body":"Bounced. The punch list is in ~/.claude/plans/review.md."}'
assert_blocked "a plan file as a file:// link" \
  run_bash "gh pr comment 1 --body 'Fixed it. [Plan](file:///Users/mike/.claude/plans/x.md).'"
assert_blocked "a scratchpad path in a gh api body" \
  run_bash "gh api repos/o/r/issues/1/comments -f body='Fixed it. Draft at ~/Developer/scratchpad/draft.md.'"

echo
echo "a path the reader acts on, a URL, or a code path still passes:"
# The other direction, and the one that carries the weight. The guard runs on
# every gh call, so a repository path a pull request edits must never block.
REPO_BODY='Fixed the loader in `hooks/lib/prose-check.py` and `src/scratchpad/view.ts`.

Run `bash hooks/test-outbound-prose-guard.sh` to check it. The plan is at https://github.com/o/r/blob/main/.claude/plans/loader.md and in docs/decisions/loader.md.'
assert_allowed "repository paths, a command, and URLs, through a heredoc" \
  run_bash "$(lines "gh pr create --title t --body-file - <<'EOF'" "$REPO_BODY" 'EOF')"
printf '%s\n' "$REPO_BODY" > "$SANDBOX/repo-paths.md"
assert_allowed "repository paths, a command, and URLs, through --body-file" \
  run_bash "gh pr edit 1 --body-file $SANDBOX/repo-paths.md"
assert_allowed "a scratch root named as a place, not a file" \
  run_bash "gh pr comment 1 --body 'Scratch now goes in \`~/Developer/scratchpad\`, and plans stay in ~/.claude/plans/.'"
assert_allowed "the word vault beside a repository path" \
  run_bash "gh pr comment 1 --body 'The vault hooks/mods/vault-git.ts refuses git writes.'"
# "Vault" is also HashiCorp's secret store, and markdown-vault-mcp has repo
# folders that hold vault notes. A path after the word counts only when its
# first folder is one of the vault's own, under a listed root and the fallback.
for root in "$CUSTOM_VAULT" "$NO_VAULT"; do
  for body in 'Store the token in Vault at secret/data/myapp.' \
              'Uses HashiCorp Vault under secret/app.' \
              'Vault: kv/prod holds the key.' \
              'vault: config/vault.php changed' \
              'The vault notes in tests/fixtures/ now load.' \
              'Fixes the vault note at docs/example.md'; do
    assert_allowed "\"$body\" (${root##*/})" \
      run_bash_vault "$root" "gh pr comment 1 --body '$body'"
  done
done
# A command in inline code is a location the reader acts on, even when its
# arguments name a scratch location. Rule 11 allows it, and README says so.
assert_allowed "a mktemp command into the scratchpad" \
  run_bash "gh pr comment 1 --body 'Make scratch with \`mktemp -d ~/Developer/scratchpad/holmes.XXXXXX\`.'"
assert_allowed "a script command writing to the scratchpad" \
  run_bash "gh pr comment 1 --body 'Run \`bash scripts/x.sh ~/Developer/scratchpad/out\` to see it.'"
assert_allowed "a command naming a session scratchpad" \
  run_bash "gh pr comment 1 --body 'Run \`ls /private/tmp/claude-503/x/abc/scratchpad/out\` to see it.'"
assert_allowed "a mktemp command into a session scratchpad" \
  run_bash "gh pr comment 1 --body 'Make scratch with \`mktemp -d /private/tmp/claude-503/x/abc/scratchpad/watson.XXXXXX\`.'"
assert_allowed "git -C into a scratchpad clone" \
  run_bash "gh pr comment 1 --body 'Check it with \`git -C ~/Developer/scratchpad/x status\`.'"

echo
echo "a command span is exempt only for a listed command and a scratch place:"
# The exemption first took any word followed by a space, so each case below
# passed. The first four are Holmes's round 2 rows. The last three each break
# one condition alone: an unlisted first word, a markdown file, a plan path.
assert_blocked "cat on a plan file" \
  run_bash "gh pr comment 1 --body 'Context: \`cat ~/.claude/plans/x.md\`.'"
assert_blocked "an unlisted word before a scratchpad markdown file" \
  run_bash "gh pr comment 1 --body 'Context: \`see ~/Developer/scratchpad/notes.md\`.'"
assert_blocked "a sentence in inline code" \
  run_bash "gh pr comment 1 --body 'Context: \`the plan is at ~/.claude/plans/x.md\`.'"
assert_blocked "open on a vault note" \
  run_bash_vault "$CUSTOM_VAULT" "gh pr comment 1 --body 'Context: \`open ~/Documents/Claude/Memory/decisions/x.md\`.'"
assert_blocked "an unlisted word before a scratchpad folder" \
  run_bash "gh pr comment 1 --body 'Context: \`see ~/Developer/scratchpad/notes\`.'"
assert_blocked "a listed command on a scratchpad markdown file" \
  run_bash "gh pr comment 1 --body 'Context: \`cat ~/Developer/scratchpad/notes.md\`.'"
assert_blocked "a listed command on a plan path with no .md" \
  run_bash "gh pr comment 1 --body 'Context: \`ls ~/.claude/plans/loader\`.'"
assert_blocked "a listed command on a vault path with no .md" \
  run_bash_vault "$CUSTOM_VAULT" "gh pr comment 1 --body 'Context: \`ls $CUSTOM_VAULT/insights/loader\`.'"
# Round 3: only a command that creates or writes the place it names is exempt.
# A reading command points at content, so each of these goes red if a reading
# command rejoins the list or the markdown test loses a spelling.
assert_blocked "cat on a scratchpad text file" \
  run_bash "gh pr comment 1 --body 'Context: \`cat ~/Developer/scratchpad/notes.txt\`.'"
assert_blocked "tail on a background task's output" \
  run_bash "gh pr comment 1 --body 'Context: \`tail /private/tmp/claude-503/p/s/tasks/x.output\`.'"
assert_blocked "a writing command on a .markdown file" \
  run_bash "gh pr comment 1 --body 'Context: \`touch ~/Developer/scratchpad/notes.markdown\`.'"
assert_blocked "a writing command on notes.md with a full stop" \
  run_bash "gh pr comment 1 --body 'Context: \`touch ~/Developer/scratchpad/notes.md.\`'"
assert_blocked "a shell running a script that is itself scratch" \
  run_bash "gh pr comment 1 --body 'Context: \`bash ~/Developer/scratchpad/run.sh\`.'"
assert_blocked "git without -C on a scratchpad path" \
  run_bash "gh pr comment 1 --body 'Context: \`git log ~/Developer/scratchpad/x\`.'"
mkdir -p "$SANDBOX/scratchpad"
printf '%s\n' "$CLEAN" > "$SANDBOX/scratchpad/pr-body.md"
assert_allowed "a clean body read from a scratchpad file" \
  run_bash "gh pr create --title t --body-file $SANDBOX/scratchpad/pr-body.md"
printf 'Fixed it.\n\n```\nError: cannot read /private/tmp/claude-503/x/abc/scratchpad/out.log\n```\n' > "$SANDBOX/fenced-log.md"
assert_allowed "a session path quoted inside a fenced log" \
  run_bash "gh pr comment 1 --body-file $SANDBOX/fenced-log.md"
assert_allowed "a pointer inside an HTML comment no reader sees" \
  run_bash "gh pr comment 1 --body 'Fixed it. <!-- draft: scratchpad/pr-body.md -->'"

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

# Adapted from decisioncloud's .github/PULL_REQUEST_TEMPLATE.md, with a semicolon
# added. Template checklist text is not the author's, so this fixture goes red
# the moment the checklist exemption stops working.
printf '🐛 Fixed it.\n\n- [ ] I have addressed all GitHub linter comments. Each linter comment must have a resolution description; it resolves only then, unless the concern has been addressed, and the comment is marked as "outdated".\n' > "$SANDBOX/checklist.md"
assert_allowed "a semicolon inside a template checklist line" \
  run_bash "gh pr create --title t --body-file $SANDBOX/checklist.md"

printf '🐛 Fixed it.\n\n<!-- This is an auto-generated comment: release notes by coderabbit.ai -->\n\n## Summary by CodeRabbit\n\nImproved list editing — preserves saved values.\n\n<!-- end of auto-generated comment: release notes by coderabbit.ai -->\n' > "$SANDBOX/bot.md"
assert_allowed "an em dash inside a bot-generated region" \
  run_bash "gh pr create --title t --body-file $SANDBOX/bot.md"

echo
echo "unreadable input fails OPEN, never blocking the session:"
assert_allowed "a command substitution body" \
  run_bash 'gh pr create --title t --body "$(cat notes.md)"'
assert_allowed "a body file read from stdin"  run_bash 'gh pr create --title t --body-file -'
# Piped standard input is not in the command text, so it is not read.
assert_allowed "a body piped in from another stage" \
  run_bash "$(printf '%s\n' 'cat <<EOF | gh pr comment 1 --body-file -' 'Not read — piped.' 'EOF')"
assert_allowed "an unterminated heredoc"     run_bash "$(printf '%s\n' "gh pr comment 1 --body-file - <<'EOF'" 'Never closed — so no body.')"
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

echo
echo "a realistically large body is judged quickly:"
# A regression test with teeth. The whitespace pre-check first used
# "${PROSE//[[:space:]]/}", which is quadratic in payload length. Measured end
# to end through this guard, 8 KB took 32.8s and 12 KB took 101.8s. A PreToolUse
# hook holds its tool call open while it runs, so a live session froze behind one
# instance for over three minutes. Size is not a corner case here: the body this
# guard exists to catch, decisioncloud#21665, ran 1,855 words. Restore the
# expansion and this case blows its budget roughly thirtyfold.
BIG="$SANDBOX/big-body.md"
: > "$BIG"
while [ "$(wc -c < "$BIG")" -lt 12000 ]; do
  printf '%s\n\n' 'Editing a list in the List Manager showed an empty textarea — whether the list was new or upgraded.' >> "$BIG"
done
BIG_SIZE=$(wc -c < "$BIG" | tr -d ' ')
START=$(date +%s)
run_bash "gh pr create --title t --body-file $BIG"
BIG_RC=$?
ELAPSED=$(( $(date +%s) - START ))
if [ "$ELAPSED" -le 3 ]; then
  PASS=$((PASS + 1)); echo "  ✅ a ${BIG_SIZE}-byte body is judged in ${ELAPSED}s (budget 3s)"
else
  FAIL=$((FAIL + 1)); echo "  ❌ a ${BIG_SIZE}-byte body took ${ELAPSED}s, over the 3s budget"
fi
# ...and it is still judged correctly, so the budget is not met by bailing out.
if [ "$BIG_RC" -eq 2 ]; then
  PASS=$((PASS + 1)); echo "  ✅ the large body is still blocked, so speed is not early exit"
else
  FAIL=$((FAIL + 1)); echo "  ❌ the large body returned $BIG_RC, so the timing proves nothing"
fi

# The pre-check's other path. Prose short-circuits on its first character, so
# only an all-whitespace payload walks the whole string, and that is the glob's
# worst case. It stays linear there (0.009s at 64 KB) where the expansion did
# not: 4 KB of pure whitespace took 4.6s through this guard before the fix.
WS="$SANDBOX/whitespace-body.md"
: > "$WS"
while [ "$(wc -c < "$WS")" -lt 8000 ]; do
  printf '   \n\t\n' >> "$WS"
done
WS_SIZE=$(wc -c < "$WS" | tr -d ' ')
START=$(date +%s)
run_bash "gh pr create --title t --body-file $WS"
WS_RC=$?
ELAPSED=$(( $(date +%s) - START ))
if [ "$ELAPSED" -le 3 ]; then
  PASS=$((PASS + 1)); echo "  ✅ ${WS_SIZE} bytes of pure whitespace is judged in ${ELAPSED}s (budget 3s)"
else
  FAIL=$((FAIL + 1)); echo "  ❌ ${WS_SIZE} bytes of pure whitespace took ${ELAPSED}s, over the 3s budget"
fi
# Whitespace is not prose, so it never reaches the checker at all.
if [ "$WS_RC" -eq 0 ]; then
  PASS=$((PASS + 1)); echo "  ✅ a whitespace-only body is allowed, never sent to the checker"
else
  FAIL=$((FAIL + 1)); echo "  ❌ a whitespace-only body returned $WS_RC, expected allow"
fi

echo
echo "the emptiness pre-check decides the same thing on every platform:"
# What counts as "whitespace" here is a property of the C library, not only of
# the locale. glibc excludes U+00A0, U+202F and U+2007 from [[:space:]] in every
# locale, Darwin includes them, and the two disagree again with LC_ALL=POSIX on
# U+2028, U+3000 and U+205F. Under [[:space:]] a body of nothing but NBSPs was
# therefore skipped on macOS and checked on Linux. The pre-check now lists the
# six ASCII whitespace characters, so the answer is the same everywhere.
#
# Return code alone cannot see this: the real checker finds nothing in a body of
# Unicode spaces, so skipped and checked both come back 0. These cases run the
# guard against a STUB checker that reports a finding for anything it is given,
# which turns "the checker ran" into an observable block.
STUB="$SANDBOX/stub"
mkdir -p "$STUB/lib"
cp "$GUARD" "$STUB/"
# The parser imports the shared tokeniser, so the stub tree carries it too.
cp "$(dirname "$GUARD")/lib/shell_parse.py" "$STUB/lib/"
printf '%s\n' 'import sys; sys.stdin.read(); print("stub-finding")' > "$STUB/lib/prose-check.py"

run_stub() {  # run_stub <body-file> -> rc (0 allowed, 2 blocked)
  jq -cn --arg c "gh pr create --title t --body-file $1" --arg d "$SANDBOX" \
    '{tool_name:"Bash", cwd:$d, tool_input:{command:$c}}' \
    | bash "$STUB/$(basename "$GUARD")" >/dev/null 2>&1
}

# Every one of these is content, so every one must reach the checker. Before the
# fix each was skipped on Darwin, and NBSP and NNBSP were skipped on no Linux
# locale at all, which is the divergence itself.
for u in 'c2a0:NBSP U+00A0' 'e280af:narrow NBSP U+202F' 'e38080:ideographic space U+3000' 'e280a8:line separator U+2028'; do
  bytes=${u%%:*}; label=${u#*:}
  UB="$SANDBOX/uni-$bytes.md"
  printf "$(echo "$bytes" | sed 's/../\\x&/g')" > "$UB"
  run_stub "$UB"
  if [ $? -eq 2 ]; then
    PASS=$((PASS + 1)); echo "  ✅ a body of only ${label} reaches the checker"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ a body of only ${label} was skipped, so the pre-check still follows the locale"
  fi
done

# The other half, and the one that stops "always run the checker" from passing
# the four above. ASCII whitespace must STILL short-circuit, or the pre-check has
# been deleted rather than made deterministic, and every empty body now forks
# python3 for nothing.
run_stub "$WS"
if [ $? -eq 0 ]; then
  PASS=$((PASS + 1)); echo "  ✅ ASCII whitespace still short-circuits before the checker"
else
  FAIL=$((FAIL + 1)); echo "  ❌ ASCII whitespace reached the checker, so the fast path is gone"
fi

# ── The prefilter ────────────────────────────────────────────────────────────
# The guard skips its parser when a Bash command cannot be a gh prose command.
# These cases prove the skip happens for ordinary calls, and that no spelling
# the parser accepts is skipped.
printf '#!/bin/bash\necho started >> "%s/starts"\nexec "%s" "$@"\n' \
  "$SANDBOX" "$(command -v python3)" > "$SANDBOX/python3"
chmod +x "$SANDBOX/python3"
python_starts() {  # python_starts <command> → how many python3 starts it cost
  : > "$SANDBOX/starts"
  jq -cn --arg c "$1" --arg d "$SANDBOX" '{tool_name:"Bash", cwd:$d, tool_input:{command:$c}}' \
    | PATH="$SANDBOX:$PATH" bash "$GUARD" >/dev/null 2>&1
  wc -l < "$SANDBOX/starts" | tr -d ' '
}
assert_starts() {  # assert_starts <description> <command> <expected>
  local got
  got=$(python_starts "$2")
  if [ "$got" = "$3" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $1"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $1 (expected $3 python start(s), got $got)"
  fi
}

echo "prefilter: a Bash call that is not a gh prose command starts no python:"
assert_starts "ls"                         'ls -la' 0
assert_starts "a grep that mentions gh"    'grep -rn "ghost" .' 0
assert_starts "a git log"                  'git log --oneline -3' 0
assert_starts "gh with no prose noun"      'gh auth status' 0
assert_starts "a prose noun with no gh"   'echo "open a pr for the release"' 0
assert_starts "gh with a noun and no prose verb" 'gh pr view 21665 --json body' 0
assert_starts "gh api reaches the parser"  'gh api repos/o/r/issues/1/comments -f body=' 1
assert_starts "a backslash-newline gh reaches the parser" "g"$'\\\n'"h pr comment 1 --body ''" 1

echo "prefilter: every spelling the parser accepts still reaches it:"
EMDASH_BODY="The fix works — mostly."
assert_blocked "gh split by empty quotes" run_bash "g\"\"h pr create --title t --body '$EMDASH_BODY'"
assert_blocked "gh split by a backslash"  run_bash "g\\h pr comment 1 --body '$EMDASH_BODY'"
assert_blocked "pr in quotes"             run_bash "gh 'pr' edit 1 --body '$EMDASH_BODY'"
assert_blocked "after cd &&"              run_bash "cd /x && gh release create v1 --notes '$EMDASH_BODY'"
assert_blocked "issue comment"            run_bash "gh issue comment 5 --body '$EMDASH_BODY'"

# The parser used to split the command with plain shlex and look for a token
# spelled exactly `gh`. An operator glued to the name, an absolute path, a
# backslash-newline, and `gh api` each hid the call from it.
echo "parser: every spelling of a gh prose call is read:"
assert_blocked "x&&gh with no spaces"      run_bash "true&&gh pr comment 1 --body '$EMDASH_BODY'"
assert_blocked "a subshell (gh"            run_bash "(gh pr comment 1 --body '$EMDASH_BODY')"
assert_blocked "an upper-case GH"          run_bash "GH pr comment 1 --body '$EMDASH_BODY'"
assert_blocked "an absolute gh path"      run_bash "/opt/homebrew/bin/gh pr comment 1 --body '$EMDASH_BODY'"
assert_blocked "gh split by a backslash-newline" \
  run_bash "g"$'\\\n'"h pr comment 1 --body '$EMDASH_BODY'"
assert_blocked "a second gh call after a clean first" \
  run_bash "gh pr view 1 && gh pr comment 1 --body '$EMDASH_BODY'"
assert_blocked "gh api with -f body"       run_bash "gh api repos/o/r/issues/1/comments -f body='$EMDASH_BODY'"
assert_blocked "gh api with --raw-field"   run_bash "gh api repos/o/r/issues/1/comments --raw-field 'body=$EMDASH_BODY'"
assert_blocked "gh api with a nested review body" \
  run_bash "gh api repos/o/r/pulls/1/reviews -f event=COMMENT -f 'comments[][body]=$EMDASH_BODY'"
printf '%s' "$EMDASH_BODY" > "$SANDBOX/api-body.md"
assert_blocked "gh api with -F body=@file" run_bash "gh api repos/o/r/issues/1/comments -F body=@api-body.md"
printf '{"body": "%s"}' "$EMDASH_BODY" > "$SANDBOX/api-input.json"
assert_blocked "gh api with --input"       run_bash "gh api repos/o/r/issues/1/comments --input api-input.json"
assert_blocked "gh api graphql mutation"   run_bash "gh api graphql -f query='mutation { addComment(input: {subjectId: \"x\", body: \"$EMDASH_BODY\"}) { clientMutationId } }'"
assert_allowed "gh api with a clean body"  run_bash "gh api repos/o/r/issues/1/comments -f body='$CLEAN'"
assert_allowed "gh api GET carries no prose" \
  run_bash "gh api -X GET repos/o/r/issues -f body='a; b'"
assert_allowed "gh api graphql query is a read" \
  run_bash "gh api graphql -f query='query { viewer { login } }; x'"
assert_allowed "gh api non-prose fields"   run_bash "gh api repos/o/r/pulls/1/reviews -f event=APPROVE -f commit_id='a;b'"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
