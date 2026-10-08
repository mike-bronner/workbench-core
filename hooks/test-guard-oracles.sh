#!/bin/bash
# Holds tests/oracle/guard-cases.ts to the frozen bash guards under tests/oracle/.
# Run directly: ./test-guard-oracles.sh          (check)
#               ./test-guard-oracles.sh --write  (regenerate the fixture)
#
# Four bash guards moved into the hooks module: the peer message gate and the
# provisioning, summary-writer and credential guards (hooks/mods/guards.ts).
# Each is frozen, unchanged, under tests/oracle/<guard>/ as a test oracle that
# hooks/ never runs. This script:
#
#   1. runs each frozen guard's own suite, which must still pass, and records
#      every payload the suite fed the guard, with its verdict
#      (tests/oracle/record.sh);
#   2. runs tests/oracle/generate.py, which adds seeded random cases, runs
#      each through its frozen guard, and renders every refused case as
#      tests/oracle/guard-cases.ts;
#   3. compares that with the committed fixture, down to the SANDBOX marker.
#
# tests/guard-differential.test.ts then holds each port to refusing every case
# in the fixture, unless the fixture's SANDBOX half shows the command did no
# harm under both bash and zsh. That half is written only with --write, which
# runs the sandbox and needs zsh. A check needs bash, jq and python3.

set -u
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HOOKS_DIR/.." && pwd)"
ORACLE="$ROOT/tests/oracle"
FIXTURE="$ORACLE/guard-cases.ts"
MARKER='// SANDBOX: below this line'

for tool in jq python3; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "  ❌ $tool is not on PATH, so the oracle fixture cannot be checked"
    exit 1
  fi
done

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/guard-oracles.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT
# The suites build credential paths from $HOME, so they run under a home of
# their own, which generate.py writes as /Users/tester.
RUN_HOME="$SANDBOX/home"
mkdir -p "$RUN_HOME"
CASES="$SANDBOX/cases.jsonl"
: >"$CASES"

FAIL=0
for guard in credential-guard provisioning-guard summary-writer-guard peer-message-gate; do
  if HOME="$RUN_HOME" ORACLE_CASES_OUT="$CASES" bash "$ORACLE/$guard/test-$guard.sh" </dev/null >"$SANDBOX/$guard.log" 2>&1; then
    echo "  ✅ the frozen $guard passes its own suite"
  else
    FAIL=1
    echo "  ❌ the frozen $guard fails its own suite:"
    grep '❌' "$SANDBOX/$guard.log" | head -5
  fi
done
[ "$FAIL" -eq 0 ] || exit 1

if [ "${1:-}" = "--write" ]; then
  command -v zsh >/dev/null 2>&1 || { echo "  ❌ --write runs the sandbox under zsh, and zsh is not on PATH"; exit 1; }
  python3 "$ORACLE/generate.py" "$CASES" "$RUN_HOME" --sandbox >"$FIXTURE" || exit 1
  echo "  ✅ wrote $FIXTURE"
  exit 0
fi

python3 "$ORACLE/generate.py" "$CASES" "$RUN_HOME" >"$SANDBOX/fresh.ts" || { echo "  ❌ generate.py failed"; exit 1; }
if [ ! -f "$FIXTURE" ]; then
  echo "  ❌ tests/oracle/guard-cases.ts is missing; run hooks/test-guard-oracles.sh --write"
  exit 1
fi
# Everything above the marker is the oracle's half, and must match line for line.
if diff <(sed "/^${MARKER//\//\\/}/q" "$SANDBOX/fresh.ts") <(sed "/^${MARKER//\//\\/}/q" "$FIXTURE") >"$SANDBOX/diff.txt"; then
  echo "  ✅ tests/oracle/guard-cases.ts matches what the frozen guards refuse"
else
  echo "  ❌ tests/oracle/guard-cases.ts is out of date; run hooks/test-guard-oracles.sh --write:"
  head -20 "$SANDBOX/diff.txt"
  exit 1
fi

# Not one hook in hooks.json may run a guard that moved into the module.
for guard in credential-guard provisioning-guard summary-writer-guard peer-message-gate; do
  if grep -q "$guard" "$HOOKS_DIR/hooks.json" || [ -e "$HOOKS_DIR/$guard.sh" ]; then
    echo "  ❌ $guard is still a bash hook"
    exit 1
  fi
done
echo "  ✅ no bash hook runs a ported guard"
