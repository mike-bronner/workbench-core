#!/usr/bin/env bash
#
# install.sh — propagate the plugin's shipped persona into the live location
# Claude Code loads it from.
#
# The plugin ships exactly one persona, a directory at assets/personas/<name>/
# holding one output style:
#   output-style.md  → ~/.claude/output-styles/<name>.md   (system-prompt layer)
# The output style's `name:` frontmatter is also written to
# ~/.claude/settings.json as .outputStyle (safe single-key jq merge).
#
# The plugin SHIPS the persona (read-only at runtime via CLAUDE_PLUGIN_ROOT);
# this script COPIES it to the user's live location. Both writes are
# content-addressed and idempotent.
#
# Usage:
#   install.sh [--dry-run]
#
# Env overrides (for testing): WORKBENCH_SETTINGS_FILE, WORKBENCH_OUTPUT_STYLES_DIR.
#
# Exit codes: 0 ok/no-op · 1 preflight failure · 2 usage error.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$SCRIPT_DIR")}"

SETTINGS_FILE="${WORKBENCH_SETTINGS_FILE:-$HOME/.claude/settings.json}"
OUTPUT_STYLES_DIR="${WORKBENCH_OUTPUT_STYLES_DIR:-$HOME/.claude/output-styles}"

DRY_RUN=0

if ! command -v jq >/dev/null 2>&1; then
  echo "❌ jq not installed. Install via: brew install jq"
  exit 1
fi

# Read the `name:` value from an output-style markdown's YAML frontmatter.
#
# [[:space:]] IS SAFE HERE, and is left alone deliberately. Sibling hooks spell
# the class out in ASCII, because in grep and bash it is a property of the C
# library rather than only the locale — glibc excludes U+00A0, U+202F and U+2007
# in every locale, Darwin includes them — and awk is a third engine with the same
# exposure (BSD awk here, mawk or gawk on Linux). Two things keep that
# unreachable, and either alone would be enough:
#
#   The input is not untrusted. This only ever reads an output-style.md shipped
#   inside this repo, from assets/personas/*/ — never a path a user supplies.
#
#   The character under test is the YAML `key: value` separator, which must be
#   an ASCII space for the file to be frontmatter at all. Claude Code's own
#   parser and the frontmatter job in .github/workflows/validate.yml both read
#   these files; an exotic space there breaks the style before this line is
#   reached, and the divergence never gets a turn.
#
# The second reason is the durable one: it holds for any file this ever reads,
# not just today's. No test pins it, because a test could only restate the YAML
# spec that every other consumer already enforces.
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
    # A stale live copy is the case a re-sync exists for, so show what changes.
    if [ -f "$dest" ]; then
      echo "      Diff (current → shipped):"
      diff -u "$dest" "$src" 2>/dev/null | sed 's/^/      /' || true
    fi
    return 0
  fi
  local tmp
  tmp="$(mktemp)"
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$tmp"
  mv "$tmp" "$dest"
  echo "  ✅ wrote $label → $dest"
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

# ──────────── persona mode ────────────
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) echo "Unknown option: $arg"; exit 2 ;;
  esac
done

PERSONAS_DIR="$PLUGIN_ROOT/assets/personas"
PERSONA_DIRS=("$PERSONAS_DIR"/*/)
if [ ! -d "$PERSONAS_DIR" ] || [ ! -d "${PERSONA_DIRS[0]}" ]; then
  echo "❌ No persona shipped at $PERSONAS_DIR"
  exit 1
fi
if [ "${#PERSONA_DIRS[@]}" -ne 1 ]; then
  echo "❌ Expected exactly one shipped persona at $PERSONAS_DIR, found ${#PERSONA_DIRS[@]}"
  exit 1
fi
PERSONA_DIR="${PERSONA_DIRS[0]%/}"
PERSONA="$(basename "$PERSONA_DIR")"

RUN_LABEL=""
if [ "$DRY_RUN" -eq 1 ]; then
  RUN_LABEL=" (dry run — nothing written)"
fi
echo "🎩 Installing persona '$PERSONA'$RUN_LABEL"
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
