#!/usr/bin/env bash
#
# session-log: dump the current session's JSONL segment to disk and mark a
# pending-summary for the next session-warmup (or the summary-writer agent)
# to turn into a narrative.
#
# Invoked by:
#   - the `core` plugin's PreCompact hook → mode=checkpoint
#   - the `core` plugin's SessionEnd hook  → mode=final
#   - the /log-now slash command            → mode=manual (WORKBENCH_LOG_MODE=manual)
#
# Never fails the hook. Always exits 0. Worst case: the session ends without
# a log entry; the next warmup finds no pending-summary and proceeds.

set -u

# Config resolution: env var → config.json → hardcoded default.
CONFIG_FILE="$HOME/.claude/plugins/data/workbench-claude-workbench/config.json"
_cfg() { [ -f "$CONFIG_FILE" ] && command -v jq >/dev/null 2>&1 && jq -r "$1 // empty" "$CONFIG_FILE" 2>/dev/null; }

MEMORY_PATH="${WORKBENCH_MEMORY_PATH:-$(_cfg '.memory_path')}"
MEMORY_PATH="${MEMORY_PATH:-$HOME/Documents/Claude/Memory}"
CACHE_PATH="${WORKBENCH_MEMORY_CACHE:-$(_cfg '.memory_cache')}"
CACHE_PATH="${CACHE_PATH:-$HOME/.claude-memory-cache}"
PENDING_SUMMARIES_DIR="$CACHE_PATH/pending-summaries"
CHECKPOINTS_DIR="$CACHE_PATH/log-checkpoints"

# ──────────── Recursion guard ────────────
# The dispatch block at the bottom of this script spawns a detached claude
# process with WORKBENCH_SKIP_LOG=1 set. That process's own SessionEnd hook
# fires this same script; this guard prevents it from trying to log its
# own ephemeral session and potentially cascading into infinite dispatch.
if [ "${WORKBENCH_SKIP_LOG:-}" = "1" ]; then
  exit 0
fi

# ──────────── Read hook payload ────────────
PAYLOAD=""
if [ ! -t 0 ]; then
  PAYLOAD=$(cat)
fi

if [ -z "$PAYLOAD" ]; then
  # Nothing to work with. Exit silently.
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  # jq missing — can't parse the payload. Exit silently.
  exit 0
fi

SESSION_ID=$(printf '%s' "$PAYLOAD" | jq -r '.session_id // empty' 2>/dev/null)
TRANSCRIPT=$(printf '%s' "$PAYLOAD" | jq -r '.transcript_path // empty' 2>/dev/null)
EVENT=$(printf '%s' "$PAYLOAD" | jq -r '.hook_event_name // "SessionEnd"' 2>/dev/null)

if [ -z "$SESSION_ID" ] || [ -z "$TRANSCRIPT" ] || [ ! -r "$TRANSCRIPT" ]; then
  exit 0
fi

# ──────────── Per-session checkpoint ────────────
CHECKPOINT="$CHECKPOINTS_DIR/${SESSION_ID}.json"

# Migration: if old single-slot checkpoint exists and matches this session,
# adopt it into the per-session directory.
OLD_CHECKPOINT="$CACHE_PATH/log-checkpoint.json"
if [ ! -f "$CHECKPOINT" ] && [ -f "$OLD_CHECKPOINT" ]; then
  OLD_SID=$(jq -r '.session_id // empty' "$OLD_CHECKPOINT" 2>/dev/null)
  if [ "$OLD_SID" = "$SESSION_ID" ]; then
    mkdir -p "$CHECKPOINTS_DIR" 2>/dev/null
    mv "$OLD_CHECKPOINT" "$CHECKPOINT" 2>/dev/null
  fi
fi

# ──────────── Determine mode ────────────
MODE="${WORKBENCH_LOG_MODE:-}"
if [ -z "$MODE" ]; then
  case "$EVENT" in
    PreCompact) MODE="checkpoint" ;;
    SessionEnd) MODE="final" ;;
    *)          MODE="final" ;;
  esac
fi

# ──────────── Determine segment bounds ────────────
START_LINE=1
if [ -f "$CHECKPOINT" ]; then
  PREV_SID=$(jq -r '.session_id // empty' "$CHECKPOINT" 2>/dev/null)
  if [ "$PREV_SID" = "$SESSION_ID" ]; then
    START_LINE=$(jq -r '.next_line // 1' "$CHECKPOINT" 2>/dev/null)
  fi
fi

# Clamp START_LINE to a positive integer.
case "$START_LINE" in
  ''|*[!0-9]*) START_LINE=1 ;;
esac

TOTAL_LINES=$(wc -l < "$TRANSCRIPT" 2>/dev/null | tr -d ' ')
case "$TOTAL_LINES" in
  ''|*[!0-9]*) TOTAL_LINES=0 ;;
esac

if [ "$TOTAL_LINES" -lt "$START_LINE" ]; then
  # Nothing new since last checkpoint.
  exit 0
fi

SEG_LINES=$((TOTAL_LINES - START_LINE + 1))

# ──────────── Write the raw log ────────────
TODAY=$(date -u +%Y-%m-%d)
TS=$(date -u +%H%M%SZ)
SEG_DIR="$MEMORY_PATH/sessions/$TODAY"
SEG_FILE="$SEG_DIR/${SESSION_ID}-${TS}-${MODE}.log.md"
mkdir -p "$SEG_DIR" 2>/dev/null || exit 0
mkdir -p "$CACHE_PATH" "$PENDING_SUMMARIES_DIR" "$CHECKPOINTS_DIR" 2>/dev/null || exit 0

NOW_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)

{
  printf -- '---\n'
  printf 'name: "Session log — %s %s %s"\n' "$SESSION_ID" "$MODE" "$TS"
  printf 'type: session\n'
  printf 'scope: chronological\n'
  printf 'date: %s\n' "$TODAY"
  printf 'tags: [session, log, %s]\n' "$MODE"
  printf 'session_id: %s\n' "$SESSION_ID"
  printf 'mode: %s\n' "$MODE"
  printf 'event: %s\n' "$EVENT"
  printf 'transcript: %s\n' "$TRANSCRIPT"
  printf 'start_line: %s\n' "$START_LINE"
  printf 'end_line: %s\n' "$TOTAL_LINES"
  printf 'logged_at: %s\n' "$NOW_ISO"
  printf 'summary: |\n'
  printf '  Raw session log segment dumped by session-log (%s).\n' "$MODE"
  printf '  Awaiting narrative summary (sibling `.summary.md` when written).\n'
  printf -- '---\n\n'
  printf '# Raw JSONL segment\n\n'
  printf 'Lines %s–%s of `%s`.\n\n' "$START_LINE" "$TOTAL_LINES" "$TRANSCRIPT"
  printf '```jsonl\n'
  tail -n "+${START_LINE}" "$TRANSCRIPT" | head -n "$SEG_LINES"
  printf '\n```\n'
} > "$SEG_FILE" 2>/dev/null || exit 0

# ──────────── Update checkpoint ────────────
NEXT=$((TOTAL_LINES + 1))
cat > "$CHECKPOINT" <<EOF
{
  "session_id": "$SESSION_ID",
  "next_line": $NEXT,
  "last_log_file": "$SEG_FILE",
  "last_log_mode": "$MODE",
  "last_logged_at": "$NOW_ISO"
}
EOF

# ──────────── Mark pending-summary on final/manual ────────────
# Checkpoints don't get a pending-summary marker — they're intermediate and
# the session is still live. Only final (SessionEnd) and manual (/log-now)
# produce a marker that the next warmup (or the summary-writer agent) should
# pick up.
#
# Each marker lives at $PENDING_SUMMARIES_DIR/$SESSION_ID.json so multiple
# concurrent sessions can all leave markers without clobbering each other.
PENDING_SUMMARY_FILE=""
if [ "$MODE" != "checkpoint" ]; then
  PENDING_SUMMARY_FILE="$PENDING_SUMMARIES_DIR/${SESSION_ID}.json"
  cat > "$PENDING_SUMMARY_FILE" <<EOF
{
  "session_id": "$SESSION_ID",
  "transcript_path": "$TRANSCRIPT",
  "log_path": "$SEG_FILE",
  "mode": "$MODE",
  "event": "$EVENT",
  "marked_at": "$NOW_ISO"
}
EOF
fi

# ──────────── Dispatch background summary-writer (experimental) ────────────
# When WORKBENCH_AUTO_SUMMARIZE=1, spawn a detached claude process running
# the summary-writer agent. It reads the marker + raw log and writes a
# narrative summary directly to the vault via the memory MCP, then deletes
# the marker.
#
# Defense in depth: if the spawn fails or the background claude errors out,
# the marker stays in place and the next session's warmup hook picks it up
# just like 0.1.5 without this block.
#
# Safeguards:
#   - WORKBENCH_SKIP_LOG=1 on the spawn prevents the spawned claude's own
#     SessionEnd hook from recursing into another summary-writer (handled
#     by the early-exit guard at the top of this script).
#   - WORKBENCH_SKIP_WARMUP=1 on the spawn prevents the spawned claude's
#     SessionStart hook from injecting identity or scanning pending
#     summaries (it shouldn't touch any work other than its assigned job).
#   - --no-session-persistence prevents the spawned claude from leaving a
#     JSONL transcript behind, which would otherwise become a new pending
#     summary when its SessionEnd fires.
#   - nohup + & + disown fully detaches the process so this hook returns
#     immediately; the summary-writer runs asynchronously while the user's
#     session ends normally.
if [ "$MODE" != "checkpoint" ] \
    && [ -n "$PENDING_SUMMARY_FILE" ] \
    && [ "${WORKBENCH_AUTO_SUMMARIZE:-}" = "1" ] \
    && command -v claude >/dev/null 2>&1; then
  SUMMARY_WRITER_LOG="$CACHE_PATH/summary-writer-${SESSION_ID}.log"
  SUMMARY_WRITER_PROMPT="Process pending session summary.

session_id: ${SESSION_ID}
marker_path: ${PENDING_SUMMARY_FILE}
log_path: ${SEG_FILE}

Follow your agent definition. Write the summary, update the daily journal, promote any decisions, delete the marker, and exit."
  WORKBENCH_SKIP_LOG=1 WORKBENCH_SKIP_WARMUP=1 nohup claude -p \
    --no-session-persistence \
    --permission-mode bypassPermissions \
    --agent summary-writer \
    "$SUMMARY_WRITER_PROMPT" \
    > "$SUMMARY_WRITER_LOG" 2>&1 &
  disown 2>/dev/null || true
fi

exit 0
