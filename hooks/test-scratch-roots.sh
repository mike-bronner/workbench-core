#!/usr/bin/env bash
# Tests for hooks/lib/scratch-roots.sh, run directly as
# $.workbench.scratchRoots() runs it: `bash scratch-roots.sh <session_id>`.
# Run directly: ./test-scratch-roots.sh
#
# These cases came from the retired bash delegation gate suite. What the
# roots mean to the delegation reminder is pinned in tests/delegation.test.ts.
# These pin the command-line door on a real file system: the session's pad for
# its own id only, no linked pad, no root for an id that could walk out of the
# tree, and the login home taken from the password database, never from $HOME.

set -u
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
RESOLVER="$HOOKS_DIR/lib/scratch-roots.sh"
PASS=0
FAIL=0

contains() { case "$2" in *"$3"*) PASS=$((PASS + 1)); echo "  ✅ $1" ;; *) FAIL=$((FAIL + 1)); echo "  ❌ $1" ;; esac; }
missing() { case "$2" in *"$3"*) FAIL=$((FAIL + 1)); echo "  ❌ $1" ;; *) PASS=$((PASS + 1)); echo "  ✅ $1" ;; esac; }

# The resolver finds a session pad only under /tmp/claude-*/ or
# /private/tmp/claude-*/, so the fixture tree has to live there.
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/scratch-roots.XXXXXX")"
TREE="/tmp/claude-sroots-test-$$"
SID="sroots-$$-aaaa"
PAD="$TREE/-fake-project/$SID/scratchpad"
OTHER_PAD="$TREE/-fake-project/sroots-$$-bbbb/scratchpad"
LINK_SID="sroots-$$-link"
mkdir -p "$PAD" "$OTHER_PAD" "$SANDBOX/outside" "$TREE/-fake-project/$LINK_SID" "$SANDBOX/home/Developer/scratchpad" "$SANDBOX/home/.claude/plans"
ln -s "$SANDBOX/outside" "$TREE/-fake-project/$LINK_SID/scratchpad"
trap 'rm -rf "$SANDBOX" "$TREE"' EXIT

REAL_PAD="$(cd -P "$PAD" && pwd -P)"
OUT="$(HOME="$SANDBOX/home" bash "$RESOLVER" "$SID")"

echo "the session's own pad, and nothing it should not name:"
contains "the session's own pad is a root" "$OUT" "$REAL_PAD"
missing "another session's pad is not" "$OUT" "$(cd -P "$OTHER_PAD" && pwd -P)"
missing "a symlinked pad is not" "$(bash "$RESOLVER" "$LINK_SID")" "$SANDBOX/outside"
missing "an id with a path separator names no session root" "$(bash "$RESOLVER" "../$SID")" "$REAL_PAD"
# A glob in the id would match every session's pad, real paths and all.
missing "an id that is a glob names no session root" "$(bash "$RESOLVER" '*')" "$REAL_PAD"

echo "the login home comes from the password database, not \$HOME:"
missing "a \$HOME-relative scratchpad does not count" "$OUT" "$SANDBOX/home/Developer/scratchpad"
missing "a \$HOME-relative plans folder does not count" "$OUT" "$SANDBOX/home/.claude/plans"
LOGIN_USER=$(id -un)
eval "LOGIN_HOME=~$LOGIN_USER"
if [ -d "$LOGIN_HOME/.claude" ]; then
  REAL_CLAUDE="$(cd -P "$LOGIN_HOME/.claude" && pwd -P)"
  # plans/ may not exist yet: its root is then the resolved .claude plus /plans.
  contains "the login home's plans folder is a root" "$OUT" "$REAL_CLAUDE/plans"
fi

echo "exit status:"
if bash "$RESOLVER" '../x' >/dev/null 2>&1; then
  PASS=$((PASS + 1)); echo "  ✅ the resolver exits 0 on a bad id"
else
  FAIL=$((FAIL + 1)); echo "  ❌ the resolver exits 0 on a bad id"
fi

echo
echo "scratch-roots: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
