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

assert_no_file() {
  local desc="$1" path="$2"
  if [ -e "$path" ]; then
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — marker should NOT exist: $path"
  else
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  fi
}

echo "PreCompact (mode=checkpoint) — dispatches, anchored to the vault:"
OUT=$(run_dispatch "WORKBENCH_AUTO_SUMMARIZE=1" "PreCompact" "sid-precompact")
assert_contains "runs from the vault dir"              "$OUT" "DISPATCH cwd=$SANDBOX/memory"
assert_contains "child inherits WORKBENCH_MEMORY_PATH" "$OUT" "WORKBENCH_MEMORY_PATH=$SANDBOX/memory"
assert_contains "child is flagged for the Bash guard"  "$OUT" "WORKBENCH_SUMMARY_WRITER=1"
assert_contains "child loads no CLAUDE.md"            "$OUT" "DISPATCH env CLAUDE_CODE_DISABLE_CLAUDE_MDS=1"
assert_contains "agent file omits CLAUDE.md as a sub-agent" \
  "$(sed -n '/^---$/,/^---$/p' "$(dirname "$0")/../agents/summary-writer.md")" "omitClaudeMd: true"
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

echo "mode=reconcile — writes the marker, NO dispatch, names the reconciler:"
# The reconciler runs inside session-warmup.sh just before the drain, and the
# drain takes the marker from there. A spawn here would be a second writer.
OUT=$(run_dispatch "WORKBENCH_AUTO_SUMMARIZE=1 WORKBENCH_LOG_MODE=reconcile" "Reconcile" "sid-reconcile")
assert_missing "reconcile does not spawn"              "$OUT" "DISPATCH sid="
assert_file    "reconcile still writes the marker"     "$SANDBOX/cache/pending-summaries/sid-reconcile.json"
assert_contains "the marker's origin is reconciler" \
  "$(jq -r .origin "$SANDBOX/cache/pending-summaries/sid-reconcile.json" 2>/dev/null)" "reconciler"

echo "the SessionEnd reason is recorded on the marker:"
printf '{"session_id":"sid-reason","transcript_path":"%s","hook_event_name":"SessionEnd","reason":"prompt_input_exit"}' \
  "$TRANSCRIPT" | env HOME="$SANDBOX/home" WORKBENCH_MEMORY_PATH="$SANDBOX/memory" \
    WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" bash "$LOG_HOOK" >/dev/null 2>&1
REASON_MARKER="$SANDBOX/cache/pending-summaries/sid-reason.json"
assert_contains "reason carried from the payload" "$(jq -r .reason "$REASON_MARKER" 2>/dev/null)" "prompt_input_exit"
assert_contains "a hook-written marker names session-log" "$(jq -r .origin "$REASON_MARKER" 2>/dev/null)" "session-log"
# A normal write stores no reason and no open deferral, so the reason cannot
# outlive the segment it belongs to.
assert_no_file "a normal write leaves no deferral" "$SANDBOX/cache/log-checkpoints/sid-reason.deferred"
OUT=$(run_dispatch "" "SessionEnd" "sid-noreason")
assert_contains "no reason in the payload records null" \
  "$(jq -c .reason "$SANDBOX/cache/pending-summaries/sid-noreason.json" 2>/dev/null)" "null"

echo "a reason with quotes cannot break the marker JSON:"
printf '{"session_id":"sid-quote","transcript_path":"%s","hook_event_name":"SessionEnd","reason":"a\\"b"}' \
  "$TRANSCRIPT" | env HOME="$SANDBOX/home" WORKBENCH_MEMORY_PATH="$SANDBOX/memory" \
    WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" bash "$LOG_HOOK" >/dev/null 2>&1
assert_contains "the marker parses and keeps the quote" \
  "$(jq -r .reason "$SANDBOX/cache/pending-summaries/sid-quote.json" 2>/dev/null)" 'a"b'

echo "the segment copy is exactly lines next_line..end:"
SEG_T="$SANDBOX/seg.jsonl"
printf '{"n":1}\n{"n":2}\n{"n":3}\n{"n":4}\n{"n":5}\n' > "$SEG_T"
mkdir -p "$SANDBOX/cache/log-checkpoints"
printf '{"session_id":"sid-seg","next_line":3}\n' > "$SANDBOX/cache/log-checkpoints/sid-seg.json"
printf '{"session_id":"sid-seg","transcript_path":"%s","hook_event_name":"SessionEnd"}' "$SEG_T" | \
  env HOME="$SANDBOX/home" WORKBENCH_MEMORY_PATH="$SANDBOX/memory" \
    WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" bash "$LOG_HOOK" >/dev/null 2>&1
SEG_LOG=$(jq -r .last_log_file "$SANDBOX/cache/log-checkpoints/sid-seg.json" 2>/dev/null)
SEG_BODY=$(sed -n '/^```jsonl$/,/^```$/p' "$SEG_LOG" 2>/dev/null | grep '^{')
if [ "$SEG_BODY" = "$(printf '{"n":3}\n{"n":4}\n{"n":5}')" ]; then
  PASS=$((PASS + 1)); echo "  ✅ lines 3-5 copied, nothing before, nothing missing"
else
  FAIL=$((FAIL + 1)); echo "  ❌ segment body wrong: $SEG_BODY"
fi
assert_contains "the checkpoint advances past the end" \
  "$(jq -r .next_line "$SANDBOX/cache/log-checkpoints/sid-seg.json")" "6"
# BSD `tail -n +N` took 1.5 s on a 42 MB transcript where sed takes 30 ms. The
# speed is not observable in a unit test, so pin the source: the slow form must
# not come back.
assert_missing "the copy does not use tail -n +N" "$(grep -v '^[[:space:]]*#' "$LOG_HOOK")" 'tail -n'

echo "exit-budget cap — a transcript past the cap is deferred, not copied:"
printf '{"session_id":"sid-cap","transcript_path":"%s","hook_event_name":"SessionEnd","reason":"other"}' "$TRANSCRIPT" | \
  env HOME="$SANDBOX/home" WORKBENCH_MEMORY_PATH="$SANDBOX/memory" WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" \
    WORKBENCH_LOG_SYNC_MAX_BYTES=5 bash "$LOG_HOOK" >/dev/null 2>&1
assert_no_file "no marker at exit"                      "$SANDBOX/cache/pending-summaries/sid-cap.json"
assert_contains "the checkpoint stays at line 1" \
  "$(jq -r .next_line "$SANDBOX/cache/log-checkpoints/sid-cap.json" 2>/dev/null)" "1"
assert_contains "the deferral file records the transcript" \
  "$(sed -n 1p "$SANDBOX/cache/log-checkpoints/sid-cap.deferred" 2>/dev/null)" "$TRANSCRIPT"
assert_contains "the deferral file records the reason" \
  "$(sed -n 2p "$SANDBOX/cache/log-checkpoints/sid-cap.deferred" 2>/dev/null)" "other"
printf '{"session_id":"sid-cap2","transcript_path":"%s","hook_event_name":"SessionEnd"}' "$TRANSCRIPT" | \
  env HOME="$SANDBOX/home" WORKBENCH_MEMORY_PATH="$SANDBOX/memory" WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" \
    WORKBENCH_LOG_SYNC_MAX_BYTES=100000 bash "$LOG_HOOK" >/dev/null 2>&1
assert_file "under the cap the copy runs as before"    "$SANDBOX/cache/pending-summaries/sid-cap2.json"
printf '{"session_id":"sid-cap3","transcript_path":"%s","hook_event_name":"PreCompact"}' "$TRANSCRIPT" | \
  env HOME="$SANDBOX/home" WORKBENCH_MEMORY_PATH="$SANDBOX/memory" WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" \
    WORKBENCH_LOG_SYNC_MAX_BYTES=5 bash "$LOG_HOOK" >/dev/null 2>&1
assert_file "the cap applies to SessionEnd only"       "$SANDBOX/cache/pending-summaries/sid-cap3.json"

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

echo "The marker lands where the destructive-scope guard permits deleting it:"
# The guard permits a marker delete only in the folder memory_resolve_cache_path
# names. So the writer has to resolve the cache the same way, WORKBENCH_CONFIG_FILE
# included. A private copy of the lookup ignored that variable and wrote markers
# to $HOME's default cache instead, where no permit reached them. With no
# WORKBENCH_MEMORY_CACHE, the config file alone must decide.
# In /tmp, not the mktemp sandbox: on Darwin the sandbox sits inside the per-user
# temporary root the guard already approves, so a delete there would pass without
# the marker permit and prove nothing about it.
CFG_CACHE="/tmp/slog-cfg-cache-$$"
trap 'rm -rf "$SANDBOX" "$CFG_CACHE"' EXIT
CFG_FILE="$SANDBOX/cfg.json"
mkdir -p "$CFG_CACHE"
jq -n --arg c "$CFG_CACHE" '{memory_cache: $c}' > "$CFG_FILE"
printf '{"session_id":"%s","transcript_path":"%s","hook_event_name":"SessionEnd"}' \
  "sid-cfg" "$TRANSCRIPT" | \
  env -u WORKBENCH_MEMORY_CACHE HOME="$SANDBOX/home" PATH="$SANDBOX/bin:$PATH" \
    WORKBENCH_MEMORY_PATH="$SANDBOX/memory" WORKBENCH_CONFIG_FILE="$CFG_FILE" \
    WORKBENCH_DISPATCH_DRY_RUN=1 bash "$LOG_HOOK" >/dev/null 2>&1
assert_file "the marker follows WORKBENCH_CONFIG_FILE's memory_cache" \
  "$CFG_CACHE/pending-summaries/sid-cfg.json"
assert_no_file "and not the \$HOME default cache" \
  "$SANDBOX/home/.claude-memory-cache/pending-summaries/sid-cfg.json"
GUARD_OUT=$(jq -nc --arg c "rm -f $CFG_CACHE/pending-summaries/sid-cfg.json" \
    '{tool_name: "Bash", tool_input: {command: $c}, cwd: "/", session_id: "sid-cfg"}' | \
  env -u WORKBENCH_MEMORY_CACHE HOME="$SANDBOX/home" WORKBENCH_CONFIG_FILE="$CFG_FILE" \
    CLAUDE_PROJECT_DIR="$SANDBOX/memory" bash "$(dirname "$LOG_HOOK")/destructive-scope-guard.sh" 2>/dev/null)
assert_contains "the guard permits deleting that same marker" \
  "$(printf '%s' "$GUARD_OUT" | jq -r '.hookSpecificOutput.permissionDecision // "neutral"')" "allow"

echo
echo "mode=turn — the hooks module's per-turn checkpoint shares one checkpoint with SessionEnd:"
# hooks/register.ts runs this script with WORKBENCH_LOG_MODE=turn after every
# main-loop turn, answered or interrupted, and at session.end with
# hook_event_name SessionEnd. Each transcript line must reach the log exactly
# once, whichever writer gets to it.
CP_DIR="$SANDBOX/cache/log-checkpoints"
log_run() { # <WORKBENCH_LOG_MODE or ""> <sid> <transcript> [event] [reason]
  local mode="$1" sid="$2" tr="$3" event="${4:-TurnComplete}" reason="${5:-}"
  jq -nc --arg s "$sid" --arg t "$tr" --arg e "$event" --arg r "$reason" \
    '{session_id:$s, transcript_path:$t, hook_event_name:$e} + (if $r == "" then {} else {reason:$r} end)' | \
    env HOME="$SANDBOX/home" PATH="$SANDBOX/bin:$PATH" \
      WORKBENCH_MEMORY_PATH="$SANDBOX/memory" WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" \
      WORKBENCH_DISPATCH_DRY_RUN=1 WORKBENCH_AUTO_SUMMARIZE=1 \
      ${mode:+WORKBENCH_LOG_MODE=$mode} bash "$LOG_HOOK" 2>/dev/null
}
# once <desc> <log> <first> <last> <prefix>: lines <prefix>-<first>..<last> each
# appear exactly once in the log.
once() {
  local desc="$1" log="$2" i n bad=""
  for i in $(seq "$3" "$4"); do
    n=$(grep -cF "\"$5-$i\"" "$log" 2>/dev/null)
    [ "$n" = 1 ] || bad="$bad $5-$i:$n"
  done
  if [ -z "$bad" ]; then PASS=$((PASS + 1)); echo "  ✅ $desc"; else FAIL=$((FAIL + 1)); echo "  ❌ $desc —$bad"; fi
}
lines() { local i; for i in $(seq "$2" "$3"); do printf '{"type":"user","line":"%s-%s"}\n' "$1" "$i"; done; }
next_line() { jq -r '.next_line' "$CP_DIR/$1.json" 2>/dev/null; }
eq() { if [ "$2" = "$3" ]; then PASS=$((PASS + 1)); echo "  ✅ $1"; else FAIL=$((FAIL + 1)); echo "  ❌ $1 — got '$2', want '$3'"; fi; }

TT="$SANDBOX/turns.jsonl"
lines t 1 3 > "$TT"
OUT=$(log_run turn sid-turn "$TT")
TLOG="$(jq -r '.last_log_file' "$CP_DIR/sid-turn.json" 2>/dev/null)"
assert_file "a turn checkpoint writes the session's log" "$TLOG"
once "each line of the first turn is logged once" "$TLOG" 1 3 t
eq "the checkpoint moves past the last line" "$(next_line sid-turn)" 4
eq "the checkpoint names the mode" "$(jq -r '.last_log_mode' "$CP_DIR/sid-turn.json")" turn
assert_file "a turn checkpoint queues the session's marker" "$SANDBOX/cache/pending-summaries/sid-turn.json"
eq "the marker names the mode" "$(jq -r '.mode' "$SANDBOX/cache/pending-summaries/sid-turn.json")" turn
assert_missing "a turn checkpoint never dispatches a writer" "$OUT" "DISPATCH"
assert_no_file "the lock is released" "$CP_DIR/sid-turn.lock/."

lines t 4 5 >> "$TT"
log_run turn sid-turn "$TT" >/dev/null
once "the second turn appends only its own lines" "$TLOG" 1 5 t
eq "into the same log file" "$(jq -r '.last_log_file' "$CP_DIR/sid-turn.json")" "$TLOG"
eq "two segments, one per turn" "$(grep -c '^## Segment: turn' "$TLOG")" 2

echo "a turn checkpoint followed by SessionEnd logs nothing twice:"
BEFORE="$(wc -l < "$TLOG")"
log_run "" sid-turn "$TT" SessionEnd prompt_input_exit >/dev/null
eq "SessionEnd with nothing new leaves the log alone" "$(wc -l < "$TLOG")" "$BEFORE"
eq "and the checkpoint where it was" "$(next_line sid-turn)" 6
lines t 6 7 >> "$TT"
log_run "" sid-turn "$TT" SessionEnd other >/dev/null
once "SessionEnd logs only the lines after the last turn" "$TLOG" 1 7 t
eq "as a final segment" "$(grep -c '^## Segment: final' "$TLOG")" 1
eq "the checkpoint moves past them" "$(next_line sid-turn)" 8

echo "the per-session lock serializes the writers:"
TL="$SANDBOX/locked.jsonl"
lines l 1 2 > "$TL"
log_run turn sid-lock "$TL" >/dev/null
lines l 3 4 >> "$TL"
mkdir "$CP_DIR/sid-lock.lock"
START_S=$SECONDS
log_run turn sid-lock "$TL" >/dev/null
eq "a writer that cannot take the lock gives up without writing" "$(next_line sid-lock)" 3
eq "within the exit budget" "$([ $((SECONDS - START_S)) -le 2 ] && echo yes)" yes
eq "and leaves the holder's lock alone" "$([ -d "$CP_DIR/sid-lock.lock" ] && echo held)" held
touch -t 202601010000 "$CP_DIR/sid-lock.lock"
log_run turn sid-lock "$TL" >/dev/null
once "a lock left by a crashed writer is broken, and the lines are logged once" \
  "$(jq -r '.last_log_file' "$CP_DIR/sid-lock.json")" 1 4 l

echo "two writers at once still log each line once:"
TC="$SANDBOX/concurrent.jsonl"
lines c 1 400 > "$TC"
for round in 1 2 3; do
  log_run turn sid-conc "$TC" >/dev/null &
  log_run "" sid-conc "$TC" SessionEnd other >/dev/null &
  wait
  lines c $((round * 100 + 301)) $((round * 100 + 400)) >> "$TC"
done
log_run turn sid-conc "$TC" >/dev/null
once "turn and SessionEnd racing, three rounds" "$(jq -r '.last_log_file' "$CP_DIR/sid-conc.json")" 1 700 c

echo "a stale lock broken by many writers at once is held by one:"
# Breaking a crashed writer's lock is a check and a remove. Two writers that
# both see it stale must not both remove it, or the second removes the lock the
# first just took and both copy the same lines.
TS="$SANDBOX/stale-race.jsonl"
: > "$TS"
n=0
for round in $(seq 1 15); do
  lines s $((n + 1)) $((n + 40)) >> "$TS"
  n=$((n + 40))
  mkdir -p "$CP_DIR/sid-stale.lock"
  touch -t 202601010000 "$CP_DIR/sid-stale.lock"
  for _ in 1 2 3 4 5 6; do log_run turn sid-stale "$TS" >/dev/null & done
  wait
  # A writer that lost the race gives up, so the lines it would have copied
  # are left for the next one.
  log_run turn sid-stale "$TS" >/dev/null
done
once "fifteen rounds of six writers breaking one stale lock" "$(jq -r '.last_log_file' "$CP_DIR/sid-stale.json")" 1 "$n" s
assert_no_file "no lock is left behind" "$CP_DIR/sid-stale.lock"
assert_no_file "no takeover lock is left behind" "$CP_DIR/sid-stale.lock.takeover"

echo "the stale break, step by step (hooks/lib/dir-lock.sh):"
# The race above is too narrow to hit by timing alone, so each interleaving is
# driven here directly.
# shellcheck source=hooks/lib/dir-lock.sh
. "$(dirname "$LOG_HOOK")/lib/dir-lock.sh"
L="$SANDBOX/locks/step.lock"
mkdir -p "$SANDBOX/locks"
took() { if "$@"; then echo took; else echo refused; fi; }
fresh() { [ -d "$1" ] && ! dir_lock_is_stale "$1" && echo fresh; }
old() { touch -t 202601010000 "$1"; }
mkdir "$L"
eq "a writer that saw the lock stale, after another took it fresh, does not take it" "$(took dir_lock_take_stale "$L")" refused
eq "and the fresh lock stays" "$(fresh "$L")" fresh
old "$L"
mkdir "$L.takeover"
eq "a writer whose fresh takeover another holds does not take it" "$(took dir_lock_take_stale "$L")" refused
eq "and the stale lock is left for that writer" "$(dir_lock_is_stale "$L" && echo stale)" stale
rmdir "$L.takeover"
eq "the one writer under the takeover takes the stale lock" "$(took dir_lock_take_stale "$L")" took
eq "and holds it fresh" "$(fresh "$L")" fresh
eq "the takeover is released" "$([ -e "$L.takeover" ] && echo held || echo released)" released
eq "a fresh lock held by another is not acquired" "$(took dir_lock_acquire "$L" 2)" refused
rmdir "$L"
eq "a free lock is acquired" "$(took dir_lock_acquire "$L" 2)" took

echo "a takeover lock its breaker left behind blocks nothing for good:"
# A breaker killed in its few milliseconds leaves <lock>.takeover. One older
# than a minute is broken the same way, under <lock>.takeover.takeover.
old "$L"
mkdir "$L.takeover"
old "$L.takeover"
eq "a stale lock behind a stale takeover is taken" "$(took dir_lock_acquire "$L" 2)" took
eq "and held fresh" "$(fresh "$L")" fresh
eq "with no takeover lock left at any level" "$(find "$SANDBOX/locks" -name 'step.lock.takeover*' | grep -c .)" 0
mkdir "$L.takeover"
old "$L.takeover"
eq "a stale takeover beside a fresh lock does not unlock it" "$(took dir_lock_take_stale "$L")" refused
eq "the fresh lock stays" "$(fresh "$L")" fresh
eq "and the stale takeover is cleared on the way" "$([ -e "$L.takeover" ] && echo left || echo cleared)" cleared
rmdir "$L"
old "$(mkdir -p "$L" && echo "$L")"
mkdir "$L.takeover" "$L.takeover.takeover"
old "$L.takeover"
eq "a stale takeover whose own takeover is held fresh is not broken" "$(took dir_lock_take_stale "$L")" refused
eq "and the stale lock waits" "$(dir_lock_is_stale "$L" && echo stale)" stale
rmdir "$L.takeover.takeover" "$L.takeover" "$L"

echo "SessionEnd waits for the lock only briefly, inside the exit budget:"
TF="$SANDBOX/final-wait.jsonl"
lines f 1 2 > "$TF"
log_run turn sid-final "$TF" >/dev/null
lines f 3 3 >> "$TF"
mkdir "$CP_DIR/sid-final.lock"
T0=$(python3 -c 'import time; print(time.time())')
log_run "" sid-final "$TF" SessionEnd other >/dev/null
T1=$(python3 -c 'import time; print(time.time())')
eq "mode=final gives up within about 0.2 s" "$(python3 -c "print('yes' if $T1 - $T0 < 0.6 else 'no')")" yes
eq "and writes nothing, leaving the lines to the reconciler" "$(next_line sid-final)" 3
rmdir "$CP_DIR/sid-final.lock"

echo "a write a kill cut short is rolled back, never doubled or torn:"
# Each write records the log's size before it appends. A checkpoint still
# holding that size means the append may have run, in part or in full, and
# next_line never moved. The next writer cuts the log back and copies again.
TK="$SANDBOX/killed.jsonl"
lines k 1 3 > "$TK"
log_run turn sid-kill "$TK" >/dev/null
KLOG="$(jq -r '.last_log_file' "$CP_DIR/sid-kill.json")"
lines k 4 6 >> "$TK"
pending_at() { # <sid> <log>: the checkpoint as a killed write leaves it
  jq --argjson s "$(wc -c < "$2" | tr -d ' ')" '. + {pending_size: $s}' "$CP_DIR/$1.json" > "$CP_DIR/$1.json.x" \
    && mv "$CP_DIR/$1.json.x" "$CP_DIR/$1.json"
}
pending_at sid-kill "$KLOG"
printf '\n---\n\n## Segment: turn (lines 4–6)\n\n```jsonl\n' >> "$KLOG"
sed -n '4,6p' "$TK" >> "$KLOG"
printf '\n```\n' >> "$KLOG"
log_run turn sid-kill "$TK" >/dev/null
once "a kill after the whole append: each line once" "$KLOG" 1 6 k
eq "the checkpoint is clean again" "$(jq -r 'has("pending_size")' "$CP_DIR/sid-kill.json")" false
eq "two segments in the log, not three" "$(grep -c '^## Segment:' "$KLOG")" 2
lines k 7 9 >> "$TK"
pending_at sid-kill "$KLOG"
printf '\n---\n\n## Segment: turn (lines 7–9)\n\n```jsonl\n{"type":"user","li' >> "$KLOG"
log_run "" sid-kill "$TK" SessionEnd other >/dev/null
once "a kill in the middle of the append: no torn line, each line once" "$KLOG" 1 9 k
eq "and no fragment of the torn write" "$(grep -c '"li$' "$KLOG")" 0
TN="$SANDBOX/killed-new.jsonl"
lines n 1 2 > "$TN"
NLOG="$SANDBOX/memory/sessions/2026-01-01/sid-kill-new.log.md"
mkdir -p "$(dirname "$NLOG")"
printf -- '---\nname: "Session log' > "$NLOG"
jq -n --arg l "$NLOG" '{session_id:"sid-kill-new", next_line:1, last_log_file:$l, pending_size:0}' > "$CP_DIR/sid-kill-new.json"
log_run turn sid-kill-new "$TN" >/dev/null
NEWLOG="$(jq -r '.last_log_file' "$CP_DIR/sid-kill-new.json")"
once "a kill while the first write created the log: written again whole" "$NEWLOG" 1 2 n
eq "with its frontmatter" "$(head -1 "$NEWLOG")" "---"
eq "and the torn first file is gone" "$([ -e "$NLOG" ] && [ "$NLOG" != "$NEWLOG" ] && echo left || echo gone)" gone

echo "a session id that could leave the folders writes nothing:"
log_run turn '../escape' "$TT" >/dev/null
assert_no_file "no checkpoint outside the folder" "$SANDBOX/cache/escape.json"
eq "and no lock either" "$(find "$SANDBOX/cache" -name '*escape*' | grep -c .)" 0

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
