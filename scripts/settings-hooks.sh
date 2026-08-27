#!/usr/bin/env bash
#
# settings-hooks.sh — deploy workbench user-level hooks and merge their entries
# into ~/.claude/settings.json.
#
# WHY THESE AREN'T IN hooks/hooks.json
#
# The Claude desktop app serves plugin bundles from a server-ingested rpm/ cache
# (api.anthropic.com, keyed per marketplaceId). That ingest can freeze weeks behind
# the CLI-installed copy — observed 2026-08-27 with workbench-core pinned at 0.13.2
# while the CLI held 0.17.0. A hook declared in hooks/hooks.json therefore never
# activates in the desktop app, and "${CLAUDE_PLUGIN_ROOT}" resolves INTO the frozen
# bundle, where a newly-added script does not exist at all. User settings.json is the
# only layer outside the freeze, so the guard is deployed to a stable user path and
# referenced absolutely.
#
# The entries ship as data in assets/hooks/settings-hooks.json so the list is data,
# not prose an agent retypes. The merge is ADDITIVE: an entry is added when its
# command is absent, left alone when present, and existing entries are never removed
# or reordered. No other settings key is touched.
#
# Usage:
#   settings-hooks.sh [--dry-run]
#   settings-hooks.sh --list
#
# Env overrides (for testing): WORKBENCH_SETTINGS_FILE, WORKBENCH_HOOKS_DIR,
#                              WORKBENCH_SETTINGS_HOOKS_FILE.
#
# Exit codes: 0 ok/no-op · 1 preflight failure · 2 usage error.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$SCRIPT_DIR")}"

SETTINGS_FILE="${WORKBENCH_SETTINGS_FILE:-$HOME/.claude/settings.json}"
HOOKS_DIR="${WORKBENCH_HOOKS_DIR:-$HOME/.claude/hooks}"
DATA_FILE="${WORKBENCH_SETTINGS_HOOKS_FILE:-$PLUGIN_ROOT/assets/hooks/settings-hooks.json}"

DRY_RUN=0
LIST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --list)    LIST=1 ;;
    *) echo "usage: settings-hooks.sh [--dry-run] [--list]" >&2; exit 2 ;;
  esac
  shift
done

command -v jq >/dev/null 2>&1 || { echo "❌ jq is required" >&2; exit 1; }
[ -f "$DATA_FILE" ] || { echo "❌ hook data file not found: $DATA_FILE" >&2; exit 1; }
jq empty "$DATA_FILE" 2>/dev/null || { echo "❌ hook data file is not valid JSON: $DATA_FILE" >&2; exit 1; }

if [ "$LIST" -eq 1 ]; then
  jq -r --arg d "$HOOKS_DIR" '
    .hooks | to_entries[] | .key as $e | .value[] | .hooks[]
    | "\($e): \(.command | gsub("__WORKBENCH_HOOKS_DIR__"; $d))"' "$DATA_FILE"
  exit 0
fi

# 1. Deploy shipped hook scripts to the stable user path (overwrite: re-running
#    setup is how a stale deployed copy gets refreshed).
deployed=0
while IFS= read -r name; do
  src="$PLUGIN_ROOT/hooks/$name"
  [ -f "$src" ] || { echo "⚠  shipped hook script missing, skipping: $name" >&2; continue; }
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would deploy: $src -> $HOOKS_DIR/$name"
  else
    mkdir -p "$HOOKS_DIR"
    install -m 755 "$src" "$HOOKS_DIR/$name"
    echo "✅ deployed hook script: $HOOKS_DIR/$name"
  fi
  deployed=$((deployed + 1))
done < <(jq -r '.hooks | to_entries[] | .value[] | .hooks[] | .command
                | gsub("__WORKBENCH_HOOKS_DIR__/"; "") | split(" ") | last | split("/") | last' "$DATA_FILE" | sort -u)

# 2. Merge the entries into settings.json, additively and by command string.
[ -f "$SETTINGS_FILE" ] || { [ "$DRY_RUN" -eq 1 ] || { mkdir -p "$(dirname "$SETTINGS_FILE")"; echo '{}' > "$SETTINGS_FILE"; }; }
if [ -f "$SETTINGS_FILE" ] && ! jq empty "$SETTINGS_FILE" 2>/dev/null; then
  echo "❌ Refusing to touch $SETTINGS_FILE — existing file is not valid JSON. Fix it by hand, then re-run." >&2
  exit 1
fi

tmp="$(mktemp)"
jq --slurpfile data "$DATA_FILE" --arg d "$HOOKS_DIR" '
  ($data[0].hooks
   | with_entries(.value |= map(.hooks |= map(.command |= gsub("__WORKBENCH_HOOKS_DIR__"; $d))))) as $want
  | reduce ($want | to_entries[]) as $ev (
      .;
      .hooks[$ev.key] = (
        ($ev.value) as $incoming
        | (.hooks[$ev.key] // []) as $existing
        | ($existing | map(.hooks[]?.command) ) as $have
        | $existing + ($incoming | map(select((.hooks[0].command) as $c | ($have | index($c)) | not)))
      )
    )
' "$SETTINGS_FILE" > "$tmp"

if ! jq empty "$tmp" 2>/dev/null || [ ! -s "$tmp" ]; then
  rm -f "$tmp"; echo "❌ Refusing to write — produced invalid JSON for $SETTINGS_FILE" >&2; exit 1
fi

before_keys="$(jq -r 'keys|join(",")' "$SETTINGS_FILE" 2>/dev/null || echo '')"
missing="$(jq -rn --arg b "$before_keys" --arg a "$(jq -r 'keys|join(",")' "$tmp")" '
  (($b|split(",")) - ($a|split(","))) | join(",")')"
[ -z "$missing" ] || { rm -f "$tmp"; echo "❌ merge would drop settings keys: $missing — aborted" >&2; exit 1; }

if [ "$DRY_RUN" -eq 1 ]; then
  echo "--- would write to $SETTINGS_FILE ---"
  jq -r '.hooks' "$tmp"
  rm -f "$tmp"
else
  mv "$tmp" "$SETTINGS_FILE"
  echo "✅ merged $deployed hook entr$([ "$deployed" -eq 1 ] && echo y || echo ies) into $SETTINGS_FILE"
fi
