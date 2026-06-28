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

# Resolve the memory env (path/cache/mcp-name/port + the full MARKDOWN_VAULT_MCP_*
# export set) via the shared library, so this launcher, the lazy-start
# supervisor, and the warmup all agree on where the vault and cache live.
# memory_load_env sets MEMORY_PATH/CACHE_PATH/MCP_NAME/MEMORY_PORT and exports
# the server env (precedence: WORKBENCH_* override → config.json → default).
# shellcheck source=hooks/lib/memory-env.sh
. "$HOOKS_DIR/lib/memory-env.sh"
memory_load_env

# --- Index reclamation moved out of this launcher ----------------------------
# The gated full VACUUM used to run here on every per-session connect, which
# could race a sibling session holding the same index. It now lives in the
# shared cold-start library (hooks/lib/memory-vacuum.sh); under the shared-server
# model the lazy-start supervisor runs it at a confirmed cold start, inside the
# spawn lock, with no server alive — so there is no writer to race. This stdio
# launcher is the escape hatch / in-flight-old-session path; it no longer VACUUMs.
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
