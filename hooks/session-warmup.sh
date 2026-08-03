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
#   startup → full warmup: cleanup + identity + notices refresh
#   resume  → identity refresh (profile as pointer) + notices refresh
#   clear   → identity refresh + notices refresh
#   compact → identity refresh only (profile as pointer)
#
# The injected payload is BYTE-STABLE by construction: all volatile housekeeping
# state goes to ~/.claude-workbench/warmup-notices.md and is surfaced by a
# constant pointer line. See the append-only invariant at the guardrails block.
#
# Exit code is always 0 — warmup failures must not break the session.

set -u

# Resolve the launcher's own directory so we can source shared libraries
# regardless of how the script is invoked. Honor CLAUDE_PLUGIN_ROOT (set by
# Claude Code's hook host) when present, fall back to a BASH_SOURCE-relative
# path so manual and test invocations still locate hooks/lib.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/hooks}"
HOOKS_DIR="${HOOKS_DIR:-$SCRIPT_DIR}"

# Memory path/cache come from the shared resolver (precedence: WORKBENCH_*
# override → config.json → default). It also exports the full MARKDOWN_VAULT_MCP_*
# set, harmless here. memory_load_env sets MEMORY_PATH and CACHE_PATH, both used
# below. memory-probe.sh is deliberately NOT sourced any more: the shared-server
# health check was disabled when the memory transport reverted to per-session
# stdio (v0.13.0) — there is no external server to probe. See the breadcrumb
# where that block used to live, further down.
# shellcheck source=hooks/lib/memory-env.sh
. "$HOOKS_DIR/lib/memory-env.sh"
memory_load_env

# Config resolution for warmup-only fields (agent_name, identity_files).
# Prefer the current data dir; fall back to the pre-rename location so users
# who customized before the workbench → workbench-core rename keep working.
CONFIG_FILE="$(memory_resolve_config_file)"
_cfg() { [ -f "$CONFIG_FILE" ] && command -v jq >/dev/null 2>&1 && jq -r "$1 // empty" "$CONFIG_FILE" 2>/dev/null; }

# Validate config.json if it exists — a malformed file silently falls back to
# hardcoded defaults, which point to the wrong directories.
if [ -f "$CONFIG_FILE" ] && command -v jq >/dev/null 2>&1; then
  if ! jq empty "$CONFIG_FILE" 2>/dev/null; then
    CONFIG_BROKEN=1
  fi
fi

PENDING_SUMMARIES_DIR="$CACHE_PATH/pending-summaries"
CHECKPOINTS_DIR="$CACHE_PATH/log-checkpoints"
AGENT_NAME="$(_cfg '.agent_name')"
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
  # PostCompact payloads carry `trigger` (manual|auto) instead of `source`.
  # Without this mapping they fall through to a FULL startup warmup right
  # after the context was compressed — route them to the compact branch.
  HOOK_EVENT=$(printf '%s' "$PAYLOAD" | jq -r '.hook_event_name // empty' 2>/dev/null)
  [ "$HOOK_EVENT" = "PostCompact" ] && SOURCE="compact"
fi

# ──────────── Persistent file management (function defs) ────────────
# These functions manage files that persist on disk across sessions. Defined
# here, called conditionally below.

# Single source for the behavioral-overrides text. Layer 1
# (~/.claude/system-overrides.md, system-prompt tier, CLI only) and layer 2
# (the managed block in ~/.claude/CLAUDE.md, user-message tier, everywhere)
# are separate authority tiers by design — see the README layer table — so each
# still ends up with the rules FULLY INLINED, never a pointer: both files are
# read later, by the CLI and the model, against a version-pinned plugin path
# that may no longer be live. What converges is only the hook's source for what
# it writes. Reading it here is safe precisely because the hook runs fresh at
# every session start, when CLAUDE_PLUGIN_ROOT is current.
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
BEHAVIORAL_OVERRIDES_SRC="$PLUGIN_ROOT/references/behavioral-overrides.md"

render_behavioral_overrides() {
  # Print the shared overrides block with the agent name substituted.
  # FAILS CLOSED: returns non-zero when the shipped source is unreadable or
  # empty, so callers leave their destination file exactly as it is. Stale
  # good content beats a truncated or blanked identity block.
  [ -r "$BEHAVIORAL_OVERRIDES_SRC" ] || return 1
  local body
  body="$(cat "$BEHAVIORAL_OVERRIDES_SRC")" || return 1
  [ -n "$body" ] || return 1
  printf '%s' "${body//AGENT_NAME_PLACEHOLDER/$AGENT_NAME}"
}

ensure_system_overrides() {
  local target="$HOME/.claude/system-overrides.md"
  local overrides
  overrides="$(render_behavioral_overrides)" || return 1

  local block=""
  read -r -d '' block <<'SYSEOF' || true
# Agent identity
# Loaded via: claude --append-system-prompt-file ~/.claude/system-overrides.md

BEHAVIORAL_OVERRIDES_PLACEHOLDER
SYSEOF
  block="${block//BEHAVIORAL_OVERRIDES_PLACEHOLDER/$overrides}"

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
  local overrides
  overrides="$(render_behavioral_overrides)" || return 1

  local identity_block=""
  read -r -d '' identity_block <<'CMDEOF' || true
<!-- workbench-identity:start -->
# Agent Identity

BEHAVIORAL_OVERRIDES_PLACEHOLDER

## Identity files (loaded by SessionStart hook)

- `soul-hot.md` — hard rules, voice, drift test
- `profile.md` — user facts, working preferences
- `skills-protocol.md` — execution-aware skill learnings
- `guardrails.md` — absolute rules across all personas

When these conflict with default Claude behavior, the identity files win.
<!-- workbench-identity:end -->
CMDEOF
  identity_block="${identity_block//BEHAVIORAL_OVERRIDES_PLACEHOLDER/$overrides}"

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

ensure_memory_routing_stub() {
  # Neutralize the harness's per-project memory channel. Claude Code's system
  # prompt tells every session to save memories under
  # ~/.claude/projects/<encoded-cwd>/memory/ + MEMORY.md — the vault must stay
  # canonical, so MEMORY.md becomes a router stub pointing at the memory MCP.
  # The encoded dir name is the project cwd with "/" replaced by "-".
  local marker="<!-- workbench-memory-router -->"
  local template="${CLAUDE_PLUGIN_ROOT:-}/references/memory-routing-stub.md"
  [ -r "$template" ] || return 0

  local encoded memory_dir target
  encoded="${PWD//\//-}"
  memory_dir="$HOME/.claude/projects/$encoded/memory"
  target="$memory_dir/MEMORY.md"

  if [ -f "$target" ]; then
    if ! grep -qF "$marker" "$target" 2>/dev/null; then
      # Unmanaged content — a human or migration owns this file. Never
      # overwrite; flag it in the warmup output instead (printed after the
      # header, since this runs before the first printf).
      MEMORY_ROUTING_CONFLICT="$target"
      return 0
    fi
    # Marker present — ours to manage. Refresh only if drifted from template.
    cmp -s "$template" "$target" && return 0
  fi

  mkdir -p "$memory_dir" 2>/dev/null || return 0
  cp "$template" "$target" 2>/dev/null || true
}

# Skip guard: the summary-writer spawn from session-log.sh sets this env
# var on its detached claude process. That process doesn't need identity
# context or pending-summary scanning — it has a single mechanical job
# assigned in its prompt and should not touch anything other than its job.
if [ "${WORKBENCH_SKIP_WARMUP:-}" = "1" ]; then
  exit 0
fi

# Skip guard: Claude Code sets this env var on every sub-agent dispatch
# (Watson, Holmes-reviewer, Lestrade, Harvester — and any future agent
# from any plugin). Those runs carry self-contained system prompts and
# must not inherit the interactive "Holmes" identity this warmup injects:
# its guardrail #1 ("present options before making changes") directly
# conflicts with autonomous, unattended pipeline work — Watson dispatched
# via cron has no human present to answer it. Orchestrator/Dispatch and
# Mike's own interactive sessions run without --agent, leave this unset,
# and are unaffected.
if [ -n "${CLAUDE_CODE_AGENT:-}" ]; then
  exit 0
fi

# ──────────── CLAUDE.md + system-overrides enforcement (startup only) ────────────
# These files persist on disk — no need to regenerate on compact/resume.
# Note: system-overrides.md takes effect on the *next* session (must exist before
# Claude Code starts). CLAUDE.md and hook output cover the current session.
if [ "$SOURCE" = "startup" ]; then
  ensure_system_overrides || true
  ensure_claude_md_enforcement || true
  ensure_memory_routing_stub || true
fi

printf '# %s session warmup (%s)\n\n' "$AGENT_NAME" "$SOURCE"

# ──────────── Config validation warning ────────────
if [ "${CONFIG_BROKEN:-}" = "1" ]; then
  printf '## ⚠ Malformed config.json\n\n'
  printf '`%s` exists but is not valid JSON.\n' "$CONFIG_FILE"
  printf 'All settings are falling back to hardcoded defaults, which may point to wrong directories.\n'
  printf 'Run `/workbench:setup` to regenerate the config, or fix the JSON manually.\n\n'
fi

# ──────────── Memory-routing stub conflict warning ────────────
if [ -n "${MEMORY_ROUTING_CONFLICT:-}" ]; then
  printf '⚠ Harness `MEMORY.md` at `%s` has unmanaged content — left untouched; migrate it to the vault, then delete it so the router stub can take over.\n\n' "$MEMORY_ROUTING_CONFLICT"
fi

# ──────────── Retention cleanup (startup only) ────────────
# Prune stale artifacts on full warmup. Runs before identity injection so it
# doesn't add latency to the user-visible part of startup. All find commands
# are fire-and-forget (-delete exits silently on no matches).
if [ "$SOURCE" = "startup" ]; then
  # Raw logs older than 7 days — summaries stay forever as the durable record.
  # A log whose session still has a pending-summary marker is NOT deleted:
  # the marker means summarization is outstanding, and the summary-writer
  # cannot run without the log. Markers are removed on summary (or deliberate
  # skip), which re-arms normal deletion.
  while IFS= read -r OLD_LOG; do
    [ -n "$OLD_LOG" ] || continue
    OLD_SID=$(basename "$OLD_LOG" .log.md)
    if [ -f "$PENDING_SUMMARIES_DIR/$OLD_SID.json" ]; then
      continue
    fi
    # Manual logs carry suffixes, so the basename may not be the session id —
    # a marker referencing the exact log path also protects it.
    if [ -d "$PENDING_SUMMARIES_DIR" ] && \
       grep -qF "\"$OLD_LOG\"" "$PENDING_SUMMARIES_DIR"/*.json 2>/dev/null; then
      continue
    fi
    rm -f "$OLD_LOG" 2>/dev/null
  done < <(find "$MEMORY_PATH/sessions" -name "*.log.md" -mtime +7 2>/dev/null)

  # Per-session checkpoint files older than 7 days — sessions don't resume.
  [ -d "$CHECKPOINTS_DIR" ] && find "$CHECKPOINTS_DIR" -name "*.json" -mtime +7 -delete 2>/dev/null

  # Legacy summary-writer logs — no longer generated, clean up any remaining.
  find "$CACHE_PATH" -name "summary-writer-*.log" -delete 2>/dev/null
fi

# ──────────── Memory server health check — disabled (per-session stdio) ────────
# A shared-HTTP health probe lived here through v0.12: it ran memory_probe and
# surfaced port-drift / conflict / failed / starting notices for the lazy-started
# shared server. It was removed in v0.13.0 when the transport reverted to a
# per-session stdio server: stdio spawns the server in-process per session, so
# there is NO external listener to probe — the probe returned DOWN_NONE every
# startup and printed a phantom "Memory server starting" notice. The MCP host's
# own connect error is the real signal for a broken stdio launcher now.
#
# To RE-ENABLE the shared HTTP server, restore this block and the memory-probe.sh
# source near the top of this file (both are in git history), re-add the
# memory-server-up.sh SessionStart hook in hooks/hooks.json, and switch
# plugin.json's memory MCP back to the http transport. See README, section
# "Memory server transport — re-enabling the shared HTTP server (optional)".

# ──────────── Identity injection (source-aware) ────────────
# Guardrails and soul-hot are re-injected on every source: after context
# compression (compact) the identity may have been shed; on resume it may have
# drifted. The full profile (~4KB) only loads when the context is genuinely
# fresh (startup, clear) — compact and resume get a one-line pointer and
# re-read on demand. skills-protocol is execution-time guidance that skills
# re-read when they run, so every source gets a pointer.
#
# Paths resolve from config.json identity_files, falling back to hardcoded defaults.
SOUL_HOT_REL="$(_cfg '.identity_files.soul_hot')"
SOUL_HOT="$MEMORY_PATH/${SOUL_HOT_REL:-identity/soul-hot.md}"
PROFILE_REL="$(_cfg '.identity_files.profile')"
PROFILE="$MEMORY_PATH/${PROFILE_REL:-identity/profile.md}"
SKILLS_PROTOCOL="$MEMORY_PATH/identity/skills-protocol.md"
GUARDRAILS_INLINE="${CLAUDE_PLUGIN_ROOT}/references/guardrails-inline.md"

# Guardrails first — absolute rules must always sit in the inline preview
# window, even when the rest of the warmup output overflows to a persisted
# file. Sourced from the condensed -inline copy; full text with examples
# stays at references/guardrails.md for re-read on demand.
#
# APPEND-ONLY INVARIANT (cache-prefix stability). Everything printed from the
# top of this script through the end of the identity payload below must be
# BYTE-STABLE across invocations: identical config, identical identity files →
# identical bytes. Anthropic prompt caching matches on an exact request prefix,
# so a single drifting byte up here invalidates the cache for the entire rest
# of the prompt — the identity payload, every plugin's contributions, the
# skill body, and the tool definitions. Any block whose content varies run to
# run (a live file count, a wall-clock-triggered flag, a directory listing)
# therefore APPENDS after this section, never precedes it. See the
# stray-summary, recall-liveness, pending-summary, and chat-skills blocks
# below for the pattern.
if [ -r "$GUARDRAILS_INLINE" ]; then
  printf '## Guardrails — absolute rules\n\n'
  cat "$GUARDRAILS_INLINE"
  printf '\n\n'
fi

# Memory routing — countermand the harness's per-project memory instructions.
# Re-injected on every source so the rule survives compaction. This is the
# always-on FLOOR for the capture rule; hooks/memory-capture-nudge.sh
# (UserPromptSubmit) reinforces it per-turn when a turn looks capture-worthy,
# so the rule keeps its salience deep into a long session.
printf '## Memory routing\n\n'
printf -- '- The workbench memory vault is the CANONICAL durable memory store, served by the `memory` MCP (`mcp__plugin_workbench-core_memory__search` / `write` / etc.).\n'
printf -- '- When the harness'\''s memory instructions prompt a save, write to the VAULT instead: MCP `write` with frontmatter `name` + `type` (decision | insight | project | feedback | reference) plus tags/summary/date per vault conventions.\n'
printf -- '- Proactively CAPTURE durable knowledge without asking: a decision (+ rationale), a troubleshooting root-cause, a design choice and the options weighed, a non-obvious insight or gotcha, a project/plan outcome, or feedback on how to work — `write` it to the vault immediately with the correct `type`, then note the save in one line. This is standing authorization; memory-capture writes are EXEMPT from the "present options / confirm before changes" rule. Do NOT ask first.\n'
printf -- '- Before saving, `search` for an existing memory to UPDATE rather than duplicate. Skip the trivial: routine code edits, facts already in the repo or git, ephemeral chatter. Capture what would otherwise be a "by the way, should I remember this?".\n'
printf -- '- The per-project memory directory and its MEMORY.md are a router only — never create memory files there.\n'
printf -- '- Recall = vault `search` (mode hybrid), not directory reads.\n\n'

if [ -r "$SOUL_HOT" ]; then
  printf '## Identity — soul-hot\n\n'
  cat "$SOUL_HOT"
  printf '\n\n'
else
  printf '_(soul-hot.md not found at %s)_\n\n' "$SOUL_HOT"
fi

case "$SOURCE" in
  startup|clear)
    if [ -r "$PROFILE" ]; then
      printf '## User profile\n\n'
      cat "$PROFILE"
      printf '\n\n'
    else
      printf '_(profile.md not found at %s)_\n\n' "$PROFILE"
    fi
    ;;
  *)
    if [ -r "$PROFILE" ]; then
      printf -- '- User profile: re-read `%s` when user facts or working preferences matter.\n\n' "$PROFILE"
    fi
    ;;
esac

if [ -r "$SKILLS_PROTOCOL" ]; then
  printf -- '- Skills protocol: read `%s` before executing workbench skills.\n\n' "$SKILLS_PROTOCOL"
fi

# ──────────── VOLATILE NOTICES — written to a file, never injected ────────────
# Every block below varies run to run: a live file count, a wall-clock flag, a
# marker-directory listing, a plugin-version diff. Injecting any of them makes
# the warmup output drift between otherwise identical sessions, which breaks
# prompt-cache reuse for the ENTIRE prompt downstream of it — the ~36k-token
# tail of a scheduled Dispatch tick never cached for exactly this reason.
#
# So they are PULLED, not PUSHED: collected into $NOTICES_FILE and surfaced by
# a pointer line whose bytes never change. The warmup payload is therefore
# byte-stable for every session type — interactive, sub-agent, or scheduled —
# without the hook needing to detect which kind of fire this is (no such signal
# exists at SessionStart — see README, "Housekeeping notices — pulled, not
# pushed", for what was checked and ruled out).

collect_warmup_notices() {
# ──────────── Stray project-dir summary detector (startup only) ────────────
# Session summaries belong in the vault, never in a project. A misrouted
# summary-writer (see the summary-misroute fix) could leave *.summary.md under
# the project's memory/ or .claude/memory* dirs. Surface any so a silent
# misroute becomes visible and can be relocated to the vault. Skip when the
# session cwd IS the vault (its sessions/ summaries are legitimate).
if [ "$SOURCE" = "startup" ] && [ "${PWD#"$MEMORY_PATH"}" = "$PWD" ]; then
  STRAY_SUMMARIES=$(find "$PWD/memory" "$PWD/.claude/memory" "$PWD/.claude/memory-vault" \
    -name "*.summary.md" 2>/dev/null | head -20)
  if [ -n "$STRAY_SUMMARIES" ]; then
    STRAY_COUNT=$(printf '%s\n' "$STRAY_SUMMARIES" | grep -c .)
    printf '## ⚠ Stray session summaries in this project (%s)\n\n' "$STRAY_COUNT"
    printf 'These `.summary.md` files are in the project, not the memory vault — a misrouted summary-writer left them here. Relocate them into `%s/sessions/` via the memory MCP, then delete the empty project dirs:\n\n' "$MEMORY_PATH"
    while IFS= read -r stray; do
      [ -n "$stray" ] && printf -- '- `%s`\n' "$stray"
    done <<< "$STRAY_SUMMARIES"
    printf '\n'
  fi
fi

# ──────────── Recall-hook liveness check (startup only) ────────────
# memory-recall.sh stamps last-attempt on every substantive prompt. A stamp
# that exists but is >48h old means the hook stopped firing — a silent recall
# death is otherwise invisible. No stamp at all = fresh install; stay quiet.
if [ "$SOURCE" = "startup" ]; then
  RECALL_STAMP="${WORKBENCH_MEMORY_RECALL_STATE:-$HOME/.claude-workbench/memory-recall}/last-attempt"
  if [ -f "$RECALL_STAMP" ] && [ -z "$(find "$RECALL_STAMP" -mtime -2 2>/dev/null)" ]; then
    printf '## ⚠ Memory recall may be dead\n\n'
    printf 'The proactive recall hook last attempted a search more than 48h ago.\n'
    printf 'Check hook registration and the memory server: `/workbench-core:memory-status`.\n\n'
  fi
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
    # Count + the 3 oldest only. The drain skill rescans the marker directory
    # itself, so the listing is purely informational — enumerating every
    # marker once bloated the warmup to 57KB, overflowed the harness's inline
    # window, and buried the identity payload (2026-07-08 audit).
    OLDEST_SIDS=$(ls -tr "$PENDING_SUMMARIES_DIR"/*.json 2>/dev/null | head -3 \
      | sed 's|.*/||; s|\.json$||' | paste -sd ',' -)
    printf 'Previous sessions ended without narrative summaries.\n\n'
    printf -- '- oldest first: `%s`\n' "${OLDEST_SIDS:-unparsable}"
    printf -- '- marker directory: `%s`\n\n' "$PENDING_SUMMARIES_DIR"

    cat <<NOTICE
**Run \`/workbench-core:process-pending-summaries\` to handle these in the background.**
Do NOT block the session — the skill dispatches agents and returns immediately.

If the skill is unavailable, note the pending summaries and move on.
They will be picked up by the next session or manual \`/workbench-core:log-now\`.
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
}

# Collect, then persist. The file is rewritten every run — including when there
# is nothing to report, so a stale notice from a previous session can never
# masquerade as current. A write failure is not fatal (warmup never breaks a
# session), but it must not leave the pointer promising a file that is missing
# or stale: on failure the pointer is suppressed, which is the only branch here
# that changes the injected bytes, and it only fires when the filesystem is
# already broken.
NOTICES_FILE="$HOME/.claude-workbench/warmup-notices.md"
NOTICES="$(collect_warmup_notices)"
NOTICES_WRITTEN=0
if mkdir -p "$(dirname "$NOTICES_FILE")" 2>/dev/null; then
  if {
    printf '# Warmup notices\n\n'
    printf '_Written by session-warmup.sh at %s session start. Rewritten every run._\n\n' "$SOURCE"
    if [ -n "$NOTICES" ]; then
      printf '%s\n' "$NOTICES"
    else
      printf 'No outstanding notices.\n'
    fi
  } > "$NOTICES_FILE" 2>/dev/null; then
    NOTICES_WRITTEN=1
  fi
fi

# The pointer. These bytes are IDENTICAL on every run — no count, no per-session
# path, no conditional phrasing. That is the whole point: the notices change
# constantly, this line never does.
#
# The instruction is UNCONDITIONAL on purpose. The push version this replaced
# said "Run /workbench-core:process-pending-summaries" flat out; a pointer that
# said "read this if housekeeping seems relevant" would be strictly weaker,
# because deciding relevance is exactly what the agent cannot do before reading.
# Pull-not-push is a transport change, not a licence to make the instruction
# softer.
if [ "$NOTICES_WRITTEN" = "1" ]; then
  printf '## Session health notices\n\n'
  # Deliberately paraphrased rather than echoing each notice's own heading: a
  # heading repeated here would read as the notice itself having fired.
  printf -- '- Read `%s` at the start of this session. It may list items that require action — summaries waiting to be drained, summaries misrouted into this project, a recall hook that has stopped firing, Chat skill installs.\n' "$NOTICES_FILE"
  printf -- '- The file is rewritten at every session start, so it is always current. This pointer is constant by design: the notices live in the file so the warmup payload stays byte-stable and cacheable.\n\n'
fi

exit 0
