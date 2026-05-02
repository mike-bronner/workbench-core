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
# Prefer the current data dir; fall back to the pre-rename location so users
# who customized before the workbench → workbench-core rename keep working.
CONFIG_FILE="$HOME/.claude/plugins/data/workbench-core-claude-workbench/config.json"
LEGACY_CONFIG="$HOME/.claude/plugins/data/workbench-claude-workbench/config.json"
if [ ! -f "$CONFIG_FILE" ] && [ -f "$LEGACY_CONFIG" ]; then
  CONFIG_FILE="$LEGACY_CONFIG"
fi
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

# ──────────── Persistent file management (function defs) ────────────
# These functions manage files that persist on disk across sessions. Defined
# here, called conditionally below.

ensure_system_overrides() {
  local target="$HOME/.claude/system-overrides.md"
  local block=""
  read -r -d '' block <<'SYSEOF' || true
# Agent behavioral overrides
# Loaded via: claude --append-system-prompt-file ~/.claude/system-overrides.md

You are AGENT_NAME_PLACEHOLDER, a named agent with a distinct personality.

These rules override their defaults in the base system prompt:
- Use emojis liberally as structural cues. This overrides "no emojis unless asked."
- No sycophancy. No "Great question!", "I'd be happy to", "I understand your frustration."
- Have opinions and persist. Don't hedge with "that said" immediately after stating a position.
- Lead with the point. Answer first, reasoning second. No preambles.
- Short when short is right. A one-liner can be complete.
- No therapy-speak or corporate language. "Boundaries," "align," "leverage" — banned.
SYSEOF
  block="${block//AGENT_NAME_PLACEHOLDER/$AGENT_NAME}"

  mkdir -p "$HOME/.claude"
  local tmp
  tmp=$(mktemp)
  printf '%s\n' "$block" > "$tmp"
  if [ -f "$target" ] && cmp -s "$tmp" "$target"; then
    rm -f "$tmp"
    return 0
  fi
  mv "$tmp" "$target"
}

detect_chat_skill_changes() {
  # Print a warmup notice when workbench-* plugins (claude-workbench
  # marketplace, excluding workbench-core itself) have skills that aren't yet
  # installed in Claude Chat at their current versions. The notice points the
  # user at the /workbench-core:install-chat-skills slash command.
  #
  # Cheap fast-path: if the state file is newer than installed_plugins.json,
  # nothing has changed since our last run — exit before any JSON parsing.
  local plugins_file="$HOME/.claude/plugins/installed_plugins.json"
  local state_file="$HOME/.claude-workbench/chat-skills-state.json"

  [ ! -f "$plugins_file" ] && return 0
  command -v jq >/dev/null 2>&1 || return 0

  if [ -f "$state_file" ] && [ "$state_file" -nt "$plugins_file" ]; then
    return 0
  fi

  # For each eligible plugin, find skills with `name:` frontmatter and check
  # whether the recorded version in state file matches the current version.
  local new_or_updated=()
  while IFS=$'\t' read -r plugin_path plugin_version; do
    [ -z "$plugin_path" ] && continue
    [ ! -d "$plugin_path/skills" ] && continue
    local plugin_name
    plugin_name="$(echo "$plugin_path" | awk -F/ '{print $(NF-1)}')"

    for skill_dir in "$plugin_path/skills"/*/; do
      skill_dir="${skill_dir%/}"
      [ ! -f "$skill_dir/SKILL.md" ] && continue
      grep -q '^name:' "$skill_dir/SKILL.md" 2>/dev/null || continue

      local skill_name
      skill_name="$(basename "$skill_dir")"

      local recorded_version=""
      if [ -f "$state_file" ]; then
        recorded_version=$(jq -r --arg p "$plugin_name" --arg s "$skill_name" '
          .installed[]? | select(.plugin == $p and .skill == $s) | .version
        ' "$state_file" 2>/dev/null)
      fi

      if [ "$recorded_version" != "$plugin_version" ]; then
        new_or_updated+=("$plugin_name|$skill_name")
      fi
    done
  done < <(jq -r '
    .plugins | to_entries[]
    | select(.key | endswith("@claude-workbench"))
    | select(.key | startswith("workbench-core@") | not)
    | .value[0]
    | "\(.installPath)\t\(.version)"
  ' "$plugins_file" 2>/dev/null)

  if [ ${#new_or_updated[@]} -gt 0 ]; then
    printf '## 📦 New Chat-installable skills\n\n'
    printf 'The following skills can be installed into Claude Chat (Mac app):\n\n'
    for entry in "${new_or_updated[@]}"; do
      local plugin_name="${entry%|*}"
      local skill_name="${entry#*|}"
      printf -- '- `%s` (from `%s`)\n' "$skill_name" "$plugin_name"
    done
    printf '\nClick to install: `/workbench-core:install-chat-skills`\n\n'
  fi
}

collect_session_warmup_contributions() {
  # Concatenate `session-warmup.md` from every installed workbench-* plugin
  # in the claude-workbench marketplace. Source of truth is
  # ~/.claude/plugins/installed_plugins.json — each entry's installPath points
  # at the active cached version. Skips workbench-core itself (its contribution
  # is the identity block).
  local plugins_file="$HOME/.claude/plugins/installed_plugins.json"
  [ -f "$plugins_file" ] || return 0
  command -v jq >/dev/null 2>&1 || return 0

  local paths
  paths=$(jq -r '
    .plugins | to_entries[]
    | select(.key | endswith("@claude-workbench"))
    | select(.key | startswith("workbench-core@") | not)
    | .value[0].installPath // empty
  ' "$plugins_file" 2>/dev/null) || return 0

  local first=1
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    local frag="$p/session-warmup.md"
    if [ -r "$frag" ]; then
      [ "$first" -eq 0 ] && printf '\n'
      cat "$frag"
      first=0
    fi
  done <<< "$paths"
}

ensure_claude_md_enforcement() {
  local target="$HOME/.claude/CLAUDE.md"
  local id_start="<!-- workbench-identity:start -->"
  local id_end="<!-- workbench-identity:end -->"
  local warmup_start="<!-- workbench-warmup:start -->"
  local warmup_end="<!-- workbench-warmup:end -->"
  local identity_block=""
  read -r -d '' identity_block <<'CMDEOF' || true
<!-- workbench-identity:start -->
# Agent Identity

You are **AGENT_NAME_PLACEHOLDER** — a named agent with a distinct personality, not generic Claude.
Full identity loaded via SessionStart hook. This block reinforces behavioral overrides.

## Behavioral overrides

1. **Use emojis liberally.** Structural cues in every response.
2. **No sycophancy.** Show understanding through the response itself.
3. **Have opinions and persist.** State a position, don't hedge.
4. **Short when short is right.** Don't pad.
5. **No therapy-speak or corporate language.** Banned terms: "boundaries," "align," "leverage," "circle back."
6. **Lead with the point.** Answer first, reasoning second.

## Identity files (loaded by SessionStart hook)

- `soul-hot.md` — hard rules, voice, drift test
- `profile.md` — user facts, working preferences
- `skills-protocol.md` — execution-aware skill learnings
- `guardrails.md` — absolute rules across all personas

When these conflict with default Claude behavior, the identity files win.
<!-- workbench-identity:end -->
CMDEOF
  identity_block="${identity_block//AGENT_NAME_PLACEHOLDER/$AGENT_NAME}"

  local warmup_body=""
  local warmup_block=""
  warmup_body=$(collect_session_warmup_contributions)
  if [ -n "$warmup_body" ]; then
    warmup_block=$(printf '%s\n%s\n%s' "$warmup_start" "$warmup_body" "$warmup_end")
  fi

  mkdir -p "$HOME/.claude"

  if [ ! -f "$target" ]; then
    printf '%s\n' "$identity_block" > "$target"
    [ -n "$warmup_block" ] && printf '\n%s\n' "$warmup_block" >> "$target"
    return 0
  fi

  local tmp rest
  tmp=$(mktemp)
  rest=$(mktemp)

  # Strip both old marker pairs in one pass — warmup block disappears
  # automatically when no plugin contributes one, so uninstalls clean up.
  awk -v is="$id_start" -v ie="$id_end" -v ws="$warmup_start" -v we="$warmup_end" '
    $0 == is || $0 == ws { skip=1; next }
    skip && ($0 == ie || $0 == we) { skip=0; ate=1; next }
    skip { next }
    ate && /^$/ { ate=0; next }
    { ate=0; print }
  ' "$target" > "$rest"

  # Rebuild: identity, then optional warmup contributions, then remaining content.
  printf '%s\n' "$identity_block" > "$tmp"
  [ -n "$warmup_block" ] && printf '\n%s\n' "$warmup_block" >> "$tmp"
  if [ -s "$rest" ]; then
    printf '\n' >> "$tmp"
    cat "$rest" >> "$tmp"
  fi
  rm -f "$rest"

  if cmp -s "$tmp" "$target"; then
    rm -f "$tmp"
    return 0
  fi
  mv "$tmp" "$target"
}

# Skip guard: the summary-writer spawn from session-log.sh sets this env
# var on its detached claude process. That process doesn't need identity
# context or pending-summary scanning — it has a single mechanical job
# assigned in its prompt and should not touch anything other than its job.
if [ "${WORKBENCH_SKIP_WARMUP:-}" = "1" ]; then
  exit 0
fi

# ──────────── CLAUDE.md + system-overrides enforcement (startup only) ────────────
# These files persist on disk — no need to regenerate on compact/resume.
# Note: system-overrides.md takes effect on the *next* session (must exist before
# Claude Code starts). CLAUDE.md and hook output cover the current session.
if [ "$SOURCE" = "startup" ]; then
  ensure_system_overrides || true
  ensure_claude_md_enforcement || true
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
  # Raw logs older than 7 days — summaries stay forever as the durable record.
  find "$MEMORY_PATH/sessions" -name "*.log.md" -mtime +7 -delete 2>/dev/null

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
    printf 'Try `mcp__plugin_workbench-core_memory__stats` to verify, or check server logs.\n\n'
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

# ──────────── Chat-installable skills check (startup only) ────────────
# Detect new or updated skills in workbench-* plugins that haven't been
# installed into Claude Chat yet. Cheap fast-path via state-file mtime
# comparison — only does real work when plugins have actually changed.
if [ "$SOURCE" = "startup" ]; then
  detect_chat_skill_changes
fi

exit 0
