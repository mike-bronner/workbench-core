#!/bin/bash
# Tests for hooks/lib/memory-vacuum.sh — the gated, cooled-down full VACUUM.
# Run directly: ./test-memory-vacuum.sh
# Builds a real (small) sqlite index with a known freelist and drives
# memory_vacuum through its gates: freelist threshold, once/day cooldown, stamp
# write-on-success, and the never-fail skip paths (no sqlite3, absent file).
# No server, no network — sqlite3 only.

set -u
LIB="$(cd "$(dirname "$0")" && pwd)/lib/memory-vacuum.sh"
PASS=0
FAIL=0

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "SKIP: sqlite3 not on PATH (the lib itself skips too)"
  exit 0
fi

SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

# build_index <path> — create a sqlite db, fill then delete rows so it carries a
# multi-MB freelist (so a sub-MB threshold trips VACUUM, a huge one skips).
build_index() {
  local db="$1"
  rm -f "$db"
  sqlite3 "$db" "PRAGMA page_size=4096;
    CREATE TABLE t(x TEXT);
    INSERT INTO t SELECT randomblob(2000)
      FROM (WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<5000) SELECT n FROM c);
    DELETE FROM t;" 2>/dev/null
}

# run_vacuum <index> [env assignments...] — call memory_vacuum capturing its log
# output (the lib logs via a stderr logger).
run_vacuum() {
  local index="$1"; shift
  env "$@" bash -c '. "'"$LIB"'"; memory_vacuum "'"$index"'"' 2>&1
}

assert_contains() {
  local desc="$1" output="$2" needle="$3"
  if printf '%s' "$output" | grep -qF "$needle"; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected: $needle — got: $output"
  fi
}

assert_file() {
  local desc="$1" path="$2"
  if [ -f "$path" ]; then PASS=$((PASS + 1)); echo "  ✅ $desc"
  else FAIL=$((FAIL + 1)); echo "  ❌ $desc — missing: $path"; fi
}

assert_no_file() {
  local desc="$1" path="$2"
  if [ ! -f "$path" ]; then PASS=$((PASS + 1)); echo "  ✅ $desc"
  else FAIL=$((FAIL + 1)); echo "  ❌ $desc — should be absent: $path"; fi
}

assert_no_dir() {
  local desc="$1" path="$2"
  if [ ! -d "$path" ]; then PASS=$((PASS + 1)); echo "  ✅ $desc"
  else FAIL=$((FAIL + 1)); echo "  ❌ $desc — dir should be absent: $path"; fi
}

# run_vacuum_locked <index> [env...] — call the race-guarded wrapper the stdio
# launcher uses, capturing its stderr log.
run_vacuum_locked() {
  local index="$1"; shift
  env "$@" bash -c '. "'"$LIB"'"; memory_vacuum_locked "'"$index"'"' 2>&1
}

assert_no_run() {
  local desc="$1" output="$2"
  if printf '%s' "$output" | grep -qF "running VACUUM"; then
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — VACUUM ran but should have been skipped"
  else
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  fi
}

echo "freelist over threshold → VACUUM runs, file shrinks, stamp written:"
IDX="$SANDBOX/over/vault-index.sqlite"; mkdir -p "$SANDBOX/over"
build_index "$IDX"
BEFORE=$(wc -c < "$IDX" | tr -d ' ')
OUT=$(run_vacuum "$IDX" WORKBENCH_MEMORY_VACUUM_THRESHOLD_MB=1)
AFTER=$(wc -c < "$IDX" | tr -d ' ')
assert_contains "logs that it ran VACUUM" "$OUT" "running VACUUM"
assert_contains "logs reclamation"        "$OUT" "reclaimed index space"
assert_file     "stamp written on success" "$SANDBOX/over/.last-vacuum"
if [ "$AFTER" -lt "$BEFORE" ]; then
  PASS=$((PASS + 1)); echo "  ✅ file shrank ($BEFORE → $AFTER bytes)"
else
  FAIL=$((FAIL + 1)); echo "  ❌ file did not shrink ($BEFORE → $AFTER)"
fi

echo "freelist under threshold → skip, no stamp:"
IDX="$SANDBOX/under/vault-index.sqlite"; mkdir -p "$SANDBOX/under"
build_index "$IDX"
OUT=$(run_vacuum "$IDX" WORKBENCH_MEMORY_VACUUM_THRESHOLD_MB=500)
assert_contains "logs under-threshold skip" "$OUT" "under 500MB threshold; skipping"
assert_no_file  "no stamp when skipped"     "$SANDBOX/under/.last-vacuum"

echo "cooldown active → skip even when freelist is over threshold:"
IDX="$SANDBOX/cool/vault-index.sqlite"; mkdir -p "$SANDBOX/cool"
build_index "$IDX"
touch "$SANDBOX/cool/.last-vacuum"   # fresh stamp = inside the 24h window
OUT=$(run_vacuum "$IDX" WORKBENCH_MEMORY_VACUUM_THRESHOLD_MB=1)
assert_contains "logs cooldown skip" "$OUT" "cooldown; skipping"

echo "cooldown expired → VACUUM runs again:"
# Backdate the stamp well past the (overridden, tiny) cooldown window.
touch -t 202001010000 "$SANDBOX/cool/.last-vacuum"
OUT=$(run_vacuum "$IDX" WORKBENCH_MEMORY_VACUUM_THRESHOLD_MB=1 WORKBENCH_MEMORY_VACUUM_COOLDOWN_HOURS=1)
assert_contains "runs after cooldown expiry" "$OUT" "running VACUUM"

echo "absent index → skip, never fail:"
OUT=$(run_vacuum "$SANDBOX/nope/vault-index.sqlite")
RC=$?
assert_contains "logs absent-index skip" "$OUT" "index not present yet"
[ "$RC" -eq 0 ] && { PASS=$((PASS+1)); echo "  ✅ returns 0 on absent index"; } || { FAIL=$((FAIL+1)); echo "  ❌ non-zero on absent index"; }

echo "sqlite3 missing → skip, never fail (PATH stripped of sqlite3):"
# Point PATH at a dir with every tool the lib (and the bash invocation) needs,
# but deliberately WITHOUT sqlite3 — so `command -v sqlite3` fails and the lib
# takes its skip path.
STUBBIN="$SANDBOX/stubbin"; mkdir -p "$STUBBIN"
for tool in bash find touch cat grep dirname; do
  src=$(command -v "$tool"); [ -n "$src" ] && ln -sf "$src" "$STUBBIN/$tool"
done
OUT=$(PATH="$STUBBIN" bash -c '. "'"$LIB"'"; memory_vacuum "'"$SANDBOX"'/over/vault-index.sqlite"' 2>&1)
RC=$?
assert_contains "logs sqlite3-missing skip" "$OUT" "sqlite3 not on PATH"
[ "$RC" -eq 0 ] && { PASS=$((PASS+1)); echo "  ✅ returns 0 when sqlite3 absent"; } || { FAIL=$((FAIL+1)); echo "  ❌ non-zero when sqlite3 absent"; }

echo "locked wrapper: free lock → VACUUM runs and the lock is released:"
IDX="$SANDBOX/lockfree/vault-index.sqlite"; mkdir -p "$SANDBOX/lockfree"
build_index "$IDX"
OUT=$(run_vacuum_locked "$IDX" WORKBENCH_MEMORY_VACUUM_THRESHOLD_MB=1)
assert_contains "runs VACUUM when the lock is free" "$OUT" "running VACUUM"
assert_no_dir   "lock dir released after the run"    "$SANDBOX/lockfree/vacuum.lock"

echo "locked wrapper: lock held by a LIVE pid → skip, holder untouched:"
IDX="$SANDBOX/lockheld/vault-index.sqlite"; mkdir -p "$SANDBOX/lockheld"
build_index "$IDX"
mkdir -p "$SANDBOX/lockheld/vacuum.lock"
sleep 60 & HOLDER=$!
disown 2>/dev/null || true   # silence the job-control "Terminated" notice on kill
echo "$HOLDER" > "$SANDBOX/lockheld/vacuum.lock/pid"
OUT=$(run_vacuum_locked "$IDX" WORKBENCH_MEMORY_VACUUM_THRESHOLD_MB=1)
kill "$HOLDER" 2>/dev/null
assert_contains "logs the live-holder skip" "$OUT" "held by live pid"
assert_no_run   "does not VACUUM under a live lock" "$OUT"
assert_file     "live holder's lock left intact" "$SANDBOX/lockheld/vacuum.lock/pid"

echo "locked wrapper: STALE lock (dead pid) → stolen, VACUUM runs, lock released:"
IDX="$SANDBOX/lockstale/vault-index.sqlite"; mkdir -p "$SANDBOX/lockstale"
build_index "$IDX"
mkdir -p "$SANDBOX/lockstale/vacuum.lock"
# A guaranteed-dead pid: spawn a trivial child, then reap it so kill -0 fails.
sh -c 'exit 0' & DEAD=$!; wait "$DEAD" 2>/dev/null
echo "$DEAD" > "$SANDBOX/lockstale/vacuum.lock/pid"
OUT=$(run_vacuum_locked "$IDX" WORKBENCH_MEMORY_VACUUM_THRESHOLD_MB=1)
assert_contains "steals the stale lock"          "$OUT" "stealing stale lock"
assert_contains "runs VACUUM after the steal"    "$OUT" "running VACUUM"
assert_no_dir   "lock released after stolen run" "$SANDBOX/lockstale/vacuum.lock"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
