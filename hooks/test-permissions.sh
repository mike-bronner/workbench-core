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
    { "rule": "Bash(dd:*)", "why": "destroys disks" }
  ],
  "ask": [
    { "rule": "Bash(npm publish:*)", "why": "prompt first" },
    { "rule": "Bash(gh pr merge:*)", "why": "human gate" }
  ],
  "allow": [
    { "rule": "mcp__plugin_test_memory__*", "why": "memory writes must not stall" }
  ],
  "autoMode": {
    "allow": [
      { "rule": "Dispatching the pipeline is allowed.", "why": "soft-deny exception" }
    ]
  }
}
EOF

# A second fixture with NO allow list, to pin that the key is not invented for a
# rails file that does not ship one. Without the length guard in the merge, this
# would write an empty `permissions.allow` array into a user's settings.json.
RAILS_NOALLOW="$SANDBOX/rails-noallow.json"
jq 'del(.allow)' "$RAILS" > "$RAILS_NOALLOW"

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
assert_jq "first ask rule"        "$S" '.permissions.ask[0]'  "Bash(npm publish:*)"
assert_jq "defaultMode untouched" "$S" '.permissions.defaultMode // "unset"' "unset"

echo "preserves unrelated keys:"
S="$SANDBOX/existing.json"
cat > "$S" <<'EOF'
{
  "outputStyle": "Clear",
  "theme": "dark",
  "permissions": {
    "allow": ["mcp__plugin_workbench-bujo_scribe__*"],
    "defaultMode": "auto"
  }
}
EOF
run "$S" >/dev/null
assert_jq "outputStyle survives"    "$S" '.outputStyle' "Clear"
assert_jq "theme survives"          "$S" '.theme' "dark"
assert_jq "existing mode preserved" "$S" '.permissions.defaultMode' "auto"
assert_jq "deny added"              "$S" '.permissions.deny | length' "2"

# This file shipped no allow list for most of its life, and permissions.sh said
# plainly that `permissions.allow` was never touched. It now merges one, so the
# promise is narrower and both halves of it need pinning: the shipped entry IS
# added, and the user's own entries are neither moved nor dropped to make room.
echo "merges the shipped allow list without disturbing the user's own entries:"
assert_jq "user's allow entry kept"   "$S" '.permissions.allow[0]' "mcp__plugin_workbench-bujo_scribe__*"
assert_jq "shipped allow appended"    "$S" '.permissions.allow[1]' "mcp__plugin_test_memory__*"
assert_jq "allow length after merge"  "$S" '.permissions.allow | length' "2"

S="$SANDBOX/allow-order.json"
cat > "$S" <<'EOF'
{
  "permissions": {
    "allow": [
      "Bash(npm test:*)",
      "mcp__plugin_test_memory__*",
      "Read(//Users/me/notes/**)",
      "Bash(ls:*)"
    ]
  }
}
EOF
run "$S" >/dev/null
assert_jq "first user entry holds index 0"  "$S" '.permissions.allow[0]' "Bash(npm test:*)"
assert_jq "second holds index 1"            "$S" '.permissions.allow[1]' "mcp__plugin_test_memory__*"
assert_jq "third holds index 2"             "$S" '.permissions.allow[2]' "Read(//Users/me/notes/**)"
assert_jq "fourth holds index 3"            "$S" '.permissions.allow[3]' "Bash(ls:*)"
assert_jq "an already-present entry is not duplicated" "$S" \
  '[.permissions.allow[] | select(. == "mcp__plugin_test_memory__*")] | length' "1"
assert_jq "no user entry was dropped"       "$S" '.permissions.allow | length' "4"
OUT=$(run "$S")
assert_contains "reports nothing new to add" "$OUT" "all shipped rails already present"

# The upgrade path, and the one case where allow is the ONLY new entry: a user
# who already merged the previous rails (no allow list) then updates the plugin.
# The report has to say so. If the new-entry count omits allow, this run prints
# "all shipped rails already present" while quietly adding one — a merge that
# lies about what it did is worse than one that adds nothing.
echo "reports an allow entry that is the only new rail:"
S="$SANDBOX/upgrade.json"
WORKBENCH_SETTINGS_FILE="$S" WORKBENCH_RAILS_FILE="$RAILS_NOALLOW" \
  bash "$SCRIPT" >/dev/null 2>&1
OUT=$(run "$S" --dry-run)
assert_contains "previews the allow add" "$OUT" "would add allow: mcp__plugin_test_memory__*"
if printf '%s\n' "$OUT" | grep -qF -- "all shipped rails already present"; then
  FAIL=$((FAIL + 1)); echo "  ❌ claimed nothing was new while adding an allow entry"
else
  PASS=$((PASS + 1)); echo "  ✅ does not claim the rails are already present"
fi
run "$S" >/dev/null
assert_jq "allow entry actually added" "$S" '.permissions.allow[0]' "mcp__plugin_test_memory__*"
assert_jq "deny not duplicated by the second run" "$S" '.permissions.deny | length' "2"

echo "a rails file with no allow list does not invent the key:"
S="$SANDBOX/noallow.json"
WORKBENCH_SETTINGS_FILE="$S" WORKBENCH_RAILS_FILE="$RAILS_NOALLOW" \
  bash "$SCRIPT" >/dev/null 2>&1
assert_jq "permissions.allow absent" "$S" '.permissions | has("allow")' "false"
assert_jq "deny still merged"        "$S" '.permissions.deny | length' "2"

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
assert_jq "missing shipped appended"  "$S" '.permissions.deny[2]' "Bash(dd:*)"
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
assert_contains "previews an allow add" "$OUT" "would add allow: mcp__plugin_test_memory__*"
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
assert_contains "lists an allow rule" "$OUT" "allow	mcp__plugin_test_memory__*	memory writes must not stall"
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
assert_jq "every allow entry has a rule" "$SHIPPED_RAILS" \
  '[(.allow // [])[] | select(.rule == null)] | length' "0"
assert_jq "every allow entry has a why"  "$SHIPPED_RAILS" \
  '[(.allow // [])[] | select(.why  == null)] | length' "0"
# deny beats allow regardless of specificity, so a rule in both is dead text
# that reads like a grant. Catch it here rather than in a confused bug report.
assert_jq "no rule is both denied and allowed" "$SHIPPED_RAILS" \
  '[(.allow // [] | map(.rule))[] as $a | (.deny | map(.rule)) | select(index($a))] | length' "0"
assert_jq "every autoMode entry has a rule" "$SHIPPED_RAILS" \
  '[.autoMode.allow[] | select(.rule == null)] | length' "0"
assert_jq "every autoMode entry has a why"  "$SHIPPED_RAILS" \
  '[.autoMode.allow[] | select(.why  == null)] | length' "0"

# THE FIVE SCOPE-ABLE VERBS ARE GATED BY A HOOK AND BY NO RULE AT ALL.
#
# `Bash(rm -rf:*)` and the four git entries used to sit in `ask`. They encoded a
# VERB-based policy — prompt wherever the verb acts — and the policy this
# machine runs is SCOPE-based: inside the project and the scratch roots is
# permitted, outside is the human's call. That exception cannot be layered on
# top of an ask entry, because a matching ask rule still prompts even when a
# PreToolUse hook returned "allow". So the five had to leave rather than be
# narrowed, and hooks/destructive-scope-guard.sh answers in their place.
#
# A deny was never an option either, in any era: `*` is always a wildcard in a
# Bash rule and deny cannot carry an allow exception, so an `rm -rf /`-shaped
# deny would block every absolute-path delete.
echo "the five scope-able verbs are gated by the hook, and by no rule:"
for RULE in "Bash(rm -rf:*)" "Bash(git reset --hard:*)" "Bash(git clean -fd:*)" \
            "Bash(git stash drop:*)" "Bash(git stash clear:*)"; do
  COUNT="$(jq -r --arg r "$RULE" \
    '[(.deny + .ask + (.allow // []))[] | select(.rule == $r)] | length' "$SHIPPED_RAILS")"
  if [ "$COUNT" = "0" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $RULE is in no list"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $RULE is back — it re-prompts wherever the verb acts, and overrides the guard's permit"
  fi
done
# Prefix-wide, not just the exact spellings above: `Bash(rm:*)` or
# `Bash(git reset:*)` would re-arm the same verb-based prompt under a different
# string, and the loop above would not see it.
assert_jq "no rm rule anywhere" "$SHIPPED_RAILS" \
  '[(.deny + .ask + (.allow // []))[] | select(.rule | startswith("Bash(rm"))] | length' "0"

# THE OTHER HALF, AND IT IS THE ONE THAT MATTERS. Every assertion above is
# satisfied by a file that ships no rules AND no guard — which is these verbs
# gated by nothing, and it would read here as success. So the guard is pinned
# too: shipped, and registered exactly once on Bash. Delete the guard and the
# absence of the rules stops being a policy and becomes a hole.
REPO_ROOT_RAILS="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$REPO_ROOT_RAILS/hooks/destructive-scope-guard.sh" ]; then
  PASS=$((PASS + 1)); echo "  ✅ the guard that replaced them ships"
else
  FAIL=$((FAIL + 1)); echo "  ❌ the five are gone and no guard ships — these verbs are gated by nothing"
fi
assert_jq "the guard is registered once on Bash" "$REPO_ROOT_RAILS/hooks/hooks.json" \
  '[.hooks.PreToolUse[] | select(.hooks[].command | test("destructive-scope-guard.sh")) | .matcher] | join(",")' \
  "Bash"

# Credential paths are guarded by hooks/credential-guard.sh, not by a deny rule.
# A Read deny never applied to a subprocess that opens the file itself, and ANY
# Read() rule arms the `deniedPathInsideDirectory` circuit breaker, which forces
# a prompt on every relative-path grep/rg/diff/git/cp/mv in a command containing
# `cd`. That breaker is bypassImmune and reads the deny list as a boolean, so
# narrowing a rule does not help — one deny rule of any shape re-arms the class.
# The ask list is asserted too, so the rules cannot come back as a "compromise":
# an ask rule dodges the breaker but prompts on every legitimate read instead,
# and it would block the headless pipeline the way any ask rule does.
echo "no Read() rule ships in either list — one deny re-arms the prompt storm:"
assert_jq "no Read rules in deny" "$SHIPPED_RAILS" \
  '[.deny[] | select(.rule | startswith("Read("))] | length' "0"
assert_jq "no Read rules in ask"  "$SHIPPED_RAILS" \
  '[.ask[]  | select(.rule | startswith("Read("))] | length' "0"

# The headless-pipeline constraint is the whole reason this list is curated.
# workbench-dev-team dispatches Watson via `nohup claude -p`, where an ask rule
# blocks instead of prompting. If one of these ever lands in ask, the pipeline
# dies silently — so assert it here rather than trusting a comment.
# The Linux rails close the paths the `sudo` deny does NOT cover. Two of those
# calls are non-obvious enough that a future edit could plausibly "tidy" them
# into something that silently stops working, so assert them.
echo "Linux rails cover the rootless paths:"
assert_jq "systemctl is blanket, not scoped to a verb" "$SHIPPED_RAILS" \
  '[.ask[] | select(.rule == "Bash(systemctl:*)")] | length' "1"
# `systemctl --user enable foo` puts the flag BEFORE the verb, so a scoped
# `Bash(systemctl enable:*)` rule would never match the rootless case — which is
# the one case that most needs the rail, since it needs no sudo.
assert_jq "no scoped systemctl verb rules" "$SHIPPED_RAILS" \
  '[.ask[] | select(.rule | startswith("Bash(systemctl "))] | length' "0"
for RULE in "Bash(yay:*)" "Bash(paru:*)" "Bash(systemd-run:*)" "Bash(udisksctl:*)"; do
  assert_jq "$RULE asks" "$SHIPPED_RAILS" \
    "[.ask[] | select(.rule == \"$RULE\")] | length" "1"
done

# pacman/apt/dnf need root for every mutating operation, so `Bash(sudo:*)`
# already walls them. A blanket rule would prompt on every harmless `-Q` query
# and buy nothing. If one ever appears here, the reasoning above was lost.
echo "system package managers rely on the sudo deny, not their own rule:"
for MGR in pacman apt apt-get dnf yum zypper; do
  COUNT="$(jq -r --arg m "Bash($MGR" \
    '[(.deny + .ask)[] | select(.rule | startswith($m))] | length' "$SHIPPED_RAILS")"
  if [ "$COUNT" = "0" ]; then
    PASS=$((PASS + 1)); echo "  ✅ no $MGR rule"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $MGR rule present — prompts on read-only queries for no gain"
  fi
done

# The allow list is the most dangerous surface in this file, because an allow
# rule is a grant rather than a brake. The rule that keeps it safe is structural,
# and it turns on SHAPE rather than on the `Bash(` prefix: an entry may name ONE
# plugin's MCP server, or ONE script at a fixed path under ~/.claude-workbench/
# bin/. A shell PATTERN may never appear. `Bash(rm -rf:*)`, or any `*` inside the
# command part, grants arbitrary code execution — precisely what autoMode.allow
# exists to handle instead, and what auto mode deliberately suspends. A fixed
# script path grants the logic in one file this plugin ships, installs, and
# tests. Assert the shape rather than trusting the comment.
echo "every allow entry names one MCP server or one installed script:"
assert_jq "no Read pattern in allow" "$SHIPPED_RAILS" \
  '[(.allow // [])[] | select(.rule | startswith("Read("))] | length' "0"
assert_jq "every allow rule is an mcp__ pattern or a fixed bin/ script" "$SHIPPED_RAILS" \
  '[(.allow // [])[]
    | select(((.rule | startswith("mcp__"))
              or (.rule | test("^Bash\\(bash \"\\$HOME/\\.claude-workbench/bin/[a-z0-9-]+\\.sh\":\\*\\)$"))) | not)]
   | length' "0"
# The `*` is the whole hazard, and the claim about it splits in two.
#   VERIFIED, and what this assertion holds: no wildcard sits inside the command
#   part, so no entry here grants a command SHAPE — only a fixed path.
#   ASSUMED: that the trailing `:*` admits nothing but that script's own
#   arguments. Claude Code documents deny and ask rules as checked inside
#   command substitution, and documents nothing either way about allow rules, so
#   an argument carrying `$(...)` is undocumented ground. A substitution holding
#   `rm -rf` used to be covered by this file's own ask rule, which is no longer
#   here — hooks/destructive-scope-guard.sh reads it instead, because a `$(...)`
#   becomes a statement of its own when the command is tokenised and its verb
#   slot is judged like any other. That residual is not introduced here anyway:
#   workbench-dev-team already ships allow entries of exactly this form for
#   approve-commit.sh and dispatch-agent.sh.
assert_jq "no wildcard inside the command part of a Bash allow entry" "$SHIPPED_RAILS" \
  '[(.allow // [])[]
    | select(.rule | startswith("Bash("))
    | select(.rule | ltrimstr("Bash(") | rtrimstr(":*)") | contains("*"))]
   | length' "0"
# The vault is the canonical memory store, and a classifier hold on a write
# loses the memory rather than deferring it — nothing retries the call.
assert_jq "the memory MCP is allowed" "$SHIPPED_RAILS" \
  '[(.allow // [])[] | select(.rule == "mcp__plugin_workbench-core_memory__*")] | length' "1"
# No Bash allow entry ships at all. The one that did named a command at a fixed
# path under ~/.claude-workbench/bin/ which deleted inside a scratchpad without
# prompting; hooks/destructive-scope-guard.sh answers that question directly
# now, by resolving the path, so the command and its grant were retired.
#
# Asserted rather than left to the loop below, which iterates Bash allow entries
# and is therefore satisfied by an empty list — it cannot tell "no entry" from
# "no entry checked". This states the zero.
assert_jq "no Bash allow entry ships" "$SHIPPED_RAILS" \
  '[(.allow // [])[] | select(.rule | startswith("Bash("))] | length' "0"

# An allow entry naming a script this plugin does not ship is a dangling grant:
# setup installs nothing to that path, so the rule stands ready for whatever
# lands there later. Every allowed script has to exist in bin/, which is both
# where this plugin keeps its installable commands and the directory setup
# installs them into — so the source and deployed basenames are the same string.
#
# "Tested" is the other half of what rails.json and the README claim for these
# entries, and a claim nothing checks is exactly the drift this file exists to
# catch: a future script plus an allow entry would otherwise pass every
# assertion here with nobody re-deriving the safety argument. So each allowed
# script must also have hooks/test-<name>.sh, and that suite must name
# bin/<name>. validate.yml runs hooks/test-*.sh by glob, so a suite at that path
# is a suite CI runs on every push. "Reviewed" is the one word no assertion can
# hold — that is a human reading the diff, and the prose says so plainly rather
# than implying a check that does not exist.
echo "every allowed script is one this plugin ships, with a suite CI runs:"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
while IFS= read -r ALLOWED; do
  [ -n "$ALLOWED" ] || continue
  if [ -f "$REPO_ROOT/bin/$ALLOWED" ]; then
    PASS=$((PASS + 1)); echo "  ✅ bin/$ALLOWED ships"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ allow names $ALLOWED, which this plugin does not ship"
  fi
  SUITE="hooks/test-$ALLOWED"
  if [ -f "$REPO_ROOT/$SUITE" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $SUITE exists, so CI's hooks/test-*.sh glob runs it"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ allow names $ALLOWED with no $SUITE — nothing tests what the grant runs"
  fi
  # Comment lines are stripped first: every one of these suites opens by saying
  # which script it covers, so a whole-file grep is satisfied by that sentence
  # alone and would pass on a suite that runs something else entirely.
  if [ -f "$REPO_ROOT/$SUITE" ] \
     && grep -v '^[[:space:]]*#' "$REPO_ROOT/$SUITE" | grep -qF "bin/$ALLOWED"; then
    PASS=$((PASS + 1)); echo "  ✅ $SUITE runs bin/$ALLOWED"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $SUITE never runs bin/$ALLOWED — it tests something else"
  fi
done < <(jq -r '(.allow // [])[] | .rule
  | select(startswith("Bash("))
  | ltrimstr("Bash(bash \"$HOME/.claude-workbench/bin/")
  | rtrimstr("\":*)")' "$SHIPPED_RAILS")

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
