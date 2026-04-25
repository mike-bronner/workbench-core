#!/usr/bin/env bash
#
# install-chat-skills.sh — package and install workbench-* plugin skills into
# the Claude Mac app's Chat surface via .skill files.
#
# Discovers eligible skills in installed @claude-workbench plugins
# (excluding workbench-core itself), packages each via the skill-creator's
# package_skill.py, and opens each .skill file with the Mac app to trigger
# the install dialog. Updates a state file so the SessionStart notice clears.
#
# Triggered by the /workbench-core:install-chat-skills slash command, OR
# run directly: `bash scripts/install-chat-skills.sh`
#
# Exit codes:
#   0 — success or nothing to do
#   1 — pre-flight failure (jq missing, skill-creator missing, etc.)

set -euo pipefail

PLUGINS_FILE="$HOME/.claude/plugins/installed_plugins.json"
STATE_FILE="$HOME/.claude-workbench/chat-skills-state.json"
DIST_DIR="/tmp/workbench-chat-skills"

# ──────────── Pre-flight ────────────

if [ ! -f "$PLUGINS_FILE" ]; then
  echo "❌ Plugin registry not found at $PLUGINS_FILE"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "❌ jq not installed. Install via: brew install jq"
  exit 1
fi

# Find skill-creator's package_skill.py — the install path layout differs
# slightly between plugin versions, so check both common shapes.
SKILL_CREATOR_PATH=""
for candidate_path in $(jq -r '
  .plugins | to_entries[]
  | select(.key | startswith("skill-creator@"))
  | .value[0].installPath // empty
' "$PLUGINS_FILE" 2>/dev/null); do
  if [ -f "$candidate_path/skills/skill-creator/scripts/package_skill.py" ]; then
    SKILL_CREATOR_PATH="$candidate_path/skills/skill-creator"
    break
  elif [ -f "$candidate_path/scripts/package_skill.py" ]; then
    SKILL_CREATOR_PATH="$candidate_path"
    break
  fi
done

if [ -z "$SKILL_CREATOR_PATH" ]; then
  echo "❌ skill-creator plugin not found. Install it first:"
  echo "   /plugin install skill-creator@claude-plugins-official"
  exit 1
fi

# pyyaml is required by skill-creator's quick_validate.py.
if ! python3 -c "import yaml" 2>/dev/null; then
  echo "📦 Installing pyyaml (required by skill-creator's validator)..."
  if ! pip3 install pyyaml --break-system-packages --quiet 2>&1; then
    echo "❌ Failed to install pyyaml. Install manually:"
    echo "   pip3 install pyyaml --break-system-packages"
    exit 1
  fi
fi

# ──────────── Discovery ────────────

echo "🔍 Scanning workbench plugins for installable skills..."

SKILLS=()
SKILL_NAMES=()
PLUGIN_NAMES=()
PLUGIN_VERSIONS=()

while IFS=$'\t' read -r plugin_path plugin_version; do
  [ -z "$plugin_path" ] && continue
  [ ! -d "$plugin_path/skills" ] && continue

  # Plugin name = the directory two levels up from skills/ (cache layout:
  # cache/<marketplace>/<plugin_name>/<version>/skills/...).
  plugin_name="$(echo "$plugin_path" | awk -F/ '{print $(NF-1)}')"

  for skill_dir in "$plugin_path/skills"/*/; do
    skill_dir="${skill_dir%/}"
    [ ! -f "$skill_dir/SKILL.md" ] && continue

    # `name:` is required by the skill-creator validator. Skip with a notice
    # so the user knows why a skill they expected isn't being installed.
    if grep -q '^name:' "$skill_dir/SKILL.md" 2>/dev/null; then
      SKILLS+=("$skill_dir")
      SKILL_NAMES+=("$(basename "$skill_dir")")
      PLUGIN_NAMES+=("$plugin_name")
      PLUGIN_VERSIONS+=("$plugin_version")
    else
      echo "⚠️  Skipping $plugin_name/$(basename "$skill_dir") — missing 'name:' in frontmatter"
    fi
  done
done < <(jq -r '
  .plugins | to_entries[]
  | select(.key | endswith("@claude-workbench"))
  | select(.key | startswith("workbench-core@") | not)
  | .value[0]
  | "\(.installPath)\t\(.version)"
' "$PLUGINS_FILE")

if [ ${#SKILLS[@]} -eq 0 ]; then
  echo "ℹ️  No installable skills found in dependent plugins."
  # Clear the state file so the warmup notice clears too.
  mkdir -p "$(dirname "$STATE_FILE")"
  echo '{"installed": []}' > "$STATE_FILE"
  exit 0
fi

# ──────────── Plan ────────────

echo ""
echo "Found ${#SKILLS[@]} skill(s) to install into Claude Chat:"
for i in "${!SKILLS[@]}"; do
  echo "  • ${PLUGIN_NAMES[$i]} / ${SKILL_NAMES[$i]}"
done
echo ""

# ──────────── Package and open ────────────

mkdir -p "$DIST_DIR"
rm -f "$DIST_DIR"/*.skill

INSTALLED_RECORDS=()

for i in "${!SKILLS[@]}"; do
  skill_dir="${SKILLS[$i]}"
  name="${SKILL_NAMES[$i]}"
  plugin="${PLUGIN_NAMES[$i]}"
  version="${PLUGIN_VERSIONS[$i]}"

  echo "📦 Packaging $plugin / $name..."
  cd "$SKILL_CREATOR_PATH"
  if python3 -m scripts.package_skill "$skill_dir" "$DIST_DIR" 2>&1 | tail -3 | grep -q "✅"; then
    echo "🚀 Opening $name.skill — confirm install in the Mac app dialog..."
    open -a "Claude" "$DIST_DIR/$name.skill" 2>&1 || {
      echo "⚠️  Failed to open Claude.app for $name.skill — is the Mac app installed?"
      continue
    }
    INSTALLED_RECORDS+=("$plugin|$name|$version")
    sleep 1.5  # let dialog appear before queueing next
  else
    echo "❌ Packaging failed for $name. Skipping."
  fi
done

# ──────────── State file update ────────────

mkdir -p "$(dirname "$STATE_FILE")"

# Build state JSON via jq for safe escaping.
state_json='{"installed":[]}'
for record in "${INSTALLED_RECORDS[@]}"; do
  IFS='|' read -r plugin skill version <<< "$record"
  state_json=$(echo "$state_json" | jq \
    --arg plugin "$plugin" \
    --arg skill "$skill" \
    --arg version "$version" \
    '.installed += [{plugin: $plugin, skill: $skill, version: $version}]')
done
echo "$state_json" > "$STATE_FILE"

echo ""
echo "✅ Done. Verify in Claude Chat that the skills appear."
echo "   State recorded at: $STATE_FILE"
