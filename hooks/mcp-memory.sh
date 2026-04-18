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
export MARKDOWN_VAULT_MCP_SERVER_NAME="$MCP_NAME"
export EMBEDDING_PROVIDER="fastembed"

exec markdown-vault-mcp serve
