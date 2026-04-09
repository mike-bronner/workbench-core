#!/usr/bin/env bash
#
# session-wrap: dump the current session's JSONL segment to disk and mark a
# pending-wrap for the next session-warmup to turn into a narrative.
#
# Invoked by:
#   - the `core` plugin's PreCompact hook → mode=checkpoint
#   - the `core` plugin's SessionEnd hook  → mode=final
#   - the /log-now slash command            → mode=manual (HOBBES_WRAP_MODE=manual)
#
# Never fails the hook. Always exits 0. Worst case: the session ends without a
# log entry; the next warmup finds no pending-wrap and proceeds.

set -u

# TODO: move to userConfig once the plugin system supports it.
MEMORY_PATH="${HOBBES_MEMORY_PATH:-/Users/mike/Documents/Claude/Memory}"
CACHE_PATH="${HOBBES_MEMORY_CACHE:-$HOME/.claude-memory-cache}"
PENDING_WRAP_DIR="$CACHE_PATH/pending-wraps"
CHECKPOINT="$CACHE_PATH/wrap-checkpoint.json"

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

# ──────────── Determine mode ────────────
MODE="${HOBBES_WRAP_MODE:-}"
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
mkdir -p "$CACHE_PATH" "$PENDING_WRAP_DIR" 2>/dev/null || exit 0

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
  printf 'wrapped_at: %s\n' "$NOW_ISO"
  printf 'summary: |\n'
  printf '  Raw session log segment dumped by session-wrap (%s).\n' "$MODE"
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
  "last_wrap_file": "$SEG_FILE",
  "last_wrap_mode": "$MODE",
  "last_wrap_at": "$NOW_ISO"
}
EOF

# ──────────── Mark pending-wrap on final/manual ────────────
# Checkpoints don't get a pending-wrap marker — they're intermediate and the
# session is still live. Only final (SessionEnd) and manual (/log-now) produce
# a marker that the next warmup should pick up.
#
# Each marker lives at $PENDING_WRAP_DIR/$SESSION_ID.json so multiple concurrent
# sessions can all leave markers without clobbering each other. This is the
# fix for the 2026-04-09 multi-session race where a Claude Code app restart
# fired SessionEnd in several sessions simultaneously and the single-slot
# pending-wrap.json lost all but the last writer's marker.
if [ "$MODE" != "checkpoint" ]; then
  PENDING_WRAP_FILE="$PENDING_WRAP_DIR/${SESSION_ID}.json"
  cat > "$PENDING_WRAP_FILE" <<EOF
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

exit 0
