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
WHEELS_DIR="$HOOKS_DIR/wheels"

# Fallback bootstrap (resilience / dev): when no bundled wheel is available or
# uv is missing, fall back to the legacy "install the global binary from the
# mikebronner fork if it's missing, then exec the PATH binary" behavior. This
# keeps a working server on a checkout with an empty wheels/ dir, or on a host
# without uv. Mirrors the pre-bundled-wheel launcher exactly.
_install_from_git_and_exec() {
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
  exec markdown-vault-mcp serve
}
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

# --- Bundled-wheel install into a persistent venv, then exec the venv binary -
# Claude Code plugins have no dependency-install lifecycle, so the launcher
# installs its own server. We bundle the built wheel under hooks/wheels/ (it
# travels with the plugin) and install it into a persistent venv kept under
# CACHE_PATH — outside the plugin tree, so it survives plugin updates and a
# plugin update that ships a new wheel triggers an automatic server upgrade.
#
# Cache key is the wheel's SHA-256 content hash, NOT the version string: a wheel
# rebuilt from the same upstream version still gets reinstalled if its bytes
# changed. We reinstall iff the hash differs from the marker OR the venv binary
# is missing. Cold install of the full closure (~90 pkgs) benchmarks at ~2.6s,
# well under Claude Code's 30s MCP startup timeout, so the install runs
# synchronously here — no deferral needed.
#
# The base wheel declares only fastmcp-pvl-core/typer/frontmatter/requests;
# fastmcp and fastembed live behind extras, so they MUST be named explicitly
# (matching the legacy `--with fastmcp --with fastembed`).
#
# Hard rules carry over: every byte of install/hash output goes to stderr via
# _log (stdout is the MCP stdio channel). If uv is missing or no bundled wheel
# exists, fall back to the legacy git-install-and-exec path.
WHEEL=""
if [ -d "$WHEELS_DIR" ]; then
  WHEEL="$(ls -t "$WHEELS_DIR"/markdown_vault_mcp-*.whl 2>/dev/null | head -n 1)"
fi

if [ -z "$WHEEL" ] || ! command -v uv >/dev/null 2>&1; then
  if [ -z "$WHEEL" ]; then
    _log "no bundled wheel in $WHEELS_DIR; falling back to git install"
  else
    _log "uv not on PATH; falling back to git/pipx install"
  fi
  _install_from_git_and_exec
fi

VENV="$CACHE_PATH/server-venv"
HASH_MARKER="$VENV/.installed-wheel-hash"
SERVER_BIN="$VENV/bin/markdown-vault-mcp"

# Hash the wheel bytes. shasum ships with macOS base and exists on Linux too.
WHEEL_HASH="$(shasum -a 256 "$WHEEL" | cut -d' ' -f1)"
INSTALLED_HASH=""
[ -f "$HASH_MARKER" ] && INSTALLED_HASH="$(cat "$HASH_MARKER" 2>/dev/null)"

if [ "$WHEEL_HASH" != "$INSTALLED_HASH" ] || [ ! -x "$SERVER_BIN" ]; then
  _log "installing bundled wheel $(basename "$WHEEL") into $VENV (~2.6s, first run or wheel change)"
  if [ ! -d "$VENV" ]; then
    if ! uv venv "$VENV" --python ">=3.11" 1>&2; then
      _log "ERROR: uv venv failed; falling back to git install"
      _install_from_git_and_exec
    fi
  fi
  if uv pip install --python "$VENV/bin/python" --force-reinstall \
      "$WHEEL" fastmcp fastembed 1>&2; then
    echo "$WHEEL_HASH" > "$HASH_MARKER"
    _log "installed markdown-vault-mcp into server venv"
  else
    _log "ERROR: uv pip install failed; falling back to git install"
    _install_from_git_and_exec
  fi
else
  _log "server venv up to date (wheel hash matches); skipping install"
fi

if [ ! -x "$SERVER_BIN" ]; then
  _log "ERROR: install reported success but $SERVER_BIN is missing; falling back to git install"
  _install_from_git_and_exec
fi

# Hand off to the venv binary. exec replaces the shell so Claude Code's MCP
# stop signal reaches the Python process directly.
exec "$SERVER_BIN" serve
# -----------------------------------------------------------------------------
