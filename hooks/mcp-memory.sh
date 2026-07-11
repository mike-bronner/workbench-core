#!/usr/bin/env bash
#
# mcp-memory: launcher for the markdown-vault-mcp memory server.
#
# Resolves env vars from config.json at server-start time, so plugin updates
# never clobber MCP configuration. config.json is the single source of truth;
# plugin.json just points at this wrapper.
#
# Invoked by plugin.json's mcpServers.memory entry.

set -u

# Hooks run with a leaner PATH than an interactive shell. uv and pipx both
# place tool binaries in ~/.local/bin, so prepend it — this also makes a
# binary installed by the bootstrap below findable in this same run.
export PATH="$HOME/.local/bin:$PATH"

# stdout is the MCP stdio channel (JSON-RPC). Every byte of bootstrap output
# MUST go to stderr — a single stray stdout line corrupts the MCP handshake.
# Installer invocations below redirect at the command level (1>&2) rather
# than trusting the tools to be quiet.
_log() { echo "mcp-memory: $*" 1>&2; }

# Resolve the launcher's own directory so we can find the bundled wheel
# regardless of how the script is invoked. Honor CLAUDE_PLUGIN_ROOT (the
# convention the rest of this plugin's scripts use, set by Claude Code's MCP
# host) when present, and fall back to a BASH_SOURCE-relative path so manual
# and test invocations still locate the wheel. In production both resolve to
# the same hooks/ directory — plugin.json invokes us as
# ${CLAUDE_PLUGIN_ROOT}/hooks/mcp-memory.sh.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/hooks}"
HOOKS_DIR="${HOOKS_DIR:-$SCRIPT_DIR}"

# Resolve the memory env (path/cache/mcp-name/port + the full MARKDOWN_VAULT_MCP_*
# export set) via the shared library, so this launcher, the lazy-start
# supervisor, and the warmup all agree on where the vault and cache live.
# memory_load_env sets MEMORY_PATH/CACHE_PATH/MCP_NAME/MEMORY_PORT and exports
# the server env (precedence: WORKBENCH_* override → config.json → default).
# shellcheck source=hooks/lib/memory-env.sh
. "$HOOKS_DIR/lib/memory-env.sh"
memory_load_env

# --- Out-of-band index reclamation: race-guarded gated VACUUM ----------------
# Per-session stdio means N sessions can start concurrently, and a sibling
# session's server may already hold the index. memory_vacuum_locked serializes
# the attempt with a non-blocking mkdir lock — one launcher VACUUMs, the rest
# skip immediately — and, one layer down, memory_vacuum's SQLite busy timeout
# makes a VACUUM that still contends with a live sibling writer skip safely
# rather than block or corrupt. Gated (freelist threshold) + cooled down
# (once/day) inside the lib, so most boots skip with near-zero added latency.
# Reuses the same lib the shared-server supervisor uses — no reinvention.
#
# Hard rules carry over from the old inline VACUUM: this step must NEVER fail the
# launcher and must NEVER touch stdout (the MCP stdio channel). memory_vacuum
# routes all output through the _log function (stderr) passed here and treats
# every error (busy/locked, missing sqlite3, absent file) as skip-and-continue.
# shellcheck source=hooks/lib/memory-vacuum.sh
. "$HOOKS_DIR/lib/memory-vacuum.sh"
memory_vacuum_locked "$MARKDOWN_VAULT_MCP_INDEX_PATH" _log
# -----------------------------------------------------------------------------

# --- Resolve/install the server binary via the shared install library --------
# The bundled-wheel-into-persistent-venv install (with SHA-256 wheel-hash cache
# key and git/pipx fallback) is shared with the lazy-start HTTP supervisor, so
# it lives in hooks/lib/memory-install.sh. memory_install_server sets SERVER_BIN
# on success; all install chatter goes to stderr via _log (stdout is the MCP
# stdio channel). On unrecoverable failure it returns non-zero and we exit.
# shellcheck source=hooks/lib/memory-install.sh
. "$HOOKS_DIR/lib/memory-install.sh"
if ! memory_install_server _log; then
  _log "ERROR: could not resolve a markdown-vault-mcp binary; see messages above"
  exit 1
fi

# Hand off to the resolved binary. exec replaces the shell so Claude Code's MCP
# stop signal reaches the Python process directly.
exec "$SERVER_BIN" serve
# -----------------------------------------------------------------------------
