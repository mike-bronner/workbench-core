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

# Validate config.json if it exists — a malformed file silently falls back to
# hardcoded defaults, which point to the wrong directories.
if [ -f "$CONFIG_FILE" ] && command -v jq >/dev/null 2>&1; then
  if ! jq empty "$CONFIG_FILE" 2>/dev/null; then
    CONFIG_BROKEN=1
  fi
fi

MEMORY_PATH="${WORKBENCH_MEMORY_PATH:-$(_cfg '.memory_path')}"
MEMORY_PATH="${MEMORY_PATH:-$HOME/Documents/Claude/Memory}"
CACHE_PATH="${WORKBENCH_MEMORY_CACHE:-$(_cfg '.memory_cache')}"
CACHE_PATH="${CACHE_PATH:-$HOME/.claude-memory-cache}"
PENDING_SUMMARIES_DIR="$CACHE_PATH/pending-summaries"
CHECKPOINTS_DIR="$CACHE_PATH/log-checkpoints"
MCP_SERVER_NAME="${WORKBENCH_MCP_SERVER_NAME:-$(_cfg '.memory_mcp_server_name')}"
MCP_SERVER_NAME="${MCP_SERVER_NAME:-workbench-memory}"
AGENT_NAME="${WORKBENCH_AGENT_NAME:-$(_cfg '.agent_name')}"
AGENT_NAME="${AGENT_NAME:-Claude}"

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

# Skip guard: the summary-writer spawn from session-log.sh sets this env
# var on its detached claude process. That process doesn't need identity
# context or pending-summary scanning — it has a single mechanical job
# assigned in its prompt and should not touch anything other than its job.
if [ "${WORKBENCH_SKIP_WARMUP:-}" = "1" ]; then
  exit 0
fi

printf '# %s session warmup (%s)\n\n' "$AGENT_NAME" "$SOURCE"

# ──────────── Config validation warning ────────────
if [ "${CONFIG_BROKEN:-}" = "1" ]; then
  printf '## ⚠ Malformed config.json\n\n'
  printf '`%s` exists but is not valid JSON.\n' "$CONFIG_FILE"
  printf 'All settings are falling back to hardcoded defaults, which may point to wrong directories.\n'
  printf 'Run `/workbench:customize` to regenerate the config, or fix the JSON manually.\n\n'
fi

# ──────────── Retention cleanup (startup only) ────────────
# Prune stale artifacts on full warmup. Runs before identity injection so it
# doesn't add latency to the user-visible part of startup. All find commands
# are fire-and-forget (-delete exits silently on no matches).
if [ "$SOURCE" = "startup" ]; then
  # Raw logs older than 28 days — summaries stay forever as the durable record.
  find "$MEMORY_PATH/sessions" -name "*.log.md" -mtime +28 -delete 2>/dev/null

  # Per-session checkpoint files older than 7 days — sessions don't resume.
  [ -d "$CHECKPOINTS_DIR" ] && find "$CHECKPOINTS_DIR" -name "*.json" -mtime +7 -delete 2>/dev/null

  # Legacy summary-writer logs — no longer generated, clean up any remaining.
  find "$CACHE_PATH" -name "summary-writer-*.log" -delete 2>/dev/null
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
#
# Paths resolve from config.json identity_files, falling back to hardcoded defaults.
SOUL_HOT="$MEMORY_PATH/$(_cfg '.identity_files.soul_hot')"
SOUL_HOT="${SOUL_HOT:-$MEMORY_PATH/identity/soul-hot.md}"
PROFILE="$MEMORY_PATH/$(_cfg '.identity_files.profile')"
PROFILE="${PROFILE:-$MEMORY_PATH/identity/profile.md}"
SKILLS_PROTOCOL="$MEMORY_PATH/identity/skills-protocol.md"

if [ -r "$SOUL_HOT" ]; then
  printf '## Identity — soul-hot\n\n'
  cat "$SOUL_HOT"
  printf '\n\n'
else
  printf '_(soul-hot.md not found at %s)_\n\n' "$SOUL_HOT"
fi

if [ -r "$PROFILE" ]; then
  printf '## User profile\n\n'
  cat "$PROFILE"
  printf '\n\n'
else
  printf '_(profile.md not found at %s)_\n\n' "$PROFILE"
fi

if [ -r "$SKILLS_PROTOCOL" ]; then
  printf '## Skills protocol\n\n'
  cat "$SKILLS_PROTOCOL"
  printf '\n\n'
fi

GUARDRAILS="${CLAUDE_PLUGIN_ROOT}/references/guardrails.md"

if [ -r "$GUARDRAILS" ]; then
  printf '## Guardrails — absolute rules\n\n'
  cat "$GUARDRAILS"
  printf '\n\n'
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
**Run \`/workbench:process-pending-summaries\` to handle these in the background.**
Do NOT block the session — the skill dispatches agents and returns immediately.

If the skill is unavailable, note the pending summaries and move on.
They will be picked up by the next session or manual \`/workbench:log-now\`.
NOTICE
    printf '\n'
  fi
fi

exit 0
