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

# --- Bootstrap: self-install the server if missing --------------------------
# Claude Code plugins have no dependency-install lifecycle, so the launcher
# installs its own server binary on first run. Note: on a fresh machine the
# first MCP connection may still time out at Claude Code's 30s limit while
# the install runs — that's accepted; the install completes anyway and the
# next session connects normally.
if ! command -v markdown-vault-mcp >/dev/null 2>&1; then
  _log "markdown-vault-mcp not found; installing from mikebronner fork (~60-90s, first run only)"
  if command -v uv >/dev/null 2>&1; then
    if uv tool install --from git+https://github.com/mikebronner/markdown-vault-mcp \
        markdown-vault-mcp --with fastmcp --with fastembed 1>&2; then
      _log "installed markdown-vault-mcp via uv"
    else
      _log "ERROR: uv tool install failed (see installer output above)"
      exit 1
    fi
  elif command -v pipx >/dev/null 2>&1; then
    if pipx install git+https://github.com/mikebronner/markdown-vault-mcp 1>&2; then
      _log "installed markdown-vault-mcp via pipx"
    else
      _log "ERROR: pipx install failed (see installer output above)"
      exit 1
    fi
  else
    _log "ERROR: markdown-vault-mcp is not installed and neither uv nor pipx is on PATH."
    _log "Install uv (https://docs.astral.sh/uv/) or pipx (https://pipx.pypa.io/) and restart Claude Code,"
    _log "or install the server manually with one of:"
    _log "  uv tool install --from git+https://github.com/mikebronner/markdown-vault-mcp markdown-vault-mcp --with fastmcp --with fastembed"
    _log "  pipx install git+https://github.com/mikebronner/markdown-vault-mcp"
    _log "See README.md, section '3. markdown-vault-mcp — the MCP server backing the memory vault'."
    exit 1
  fi

  if ! command -v markdown-vault-mcp >/dev/null 2>&1; then
    _log "ERROR: install reported success but markdown-vault-mcp is still not on PATH"
    _log "PATH: $PATH"
    exit 1
  fi
  _log "bootstrap complete; starting server"
fi
# -----------------------------------------------------------------------------

# Prefer the current data dir; fall back to the pre-rename location.
CONFIG_FILE="$HOME/.claude/plugins/data/workbench-core-claude-workbench/config.json"
LEGACY_CONFIG="$HOME/.claude/plugins/data/workbench-claude-workbench/config.json"
if [ ! -f "$CONFIG_FILE" ] && [ -f "$LEGACY_CONFIG" ]; then
  CONFIG_FILE="$LEGACY_CONFIG"
fi

_cfg() {
  [ -f "$CONFIG_FILE" ] && command -v jq >/dev/null 2>&1 \
    && jq -r "$1 // empty" "$CONFIG_FILE" 2>/dev/null
}

MEMORY_PATH=$(_cfg '.memory_path')
MEMORY_PATH="${MEMORY_PATH:-$HOME/Documents/Claude/Memory}"
CACHE_PATH=$(_cfg '.memory_cache')
CACHE_PATH="${CACHE_PATH:-$HOME/.claude-memory-cache}"
MCP_NAME=$(_cfg '.memory_mcp_server_name')
MCP_NAME="${MCP_NAME:-workbench-memory}"

export MARKDOWN_VAULT_MCP_SOURCE_DIR="$MEMORY_PATH"
export MARKDOWN_VAULT_MCP_INDEX_PATH="$CACHE_PATH/vault-index.sqlite"
export MARKDOWN_VAULT_MCP_EMBEDDINGS_PATH="$CACHE_PATH/embeddings"
export MARKDOWN_VAULT_MCP_STATE_PATH="$CACHE_PATH/state.json"
export MARKDOWN_VAULT_MCP_READ_ONLY="false"
export MARKDOWN_VAULT_MCP_REQUIRED_FIELDS="name,type"
export MARKDOWN_VAULT_MCP_INDEXED_FIELDS="name,type,tags,summary,date,scope,log_files"
# Raw session transcripts are write-only archival: searchable memory lives in
# the summaries/decisions layer (summaries keep log_files pointers, and the
# server's read tool still reads excluded files by path). The server purges
# previously-indexed matches on next boot (markdown-vault-mcp upgrade, #255).
export MARKDOWN_VAULT_MCP_EXCLUDE="sessions/**/*.log.md"
export MARKDOWN_VAULT_MCP_SERVER_NAME="$MCP_NAME"
export EMBEDDING_PROVIDER="fastembed"

# --- Out-of-band index reclamation: gated full VACUUM ------------------------
# We keep the markdown-vault-mcp server a pristine mirror of upstream 3.0.1, so
# index maintenance happens here in the launcher rather than inside the server.
# This matches upstream's own guidance ("run VACUUM on the index file").
#
# A *gated full* VACUUM is the right out-of-band choice:
#   - The index is auto_vacuum=NONE, so `PRAGMA incremental_vacuum` is a no-op —
#     only a full VACUUM actually reclaims space.
#   - A full VACUUM also defragments the file, and avoids the permanent ptrmap
#     overhead that switching to auto_vacuum=FULL would impose on every write.
#
# Gating keeps boot fast: we only VACUUM when the reclaimable freelist exceeds a
# threshold (freelist_count * page_size). Most boots have a tiny freelist → skip
# → zero added latency. The first VACUUM on an already-bloated index is bounded
# by *live* data size (~1s here), well under Claude Code's MCP startup timeout.
#
# Hard rules: this step must NEVER fail the launcher and must NEVER touch stdout
# (the MCP stdio channel) — all output goes through _log (stderr). Another server
# process may hold the index (multi-session), so we set a busy timeout and treat
# any error (busy/locked, missing sqlite3, absent file) as a skip-and-continue.
# The busy timeout is set with the `.timeout` dot-command, not `PRAGMA
# busy_timeout` — the PRAGMA emits a result row that would pollute the freelist
# read; the dot-command sets the same busy handler silently.
VACUUM_THRESHOLD_MB="${WORKBENCH_MEMORY_VACUUM_THRESHOLD_MB:-50}"
if ! command -v sqlite3 >/dev/null 2>&1; then
  _log "vacuum: sqlite3 not on PATH; skipping index reclamation"
elif [ ! -f "$MARKDOWN_VAULT_MCP_INDEX_PATH" ]; then
  _log "vacuum: index not present yet; skipping reclamation"
else
  FREELIST_BYTES=$(sqlite3 "$MARKDOWN_VAULT_MCP_INDEX_PATH" -cmd ".timeout 2000" \
    "SELECT freelist_count * page_size FROM pragma_freelist_count, pragma_page_size;" \
    2>/dev/null)
  if ! [[ "$FREELIST_BYTES" =~ ^[0-9]+$ ]]; then
    _log "vacuum: could not read freelist (locked or unreadable); skipping"
  elif [ "$FREELIST_BYTES" -gt $(( VACUUM_THRESHOLD_MB * 1024 * 1024 )) ]; then
    _log "vacuum: reclaimable freelist ${FREELIST_BYTES}B > ${VACUUM_THRESHOLD_MB}MB threshold; running VACUUM"
    if sqlite3 "$MARKDOWN_VAULT_MCP_INDEX_PATH" -cmd ".timeout 2000" "VACUUM;" 1>&2; then
      _log "vacuum: reclaimed index space"
    else
      _log "vacuum: VACUUM failed (likely held by another session); continuing"
    fi
  else
    _log "vacuum: freelist ${FREELIST_BYTES}B under ${VACUUM_THRESHOLD_MB}MB threshold; skipping"
  fi
fi
# -----------------------------------------------------------------------------

exec markdown-vault-mcp serve
