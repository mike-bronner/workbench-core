#!/usr/bin/env bash
#
# process-pending-summaries.sh [<session-id> [--overwrite]]
#
# The work behind /process-pending-summaries, which hooks/register.ts answers
# with no model turn. It spawns detached summary-writers through
# hooks/lib/summary-dispatch.sh, the helper session-warmup.sh drains with, and
# prints one line for the hook to report:
#
#   no argument        drain the backlog
#     result=none                          no marker is pending
#     result=drained dispatched=N live=L dead=D total=T
#   <session-id>       summarize that one session
#     result=invalid-id                    the id holds more than letters,
#                                          digits and -
#     result=unrecoverable                 no log and no transcript
#     result=exists summary=<path>         a summary is there already, and
#                                          --overwrite was not given
#     result=dispatched                    one writer is running
#     result=failed                        the spawn refused
#   either
#     result=unavailable reason=<what>     jq or claude is missing
#
# THE DRAIN. A marker is live when its log or its transcript is still on disk:
# the log is a 7-day cache and the transcript lives about 30 days, so a missing
# log is a cache miss, never a lost session. A dead marker (both gone, or no
# session id) is counted and left alone: it is the only record that a session
# went unsummarized, and purging it is a separate, deliberate sweep. The live
# markers are taken oldest first by marked_at (the file's mtime when it has
# none), at most 10 a run, because the binding deadline is transcript
# retention and the oldest are nearest it. Filtering before sorting is the fix
# for the 2026-07-18 deadlock, when every run picked 10 dead markers.
#
# ONE SESSION. With no marker, one is written in the shape hooks/session-log.sh
# writes, so the writer has its usual input. An existing summary is never
# replaced without --overwrite: the hook asks Mike first.
#
# Under WORKBENCH_DISPATCH_DRY_RUN=1 (tests only) the spawn helper prints its
# resolved invocation instead of spawning, and claude need not be installed.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/hooks}"
HOOKS_DIR="${HOOKS_DIR:-$(cd "$SCRIPT_DIR/../hooks" && pwd)}"
BATCH=10

say() { printf '%s\n' "$*"; exit 0; }

command -v jq >/dev/null 2>&1 || say 'result=unavailable reason=jq'
if [ "${WORKBENCH_DISPATCH_DRY_RUN:-}" != 1 ]; then
  command -v claude >/dev/null 2>&1 || say 'result=unavailable reason=claude'
fi

# shellcheck source=hooks/lib/memory-env.sh
. "$HOOKS_DIR/lib/memory-env.sh" || say 'result=unavailable reason=memory-env'
memory_load_env
CONFIG_FILE="$(memory_resolve_config_file)"
# summary_dispatch_model reads the writer's model through _cfg.
_cfg() { [ -f "$CONFIG_FILE" ] && jq -r "$1 // empty" "$CONFIG_FILE" 2>/dev/null; }
# shellcheck source=hooks/lib/summary-dispatch.sh
. "$HOOKS_DIR/lib/summary-dispatch.sh"

PENDING="$CACHE_PATH/pending-summaries"
# A claim whose writer is done, or past its TTL, no longer holds its marker.
summary_dispatch_sweep_claims "$PENDING"
SID="${1:-}"

if [ -n "$SID" ]; then
  case "$SID" in *[!A-Za-z0-9-]*) say 'result=invalid-id' ;; esac
  MARKER="$PENDING/$SID.json"
  LOG="$(find "$MEMORY_PATH/sessions" -maxdepth 2 -name "$SID.log.md" 2>/dev/null | head -1)"
  SUMMARY="$(find "$MEMORY_PATH/sessions" -maxdepth 2 -name "$SID.summary.md" 2>/dev/null | head -1)"
  TRANSCRIPT="$(find "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects" -maxdepth 2 -name "$SID.jsonl" 2>/dev/null | head -1)"
  [ -n "$LOG" ] || [ -n "$TRANSCRIPT" ] || say 'result=unrecoverable'
  [ -n "$SUMMARY" ] && [ "${2:-}" != --overwrite ] && say "result=exists summary=$SUMMARY"
  if [ ! -f "$MARKER" ]; then
    mkdir -p "$PENDING"
    jq -n --arg sid "$SID" --arg t "$TRANSCRIPT" --arg l "$LOG" \
      --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{session_id:$sid, transcript_path:$t, log_path:$l, mode:"manual", event:"ProcessPendingSummaries", marked_at:$at}' \
      > "$MARKER" || say 'result=failed'
  fi
  if summary_dispatch_spawn "$SID" "$MARKER" "$LOG" "$TRANSCRIPT"; then
    say 'result=dispatched'
  fi
  say 'result=failed'
fi

TOTAL=0
DEAD=0
LIVE=''
for marker in "$PENDING"/*.json; do
  [ -f "$marker" ] || continue
  TOTAL=$((TOTAL + 1))
  sid="$(jq -r '.session_id // empty' "$marker" 2>/dev/null)"
  log="$(jq -r '.log_path // empty' "$marker" 2>/dev/null)"
  transcript="$(jq -r '.transcript_path // empty' "$marker" 2>/dev/null)"
  if [ -z "$sid" ] || ! summary_dispatch_readable "$log" "$transcript"; then
    DEAD=$((DEAD + 1))
    continue
  fi
  at="$(jq -r '.marked_at // empty' "$marker" 2>/dev/null)"
  [ -n "$at" ] || at="$(date -u -r "$marker" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)"
  LIVE+="$at"$'\t'"$marker"$'\n'
done
[ "$TOTAL" -gt 0 ] || say 'result=none'

LIVE_COUNT=$((TOTAL - DEAD))
DISPATCHED=0
while IFS=$'\t' read -r _ marker; do
  [ -n "$marker" ] || continue
  [ "$DISPATCHED" -ge "$BATCH" ] && break
  if summary_dispatch_spawn "$(jq -r '.session_id' "$marker")" "$marker" \
       "$(jq -r '.log_path // empty' "$marker")" "$(jq -r '.transcript_path // empty' "$marker")"; then
    DISPATCHED=$((DISPATCHED + 1))
  fi
done <<< "$(printf '%s' "$LIVE" | sort)"

say "result=drained dispatched=$DISPATCHED live=$((LIVE_COUNT - DISPATCHED)) dead=$DEAD total=$TOTAL"
