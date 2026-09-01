#!/usr/bin/env bash
#
# memory-status.sh — report the shared memory server's facts.
#
# Since 0.19.0 the vault is served by a lazy-started, reference-counted shared
# HTTP server on 127.0.0.1:{memory_port}. So there IS an out-of-band server here,
# and the two questions that actually matter when memory is broken are "is it
# up, and is it OURS" — answered by the identity-checked probe rather than a bare
# TCP connect, which would happily report a foreign squatter as healthy.
#
# Reports: resolved vault/cache, probe health, live session refs (what holds the
# server up), server binary install state, and index / maintenance facts.
#
# Usage:
#   memory-status.sh          # print status (read-only)
# Always exits 0.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# scripts/ sits beside hooks/ in the plugin tree. Honor CLAUDE_PLUGIN_ROOT.
HOOKS_DIR="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/hooks}"
HOOKS_DIR="${HOOKS_DIR:-$(cd "$SCRIPT_DIR/../hooks" && pwd)}"

# shellcheck source=hooks/lib/memory-env.sh
. "$HOOKS_DIR/lib/memory-env.sh"
memory_load_env

# start/stop are real operations again. Point at the scripts that own them rather
# than duplicating their logic (and their identity guards) here.
case "${1:-status}" in
  start)
    echo "Note: the server starts itself — memory-server-up.sh runs at SessionStart"
    echo "and spawns it on a probe miss. To force one now: hooks/memory-server-up.sh"
    echo
    ;;
  stop)
    echo "Note: the server stops on its own a grace period after the last session"
    echo "exits (WORKBENCH_MEMORY_IDLE_GRACE, default 120s). To stop it now:"
    echo "hooks/memory-server-down.sh"
    echo
    ;;
esac

echo "Memory server status (shared HTTP)"
echo "=================================="
echo "transport        : shared HTTP on 127.0.0.1:$MEMORY_PORT/mcp (lazy-started, refcounted)"
echo "vault (source)   : $MEMORY_PATH"
echo "cache            : $CACHE_PATH"
echo "server name      : $MCP_NAME"

# Health: identity-checked, so a foreign process squatting the port is reported
# as a conflict rather than silently adopted as our vault.
# shellcheck source=hooks/lib/memory-probe.sh
. "$HOOKS_DIR/lib/memory-probe.sh"
STATUS="$(memory_probe 2>/dev/null || echo DOWN_NONE)"
case "$STATUS" in
  UP)           echo "health           : UP (serving, index built)" ;;
  BUILDING)     echo "health           : BUILDING (bound; index still building, search available)" ;;
  PORT_DRIFT)   echo "health           : PORT_DRIFT — recorded server.port != configured $MEMORY_PORT" ;;
  DOWN_FOREIGN) echo "health           : DOWN_FOREIGN — something else holds :$MEMORY_PORT (not the $MCP_NAME vault)" ;;
  DOWN_FAILED)  echo "health           : DOWN_FAILED — last spawn failed; see $CACHE_PATH/server.log" ;;
  *)            echo "health           : DOWN — nothing listening (starts at next SessionStart)" ;;
esac

# The bearer token is what plugin.json interpolates into the Authorization
# header. Absent, Claude Code rejects the MCP config outright and no server is
# ever started — the single most common "memory is broken" cause on a fresh
# install, so name it explicitly rather than leaving it to be inferred.
if [ -s "$CACHE_PATH/server.token" ]; then
  echo "bearer token     : present ($CACHE_PATH/server.token)"
else
  echo "bearer token     : MISSING — run /workbench-core:setup, then restart Claude Code"
fi

# Refs are what hold the server up; zero means the reaper may take it down.
# shellcheck source=hooks/lib/memory-refs.sh
if . "$HOOKS_DIR/lib/memory-refs.sh" 2>/dev/null; then
  memory_refs_migrate_legacy
  echo "live processes   : $(memory_refs_count) Claude Code process(es) holding the server up (auto-stop grace: ${WORKBENCH_MEMORY_IDLE_GRACE:-120}s)"
fi

# Git sync is off unless a remote is configured; say which, so "my machines
# aren't sharing memory" has a one-line answer.
if [ -n "${MARKDOWN_VAULT_MCP_GIT_REPO_URL:-}" ]; then
  echo "git sync         : $MARKDOWN_VAULT_MCP_GIT_REPO_URL (pull ${MARKDOWN_VAULT_MCP_GIT_PULL_INTERVAL_S}s)"
else
  echo "git sync         : off (set memory_git_repo_url in config.json to share across machines)"
fi

# Server binary: the wheel-keyed venv the launcher installs into, under the
# cache. The path is derived by the installer (it hashes the bundled wheel), so
# ask it rather than rebuilding the path here and drifting from it.
# shellcheck source=hooks/lib/memory-install.sh
. "$HOOKS_DIR/lib/memory-install.sh"
VENV="$(memory_venv_path 2>/dev/null || true)"
SERVER_BIN="${VENV:+$VENV/bin/markdown-vault-mcp}"
if [ -n "$SERVER_BIN" ] && [ -x "$SERVER_BIN" ]; then
  echo "server binary    : installed ($SERVER_BIN)"
elif [ -z "$VENV" ]; then
  echo "server binary    : no bundled wheel found — the launcher falls back to a git/pipx install"
else
  echo "server binary    : not installed yet — the launcher installs it on first session (needs uv or pipx)"
fi

# Index + maintenance facts.
if [ -f "$MARKDOWN_VAULT_MCP_INDEX_PATH" ]; then
  SIZE=$(wc -c < "$MARKDOWN_VAULT_MCP_INDEX_PATH" 2>/dev/null | tr -d ' ')
  echo "index            : $MARKDOWN_VAULT_MCP_INDEX_PATH (${SIZE:-?} bytes)"
else
  echo "index            : not built yet (builds on first session)"
fi
STAMP="$CACHE_PATH/.last-vacuum"
if [ -f "$STAMP" ]; then
  echo "last VACUUM      : $(date -r "$STAMP" 2>/dev/null || echo present)"
else
  echo "last VACUUM      : never (runs out-of-band from the launcher, gated + once/day)"
fi

echo
echo "If memory tools are unavailable, in order of likelihood:"
echo "  1. bearer token missing above  -> /workbench-core:setup, then QUIT and relaunch"
echo "     Claude Code (settings.json .env is read at launch; a new session is not enough)."
echo "  2. health DOWN                 -> starts at the next SessionStart; check server.log."
echo "  3. health DOWN_FOREIGN         -> free :$MEMORY_PORT or set a different memory_port."
echo "  4. server binary not installed -> confirm 'uv' (or 'pipx') is on PATH."
exit 0
