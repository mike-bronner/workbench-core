#!/usr/bin/env bash
#
# session-warmup: inject identity essentials at session start.
#
# Invoked by the `core` plugin's SessionStart hook. Reads the hook payload from
# stdin, writes identity + pending-wrap notice to stdout for Claude Code to
# inject into the assistant's context.
#
# Branches on the payload's `source` (or legacy `how`) field:
#   startup → full warmup: identity + pending-wrap check
#   resume  → minimal: pending-wrap check only (identity already in context)
#   clear   → identity only (a clear follows a wrap, so skip pending-wrap)
#   compact → no-op (context just got compressed, don't add more)
#
# Exit code is always 0 — warmup failures must not break the session.

set -u

# TODO: move to userConfig once the plugin system supports directory prompts.
MEMORY_PATH="${HOBBES_MEMORY_PATH:-/Users/mike/Documents/Claude/Memory}"
CACHE_PATH="${HOBBES_MEMORY_CACHE:-$HOME/.claude-memory-cache}"
PENDING_WRAP="$CACHE_PATH/pending-wrap.json"

# Read hook payload from stdin. May be empty if invoked outside a hook.
PAYLOAD=""
if [ ! -t 0 ]; then
  PAYLOAD=$(cat)
fi

# Extract source / how. Default to "startup" so manual runs act like a full warmup.
SOURCE="startup"
if [ -n "$PAYLOAD" ] && command -v jq >/dev/null 2>&1; then
  SOURCE=$(printf '%s' "$PAYLOAD" | jq -r '.source // .how // "startup"' 2>/dev/null || echo "startup")
fi

# compact → no-op. We just shed context; adding more is counter-productive.
if [ "$SOURCE" = "compact" ]; then
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

# Pending-wrap check: skip on `clear` since clear follows a just-completed wrap.
if [ "$SOURCE" != "clear" ] && [ -f "$PENDING_WRAP" ]; then
  printf '## ⚠ Pending session wrap\n\n'
  printf 'The previous session ended (or compacted) without a narrative summary.\n'
  printf 'The raw log is already on disk at:\n\n'

  LOG_PATH=""
  if command -v jq >/dev/null 2>&1; then
    LOG_PATH=$(jq -r '.log_path // empty' "$PENDING_WRAP" 2>/dev/null)
  fi
  if [ -n "$LOG_PATH" ]; then
    printf -- '- `%s`\n\n' "$LOG_PATH"
  else
    printf '_(could not parse pending-wrap.json; open it at %s)_\n\n' "$PENDING_WRAP"
  fi

  cat <<'NOTICE'
**Your first task this session, before any new work:**

1. Read the raw log above.
2. Write a sibling `.summary.md` in the same directory — frontmatter
   (`name`, `type: session`, `scope: chronological`, `date`, `tags`,
   `summary: |`) plus a narrative body covering what happened, what got
   decided, what's still open.
3. Append a short BuJo line to today's Apple Notes daily journal
   (`mcp__Read_and_Write_Apple_Notes__update_note_content`). Pointer to
   the log/summary path so Mike can open the detail.
4. Promote any decisions to `~/Documents/Claude/Memory/decisions/YYYY-MM-DD-slug.md`
   via the `hobbes-memory` MCP.
5. Update `~/Documents/Claude/Memory/identity/profile.md` if preferences shifted.
6. Delete the marker: `rm ~/.claude-memory-cache/pending-wrap.json`.

Do this proactively. No new work begins until the previous wrap is recorded.
NOTICE
  printf '\n'
fi

exit 0
