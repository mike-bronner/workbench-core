#!/bin/bash
# Differential test for hooks/lib/shell_parse.py — the parser all four Bash
# guards share. Run directly: ./test-parser-differential.sh
#
# WHY THIS EXISTS, AND WHY NO SINGLE GUARD'S SUITE CAN REPLACE IT.
#
# On 2026-09-21 a change to token_lines() made it call extract_heredocs(). Three
# checkers already called that function themselves and passed the stripped text
# down, so it ran twice. The second pass met an opener whose delimiter line the
# first had consumed, found no terminator, and swallowed every remaining line as
# that opener's body — so an ordinary `cat <<EOF` used to write a file deleted
# every command after it from three guards' view. `dropdb app` denied; the same
# command behind a harmless heredoc returned nothing.
#
# 578 assertions across six suites were green while that was true, and the rule
# "rerun every importer's suite after touching the parser" was followed. Both
# failed for the same reason: THE DEFECT LIVED IN THE SEAM BETWEEN TWO LAYERS,
# and each layer's own suite tests that layer. shell_parse's callers each have a
# suite; the composition of parser-plus-caller had none.
#
# So this file tests the composition. It drives the LIVE hooks end to end, one
# corpus of commands against every guard, and pins the verdict each one reaches.
# A parser change that moves any verdict shows up here as a diff, whichever
# guard it moves and whichever direction it moves in — including a guard the
# author of the change was not thinking about.
#
# HOW TO READ A FAILURE. This suite asserts CURRENT BEHAVIOUR, not correct
# behaviour. A diff means a parser change altered a verdict somewhere. That is
# not automatically a bug — an improvement moves a verdict too. It means: go
# look, decide which it is, and if it is an improvement, update the row and say
# so in the commit. What it must never be is unnoticed.
#
# ROWS MARKED KNOWN-GAP RECORD A DEFECT RATHER THAN AN ENDORSEMENT. They are
# here so that a fix becomes visible as a diff, in a file whose failures get
# read. Each one names what is wrong with it.

set -u
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0

# /tmp, deliberately NOT `mktemp -d`. On Darwin mktemp lands under
# /private/var/folders, which IS this account's per-user temporary directory and
# therefore an approved scratch root for the scope guard — a victim placed there
# is in scope, and a case asserting it is refused would fail for a reason that
# has nothing to do with the parser. /tmp is under no approved root: the session
# glob needs a `claude-` prefix, and /tmp resolves to /private/tmp rather than
# into the folders tree.
SANDBOX="/tmp/pdiff-$$"
mkdir -p "$SANDBOX"
trap 'rm -rf "$SANDBOX"' EXIT

PROJECT="$SANDBOX/project"
VAULT="$SANDBOX/vault"
OUTSIDE="$SANDBOX/outside"
mkdir -p "$PROJECT/sub" "$VAULT/insights" "$OUTSIDE"
echo "keep" > "$OUTSIDE/keep.txt"

# A config file naming a vault that is not this machine's, so the vault guard
# judges the sandbox rather than the user's real notes.
CONFIG="$SANDBOX/config.json"
printf '{"memory_path": "%s"}\n' "$VAULT" > "$CONFIG"

# verdict <guard> <command> — the live hook's decision, or "silent".
verdict() {
  local guard="$1" command="$2" out
  out=$(jq -nc --arg c "$command" --arg d "$PROJECT" \
        '{tool_name: "Bash", tool_input: {command: $c}, cwd: $d, session_id: "differential-fixture"}' \
      | (unset CLAUDE_CODE_SESSION_ID
         CLAUDE_PROJECT_DIR="$PROJECT" \
         WORKBENCH_MEMORY_PATH="$VAULT" \
         WORKBENCH_CONFIG_FILE="$CONFIG" \
         bash "$HOOKS_DIR/$guard.sh") 2>/dev/null)
  # No output at all is the neutral verdict, and it has to be spelled rather
  # than left as an empty string: `jq` over empty input prints nothing and exits
  # 0, so an empty result would compare equal to nothing and read as a pass.
  [ -n "$out" ] || { echo "silent"; return; }
  printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // "silent"' 2>/dev/null \
    || echo "silent"
}

# row <guard> <expected> <label> <command>
row() {
  local guard="$1" expected="$2" label="$3" command="$4" actual
  actual=$(verdict "$guard" "$command")
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $guard · $label"
  else
    FAIL=$((FAIL + 1))
    echo "  ❌ $guard · $label — verdict moved: expected $expected, got $actual"
  fi
}

# Wrap a command in a heredoc that writes an unrelated file, then runs it. This
# is the shape that disabled three guards, and it is deliberately innocuous —
# nothing about it is an attack, which is what made the regression so quiet.
heredoc_before() { printf 'cat <<EOF > notes.txt\njust some text\nEOF\n%s' "$1"; }
# The same, unterminated. At HEAD this hid every following line from all three
# guards, which predates the double-extraction defect.
unterminated_before() { printf 'cat <<EOF\n%s' "$1"; }
# A parenthesised group in front, which `);` used to make swallow the rest.
paren_before() { printf '(true); %s' "$1"; }

echo "baseline — each guard denies its own verb, plainly:"
row destructive-database-guard deny "dropdb"          "dropdb app"
row provisioning-guard         deny "createdb"        "createdb app"
row vault-git-guard            deny "git rm in vault" "git -C $VAULT rm insights/a.md"
row destructive-scope-guard    deny "rm outside"      "rm -rf $OUTSIDE/keep.txt"
row destructive-scope-guard    allow "rm inside"      "rm -rf $PROJECT/sub"

echo "a harmless heredoc must not blind any guard to what follows it:"
row destructive-database-guard deny "dropdb after heredoc"   "$(heredoc_before 'dropdb app')"
row provisioning-guard         deny "createdb after heredoc" "$(heredoc_before 'createdb app')"
row vault-git-guard            deny "git rm after heredoc"   "$(heredoc_before "git -C $VAULT rm insights/a.md")"
row destructive-scope-guard    deny "rm after heredoc"       "$(heredoc_before "rm -rf $OUTSIDE/keep.txt")"

echo "nor must an UNTERMINATED one:"
row destructive-database-guard deny "dropdb after an unterminated heredoc"   "$(unterminated_before 'dropdb app')"
row provisioning-guard         deny "createdb after an unterminated heredoc" "$(unterminated_before 'createdb app')"
row destructive-scope-guard    deny "rm after an unterminated heredoc"       "$(unterminated_before "rm -rf $OUTSIDE/keep.txt")"

echo "nor must a parenthesised group:"
row destructive-database-guard deny "dropdb after a group"   "$(paren_before 'dropdb app')"
row provisioning-guard         deny "createdb after a group" "$(paren_before 'createdb app')"
row vault-git-guard            deny "git rm after a group"   "$(paren_before "git -C $VAULT rm insights/a.md")"
row destructive-scope-guard    deny "rm after a group"       "$(paren_before "rm -rf $OUTSIDE/keep.txt")"

echo "a heredoc body is data, and must not be read as commands:"
# The false-positive direction. `cat` fed destructive TEXT deletes nothing, and
# a guard that refuses it is refusing a command that was never going to run.
row destructive-database-guard silent "cat fed DROP DATABASE" "$(printf 'cat <<EOF\nDROP DATABASE app;\nEOF')"
row destructive-scope-guard    silent "cat fed rm -rf /"      "$(printf 'cat <<EOF\nrm -rf /\nEOF')"
# …but a heredoc fed to a SHELL is a script, and its body does run.
row destructive-scope-guard    deny "bash fed rm -rf"         "$(printf 'bash <<EOF\nrm -rf %s/keep.txt\nEOF' "$OUTSIDE")"

echo "read-only work stays untouched by all of it:"
row destructive-database-guard silent "psql SELECT"      "psql -c 'SELECT 1'"
row provisioning-guard         silent "git worktree list" "git worktree list"
row vault-git-guard            silent "git log in vault" "git -C $VAULT log --oneline"
row destructive-scope-guard    silent "git status"       "git status"
row destructive-scope-guard    silent "grep for rm"      "grep -rn 'rm -rf' ."

# ─────────────────────────────────────────────────────────────────────────────
# KNOWN GAPS. Each row below records a DEFECT that is live today, so that a fix
# shows up here as a diff rather than passing unnoticed. None of them is an
# endorsement, and none should be copied as a pattern.
echo "known gaps, pinned so that closing one is visible:"
# strip_noop() drops `env` but not env's own options, so `-i` lands in the verb
# slot. The scope guard refuses an unreadable verb slot and so is unaffected;
# the other three read `-i` as a command named `-i` and walk on. Fixing it means
# changing what strip_noop() returns, which moves three guards at once, so it is
# tracked separately rather than folded into the round that found it.
row destructive-database-guard silent "KNOWN-GAP env -i hides dropdb"  "env -i dropdb app"
row provisioning-guard         silent "KNOWN-GAP env -i hides createdb" "env -i createdb app"
row destructive-scope-guard    deny   "env -i does NOT hide rm"        "env -i rm -rf $OUTSIDE/keep.txt"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
