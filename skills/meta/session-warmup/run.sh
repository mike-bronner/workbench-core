#!/usr/bin/env bash
#
# session-warmup: inject identity essentials at session start.
#
# Invoked by the `core` plugin's SessionStart hook. Reads the hook payload from
# stdin, writes identity + pending-summary notice to stdout for Claude Code to
# inject into the assistant's context.
#
# Branches on the payload's `source` field:
#   startup → full warmup: identity + pending-summary check
#   resume  → minimal: pending-summary check only (identity already in context)
#   clear   → identity only (a clear follows a summary, so skip the check)
#   compact → no-op (context just got compressed, don't add more)
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

# compact → no-op. We just shed context; adding more is counter-productive.
if [ "$SOURCE" = "compact" ]; then
  exit 0
fi

# Skip guard: the summary-writer spawn from session-log/run.sh sets this env
# var on its detached claude process. That process doesn't need identity
# context or pending-summary scanning — it has a single mechanical job
# assigned in its prompt and should not touch anything other than its job.
if [ "${WORKBENCH_SKIP_WARMUP:-}" = "1" ]; then
  exit 0
fi

printf '# Hobbes session warmup (%s)\n\n' "$SOURCE"

# Identity injection: everything except `resume` gets the identity files.
# On resume the identity is carried over from the prior turn's context.
if [ "$SOURCE" != "resume" ]; then
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
fi

# Pending-summary check: skip on `clear` since clear follows a just-completed
# summary write.
#
# Markers live at $PENDING_SUMMARIES_DIR/<session_id>.json (one per session)
# so multiple concurrent sessions can all leave markers without clobbering
# each other.
if [ "$SOURCE" != "clear" ]; then
  MARKERS=()
  if [ -d "$PENDING_SUMMARIES_DIR" ]; then
    for m in "$PENDING_SUMMARIES_DIR"/*.json; do
      [ -f "$m" ] && MARKERS+=("$m")
    done
  fi

  MARKER_COUNT=${#MARKERS[@]}

  if [ "$MARKER_COUNT" -gt 0 ]; then
    if [ "$MARKER_COUNT" -eq 1 ]; then
      printf '## ⚠ Pending session summary\n\n'
      printf 'The previous session ended (or compacted) without a narrative summary.\n'
      printf 'The raw log is already on disk at:\n\n'
    else
      printf '## ⚠ Pending session summaries (%d found)\n\n' "$MARKER_COUNT"
      printf 'Previous sessions ended (or compacted) without narrative summaries.\n'
      printf 'The raw logs are on disk at:\n\n'
    fi

    # Emit one bullet per marker: log path + session_id + marker path.
    for m in "${MARKERS[@]}"; do
      LOG_PATH=""
      SID=""
      if command -v jq >/dev/null 2>&1; then
        LOG_PATH=$(jq -r '.log_path // empty' "$m" 2>/dev/null)
        SID=$(jq -r '.session_id // empty' "$m" 2>/dev/null)
      fi
      if [ -n "$LOG_PATH" ]; then
        if [ "$MARKER_COUNT" -gt 1 ] && [ -n "$SID" ]; then
          printf -- '- `%s`\n  (session: `%s`, marker: `%s`)\n' "$LOG_PATH" "$SID" "$m"
        else
          printf -- '- `%s`\n' "$LOG_PATH"
        fi
      else
        printf -- '- _(could not parse marker at `%s`)_\n' "$m"
      fi
    done
    printf '\n'

    if [ "$MARKER_COUNT" -eq 1 ]; then
      cat <<NOTICE
**Your first task this session, before any new work:**

1. Read the raw log above.
2. Write a sibling \`.summary.md\` in the same directory — frontmatter
   (\`name\`, \`type: session\`, \`scope: chronological\`, \`date\`, \`tags\`,
   \`summary: |\`) plus a narrative body covering what happened, what got
   decided, what's still open.
3. Append a short BuJo line to today's Apple Notes daily journal
   (\`mcp__Read_and_Write_Apple_Notes__update_note_content\`). Pointer to
   the log/summary path so Mike can open the detail.
4. Promote any decisions to \`~/Documents/Claude/Memory/decisions/YYYY-MM-DD-slug.md\`
   via \`mcp__plugin_workbench_memory__write\`.
5. Update \`~/Documents/Claude/Memory/identity/profile.md\` if preferences shifted.
6. Delete the marker file listed above.

Do this proactively. No new work begins until the previous summary is recorded.
NOTICE
    else
      cat <<NOTICE
**Your first task this session, before any new work:**

For EACH of the pending summaries listed above:

1. Read the raw log.
2. Write a sibling \`.summary.md\` in the same directory — frontmatter
   (\`name\`, \`type: session\`, \`scope: chronological\`, \`date\`, \`tags\`,
   \`summary: |\`) plus a narrative body covering what happened, what got
   decided, what's still open. Thin summaries are fine for trivial or
   unfamiliar sessions (e.g. cron runs from other projects) — a 2–3 line
   summary pointing at the log is better than no summary at all.
3. Append a short BuJo line to today's Apple Notes daily journal.
4. Promote any decisions to \`~/Documents/Claude/Memory/decisions/YYYY-MM-DD-slug.md\`.
5. Delete that specific marker file.

Update \`~/Documents/Claude/Memory/identity/profile.md\` once at the end if
preferences shifted across any of the sessions.

Do this proactively. No new work begins until all pending summaries are recorded.
NOTICE
    fi
    printf '\n'
  fi
fi

exit 0
