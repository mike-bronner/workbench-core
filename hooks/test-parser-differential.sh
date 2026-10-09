#!/bin/bash
# The parser corpus: commands that once moved a bash guard's verdict through
# hooks/lib/shell_parse.py. Run directly: ./test-parser-differential.sh
#
# WHY THIS CORPUS EXISTS.
#
# On 2026-09-21 a change to token_lines() made it call extract_heredocs(). Three
# checkers already called that function themselves and passed the stripped text
# down, so it ran twice. The second pass met an opener whose delimiter line the
# first had consumed, found no terminator, and swallowed every remaining line as
# that opener's body — so an ordinary `cat <<EOF` used to write a file deleted
# every command after it from three guards' view. `dropdb app` denied; the same
# command behind a harmless heredoc returned nothing.
#
# The defect lived in the seam between the parser and its callers, which no
# single guard's suite tests. This file held the composition: one corpus of
# commands, run end to end through every bash guard, each verdict pinned.
#
# WHAT IT DOES NOW. The bash guards are retired, and their ports in the hooks
# module read shell through hooks/mods/shell.ts. So this file no longer runs a
# guard. It records its corpus only:
#
#   - hooks/test-shell-parity.sh runs it with PARSER_CASES_OUT set, and holds
#     the TypeScript reader to shell_parse.py on every command;
#   - tests/guards.test.ts holds the provisioning port to its rows, and
#     tests/destructive.test.ts holds the other three ports to theirs.
#
# Each row keeps the verdict the retired bash guard reached, as a record. Rows
# marked KNOWN-GAP recorded a defect in that guard rather than an endorsement.

set -u
COUNT=0

# The corpus writes its paths under /sandbox, so the record is the same on
# every run. No command here runs, so nothing is created there.
SANDBOX="/sandbox"
PROJECT="$SANDBOX/project"
VAULT="$SANDBOX/vault"
OUTSIDE="$SANDBOX/outside"

# row <guard> <bash verdict> <label> <command>
#
# With PARSER_CASES_OUT set, each row's command is written there as one JSON
# line. hooks/test-shell-parity.sh reads them.
row() {
  local guard="$1" label="$3" command="$4"
  if [ -n "${PARSER_CASES_OUT:-}" ]; then
    jq -nc --arg label "$guard · $label" --arg command "$command" \
      '{label: $label, command: $command}' >>"$PARSER_CASES_OUT" || exit 1
  fi
  COUNT=$((COUNT + 1)); echo "  recorded: $guard · $label"
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

echo "a backslash-newline and an upper-case name read as bash reads them:"
# Bash deletes a backslash-newline before it reads a word, and macOS resolves a
# command name case-insensitively. The tokeniser does both for every guard, so
# one parser change moves all four verdicts at once. Each row went from silent
# to deny when shell_parse learned it.
row destructive-database-guard deny "drop<continuation>db"   "$(printf 'drop\\\ndb app')"
row provisioning-guard         deny "create<continuation>db" "$(printf 'create\\\ndb app')"
row vault-git-guard            deny "git r<continuation>m"   "$(printf 'git -C %s r\\\nm insights/a.md' "$VAULT")"
row destructive-scope-guard    deny "r<continuation>m"       "$(printf 'r\\\nm -rf %s/keep.txt' "$OUTSIDE")"
row destructive-database-guard deny "DROPDB"                 "DROPDB app"
row provisioning-guard         deny "CREATEDB"               "CREATEDB app"
row vault-git-guard            deny "GIT rm in vault"        "GIT -C $VAULT rm insights/a.md"
row destructive-scope-guard    deny "RM outside"             "RM -rf $OUTSIDE/keep.txt"
# Inside single quotes bash keeps the pair, so the word stays split.
row destructive-scope-guard    silent "quoted r<continuation>m is data" "$(printf "echo 'r\\\\\\nm -rf /'")"

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
echo "$COUNT commands recorded"
