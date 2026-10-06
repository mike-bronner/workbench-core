#!/bin/bash
# Tests for hooks/skill-learnings.sh, the PreToolUse(Skill) hook that hands a
# skill its learnings file. Run directly: ./test-skill-learnings.sh
# Every case runs against a throwaway vault, never the user's real one.

set -u
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK="$HOOKS_DIR/skill-learnings.sh"
COUNT="$(cd "$HOOKS_DIR/.." && pwd)/scripts/learnings-count.sh"
ROOT="$(cd "$HOOKS_DIR/.." && pwd)"
PASS=0
FAIL=0

SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT
VAULT="$SANDBOX/vault"
mkdir -p "$VAULT/skills"

run_hook() {  # run_hook <skill> [tool-name] -> the hook's stdout
  jq -cn --arg s "$1" --arg t "${2:-Skill}" '{tool_name:$t, tool_input:{skill:$s}}' \
    | WORKBENCH_MEMORY_PATH="$VAULT" WORKBENCH_CONFIG_FILE="$SANDBOX/none.json" bash "$HOOK"
}
count_of() {  # count_of <skill> -> what scripts/learnings-count.sh prints
  WORKBENCH_MEMORY_PATH="$VAULT" WORKBENCH_CONFIG_FILE="$SANDBOX/none.json" bash "$COUNT" "$1"
}
context_of() { printf '%s' "$1" | jq -r '.hookSpecificOutput.additionalContext // empty' 2>/dev/null; }

ok() { PASS=$((PASS + 1)); echo "  ✅ $1"; }
no() { FAIL=$((FAIL + 1)); echo "  ❌ $1"; }
assert_empty()    { if [ -z "$2" ]; then ok "$1"; else no "$1 (got output: ${2:0:80})"; fi; }
assert_contains() { if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else no "$1 (missing: $3)"; fi; }
assert_missing()  { if printf '%s' "$2" | grep -qF -- "$3"; then no "$1 (found: $3)"; else ok "$1"; fi; }

entries() {  # entries <n> -> n dated `## ` entries
  local i
  for i in $(seq 1 "$1"); do printf '## 2026-09-%02d - entry %d\nText %d.\n\n' $((i % 28 + 1)) "$i" "$i"; done
}

echo "no learnings file means no output:"
assert_empty "absent file is silent"             "$(run_hook workbench-core:log-now)"
assert_empty "a non-Skill tool is ignored"       "$(run_hook anything Bash)"

echo "an existing file is injected, and keyed by the bare skill name:"
printf -- '---\nname: x\n---\n\nLEARNING-CANARY use keyword mode\n' > "$VAULT/skills/memory-lint.learnings.md"
OUT=$(run_hook workbench-core:memory-lint)
CTX=$(context_of "$OUT")
assert_contains "the file text reaches the model"   "$CTX" "LEARNING-CANARY use keyword mode"
assert_contains "the context names the file"         "$CTX" "skills/memory-lint.learnings.md"
assert_contains "the context carries the write rule" "$CTX" "Append it through the memory MCP"
assert_contains "it is a PreToolUse context"         "$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.hookEventName')" "PreToolUse"
assert_missing  "it grants no permission"            "$OUT" "permissionDecision"
assert_contains "a bare name reads the same file"    "$(context_of "$(run_hook memory-lint)")" "LEARNING-CANARY"
assert_missing  "a small file draws no warning"      "$CTX" "entry limit"

echo "the entry count goes to the status line, never into model context:"
# hooks/register.ts runs scripts/learnings-count.sh after each Skill call and
# puts a count past 30 on the status line. The hook itself warns about nothing.
entries 31 > "$VAULT/skills/over-limit.learnings.md"
CTX=$(context_of "$(run_hook plugin:over-limit)")
assert_contains "31 entries: the text still reaches the model" "$CTX" "entry 31"
assert_missing  "31 entries: no warning in the context"         "$CTX" "entry limit"
assert_missing  "31 entries: no count in the context"           "$CTX" "31 entries"
assert_missing  "31 entries: no compaction prompt"              "$CTX" "compact-learnings"
assert_contains "the script counts 31 \`## \` entries" "$(count_of plugin:over-limit)" "31"
entries 30 > "$VAULT/skills/at-limit.learnings.md"
if [ "$(count_of at-limit)" = "30" ]; then ok "the script counts 30 at the limit"; else no "the script counted $(count_of at-limit) at the limit"; fi
# Dated bullets are the other entry shape in the vault.
for i in $(seq 1 31); do printf -- '- **2026-06-%02d** - bullet %d\n' $((i % 28 + 1)) "$i"; done \
  > "$VAULT/skills/bullets.learnings.md"
if [ "$(count_of bullets)" = "31" ]; then ok "dated bullets count as entries"; else no "dated bullets counted $(count_of bullets)"; fi
assert_empty "no learnings file prints no count"          "$(count_of no-such-skill)"
assert_empty "a slash in the name prints no count"        "$(count_of '../secret')"
assert_empty "a leading dot in the name prints no count"  "$(count_of '.hidden')"
assert_empty "an empty name prints no count"              "$(count_of 'plugin:')"

echo "a file too large for one hook message is pointed at, never truncated:"
{ entries 5; head -c 12000 /dev/zero | tr '\0' 'x'; printf '\nTAIL-CANARY\n'; } > "$VAULT/skills/big.learnings.md"
CTX=$(context_of "$(run_hook big)")
assert_contains "the context names the file"      "$CTX" "skills/big.learnings.md"
assert_contains "it says to read the whole file"  "$CTX" "Read the whole file"
assert_missing  "no partial text is inlined"      "$CTX" "xxxxxxxxxx"
if [ "${#CTX}" -lt 9000 ]; then ok "the pointer fits one hook message"; else no "the pointer is ${#CTX} characters"; fi
# The memory MCP's read tool takes a vault-relative path, never an absolute one.
assert_missing  "the pointer carries no absolute path" "$CTX" "$VAULT/"

echo "the budget is the JSON the hook prints, not the file:"
# Short lines under a byte budget still grow past it once every newline and
# quote is escaped. An 8,944-byte file with 146 entries once printed 10,686
# characters, past Claude Code's 10,000-character hook limit, so its tail was cut.
for i in $(seq 1 146); do printf '## "e%d"\n"q" \\ x\n\n' "$i"; done > "$VAULT/skills/escaped.learnings.md"
while [ "$(wc -c < "$VAULT/skills/escaped.learnings.md")" -lt 8900 ]; do
  printf '"\n' >> "$VAULT/skills/escaped.learnings.md"
done
FILE_BYTES=$(wc -c < "$VAULT/skills/escaped.learnings.md" | tr -d ' ')
OUT=$(run_hook escaped)
if [ "$FILE_BYTES" -lt 9000 ] && [ "${#OUT}" -le 9000 ]; then
  ok "a ${FILE_BYTES}-byte file prints ${#OUT} characters, inside the budget"
else
  no "a ${FILE_BYTES}-byte file printed ${#OUT} characters"
fi
assert_contains "it falls back to the pointer"   "$(context_of "$OUT")" "Read the whole file"
SMALL=$(run_hook memory-lint)
if [ "${#SMALL}" -le 9000 ]; then ok "a small file is still inlined within the budget"; else no "a small file printed ${#SMALL} characters"; fi

echo "a skill name cannot leave the skills folder:"
mkdir -p "$SANDBOX/vault/secret"
printf 'SECRET-CANARY\n' > "$SANDBOX/vault/secret.learnings.md"
assert_empty "a slash is refused"      "$(run_hook '../secret')"
assert_empty "a leading dot is refused" "$(run_hook '..')"
assert_empty "an empty name is silent" "$(run_hook 'plugin:')"
# The status line's count reads the same folder, under the same rule.
assert_empty "the count script refuses a slash"      "$(count_of '../secret')"
assert_empty "the count script refuses a leading dot" "$(count_of '..')"

echo "the hook is registered on the Skill tool:"
if jq -e '[.hooks.PreToolUse[] | select(.matcher == "Skill") | .hooks[].command | select(test("skill-learnings.sh"))] | length == 1' \
  "$ROOT/hooks/hooks.json" >/dev/null; then ok "hooks.json registers it once on Skill"; else no "hooks.json does not register it on Skill"; fi

echo "no skill or warmup text restates the protocol the hook replaced:"
STALE=$(grep -rlE 'execution-aware skill|skills-protocol|Skills protocol:' \
  "$ROOT/skills" "$ROOT/hooks/session-warmup.sh" 2>/dev/null)
if [ -z "$STALE" ]; then ok "no restatement left"; else no "still restated in: $(echo "$STALE" | tr '\n' ' ')"; fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
