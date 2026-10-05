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
#   - the start-up reconciler               → mode=reconcile (WORKBENCH_LOG_MODE=reconcile)
#
# The reconciler (hooks/lib/session-reconcile.sh, run by session-warmup.sh)
# feeds this script the sessions that never got a usable SessionEnd: a reboot, a
# kill, or a final segment deferred by the size cap below, which it finds by the
# `<session>.deferred` file the cap leaves. It is how a session with no marker still reaches
# the drain.
#
# Never fails the hook. Always exits 0. Worst case: the session ends without
# a log entry, and the next session start's reconciler logs it from the
# transcript.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/hooks}"
HOOKS_DIR="${HOOKS_DIR:-$SCRIPT_DIR}"

# Config resolution: env var → config.json → hardcoded default, through the
# shared resolver in lib/memory-env.sh. The cache path in particular MUST come
# from memory_resolve_cache_path: this script writes the pending-summary
# markers, and hooks/destructive-scope-guard.sh permits deleting them only in
# the folder that same function names. Two copies of the lookup could drift
# apart, and a marker written where the guard is not looking cannot be deleted.
# shellcheck source=hooks/lib/memory-env.sh
. "$HOOKS_DIR/lib/memory-env.sh"
CONFIG_FILE="$(memory_resolve_config_file)"
_cfg() { [ -f "$CONFIG_FILE" ] && command -v jq >/dev/null 2>&1 && jq -r "$1 // empty" "$CONFIG_FILE" 2>/dev/null; }

# Warn on malformed config (logged to stderr so it doesn't break hook stdout).
if [ -f "$CONFIG_FILE" ] && command -v jq >/dev/null 2>&1; then
  if ! jq empty "$CONFIG_FILE" 2>/dev/null; then
    echo "session-log: WARNING — config.json is malformed, using defaults" >&2
  fi
fi

MEMORY_PATH="${WORKBENCH_MEMORY_PATH:-$(_cfg '.memory_path')}"
MEMORY_PATH="${MEMORY_PATH:-$HOME/Documents/Claude/Memory}"
CACHE_PATH="$(memory_resolve_cache_path)"
PENDING_SUMMARIES_DIR="$CACHE_PATH/pending-summaries"
CHECKPOINTS_DIR="$CACHE_PATH/log-checkpoints"

# Shared writer-spawn helpers. Sourced after MEMORY_PATH/CACHE_PATH/_cfg exist —
# the lib reads all three. Honor CLAUDE_PLUGIN_ROOT (set by Claude Code's hook
# host) and fall back to a BASH_SOURCE-relative path (HOOKS_DIR, resolved at
# the top) so manual and test invocations still resolve hooks/lib.
# shellcheck source=hooks/lib/summary-dispatch.sh
. "$HOOKS_DIR/lib/summary-dispatch.sh"
# session_transcript_disposable lives with the reconciler, so the rule for which
# transcripts are never logged has one copy that both of them read.
# shellcheck source=hooks/lib/session-reconcile.sh
. "$HOOKS_DIR/lib/session-reconcile.sh"

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
# SessionEnd carries why the session ended (clear, logout, prompt_input_exit,
# other, and so on). It goes on the marker, so a lost or partial log can be
# traced to the kind of exit that produced it.
REASON=$(printf '%s' "$PAYLOAD" | jq -r '.reason // empty' 2>/dev/null)

if [ -z "$SESSION_ID" ] || [ -z "$TRANSCRIPT" ] || [ ! -r "$TRANSCRIPT" ]; then
  exit 0
fi

# ──────────── Disposable-workspace filter ────────────
# Sessions run in throwaway scratch, eval, or probe roots must never produce a
# log or a marker. They are real sessions with real prompts, so the
# summary-writer's idle-tick check (step 2.5) correctly lets them through — but
# the pollution here is COLLECTIVE, not per-session: on 2026-08-19 a single
# `.../scratchpad/evalroot` fixture accounted for 274 of 332 processable markers
# (83%), each of which would have become a defensible, near-identical summary of
# a two-file repo. A per-document quality bar cannot see that shape, so the
# filter belongs here, at the source, before a marker is ever queued.
#
# Filtering at summary time is too late: the marker already exists, already
# queues, and already costs a full agent dispatch to reject.
# The patterns live in session_transcript_disposable (hooks/lib/session-reconcile.sh),
# which the start-up reconciler applies to the same transcripts.
if session_transcript_disposable "$TRANSCRIPT"; then
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
EXISTING_LOG=""
DEFERRAL="$CHECKPOINTS_DIR/${SESSION_ID}.deferred"
if [ -f "$CHECKPOINT" ]; then
  PREV_SID=$(jq -r '.session_id // empty' "$CHECKPOINT" 2>/dev/null)
  if [ "$PREV_SID" = "$SESSION_ID" ]; then
    START_LINE=$(jq -r '.next_line // 1' "$CHECKPOINT" 2>/dev/null)
    EXISTING_LOG=$(jq -r '.last_log_file // empty' "$CHECKPOINT" 2>/dev/null)
  fi
fi
# A reconciler run has no SessionEnd payload. A SessionEnd that deferred its
# copy (below) left its reason in the deferral file, and only the segment it
# deferred may use it. Every log write deletes the file, so a resumed session's
# old clean-exit reason never reaches a later segment.
if [ -f "$DEFERRAL" ] && [ -z "$REASON" ]; then
  REASON=$(sed -n '2p' "$DEFERRAL" 2>/dev/null)
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

NOW_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# write_checkpoint <next_line> <log_file> — the per-session resume point. Built
# with jq so a path can never break the JSON.
write_checkpoint() {
  jq -n --arg sid "$SESSION_ID" --argjson next "$1" --arg log "$2" \
    --arg mode "$MODE" --arg at "$NOW_ISO" \
    '{session_id: $sid, next_line: $next, last_log_file: $log,
      last_log_mode: $mode, last_logged_at: $at}' \
    > "$CHECKPOINT.tmp" 2>/dev/null && mv "$CHECKPOINT.tmp" "$CHECKPOINT" 2>/dev/null
}

# ──────────── Exit-budget cap (mode=final only) ────────────
# SessionEnd runs inside Claude Code's exit budget, and a hook still copying
# when that budget ends is killed mid-write. The copy below uses `sed`, which
# moves a 42 MB transcript in about 30 ms. BSD `tail -n +N`, the copy this hook
# used to make, took 1.5 s on the same file. The cap is the hard bound on top: a
# transcript past WORKBENCH_LOG_SYNC_MAX_BYTES (default 128 MB) is not copied at
# exit at all. The checkpoint keeps its old `next_line`, which is still correct,
# and a `<session>.deferred` file beside it holds the transcript path (line 1)
# and the SessionEnd reason (line 2). The next session start's reconciler walks
# those files with no time window, treats each as a segment owed, and logs it
# with no budget to run out of. A file, not a
# checkpoint field: this checkpoint is written after the transcript's last line,
# so an mtime test passes over it, and the reconciler can stat a file for every
# recent transcript where reading every checkpoint would cost a read each.
SYNC_MAX_BYTES="${WORKBENCH_LOG_SYNC_MAX_BYTES:-134217728}"
case "$SYNC_MAX_BYTES" in ''|*[!0-9]*) SYNC_MAX_BYTES=134217728 ;; esac
if [ "$MODE" = "final" ] \
   && [ -n "$(find "$TRANSCRIPT" -prune -size "+${SYNC_MAX_BYTES}c" 2>/dev/null)" ]; then
  mkdir -p "$CHECKPOINTS_DIR" 2>/dev/null || exit 0
  write_checkpoint "$START_LINE" "$EXISTING_LOG"
  printf '%s\n%s\n' "$TRANSCRIPT" "$REASON" > "$DEFERRAL" 2>/dev/null
  exit 0
fi

# ──────────── Write the raw log (one file per session) ────────────
# Instead of creating a new file per hook invocation, we maintain a single
# rolling log per session. The first invocation writes frontmatter + initial
# segment. Subsequent invocations (checkpoints) append new segments to the
# same file. This eliminates the need for the summary-writer to glob and
# stitch siblings.
TODAY=$(date -u +%Y-%m-%d)
# A reconciled session is filed under the day its transcript was last written,
# not the day a later start recovered it. `date -r <file>` reads a file's mtime
# on both BSD and GNU date.
if [ "$MODE" = "reconcile" ]; then
  TODAY=$(date -u -r "$TRANSCRIPT" +%Y-%m-%d 2>/dev/null || date -u +%Y-%m-%d)
fi

# The segment is lines START_LINE..TOTAL_LINES, read with `sed`, which quits at
# TOTAL_LINES so lines appended during the copy wait for the next segment. Never
# `tail -n +N`: the BSD build is about 50 times slower on a large transcript,
# which is what put the SessionEnd copy at risk of the exit budget.
copy_segment() {
  sed -n "${START_LINE},${TOTAL_LINES}p;${TOTAL_LINES}q" "$TRANSCRIPT"
}

if [ -n "$EXISTING_LOG" ] && [ -f "$EXISTING_LOG" ]; then
  # Append to existing log file.
  SEG_FILE="$EXISTING_LOG"
  {
    printf '\n---\n\n'
    printf '## Segment: %s (lines %s–%s, %s)\n\n' "$MODE" "$START_LINE" "$TOTAL_LINES" "$NOW_ISO"
    printf '```jsonl\n'
    copy_segment
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
    copy_segment
    printf '\n```\n'
  } > "$SEG_FILE" 2>/dev/null || exit 0
fi

# ──────────── Update checkpoint ────────────
mkdir -p "$CHECKPOINTS_DIR" "$PENDING_SUMMARIES_DIR" 2>/dev/null || exit 0
write_checkpoint "$((TOTAL_LINES + 1))" "$SEG_FILE"
# The segment a SessionEnd deferred is logged now, so its deferral is closed.
rm -f "$DEFERRAL" 2>/dev/null

# ──────────── Mark pending-summary ────────────
# Every log write (checkpoint, final, manual) gets a marker. With one rolling
# file per session, each summary-writer invocation reads the full log and
# writes a complete summary — later runs overwrite earlier ones. The marker
# uses the session ID as filename so concurrent sessions don't clobber.
#
# `reason` is the SessionEnd reason, or null when no SessionEnd reported one (a
# reboot leaves none). `origin` names the writer: "reconciler" for a marker the
# start-up reconciler created, "session-log" for every hook and /log-now write.
PENDING_SUMMARY_FILE="$PENDING_SUMMARIES_DIR/${SESSION_ID}.json"
ORIGIN="session-log"
[ "$MODE" = "reconcile" ] && ORIGIN="reconciler"
jq -n --arg sid "$SESSION_ID" --arg t "$TRANSCRIPT" --arg log "$SEG_FILE" \
  --arg mode "$MODE" --arg event "$EVENT" --arg at "$NOW_ISO" \
  --arg reason "$REASON" --arg origin "$ORIGIN" \
  '{session_id: $sid, transcript_path: $t, log_path: $log, mode: $mode,
    event: $event, reason: (if $reason == "" then null else $reason end),
    origin: $origin, marked_at: $at}' \
  > "$PENDING_SUMMARY_FILE.tmp" 2>/dev/null \
  && mv "$PENDING_SUMMARY_FILE.tmp" "$PENDING_SUMMARY_FILE" 2>/dev/null

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
# The guard is on MODE, not EVENT, and it is an allowlist. MODE=final is the
# "this is a terminal log write" signal, and an unrecognised event falls through
# to final by design — so any future teardown-time hook inherits the safe path
# (write the marker, let the next session start drain it) instead of the one that
# loses work. mode=reconcile does not dispatch either: it runs inside
# session-warmup.sh just before the drain, which takes the marker from there.
case "$MODE" in
  checkpoint|manual)
    if summary_dispatch_enabled; then
      summary_dispatch_spawn "$SESSION_ID" "$PENDING_SUMMARY_FILE" "$SEG_FILE" "$TRANSCRIPT" || true
    fi
    ;;
esac

exit 0
