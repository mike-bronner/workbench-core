#!/usr/bin/env bash
#
# memory-server-release: SessionEnd hook. Schedules the delayed reaper when this
# looks like the last Claude Code process standing.
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
# ── Why this does NOT delete its own ref ───────────────────────────────────
# Refs are keyed by the owning `claude` PROCESS, not by session id (see
# lib/memory-refs.sh). At the moment this hook runs, that process is still very
# much alive — SessionEnd fires as one session finishes, and the process may
# have other sessions still using the server. Deleting the ref here would drop
# the count to zero under live sessions and let the reaper kill a server that is
# still in use.
#
# So the ref is left alone and reclaimed by the pid sweep instead. The reaper's
# grace period is exactly the window in which a genuinely exiting process
# finishes exiting: by the time it sweeps, the pid is gone, the ref clears, the
# count reaches zero, and the server stops. If the process is still alive
# because other sessions continue, the ref survives and the reaper stands down.
#
# This also means nothing here has to be reliable. A process that is SIGKILLed
# never runs this hook at all, and the sweep reclaims it just the same.
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

# Drain stdin so the harness's write never blocks. The payload is not parsed:
# the ref is keyed by the owning process, which is discovered from the process
# tree, so nothing here needs the session id — and dropping the parse drops the
# jq dependency with it, making this hook work on a box that has no jq.
if [ ! -t 0 ]; then
  cat >/dev/null 2>&1 || true
fi

# shellcheck source=hooks/lib/memory-env.sh
. "$HOOKS_DIR/lib/memory-env.sh" 2>/dev/null || exit 0
# shellcheck source=hooks/lib/memory-refs.sh
. "$HOOKS_DIR/lib/memory-refs.sh" 2>/dev/null || exit 0
memory_load_env 2>/dev/null || exit 0

# Clear any session-keyed refs left by a pre-0.19.3 install, so the count is not
# inflated by files the current glob would otherwise ignore forever.
memory_refs_migrate_legacy

# The sweep also reclaims OTHER processes' refs that have gone stale, which makes
# this a perfectly good moment to run it regardless of what we decide below.
LIVE="$(memory_refs_count)"

# More than one live process means another Claude Code is still using the server
# — nothing to schedule. At exactly one, that one is almost certainly us, and we
# are on the way out: schedule the reaper so something outside this process is
# around to notice when the pid finally goes. At zero, our own ref is already
# gone (an unwritable cache, or a manual release) and the server should still be
# reaped.
if [ "$LIVE" -gt 1 ]; then
  _log "$LIVE live Claude Code process(es); leaving the server up"
  exit 0
fi

# ──────────── Likely last one out: schedule the reaper ────────────
if command -v perl >/dev/null 2>&1; then
  perl -e 'use POSIX qw(setsid); setsid; exec @ARGV' -- \
    bash "$HOOKS_DIR/memory-server-idle-stop.sh" >/dev/null 2>&1 < /dev/null &
  disown 2>/dev/null || true
  _log "likely last process out (live refs: $LIVE); reaper scheduled"
else
  nohup bash "$HOOKS_DIR/memory-server-idle-stop.sh" >/dev/null 2>&1 < /dev/null &
  disown 2>/dev/null || true
  _log "likely last process out (live refs: $LIVE); reaper scheduled (nohup fallback)"
fi

exit 0
