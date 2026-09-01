#!/usr/bin/env bash
#
# memory-server-spawn: detached supervisor that brings up the shared HTTP memory
# server. NOT a hook — it is reparented out of the SessionStart hook's process
# group (via perl-setsid) by memory-server-up.sh, so the heavy work (venv
# install, embedding build) runs OFF the hook's locked critical path and the
# server outlives the session that kicked it.
#
# Contract with memory-server-up.sh (the kicker):
#   - The kicker has already won the spawn lock ($CACHE_PATH/server.lock) and
#     reparented us. The kicker does NOT write claimer.pid — WE stamp the lock
#     with our OWN pid as our first action (a late write from the ephemeral
#     kicker could clobber a newer lock generation). This supervisor OWNS the
#     lock now and is responsible for releasing it (rm -rf) on every exit path.
#   - On success: server bound + identity-checked-ready → release the lock.
#   - On failure: write $CACHE_PATH/.server-failed (with a log tail) → release
#     the lock. The next SessionStart will see DOWN_FAILED and retry.
#
# Lifetime: this supervisor only ever brings the server UP. Stopping it belongs
# to memory-server-idle-stop.sh, which is reparented by memory-server-release.sh
# once the last session ref is dropped — see hooks/lib/memory-refs.sh. (Through
# v0.18 there was no reaper at all and memory-server-down.sh was the only, manual,
# stop path.) The client's per-tool timeout is still NOT a server idle reaper.

set -u

# Resolve our own hooks dir so we can source the shared libraries regardless of
# how we were invoked (the kicker passes an absolute path, but be robust).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/hooks}"
HOOKS_DIR="${HOOKS_DIR:-$SCRIPT_DIR}"

# uv / pipx put tool binaries in ~/.local/bin; a reparented process inherits a
# leaner PATH, so prepend it (mirrors mcp-memory.sh).
export PATH="$HOME/.local/bin:$PATH"

# shellcheck source=hooks/lib/memory-env.sh
. "$HOOKS_DIR/lib/memory-env.sh"
# shellcheck source=hooks/lib/memory-vacuum.sh
. "$HOOKS_DIR/lib/memory-vacuum.sh"
# shellcheck source=hooks/lib/memory-install.sh
. "$HOOKS_DIR/lib/memory-install.sh"
# shellcheck source=hooks/lib/memory-probe.sh
. "$HOOKS_DIR/lib/memory-probe.sh"

memory_load_env

LOCK_DIR="$CACHE_PATH/server.lock"
CLAIMER_PID_FILE="$LOCK_DIR/claimer.pid"
NONCE_FILE="$LOCK_DIR/nonce"
# Generation token of the lock WE belong to, captured at stamp time. release_lock
# only removes the lock while the on-disk nonce still matches this one — so a
# stale supervisor whose lock was already stolen and re-created by a newer
# generation never deletes that newer generation's lock (the fixed-path rm -rf
# cross-generation hazard).
GEN_NONCE=""
SERVER_LOG="$CACHE_PATH/server.log"
SERVER_PID_FILE="$CACHE_PATH/server.pid"
SERVER_PORT_FILE="$CACHE_PATH/server.port"
TOKEN_FILE="$CACHE_PATH/server.token"
FAILED_MARKER="$CACHE_PATH/.server-failed"

# All supervisor output goes to the server log (we are detached; there is no
# stdout consumer). Mirror the launcher's _log shape for grep-ability.
_log() { echo "memory-server-spawn: $*" >> "$SERVER_LOG" 2>/dev/null; }

# release_lock: remove the spawn lock — but ONLY if it is still OUR generation's
# lock. Compare the on-disk nonce against the one we captured at stamp time: if
# they differ, our lock was stolen (rm -rf) and re-created by a newer generation,
# so removing the fixed-path dir now would delete THAT generation's lock — leave
# it. When they match (the normal case) rm -rf (the dir is non-empty — it holds
# claimer.pid + nonce — so rm -rf, never rmdir). An empty captured nonce paired
# with an empty on-disk nonce is the legacy/no-nonce case and still releases, so
# a missing nonce can never wedge the lock.
release_lock() {
  local cur
  cur="$(cat "$NONCE_FILE" 2>/dev/null)"
  if [ "$cur" = "$GEN_NONCE" ]; then
    rm -rf "$LOCK_DIR" 2>/dev/null || true
  else
    _log "lock generation changed (nonce '$cur' != ours '$GEN_NONCE'); not releasing a newer generation's lock"
  fi
}

# fail: record the failure (marker + log tail) and release the lock, then exit.
# Never leave the lock held — a stuck lock would block every future spawn.
fail() {
  _log "FAILED: $*"
  {
    echo "server spawn failed at $(date -u +%Y-%m-%dT%H:%M:%SZ): $*"
    echo "--- last 20 server.log lines ---"
    tail -n 20 "$SERVER_LOG" 2>/dev/null
  } > "$FAILED_MARKER" 2>/dev/null || true
  release_lock
  exit 0
}

# _parent_is_reaper <ppid> — true when a process with this parent has been
# ORPHANED and adopted, rather than still being owned by a live session.
#
# "Orphan == ppid 1" is a macOS assumption and is WRONG on Linux. When a parent
# dies, the kernel reparents its children to the nearest ancestor marked
# PR_SET_CHILD_SUBREAPER, falling back to pid 1 only when there is none. Under
# systemd every user session runs a `systemd --user` manager that sets exactly
# that flag, so an orphan reparents to it — a live process, with a pid that is
# not 1. The old gate read that as "has a live parent, therefore in use" and
# skipped it, which meant **orphaned stdio servers were never reaped on Linux**
# (verified on Omarchy: an orphan landed on ppid 1245 = systemd --user, not 1).
#
# So treat as orphaned: no parent, a dead parent, pid 1 (init/launchd), or a
# parent that IS an init/subreaper by name. The name check is the Linux half;
# macOS orphans still land on launchd at pid 1 and are caught by the pid test.
#
# This cannot mis-reap a live session's server: for the name branch to fire, the
# server's own launcher must already have exited, which is what orphaned means.
_parent_is_reaper() {
  local ppid="$1" comm
  [ -z "$ppid" ] && return 0                 # no parent reported at all
  case "$ppid" in
    0|1) return 0 ;;                         # init / launchd
  esac
  kill -0 "$ppid" 2>/dev/null || return 0    # parent is dead
  comm="$(ps -o comm= -p "$ppid" 2>/dev/null | tr -d ' ')"
  case "${comm##*/}" in
    systemd|init|launchd) return 0 ;;        # adopted by a subreaper
  esac
  return 1
}

# sweep_orphan_stdio_servers: one-shot migration. Before the shared-server model,
# every session launched its OWN stdio markdown-vault-mcp. When those sessions
# ended uncleanly their servers could leak as orphans (parent dead → reparented
# to PID 1) — the exact CPU/SQLite-contention problem the shared server fixes.
# On the FIRST successful shared start, reap those leaked orphans so the shared
# server inherits a clean field. Guarded by a stamp so it runs once, ever.
#
# Safety rails (all must hold to kill a pid):
#   - UID-scoped: only our own processes (pgrep -u $(id -u)).
#   - Command matches the resolved venv SERVER_BIN path (the per-session stdio
#     launcher's binary) — never a random "markdown-vault-mcp" substring.
#   - ORPHAN only, per _parent_is_reaper below: the parent is dead, is init, or
#     is a subreaper that adopted it. A server with a live session-owned parent
#     is an in-flight session's server — NEVER touch it.
#   - Excludes our own shared server, this supervisor ($$), and our parent
#     ($PPID).
# WAL checkpoint runs only if, after the sweep, zero servers remain holding the
# index (so we don't checkpoint under a live writer).
sweep_orphan_stdio_servers() {
  local stamp="$CACHE_PATH/.shared-migration-done"
  [ -f "$stamp" ] && return 0
  command -v pgrep >/dev/null 2>&1 || { touch "$stamp" 2>/dev/null; return 0; }

  # The per-session stdio launcher execs the SAME venv binary we resolved. Match
  # candidates on that exact path. (When SERVER_BIN came from the git fallback it
  # is the global binary path — still the right discriminator.)
  local bin="$SERVER_BIN"
  local uid; uid="$(id -u)"
  local self="$$" parent="${PPID:-0}" shared="$SERVER_PID"

  local killed=0 pid ppid cmd
  # -f matches against the full command line; -u scopes to our uid.
  for pid in $(pgrep -u "$uid" -f "$bin" 2>/dev/null); do
    # Never our own shared server, this supervisor, or our parent.
    [ "$pid" = "$shared" ] && continue
    [ "$pid" = "$self" ] && continue
    [ "$pid" = "$parent" ] && continue
    # Confirm it really is a markdown-vault-mcp server invocation, not e.g. an
    # editor that happens to have the path in argv.
    cmd="$(ps -o command= -p "$pid" 2>/dev/null)"
    case "$cmd" in *markdown-vault-mcp*|*"$bin"*) : ;; *) continue ;; esac
    # ORPHAN gate: the parent must be dead, or an init/subreaper that ADOPTED
    # this process after its real parent died. A live, session-owned parent means
    # a live session owns this server — leave it strictly alone.
    ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
    if ! _parent_is_reaper "$ppid"; then
      continue
    fi
    _log "sweep: reaping orphan stdio server pid=$pid (ppid=$ppid)"
    kill "$pid" 2>/dev/null && killed=$((killed + 1))
  done
  _log "sweep: reaped $killed orphan stdio server(s)"

  # WAL checkpoint only if no server besides ours remains holding the index.
  # (Our shared server is the legitimate holder; a checkpoint while a stray
  # writer is live could race, so we skip it then.)
  local remaining=0 p
  for p in $(pgrep -u "$uid" -f "$bin" 2>/dev/null); do
    [ "$p" = "$shared" ] && continue
    remaining=$((remaining + 1))
  done
  if [ "$remaining" -eq 0 ] && command -v sqlite3 >/dev/null 2>&1 \
      && [ -f "$MARKDOWN_VAULT_MCP_INDEX_PATH" ]; then
    sqlite3 "$MARKDOWN_VAULT_MCP_INDEX_PATH" -cmd ".timeout 2000" \
      "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null 2>&1 \
      && _log "sweep: WAL checkpoint complete" \
      || _log "sweep: WAL checkpoint skipped/failed (non-fatal)"
  fi

  touch "$stamp" 2>/dev/null || true
}

# Test seam: let the suite source THIS file for its helper functions
# (release_lock, etc.) without running the supervisor body. Tests set
# MEMORY_SPAWN_LIB_ONLY=1; `return` is valid here because the test sources us,
# and the guard is never reached on a normal direct execution (the var is unset).
[ -n "${MEMORY_SPAWN_LIB_ONLY:-}" ] && return 0

# ──────────── Stamp the lock's liveness token (our own pid) ────────────
# The kicker won the mkdir lock and reparented us but deliberately does NOT write
# claimer.pid. A late write from the ephemeral kicker can land in a NEWER lock
# generation if we release the lock fast (the UP/BUILDING fast paths below do
# exactly that), overwriting a live sibling supervisor's pid with our dead one —
# a third kicker then reads the dead pid, declares the lock stale, steals it, and
# double-spawns. WE own the lock now, so WE stamp it with our own long-lived pid
# as the first action. A concurrent kicker reads this live pid and backs off, and
# because the token lives INSIDE the lock dir it is removed (rm -rf) with the dir
# on release — it can never outlive its generation. The kicker pre-created
# LOCK_DIR (the mkdir mutex), so this write lands; it is best-effort regardless.
# Capture our generation's nonce (the kicker wrote it into the lock at mkdir
# time) BEFORE any heavy work, so release_lock can later prove the lock is still
# ours. Capture-then-stamp is the supervisor's first action; a steal can only
# happen once our claimer.pid looks dead, which it does not while we run.
GEN_NONCE="$(cat "$NONCE_FILE" 2>/dev/null)"
echo "$$" > "$CLAIMER_PID_FILE" 2>/dev/null || true

# ──────────── Cache + state dirs ────────────
# Create the cache and the HTTP transport's required KV/event store dirs. chmod
# 700 — these hold the index, embeddings, session KV state, and the bearer
# token; keep them owner-only.
mkdir -p "$CACHE_PATH" "$CACHE_PATH/kv" "$CACHE_PATH/events" 2>/dev/null \
  || fail "could not create cache dirs under $CACHE_PATH"
chmod 700 "$CACHE_PATH" "$CACHE_PATH/kv" "$CACHE_PATH/events" 2>/dev/null || true

# ──────────── Size-rotate the server log (5MB, keep 2) ────────────
# The server appends to server.log indefinitely; rotate before this boot's
# output so it never grows unbounded. Plain size check + rename — no logrotate.
LOG_MAX_BYTES=$(( 5 * 1024 * 1024 ))
if [ -f "$SERVER_LOG" ]; then
  LOG_SIZE=$(wc -c < "$SERVER_LOG" 2>/dev/null | tr -d ' ')
  case "$LOG_SIZE" in ''|*[!0-9]*) LOG_SIZE=0 ;; esac
  if [ "$LOG_SIZE" -gt "$LOG_MAX_BYTES" ]; then
    rm -f "$SERVER_LOG.2" 2>/dev/null || true
    [ -f "$SERVER_LOG.1" ] && mv "$SERVER_LOG.1" "$SERVER_LOG.2" 2>/dev/null
    mv "$SERVER_LOG" "$SERVER_LOG.1" 2>/dev/null
  fi
fi

_log "spawn starting (pid $$): port=$MEMORY_PORT vault=$MEMORY_PATH name=$MCP_NAME"

# ──────────── Bearer token: read or mint ────────────
# Auth is a per-install static bearer token, fully auto-provisioned. The
# setup skill mints it and writes it to settings.json env; here we
# self-heal — if the token file is missing, mint one so the server still comes
# up authenticated. Setting MARKDOWN_VAULT_MCP_BEARER_TOKEN is sufficient: the
# server auto-resolves to single-bearer auth when only a bearer token is set
# (an explicit AUTH_MODE=bearer-single is NOT a valid override in the server and
# only logs a warning, so we don't set it — the token alone is the correct knob).
if [ ! -s "$TOKEN_FILE" ]; then
  if command -v openssl >/dev/null 2>&1; then
    (umask 077; openssl rand -hex 32 > "$TOKEN_FILE" 2>/dev/null) || true
    _log "minted a new bearer token (token file was absent)"
  fi
fi
if [ -s "$TOKEN_FILE" ]; then
  chmod 600 "$TOKEN_FILE" 2>/dev/null || true
  MARKDOWN_VAULT_MCP_BEARER_TOKEN="$(cat "$TOKEN_FILE" 2>/dev/null)"
  export MARKDOWN_VAULT_MCP_BEARER_TOKEN
else
  _log "WARNING: no bearer token available (openssl missing?); server will start unauthenticated"
fi

# ──────────── Cold-start index VACUUM ────────────
# We hold the spawn lock and no server is alive (the probe said it was down),
# so this is the one safe moment to VACUUM the index with no writer to race.
# Gated + cooled-down inside the lib; route its log to our server log.
memory_vacuum "$MARKDOWN_VAULT_MCP_INDEX_PATH" _log

# ──────────── Install / resolve the server binary ────────────
# WORKBENCH_MEMORY_SERVER_BIN short-circuits the install — it points directly at
# a server binary. The test suite uses it to substitute the fake-server fixture
# (no venv, no network); advanced users can point it at a custom build.
if [ -n "${WORKBENCH_MEMORY_SERVER_BIN:-}" ]; then
  SERVER_BIN="$WORKBENCH_MEMORY_SERVER_BIN"
  _log "using WORKBENCH_MEMORY_SERVER_BIN=$SERVER_BIN (install skipped)"
elif ! memory_install_server _log; then
  fail "could not resolve a markdown-vault-mcp binary (see log above)"
fi

# ──────────── Defensive re-probe: another server may already be up ────────────
# Belt-and-suspenders against any kicker-lock race: if our vault is ALREADY
# serving on the port (a sibling supervisor won), do NOT launch a second server
# (which would fail to bind and clobber server.pid). Just release the lock.
PRELAUNCH_STATUS="$(memory_probe)"
case "$PRELAUNCH_STATUS" in
  UP|BUILDING)
    _log "server already serving (probe: $PRELAUNCH_STATUS) before launch; not double-spawning"
    rm -f "$FAILED_MARKER" 2>/dev/null || true
    release_lock
    exit 0
    ;;
esac

# ──────────── Launch the HTTP server, detached ────────────
# nohup + background + disown: the server must outlive this supervisor. We append
# to server.log so the probe's failure tail has context. Bare `disown` — the
# `disown "$PID"` jobspec form is broken in bash 3.2.
nohup "$SERVER_BIN" serve --transport http --host 127.0.0.1 \
  --port "$MEMORY_PORT" --http-path /mcp >> "$SERVER_LOG" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$SERVER_PID_FILE"
echo "$MEMORY_PORT" > "$SERVER_PORT_FILE"
disown 2>/dev/null || true
chmod 600 "$SERVER_PID_FILE" "$SERVER_PORT_FILE" 2>/dev/null || true
_log "launched server pid=$SERVER_PID; awaiting readiness"

# ──────────── Readiness gate (identity-checked probe, ~10s) ────────────
# The HTTP transport binds in ~2.1s (embedding build runs async after bind).
# Poll the identity-checked probe — the SAME check the host/warmup use, never a
# bare TCP connect — until it reports our vault UP/BUILDING (both mean serving),
# or the budget elapses. If the server process dies, stop early.
READY=0
i=0
while [ "$i" -lt 50 ]; do   # 50 × 0.2s = 10s
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    _log "server process exited during startup"
    break
  fi
  STATUS="$(memory_probe)"
  if [ "$STATUS" = "UP" ] || [ "$STATUS" = "BUILDING" ]; then
    READY=1
    _log "server ready (probe: $STATUS)"
    break
  fi
  i=$((i + 1))
  sleep 0.2
done

# chmod the log last (it now exists for sure).
chmod 600 "$SERVER_LOG" 2>/dev/null || true

if [ "$READY" -eq 1 ]; then
  # Healthy start — clear any prior failure marker.
  rm -f "$FAILED_MARKER" 2>/dev/null || true
  # One-shot: reap leaked orphan stdio servers from the pre-shared-server era,
  # now that a healthy shared server has taken over. Never fails the supervisor.
  sweep_orphan_stdio_servers || true
  release_lock
  exit 0
fi

# Never bound / never became our vault in the budget → record + release.
fail "server did not become ready within the readiness window (port $MEMORY_PORT)"
