#!/bin/bash
# Tests for hooks/lib/memory-env.sh — the shared memory env resolver.
# Run directly: ./test-memory-env.sh
# Each case sources the lib in a clean env, calls memory_load_env with a chosen
# combination of override env / config.json / nothing, and asserts the resolved
# variables and the exported MARKDOWN_VAULT_MCP_* set. Pure resolution logic —
# no server, no network, no I/O beyond reading a fixture config.json.

set -u
LIB="$(cd "$(dirname "$0")" && pwd)/lib/memory-env.sh"
PASS=0
FAIL=0

SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

# A config fixture with every field set, so config-wins cases have a value to win
# with that is distinct from both override env and the hardcoded defaults.
mkdir -p "$SANDBOX/cfgdir"
cat > "$SANDBOX/cfgdir/config.json" <<'EOF'
{
  "memory_path": "/cfg/mem",
  "memory_cache": "/cfg/cache",
  "memory_mcp_server_name": "cfg-mcp",
  "memory_port": 9999
}
EOF

# load: source the lib in a pristine env and echo "VAR=value" lines for every
# resolved/exported field. Args after the config-file path are extra env
# assignments (e.g. WORKBENCH_MEMORY_PATH=/x). A config path of "" runs with no
# config file at all (default-fallback case).
load() {
  local config="$1"; shift
  env -i HOME="$SANDBOX/home" PATH="$PATH" \
    ${config:+WORKBENCH_CONFIG_FILE="$config"} \
    "$@" \
    bash -c '. "'"$LIB"'"; memory_load_env
      printf "MEMORY_PATH=%s\n" "$MEMORY_PATH"
      printf "CACHE_PATH=%s\n" "$CACHE_PATH"
      printf "MCP_NAME=%s\n" "$MCP_NAME"
      printf "MEMORY_PORT=%s\n" "$MEMORY_PORT"
      printf "SOURCE_DIR=%s\n" "$MARKDOWN_VAULT_MCP_SOURCE_DIR"
      printf "INDEX_PATH=%s\n" "$MARKDOWN_VAULT_MCP_INDEX_PATH"
      printf "SERVER_NAME=%s\n" "$MARKDOWN_VAULT_MCP_SERVER_NAME"
      printf "KV_STORE_URL=%s\n" "$MARKDOWN_VAULT_MCP_KV_STORE_URL"
      printf "EVENT_STORE_URL=%s\n" "$MARKDOWN_VAULT_MCP_EVENT_STORE_URL"
      printf "EMBEDDING_PROVIDER=%s\n" "$MARKDOWN_VAULT_MCP_EMBEDDING_PROVIDER"
      printf "TITLE_FIELD=%s\n" "$MARKDOWN_VAULT_MCP_TITLE_FIELD"
      printf "SEARCHABLE_FIELDS=%s\n" "$MARKDOWN_VAULT_MCP_SEARCHABLE_FIELDS"
      printf "EMBED_CONTEXT=%s\n" "$MARKDOWN_VAULT_MCP_EMBED_CONTEXT"
      printf "FOLDER_WEIGHTS=%s\n" "$MARKDOWN_VAULT_MCP_FOLDER_WEIGHTS"
      printf "FTS_WEIGHTS=%s\n" "$MARKDOWN_VAULT_MCP_FTS_WEIGHTS"'
}

assert_line() {
  local desc="$1" output="$2" needle="$3"
  if printf '%s\n' "$output" | grep -qxF "$needle"; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected line: $needle"
  fi
}

assert_missing() {
  local desc="$1" output="$2" needle="$3"
  if printf '%s\n' "$output" | grep -qF "$needle"; then
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — should NOT contain: $needle"
  else
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  fi
}

echo "config.json wins when no override env is set:"
OUT=$(load "$SANDBOX/cfgdir/config.json")
assert_line "memory_path from config"     "$OUT" "MEMORY_PATH=/cfg/mem"
assert_line "memory_cache from config"    "$OUT" "CACHE_PATH=/cfg/cache"
assert_line "mcp name from config"        "$OUT" "MCP_NAME=cfg-mcp"
assert_line "port from config"            "$OUT" "MEMORY_PORT=9999"
assert_line "source_dir tracks path"      "$OUT" "SOURCE_DIR=/cfg/mem"
assert_line "index_path under cache"      "$OUT" "INDEX_PATH=/cfg/cache/vault-index.sqlite"
assert_line "server_name tracks mcp name" "$OUT" "SERVER_NAME=cfg-mcp"
assert_line "provider pin uses prefixed var"  "$OUT" "EMBEDDING_PROVIDER=fastembed"
assert_line "title field is name"             "$OUT" "TITLE_FIELD=name"
assert_line "summary is searchable"           "$OUT" "SEARCHABLE_FIELDS=summary"
assert_line "embed context on"                "$OUT" "EMBED_CONTEXT=true"
assert_line "sessions down-weighted"          "$OUT" "FOLDER_WEIGHTS=sessions:0.5"
assert_line "title and summary boosted"       "$OUT" "FTS_WEIGHTS=title:3.0,summary:2.0"

echo "override env wins over config.json:"
OUT=$(load "$SANDBOX/cfgdir/config.json" \
  WORKBENCH_MEMORY_PATH=/ovr/mem \
  WORKBENCH_MEMORY_CACHE=/ovr/cache \
  WORKBENCH_MCP_SERVER_NAME=ovr-mcp \
  WORKBENCH_MEMORY_PORT=7777)
assert_line "override path beats config"  "$OUT" "MEMORY_PATH=/ovr/mem"
assert_line "override cache beats config" "$OUT" "CACHE_PATH=/ovr/cache"
assert_line "override name beats config"  "$OUT" "MCP_NAME=ovr-mcp"
assert_line "override port beats config"  "$OUT" "MEMORY_PORT=7777"

echo "defaults apply when neither override nor config provides a value:"
OUT=$(load "$SANDBOX/nonexistent.json")
assert_line "default vault path"  "$OUT" "MEMORY_PATH=$SANDBOX/home/Documents/Claude/Memory"
assert_line "default cache path"  "$OUT" "CACHE_PATH=$SANDBOX/home/.claude-memory-cache"
assert_line "default mcp name"    "$OUT" "MCP_NAME=workbench-memory"
assert_line "default port 8765"   "$OUT" "MEMORY_PORT=8765"

echo "partial config falls back per-field (port absent → default):"
cat > "$SANDBOX/cfgdir/partial.json" <<'EOF'
{ "memory_path": "/only/path" }
EOF
OUT=$(load "$SANDBOX/cfgdir/partial.json")
assert_line "set field from config"        "$OUT" "MEMORY_PATH=/only/path"
assert_line "unset cache falls to default" "$OUT" "CACHE_PATH=$SANDBOX/home/.claude-memory-cache"
assert_line "unset port falls to default"  "$OUT" "MEMORY_PORT=8765"

echo "legacy data dir is used when the current one is absent:"
# memory_resolve_config_file (no WORKBENCH_CONFIG_FILE) prefers the current data
# dir but falls back to the pre-rename location. Seed only the legacy path under
# a fake HOME and confirm its values win.
LEGACY_HOME="$SANDBOX/legacy-home"
mkdir -p "$LEGACY_HOME/.claude/plugins/data/workbench-claude-workbench"
cat > "$LEGACY_HOME/.claude/plugins/data/workbench-claude-workbench/config.json" <<'EOF'
{ "memory_path": "/legacy/mem", "memory_cache": "/legacy/cache" }
EOF
OUT=$(env -i HOME="$LEGACY_HOME" PATH="$PATH" \
  bash -c '. "'"$LIB"'"; memory_load_env; printf "MEMORY_PATH=%s\nCACHE_PATH=%s\n" "$MEMORY_PATH" "$CACHE_PATH"')
assert_line "legacy config path used"  "$OUT" "MEMORY_PATH=/legacy/mem"
assert_line "legacy config cache used" "$OUT" "CACHE_PATH=/legacy/cache"

echo "KV/EVENT stores are pinned under the cache, never the crashing default:"
OUT=$(load "$SANDBOX/cfgdir/config.json")
assert_line "kv store under cache as file://"    "$OUT" "KV_STORE_URL=file:///cfg/cache/kv"
assert_line "event store under cache as file://" "$OUT" "EVENT_STORE_URL=file:///cfg/cache/events"
assert_missing "kv store never /data/state"      "$OUT" "/data/state"

echo "sourcing the lib has no side effects (no exports until called):"
OUT=$(env -i HOME="$SANDBOX/home" PATH="$PATH" \
  bash -c '. "'"$LIB"'"; printf "SRC=[%s]\n" "${MARKDOWN_VAULT_MCP_SOURCE_DIR:-}"')
assert_line "no SOURCE_DIR exported on bare source" "$OUT" "SRC=[]"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
