#!/bin/bash
# Tests for session-log.sh summary-writer dispatch. Run directly: ./test-session-log.sh
# Uses WORKBENCH_DISPATCH_DRY_RUN=1 so the dispatch prints its resolved
# invocation (cwd, env, args) instead of spawning a real claude — letting us
# assert that the detached writer is anchored to the vault (the summary-misroute
# regression) without launching anything.
#
# The central contract here is WHICH log writes dispatch and which do not.
# mode=final (SessionEnd) must NOT spawn: a child started as the parent exits is
# killed during teardown, which stranded 968 markers between 2026-07-31 and
# 2026-08-14. It must still write the marker, because session-warmup.sh's drain
# is what actually gets those sessions summarized.

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

# $1: extra env assignment (e.g. WORKBENCH_AUTO_SUMMARIZE=1)
# $2: hook_event_name (default SessionEnd)
# $3: session_id (default testsid) — distinct ids keep marker assertions from
#     colliding with the rolling checkpoint state left by a previous case.
run_dispatch() {
  local extra_env="$1" event="${2:-SessionEnd}" sid="${3:-testsid}"
  printf '{"session_id":"%s","transcript_path":"%s","hook_event_name":"%s"}' \
    "$sid" "$TRANSCRIPT" "$event" | \
    env HOME="$SANDBOX/home" \
      PATH="$SANDBOX/bin:$PATH" \
      WORKBENCH_MEMORY_PATH="$SANDBOX/memory" \
      WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" \
      WORKBENCH_DISPATCH_DRY_RUN=1 \
      $extra_env \
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

assert_file() {
  local desc="$1" path="$2"
  if [ -f "$path" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected file: $path"
  fi
}

echo "PreCompact (mode=checkpoint) — dispatches, anchored to the vault:"
OUT=$(run_dispatch "WORKBENCH_AUTO_SUMMARIZE=1" "PreCompact" "sid-precompact")
assert_contains "runs from the vault dir"              "$OUT" "DISPATCH cwd=$SANDBOX/memory"
assert_contains "child inherits WORKBENCH_MEMORY_PATH" "$OUT" "WORKBENCH_MEMORY_PATH=$SANDBOX/memory"
assert_contains "child is flagged for the Bash guard"  "$OUT" "WORKBENCH_SUMMARY_WRITER=1"
assert_contains "grants the vault via --add-dir"       "$OUT" "--add-dir $SANDBOX/memory"
assert_contains "defaults to the sonnet model"         "$OUT" "DISPATCH model=sonnet"
assert_contains "carries the session id"               "$OUT" "DISPATCH sid=sid-precompact"

echo "PreCompact — output goes to a dispatch log, not /dev/null:"
# The two-week silent failure was only invisible because every byte the child
# produced was discarded. Assert the real resolved path, and assert the name
# does NOT match the summary-writer-*.log glob that session-warmup.sh deletes
# on every startup — that glob would silently eat this file.
assert_contains "logfile resolves under the cache"     "$OUT" "DISPATCH logfile=$SANDBOX/cache/summary-dispatch-errors.log"
assert_missing  "logfile is not /dev/null"             "$OUT" "logfile=/dev/null"
LOGNAME_LEAF="$(printf '%s' "$OUT" | sed -n 's|^DISPATCH logfile=.*/||p')"
case "$LOGNAME_LEAF" in
  summary-writer-*.log)
    FAIL=$((FAIL + 1)); echo "  ❌ logfile name is eaten by the startup legacy-log sweep" ;;
  *)
    PASS=$((PASS + 1)); echo "  ✅ logfile name survives the startup legacy-log sweep" ;;
esac

echo "ManualLogNow event name ALONE resolves to final — no dispatch:"
# Documents a live trap rather than asserting a wish. /log-now names its event
# ManualLogNow but the case statement has no arm for it, so the name alone falls
# through to `*) MODE="final"` and skips the spawn. In practice /log-now also
# sets WORKBENCH_LOG_MODE=manual, which is what actually carries the dispatch
# (asserted below) — the event name is decorative. If an arm for ManualLogNow is
# ever added, this assertion is the one that should flip.
OUT=$(run_dispatch "WORKBENCH_AUTO_SUMMARIZE=1" "ManualLogNow" "sid-manual")
assert_missing "event name alone does not dispatch"    "$OUT" "DISPATCH sid=sid-manual"
assert_file    "but the marker is still written"       "$SANDBOX/cache/pending-summaries/sid-manual.json"

echo "SessionEnd (mode=final) — marker written, NO dispatch:"
OUT=$(run_dispatch "WORKBENCH_AUTO_SUMMARIZE=1" "SessionEnd" "sid-final")
assert_missing "no writer spawned at teardown"         "$OUT" "DISPATCH cwd="
assert_missing "not even a sid line"                   "$OUT" "DISPATCH sid="
# The marker is the whole reason skipping the spawn is safe — without it the
# session is lost outright rather than deferred to the next start.
assert_file    "marker still written for the drain"    "$SANDBOX/cache/pending-summaries/sid-final.json"

echo "Unrecognised event falls through to final — no dispatch:"
# MODE defaults to final for any unknown event, so a future teardown-time hook
# inherits the safe path instead of the one that loses work.
OUT=$(run_dispatch "WORKBENCH_AUTO_SUMMARIZE=1" "SomeFutureTeardownEvent" "sid-unknown")
assert_missing "unknown event does not spawn"          "$OUT" "DISPATCH cwd="
assert_file    "unknown event still writes a marker"   "$SANDBOX/cache/pending-summaries/sid-unknown.json"

echo "WORKBENCH_LOG_MODE=manual overrides a SessionEnd payload:"
# /log-now sets the mode explicitly. Even if it arrived carrying a SessionEnd
# event name, the explicit mode must win and the dispatch must happen.
OUT=$(run_dispatch "WORKBENCH_AUTO_SUMMARIZE=1 WORKBENCH_LOG_MODE=manual" "SessionEnd" "sid-modeoverride")
assert_contains "explicit manual mode dispatches"      "$OUT" "DISPATCH sid=sid-modeoverride"

echo "auto-summarize off — no dispatch:"
OUT=$(run_dispatch "WORKBENCH_AUTO_SUMMARIZE=0" "PreCompact" "sid-off")
assert_missing "no writer dispatched when disabled"    "$OUT" "DISPATCH cwd="

echo "disposable-workspace filter — scratch/eval roots produce no marker:"
# 2026-08-19: one `.../scratchpad/evalroot` fixture produced 274 of 332
# processable markers. These are real sessions with real prompts, so the
# summary-writer's idle-tick check correctly passes them — the filter has to be
# here, at the source, or the noise is only rejected after costing an agent each.
run_scratch() {
  local sid="$1" transcript="$2"
  printf '{"line":1}\n{"line":2}\n' > "$transcript"
  printf '{"session_id":"%s","transcript_path":"%s","hook_event_name":"SessionEnd"}' \
    "$sid" "$transcript" | \
    env HOME="$SANDBOX/home" PATH="$SANDBOX/bin:$PATH" \
      WORKBENCH_MEMORY_PATH="$SANDBOX/memory" WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" \
      WORKBENCH_DISPATCH_DRY_RUN=1 WORKBENCH_AUTO_SUMMARIZE=1 \
      bash "$LOG_HOOK" >/dev/null 2>&1
}

assert_no_file() {
  local desc="$1" path="$2"
  if [ -e "$path" ]; then
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — marker should NOT exist: $path"
  else
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  fi
}

mkdir -p "$SANDBOX/scratchpad/evalroot" "$SANDBOX/probe-root" \
         "$SANDBOX/projects/-private-tmp-claude-503--Users-mike-scratchpad-evalroot"

run_scratch "sid-evalroot" "$SANDBOX/scratchpad/evalroot/t.jsonl"
assert_no_file "scratchpad/evalroot writes no marker" "$SANDBOX/cache/pending-summaries/sid-evalroot.json"

run_scratch "sid-proberoot" "$SANDBOX/probe-root/t.jsonl"
assert_no_file "probe-root writes no marker"          "$SANDBOX/cache/pending-summaries/sid-proberoot.json"

# Claude Code flattens the session cwd into the transcript DIRECTORY name, so a
# scratch cwd never appears as a real path component — this is the shape that
# actually occurs in `~/.claude/projects/`, and the one a naive `*/scratchpad/*`
# glob alone would miss.
run_scratch "sid-flattened" \
  "$SANDBOX/projects/-private-tmp-claude-503--Users-mike-scratchpad-evalroot/t.jsonl"
assert_no_file "flattened scratch cwd writes no marker" "$SANDBOX/cache/pending-summaries/sid-flattened.json"

# Guard against over-matching: a real project must still be logged. This is the
# assertion that fails if the filter globs ever widen carelessly.
mkdir -p "$SANDBOX/projects/-Users-mike-Developer-workbench-core"
run_scratch "sid-realproject" \
  "$SANDBOX/projects/-Users-mike-Developer-workbench-core/t.jsonl"
assert_file "real project still writes a marker"      "$SANDBOX/cache/pending-summaries/sid-realproject.json"

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
