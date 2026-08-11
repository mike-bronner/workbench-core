#!/bin/bash
# Tests for scripts/permissions.sh — the permission safety-rails merger.
# Run directly: ./test-permissions.sh
# Each case points the script at a sandbox settings.json via
# WORKBENCH_SETTINGS_FILE and a fixture rails file via WORKBENCH_RAILS_FILE,
# then asserts the resulting JSON. Pure file merging — no network, no server.
#
# shellcheck disable=SC2016
# Every single-quoted `$` in this file is intentional: either a jq variable
# inside a filter, or the literal string "$defaults" that Claude Code requires
# in autoMode arrays. Neither should ever be expanded by the shell.

set -u
SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/permissions.sh"
SHIPPED_RAILS="$(cd "$(dirname "$0")/.." && pwd)/assets/permissions/rails.json"
PASS=0
FAIL=0

SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

# A small fixture so assertions don't churn every time the shipped list changes.
RAILS="$SANDBOX/rails.json"
cat > "$RAILS" <<'EOF'
{
  "deny": [
    { "rule": "Bash(sudo:*)", "why": "no root" },
    { "rule": "Read(~/.ssh/**)", "why": "private keys" }
  ],
  "ask": [
    { "rule": "Bash(rm -rf:*)", "why": "prompt first" },
    { "rule": "Bash(gh pr merge:*)", "why": "human gate" }
  ],
  "autoMode": {
    "allow": [
      { "rule": "Dispatching the pipeline is allowed.", "why": "soft-deny exception" }
    ]
  }
}
EOF

# run <settings-file> [args...] — invoke the script against a sandbox settings file.
run() {
  local settings="$1"; shift
  WORKBENCH_SETTINGS_FILE="$settings" WORKBENCH_RAILS_FILE="$RAILS" \
    bash "$SCRIPT" "$@" 2>&1
}

assert_jq() {
  local desc="$1" file="$2" filter="$3" expected="$4" actual
  actual="$(jq -r "$filter" "$file" 2>/dev/null)"
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected [$expected], got [$actual]"
  fi
}

assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if printf '%s\n' "$haystack" | grep -qF "$needle"; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — output missing: $needle"
  fi
}

assert_status() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected exit $expected, got $actual"
  fi
}

echo "creates permissions from scratch when settings.json is absent:"
S="$SANDBOX/fresh.json"
run "$S" >/dev/null
assert_jq "deny populated"        "$S" '.permissions.deny | length' "2"
assert_jq "ask populated"         "$S" '.permissions.ask  | length' "2"
assert_jq "first deny rule"       "$S" '.permissions.deny[0]' "Bash(sudo:*)"
assert_jq "first ask rule"        "$S" '.permissions.ask[0]'  "Bash(rm -rf:*)"
assert_jq "defaultMode untouched" "$S" '.permissions.defaultMode // "unset"' "unset"

echo "preserves unrelated keys and never touches allow:"
S="$SANDBOX/existing.json"
cat > "$S" <<'EOF'
{
  "outputStyle": "Holmes",
  "theme": "dark",
  "permissions": {
    "allow": ["mcp__plugin_workbench-bujo_scribe__*"],
    "defaultMode": "auto"
  }
}
EOF
run "$S" >/dev/null
assert_jq "outputStyle survives"    "$S" '.outputStyle' "Holmes"
assert_jq "theme survives"          "$S" '.theme' "dark"
assert_jq "allow untouched"         "$S" '.permissions.allow | join(",")' "mcp__plugin_workbench-bujo_scribe__*"
assert_jq "allow length unchanged"  "$S" '.permissions.allow | length' "1"
assert_jq "existing mode preserved" "$S" '.permissions.defaultMode' "auto"
assert_jq "deny added"              "$S" '.permissions.deny | length' "2"

echo "merge is additive — user's own rules keep their position:"
S="$SANDBOX/custom.json"
cat > "$S" <<'EOF'
{
  "permissions": {
    "deny": ["Bash(my-custom-thing:*)", "Bash(sudo:*)"],
    "ask": ["Bash(terraform apply:*)"]
  }
}
EOF
run "$S" >/dev/null
assert_jq "custom deny stays first"   "$S" '.permissions.deny[0]' "Bash(my-custom-thing:*)"
assert_jq "already-present not dupes" "$S" '.permissions.deny[1]' "Bash(sudo:*)"
assert_jq "missing shipped appended"  "$S" '.permissions.deny[2]' "Read(~/.ssh/**)"
assert_jq "no duplicate deny entries" "$S" '.permissions.deny | length' "3"
assert_jq "custom ask stays first"    "$S" '.permissions.ask[0]' "Bash(terraform apply:*)"
assert_jq "ask total after merge"     "$S" '.permissions.ask | length' "3"

echo "autoMode.allow gets \$defaults prepended so built-in soft-denies survive:"
S="$SANDBOX/automode.json"
run "$S" >/dev/null
assert_jq "defaults present"       "$S" '.autoMode.allow[0]' '$defaults'
assert_jq "shipped rule appended"  "$S" '.autoMode.allow[1]' "Dispatching the pipeline is allowed."
assert_jq "exactly two entries"    "$S" '.autoMode.allow | length' "2"

echo "an existing autoMode.allow missing \$defaults is repaired, not replaced:"
S="$SANDBOX/automode-nodefaults.json"
cat > "$S" <<'EOF'
{ "autoMode": { "allow": ["Deploying to staging is allowed."],
                "environment": ["$defaults", "Organization: Acme"] } }
EOF
run "$S" >/dev/null
assert_jq "defaults prepended"      "$S" '.autoMode.allow[0]' '$defaults'
assert_jq "user rule kept"          "$S" '.autoMode.allow[1]' "Deploying to staging is allowed."
assert_jq "shipped rule appended"   "$S" '.autoMode.allow[2]' "Dispatching the pipeline is allowed."
assert_jq "environment untouched"   "$S" '.autoMode.environment | join("|")' '$defaults|Organization: Acme'

echo "an existing autoMode.allow that already has \$defaults is not double-added:"
S="$SANDBOX/automode-hasdefaults.json"
cat > "$S" <<'EOF'
{ "autoMode": { "allow": ["Deploying to staging is allowed.", "$defaults"] } }
EOF
run "$S" >/dev/null
assert_jq "no duplicate defaults" "$S" '[.autoMode.allow[] | select(. == "$defaults")] | length' "1"
assert_jq "original order kept"   "$S" '.autoMode.allow[0]' "Deploying to staging is allowed."
assert_jq "total entries"         "$S" '.autoMode.allow | length' "3"

echo "running twice is a byte-identical no-op:"
S="$SANDBOX/idem.json"
run "$S" --mode acceptEdits >/dev/null
FIRST="$(cat "$S")"
OUT=$(run "$S" --mode acceptEdits)
assert_contains "reports rails already present" "$OUT" "all shipped rails already present"
assert_contains "reports mode already set"      "$OUT" 'defaultMode already "acceptEdits"'
if [ "$FIRST" = "$(cat "$S")" ]; then
  PASS=$((PASS + 1)); echo "  ✅ second run changed nothing"
else
  FAIL=$((FAIL + 1)); echo "  ❌ second run changed the file"
fi

echo "--mode sets defaultMode and validates its value:"
S="$SANDBOX/mode.json"
run "$S" --mode plan >/dev/null
assert_jq "mode written" "$S" '.permissions.defaultMode' "plan"
run "$S" --mode auto >/dev/null
assert_jq "mode overwritten" "$S" '.permissions.defaultMode' "auto"
OUT=$(run "$S" --mode auto)
assert_contains "warns auto is user-scope only" "$OUT" "only honoured from user settings"
OUT=$(run "$S" --mode nonsense); STATUS=$?
assert_status "invalid mode exits 2" "2" "$STATUS"
assert_contains "invalid mode explained" "$OUT" "Invalid mode"
assert_jq "invalid mode left file alone" "$S" '.permissions.defaultMode' "auto"
OUT=$(run "$S" --mode); STATUS=$?
assert_status "bare --mode exits 2" "2" "$STATUS"

echo "--dry-run writes nothing:"
S="$SANDBOX/dry.json"
echo '{"theme":"dark"}' > "$S"
BEFORE="$(cat "$S")"
OUT=$(run "$S" --dry-run --mode plan)
assert_contains "announces dry run"    "$OUT" "dry run — nothing written"
assert_contains "previews a deny add"  "$OUT" "would add deny: Bash(sudo:*)"
assert_contains "previews the mode"    "$OUT" 'would set defaultMode = "plan"'
if [ "$BEFORE" = "$(cat "$S")" ]; then
  PASS=$((PASS + 1)); echo "  ✅ file unchanged after dry run"
else
  FAIL=$((FAIL + 1)); echo "  ❌ dry run modified the file"
fi

echo "refuses to touch a malformed settings.json:"
S="$SANDBOX/broken.json"
printf '{ this is not json' > "$S"
BEFORE="$(cat "$S")"
OUT=$(run "$S"); STATUS=$?
assert_status "exits 1 on bad JSON" "1" "$STATUS"
assert_contains "explains the refusal" "$OUT" "not valid JSON"
if [ "$BEFORE" = "$(cat "$S")" ]; then
  PASS=$((PASS + 1)); echo "  ✅ malformed file left untouched"
else
  FAIL=$((FAIL + 1)); echo "  ❌ malformed file was modified"
fi

echo "--list prints every shipped rule with its rationale:"
OUT=$(run "$SANDBOX/unused.json" --list)
assert_contains "lists a deny rule" "$OUT" "deny	Bash(sudo:*)	no root"
assert_contains "lists an ask rule" "$OUT" "ask	Bash(gh pr merge:*)	human gate"
if [ ! -f "$SANDBOX/unused.json" ]; then
  PASS=$((PASS + 1)); echo "  ✅ --list wrote no settings file"
else
  FAIL=$((FAIL + 1)); echo "  ❌ --list created a settings file"
fi

echo "the shipped rails file is valid and complete:"
if jq empty "$SHIPPED_RAILS" 2>/dev/null; then
  PASS=$((PASS + 1)); echo "  ✅ rails.json is valid JSON"
else
  FAIL=$((FAIL + 1)); echo "  ❌ rails.json is not valid JSON"
fi
assert_jq "every deny entry has a rule" "$SHIPPED_RAILS" \
  '[.deny[] | select(.rule == null)] | length' "0"
assert_jq "every deny entry has a why"  "$SHIPPED_RAILS" \
  '[.deny[] | select(.why  == null)] | length' "0"
assert_jq "every ask entry has a rule"  "$SHIPPED_RAILS" \
  '[.ask[]  | select(.rule == null)] | length' "0"
assert_jq "every ask entry has a why"   "$SHIPPED_RAILS" \
  '[.ask[]  | select(.why  == null)] | length' "0"
assert_jq "no rule appears in both lists" "$SHIPPED_RAILS" \
  '[(.deny | map(.rule))[] as $d | (.ask | map(.rule)) | select(index($d))] | length' "0"
assert_jq "every autoMode entry has a rule" "$SHIPPED_RAILS" \
  '[.autoMode.allow[] | select(.rule == null)] | length' "0"
assert_jq "every autoMode entry has a why"  "$SHIPPED_RAILS" \
  '[.autoMode.allow[] | select(.why  == null)] | length' "0"

# `*` is always a wildcard in a Bash rule and deny cannot carry an allow
# exception, so any `rm -rf /`-shaped deny would block every absolute-path
# delete. Claude Code already gates root/home removals semantically — the
# classifier decides them in auto mode and they still prompt under
# bypassPermissions. The ask rule is deliberately the only rm guard.
echo "rm is guarded by ask alone — no rm deny may creep back in:"
assert_jq "no rm rule in deny" "$SHIPPED_RAILS" \
  '[.deny[] | select(.rule | startswith("Bash(rm"))] | length' "0"
assert_jq "rm -rf is in ask"   "$SHIPPED_RAILS" \
  '[.ask[]  | select(.rule == "Bash(rm -rf:*)")] | length' "1"

echo "the .env deny covers bare .env only:"
assert_jq "bare .env denied" "$SHIPPED_RAILS" \
  '[.deny[] | select(.rule == "Read(**/.env)")] | length' "1"
assert_jq "no .env.* rule (would catch .env.example)" "$SHIPPED_RAILS" \
  '[.deny[] | select(.rule == "Read(**/.env.*)")] | length' "0"

# The headless-pipeline constraint is the whole reason this list is curated.
# workbench-dev-team dispatches Watson via `nohup claude -p`, where an ask rule
# blocks instead of prompting. If one of these ever lands in ask, the pipeline
# dies silently — so assert it here rather than trusting a comment.
echo "ask list never blocks the unattended dev-team pipeline:"
for RULE in "Bash(git push:*)" "Bash(git commit:*)" "Bash(gh pr create:*)"; do
  COUNT="$(jq -r --arg r "$RULE" '[.ask[] | select(.rule == $r)] | length' "$SHIPPED_RAILS")"
  if [ "$COUNT" = "0" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $RULE not in ask"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $RULE in ask — would block headless Watson"
  fi
done

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
