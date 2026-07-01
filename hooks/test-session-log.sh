#!/bin/bash
# Tests for session-log.sh summary-writer dispatch. Run directly: ./test-session-log.sh
# Uses WORKBENCH_DISPATCH_DRY_RUN=1 so the dispatch prints its resolved
# invocation (cwd, env, args) instead of spawning a real claude — letting us
# assert that the detached writer is anchored to the vault (the summary-misroute
# regression) without launching anything.

set -u
LOG_HOOK="$(cd "$(dirname "$0")" && pwd)/session-log.sh"
PASS=0
FAIL=0

SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

# Sandbox: fake HOME so config resolution never reads the real one; a fake
# `claude` on PATH so `command -v claude` succeeds (dry-run never invokes it);
# a synthetic transcript so the log-write path runs to the dispatch block.
mkdir -p "$SANDBOX/home" "$SANDBOX/memory" "$SANDBOX/cache" "$SANDBOX/bin"
printf '#!/bin/sh\nexit 0\n' > "$SANDBOX/bin/claude"
chmod +x "$SANDBOX/bin/claude"
TRANSCRIPT="$SANDBOX/transcript.jsonl"
printf '{"line":1}\n{"line":2}\n' > "$TRANSCRIPT"

run_dispatch() {
  # $1: extra env assignment (e.g. WORKBENCH_AUTO_SUMMARIZE=1)
  printf '{"session_id":"testsid","transcript_path":"%s","hook_event_name":"SessionEnd"}' "$TRANSCRIPT" | \
    env HOME="$SANDBOX/home" \
      PATH="$SANDBOX/bin:$PATH" \
      WORKBENCH_MEMORY_PATH="$SANDBOX/memory" \
      WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" \
      WORKBENCH_DISPATCH_DRY_RUN=1 \
      $1 \
      bash "$LOG_HOOK" 2>/dev/null
}

assert_contains() {
  local desc="$1" output="$2" needle="$3"
  if printf '%s' "$output" | grep -qF -- "$needle"; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected to find: $needle"
  fi
}

assert_missing() {
  local desc="$1" output="$2" needle="$3"
  if printf '%s' "$output" | grep -qF -- "$needle"; then
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — should NOT contain: $needle"
  else
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  fi
}

echo "auto-summarize on — detached writer is anchored to the vault:"
OUT=$(run_dispatch "WORKBENCH_AUTO_SUMMARIZE=1")
assert_contains "runs from the vault dir"              "$OUT" "DISPATCH cwd=$SANDBOX/memory"
assert_contains "child inherits WORKBENCH_MEMORY_PATH" "$OUT" "WORKBENCH_MEMORY_PATH=$SANDBOX/memory"
assert_contains "child is flagged for the Bash guard"  "$OUT" "WORKBENCH_SUMMARY_WRITER=1"
assert_contains "grants the vault via --add-dir"       "$OUT" "--add-dir $SANDBOX/memory"
assert_contains "defaults to the sonnet model"         "$OUT" "DISPATCH model=sonnet"

echo "auto-summarize off — no dispatch:"
OUT=$(run_dispatch "WORKBENCH_AUTO_SUMMARIZE=0")
assert_missing "no writer dispatched when disabled"    "$OUT" "DISPATCH cwd="

echo "exit code is always 0:"
if printf '{"session_id":"testsid","transcript_path":"%s","hook_event_name":"SessionEnd"}' "$TRANSCRIPT" | \
    env HOME="$SANDBOX/home" PATH="$SANDBOX/bin:$PATH" \
      WORKBENCH_MEMORY_PATH="$SANDBOX/memory" WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" \
      WORKBENCH_DISPATCH_DRY_RUN=1 WORKBENCH_AUTO_SUMMARIZE=1 \
      bash "$LOG_HOOK" >/dev/null 2>&1; then
  PASS=$((PASS + 1)); echo "  ✅ exits 0"
else
  FAIL=$((FAIL + 1)); echo "  ❌ exited non-zero"
fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
