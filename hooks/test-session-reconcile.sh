#!/bin/bash
# Tests for the start-up session reconciler and the dead-marker sweep
# (hooks/lib/session-reconcile.sh), driven through session-warmup.sh the way a
# real SessionStart runs them. Run directly: ./test-session-reconcile.sh
#
# Every case builds a sandbox Claude Code home (CLAUDE_CONFIG_DIR) with
# transcripts, a live-session registry, checkpoints, and markers, then runs one
# warmup and asserts what was logged, queued, skipped, or deleted.

set -u
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
WARMUP="$HOOKS_DIR/session-warmup.sh"
REPO_ROOT="$(cd "$HOOKS_DIR/.." && pwd)"
PASS=0
FAIL=0

unset CLAUDE_CODE_AGENT WORKBENCH_SKIP_WARMUP WORKBENCH_SKIP_LOG

SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

CLAUDE="$SANDBOX/claude"
PROJ="$CLAUDE/projects/-Users-x-Developer-proj"
REG="$CLAUDE/sessions"
CACHE="$SANDBOX/cache"
MEM="$SANDBOX/memory"
CP="$CACHE/log-checkpoints"
PENDING="$CACHE/pending-summaries"
DLOG="$CACHE/summary-dispatch-errors.log"
NOTICES_FILE="$SANDBOX/home/.claude-workbench/warmup-notices.md"

mkdir -p "$SANDBOX/bin"
printf '#!/bin/sh\nexit 0\n' > "$SANDBOX/bin/claude"
chmod +x "$SANDBOX/bin/claude"

# A pid that is certainly not running: a child that has already been reaped.
sleep 0 &
DEAD_PID=$!
wait "$DEAD_PID" 2>/dev/null

reset() {
  rm -rf "$CLAUDE" "$CACHE" "$MEM" "${SANDBOX:?}/home" "${SANDBOX:?}/elsewhere"
  mkdir -p "$PROJ" "$REG" "$CACHE" "$MEM" "$SANDBOX/home"
}

# age <path> <minutes>: set a file's mtime to that many minutes ago.
age() {
  python3 -c 'import os,sys,time; t=time.time()-float(sys.argv[2])*60; os.utime(sys.argv[1],(t,t))' "$1" "$2"
}

# transcript <sid> <minutes-ago> [dir]: a transcript with a real conversation
# (two user lines, two assistant lines) plus a trailing bookkeeping line.
transcript() {
  local sid="$1" mins="$2" dir="${3:-$PROJ}"
  mkdir -p "$dir"
  {
    printf '{"type":"user","sessionId":"%s","n":1}\n' "$sid"
    printf '{"type":"assistant","sessionId":"%s","n":2}\n' "$sid"
    printf '{"type":"user","sessionId":"%s","n":3}\n' "$sid"
    printf '{"type":"assistant","sessionId":"%s","n":4}\n' "$sid"
    printf '{"type":"cost-state","sessionId":"%s","n":5}\n' "$sid"
  } > "$dir/$sid.jsonl"
  age "$dir/$sid.jsonl" "$mins"
}

# checkpoint <sid> <next_line> <minutes-ago> [log_file]
checkpoint() {
  mkdir -p "$CP"
  jq -n --arg s "$1" --argjson n "$2" --arg l "${4:-}" \
    '{session_id:$s, next_line:$n, last_log_file:$l, last_log_mode:"final"}' > "$CP/$1.json"
  age "$CP/$1.json" "$3"
}

register() {  # register <pid> <sid>
  printf '{"pid":%s,"sessionId":"%s","kind":"interactive"}' "$1" "$2" > "$REG/$1.json"
}

# $1: source (default startup). Remaining args: extra env assignments.
run_warmup() {
  local source="${1:-startup}"
  shift || true
  printf '{"source":"%s","session_id":"%s"}' "$source" "${CURRENT:-sid-current}" | \
    env HOME="$SANDBOX/home" PATH="$SANDBOX/bin:$PATH" \
      CLAUDE_CONFIG_DIR="$CLAUDE" \
      WORKBENCH_MEMORY_PATH="$MEM" WORKBENCH_MEMORY_CACHE="$CACHE" \
      WORKBENCH_MEMORY_PORT=1 CLAUDE_PLUGIN_ROOT="$REPO_ROOT" \
      WORKBENCH_AUTO_SUMMARIZE=0 WORKBENCH_DISPATCH_DRY_RUN=1 \
      "$@" bash "$WARMUP" 2>/dev/null
}

ok()  { PASS=$((PASS + 1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  ❌ $1"; }
assert_path()    { if [ -e "$2" ]; then ok "$1"; else bad "$1 — expected: $2"; fi; }
assert_no_path() { if [ -e "$2" ]; then bad "$1 — should NOT exist: $2"; else ok "$1"; fi; }
assert_eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — expected [$3], got [$2]"; fi; }
assert_contains() {
  if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else bad "$1 — expected to find: $3"; fi
}
assert_missing() {
  if printf '%s' "$2" | grep -qF -- "$3"; then bad "$1 — should NOT contain: $3"; else ok "$1"; fi
}
marker_field() { jq -r ".$2" "$PENDING/$1.json" 2>/dev/null; }
log_of() { find "$MEM/sessions" -name "$1.log.md" 2>/dev/null | head -1; }

# ──────────── AC1: a session with no checkpoint and no marker ────────────
echo "reconcile — a dead transcript with no checkpoint and no marker is logged and queued:"
reset
register "$$" "sid-current"
transcript "sid-lost" 120
run_warmup >/dev/null
LOG=$(log_of sid-lost)
assert_path     "the raw log is written to the vault"        "${LOG:-$MEM/sessions/none/sid-lost.log.md}"
assert_contains "the log carries the conversation"           "$(cat "$LOG" 2>/dev/null)" '"n":4'
assert_contains "the log segment is labelled reconcile"      "$(cat "$LOG" 2>/dev/null)" "## Segment: reconcile (lines 1–5"
assert_path     "a pending marker is created"                "$PENDING/sid-lost.json"
assert_eq       "the marker says it came from the reconciler" "$(marker_field sid-lost origin)" "reconciler"
assert_eq       "the marker mode is reconcile"               "$(marker_field sid-lost mode)" "reconcile"
assert_eq       "no SessionEnd, so the reason is null"       "$(marker_field sid-lost reason)" "null"
assert_eq       "the checkpoint is advanced past the end"    "$(jq -r .next_line "$CP/sid-lost.json" 2>/dev/null)" "6"

echo "reconcile — a recovered session is filed under the day it was last written:"
reset
transcript "sid-twodays" $((2 * 1440))
run_warmup >/dev/null
EXPECT_DAY=$(date -u -r "$PROJ/sid-twodays.jsonl" +%Y-%m-%d)
assert_path     "the log is under the transcript's day"      "$MEM/sessions/$EXPECT_DAY/sid-twodays.log.md"
assert_no_path  "not under the day it was found"             "$MEM/sessions/$(date -u +%Y-%m-%d)/sid-twodays.log.md"

echo "reconcile — a second start does not log the same session again:"
reset
transcript "sid-lost" 120
run_warmup >/dev/null
LOG=$(log_of sid-lost)
BEFORE=$(cat "$LOG" 2>/dev/null)
rm -f "$PENDING/sid-lost.json"
run_warmup >/dev/null
assert_eq       "the log is unchanged"                       "$(cat "$LOG" 2>/dev/null)" "$BEFORE"
assert_no_path  "no new marker is queued"                    "$PENDING/sid-lost.json"

echo "reconcile — the drain picks the reconciled marker up in the same start:"
reset
transcript "sid-drained" 120
OUT=$(run_warmup startup WORKBENCH_AUTO_SUMMARIZE=1)
assert_contains "the drain dispatches a writer for it"       "$OUT" "DISPATCH sid=sid-drained"
assert_contains "the writer is handed the new log"           "$OUT" "DISPATCH log=$MEM/sessions/"

echo "reconcile — runs on resume, not on clear or compact:"
reset
transcript "sid-src" 120
run_warmup resume >/dev/null
assert_path     "resume reconciles"                          "$PENDING/sid-src.json"
reset
transcript "sid-src" 120
run_warmup clear >/dev/null
assert_no_path  "clear does not reconcile"                   "$PENDING/sid-src.json"
run_warmup compact >/dev/null
assert_no_path  "compact does not reconcile"                 "$PENDING/sid-src.json"

# ──────────── What the reconciler must never touch ────────────
echo "reconcile — skips the starting session, live sessions, and the classes session-log skips:"
reset
register "$$" "sid-live"
register "$DEAD_PID" "sid-registered-dead"
transcript "sid-current" 120
transcript "sid-live" 120
transcript "sid-registered-dead" 120
transcript "sid-scratch" 120 "$CLAUDE/projects/-private-tmp-claude-503--Users-x-proj-abc-scratchpad"
transcript "sid-scratch2" 120 "$CLAUDE/projects/-Users-x-Developer-scratchpad-eval"
transcript "agent-a1" 120 "$PROJ/sid-parent/subagents"
transcript "sid-writer" 120
printf '{"type":"user","message":{"content":"Process pending session summary.\\n\\nsession_id: x"}}\n' \
  | cat - "$PROJ/sid-writer.jsonl" > "$SANDBOX/w.tmp" && mv "$SANDBOX/w.tmp" "$PROJ/sid-writer.jsonl"
age "$PROJ/sid-writer.jsonl" 120
CURRENT="sid-current" run_warmup >/dev/null
assert_no_path  "the starting session is not reconciled"     "$PENDING/sid-current.json"
assert_no_path  "a live session is not reconciled"           "$PENDING/sid-live.json"
assert_no_path  "its checkpoint is not touched either"       "$CP/sid-live.json"
assert_path     "a registry entry with a dead pid is reconciled" "$PENDING/sid-registered-dead.json"
assert_no_path  "a scratchpad session is not reconciled"     "$PENDING/sid-scratch.json"
assert_no_path  "a flattened scratchpad cwd is not reconciled" "$PENDING/sid-scratch2.json"
assert_no_path  "a sub-agent transcript is not reconciled"   "$PENDING/agent-a1.json"
assert_no_path  "a summary writer's transcript is not reconciled" "$PENDING/sid-writer.json"

echo "reconcile — the time window bounds the scan:"
reset
transcript "sid-fresh" 5
transcript "sid-old" $((5 * 1440))
transcript "sid-week" $((7 * 1440 + 60))
transcript "sid-inside" 120
run_warmup >/dev/null
assert_no_path  "a transcript written 5 minutes ago may be live" "$PENDING/sid-fresh.json"
assert_no_path  "a transcript older than the window is left"  "$PENDING/sid-old.json"
assert_path     "a transcript inside the window is reconciled" "$PENDING/sid-inside.json"
rm -f "$PENDING"/*.json
# The window is clamped below the 7-day checkpoint retention. Past it, a pruned
# checkpoint would make an already-logged session look new.
run_warmup startup WORKBENCH_RECONCILE_WINDOW_MIN=99999 >/dev/null
assert_path     "a wide window reaches 5 days"               "$PENDING/sid-old.json"
assert_no_path  "but never past the clamp below 7 days"      "$PENDING/sid-week.json"
reset
transcript "sid-quiet" 20
run_warmup startup WORKBENCH_RECONCILE_QUIET_MIN=10 >/dev/null
assert_path     "the quiet period is configurable"           "$PENDING/sid-quiet.json"

echo "reconcile — a transcript with no conversation is not logged:"
reset
printf '{"type":"cost-state"}\n{"type":"mode"}\n' > "$PROJ/sid-meta.jsonl"
age "$PROJ/sid-meta.jsonl" 120
run_warmup >/dev/null
assert_no_path  "bookkeeping lines alone queue nothing"      "$PENDING/sid-meta.json"

echo "reconcile — a queued marker without a checkpoint is left to the drain:"
reset
transcript "sid-queued" 120
mkdir -p "$PENDING"
printf '{"session_id":"sid-queued","transcript_path":"%s","mode":"manual"}\n' "$PROJ/sid-queued.jsonl" \
  > "$PENDING/sid-queued.json"
run_warmup >/dev/null
assert_eq       "the marker is not rewritten"                "$(marker_field sid-queued mode)" "manual"
assert_eq       "no log is written for it"                   "$(log_of sid-queued)" ""

echo "reconcile — batch bound, oldest first:"
reset
transcript "sid-b1" 300
transcript "sid-b2" 200
transcript "sid-b3" 100
run_warmup startup WORKBENCH_RECONCILE_BATCH=2 >/dev/null
assert_path     "oldest reconciled"                          "$PENDING/sid-b1.json"
assert_path     "second-oldest reconciled"                   "$PENDING/sid-b2.json"
assert_no_path  "the batch stops at 2"                       "$PENDING/sid-b3.json"
run_warmup startup WORKBENCH_RECONCILE_BATCH=2 >/dev/null
assert_path     "the next start takes the rest"              "$PENDING/sid-b3.json"
reset
transcript "sid-b0" 100
run_warmup startup WORKBENCH_RECONCILE_BATCH=0 >/dev/null
assert_no_path  "a batch of 0 disables the reconciler"       "$PENDING/sid-b0.json"

echo "reconcile — a held lock blocks a concurrent start:"
reset
transcript "sid-lock" 100
mkdir -p "$CACHE/session-reconcile.lock"
run_warmup >/dev/null
assert_no_path  "a fresh lock suppresses the reconciler"     "$PENDING/sid-lock.json"
age "$CACHE/session-reconcile.lock" 10
run_warmup >/dev/null
assert_path     "a stale lock is broken"                     "$PENDING/sid-lock.json"
assert_no_path  "and released after the run"                 "$CACHE/session-reconcile.lock"

echo "reconcile — fails closed when it cannot tell which sessions are live:"
reset
rm -rf "$REG"
transcript "sid-noreg" 100
run_warmup >/dev/null
assert_no_path  "no registry, nothing reconciled"            "$PENDING/sid-noreg.json"
assert_contains "and the notices say so"                     "$(cat "$NOTICES_FILE" 2>/dev/null)" "Session reconciler skipped"
reset
rm -rf "$REG"
run_warmup >/dev/null
assert_missing  "no candidates, no registry notice"          "$(cat "$NOTICES_FILE" 2>/dev/null)" "Session reconciler skipped"
reset
printf 'not json' > "$REG/$$.json"
transcript "sid-badreg" 100
run_warmup >/dev/null
assert_no_path  "a live pid with an unreadable entry blocks the run" "$PENDING/sid-badreg.json"
reset
printf 'not json' > "$REG/$DEAD_PID.json"
transcript "sid-deadbad" 100
run_warmup >/dev/null
assert_path     "an unreadable entry for a dead pid does not"  "$PENDING/sid-deadbad.json"

echo "reconcile — candidate selection, seen from the log hook it calls:"
# Driven directly with a stub in place of session-log.sh, so a skip the reconciler
# makes is observable even where session-log.sh would also have refused.
reset
STUB="$SANDBOX/stub-log.sh"
CALLS="$SANDBOX/stub-calls"
: > "$CALLS"
printf '#!/bin/bash
jq -r .session_id >> "%s"
' "$CALLS" > "$STUB"
transcript "sid-stub-ok" 120
transcript "sid-stub-scratch" 120 "$CLAUDE/projects/-Users-x-Developer-scratchpad-eval"
(
  . "$HOOKS_DIR/lib/session-reconcile.sh"
  session_reconcile "$CLAUDE/projects" "none" "$STUB" "$CP" "$PENDING" "$REG"
)
assert_contains "a real session reaches the log hook"        "$(cat "$CALLS")" "sid-stub-ok"
assert_missing  "a disposable one never does"                "$(cat "$CALLS")" "sid-stub-scratch"

# ──────────── AC2: checkpoints ────────────
echo "reconcile — an up-to-date checkpoint is not logged again:"
reset
transcript "sid-done" 120
checkpoint "sid-done" 6 60
: > "$SANDBOX/ref-30min"
age "$SANDBOX/ref-30min" 30
run_warmup >/dev/null
assert_no_path  "checkpoint newer than the transcript: nothing queued" "$PENDING/sid-done.json"
assert_eq       "no log written"                             "$(log_of sid-done)" ""
# The mtime test is what keeps a steady-state start cheap: a current checkpoint
# is passed over without reading the transcript at all, so it is not touched.
if [ "$CP/sid-done.json" -nt "$SANDBOX/ref-30min" ]; then
  bad "a current checkpoint was re-examined and touched"
else
  ok "a current checkpoint is skipped on mtime alone"
fi

echo "reconcile — a checkpoint behind only bookkeeping lines is not a lost segment:"
# A transcript can sit a line past its checkpoint with only cost-state or mode
# records. That is not a loss.
reset
transcript "sid-tail" 60
checkpoint "sid-tail" 5 120
run_warmup >/dev/null
assert_no_path  "nothing queued for a bookkeeping tail"      "$PENDING/sid-tail.json"
if [ "$CP/sid-tail.json" -nt "$PROJ/sid-tail.jsonl" ]; then
  ok "the checkpoint is touched, so the next start skips it cheaply"
else
  bad "the checkpoint was not touched"
fi

echo "reconcile — a lagging checkpoint gets only the missing segment:"
reset
transcript "sid-lag" 60
mkdir -p "$MEM/sessions/2026-01-01"
EXISTING="$MEM/sessions/2026-01-01/sid-lag.log.md"
printf -- '---\nname: x\n---\n\n## Segment: checkpoint (lines 1–2)\n\n```jsonl\n{"n":1}\n{"n":2}\n```\n' > "$EXISTING"
checkpoint "sid-lag" 3 120 "$EXISTING"
run_warmup >/dev/null
LAGLOG=$(cat "$EXISTING")
assert_contains "the missing segment is appended to the existing log" "$LAGLOG" "## Segment: reconcile (lines 3–5"
assert_contains "it carries the lost lines"                  "$LAGLOG" '"type":"user","sessionId":"sid-lag","n":3'
assert_missing  "it does not repeat line 1"                  "$LAGLOG" '"sessionId":"sid-lag","n":1'
assert_missing  "it does not repeat line 2"                  "$LAGLOG" '"sessionId":"sid-lag","n":2'
assert_eq       "one log file, not two"                      "$(find "$MEM/sessions" -name 'sid-lag.log.md' | wc -l | tr -d ' ')" "1"
assert_eq       "the checkpoint is advanced"                 "$(jq -r .next_line "$CP/sid-lag.json")" "6"
assert_eq       "a reconciler marker is queued"              "$(marker_field sid-lag origin)" "reconciler"

# ──────────── AC4 + AC5 together: a deferred SessionEnd copy ────────────
echo "reconcile — a SessionEnd copy deferred by the size cap is recovered with its reason:"
reset
transcript "sid-big" 120
printf '{"session_id":"sid-big","transcript_path":"%s","hook_event_name":"SessionEnd","reason":"prompt_input_exit"}' \
  "$PROJ/sid-big.jsonl" | \
  env HOME="$SANDBOX/home" WORKBENCH_MEMORY_PATH="$MEM" WORKBENCH_MEMORY_CACHE="$CACHE" \
    WORKBENCH_LOG_SYNC_MAX_BYTES=10 bash "$HOOKS_DIR/session-log.sh" >/dev/null 2>&1
assert_eq       "at exit: no log is copied"                  "$(log_of sid-big)" ""
assert_no_path  "at exit: no marker"                         "$PENDING/sid-big.json"
assert_eq       "at exit: the checkpoint keeps next_line"    "$(jq -r .next_line "$CP/sid-big.json" 2>/dev/null)" "1"
assert_eq       "at exit: the deferral file names the transcript" "$(sed -n 1p "$CP/sid-big.deferred" 2>/dev/null)" "$PROJ/sid-big.jsonl"
assert_eq       "at exit: the deferral file keeps the reason" "$(sed -n 2p "$CP/sid-big.deferred" 2>/dev/null)" "prompt_input_exit"
# No back-dating: the checkpoint stays newer than the transcript, exactly as a
# deferring SessionEnd leaves it in production. An mtime test alone skips it.
if [ "$CP/sid-big.json" -nt "$PROJ/sid-big.jsonl" ]; then
  ok "the deferring checkpoint is newer than its transcript"
else
  bad "the fixture does not match production: checkpoint is older than the transcript"
fi
run_warmup >/dev/null
assert_contains "at start: the whole transcript is logged"   "$(cat "$(log_of sid-big)" 2>/dev/null)" "## Segment: reconcile (lines 1–5"
assert_eq       "at start: the marker carries the SessionEnd reason" "$(marker_field sid-big reason)" "prompt_input_exit"
assert_eq       "at start: and names the reconciler"         "$(marker_field sid-big origin)" "reconciler"
assert_no_path  "at start: the deferral is closed"           "$CP/sid-big.deferred"
rm -f "$PENDING/sid-big.json"
run_warmup >/dev/null
assert_no_path  "a later start does not log it again"        "$PENDING/sid-big.json"

echo "reconcile — a deferral with only bookkeeping past next_line is still owed:"
reset
printf '{"type":"cost-state"}\n{"type":"mode"}\n' > "$PROJ/sid-bigmeta.jsonl"
age "$PROJ/sid-bigmeta.jsonl" 120
printf '{"session_id":"sid-bigmeta","transcript_path":"%s","hook_event_name":"SessionEnd"}' \
  "$PROJ/sid-bigmeta.jsonl" | \
  env HOME="$SANDBOX/home" WORKBENCH_MEMORY_PATH="$MEM" WORKBENCH_MEMORY_CACHE="$CACHE" \
    WORKBENCH_LOG_SYNC_MAX_BYTES=10 bash "$HOOKS_DIR/session-log.sh" >/dev/null 2>&1
assert_path     "the cap deferred it"                        "$CP/sid-bigmeta.deferred"
run_warmup >/dev/null
assert_no_path  "the deferral is logged and closed"          "$CP/sid-bigmeta.deferred"
assert_path     "and a marker is queued for it"              "$PENDING/sid-bigmeta.json"

echo "reconcile — a deferral is found after its transcript leaves the 3-day window:"
# No session started for 5 days after the deferring SessionEnd. The transcript,
# its checkpoint and the deferral are all 5 days old, past the scan window but
# inside the 7-day retention.
reset
transcript "sid-late" $((5 * 1440))
printf '{"session_id":"sid-late","transcript_path":"%s","hook_event_name":"SessionEnd","reason":"other"}' \
  "$PROJ/sid-late.jsonl" | \
  env HOME="$SANDBOX/home" WORKBENCH_MEMORY_PATH="$MEM" WORKBENCH_MEMORY_CACHE="$CACHE" \
    WORKBENCH_LOG_SYNC_MAX_BYTES=10 bash "$HOOKS_DIR/session-log.sh" >/dev/null 2>&1
age "$CP/sid-late.json" $((5 * 1440))
age "$CP/sid-late.deferred" $((5 * 1440))
transcript "sid-old-plain" $((5 * 1440))
run_warmup >/dev/null
assert_contains "the late deferral is logged"                "$(cat "$(log_of sid-late)" 2>/dev/null)" "## Segment: reconcile (lines 1–5"
assert_no_path  "and closed"                                 "$CP/sid-late.deferred"
assert_eq       "its marker carries the reason"              "$(marker_field sid-late reason)" "other"
assert_no_path  "a plain old transcript is still outside the window" "$PENDING/sid-old-plain.json"

echo "reconcile — a deferral the reconciler cannot act on is left for retention:"
reset
mkdir -p "$CP"
printf '%s\nother\n' "$PROJ/sid-gone.jsonl" > "$CP/sid-gone.deferred"
printf '{"session_id":"sid-gone","next_line":1}\n' > "$CP/sid-gone.json"
transcript "sid-nocp" 120
printf '%s\nother\n' "$PROJ/sid-nocp.jsonl" > "$CP/sid-nocp.deferred"
transcript "sid-livedef" 120
checkpoint "sid-livedef" 1 60
printf '%s\nother\n' "$PROJ/sid-livedef.jsonl" > "$CP/sid-livedef.deferred"
register "$$" "sid-livedef"
# A deferral naming some other session's transcript is not trusted.
transcript "sid-other" 120
checkpoint "sid-other" 1 60
checkpoint "sid-wrong" 1 60
printf '%s\nother\n' "$PROJ/sid-other.jsonl" > "$CP/sid-wrong.deferred"
run_warmup >/dev/null
assert_no_path  "a deferral naming another transcript is ignored" "$PENDING/sid-other.json"
assert_path     "a missing transcript: deferral kept"         "$CP/sid-gone.deferred"
assert_no_path  "and nothing queued"                          "$PENDING/sid-gone.json"
assert_no_path  "no checkpoint: not logged from line 1"       "$PENDING/sid-nocp.json"
assert_no_path  "a live session's deferral waits"             "$PENDING/sid-livedef.json"
assert_path     "and stays open"                              "$CP/sid-livedef.deferred"

echo "retention — a deferral older than 7 days is pruned with its checkpoint:"
reset
mkdir -p "$CP"
: > "$CP/sid-stale.deferred"
age "$CP/sid-stale.deferred" $((8 * 1440))
: > "$CP/sid-fresh.deferred"
run_warmup >/dev/null
assert_no_path  "the stale deferral is deleted"              "$CP/sid-stale.deferred"
assert_path     "a fresh one stays"                          "$CP/sid-fresh.deferred"

echo "reconcile — an old clean-exit reason does not reach a later segment:"
# A resumed session keeps its id. Its first SessionEnd ended cleanly; then a
# reboot cut the resumed part off. The reboot segment has no reason.
reset
transcript "sid-resumed" 120
printf '{"session_id":"sid-resumed","transcript_path":"%s","hook_event_name":"SessionEnd","reason":"prompt_input_exit"}' \
  "$PROJ/sid-resumed.jsonl" | \
  env HOME="$SANDBOX/home" WORKBENCH_MEMORY_PATH="$MEM" WORKBENCH_MEMORY_CACHE="$CACHE" \
    bash "$HOOKS_DIR/session-log.sh" >/dev/null 2>&1
rm -f "$PENDING/sid-resumed.json"
printf '{"type":"user","sessionId":"sid-resumed","n":6}\n' >> "$PROJ/sid-resumed.jsonl"
age "$PROJ/sid-resumed.jsonl" 60
age "$CP/sid-resumed.json" 120
run_warmup >/dev/null
assert_eq       "the reboot segment is queued"               "$(marker_field sid-resumed origin)" "reconciler"
assert_eq       "with no reason, not the old one"            "$(marker_field sid-resumed reason)" "null"

# ──────────── AC3: the dead-marker sweep ────────────
echo "sweep — deletes empty and sourceless markers, keeps every recoverable one:"
reset
mkdir -p "$PENDING" "$SANDBOX/elsewhere"
: > "$SANDBOX/elsewhere/t.jsonl"
: > "$SANDBOX/elsewhere/l.log.md"
: > "$PENDING/empty.json"
printf '{"session_id":"gone","log_path":"/nonexistent/a.log.md","transcript_path":"/nonexistent/a.jsonl"}\n' > "$PENDING/gone.json"
printf '{\n  "session_id": "gone-pretty",\n  "transcript_path": "/nonexistent/b.jsonl",\n  "log_path": "/nonexistent/b.log.md"\n}\n' > "$PENDING/gone-pretty.json"
printf '{"session_id":"nulls","log_path":null,"transcript_path":null}\n' > "$PENDING/nulls.json"
printf '{"session_id":"has-log","log_path":"%s","transcript_path":"/nonexistent/c.jsonl"}\n' "$SANDBOX/elsewhere/l.log.md" > "$PENDING/has-log.json"
printf '{"session_id":"has-t","log_path":"/nonexistent/d.log.md","transcript_path":"%s"}\n' "$SANDBOX/elsewhere/t.jsonl" > "$PENDING/has-t.json"
printf '{"session_id":"t-only","transcript_path":"%s"}\n' "$SANDBOX/elsewhere/t.jsonl" > "$PENDING/t-only.json"
printf 'this is not json' > "$PENDING/malformed.json"
printf '{"session_id":"escaped","log_path":"/nonexistent/e\\"q.log.md","transcript_path":"/nonexistent/e.jsonl"}\n' > "$PENDING/escaped.json"
run_warmup >/dev/null
assert_no_path  "a 0-byte marker is deleted"                 "$PENDING/empty.json"
assert_no_path  "a marker with both sources gone is deleted" "$PENDING/gone.json"
assert_no_path  "the same in pretty-printed JSON"            "$PENDING/gone-pretty.json"
assert_no_path  "a marker with null sources is deleted"      "$PENDING/nulls.json"
assert_path     "a marker whose log survives is kept"        "$PENDING/has-log.json"
assert_path     "a marker whose transcript survives is kept" "$PENDING/has-t.json"
assert_path     "a transcript-only marker that survives is kept" "$PENDING/t-only.json"
assert_path     "a malformed marker is kept (fail closed)"   "$PENDING/malformed.json"
assert_path     "a path the sweep cannot read cleanly is kept" "$PENDING/escaped.json"
assert_contains "each purge is recorded once"                "$(cat "$DLOG" 2>/dev/null)" "purged-dead-marker marker=$PENDING/gone.json reason=no-source"
assert_contains "the empty one says why"                     "$(cat "$DLOG" 2>/dev/null)" "purged-dead-marker marker=$PENDING/empty.json reason=empty"
assert_missing  "a kept marker is not recorded"              "$(cat "$DLOG" 2>/dev/null)" "has-t.json"
LINES_BEFORE=$(wc -l < "$DLOG" | tr -d ' ')
run_warmup >/dev/null
assert_eq       "a second start writes nothing more to the dispatch log" "$(wc -l < "$DLOG" | tr -d ' ')" "$LINES_BEFORE"

echo "sweep — runs on startup and resume, not on clear or compact:"
reset
mkdir -p "$PENDING"
: > "$PENDING/empty.json"
run_warmup clear >/dev/null
assert_path     "clear leaves it"                            "$PENDING/empty.json"
run_warmup compact >/dev/null
assert_path     "compact leaves it"                          "$PENDING/empty.json"
run_warmup resume >/dev/null
assert_no_path  "resume sweeps it"                           "$PENDING/empty.json"

echo "warmup stdout is unchanged by reconciling:"
# The payload must stay byte-stable. Everything the reconciler and the sweep do
# goes to disk, never to stdout.
reset
OUT_EMPTY=$(run_warmup)
reset
transcript "sid-quiet-out" 120
mkdir -p "$PENDING"; : > "$PENDING/empty.json"
OUT_WORK=$(run_warmup)
assert_path     "work was done"                              "$PENDING/sid-quiet-out.json"
assert_eq       "stdout is identical with and without work"  "$OUT_WORK" "$OUT_EMPTY"

echo "a turn checkpoint, then a crash — the reconciler logs only what the turns did not:"
# The hooks module checkpoints every main-loop turn through session-log.sh in
# mode=turn (hooks/register.ts). A crash after a turn leaves the lines written
# since then. The reconciler reads the same checkpoint, so it logs those lines
# and no line the turn already logged.
reset
register "$$" "sid-current"
TT="$PROJ/sid-turned.jsonl"
{
  printf '{"type":"user","sessionId":"sid-turned","n":1}\n'
  printf '{"type":"assistant","sessionId":"sid-turned","n":2}\n'
} > "$TT"
printf '{"session_id":"sid-turned","transcript_path":"%s","hook_event_name":"TurnComplete"}' "$TT" | \
  env HOME="$SANDBOX/home" PATH="$SANDBOX/bin:$PATH" WORKBENCH_MEMORY_PATH="$MEM" \
    WORKBENCH_MEMORY_CACHE="$CACHE" WORKBENCH_LOG_MODE=turn bash "$HOOKS_DIR/session-log.sh" 2>/dev/null
age "$CP/sid-turned.json" 125
{
  printf '{"type":"user","sessionId":"sid-turned","n":3}\n'
  printf '{"type":"assistant","sessionId":"sid-turned","n":4}\n'
} >> "$TT"
age "$TT" 120
run_warmup >/dev/null
LOG=$(log_of sid-turned)
for n in 1 2 3 4; do
  assert_eq "line $n is in the log once" "$(grep -c "\"n\":$n}" "$LOG" 2>/dev/null)" 1
done
assert_eq "one segment from the turn" "$(grep -c '^## Segment: turn' "$LOG" 2>/dev/null)" 1
assert_eq "one from the reconciler, for lines 3 and 4" "$(grep -c '^## Segment: reconcile (lines 3–4' "$LOG" 2>/dev/null)" 1
assert_eq "the checkpoint moves past the last line" "$(jq -r '.next_line' "$CP/sid-turned.json")" 5
run_warmup >/dev/null
assert_eq "a second start logs nothing again" "$(grep -c '^## Segment:' "$LOG" 2>/dev/null)" 2

echo "the drain leaves a live session's marker for later:"
# A turn checkpoint keeps a running session's marker queued. A writer started
# on it would summarize half a session, and its rm of the marker could delete
# the one the next turn writes.
reset
register "$$" "sid-live"
mkdir -p "$PENDING" "$MEM/sessions/2026-10-07"
for s in sid-live sid-done; do
  printf 'log\n' > "$MEM/sessions/2026-10-07/$s.log.md"
  jq -n --arg s "$s" --arg l "$MEM/sessions/2026-10-07/$s.log.md" \
    '{session_id:$s, log_path:$l, transcript_path:"", mode:"turn"}' > "$PENDING/$s.json"
done
OUT=$(run_warmup startup WORKBENCH_AUTO_SUMMARIZE=1)
assert_contains "the ended session is drained" "$OUT" "DISPATCH sid=sid-done"
assert_missing  "the live session is not"      "$OUT" "DISPATCH sid=sid-live"
assert_path     "and its marker stays"         "$PENDING/sid-live.json"
echo "a registry the drain cannot read whole: it keeps the ids it read, and skips what was written recently:"
# One live pid file names no session, so some running session is unknown. The
# drain still skips the ids it parsed, and also skips any marker whose log or
# transcript was written within the quiet period: that one may be the unknown
# session. An older one is drained.
reset
register "$$" "sid-live"
printf '{"pid":%s,"kind":"interactive"}' "$PPID" > "$REG/$PPID.json"
mkdir -p "$PENDING" "$MEM/sessions/2026-10-07"
for s in sid-live sid-recent sid-old; do
  printf 'log\n' > "$MEM/sessions/2026-10-07/$s.log.md"
  jq -n --arg s "$s" --arg l "$MEM/sessions/2026-10-07/$s.log.md" \
    '{session_id:$s, log_path:$l, transcript_path:"", mode:"turn"}' > "$PENDING/$s.json"
done
age "$MEM/sessions/2026-10-07/sid-live.log.md" 120
age "$MEM/sessions/2026-10-07/sid-old.log.md" 120
OUT=$(run_warmup startup WORKBENCH_AUTO_SUMMARIZE=1)
assert_missing  "an id it parsed is still skipped, however old its log" "$OUT" "DISPATCH sid=sid-live"
assert_missing  "a marker written within the quiet period is skipped"   "$OUT" "DISPATCH sid=sid-recent"
assert_contains "an older one is drained"                               "$OUT" "DISPATCH sid=sid-old"
mkdir -p "$SANDBOX/claude-noreg"
OUT=$(run_warmup startup WORKBENCH_AUTO_SUMMARIZE=1 WORKBENCH_DRAIN_COOLDOWN_MIN=0 CLAUDE_CONFIG_DIR="$SANDBOX/claude-noreg")
assert_missing  "with no registry at all, a recent marker is skipped too" "$OUT" "DISPATCH sid=sid-recent"
assert_path     "a skipped marker stays for a later start"              "$PENDING/sid-recent.json"
age "$MEM/sessions/2026-10-07/sid-recent.log.md" 120
OUT=$(run_warmup startup WORKBENCH_AUTO_SUMMARIZE=1 WORKBENCH_DRAIN_COOLDOWN_MIN=0 CLAUDE_CONFIG_DIR="$SANDBOX/claude-noreg")
assert_contains "once its log has been quiet that long, a later start drains it" "$OUT" "DISPATCH sid=sid-recent"

echo "session_live_ids keeps the ids it parsed, and still reports the gap:"
reset
register "$$" "sid-a"
printf 'not json' > "$REG/$PPID.json"
IDS="$(. "$HOOKS_DIR/lib/session-reconcile.sh"; session_live_ids "$REG")"; RC=$?
assert_eq "the parsed id is printed" "$IDS" "sid-a"
assert_eq "and the call fails closed for the reconciler" "$RC" 1

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
