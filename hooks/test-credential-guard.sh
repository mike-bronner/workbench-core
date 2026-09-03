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

# check <expected-exit> <description> <payload-json>
check() {
  local expected="$1" desc="$2" payload="$3" actual
  printf '%s' "$payload" | bash "$GUARD" >/dev/null 2>&1
  actual=$?
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected exit $expected, got $actual"
  fi
}

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

echo "blocks Bash commands that read a dotenv file:"
check 2 "grep a secret out of .env" "$(bash_json 'grep DB_PASSWORD .env')"
check 2 "cat .env.production"       "$(bash_json 'cat .env.production')"

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

echo "allows anything it cannot parse — this hook is not an OS boundary:"
check 0 "malformed json"           'not json at all'
check 0 "empty object"             '{}'

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
