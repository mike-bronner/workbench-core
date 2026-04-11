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

# ──────────── Write the raw log (one file per session) ────────────
# Instead of creating a new file per hook invocation, we maintain a single
# rolling log per session. The first invocation writes frontmatter + initial
# segment. Subsequent invocations (checkpoints) append new segments to the
# same file. This eliminates the need for the summary-writer to glob and
# stitch siblings.
TODAY=$(date -u +%Y-%m-%d)
TS=$(date -u +%H%M%SZ)
NOW_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Check if this session already has a log file from a previous checkpoint.
EXISTING_LOG=""
if [ -f "$CHECKPOINT" ]; then
  EXISTING_LOG=$(jq -r '.last_log_file // empty' "$CHECKPOINT" 2>/dev/null)
fi

if [ -n "$EXISTING_LOG" ] && [ -f "$EXISTING_LOG" ]; then
  # Append to existing log file.
  SEG_FILE="$EXISTING_LOG"
  {
    printf '\n---\n\n'
    printf '## Segment: %s (lines %s–%s, %s)\n\n' "$MODE" "$START_LINE" "$TOTAL_LINES" "$NOW_ISO"
    printf '```jsonl\n'
    tail -n "+${START_LINE}" "$TRANSCRIPT" | head -n "$SEG_LINES"
    printf '\n```\n'
  } >> "$SEG_FILE" 2>/dev/null || exit 0
else
  # First log for this session — create with frontmatter.
  SEG_DIR="$MEMORY_PATH/sessions/$TODAY"
  SEG_FILE="$SEG_DIR/${SESSION_ID}.log.md"
  mkdir -p "$SEG_DIR" 2>/dev/null || exit 0
  mkdir -p "$CACHE_PATH" "$PENDING_SUMMARIES_DIR" "$CHECKPOINTS_DIR" 2>/dev/null || exit 0

  {
    printf -- '---\n'
    printf 'name: "Session log — %s"\n' "$SESSION_ID"
    printf 'type: session\n'
    printf 'scope: chronological\n'
    printf 'date: %s\n' "$TODAY"
    printf 'tags: [session, log]\n'
    printf 'session_id: %s\n' "$SESSION_ID"
    printf 'transcript: %s\n' "$TRANSCRIPT"
    printf 'start_line: %s\n' "$START_LINE"
    printf 'logged_at: %s\n' "$NOW_ISO"
    printf 'summary: |\n'
    printf '  Raw session log. Awaiting narrative summary (sibling `.summary.md`).\n'
    printf -- '---\n\n'
    printf '# Session log — %s\n\n' "$SESSION_ID"
    printf '## Segment: %s (lines %s–%s, %s)\n\n' "$MODE" "$START_LINE" "$TOTAL_LINES" "$NOW_ISO"
    printf '```jsonl\n'
    tail -n "+${START_LINE}" "$TRANSCRIPT" | head -n "$SEG_LINES"
    printf '\n```\n'
  } > "$SEG_FILE" 2>/dev/null || exit 0
fi

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

# ──────────── Mark pending-summary ────────────
# Every log write (checkpoint, final, manual) gets a marker. With one rolling
# file per session, each summary-writer invocation reads the full log and
# writes a complete summary — later runs overwrite earlier ones. The marker
# uses the session ID as filename so concurrent sessions don't clobber.
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

# ──────────── Dispatch background summary-writer ────────────
# Spawn a detached claude process on every log write. With one rolling file
# per session, each summary-writer reads the full log and writes a complete
# summary. Checkpoint summaries get overwritten by the final one — the last
# writer wins, which is always the most complete.
#
# Defense in depth: if the spawn fails or the background claude errors out,
# the marker stays in place and the next session's warmup hook picks it up.
#
# Safeguards:
#   - WORKBENCH_SKIP_LOG=1 prevents the spawned claude's own SessionEnd hook
#     from recursing into another summary-writer.
#   - WORKBENCH_SKIP_WARMUP=1 prevents identity injection and pending-summary
#     scanning in the spawned process.
#   - --no-session-persistence prevents the spawned claude from leaving a
#     transcript that would become a new pending summary.
#   - nohup + & + disown fully detaches so this hook returns immediately.
if [[ "${WORKBENCH_AUTO_SUMMARIZE:-$(_cfg '.auto_summarize')}" =~ ^(1|true)$ ]] \
    && command -v claude >/dev/null 2>&1; then
  SUMMARY_MODEL="${WORKBENCH_SUMMARY_MODEL:-$(_cfg '.summary_model')}"
  SUMMARY_MODEL="${SUMMARY_MODEL:-haiku}"
  SUMMARY_WRITER_LOG="$CACHE_PATH/summary-writer-${SESSION_ID}.log"
  SUMMARY_WRITER_PROMPT="Process pending session summary.

session_id: ${SESSION_ID}
marker_path: ${PENDING_SUMMARY_FILE}
log_path: ${SEG_FILE}

Follow your agent definition. Write the summary, promote any decisions, delete the marker, and exit."
  WORKBENCH_SKIP_LOG=1 WORKBENCH_SKIP_WARMUP=1 nohup claude -p \
    --no-session-persistence \
    --permission-mode bypassPermissions \
    --model "$SUMMARY_MODEL" \
    --agent summary-writer \
    "$SUMMARY_WRITER_PROMPT" \
    > "$SUMMARY_WRITER_LOG" 2>&1 &
  disown 2>/dev/null || true
fi

exit 0
