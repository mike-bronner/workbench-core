#!/bin/bash
# Holds the guard fixtures to the frozen bash guards under tests/oracle/.
# Run directly: ./test-guard-oracles.sh          (check)
#               ./test-guard-oracles.sh --write  (regenerate the fixtures)
#
# Seven bash guards moved into the hooks module: the peer message gate and the
# provisioning, summary-writer and credential guards in batch C1
# (hooks/mods/guards.ts), and the destructive-scope, destructive-database and
# vault-git guards in batch C2 (hooks/mods/destructive-scope.ts,
# destructive-database.ts, vault-git.ts). Each is frozen, unchanged, under
# tests/oracle/<guard>/ as a test oracle that hooks/ never runs. This script:
#
#   1. runs each frozen guard's own suite, which must still pass, and records
#      every payload the suite fed the guard, with its verdict
#      (tests/oracle/record.sh);
#   2. runs tests/oracle/generate.py, which adds seeded random cases, runs
#      each through its frozen guard, and renders every refused case of the
#      first four as tests/oracle/guard-cases.ts;
#   3. compares that with the committed fixture, down to the SANDBOX marker.
#
# tests/guard-differential.test.ts then holds each port to refusing every case
# in the fixture, unless the fixture's SANDBOX half shows the command did no
# harm under both bash and zsh. That half is written only with --write, which
# runs the sandbox and needs zsh. A check needs bash, jq and python3.
#
# THE C2 GUARDS READ THE DISK AND GIT, so their cases carry the sandbox their
# suite built, whose paths differ on every run and every machine. Their
# fixture, tests/oracle/world-cases.ts, is written only with --write: then
# record.sh runs tests/oracle/port-facts.js beside each refused call, in the
# suite's own environment, to record what the port made of it and the facts it
# asked about, and generate.py adds random lines run in a sandbox it builds.
# That needs deno too. A check runs their frozen suites, which must pass, and
# requires the fixture to exist and to hold cases of each.

set -u
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HOOKS_DIR/.." && pwd)"
ORACLE="$ROOT/tests/oracle"
FIXTURE="$ORACLE/guard-cases.ts"
WORLD_FIXTURE="$ORACLE/world-cases.ts"
MARKER='// SANDBOX: below this line'
GUARDS="credential-guard provisioning-guard summary-writer-guard peer-message-gate destructive-scope-guard destructive-database-guard vault-git-guard"
WORLD_GUARDS="destructive-scope-guard destructive-database-guard vault-git-guard"

for tool in jq python3; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "  ❌ $tool is not on PATH, so the oracle fixture cannot be checked"
    exit 1
  fi
done
WRITE=no
if [ "${1:-}" = "--write" ]; then
  WRITE=yes
  for tool in zsh deno; do
    command -v "$tool" >/dev/null 2>&1 || { echo "  ❌ --write needs $tool, and it is not on PATH"; exit 1; }
  done
fi

# macOS ends TMPDIR in a slash. Drop it, so the sandbox path holds no //: the
# ports fold // in the paths they ask about, and generate.py could not map
# those back to the fixture's home.
TMP_BASE="${TMPDIR:-/tmp}"
SANDBOX="$(mktemp -d "${TMP_BASE%/}/guard-oracles.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT
# The suites build credential paths from $HOME, so they run under a home of
# their own, which generate.py writes as /Users/tester.
RUN_HOME="$SANDBOX/home"
mkdir -p "$RUN_HOME"
CASES="$SANDBOX/cases.jsonl"
: >"$CASES"

FAIL=0
for guard in $GUARDS; do
  WORLD_FACTS=""
  case " $WORLD_GUARDS " in *" $guard "*) [ "$WRITE" = yes ] && WORLD_FACTS=1 ;; esac
  if HOME="$RUN_HOME" ORACLE_CASES_OUT="$CASES" ORACLE_WORLD_FACTS="$WORLD_FACTS" \
     bash "$ORACLE/$guard/test-$guard.sh" </dev/null >"$SANDBOX/$guard.log" 2>&1; then
    echo "  ✅ the frozen $guard passes its own suite"
  else
    FAIL=1
    echo "  ❌ the frozen $guard fails its own suite:"
    grep '❌' "$SANDBOX/$guard.log" | head -5
  fi
done
[ "$FAIL" -eq 0 ] || exit 1

if [ "$WRITE" = yes ]; then
  python3 "$ORACLE/generate.py" "$CASES" "$RUN_HOME" --sandbox --world "$WORLD_FIXTURE" >"$FIXTURE" || exit 1
  echo "  ✅ wrote $FIXTURE and $WORLD_FIXTURE"
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

# The world fixture holds refused cases of each C2 guard, from its suite and
# at random.
for guard in $WORLD_GUARDS; do
  if grep -q "\"guard\": \"$guard\", \"source\": \"suite\"" "$WORLD_FIXTURE" 2>/dev/null \
     && grep -q "\"guard\": \"$guard\", \"source\": \"random\"" "$WORLD_FIXTURE" 2>/dev/null; then
    echo "  ✅ tests/oracle/world-cases.ts holds suite and random cases of $guard"
  else
    echo "  ❌ tests/oracle/world-cases.ts holds no suite or no random case of $guard; run hooks/test-guard-oracles.sh --write"
    exit 1
  fi
done

# Not one hook in hooks.json may run a guard that moved into the module.
for guard in $GUARDS; do
  if grep -q "$guard" "$HOOKS_DIR/hooks.json" || [ -e "$HOOKS_DIR/$guard.sh" ]; then
    echo "  ❌ $guard is still a bash hook"
    exit 1
  fi
done
echo "  ✅ no bash hook runs a ported guard"
