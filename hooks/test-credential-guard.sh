#!/bin/bash
# Tests for hooks/credential-guard.sh — the PreToolUse credential-path guard.
# Run directly: ./test-credential-guard.sh
# Each case feeds the hook one PreToolUse payload on stdin and asserts its exit
# code: 2 = blocked, 0 = allowed. Pure stdin/exit-code checks — no network, no
# server, and nothing is ever read off disk.
#
# Paths are built from $HOME so the suite is portable to CI, where the home
# directory is not /Users/mike.

set -u
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
GUARD="$HOOKS_DIR/credential-guard.sh"
HOOKS_JSON="$HOOKS_DIR/hooks.json"
PASS=0
FAIL=0

# check_guard <guard-path> <expected-exit> <description> <payload-json>
# Takes the guard as an argument so the fail-closed cases can run a COPY of it
# from a temp directory that has no stage-2 checker beside it.
check_guard() {
  local guard="$1" expected="$2" desc="$3" payload="$4" actual
  printf '%s' "$payload" | bash "$guard" >/dev/null 2>&1
  actual=$?
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected exit $expected, got $actual"
  fi
}

# check <expected-exit> <description> <payload-json>
check() { check_guard "$GUARD" "$@"; }

assert_jq() {
  local desc="$1" file="$2" filter="$3" expected="$4" actual
  actual="$(jq -r "$filter" "$file" 2>/dev/null)"
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected [$expected], got [$actual]"
  fi
}

assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if printf '%s\n' "$haystack" | grep -qF "$needle"; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — output missing: $needle"
  fi
}

bash_json() { jq -nc --arg c "$1" '{tool_name: "Bash", tool_input: {command: $c}}'; }
file_json() { jq -nc --arg t "$1" --arg p "$2" '{tool_name: $t, tool_input: {file_path: $p}}'; }

echo "blocks Bash commands that read a credential directory:"
check 2 "cat a key via ~"          "$(bash_json 'cat ~/.ssh/id_rsa')"
check 2 "cat a key via abs path"   "$(bash_json "cat $HOME/.ssh/id_rsa")"
check 2 "\$HOME expansion"         "$(bash_json 'cat "$HOME/.ssh/id_rsa"')"
check 2 "\${HOME} expansion"       "$(bash_json 'cat "${HOME}/.ssh/id_rsa"')"
check 2 "grep into ~/.aws"         "$(bash_json 'grep -rn key ~/.aws/credentials')"
check 2 "cp out of ~/.gnupg"       "$(bash_json 'cp ~/.gnupg/secring.gpg /tmp/x')"
# The whole point of replacing the Read() deny rule: it never caught this one.
check 2 "python subprocess read"   "$(bash_json "python3 -c \"print(open('$HOME/.ssh/id_rsa').read())\"")"

# Stage 2 (hooks/lib/credential-check.py) refines these: a dotenv hit blocks
# only when the `.env` sits in an argument SLOT. Every case here puts it in one.
echo "blocks Bash commands that read a dotenv file:"
check 2 "grep a secret out of .env" "$(bash_json 'grep DB_PASSWORD .env')"
check 2 "cat .env.production"       "$(bash_json 'cat .env.production')"
check 2 "cat .env.local"            "$(bash_json 'cat .env.local')"
check 2 "a quoted path, no spaces"  "$(bash_json 'cat "$HOME/app/.env"')"
# The reader that the removed Read() deny rule could never see, in its dotenv
# form. The token holds no whitespace, so the prose rule does not clear it.
check 2 "python3 opens a dotenv"    "$(bash_json "python3 -c \"print(open('.env').read())\"")"
# A heredoc body is lifted out before tokenising, but it is still SCANNED. Drop
# that and `python3 <<PY … open('.env') … PY` becomes an open door.
HEREDOC_READ=$(cat <<'OUTER'
python3 - <<'PY'
print(open('.env').read())
PY
OUTER
)
check 2 "a dotenv read in a heredoc" "$(bash_json "$HEREDOC_READ")"
# `.env.example.bak` is not a template: TEMPLATE_RE anchors on the end of the
# path component, so a suffix past the template name leaves the hit standing.
check 2 "a template with a suffix"  "$(bash_json 'cat .env.example.bak')"

echo "blocks the file tools on a protected path:"
check 2 "Read on .env"             "$(file_json Read "$HOME/Developer/app/.env")"
check 2 "Read on ~/.aws"           "$(file_json Read "$HOME/.aws/credentials")"
check 2 "Edit on ~/.gnupg"         "$(file_json Edit "$HOME/.gnupg/gpg.conf")"
check 2 "Write on ~/.ssh"          "$(file_json Write "$HOME/.ssh/authorized_keys")"
check 2 "NotebookEdit on ~/.ssh"   "$(jq -nc --arg p "$HOME/.ssh/id_rsa" \
  '{tool_name: "NotebookEdit", tool_input: {notebook_path: $p}}')"

# A protected path alone must not block. Listing names exposes no secret, and
# blocking these would make the hook its own source of prompt noise — the exact
# failure the removed Read() deny rules were guilty of.
echo "allows commands that name a protected path without reading it:"
check 0 "ls ~/.ssh"                "$(bash_json 'ls -la ~/.ssh')"
check 0 "stat a key"               "$(bash_json 'stat ~/.ssh/id_rsa')"
check 0 "find -name .env*"         "$(bash_json "find $HOME/Developer/x -name \".env*\"")"

echo "allows unrelated work:"
# The prompt class this whole change exists to kill: cd + a relative path.
check 0 "the cd+grep case"         "$(bash_json "cd $HOME/Developer/x && grep -rn foo vendor/")"
check 0 "grep inside a project"    "$(bash_json "grep -rn foo $HOME/Developer/x/")"
check 0 "echo mentioning .env"     "$(bash_json 'echo "remember to set your .env"')"
check 0 ".envrc is out of scope"   "$(bash_json "cat $HOME/Developer/x/.envrc")"
check 0 "unrelated .ssh directory" "$(bash_json "cat $HOME/Developer/x/.ssh/notes.txt")"
# `~` only means home at the start of a word. A directory whose name merely
# ends in one is an ordinary tree — this is what DIR_RE's leading group buys.
check 0 "a tilde-suffixed sibling" "$(bash_json "cat $HOME/Developer/backup~/.ssh/id_rsa")"
check 0 "Read an ordinary file"    "$(file_json Read "$HOME/Developer/x/README.md")"
check 0 "an unmatched tool name"   "$(file_json Grep "$HOME/.ssh/id_rsa")"

# The false positives stage 2 exists to kill. Every one of these ran on
# 2026-09-04 or is the same shape as one that did, and not one opens a file.
# The rule: a path is a token with no whitespace in it, and the shell has
# already collapsed the quotes around a sentence, so prose is one token FULL of
# whitespace. Delete the whitespace test in credential-check.py and this whole
# block reddens.
echo "allows prose that merely names a dotenv file:"
check 0 "a sentence via python3 -c" \
  "$(bash_json "python3 -c \"print('remember to set your .env before running')\"")"
check 0 "a quoted sentence to grep" \
  "$(bash_json 'grep -n "update the .env file" docs/setup.md')"
# The reported case, near enough verbatim: a heredoc whose prose names two
# dotenv files. It blocked three times in one session and read nothing.
HEREDOC_PROSE=$(cat <<'OUTER'
python3 - <<'PY'
print("copy .env.example to .env, then fill in the values")
PY
OUTER
)
check 0 "a heredoc naming dotenvs"  "$(bash_json "$HEREDOC_PROSE")"

# Committed templates hold placeholder values by convention, not secrets. The
# suffix list lives twice — TMPL_RE in the guard, TEMPLATE_RE in the checker —
# so every member is pinned here; drop one from either list and its case goes
# red rather than quietly widening the block.
echo "allows the committed dotenv templates:"
check 0 "cat .env.example"          "$(bash_json 'cat .env.example')"
check 0 "cat .env.sample"           "$(bash_json 'cat .env.sample')"
check 0 "cat .env.template"         "$(bash_json 'cat .env.template')"
check 0 "cat .env.dist"             "$(bash_json 'cat .env.dist')"
check 0 "cat .env.default"          "$(bash_json 'cat .env.default')"
check 0 "cat .env.defaults"         "$(bash_json 'cat .env.defaults')"
check 0 "Read a template"           "$(file_json Read "$HOME/Developer/app/.env.example")"
check 0 "Edit a template"           "$(file_json Edit "$HOME/Developer/app/.env.dist")"
# Per token, not per command: a template in the argument list clears itself and
# nothing else. A whole-string test would clear the real dotenv beside it.
check 2 "a template beside a real one" "$(bash_json 'cat .env.example .env')"

# KNOWN LIMIT, asserted so the next reader sees a decision rather than a bug.
# Stage 2 reads the argument SLOT, and it cannot tell a search pattern or a jq
# path expression from a filename: both are bare tokens with no whitespace, in
# the slot a filename would occupy. Closing this needs per-program argument
# knowledge (which grep operands are patterns, which are paths), which is a
# much larger rule set than the false positives left justify.
echo "still blocks a bare dotenv token that is not a path — the stated limit:"
check 2 "a grep search pattern"     "$(bash_json 'grep -rn "\.env" docs/')"
check 2 "a jq path expression"      "$(bash_json 'jq ".env.WORKBENCH" settings.json')"
# The same limit from the other side, and a fail-closed path in its own right:
# a segment that will not tokenise keeps the block. Stage 2 must never relax a
# block over text it could not read, so an unbalanced quote blocks.
check 2 "an unterminated quote"     "$(bash_json "cat 'notes about .env")"
# The heredoc form of it. A body is not shell, so a bare apostrophe outside a
# string defeats shlex where the same word inside one parses fine. Built with
# printf rather than the heredoc the two cases above use, because bash's own
# command-substitution scanner mis-reads that apostrophe inside `$(cat <<…)`.
HEREDOC_UNPARSED=$(printf '%s\n' "python3 - <<'PY'" "it's the .env file" "PY")
check 2 "a heredoc body shlex rejects" "$(bash_json "$HEREDOC_UNPARSED")"

echo "allows anything it cannot parse — this hook is not an OS boundary:"
check 0 "malformed json"           'not json at all'
check 0 "empty object"             '{}'

# Stage 2 may only NARROW a block, so a checker that cannot run has to leave
# that block in place — the opposite of the other two guards, which fail open.
# Both cases run a COPY of the guard from a temp directory: a suite that moves
# the live checker aside leaves the machine unguarded if it is interrupted
# between the move and the restore.
echo "keeps the block when stage 2 cannot run — this guard fails closed:"
FAILCLOSED=$(mktemp -d)
trap 'rm -rf "$FAILCLOSED"' EXIT
cp "$GUARD" "$FAILCLOSED/credential-guard.sh"
check_guard "$FAILCLOSED/credential-guard.sh" 2 "the checker is missing" \
  "$(bash_json 'grep DB_PASSWORD .env')"
# Not redundant with the case above, and the reason is the whole design of the
# stdout sentinel: a Python traceback exits 1, which is the code the checker
# returns for ALLOW. Only the missing `allow` on stdout separates them. The
# payload is one the working checker would allow, so a guard reading the exit
# code alone would let a crashed checker clear it.
mkdir -p "$FAILCLOSED/lib"
printf 'raise RuntimeError("boom")\n' > "$FAILCLOSED/lib/credential-check.py"
check_guard "$FAILCLOSED/credential-guard.sh" 2 "the checker raises" \
  "$(bash_json 'cat .env.example')"

echo "explains the block on stderr:"
OUT=$(bash_json 'cat ~/.ssh/id_rsa' | bash "$GUARD" 2>&1)
assert_contains "names what was touched" "$OUT" "a protected credential directory"
assert_contains "offers the ! escape"    "$OUT" "! prefix"
OUT=$(bash_json 'grep DB_PASSWORD .env' | bash "$GUARD" 2>&1)
assert_contains "names the dotenv hit"   "$OUT" "a .env file"

# Registration is part of the behaviour: a guard nothing calls guards nothing.
# The matcher is deliberately every file-touching tool with no `if` condition —
# a pre-filter that misses a case is a hole in the guard.
echo "the hook is registered globally in hooks.json:"
assert_jq "matcher covers every file tool" "$HOOKS_JSON" \
  '[.hooks.PreToolUse[] | select(.hooks[].command | test("credential-guard.sh")) | .matcher] | join(",")' \
  "Bash|Read|Edit|Write|NotebookEdit"
assert_jq "registered exactly once" "$HOOKS_JSON" \
  '[.hooks.PreToolUse[].hooks[] | select(.command | test("credential-guard.sh"))] | length' "1"
assert_jq "no if condition narrows it" "$HOOKS_JSON" \
  '[.hooks.PreToolUse[] | select(.hooks[].command | test("credential-guard.sh")) | .if // empty] | length' "0"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
