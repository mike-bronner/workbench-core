#!/usr/bin/env bash
#
# memory-server-up: lazy-start kicker for the shared HTTP memory server.
#
# Invoked by the `core` plugin's SessionStart hook, FIRST — before warmup — so
# the server answers before the host's MCP client runs out of attempts. That
# client DOES retry a refused connect at startup: up to 3 attempts, with
# connection-refused named as one of the transient errors it retries, under a
# 30s overall startup timeout. What is NOT documented is the delay between those
# attempts, and the incident below is what constrains it — all 3 were spent
# before a 13s bind completed, so the 30s cap plainly does not spread them. A
# session whose attempts all land inside the bind window keeps no memory tools
# for the rest of its life, and reports "the vault is down" while the vault is
# healthy. Mid-session reconnect is a separate path with its own backoff, and it
# never rescues a session that failed to connect at startup.
#
# This hook is on a LOCKED, latency-sensitive path, so it does the absolute
# minimum: probe; if our vault is already serving, exit — no wait, nothing paid.
# Otherwise win a mutex and REPARENT the heavy supervisor
# (memory-server-spawn.sh) out of this hook's process group, so the install and
# the embedding build never run here, then wait — bounded — only for the server
# to start answering. All the slow work happens in the detached supervisor.
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
# shellcheck source=hooks/lib/memory-refs.sh
. "$HOOKS_DIR/lib/memory-refs.sh"

memory_load_env

LOCK_DIR="$CACHE_PATH/server.lock"
CLAIMER_PID_FILE="$LOCK_DIR/claimer.pid"

# ──────────── Register this Claude Code process as a live ref ────────────
# Deliberately BEFORE the already-serving fast path below: a session that joins
# a RUNNING server must still be counted, or the reaper would take the server
# down under it the moment the process that originally started it exits.
#
# The ref is keyed by the owning `claude` pid, not the session id — one process
# owns many session ids over its life (resume, /clear, plugin reload), and
# keying by session made the count read 7 for a single live process. The pid
# key is idempotent for free: every SessionStart in one process re-stamps the
# same file. Never fails; an unwritable cache costs auto-stop precision only.
memory_refs_migrate_legacy
memory_ref_register

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

# ──────────── Bounded wait for the server to start answering ────────────
# Every exit below this point leaves THIS session facing a server that is not
# answering yet — whether we spawn the supervisor ourselves, or back off to a
# sibling kicker that is already spawning one. Both owe the same wait: the
# client's 3 startup attempts are fast enough to be spent inside a slow bind,
# and a session that spends them keeps no memory tools for the rest of its life
# (seen twice on 2026-09-10, where loading the index under a post-boot storm
# pushed the bind out to ~13s and outlasted all 3).
#
# The already-serving fast path above returns before reaching this, so the
# common case — every session after the first — still waits for nothing. That
# is why the wait lives here and not at the top of the file.
#
# UP and BUILDING both end the wait, exactly as they end the fast path above:
# BUILDING means bound and answering, with the index still building and search
# already available keyword-only. Every DOWN status keeps polling instead of
# giving up, because a server that is still starting legitimately reads as
# DOWN_NONE (not bound yet), DOWN_FOREIGN (bound, not yet answering an
# authenticated initialize) or DOWN_FAILED (the supervisor gave up at its own
# shorter readiness window while the server was still coming up). Treating any
# of them as final would re-open this bug for the slow start it exists to cover.
# The deadline, not the status, is the thing that bounds the wait.
#
# That bound is WALL CLOCK, never an iteration count: a probe is not instant
# (its curl allows itself 5s), so counting iterations would fail to bound the
# wait under exactly the load that makes a wait necessary. 15s covers the one
# real measurement (a 13s cold start) with margin, and caps what a genuinely
# broken server — a dead install, a held port, a failing spawn — can cost a
# session. Past the deadline we give up and let session start proceed; the
# warmup runs next and reports the server's state to the user.
WAIT_SECS="${WORKBENCH_MEMORY_UP_WAIT_SECS:-15}"   # test seam
case "$WAIT_SECS" in ''|*[!0-9]*) WAIT_SECS=15 ;; esac

wait_for_ready() {
  local deadline status
  deadline=$(( $(date +%s) + WAIT_SECS ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    status="$(memory_probe)"
    case "$status" in
      UP|BUILDING) _log "server answering after wait (probe: $status)"; return 0 ;;
    esac
    sleep 0.2
  done
  _log "server still not answering after ${WAIT_SECS}s; proceeding anyway (see warmup)"
  return 1
}

# ──────────── Win the spawn mutex (atomic mkdir) ────────────
# mkdir is atomic: exactly one concurrent kicker creates LOCK_DIR and becomes
# the winner. Staleness is PID-liveness, NEVER wall-clock: if the dir already
# exists, the claimer is either alive (someone is spawning — back off) or dead
# (crashed mid-kick — steal the lock and retry once).
try_claim() { mkdir "$LOCK_DIR" 2>/dev/null; }

if ! try_claim; then
  # Lock held by someone else. claimer.pid is the SUPERVISOR's OWN pid, which the
  # supervisor writes as its first action — NOT the ephemeral kicker's pid (which
  # would be dead within milliseconds and make every concurrent kicker steal and
  # double-spawn). The supervisor needs a brief moment to start and write its pid,
  # so an empty claimer.pid means "supervisor still starting", not "crashed".
  # Re-read over ~300ms before concluding the pid is genuinely absent.
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
    # A live supervisor holds the lock — let it finish. No second spawn. Backing
    # off is not the same as being served: this session faces the same cold
    # server the winner does, so it waits on the winner's spawn.
    _log "spawn already in progress (supervisor pid $CLAIMER_PID); backing off"
    wait_for_ready
    exit 0
  fi
  # Provably dead claimer, OR a wedged lock that never got a pid → steal it
  # (rm -rf, never rmdir — the dir holds claimer.pid) and retry the claim ONCE.
  _log "stale spawn lock (claimer pid '${CLAIMER_PID:-none}' not alive); stealing"
  rm -rf "$LOCK_DIR" 2>/dev/null || true
  if ! try_claim; then
    # Lost the re-claim race to another kicker — that's fine, they'll spawn. We
    # still wait on their spawn: losing the race changes who spawns, not whether
    # this session is about to connect to a server that is not answering.
    _log "lost re-claim race; another kicker owns the lock"
    wait_for_ready
    exit 0
  fi
fi

# ──────────── Stamp the lock generation (nonce) ────────────
# We hold the lock now (a fresh mkdir — this generation). Write a unique
# generation nonce INTO the lock dir before reparenting. The supervisor captures
# it as its first action, and its release_lock only removes the lock while this
# nonce is still on disk. If our lock is later stolen and re-created by a newer
# generation (a new mkdir → new nonce), the old supervisor sees the changed nonce
# and declines to delete the newer generation's lock — closing the fixed-path
# rm -rf cross-generation race.
echo "$$-${RANDOM}-$(date +%s)" > "$LOCK_DIR/nonce" 2>/dev/null || true

# ──────────── Reparent the supervisor, then wait only for the bind ────────────
# We hold the lock. Hand it (and all the slow work) to a DETACHED supervisor:
# perl-setsid puts it in its own session/process group, so it survives this
# hook's process group being signalled when the session ends. macOS has no
# setsid binary, and nohup+disown alone does NOT escape the process group — the
# perl POSIX::setsid idiom is the verified detach. We never wait ON the
# supervisor (no `wait`, no pipe): it stays detached, and we poll the port.
#
# perl's `exec` keeps the SAME pid, so $! is the supervisor's pid (used only for
# the log line below). The supervisor itself writes the lock's liveness token
# (claimer.pid) from its own $$, so the token is the long-lived supervisor, not
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

# The supervisor stamps the lock's liveness token (claimer.pid) with its OWN pid
# as its first action — we deliberately do NOT write it here. A late write from
# this ephemeral kicker could land in a newer lock generation (if the supervisor
# releases the lock fast) and clobber a live sibling's pid, causing the exact
# double-spawn the lock prevents. Leaving the stamp to the lock's true owner
# closes that race.

# Our own spawn is in flight, so this session faces the cold server it just
# asked for. Wait for the port to start answering — bounded — before the MCP
# client spends its 3 startup attempts on a port that is not up yet.
wait_for_ready

exit 0
