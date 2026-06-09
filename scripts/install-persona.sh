#!/usr/bin/env bash
#
# install-persona.sh — propagate a shipped persona from the installed plugin
# into the live locations Claude Code loads identity from.
#
# A persona is a directory at assets/personas/<name>/ containing any of:
#   soul-hot.md      → $MEMORY_PATH/identity/soul-hot.md   (vault, context layer)
#   soul-core.md     → $MEMORY_PATH/identity/soul-core.md  (vault, context layer)
#   output-style.md  → ~/.claude/output-styles/<name>.md   (system-prompt layer)
# The output style's `name:` frontmatter is also written to
# ~/.claude/settings.json as .outputStyle (safe single-key jq merge).
#
# The plugin SHIPS the persona (read-only at runtime via CLAUDE_PLUGIN_ROOT);
# this script COPIES it to the user's editable live locations. Soul files are
# hand-editable, so a differing soul file is never overwritten without --force
# (the install-persona skill diffs + confirms first). The output style and the
# settings key are content-addressed idempotent writes.
#
# Usage:
#   install-persona.sh <name> [--dry-run] [--force]
#   install-persona.sh --set-output-style <StyleName> [--dry-run]
#
# Env overrides (for testing): WORKBENCH_MEMORY_PATH, WORKBENCH_SETTINGS_FILE,
# WORKBENCH_OUTPUT_STYLES_DIR.
#
# Exit codes: 0 ok/no-op · 1 preflight failure · 2 usage error.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$SCRIPT_DIR")}"

# Config resolution mirrors hooks/session-warmup.sh: env → config.json → default.
CONFIG_FILE="$HOME/.claude/plugins/data/workbench-core-claude-workbench/config.json"
LEGACY_CONFIG="$HOME/.claude/plugins/data/workbench-claude-workbench/config.json"
if [ ! -f "$CONFIG_FILE" ] && [ -f "$LEGACY_CONFIG" ]; then
  CONFIG_FILE="$LEGACY_CONFIG"
fi
# Always returns 0 — a missing config must fall back to defaults, not abort.
_cfg() {
  if [ -f "$CONFIG_FILE" ] && command -v jq >/dev/null 2>&1; then
    jq -r "$1 // empty" "$CONFIG_FILE" 2>/dev/null || true
  fi
}

MEMORY_PATH="${WORKBENCH_MEMORY_PATH:-$(_cfg '.memory_path')}"
MEMORY_PATH="${MEMORY_PATH:-$HOME/Documents/Claude/Memory}"
SETTINGS_FILE="${WORKBENCH_SETTINGS_FILE:-$HOME/.claude/settings.json}"
OUTPUT_STYLES_DIR="${WORKBENCH_OUTPUT_STYLES_DIR:-$HOME/.claude/output-styles}"

DRY_RUN=0
FORCE=0

if ! command -v jq >/dev/null 2>&1; then
  echo "❌ jq not installed. Install via: brew install jq"
  exit 1
fi

# Read the `name:` value from an output-style markdown's YAML frontmatter.
style_name() {
  awk '/^name:[[:space:]]/ { sub(/^name:[[:space:]]*/, ""); gsub(/"/, ""); print; exit }' "$1"
}

# Content-addressed install: copy src→dest only when different (or absent).
install_file() {
  local src="$1" dest="$2" label="$3"
  if [ -f "$dest" ] && cmp -s "$src" "$dest"; then
    echo "  ✓ $label already up to date"
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  ~ would write $label → $dest"
    return 0
  fi
  local tmp
  tmp="$(mktemp)"
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$tmp"
  mv "$tmp" "$dest"
  echo "  ✅ wrote $label → $dest"
}

# Soul install with an overwrite guard — hand-edited files are precious.
install_soul() {
  local src="$1" dest="$2" label="$3"
  if [ ! -f "$dest" ] || cmp -s "$src" "$dest"; then
    install_file "$src" "$dest" "$label"
    return 0
  fi
  if [ "$FORCE" -eq 1 ]; then
    install_file "$src" "$dest" "$label (overwritten)"
    return 0
  fi
  echo "  ⚠️  $label differs and was left unchanged. Diff (current → shipped):"
  diff -u "$dest" "$src" 2>/dev/null | sed 's/^/      /' || true
  echo "      Re-run with --force to overwrite, or merge by hand."
}

# Safe single-key set of .outputStyle — never rewrites the rest of settings.json.
set_output_style() {
  local value="$1" current=""
  if [ -f "$SETTINGS_FILE" ]; then
    current="$(jq -r '.outputStyle // empty' "$SETTINGS_FILE" 2>/dev/null || true)"
  fi
  if [ "$current" = "$value" ]; then
    echo "  ✓ settings.json outputStyle already \"$value\""
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  ~ would set settings.json outputStyle = \"$value\" (was \"${current:-unset}\")"
    return 0
  fi
  local tmp
  tmp="$(mktemp)"
  if [ -f "$SETTINGS_FILE" ]; then
    jq --arg v "$value" '.outputStyle = $v' "$SETTINGS_FILE" > "$tmp"
  else
    mkdir -p "$(dirname "$SETTINGS_FILE")"
    jq -n --arg v "$value" '{ outputStyle: $v }' > "$tmp"
  fi
  # Validate before replacing — never leave settings.json malformed.
  if ! jq empty "$tmp" 2>/dev/null; then
    rm -f "$tmp"
    echo "❌ Refusing to write — produced invalid JSON for settings.json"
    exit 1
  fi
  mv "$tmp" "$SETTINGS_FILE"
  echo "  ✅ settings.json outputStyle = \"$value\" (was \"${current:-unset}\")"
}

# ──────────── --set-output-style mode (used by define-soul) ────────────
if [ "${1:-}" = "--set-output-style" ]; then
  STYLE_NAME="${2:-}"
  if [ -z "$STYLE_NAME" ]; then
    echo "Usage: install-persona.sh --set-output-style <StyleName> [--dry-run]"
    exit 2
  fi
  if [ "${3:-}" = "--dry-run" ]; then
    DRY_RUN=1
  fi
  echo "🎨 Output style → \"$STYLE_NAME\""
  set_output_style "$STYLE_NAME"
  exit 0
fi

# ──────────── persona mode ────────────
PERSONA="${1:-}"
if [ -z "$PERSONA" ]; then
  echo "Usage: install-persona.sh <name> [--dry-run] [--force]"
  exit 2
fi
shift || true
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    *) echo "Unknown option: $arg"; exit 2 ;;
  esac
done

PERSONA_DIR="$PLUGIN_ROOT/assets/personas/$PERSONA"
if [ ! -d "$PERSONA_DIR" ]; then
  echo "❌ Persona '$PERSONA' not found at $PERSONA_DIR"
  exit 1
fi

RUN_LABEL=""
if [ "$DRY_RUN" -eq 1 ]; then
  RUN_LABEL=" (dry run — nothing written)"
fi
echo "🎩 Installing persona '$PERSONA'$RUN_LABEL"
echo ""

echo "🧬 Soul → $MEMORY_PATH/identity/"
if [ -f "$PERSONA_DIR/soul-hot.md" ]; then
  install_soul "$PERSONA_DIR/soul-hot.md" "$MEMORY_PATH/identity/soul-hot.md" "soul-hot.md"
fi
if [ -f "$PERSONA_DIR/soul-core.md" ]; then
  install_soul "$PERSONA_DIR/soul-core.md" "$MEMORY_PATH/identity/soul-core.md" "soul-core.md"
fi
echo ""

if [ -f "$PERSONA_DIR/output-style.md" ]; then
  STYLE_NAME="$(style_name "$PERSONA_DIR/output-style.md")"
  if [ -z "$STYLE_NAME" ]; then
    echo "❌ $PERSONA_DIR/output-style.md has no 'name:' frontmatter"
    exit 1
  fi
  echo "🎨 Output style \"$STYLE_NAME\" → $OUTPUT_STYLES_DIR/$PERSONA.md"
  install_file "$PERSONA_DIR/output-style.md" "$OUTPUT_STYLES_DIR/$PERSONA.md" "output-styles/$PERSONA.md"
  set_output_style "$STYLE_NAME"
  echo ""
fi

echo "✅ Done$RUN_LABEL"
if [ "$DRY_RUN" -eq 0 ]; then
  echo "   The output style takes effect on the next session — run /clear or restart."
fi
