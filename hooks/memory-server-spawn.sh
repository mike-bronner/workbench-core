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
#     written server.lock/claimer.pid. This supervisor OWNS that lock now and is
#     responsible for releasing it (rm -rf) on every exit path.
#   - On success: server bound + identity-checked-ready → release the lock.
#   - On failure: write $CACHE_PATH/.server-failed (with a log tail) → release
#     the lock. The next SessionStart will see DOWN_FAILED and retry.
#
# Single never-stop model: once up, the server stays up across sessions (the
# client's per-tool timeout is NOT a server idle reaper). Nothing here stops it;
# memory-server-down.sh is the only stop path, and it is manual.

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
SERVER_LOG="$CACHE_PATH/server.log"
SERVER_PID_FILE="$CACHE_PATH/server.pid"
SERVER_PORT_FILE="$CACHE_PATH/server.port"
TOKEN_FILE="$CACHE_PATH/server.token"
FAILED_MARKER="$CACHE_PATH/.server-failed"

# All supervisor output goes to the server log (we are detached; there is no
# stdout consumer). Mirror the launcher's _log shape for grep-ability.
_log() { echo "memory-server-spawn: $*" >> "$SERVER_LOG" 2>/dev/null; }

# release_lock: remove the spawn lock. The lock dir is non-empty (it holds
# claimer.pid), so rm -rf, never rmdir.
release_lock() { rm -rf "$LOCK_DIR" 2>/dev/null || true; }

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
# customize/setup skill mints it and writes it to settings.json env; here we
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
  release_lock
  exit 0
fi

# Never bound / never became our vault in the budget → record + release.
fail "server did not become ready within the readiness window (port $MEMORY_PORT)"
