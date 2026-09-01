#!/usr/bin/env bash
#
# memory-server-idle-stop: detached delayed reaper for the shared HTTP memory
# server. NOT a hook — memory-server-release.sh reparents it when a SessionEnd
# drops the last live ref.
#
# It is the counterpart to memory-server-up.sh: that brings the server up on the
# first session that needs it, this takes it back down after the last one leaves,
# so an idle machine is not holding the embedding model resident (a few hundred
# MB) and running a git pull loop for an empty room.
#
# ── Why a grace period rather than stopping at zero ─────────────────────────
# Three reasons, all real:
#   1. Session churn. Closing one terminal and opening another would otherwise
#      bounce the server — paying a full cold start for a gap of seconds.
#   2. Unattended dispatches. workbench-dev-team launches agents via
#      `nohup claude -p`. If a short-lived run's SessionStart has not registered
#      its ref yet, stopping the instant the count hits zero could pull the
#      server out from under it.
#   3. It costs nothing. A server idle for two more minutes harms no one; a
#      server yanked from a live session breaks that session's memory for good.
#
# ── The start/stop race, and how it is handled ──────────────────────────────
# A session can start at any instant, including between "count is zero" and the
# kill. Three layers make that survivable rather than merely unlikely:
#   - The count is checked TWICE, separated by a settle interval, so a session
#     arriving during the window is almost always seen before the kill.
#   - After the kill, the count is checked ONE more time. If a ref appeared, the
#     server is brought straight back up — the stop self-corrects instead of
#     leaving a live session with no memory.
#   - A stop.lock serializes reapers, so two SessionEnds firing together cannot
#     both drive a kill.
# The residual exposure is a session that connects in the milliseconds around the
# kill itself: its MCP client holds a connection to a process that then exits.
# That is the same exposure as any server restart, it is reachable only after a
# full grace period of zero sessions, and the re-spawn above means the next
# session is served normally.
#
# Env knobs:
#   WORKBENCH_MEMORY_IDLE_GRACE=N    seconds to wait before reaping (default 120,
#                                    0 disables the reaper entirely).
#   WORKBENCH_MEMORY_IDLE_SETTLE=N   seconds between the two pre-kill checks
#                                    (default 3).
#
# Always exits 0. Never prints to stdout (it is detached; stderr goes to the log).

set -u

_log() { echo "memory-idle-stop: $*" >&2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/hooks}"
HOOKS_DIR="${HOOKS_DIR:-$SCRIPT_DIR}"

# shellcheck source=hooks/lib/memory-env.sh
. "$HOOKS_DIR/lib/memory-env.sh" 2>/dev/null || exit 0
# shellcheck source=hooks/lib/memory-refs.sh
. "$HOOKS_DIR/lib/memory-refs.sh" 2>/dev/null || exit 0
memory_load_env 2>/dev/null || exit 0

GRACE="${WORKBENCH_MEMORY_IDLE_GRACE:-120}"
case "$GRACE" in ''|*[!0-9]*) GRACE=120 ;; esac
[ "$GRACE" -eq 0 ] && { _log "reaper disabled (grace=0)"; exit 0; }

SETTLE="${WORKBENCH_MEMORY_IDLE_SETTLE:-3}"
case "$SETTLE" in ''|*[!0-9]*) SETTLE=3 ;; esac

STOP_LOCK="$CACHE_PATH/stop.lock"

# ──────────── Wait out the grace period ────────────
sleep "$GRACE"

# ──────────── Serialize reapers ────────────
# Plain mkdir, no stale-stealing: a wedged stop.lock only means "no auto-stop
# this round", which is the harmless direction to fail in. The next SessionEnd
# schedules another reaper, and a leftover lock from a killed reaper is cleared
# by the age check below rather than by a liveness protocol this does not need.
if [ -d "$STOP_LOCK" ]; then
  # Clear a lock older than 10 minutes — far longer than any real reap takes.
  if find "$STOP_LOCK" -maxdepth 0 -mmin +10 2>/dev/null | grep -q .; then
    _log "clearing stale stop lock"
    rm -rf "$STOP_LOCK" 2>/dev/null || true
  fi
fi
mkdir "$STOP_LOCK" 2>/dev/null || { _log "another reaper holds the stop lock; done"; exit 0; }
trap 'rm -rf "$STOP_LOCK" 2>/dev/null || true' EXIT

# ──────────── First check ────────────
LIVE="$(memory_refs_count)"
if [ "$LIVE" -ne 0 ]; then
  _log "$LIVE live session(s); leaving the server up"
  exit 0
fi

# ──────────── Settle, then check again ────────────
sleep "$SETTLE"
LIVE="$(memory_refs_count)"
if [ "$LIVE" -ne 0 ]; then
  _log "session appeared during settle; leaving the server up"
  exit 0
fi

# ──────────── Reap ────────────
_log "no live sessions; stopping the shared server"
bash "$HOOKS_DIR/memory-server-down.sh" >/dev/null 2>&1 || true

# ──────────── Self-correct ────────────
# A session that arrived around the kill would otherwise be left with a dead MCP
# connection and no server to reconnect to. Bring one back for it.
LIVE="$(memory_refs_count)"
if [ "$LIVE" -ne 0 ]; then
  _log "session arrived during the stop; bringing the server back up"
  bash "$HOOKS_DIR/memory-server-up.sh" </dev/null >/dev/null 2>&1 || true
fi

exit 0
