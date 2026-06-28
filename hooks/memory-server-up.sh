#!/usr/bin/env bash
#
# memory-server-up: lazy-start kicker for the shared HTTP memory server.
#
# Invoked by the `core` plugin's SessionStart hook, FIRST — before warmup — so a
# cold server is already coming up by the time the host's MCP client retries its
# connect (Claude Code retries an unreachable HTTP MCP up to ~3× over ~30s at
# startup, which covers the ~2.1s bind).
#
# This hook is on a LOCKED, latency-sensitive path, so it does the absolute
# minimum: probe; if our vault is already serving, exit. Otherwise win a mutex
# and REPARENT the heavy supervisor (memory-server-spawn.sh) out of this hook's
# process group, then return immediately — it never waits for the install or the
# bind. All the slow work happens in the detached supervisor.
#
# Hard rules: exit 0 ALWAYS (a startup hook must never fail the session) and
# emit NOTHING on stdout (SessionStart stdout is injected into the model's
# context — this hook contributes none; the warmup owns user-visible output).

set -u

# Everything this hook prints is diagnostic — route it to stderr so stdout stays
# empty. (Hook stderr is not injected into context.)
_log() { echo "memory-server-up: $*" >&2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/hooks}"
HOOKS_DIR="${HOOKS_DIR:-$SCRIPT_DIR}"

# shellcheck source=hooks/lib/memory-env.sh
. "$HOOKS_DIR/lib/memory-env.sh"
# shellcheck source=hooks/lib/memory-probe.sh
. "$HOOKS_DIR/lib/memory-probe.sh"

memory_load_env

LOCK_DIR="$CACHE_PATH/server.lock"
CLAIMER_PID_FILE="$LOCK_DIR/claimer.pid"

# ──────────── Clear stale transient markers ────────────
# .server-failed and .port-conflict are single-attempt breadcrumbs from a prior
# boot. Clear them on a fresh kick so a transient failure doesn't wedge us; if
# this attempt fails again, the supervisor re-writes .server-failed.
mkdir -p "$CACHE_PATH" 2>/dev/null || exit 0
rm -f "$CACHE_PATH/.server-failed" "$CACHE_PATH/.port-conflict" 2>/dev/null || true

# ──────────── Fast path: already serving? ────────────
# UP or BUILDING both mean our vault is answering (BUILDING = bound, index still
# building, search already available). Either way, nothing to do.
STATUS="$(memory_probe)"
case "$STATUS" in
  UP|BUILDING)
    _log "already serving (probe: $STATUS); nothing to do"
    exit 0
    ;;
  PORT_DRIFT)
    # The recorded port disagrees with the configured one — a config drift the
    # warmup surfaces to the user. Spawning would fight over the wrong port, so
    # drop a breadcrumb and bail; don't spawn.
    echo "port-drift detected at $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$CACHE_PATH/.port-conflict" 2>/dev/null || true
    _log "port drift; leaving for the user to reconcile (see warmup)"
    exit 0
    ;;
  DOWN_FOREIGN)
    # Something else holds the port. One transport per key — never silently
    # adopt a foreign server. Record a conflict breadcrumb; the warmup reports
    # it. Do NOT spawn (the port is taken).
    echo "foreign listener on port $MEMORY_PORT at $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$CACHE_PATH/.port-conflict" 2>/dev/null || true
    _log "foreign listener on port $MEMORY_PORT; not spawning"
    exit 0
    ;;
esac
# DOWN_NONE / DOWN_FAILED fall through to the spawn path.

# ──────────── Win the spawn mutex (atomic mkdir) ────────────
# mkdir is atomic: exactly one concurrent kicker creates LOCK_DIR and becomes
# the winner. Staleness is PID-liveness, NEVER wall-clock: if the dir already
# exists, the claimer is either alive (someone is spawning — back off) or dead
# (crashed mid-kick — steal the lock and retry once).
try_claim() { mkdir "$LOCK_DIR" 2>/dev/null; }

if ! try_claim; then
  # Lock held by someone else. The claimer pid is the SUPERVISOR's pid, written
  # by the winning kicker right after it reparents the supervisor — NOT the
  # ephemeral kicker's pid (which would be dead within milliseconds and cause
  # every concurrent kicker to steal and double-spawn). The winner needs a brief
  # moment to spawn the supervisor and write its pid, so an empty claimer.pid
  # means "winner still spawning", not "crashed". Re-read over ~300ms before
  # concluding the pid is genuinely absent.
  CLAIMER_PID=""
  j=0
  while [ "$j" -lt 30 ]; do
    [ -f "$CLAIMER_PID_FILE" ] && CLAIMER_PID="$(cat "$CLAIMER_PID_FILE" 2>/dev/null)"
    [ -n "$CLAIMER_PID" ] && break
    # If the winner already released the lock (server came up fast), stop waiting.
    [ ! -d "$LOCK_DIR" ] && break
    j=$((j + 1)); sleep 0.01
  done

  # The winner may have finished and released the lock while we waited — re-probe
  # the cheap fast path before doing anything drastic.
  if [ ! -d "$LOCK_DIR" ]; then
    STATUS="$(memory_probe)"
    case "$STATUS" in UP|BUILDING) _log "server came up while waiting; done"; exit 0 ;; esac
  fi

  if [ -n "$CLAIMER_PID" ] && kill -0 "$CLAIMER_PID" 2>/dev/null; then
    # A live supervisor holds the lock — let it finish. No second spawn.
    _log "spawn already in progress (supervisor pid $CLAIMER_PID); backing off"
    exit 0
  fi
  # Provably dead claimer, OR a wedged lock that never got a pid → steal it
  # (rm -rf, never rmdir — the dir holds claimer.pid) and retry the claim ONCE.
  _log "stale spawn lock (claimer pid '${CLAIMER_PID:-none}' not alive); stealing"
  rm -rf "$LOCK_DIR" 2>/dev/null || true
  if ! try_claim; then
    # Lost the re-claim race to another kicker — that's fine, they'll spawn.
    _log "lost re-claim race; another kicker owns the lock"
    exit 0
  fi
fi

# ──────────── Reparent the supervisor and return immediately ────────────
# We hold the lock. Hand it (and all the slow work) to a DETACHED supervisor:
# perl-setsid puts it in its own session/process group, so it survives this
# hook's process group being signalled when the session ends. macOS has no
# setsid binary, and nohup+disown alone does NOT escape the process group — the
# perl POSIX::setsid idiom is the verified detach. We do NOT wait for it.
#
# perl's `exec` keeps the SAME pid, so $! is the supervisor's pid. We record it
# as the claimer so the lock's liveness token is the long-lived supervisor, not
# this ephemeral kicker (see try_claim). The supervisor releases the lock when
# the server is ready or has failed.
SUPERVISOR_PID=""
if command -v perl >/dev/null 2>&1; then
  perl -e 'use POSIX qw(setsid); setsid; exec @ARGV' -- \
    bash "$HOOKS_DIR/memory-server-spawn.sh" >/dev/null 2>&1 < /dev/null &
  SUPERVISOR_PID=$!
  disown 2>/dev/null || true
  _log "reparented supervisor (pid $SUPERVISOR_PID); returning"
else
  # No perl — extremely unlikely on macOS/Linux. Fall back to nohup+disown so we
  # at least try; the supervisor owns lock release either way.
  _log "perl not found; falling back to nohup detach (weaker)"
  nohup bash "$HOOKS_DIR/memory-server-spawn.sh" >/dev/null 2>&1 < /dev/null &
  SUPERVISOR_PID=$!
  disown 2>/dev/null || true
fi

# Hand the lock's liveness token to the supervisor. A concurrent kicker now sees
# a LIVE claimer (the working supervisor) and backs off instead of double-
# spawning. If the supervisor pid is somehow empty, claimer.pid stays absent and
# a concurrent kicker's wait-then-steal path resolves the wedged lock.
[ -n "$SUPERVISOR_PID" ] && echo "$SUPERVISOR_PID" > "$CLAIMER_PID_FILE" 2>/dev/null || true

exit 0
