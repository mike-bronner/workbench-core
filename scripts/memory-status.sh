#!/usr/bin/env bash
#
# memory-status.sh — report the per-session stdio memory server's facts.
#
# Since v0.13.0 the memory vault is served by a per-session STDIO server that the
# MCP host (Claude Code / Cowork) spawns in-process via hooks/mcp-memory.sh — one
# per session, no shared listener, no port, no bearer token. There is therefore
# no out-of-band server to probe, start, or stop. This reports the things that
# actually determine whether memory works: the resolved vault/cache, whether the
# launcher and server binary are installed, and index / maintenance facts.
#
# (The shared HTTP server is retained but disabled. To re-enable it — and its
# port/token/health reporting — see README, section "Memory server transport".)
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

# start/stop don't apply to a per-session stdio server — the MCP host owns its
# lifecycle. Accept them for muscle-memory, but explain and fall through to status.
case "${1:-status}" in
  start|stop)
    echo "Note: '$1' does not apply to the per-session stdio server — the MCP host"
    echo "spawns it in-process per session and stops it when the session ends."
    echo "Restart Claude Code to re-spawn it. Showing status instead:"
    echo
    ;;
esac

echo "Memory server status (per-session stdio)"
echo "========================================"
echo "transport        : per-session stdio (in-process; spawned by the MCP host)"
echo "vault (source)   : $MEMORY_PATH"
echo "cache            : $CACHE_PATH"
echo "server name      : $MCP_NAME"

# Launcher: plugin.json points the memory MCP at this script.
LAUNCHER="$HOOKS_DIR/mcp-memory.sh"
if [ -x "$LAUNCHER" ]; then
  echo "launcher         : $LAUNCHER (present)"
else
  echo "launcher         : $LAUNCHER (MISSING — plugin.json's memory MCP points here)"
fi

# Server binary: the persistent venv the launcher installs into, under the cache.
SERVER_BIN="$CACHE_PATH/server-venv/bin/markdown-vault-mcp"
if [ -x "$SERVER_BIN" ]; then
  echo "server binary    : installed ($SERVER_BIN)"
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
echo "Memory runs in-process per session — there is no shared server to start or stop."
echo "If memory tools are unavailable: confirm 'uv' (or 'pipx') is on PATH, then restart"
echo "Claude Code so the MCP host re-spawns the stdio launcher."
exit 0
