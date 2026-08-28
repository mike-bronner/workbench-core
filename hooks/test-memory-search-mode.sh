#!/bin/bash
# Tests for memory-search-mode.sh. Run directly: ./test-memory-search-mode.sh
#
# The hook is a PreToolUse middleware that injects mode="hybrid" into memory
# vault `search` calls that omit it. It must never touch an explicit mode, never
# touch another tool, and never block anything.

set -u
HOOK="$(cd "$(dirname "$0")" && pwd)/memory-search-mode.sh"
PASS=0
FAIL=0

# Run the hook with a synthetic PreToolUse payload.
#   $1 = tool_name
#   $2 = tool_input as a JSON object string
#   $3 = WORKBENCH_MEMORY_SEARCH_MODE value ("" leaves it unset)
# Prints the hook's stdout.
run_hook() {
  local tool="$1" input="$2" mode="${3:-}"
  local payload
  payload=$(jq -cn --arg t "$tool" --argjson i "$input" \
    '{tool_name:$t, tool_input:$i}')
  if [ -n "$mode" ]; then
    printf '%s' "$payload" | WORKBENCH_MEMORY_SEARCH_MODE="$mode" bash "$HOOK" 2>/dev/null
  else
    printf '%s' "$payload" | env -u WORKBENCH_MEMORY_SEARCH_MODE bash "$HOOK" 2>/dev/null
  fi
}

ok()   { PASS=$((PASS + 1)); echo "  ✅ $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "  ❌ $1 — $2"; }

# Assert the hook injected exactly this mode.
assert_injects() {
  local desc="$1" tool="$2" input="$3" want="$4" envmode="${5:-}"
  local out got
  out=$(run_hook "$tool" "$input" "$envmode")
  got=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedInput.mode // empty' 2>/dev/null)
  if [ "$got" = "$want" ]; then ok "$desc"; else bad "$desc" "expected mode=$want, got '${got:-<no output>}'"; fi
}

# Assert the hook stayed silent (no opinion → server default applies).
assert_silent() {
  local desc="$1" tool="$2" input="$3" envmode="${4:-}"
  local out
  out=$(run_hook "$tool" "$input" "$envmode")
  if [ -z "$out" ]; then ok "$desc"; else bad "$desc" "expected no output, got: $out"; fi
}

echo "memory-search-mode.sh"

# --- the thing the hook exists to do -------------------------------------
assert_injects "injects hybrid when mode is omitted" \
  "mcp__plugin_workbench-core_memory__search" '{"query":"orphan"}' "hybrid"

assert_injects "injects hybrid regardless of MCP server name" \
  "mcp__workbench-memory__search" '{"query":"orphan"}' "hybrid"

assert_injects "injects when mode is explicitly null" \
  "mcp__plugin_workbench-core_memory__search" '{"query":"o","mode":null}' "hybrid"

# --- an explicit mode is a choice, not a gap -----------------------------
for m in keyword semantic hybrid; do
  assert_silent "leaves an explicit mode=$m untouched" \
    "mcp__plugin_workbench-core_memory__search" "{\"query\":\"o\",\"mode\":\"$m\"}"
done

# --- scope: only the memory vault's own search ---------------------------
assert_silent "ignores a different server's search tool" \
  "mcp__the-index__search" '{"query":"o"}'
assert_silent "ignores a sibling memory tool with no mode param" \
  "mcp__plugin_workbench-core_memory__read" '{"path":"a.md"}'
assert_silent "ignores a non-MCP tool" \
  "Bash" '{"command":"ls"}'

# --- the escape hatch ----------------------------------------------------
assert_silent "off disables the hook entirely" \
  "mcp__plugin_workbench-core_memory__search" '{"query":"o"}' "off"
assert_injects "honours an overridden mode" \
  "mcp__plugin_workbench-core_memory__search" '{"query":"o"}' "semantic" "semantic"

# --- fail-open: never block a search -------------------------------------
out=$(printf 'not json at all' | bash "$HOOK" 2>/dev/null); rc=$?
if [ "$rc" -eq 0 ] && [ -z "$out" ]; then ok "malformed payload fails open"
else bad "malformed payload fails open" "rc=$rc out='$out'"; fi

out=$(printf '' | bash "$HOOK" 2>/dev/null); rc=$?
if [ "$rc" -eq 0 ] && [ -z "$out" ]; then ok "empty payload fails open"
else bad "empty payload fails open" "rc=$rc out='$out'"; fi

# --- the rewrite must preserve every other argument ----------------------
out=$(run_hook "mcp__plugin_workbench-core_memory__search" \
      '{"query":"orphan","limit":3,"folder":"insights"}')
q=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedInput.query // empty')
l=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedInput.limit // empty')
f=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.updatedInput.folder // empty')
if [ "$q" = "orphan" ] && [ "$l" = "3" ] && [ "$f" = "insights" ]; then
  ok "preserves the caller's other arguments"
else
  bad "preserves the caller's other arguments" "query='$q' limit='$l' folder='$f'"
fi

# --- the envelope must be the shape Claude Code expects ------------------
out=$(run_hook "mcp__plugin_workbench-core_memory__search" '{"query":"o"}')
ev=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.hookEventName // empty')
pd=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // empty')
if [ "$ev" = "PreToolUse" ] && [ "$pd" = "allow" ]; then
  ok "emits a PreToolUse/allow envelope"
else
  bad "emits a PreToolUse/allow envelope" "hookEventName='$ev' permissionDecision='$pd'"
fi

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
