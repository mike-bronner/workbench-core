#!/usr/bin/env bash
#
# memory-install: resolve (and if needed install) the markdown-vault-mcp server
# binary, shared by the stdio launcher (mcp-memory.sh) and the lazy-start HTTP
# supervisor (memory-server-spawn.sh).
#
# Sourceable and side-effect-free: sourcing only DEFINES functions. Call
# memory_install_server to do the work; on success it sets SERVER_BIN (a path
# the caller can exec / nohup) and returns 0; on unrecoverable failure it
# returns non-zero and the caller decides what to do (the stdio launcher exits,
# the supervisor records .server-failed).
#
# Why this is shared: Claude Code plugins have no dependency-install lifecycle,
# so the plugin installs its own server. The bundled wheel under hooks/wheels/
# travels with the plugin; we install it into a persistent venv kept under
# CACHE_PATH (outside the plugin tree, so it survives plugin updates, and a
# plugin update shipping a new wheel auto-upgrades the server). Both transports
# need exactly this resolution — only the launch differs (stdio `exec serve`
# vs HTTP `nohup serve --transport http …`), which stays in each caller.
#
# Cache key is the wheel's SHA-256 content hash, NOT the version string: a wheel
# rebuilt from the same upstream version still reinstalls if its bytes changed.
# Reinstall iff the hash differs from the marker OR the venv binary is missing.
#
# The base wheel declares only fastmcp-pvl-core/typer/frontmatter/requests;
# fastmcp and fastembed live behind extras, so they MUST be named explicitly.
#
# Logging: every caller passes a logger function name as $1; all install/hash
# chatter goes there (the launcher routes it to stderr so the MCP stdio channel
# stays clean; the supervisor routes it to server.log). Required inputs (env or
# pre-set vars): HOOKS_DIR (to find wheels/) and CACHE_PATH (venv location).

# _memory_install_from_git: legacy resilience path — install the global binary
# from the mikebronner fork when no bundled wheel is available or uv is missing.
# On success sets SERVER_BIN to the global binary's path and returns 0; returns
# non-zero when the binary cannot be made available. Does NOT exec — the caller
# launches with its own transport flags.
_memory_install_from_git() {
  local logger="$1"
  if ! command -v markdown-vault-mcp >/dev/null 2>&1; then
    "$logger" "markdown-vault-mcp not found; installing from mikebronner fork (~60-90s, first run only)"
    if command -v uv >/dev/null 2>&1; then
      if uv tool install --from git+https://github.com/mikebronner/markdown-vault-mcp \
          markdown-vault-mcp --with fastmcp --with fastembed 1>&2; then
        "$logger" "installed markdown-vault-mcp via uv"
      else
        "$logger" "ERROR: uv tool install failed (see installer output above)"
        return 1
      fi
    elif command -v pipx >/dev/null 2>&1; then
      if pipx install git+https://github.com/mikebronner/markdown-vault-mcp 1>&2; then
        "$logger" "installed markdown-vault-mcp via pipx"
      else
        "$logger" "ERROR: pipx install failed (see installer output above)"
        return 1
      fi
    else
      "$logger" "ERROR: markdown-vault-mcp is not installed and neither uv nor pipx is on PATH."
      "$logger" "Install uv (https://docs.astral.sh/uv/) or pipx (https://pipx.pypa.io/) and restart Claude Code,"
      "$logger" "or install the server manually with one of:"
      "$logger" "  uv tool install --from git+https://github.com/mikebronner/markdown-vault-mcp markdown-vault-mcp --with fastmcp --with fastembed"
      "$logger" "  pipx install git+https://github.com/mikebronner/markdown-vault-mcp"
      "$logger" "See README.md, section '3. markdown-vault-mcp — the MCP server backing the memory vault'."
      return 1
    fi

    if ! command -v markdown-vault-mcp >/dev/null 2>&1; then
      "$logger" "ERROR: install reported success but markdown-vault-mcp is still not on PATH"
      "$logger" "PATH: $PATH"
      return 1
    fi
    "$logger" "bootstrap complete"
  fi
  # SERVER_BIN is the function's out-parameter, read by the caller after return.
  # shellcheck disable=SC2034
  SERVER_BIN="$(command -v markdown-vault-mcp)"
  return 0
}

# memory_install_server: ensure a usable server binary, setting SERVER_BIN.
# Args: $1 = logger function name. Returns 0 with SERVER_BIN set, or non-zero.
memory_install_server() {
  local logger="$1"
  local wheels_dir="${HOOKS_DIR:?HOOKS_DIR must be set}/wheels"
  local cache="${CACHE_PATH:?CACHE_PATH must be set}"

  local wheel=""
  if [ -d "$wheels_dir" ]; then
    wheel="$(ls -t "$wheels_dir"/markdown_vault_mcp-*.whl 2>/dev/null | head -n 1)"
  fi

  # No bundled wheel or no uv → legacy git/pipx install of the global binary.
  if [ -z "$wheel" ] || ! command -v uv >/dev/null 2>&1; then
    if [ -z "$wheel" ]; then
      "$logger" "no bundled wheel in $wheels_dir; falling back to git install"
    else
      "$logger" "uv not on PATH; falling back to git/pipx install"
    fi
    _memory_install_from_git "$logger"
    return $?
  fi

  local venv="$cache/server-venv"
  local hash_marker="$venv/.installed-wheel-hash"
  local server_bin="$venv/bin/markdown-vault-mcp"

  # Hash the wheel bytes. shasum ships with macOS base and exists on Linux too.
  local wheel_hash installed_hash=""
  wheel_hash="$(shasum -a 256 "$wheel" | cut -d' ' -f1)"
  [ -f "$hash_marker" ] && installed_hash="$(cat "$hash_marker" 2>/dev/null)"

  if [ "$wheel_hash" != "$installed_hash" ] || [ ! -x "$server_bin" ]; then
    "$logger" "installing bundled wheel $(basename "$wheel") into $venv (~2.6s, first run or wheel change)"
    if [ ! -d "$venv" ]; then
      if ! uv venv "$venv" --python ">=3.11" 1>&2; then
        "$logger" "ERROR: uv venv failed; falling back to git install"
        _memory_install_from_git "$logger"
        return $?
      fi
    fi
    if uv pip install --python "$venv/bin/python" --force-reinstall \
        "$wheel" fastmcp fastembed 1>&2; then
      echo "$wheel_hash" > "$hash_marker"
      "$logger" "installed markdown-vault-mcp into server venv"
    else
      "$logger" "ERROR: uv pip install failed; falling back to git install"
      _memory_install_from_git "$logger"
      return $?
    fi
  else
    "$logger" "server venv up to date (wheel hash matches); skipping install"
  fi

  if [ ! -x "$server_bin" ]; then
    "$logger" "ERROR: install reported success but $server_bin is missing; falling back to git install"
    _memory_install_from_git "$logger"
    return $?
  fi

  # SERVER_BIN is the function's out-parameter, read by the caller after return.
  # shellcheck disable=SC2034
  SERVER_BIN="$server_bin"
  return 0
}
