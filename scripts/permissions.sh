#!/usr/bin/env bash
#
# permissions.sh — merge the plugin's shipped permission safety rails into
# ~/.claude/settings.json.
#
# Claude Code evaluates permission rules deny → ask → allow, BEFORE the auto-mode
# classifier, in every permission mode including bypassPermissions. A boundary
# stated only in conversation is lost when context is compacted; a deny rule is
# not. These rails are the durable half of that pair.
#
# The shipped rules live in assets/permissions/rails.json so the list is data,
# not prose an agent retypes. The merge is ADDITIVE: an entry is added when
# absent and left alone when present, existing entries are never removed or
# reordered, and `permissions.allow` is never touched.
#
# The rails file also carries `autoMode.allow` — prose exceptions to the
# classifier's built-in soft-deny rules, a separate layer from the tool-pattern
# rules above. The literal "$defaults" is prepended whenever missing, because
# omitting it makes Claude Code discard every built-in soft-deny rule.
#
# Usage:
#   permissions.sh [--dry-run] [--mode <mode>]
#   permissions.sh --list
#
# Modes: default | acceptEdits | plan | auto | dontAsk | bypassPermissions
# --mode is optional; omit it to merge the rails and leave defaultMode alone.
#
# Env overrides (for testing): WORKBENCH_SETTINGS_FILE, WORKBENCH_RAILS_FILE.
#
# Exit codes: 0 ok/no-op · 1 preflight failure · 2 usage error.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$SCRIPT_DIR")}"

SETTINGS_FILE="${WORKBENCH_SETTINGS_FILE:-$HOME/.claude/settings.json}"
RAILS_FILE="${WORKBENCH_RAILS_FILE:-$PLUGIN_ROOT/assets/permissions/rails.json}"

VALID_MODES="default acceptEdits plan auto dontAsk bypassPermissions"

DRY_RUN=0
LIST=0
MODE=""

if ! command -v jq >/dev/null 2>&1; then
  echo "❌ jq not installed. Install via: brew install jq"
  exit 1
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --list)    LIST=1; shift ;;
    --mode)
      MODE="${2:-}"
      if [ -z "$MODE" ]; then
        echo "❌ --mode requires a value. One of: $VALID_MODES"
        exit 2
      fi
      shift 2
      ;;
    *) echo "Unknown option: $1"; exit 2 ;;
  esac
done

if [ ! -f "$RAILS_FILE" ]; then
  echo "❌ No rails file at $RAILS_FILE"
  exit 1
fi
if ! jq empty "$RAILS_FILE" 2>/dev/null; then
  echo "❌ Rails file is not valid JSON: $RAILS_FILE"
  exit 1
fi

# ──────────── --list mode (used by the setup skill to show the rules) ────────────
if [ "$LIST" -eq 1 ]; then
  jq -r '
    (.deny // [] | map("deny\t" + .rule + "\t" + .why)),
    (.ask  // [] | map("ask\t"  + .rule + "\t" + .why)),
    (.autoMode.allow // [] | map("autoMode.allow\t" + .rule + "\t" + .why))
    | .[]
  ' "$RAILS_FILE"
  exit 0
fi

if [ -n "$MODE" ]; then
  case " $VALID_MODES " in
    *" $MODE "*) ;;
    *) echo "❌ Invalid mode \"$MODE\". One of: $VALID_MODES"; exit 2 ;;
  esac
fi

RUN_LABEL=""
if [ "$DRY_RUN" -eq 1 ]; then
  RUN_LABEL=" (dry run — nothing written)"
fi
echo "🛡️  Permission rails → $SETTINGS_FILE$RUN_LABEL"
echo ""

# Read the current file, or an empty object when it does not exist yet.
CURRENT="$(mktemp)"
trap 'rm -f "$CURRENT" "${MERGED:-}" "${ADDED:-}"' EXIT
if [ -f "$SETTINGS_FILE" ]; then
  if ! jq empty "$SETTINGS_FILE" 2>/dev/null; then
    echo "❌ $SETTINGS_FILE is not valid JSON — refusing to touch it."
    exit 1
  fi
  cp "$SETTINGS_FILE" "$CURRENT"
else
  echo '{}' > "$CURRENT"
fi

# Which rules are genuinely new? Reported before the write so a dry run is useful.
ADDED="$(mktemp)"
jq -r --slurpfile rails "$RAILS_FILE" '
  ($rails[0].deny // [] | map(.rule)) as $deny
  | ($rails[0].ask  // [] | map(.rule)) as $ask
  | ($rails[0].autoMode.allow // [] | map(.rule)) as $auto
  | (($deny - (.permissions.deny // [])) | map("deny\t" + .)),
    (($ask  - (.permissions.ask  // [])) | map("ask\t"  + .)),
    (($auto - (.autoMode.allow   // [])) | map("autoMode.allow\t" + .))
  | .[]
' "$CURRENT" > "$ADDED"

DENY_NEW=$(grep -c '^deny	' "$ADDED" || true)
ASK_NEW=$(grep -c '^ask	' "$ADDED" || true)
AUTO_NEW=$(grep -c '^autoMode.allow	' "$ADDED" || true)

if [ "$DENY_NEW" -eq 0 ] && [ "$ASK_NEW" -eq 0 ] && [ "$AUTO_NEW" -eq 0 ]; then
  echo "  ✓ all shipped rails already present"
else
  while IFS=$'\t' read -r kind rule; do
    [ -n "${rule:-}" ] || continue
    # autoMode entries are prose paragraphs — elide so the report stays readable.
    if [ "${#rule}" -gt 72 ]; then
      rule="${rule:0:69}..."
    fi
    if [ "$DRY_RUN" -eq 1 ]; then
      echo "  ~ would add $kind: $rule"
    else
      echo "  ✅ $kind: $rule"
    fi
  done < "$ADDED"
fi

# defaultMode is a separate, single-key concern from the rule arrays.
CURRENT_MODE="$(jq -r '.permissions.defaultMode // empty' "$CURRENT")"
if [ -n "$MODE" ]; then
  if [ "$CURRENT_MODE" = "$MODE" ]; then
    echo "  ✓ defaultMode already \"$MODE\""
  elif [ "$DRY_RUN" -eq 1 ]; then
    echo "  ~ would set defaultMode = \"$MODE\" (was \"${CURRENT_MODE:-unset}\")"
  else
    echo "  ✅ defaultMode = \"$MODE\" (was \"${CURRENT_MODE:-unset}\")"
  fi
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo ""
  echo "✅ Done$RUN_LABEL"
  exit 0
fi

# Additive merge. `$new - $cur` keeps only entries not already present, so
# existing rules keep their position and nothing is ever dropped.
# `permissions.allow` is never referenced.
#
# autoMode.allow is a different layer: prose exceptions to the classifier's
# built-in soft-deny rules. The literal "$defaults" MUST be in that array —
# without it Claude Code replaces the entire built-in soft-deny list (force
# push, `curl | bash`, production deploys, auto-mode bypass). So it is prepended
# whenever absent, including on a list a user had emptied of it.
MERGED="$(mktemp)"
jq --slurpfile rails "$RAILS_FILE" --arg mode "$MODE" '
  ($rails[0].deny // [] | map(.rule)) as $deny
  | ($rails[0].ask  // [] | map(.rule)) as $ask
  | ($rails[0].autoMode.allow // [] | map(.rule)) as $auto
  | .permissions = (.permissions // {})
  | .permissions.deny = ((.permissions.deny // []) as $cur | $cur + ($deny - $cur))
  | .permissions.ask  = ((.permissions.ask  // []) as $cur | $cur + ($ask  - $cur))
  | if $mode == "" then . else .permissions.defaultMode = $mode end
  | if ($auto | length) == 0 then . else
      .autoMode = (.autoMode // {})
      | .autoMode.allow = (
          (.autoMode.allow // [])
          | (if index("$defaults") then . else ["$defaults"] + . end) as $base
          | $base + ($auto - $base)
        )
    end
' "$CURRENT" > "$MERGED"

# Validate before replacing — never leave settings.json malformed.
if ! jq empty "$MERGED" 2>/dev/null; then
  echo "❌ Refusing to write — produced invalid JSON for settings.json"
  exit 1
fi

mkdir -p "$(dirname "$SETTINGS_FILE")"
cp "$MERGED" "$SETTINGS_FILE"

echo ""
echo "✅ Done"
if [ "$MODE" = "auto" ]; then
  echo "   Note: defaultMode \"auto\" is only honoured from user settings."
  echo "   Claude Code ignores it in .claude/settings.json and settings.local.json."
fi
echo "   Permission rules are read at session start — run /clear or restart."
