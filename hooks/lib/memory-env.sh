#!/usr/bin/env bash
#
# memory-env: shared resolution of the memory vault's environment.
#
# Sourceable and side-effect-free: sourcing this file only DEFINES functions —
# it touches no globals, runs no I/O, and exports nothing. Call memory_load_env
# to actually resolve config and export the MARKDOWN_VAULT_MCP_* server env.
#
# This is the single source of truth for the path/cache/mcp-name/port quartet,
# shared by the MCP launcher (mcp-memory.sh), the lazy-start supervisor
# (memory-server-spawn.sh / -up.sh), and the session warmup. Each historically
# resolved config its own way; memory_load_env reconciles them so they always
# agree on where the vault, cache, and server live.
#
# Precedence for every value: WORKBENCH_* override env → config.json → default.
# The override env wins so tests (and ad-hoc runs) can redirect every path
# without writing config; config.json is the user's persistent customization;
# the hardcoded default is the last resort.

# memory_resolve_config_file: echo the path of the config.json to read.
#
# Prefer the current data dir; fall back to the pre-rename location so users who
# customized before the workbench → workbench-core rename keep working. Honors
# WORKBENCH_CONFIG_FILE as a test/override hook. Echoes nothing when no config
# file exists (callers treat that as "use defaults").
memory_resolve_config_file() {
  if [ -n "${WORKBENCH_CONFIG_FILE:-}" ]; then
    printf '%s' "$WORKBENCH_CONFIG_FILE"
    return 0
  fi
  local current="$HOME/.claude/plugins/data/workbench-core-claude-workbench/config.json"
  local legacy="$HOME/.claude/plugins/data/workbench-claude-workbench/config.json"
  if [ ! -f "$current" ] && [ -f "$legacy" ]; then
    printf '%s' "$legacy"
  else
    printf '%s' "$current"
  fi
}

# memory_load_env: resolve config and export the full memory server env.
#
# Sets these shell variables (override → config.json → default), so callers can
# read them directly after the call:
#   MEMORY_PATH   vault root on disk
#   CACHE_PATH    index/embeddings/state/kv/events/server-artifacts root
#   MCP_NAME      MARKDOWN_VAULT_MCP_SERVER_NAME / serverInfo.name
#   MEMORY_PORT   HTTP transport port (launcher fallback; settings.json env wins
#                 for the host's own MCP-connect — see README)
#
# Then exports the complete MARKDOWN_VAULT_MCP_* set the server reads, including
# the KV_STORE_URL / EVENT_STORE_URL pair the HTTP/SSE transport REQUIRES (its
# default file:///data/state crashes on macOS). Stdio ignores those two, so
# exporting them unconditionally is harmless.
#
# Side-effect-only (exports); echoes nothing on stdout.
memory_load_env() {
  local config_file
  config_file="$(memory_resolve_config_file)"

  # _cfg: read a jq path from the resolved config, echoing empty when the file
  # is absent, jq is missing, or the key is unset.
  _cfg() {
    [ -f "$config_file" ] && command -v jq >/dev/null 2>&1 \
      && jq -r "$1 // empty" "$config_file" 2>/dev/null
  }

  MEMORY_PATH="${WORKBENCH_MEMORY_PATH:-$(_cfg '.memory_path')}"
  MEMORY_PATH="${MEMORY_PATH:-$HOME/Documents/Claude/Memory}"
  CACHE_PATH="${WORKBENCH_MEMORY_CACHE:-$(_cfg '.memory_cache')}"
  CACHE_PATH="${CACHE_PATH:-$HOME/.claude-memory-cache}"
  MCP_NAME="${WORKBENCH_MCP_SERVER_NAME:-$(_cfg '.memory_mcp_server_name')}"
  MCP_NAME="${MCP_NAME:-workbench-memory}"
  MEMORY_PORT="${WORKBENCH_MEMORY_PORT:-$(_cfg '.memory_port')}"
  MEMORY_PORT="${MEMORY_PORT:-8765}"

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

  # HTTP/SSE transport REQUIRES a writable KV store and event store; its default
  # file:///data/state is unwritable on macOS and crashes the server at boot.
  # Pin both under CACHE_PATH. Stdio ignores them, so this is harmless there.
  export MARKDOWN_VAULT_MCP_KV_STORE_URL="file://$CACHE_PATH/kv"
  export MARKDOWN_VAULT_MCP_EVENT_STORE_URL="file://$CACHE_PATH/events"

  unset -f _cfg
}
