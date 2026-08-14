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
# Prefer the current data dir; fall back to the pre-rename location so users
# who customized before the workbench → workbench-core rename keep working.
CONFIG_FILE="$HOME/.claude/plugins/data/workbench-core-claude-workbench/config.json"
LEGACY_CONFIG="$HOME/.claude/plugins/data/workbench-claude-workbench/config.json"
if [ ! -f "$CONFIG_FILE" ] && [ -f "$LEGACY_CONFIG" ]; then
  CONFIG_FILE="$LEGACY_CONFIG"
fi
_cfg() { [ -f "$CONFIG_FILE" ] && command -v jq >/dev/null 2>&1 && jq -r "$1 // empty" "$CONFIG_FILE" 2>/dev/null; }

# Warn on malformed config (logged to stderr so it doesn't break hook stdout).
if [ -f "$CONFIG_FILE" ] && command -v jq >/dev/null 2>&1; then
  if ! jq empty "$CONFIG_FILE" 2>/dev/null; then
    echo "session-log: WARNING — config.json is malformed, using defaults" >&2
  fi
fi

MEMORY_PATH="${WORKBENCH_MEMORY_PATH:-$(_cfg '.memory_path')}"
MEMORY_PATH="${MEMORY_PATH:-$HOME/Documents/Claude/Memory}"
CACHE_PATH="${WORKBENCH_MEMORY_CACHE:-$(_cfg '.memory_cache')}"
CACHE_PATH="${CACHE_PATH:-$HOME/.claude-memory-cache}"
PENDING_SUMMARIES_DIR="$CACHE_PATH/pending-summaries"
CHECKPOINTS_DIR="$CACHE_PATH/log-checkpoints"

# Shared writer-spawn helpers. Sourced after MEMORY_PATH/CACHE_PATH/_cfg exist —
# the lib reads all three. Honor CLAUDE_PLUGIN_ROOT (set by Claude Code's hook
# host) and fall back to a BASH_SOURCE-relative path so manual and test
# invocations still resolve hooks/lib, matching session-warmup.sh.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/hooks}"
HOOKS_DIR="${HOOKS_DIR:-$SCRIPT_DIR}"
# shellcheck source=hooks/lib/summary-dispatch.sh
. "$HOOKS_DIR/lib/summary-dispatch.sh"

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
# Spawn a detached claude process — but ONLY when this session is going to stay
# alive long enough to host it. With one rolling file per session, each writer
# reads the full log and writes a complete summary; checkpoint summaries get
# overwritten by the final one, so the last writer wins and is the most complete.
#
# SessionEnd is deliberately excluded. A child spawned as the parent CLI exits is
# killed during teardown — `nohup` covers SIGHUP, not a process-group SIGTERM or
# the OS reaping the job when the parent goes away. From 2026-07-31 to
# 2026-08-14 that stranded 968 markers, every one of them `event: SessionEnd`
# and not one PreCompact: the asymmetry that identified the bug. Those sessions
# are not lost — the marker persists and session-warmup.sh drains it at the next
# session start, where the parent is alive by definition. That was always the
# documented fallback; it is now an actual drain rather than a nudge.
#
# PreCompact (mode=checkpoint) and /log-now (mode=manual) still dispatch inline:
# both fire mid-session with the parent alive and staying alive, which is exactly
# why PreCompact markers never accumulated.
#
# The guard is on MODE, not EVENT. MODE=final is the "this is a terminal log
# write" signal, and an unrecognised event falls through to final by design — so
# any future teardown-time hook inherits the safe path (write the marker, let the
# next session start drain it) instead of the one that loses work.
if [ "$MODE" != "final" ] && summary_dispatch_enabled; then
  summary_dispatch_spawn "$SESSION_ID" "$PENDING_SUMMARY_FILE" "$SEG_FILE" || true
fi

exit 0
