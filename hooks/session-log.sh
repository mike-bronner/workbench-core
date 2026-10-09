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
#   - the hooks module, after each main-loop turn, answered or interrupted
#                                           → mode=turn (WORKBENCH_LOG_MODE=turn)
#   - the hooks module's session.end, which also fires on SIGHUP and SIGTERM
#                                           → mode=final (hook_event_name SessionEnd)
#
# Every caller shares one checkpoint per session, log-checkpoints/<sid>.json,
# and its `next_line`. A per-session lock (below) makes each write read the
# checkpoint, copy, and advance it as one step, so two callers that overlap (a
# turn checkpoint and SessionEnd, or the settings SessionEnd and the module's
# session.end) never copy the same line twice.
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
# markers, and the destructive-scope guard (hooks/mods/destructive-scope.ts)
# permits deleting them only in the folder that same function names, read
# through roots() in hooks/lib/scope-facts.sh. Two copies of the lookup could drift
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
# shellcheck source=hooks/lib/dir-lock.sh
. "$HOOKS_DIR/lib/dir-lock.sh"

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
# The id names the log, the checkpoint, the lock and the marker, so it may hold
# nothing that could leave those folders.
case "$SESSION_ID" in *[!A-Za-z0-9_-]*) exit 0 ;; esac
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

# ──────────── Per-session lock ────────────
# Every writer of this session's log holds it from the checkpoint read to the
# checkpoint write. Without it, two writers read the same `next_line` and both
# append the same lines: the module's turn checkpoint and SessionEnd can run at
# once, and so can the settings SessionEnd and the module's session.end. mkdir
# is the atomic test-and-set. A writer that cannot take it gives up silently:
# the holder is copying the same lines, and any line past its snapshot is left
# for the next writer or the start-up reconciler, never lost. mode=final waits
# about 0.2 s, a small share of the 1.5 s exit budget, so the copy itself still
# fits. Every other mode waits about a second.
#
# A lock older than a minute is a crashed writer's, and is broken without a
# race: hooks/lib/dir-lock.sh.
LOCK="$CHECKPOINTS_DIR/${SESSION_ID}.lock"
mkdir -p "$CHECKPOINTS_DIR" 2>/dev/null || exit 0
LOCK_TRIES=20
[ "$MODE" = "final" ] && LOCK_TRIES=4
dir_lock_acquire "$LOCK" "$LOCK_TRIES" || exit 0
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# ──────────── Determine segment bounds ────────────
START_LINE=1
EXISTING_LOG=""
DEFERRAL="$CHECKPOINTS_DIR/${SESSION_ID}.deferred"
if [ -f "$CHECKPOINT" ]; then
  PREV_SID=$(jq -r '.session_id // empty' "$CHECKPOINT" 2>/dev/null)
  if [ "$PREV_SID" = "$SESSION_ID" ]; then
    START_LINE=$(jq -r '.next_line // 1' "$CHECKPOINT" 2>/dev/null)
    EXISTING_LOG=$(jq -r '.last_log_file // empty' "$CHECKPOINT" 2>/dev/null)
    PENDING_SIZE=$(jq -r '.pending_size // empty' "$CHECKPOINT" 2>/dev/null)
  fi
fi
# A write a kill cut short is rolled back. Each write records the log's size in
# the checkpoint (`pending_size`, with `next_line` still at the segment's first
# line) before it appends, and clears it after. A checkpoint that still holds it
# means the append may have run in part or in full, with `next_line` never
# moved: the log is cut back to that size, and the segment is copied again from
# `next_line`. So a kill at any point leaves no torn segment and logs no line
# twice. A size of 0 is a log the cut write was creating, and it is removed.
case "${PENDING_SIZE:-}" in
  '' | *[!0-9]*) ;;
  0) [ -n "$EXISTING_LOG" ] && rm -f "$EXISTING_LOG" 2>/dev/null ;;
  *)
    if [ -n "$EXISTING_LOG" ] && [ -f "$EXISTING_LOG" ] \
       && [ "$(wc -c < "$EXISTING_LOG" | tr -d ' ')" -gt "$PENDING_SIZE" ]; then
      head -c "$PENDING_SIZE" "$EXISTING_LOG" > "$EXISTING_LOG.cut" 2>/dev/null \
        && mv "$EXISTING_LOG.cut" "$EXISTING_LOG" 2>/dev/null
    fi
    ;;
esac
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

# write_checkpoint <next_line> <log_file> [pending_size] — the per-session
# resume point. Built with jq so a path can never break the JSON. A pending
# size marks a write under way (see the rollback above).
write_checkpoint() {
  jq -n --arg sid "$SESSION_ID" --argjson next "$1" --arg log "$2" \
    --arg mode "$MODE" --arg at "$NOW_ISO" --arg pending "${3:-}" \
    '{session_id: $sid, next_line: $next, last_log_file: $log,
      last_log_mode: $mode, last_logged_at: $at}
     + (if $pending == "" then {} else {pending_size: ($pending | tonumber)} end)' \
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
  # Append to existing log file, its size recorded first for the rollback.
  SEG_FILE="$EXISTING_LOG"
  write_checkpoint "$START_LINE" "$SEG_FILE" "$(wc -c < "$SEG_FILE" | tr -d ' ')" || exit 0
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
  write_checkpoint "$START_LINE" "$SEG_FILE" 0 || exit 0

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
# mode=turn does not dispatch: it runs after every turn, and a writer per turn
# would summarize the same session over and over. Its marker waits for the
# drain at a later start, which skips a session that is still live.
case "$MODE" in
  checkpoint|manual)
    if summary_dispatch_enabled; then
      summary_dispatch_spawn "$SESSION_ID" "$PENDING_SUMMARY_FILE" "$SEG_FILE" "$TRANSCRIPT" || true
    fi
    ;;
esac

exit 0
