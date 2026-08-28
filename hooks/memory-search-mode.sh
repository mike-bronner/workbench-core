#!/usr/bin/env bash
#
# memory-search-mode: PreToolUse hook that fills in the vault search mode.
#
# The memory MCP's `search` tool defaults to mode="keyword" (FTS5/BM25). For a
# vault of curated prose that is the wrong default: BM25 answers term queries
# well but conversational ones badly. Measured on this vault (3,476 documents,
# embeddings configured), asking the questions an agent actually asks:
#
#   "how should agents handle a fork of someone else's repo"   keyword 0, hybrid 5
#   "what is the rule about committing without approval"        keyword 0, hybrid 5
#   "why do vault searches return nothing"                      keyword 1, hybrid 5
#   "memory-lint orphan"            (term query)                keyword 5, hybrid 5
#
# Three separate instructions already tell callers to prefer hybrid — the
# server's own MCP instructions, references/linking-synthesis.md Step A, and
# references/memory-routing-stub.md. All three are advisory, and callers still
# omit `mode` and land on keyword. This hook stops asking and rewrites the call.
#
# It only ever ADDS `mode` when the caller omitted it. An explicit
# mode="keyword" (or semantic, or hybrid) passes through untouched — a caller
# who names a mode meant it.
#
# Escape hatch: WORKBENCH_MEMORY_SEARCH_MODE
#   unset / empty  → "hybrid" (the default this hook exists to apply)
#   "off"          → no-op; every search runs the server's own default
#   any mode name  → injected instead of hybrid
#
# Fail-open by design: a malformed payload, missing jq, or any internal error
# emits nothing and exits 0, which Claude Code reads as "no opinion". A hook
# that cannot parse its input must never block a search.
#
# Exit codes: always 0. This hook allows or abstains; it never denies.

set -u

MODE="${WORKBENCH_MEMORY_SEARCH_MODE:-hybrid}"
[ "$MODE" = "off" ] && exit 0

PAYLOAD=""
if [ ! -t 0 ]; then
  PAYLOAD=$(cat)
fi
[ -n "$PAYLOAD" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

TOOL=$(printf '%s' "$PAYLOAD" | jq -r '.tool_name // empty' 2>/dev/null)

# Re-check the tool name here rather than trusting the hooks.json matcher alone.
# The matcher is a convenience; this is the contract. Only the memory vault's
# own `search` tool is rewritten — never another server's search, and never a
# sibling memory tool that has no `mode` parameter.
case "$TOOL" in
  mcp__*memory__search) ;;
  *) exit 0 ;;
esac

# Absent OR explicitly null both mean "caller expressed no preference".
# `has("mode")` alone would treat an explicit null as a choice; it isn't one.
EXISTING=$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.mode // empty' 2>/dev/null)
[ -z "$EXISTING" ] || exit 0

UPDATED=$(printf '%s' "$PAYLOAD" \
  | jq -c --arg m "$MODE" \
      '.tool_input + {mode: $m}' 2>/dev/null)
[ -n "$UPDATED" ] || exit 0

jq -cn --argjson input "$UPDATED" \
  '{hookSpecificOutput: {hookEventName: "PreToolUse",
                         permissionDecision: "allow",
                         updatedInput: $input}}'
