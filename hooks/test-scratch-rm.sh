#!/bin/bash
# Tests for bin/scratch-rm.sh — the scratchpad delete helper that a shipped
# permissions.allow entry lets run unprompted.
# Run directly: ./test-scratch-rm.sh
#
# The path check inside that script is the only thing left between an agent and
# a wrong `rm -rf`: the ask rule that prompts today never fires on this command,
# by design. So these cases are weighted at the refusals — a `..` escape, a
# symlink escape, a `$HOME` that is not this account's, and the roots themselves
# — and each one asserts the victim is still on disk afterwards, not merely that
# the exit status was non-zero.
#
# WHICH ROOT THESE CASES RUN AGAINST, AND WHY IT IS THE SESSION ONE.
# The script derives the persistent root from the password database, so no test
# can move it: `~name` expansion ignores every variable a test could set. That
# is the point of the check and it is not negotiable here. The session root is
# derived from CLAUDE_CODE_SESSION_ID under /tmp/claude-*/ instead, which IS
# sandboxable, so every root-agnostic case — escapes, symlinks, the root itself,
# bad input — runs there. Two fake project directories carry the same session
# id, which is legitimate (the glob matches any project directory holding it)
# and keeps the general cases and the session-matching cases off each other's
# fixtures. /tmp is writable on macOS and Linux alike, so these run in CI rather
# than being skipped there.
#
# What is left untested by construction is the delete itself beneath the REAL
# `$HOME/Developer/scratchpad`, because the only fixture for it would be the
# user's own live scratchpad, and a regression would then destroy the work the
# script exists to protect. Its derivation is covered instead: the last group
# asserts the root the script lists is the login home's, and that no $HOME a
# caller invents ever becomes one.

set -u
SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/bin/scratch-rm.sh"
PASS=0
FAIL=0

SANDBOX=$(mktemp -d)
FAKE_TMP="/tmp/claude-scratchrm-test-$$"
trap 'rm -rf "$SANDBOX" "$FAKE_TMP"' EXIT

SID="scratchrm-$$-aaaa"
OTHER_SID="scratchrm-$$-bbbb"

# The approved root the root-agnostic cases use, with a victim directory beside
# it that no root covers.
PROJECT="$FAKE_TMP/-fake-project/$SID"
ROOT="$PROJECT/scratchpad"
PRECIOUS="$PROJECT/precious"

# A second project directory under the same session id, for the cases about
# WHICH scratchpad the id approves.
OTHER_PROJECT="$FAKE_TMP/-other-project/$SID"
SESSION_ROOT="$OTHER_PROJECT/scratchpad"
OTHER_SESSION_ROOT="$FAKE_TMP/-other-project/$OTHER_SID/scratchpad"
# One level shallower than the glob reaches, so nothing approves this directory
# — unless a `..` inside the session id walks the glob up to it. That is the one
# thing the id's character check defends, so it needs a tree to defend.
DECOY_ROOT="$FAKE_TMP/$SID/scratchpad"

# TWO APPROVED ROOTS WHERE ONE SITS INSIDE THE OTHER, which the roots this
# command ships with cannot demonstrate: neither of them contains the other, so
# they agree no matter which order the check reads them in. A third root is all
# it would take to break that agreement, and the pair below is what a case
# covering it needs.
#
# The session glob is fixed-depth, so two session roots are always the same
# distance from /tmp and can never nest as plain directories. Each root here is
# therefore a symlink into one ordinary tree. That is not a trick to defeat the
# check — the script resolves every root physically, exactly so a root that
# resolves elsewhere is compared where it really lives, and this is the shape a
# relocated scratchpad has in the field.
#
# The project directory names carry the LIST ORDER, which the glob produces by
# sorting: `-nest-1-*` is listed before `-nest-2-*`. One session id lists the
# outer root first and the other lists the inner one first, so the same target
# is judged under both orderings. Only the first order can go wrong, and only
# the pair of them proves the answer does not depend on the order at all.
NEST_SID="scratchrm-$$-cccc"
NEST_REV_SID="scratchrm-$$-dddd"
NEST_OUTER="$SANDBOX/nest/outer"
NEST_INNER="$NEST_OUTER/inner"
NEST_OUTER_FIRST="$FAKE_TMP/-nest-1-outer/$NEST_SID"
NEST_INNER_SECOND="$FAKE_TMP/-nest-2-inner/$NEST_SID"
NEST_INNER_FIRST="$FAKE_TMP/-nest-1-inner/$NEST_REV_SID"
NEST_OUTER_SECOND="$FAKE_TMP/-nest-2-outer/$NEST_REV_SID"

# Homes that are not this account's. FAKE_HOME holds a real scratchpad
# directory; ESCAPE_HOME holds one that is a symlink to VICTIM, which is the
# shape that deleted a file outside every root before $HOME was validated.
FAKE_HOME="$SANDBOX/home"
ESCAPE_HOME="$SANDBOX/escape-home"
VICTIM="$SANDBOX/victim"
EMPTY_HOME="$SANDBOX/empty-home"
MISSING_HOME="$SANDBOX/no-such-home"

# The account's own home, read from the environment — an independent source from
# the password database the script reads, so a wrong lookup in the script shows
# up here as a mismatch. A shell whose $HOME is not the login home (a bare
# `sudo`, say) will fail the last case, and that is the correct complaint.
REAL_HOME="$(cd -P -- "${HOME:-/nonexistent}" 2>/dev/null && pwd -P)" || REAL_HOME=""

# Rebuild the whole fixture tree. Called before each group, since the passing
# cases delete parts of it.
seed() {
  rm -rf "$FAKE_HOME" "$ESCAPE_HOME" "$VICTIM" "$EMPTY_HOME" "$FAKE_TMP" \
         "$SANDBOX/nest"
  mkdir -p "$ROOT/sub" "$PRECIOUS" \
           "$SESSION_ROOT/sub" "$OTHER_SESSION_ROOT" "$DECOY_ROOT" \
           "$NEST_INNER" \
           "$NEST_OUTER_FIRST" "$NEST_INNER_SECOND" \
           "$NEST_INNER_FIRST" "$NEST_OUTER_SECOND" \
           "$FAKE_HOME/Developer/scratchpad" "$ESCAPE_HOME/Developer" \
           "$VICTIM" "$EMPTY_HOME"
  echo "scratch" > "$ROOT/file.txt"
  echo "scratch" > "$ROOT/sub/nested.txt"
  echo "do not delete" > "$PRECIOUS/keep.txt"
  echo "do not delete" > "$SESSION_ROOT/../../keep.txt"
  echo "session scratch" > "$SESSION_ROOT/file.txt"
  echo "another session's work" > "$OTHER_SESSION_ROOT/file.txt"
  echo "reachable only by traversal" > "$DECOY_ROOT/decoy.txt"
  echo "not this account's scratchpad" > "$FAKE_HOME/Developer/scratchpad/file.txt"
  echo "do not delete" > "$VICTIM/keep.txt"
  echo "outer root content" > "$NEST_OUTER/file.txt"
  echo "inner root content" > "$NEST_INNER/file.txt"
  ln -s "$PRECIOUS" "$ROOT/escape"
  ln -s "$VICTIM" "$ESCAPE_HOME/Developer/scratchpad"
  ln -s "$NEST_OUTER" "$NEST_OUTER_FIRST/scratchpad"
  ln -s "$NEST_INNER" "$NEST_INNER_SECOND/scratchpad"
  ln -s "$NEST_INNER" "$NEST_INNER_FIRST/scratchpad"
  ln -s "$NEST_OUTER" "$NEST_OUTER_SECOND/scratchpad"
}

# run <home> <session-id> [args...] — session id "" means the variable is unset,
# which is how a non-Claude Code shell runs this.
run() {
  local home="$1" session="$2"
  shift 2
  if [ -z "$session" ]; then
    (unset CLAUDE_CODE_SESSION_ID; HOME="$home" bash "$SCRIPT" "$@" 2>&1)
  else
    HOME="$home" CLAUDE_CODE_SESSION_ID="$session" bash "$SCRIPT" "$@" 2>&1
  fi
}

assert_status() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected exit $expected, got $actual"
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

refute_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if printf '%s\n' "$haystack" | grep -qF "$needle"; then
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — output contains: $needle"
  else
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  fi
}

# The nested-root cases below only discriminate while the roots are listed in
# the order each case is named for, and that order comes from the glob's sort
# rather than from anything this file states. So assert it: if it ever flips,
# this reports that the case stopped testing what it says, instead of passing on
# for the wrong reason.
assert_before() {
  local desc="$1" haystack="$2" first="$3" second="$4" a b
  a="$(printf '%s\n' "$haystack" | grep -nF "$first"  | head -1 | cut -d: -f1)"
  b="$(printf '%s\n' "$haystack" | grep -nF "$second" | head -1 | cut -d: -f1)"
  if [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1))
    echo "  ❌ $desc — expected $first before $second (found at ${a:-nowhere}/${b:-nowhere})"
  fi
}

assert_gone() {
  local desc="$1" path="$2"
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — still on disk: $path"
  fi
}

assert_survives() {
  local desc="$1" path="$2"
  if [ -e "$path" ] || [ -L "$path" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — DELETED: $path"
  fi
}

echo "deletes entries beneath an approved scratch root:"
seed
OUT=$(run "$EMPTY_HOME" "$SID" "$ROOT/file.txt"); STATUS=$?
assert_status   "a file exits 0" "0" "$STATUS"
assert_contains "says what it deleted" "$OUT" "✅ Deleted"
assert_gone     "the file is gone" "$ROOT/file.txt"
OUT=$(run "$EMPTY_HOME" "$SID" "$ROOT/sub"); STATUS=$?
assert_status "a directory tree exits 0" "0" "$STATUS"
assert_gone   "the tree is gone" "$ROOT/sub"
assert_survives "the root itself survives its own contents being deleted" "$ROOT"

echo "a path that does not exist is a no-op, not a failure:"
OUT=$(run "$EMPTY_HOME" "$SID" "$ROOT/never-existed"); STATUS=$?
assert_status   "exits 0" "0" "$STATUS"
assert_contains "says nothing was there" "$OUT" "Nothing to delete"

echo "refuses the scratch root itself — it holds other sessions' state:"
seed
OUT=$(run "$EMPTY_HOME" "$SID" "$ROOT"); STATUS=$?
assert_status   "exits 1" "1" "$STATUS"
assert_contains "names the reason" "$OUT" "is a scratchpad root itself"
assert_survives "the root survives" "$ROOT"
assert_survives "so does its content" "$ROOT/file.txt"

OUT=$(run "$EMPTY_HOME" "$SID" "$ROOT/"); STATUS=$?
assert_status   "a trailing slash is the same refusal" "1" "$STATUS"
assert_contains "names the reason" "$OUT" "is a scratchpad root itself"
assert_survives "the root survives" "$ROOT"

OUT=$(run "$EMPTY_HOME" "$SID" "$ROOT/."); STATUS=$?
assert_status   "a trailing /. is refused" "1" "$STATUS"
assert_contains "the \`.\` guard is what refuses it" "$OUT" "names a directory by position"
assert_survives "the root survives" "$ROOT"

# The `. | ..` guard produces these refusals, and only the MESSAGE proves it
# ran. Delete the `..` alternative and the exit status is still 1: the string
# `<root>/sub/..` passes the prefix test, reaches `rm -rf`, and rm refuses it on
# its own — `"." and ".." may not be removed` — so the script exits 1 through
# the rm-failed path instead. The parent is not deleted either way, which is why
# no case here asserts that it would have been. rm's refusal is a second layer
# beneath the guard, not the thing under test.
echo "refuses a path whose final component is \`..\`:"
seed
OUT=$(run "$EMPTY_HOME" "$SID" "$ROOT/sub/.."); STATUS=$?
assert_status   "exits 1" "1" "$STATUS"
assert_contains "the guard refuses it, rather than rm" "$OUT" "names a directory by position"
refute_contains "so rm is never reached" "$OUT" "rm failed on"
assert_survives "the directory it names survives" "$ROOT/sub"
assert_survives "and so does what is in it" "$ROOT/sub/nested.txt"

OUT=$(run "$EMPTY_HOME" "$SID" "$ROOT/.."); STATUS=$?
assert_status   "one that climbs out of the root exits 1" "1" "$STATUS"
assert_contains "same guard, same reason" "$OUT" "names a directory by position"
assert_survives "the directory above the root survives" "$PROJECT"

echo "refuses a \`..\` escape — the check resolves the path, never a prefix:"
seed
OUT=$(run "$EMPTY_HOME" "$SID" "$ROOT/../precious/keep.txt"); STATUS=$?
assert_status   "exits 1" "1" "$STATUS"
assert_contains "reports the resolved path, not the one typed" "$OUT" "resolves to"
assert_survives "the file outside the root survives" "$PRECIOUS/keep.txt"

OUT=$(run "$EMPTY_HOME" "$SID" "$ROOT/sub/../../precious"); STATUS=$?
assert_status   "a deeper escape exits 1" "1" "$STATUS"
assert_survives "the directory outside the root survives" "$PRECIOUS"

echo "refuses a symlink escape — a prefix check would accept this one:"
OUT=$(run "$EMPTY_HOME" "$SID" "$ROOT/escape/keep.txt"); STATUS=$?
assert_status   "exits 1" "1" "$STATUS"
assert_survives "the file the link points at survives" "$PRECIOUS/keep.txt"

echo "deletes a symlink that lives beneath the root, and not its target:"
OUT=$(run "$EMPTY_HOME" "$SID" "$ROOT/escape"); STATUS=$?
assert_status   "exits 0" "0" "$STATUS"
assert_gone     "the link is gone" "$ROOT/escape"
assert_survives "the target directory survives" "$PRECIOUS"
assert_survives "and so does what is in it" "$PRECIOUS/keep.txt"

echo "refuses anything outside every approved root:"
seed
OUT=$(run "$EMPTY_HOME" "$SID" "$PRECIOUS/keep.txt"); STATUS=$?
assert_status   "a plain outside path exits 1" "1" "$STATUS"
assert_contains "lists the roots it checked" "$OUT" "Approved roots right now:"
assert_survives "the file survives" "$PRECIOUS/keep.txt"

OUT=$(run "$EMPTY_HOME" "$SID" "$PROJECT"); STATUS=$?
assert_status   "the root's parent exits 1" "1" "$STATUS"
assert_survives "it survives" "$PROJECT"

OUT=$(run "$EMPTY_HOME" "$SID" "/"); STATUS=$?
assert_status "\"/\" exits 1" "1" "$STATUS"

echo "refuses input it cannot judge, rather than falling back to a delete:"
OUT=$(run "$EMPTY_HOME" "$SID" "Developer/scratchpad/file.txt"); STATUS=$?
assert_status   "a relative path exits 1" "1" "$STATUS"
assert_contains "says why" "$OUT" "relative path"

OUT=$(run "$EMPTY_HOME" "$SID" "$ROOT/no-such-dir/file.txt"); STATUS=$?
assert_status   "a missing parent exits 1" "1" "$STATUS"
assert_contains "says why" "$OUT" "is not an existing directory"

OUT=$(run "$EMPTY_HOME" "$SID"); STATUS=$?
assert_status   "no argument is a usage error" "2" "$STATUS"
assert_contains "prints the sanctioned spelling" "$OUT" 'bash "$HOME/.claude-workbench/bin/scratch-rm.sh" <absolute-path>'

OUT=$(run "$EMPTY_HOME" "$SID" "$ROOT/file.txt" "$ROOT/other.txt"); STATUS=$?
assert_status   "two paths are a usage error — no glob sweeps" "2" "$STATUS"
assert_survives "nothing was deleted" "$ROOT/file.txt"

OUT=$(run "$EMPTY_HOME" "$SID" "-rf"); STATUS=$?
assert_status   "an option-shaped argument is a usage error" "2" "$STATUS"
assert_contains "says why" "$OUT" "takes no options"

OUT=$(run "$EMPTY_HOME" "$SID" ""); STATUS=$?
assert_status "an empty path is a usage error" "2" "$STATUS"

# The session root is found by matching CLAUDE_CODE_SESSION_ID under
# /private/tmp/claude-*/ and /tmp/claude-*/. Matching the id is what keeps one
# session out of another's scratchpad — every session's directory sits under the
# same prefix, so a glob that ignored the id would approve all of them.
echo "deletes beneath THIS session's scratchpad:"
seed
OUT=$(run "$EMPTY_HOME" "$SID" "$SESSION_ROOT/file.txt"); STATUS=$?
assert_status "exits 0" "0" "$STATUS"
assert_gone   "the file is gone" "$SESSION_ROOT/file.txt"
OUT=$(run "$EMPTY_HOME" "$SID" "$SESSION_ROOT/sub"); STATUS=$?
assert_status "a directory beneath it exits 0" "0" "$STATUS"
assert_gone   "the tree is gone" "$SESSION_ROOT/sub"

echo "refuses the session scratchpad itself and everything above it:"
seed
OUT=$(run "$EMPTY_HOME" "$SID" "$SESSION_ROOT"); STATUS=$?
assert_status   "the root exits 1" "1" "$STATUS"
assert_contains "names the reason" "$OUT" "is a scratchpad root itself"
assert_survives "it survives" "$SESSION_ROOT"

OUT=$(run "$EMPTY_HOME" "$SID" "$OTHER_PROJECT"); STATUS=$?
assert_status   "the session directory above it exits 1" "1" "$STATUS"
assert_survives "it survives" "$OTHER_PROJECT"

OUT=$(run "$EMPTY_HOME" "$SID" "$SESSION_ROOT/../../keep.txt"); STATUS=$?
assert_status   "an escape out of it exits 1" "1" "$STATUS"
assert_survives "the file outside survives" "$FAKE_TMP/-other-project/keep.txt"

echo "refuses another session's scratchpad — the id is what pins it:"
OUT=$(run "$EMPTY_HOME" "$SID" "$OTHER_SESSION_ROOT/file.txt"); STATUS=$?
assert_status   "exits 1" "1" "$STATUS"
assert_survives "the other session's work survives" "$OTHER_SESSION_ROOT/file.txt"

OUT=$(run "$EMPTY_HOME" "$SID" "$OTHER_SESSION_ROOT"); STATUS=$?
assert_status   "its root exits 1 too" "1" "$STATUS"
assert_survives "it survives" "$OTHER_SESSION_ROOT"

# A root is refused because it IS a root, and that answer cannot depend on which
# root the check happens to reach first. With one approved root inside another,
# a single loop asking both questions per root reaches the outer root first,
# matches its containment test against the inner root, and deletes the inner
# root — a scratchpad root, gone, exit 0. That was reproduced against the
# interleaved version of this check. Today's two roots cannot express the shape,
# so these fixtures do.
#
# Every group here re-seeds. A case that fails by deleting a root leaves the
# next one judging a fixture the previous case destroyed, and a cascade like
# that reports far more than it found — the whole value of these cases is
# knowing exactly which of them discriminate.
echo "refuses a root nested inside another root, whichever one is listed first:"
seed
OUT=$(run "$EMPTY_HOME" "$NEST_SID" "$PRECIOUS/keep.txt"); STATUS=$?
assert_status "an outside path still exits 1 with nested roots approved" "1" "$STATUS"
assert_before "and the outer root really is the one listed first" "$OUT" \
  "-nest-1-outer/$NEST_SID" "-nest-2-inner/$NEST_SID"

OUT=$(run "$EMPTY_HOME" "$NEST_SID" "$NEST_INNER"); STATUS=$?
assert_status   "the inner root exits 1, though the outer root contains it" "1" "$STATUS"
assert_contains "the root refusal answers, not the containment test" "$OUT" "is a scratchpad root itself"
assert_survives "the inner root survives" "$NEST_INNER"
assert_survives "and so does its content" "$NEST_INNER/file.txt"

seed
OUT=$(run "$EMPTY_HOME" "$NEST_SID" "$NEST_OUTER"); STATUS=$?
assert_status   "the outer root is refused too" "1" "$STATUS"
assert_survives "it survives" "$NEST_OUTER"
assert_survives "and so does the root nested in it" "$NEST_INNER"

seed
OUT=$(run "$EMPTY_HOME" "$NEST_REV_SID" "$PRECIOUS/keep.txt"); STATUS=$?
assert_status "the reversed pair also exits 1 on an outside path" "1" "$STATUS"
assert_before "and this pair lists the inner root first" "$OUT" \
  "-nest-1-inner/$NEST_REV_SID" "-nest-2-outer/$NEST_REV_SID"

OUT=$(run "$EMPTY_HOME" "$NEST_REV_SID" "$NEST_INNER"); STATUS=$?
assert_status   "the same refusal arrives from the other order" "1" "$STATUS"
assert_contains "for the same reason" "$OUT" "is a scratchpad root itself"
assert_survives "the inner root survives" "$NEST_INNER"

# Refusing every nested root would be the easy over-correction, and it would
# break the only thing this command is for. What is refused is a root, not the
# nesting.
echo "still deletes beneath nested roots:"
seed
OUT=$(run "$EMPTY_HOME" "$NEST_SID" "$NEST_INNER/file.txt"); STATUS=$?
assert_status "a file inside the inner root exits 0" "0" "$STATUS"
assert_gone   "it is gone" "$NEST_INNER/file.txt"

OUT=$(run "$EMPTY_HOME" "$NEST_SID" "$NEST_OUTER/file.txt"); STATUS=$?
assert_status   "a file in the outer root but outside the inner one exits 0" "0" "$STATUS"
assert_gone     "it is gone" "$NEST_OUTER/file.txt"
assert_survives "and the inner root is untouched" "$NEST_INNER"

echo "approves no session root when the id is absent or not an id:"
OUT=$(run "$EMPTY_HOME" "" "$SESSION_ROOT/file.txt"); STATUS=$?
assert_status   "unset exits 1" "1" "$STATUS"
assert_survives "the file survives" "$SESSION_ROOT/file.txt"

OUT=$(run "$EMPTY_HOME" "*" "$SESSION_ROOT/file.txt"); STATUS=$?
assert_status   "a bare glob in the id exits 1" "1" "$STATUS"
assert_survives "the file survives" "$SESSION_ROOT/file.txt"

# Without the character check on the id, this glob walks up out of the layout it
# is meant to match and approves $FAKE_TMP/$SID/scratchpad as a root. The id
# comes from the environment, so it is the one input here this script does not
# choose for itself.
OUT=$(run "$EMPTY_HOME" "../$SID" "$DECOY_ROOT/decoy.txt"); STATUS=$?
assert_status   "a \`..\` in the id names no root" "1" "$STATUS"
assert_survives "what the traversal would have reached survives" "$DECOY_ROOT/decoy.txt"

OUT=$(run "$EMPTY_HOME" "../$SID" "$SESSION_ROOT/file.txt"); STATUS=$?
assert_status   "and it does not reach the real session root either" "1" "$STATUS"
assert_survives "the file survives" "$SESSION_ROOT/file.txt"

# $HOME is the other input the script does not choose for itself, and it decides
# the persistent root. Before it was validated, a caller-chosen $HOME made any
# directory an approved root: the first case below deleted the victim and exited
# 0, with every other defence working exactly as designed. The script now reads
# the login home from the password database and accepts $HOME only when it
# resolves to the same directory.
echo "\$HOME does not decide which directory this command may delete inside:"
seed
OUT=$(run "$ESCAPE_HOME" "$SID" "$ESCAPE_HOME/Developer/scratchpad/keep.txt"); STATUS=$?
assert_status   "a \$HOME whose scratchpad is a symlink to a victim exits 1" "1" "$STATUS"
assert_survives "the victim survives" "$VICTIM/keep.txt"
assert_contains "says the home is not this account's" "$OUT" "is not this account's home directory"

OUT=$(run "$FAKE_HOME" "$SID" "$FAKE_HOME/Developer/scratchpad/file.txt"); STATUS=$?
assert_status   "a real scratchpad under a \$HOME that is not this account's exits 1" "1" "$STATUS"
assert_survives "the file survives" "$FAKE_HOME/Developer/scratchpad/file.txt"

OUT=$(run "$FAKE_HOME" "$SID" "$PRECIOUS/keep.txt"); STATUS=$?
assert_status   "exits 1" "1" "$STATUS"
refute_contains "and that \$HOME is never listed as a root" "$OUT" "$FAKE_HOME/Developer/scratchpad"

OUT=$(run "" "$SID" "$PRECIOUS/keep.txt"); STATUS=$?
assert_status   "an empty \$HOME exits 1" "1" "$STATUS"
assert_contains "says why" "$OUT" "No persistent root is approved"

OUT=$(run "$MISSING_HOME" "$SID" "$PRECIOUS/keep.txt"); STATUS=$?
assert_status   "a \$HOME that is no directory at all exits 1" "1" "$STATUS"
assert_contains "says why" "$OUT" "names no directory that exists"

OUT=$(run "$REAL_HOME" "$SID" "$PRECIOUS/keep.txt"); STATUS=$?
assert_status   "the account's own home still exits 1 on an outside path" "1" "$STATUS"
assert_contains "and the root it lists is the login home's scratchpad" "$OUT" "$REAL_HOME/Developer/scratchpad"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
