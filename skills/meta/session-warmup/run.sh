#!/usr/bin/env bash
#
# session-warmup: inject identity essentials and handle pending work at session
# start.
#
# Invoked by the `core` plugin's SessionStart hook. Reads the hook payload from
# stdin, writes identity + notices to stdout for Claude Code to inject into the
# assistant's context.
#
# Branches on the payload's `source` field:
#   startup → full warmup: cleanup + health check + identity + pending-summary
#   resume  → identity refresh + pending-summary check
#   clear   → identity refresh + pending-summary check
#   compact → identity refresh only (re-inject after context compression)
#
# Exit code is always 0 — warmup failures must not break the session.

set -u

# Config resolution: env var → config.json → hardcoded default.
CONFIG_FILE="$HOME/.claude/plugins/data/workbench-claude-workbench/config.json"
_cfg() { [ -f "$CONFIG_FILE" ] && command -v jq >/dev/null 2>&1 && jq -r "$1 // empty" "$CONFIG_FILE" 2>/dev/null; }

MEMORY_PATH="${WORKBENCH_MEMORY_PATH:-$(_cfg '.memory_path')}"
MEMORY_PATH="${MEMORY_PATH:-$HOME/Documents/Claude/Memory}"
CACHE_PATH="${WORKBENCH_MEMORY_CACHE:-$(_cfg '.memory_cache')}"
CACHE_PATH="${CACHE_PATH:-$HOME/.claude-memory-cache}"
PENDING_SUMMARIES_DIR="$CACHE_PATH/pending-summaries"
CHECKPOINTS_DIR="$CACHE_PATH/log-checkpoints"
MCP_SERVER_NAME="${WORKBENCH_MCP_SERVER_NAME:-$(_cfg '.memory_mcp_server_name')}"
MCP_SERVER_NAME="${MCP_SERVER_NAME:-workbench-memory}"

# Read hook payload from stdin. May be empty if invoked outside a hook.
PAYLOAD=""
if [ ! -t 0 ]; then
  PAYLOAD=$(cat)
fi

# Extract source. Default to "startup" so manual runs act like a full warmup.
SOURCE="startup"
if [ -n "$PAYLOAD" ] && command -v jq >/dev/null 2>&1; then
  SOURCE=$(printf '%s' "$PAYLOAD" | jq -r '.source // "startup"' 2>/dev/null || echo "startup")
fi

# Skip guard: the summary-writer spawn from session-log/run.sh sets this env
# var on its detached claude process. That process doesn't need identity
# context or pending-summary scanning — it has a single mechanical job
# assigned in its prompt and should not touch anything other than its job.
if [ "${WORKBENCH_SKIP_WARMUP:-}" = "1" ]; then
  exit 0
fi

printf '# Hobbes session warmup (%s)\n\n' "$SOURCE"

# ──────────── Retention cleanup (startup only) ────────────
# Prune stale artifacts on full warmup. Runs before identity injection so it
# doesn't add latency to the user-visible part of startup. All find commands
# are fire-and-forget (-delete exits silently on no matches).
if [ "$SOURCE" = "startup" ]; then
  # Raw logs older than 28 days — summaries stay forever as the durable record.
  find "$MEMORY_PATH/sessions" -name "*.log.md" -mtime +28 -delete 2>/dev/null

  # Per-session checkpoint files older than 7 days — sessions don't resume.
  [ -d "$CHECKPOINTS_DIR" ] && find "$CHECKPOINTS_DIR" -name "*.json" -mtime +7 -delete 2>/dev/null

  # Summary-writer logs older than 7 days — diagnostic only, not archival.
  find "$CACHE_PATH" -name "summary-writer-*.log" -mtime +7 -delete 2>/dev/null
fi

# ──────────── MCP health check (startup only) ────────────
if [ "$SOURCE" = "startup" ]; then
  MCP_INDEX="$CACHE_PATH/vault-index.sqlite"
  if [ ! -f "$MCP_INDEX" ]; then
    printf '## ⚠ Memory vault index not found\n\n'
    printf 'Expected FTS index at `%s` but it does not exist.\n' "$MCP_INDEX"
    printf 'The `%s` MCP may not be running. Memory search and write will fail.\n' "$MCP_SERVER_NAME"
    printf 'Try `mcp__plugin_workbench_memory__stats` to verify, or check server logs.\n\n'
  fi
fi

# ──────────── Identity injection (all sources) ────────────
# Identity files are always re-injected. After context compression (compact),
# the identity may have been shed. On resume, it may have drifted. The cost
# is ~7KB — small relative to the context window, and essential for maintaining
# consistent voice and behavior.
if [ -r "$MEMORY_PATH/identity/soul-hot.md" ]; then
  printf '## Identity — soul-hot\n\n'
  cat "$MEMORY_PATH/identity/soul-hot.md"
  printf '\n\n'
else
  printf '_(soul-hot.md not found at %s/identity/soul-hot.md)_\n\n' "$MEMORY_PATH"
fi

if [ -r "$MEMORY_PATH/identity/profile.md" ]; then
  printf "## User — Mike's profile\n\n"
  cat "$MEMORY_PATH/identity/profile.md"
  printf '\n\n'
else
  printf '_(profile.md not found at %s/identity/profile.md)_\n\n' "$MEMORY_PATH"
fi

# ──────────── Pending-summary check (all sources except compact) ────────────
# On compact we just re-injected identity — don't add summary work on top of
# a context that was just shed. On all other sources, check for unprocessed
# summaries and tell the model to dispatch a background agent.
if [ "$SOURCE" != "compact" ]; then
  MARKERS=()
  if [ -d "$PENDING_SUMMARIES_DIR" ]; then
    for m in "$PENDING_SUMMARIES_DIR"/*.json; do
      [ -f "$m" ] && MARKERS+=("$m")
    done
  fi

  MARKER_COUNT=${#MARKERS[@]}

  if [ "$MARKER_COUNT" -gt 0 ]; then
    printf '## ⚠ Pending session summaries (%d)\n\n' "$MARKER_COUNT"
    printf 'Previous sessions ended without narrative summaries. Markers:\n\n'

    for m in "${MARKERS[@]}"; do
      LOG_PATH=""
      SID=""
      if command -v jq >/dev/null 2>&1; then
        LOG_PATH=$(jq -r '.log_path // empty' "$m" 2>/dev/null)
        SID=$(jq -r '.session_id // empty' "$m" 2>/dev/null)
      fi
      if [ -n "$LOG_PATH" ] && [ -n "$SID" ]; then
        printf -- '- session `%s` → `%s` (marker: `%s`)\n' "$SID" "$LOG_PATH" "$m"
      else
        printf -- '- _(could not parse marker at `%s`)_\n' "$m"
      fi
    done
    printf '\n'

    cat <<NOTICE
**Dispatch a background agent to handle these.** Do NOT block the session.

For each marker, spawn a \`workbench:summary-writer\` agent (subagent_type)
in the background with the session_id, marker_path, and log_path. Then
proceed with the user's request normally.

If the Agent tool is unavailable, note the pending summaries and move on.
They will be picked up by the next session or manual \`/log-now\`.
NOTICE
    printf '\n'
  fi
fi

exit 0
