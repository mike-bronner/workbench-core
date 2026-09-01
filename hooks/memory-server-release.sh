#!/usr/bin/env bash
#
# memory-server-release: SessionEnd hook. Drops this session's memory-server ref
# and, when it was the last one, reparents the delayed reaper.
#
# Pairs with memory-server-up.sh, which registers the ref at SessionStart. The
# two together give the shared HTTP server a lifetime: up on the first session
# that wants it, down a grace period after the last one leaves.
#
# ── Why the reaper must be detached ────────────────────────────────────────
# This hook fires while the session is shutting down, and the whole process group
# is about to be signalled. A plain background job would die with it and the
# server would never be reaped. So the reaper is put in its own session/process
# group with the same perl-setsid idiom memory-server-up.sh uses for the spawn
# supervisor (macOS ships no setsid binary, and nohup+disown alone does not
# escape the process group).
#
# Releasing is only the FAST path for a clean exit. Correctness comes from the
# pid sweep in lib/memory-refs.sh: a session that is SIGKILLed, or whose terminal
# is closed, never runs this hook at all, and its ref is reclaimed by the sweep
# instead. That is why nothing here needs to be reliable.
#
# Env knobs:
#   WORKBENCH_MEMORY_IDLE_GRACE=0   disable auto-stop (the reaper exits early).
#
# Never fails the session. Always exits 0, always silent on stdout.

set -u

_log() { echo "memory-server-release: $*" >&2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/hooks}"
HOOKS_DIR="${HOOKS_DIR:-$SCRIPT_DIR}"

PAYLOAD=""
if [ ! -t 0 ]; then
  PAYLOAD=$(cat)
fi

command -v jq >/dev/null 2>&1 || exit 0

# shellcheck source=hooks/lib/memory-env.sh
. "$HOOKS_DIR/lib/memory-env.sh" 2>/dev/null || exit 0
# shellcheck source=hooks/lib/memory-refs.sh
. "$HOOKS_DIR/lib/memory-refs.sh" 2>/dev/null || exit 0
memory_load_env 2>/dev/null || exit 0

SESSION_ID=""
if [ -n "$PAYLOAD" ]; then
  SESSION_ID=$(printf '%s' "$PAYLOAD" | jq -r '.session_id // empty' 2>/dev/null)
fi

# Release BOTH identities memory-server-up.sh can register under. That hook is on
# the locked latency-sensitive path and does not parse stdin, so it keys on
# $CLAUDE_SESSION_ID when the harness exports one and falls back to the owning
# claude pid when it does not. This hook does have the payload, so it releases
# the payload's session id AND the pid form — whichever was actually written.
#
# A mismatch would not leak: the pid sweep reclaims any ref whose process is gone,
# and the claude process is exiting right now. Releasing both just makes the
# common case immediate rather than waiting for the reaper's own sweep.
[ -n "$SESSION_ID" ] && memory_ref_release "$SESSION_ID"
[ -n "${CLAUDE_SESSION_ID:-}" ] && memory_ref_release "$CLAUDE_SESSION_ID"
memory_ref_release "pid-$(_memory_refs_owner_pid)"

# No session id at all still runs the sweep below: another session's ref may have
# gone stale, and this is a perfectly good moment to notice.

LIVE="$(memory_refs_count)"
if [ "$LIVE" -ne 0 ]; then
  _log "$LIVE session(s) still live; leaving the server up"
  exit 0
fi

# ──────────── Last one out: schedule the reaper ────────────
if command -v perl >/dev/null 2>&1; then
  perl -e 'use POSIX qw(setsid); setsid; exec @ARGV' -- \
    bash "$HOOKS_DIR/memory-server-idle-stop.sh" >/dev/null 2>&1 < /dev/null &
  disown 2>/dev/null || true
  _log "last session out; reaper scheduled"
else
  nohup bash "$HOOKS_DIR/memory-server-idle-stop.sh" >/dev/null 2>&1 < /dev/null &
  disown 2>/dev/null || true
  _log "last session out; reaper scheduled (nohup fallback)"
fi

exit 0
