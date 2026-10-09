#!/bin/bash
# Holds hooks/test-guard-oracles.sh to its stamp, tests/oracle/fixtures.sha256.
# Run directly: ./test-guard-oracle-stamp.sh
#
# The check skips the frozen suites while the stamp matches, so this test
# proves that a change under tests/oracle/ still fails it. It runs the check
# on a copy of tests/oracle/ whose suites and generate.py are stubs, so it
# takes a second, not minutes: each stub suite passes, and the stub generate.py
# prints the file named by STUB_FRESH, which stands for what the frozen guards
# refuse.

set -u
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HOOKS_DIR/.." && pwd)"
PASS=0
FAIL=0

TMP_BASE="${TMPDIR:-/tmp}"
SANDBOX="$(mktemp -d "${TMP_BASE%/}/guard-oracle-stamp.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT

COPY="$SANDBOX/repo"
mkdir -p "$COPY/hooks" "$COPY/tests"
cp "$HOOKS_DIR/test-guard-oracles.sh" "$HOOKS_DIR/hooks.json" "$COPY/hooks/"
cp -R "$ROOT/tests/oracle" "$COPY/tests/oracle"
rm -f "$COPY/tests/oracle/fixtures.sha256"
for suite in "$COPY"/tests/oracle/*/test-*.sh; do
  printf '#!/bin/bash\nexit 0\n' >"$suite"
done
printf 'import os, sys\nsys.stdout.write(open(os.environ["STUB_FRESH"]).read())\n' \
  >"$COPY/tests/oracle/generate.py"
FIXTURE="$COPY/tests/oracle/guard-cases.ts"
FRESH="$SANDBOX/fresh.ts"
cp "$FIXTURE" "$FRESH"
cp -R "$COPY/tests/oracle" "$SANDBOX/pristine"
MARKER='// SANDBOX: below this line'

OUT=""
CODE=0
run_check() {
  OUT="$(STUB_FRESH="$FRESH" bash "$COPY/hooks/test-guard-oracles.sh" 2>&1)"
  CODE=$?
}

expect() {  # expect <label> <exit code> <text the output must hold>
  if [ "$CODE" -eq "$2" ] && printf '%s' "$OUT" | grep -qF -- "$3"; then
    PASS=$((PASS + 1)); echo "  ✅ $1"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $1 (exit $CODE, wanted $2 and \"$3\"):"
    printf '%s\n' "$OUT" | sed 's/^/      /' | tail -6
  fi
}

restore() {  # put the copy back as it was, and prove it once more
  rm -rf "$COPY/tests/oracle"
  cp -R "$SANDBOX/pristine" "$COPY/tests/oracle"
  cp "$FIXTURE" "$FRESH"
  run_check; run_check
}

# With no stamp, the full check runs, writes the stamp, and fails.
run_check
expect "with no stamp the full check runs" 1 "the frozen credential-guard passes its own suite"
expect "with no stamp the check fails until the stamp is committed" 1 "fixtures.sha256 was out of date"
if [ -s "$COPY/tests/oracle/fixtures.sha256" ]; then
  PASS=$((PASS + 1)); echo "  ✅ the full check wrote the stamp"
else
  FAIL=$((FAIL + 1)); echo "  ❌ the full check wrote no stamp"
fi

# With the stamp current, the frozen suites are skipped.
run_check
expect "with the stamp current the check passes" 0 "matches fixtures.sha256"
if printf '%s' "$OUT" | grep -q "passes its own suite"; then
  FAIL=$((FAIL + 1)); echo "  ❌ the frozen suites ran with the stamp current"
else
  PASS=$((PASS + 1)); echo "  ✅ with the stamp current the frozen suites are skipped"
fi

# A frozen guard changes what it refuses, and the fixture is not regenerated.
echo '# a change to the frozen guard' >>"$COPY/tests/oracle/credential-guard/credential-guard.sh"
awk -v m="$MARKER" 'index($0, m) == 1 { print "// a case the guard now refuses" } { print }' \
  "$FIXTURE" >"$FRESH"
STAMP_BEFORE="$(cat "$COPY/tests/oracle/fixtures.sha256")"
run_check
expect "a changed frozen guard with a stale fixture fails the check" 1 "guard-cases.ts is out of date"
if [ "$(cat "$COPY/tests/oracle/fixtures.sha256")" = "$STAMP_BEFORE" ]; then
  PASS=$((PASS + 1)); echo "  ✅ a failed full check leaves the stamp alone"
else
  FAIL=$((FAIL + 1)); echo "  ❌ a failed full check rewrote the stamp"
fi
restore

# A frozen guard changes, and its own suite no longer passes.
printf '#!/bin/bash\necho "  ❌ a stub failure"\nexit 1\n' \
  >"$COPY/tests/oracle/vault-git-guard/test-vault-git-guard.sh"
run_check
expect "a frozen suite that fails after a change fails the check" 1 "the frozen vault-git-guard fails its own suite"
restore

# Someone edits the fixture by hand, above the marker.
sed -i.bak '3s/$/ /' "$FIXTURE" && rm -f "$FIXTURE.bak"
run_check
expect "a hand edit above the marker fails the check" 1 "guard-cases.ts is out of date"
restore

# Someone edits the fixture by hand, below the marker, or edits world-cases.ts.
echo '// a hand edit' >>"$FIXTURE"
run_check
expect "a hand edit below the marker fails the check" 1 "fixtures.sha256 was out of date"
restore
echo '// a hand edit' >>"$COPY/tests/oracle/world-cases.ts"
run_check
expect "a hand edit to world-cases.ts fails the check" 1 "fixtures.sha256 was out of date"

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
