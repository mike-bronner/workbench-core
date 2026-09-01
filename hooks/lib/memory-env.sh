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
  # The server reads only the prefixed form — a bare EMBEDDING_PROVIDER export
  # was dead config (2026-07-08 audit) and left the provider pin to defaults.
  export MARKDOWN_VAULT_MCP_EMBEDDING_PROVIDER="fastembed"

  # Curated-ranking options (fork feat/curated-ranking, bundled wheel ≥3.1.0):
  # vault convention titles notes via `name:`; hand-written `summary:` text is
  # searchable and boosted; the sessions/ corpus (majority of docs) is
  # down-weighted so curated notes win decision-shaped queries. All five are
  # no-ops on a server without the feature.
  export MARKDOWN_VAULT_MCP_TITLE_FIELD="name"
  export MARKDOWN_VAULT_MCP_SEARCHABLE_FIELDS="summary"
  export MARKDOWN_VAULT_MCP_EMBED_CONTEXT="true"
  export MARKDOWN_VAULT_MCP_FOLDER_WEIGHTS="sessions:0.5"
  export MARKDOWN_VAULT_MCP_FTS_WEIGHTS="title:3.0,summary:2.0"

  # HTTP/SSE transport REQUIRES a writable KV store and event store; its default
  # file:///data/state is unwritable on macOS and crashes the server at boot.
  # Pin both under CACHE_PATH. Stdio ignores them, so this is harmless there.
  export MARKDOWN_VAULT_MCP_KV_STORE_URL="file://$CACHE_PATH/kv"
  export MARKDOWN_VAULT_MCP_EVENT_STORE_URL="file://$CACHE_PATH/events"

  # ──────────── Git sync (cross-machine shared memory) ────────────
  # The server can keep the vault in sync with a git remote itself: fetch +
  # fast-forward before the initial index build, then a pull loop whose on_pull
  # callback is `reindex`, plus a deferred-commit queue for writes.
  #
  # Why this and not a file-sync tool: a synced FILE is not a searchable memory.
  # Syncthing would drop the other machine's notes into the vault, but nothing
  # would tell the index they arrived, so they stay unfindable until something
  # forces a rescan. The pull loop reindexes on every pull by design. Git also
  # merges markdown (a sync tool leaves you a .sync-conflict copy) and gives
  # every memory change a revertible history.
  #
  # ONLY the markdown syncs. The SQLite index, the embeddings and the venv stay
  # machine-local under CACHE_PATH — a WAL database copied by a file syncer with
  # no transactional grouping is a corrupted database.
  #
  # REQUIRES A SINGLE WRITER. The strategy's write-quiescing (pause writes, drain
  # the commit queue, merge on a clean tree) is built from `threading` locks —
  # in-process only. N per-session servers would be N independent locks all
  # committing into one .git, where git's own index.lock fails fast rather than
  # waiting. That is exactly why this is wired only now that the transport is the
  # single shared HTTP server; do NOT enable it alongside per-session stdio.
  #
  # Everything stays off unless a repo URL is configured, so a user who has not
  # opted in gets byte-identical behaviour to before.
  GIT_REPO_URL="${WORKBENCH_MEMORY_GIT_REPO_URL:-$(_cfg '.memory_git_repo_url')}"
  if [ -n "$GIT_REPO_URL" ]; then
    export MARKDOWN_VAULT_MCP_GIT_REPO_URL="$GIT_REPO_URL"

    # The token is read from the environment FIRST so it can live in
    # ~/.claude/settings.json `.env` beside WORKBENCH_MEMORY_TOKEN rather than in
    # config.json, which is plain-text plugin data. config.json remains a
    # fallback for convenience, but it is the worse place for a credential.
    GIT_TOKEN="${WORKBENCH_MEMORY_GIT_TOKEN:-$(_cfg '.memory_git_token')}"
    [ -n "$GIT_TOKEN" ] && export MARKDOWN_VAULT_MCP_GIT_TOKEN="$GIT_TOKEN"

    GIT_USERNAME="${WORKBENCH_MEMORY_GIT_USERNAME:-$(_cfg '.memory_git_username')}"
    [ -n "$GIT_USERNAME" ] && export MARKDOWN_VAULT_MCP_GIT_USERNAME="$GIT_USERNAME"

    # 120s, not the server's own 600s default: this is interactive shared memory
    # between two machines the same person is using, and ten minutes of staleness
    # is long enough to re-derive a decision the other machine already recorded.
    GIT_PULL="${WORKBENCH_MEMORY_GIT_PULL_INTERVAL:-$(_cfg '.memory_git_pull_interval_s')}"
    export MARKDOWN_VAULT_MCP_GIT_PULL_INTERVAL_S="${GIT_PULL:-120}"

    # Seconds of write-IDLE before pushing (not a fixed timer): a burst of
    # captures in one turn coalesces into a single push.
    GIT_PUSH="${WORKBENCH_MEMORY_GIT_PUSH_DELAY:-$(_cfg '.memory_git_push_delay_s')}"
    export MARKDOWN_VAULT_MCP_GIT_PUSH_DELAY_S="${GIT_PUSH:-30}"

    GIT_NAME="${WORKBENCH_MEMORY_GIT_COMMIT_NAME:-$(_cfg '.memory_git_commit_name')}"
    [ -n "$GIT_NAME" ] && export MARKDOWN_VAULT_MCP_GIT_COMMIT_NAME="$GIT_NAME"
    GIT_EMAIL="${WORKBENCH_MEMORY_GIT_COMMIT_EMAIL:-$(_cfg '.memory_git_commit_email')}"
    [ -n "$GIT_EMAIL" ] && export MARKDOWN_VAULT_MCP_GIT_COMMIT_EMAIL="$GIT_EMAIL"

    # LFS defaults to TRUE upstream and earns nothing on a vault of small
    # markdown files — it only adds a filter that has to be installed on both
    # machines before a clone works. Off unless deliberately asked for.
    GIT_LFS="${WORKBENCH_MEMORY_GIT_LFS:-$(_cfg '.memory_git_lfs')}"
    export MARKDOWN_VAULT_MCP_GIT_LFS="${GIT_LFS:-false}"
  fi

  unset -f _cfg
}
