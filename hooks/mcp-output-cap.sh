#!/usr/bin/env bash
#
# mcp-output-cap: a generic context-cost backstop for MCP tool responses.
#
# Invoked by the `core` plugin's PostToolUse hook with a `^mcp__` matcher, so it
# sees EVERY MCP tool call in the session regardless of which server or plugin
# owns the tool — including vendored third-party servers whose code we do not
# control and cannot ask to behave. That universal reach is the whole point:
# per-server limits (see docs/mcp-output-capping.md) produce better-shaped
# results, but only for servers whose authors opted in.
#
# MECHANISM. PostToolUse hook output supports `updatedToolOutput`, documented by
# the harness as "Replaces the tool output before it is sent to the model". The
# tool has already run — this does not save the server any work, it saves the
# CONTEXT. The replacement is in place: no block-and-resubmit, no re-execution.
#
# WHY A CAP HERE WHEN THE HARNESS ALREADY HAS ONE. Claude Code enforces
# MAX_MCP_OUTPUT_TOKENS and, on overflow, persists the result to a file and
# swaps in a pointer. Read out of the 2.1.219 binary, its real numbers are:
#
#   limit            25,000 tokens         (Om_, overridable by the env var)
#   size estimate    round(chars / 4)      (B_, plus 1,600 tokens per image)
#   cheap fast-path  estimate <= 50% limit (Dm_=0.5) → returned untouched
#   ⇒ anything under ~50,000 chars is never even measured properly
#   ⇒ persistence effectively begins around 100,000 chars (HVe = limit * 4)
#
# That covers the catastrophic case, and it happens during the MCP tool call —
# BEFORE PostToolUse hooks observe `tool_response` — so a genuinely huge result
# reaches this hook already replaced by the harness's own pointer. The band this
# hook actually governs is therefore roughly 0–100 KB.
#
# The default cap of 60,000 bytes lands at ~15,000 estimated tokens — above the
# 10,000-token point where Claude Code itself starts warning "Large MCP response
# (~N tokens), this can fill up context quickly" (bhb=1e4), and below its 25,000
# persistence limit. It was chosen empirically: across 2,762 recorded MCP calls
# in the dev-team pipeline the largest response was 40,986 bytes (median 53), so
# 60,000 clears all observed real traffic with headroom while still cutting the
# unbounded dumps this hook exists for.
#
# Note that at this size the two layers can start to meet: 60,000 chars is past
# the harness's 50,000-char fast path, so it runs its real tokenizer, and dense
# JSON tokenizes nearer 2 chars/token than 4. If the harness decides to persist
# first, this hook simply sees the resulting pointer and passes it through. Both
# layers do the same thing — persist and point — so overlap is harmless.
#
# EXEMPTIONS — deliberate caps are not sloppiness. Some servers set a large
# ceiling ON PURPOSE and raise rather than truncate when it is exceeded, which
# is the correct design (see docs/mcp-output-capping.md). markdown-vault-mcp,
# behind this plugin's own memory MCP, allows .md reads up to 262,144 bytes
# (MARKDOWN_VAULT_MCP_MAX_NOTE_READ_BYTES). Session logs and synthesis notes
# routinely sit in the 60 KB–256 KB range, and byte-truncating one would destroy
# a document the server deliberately chose to return whole — while this hook's
# own doc argues servers should do exactly what that one is doing.
#
# So tool names matching WORKBENCH_MCP_OUTPUT_EXEMPT are never capped. The
# discriminator has to be the tool name: the harness's own "this server declared
# its result size" signal (hasResultSizeAnnotation) lives on the tool definition
# and is not present in the PostToolUse payload, which carries only tool_name,
# tool_input, tool_response, and tool_use_id.
#
# This does NOT reintroduce per-plugin opt-in. The exemption list is maintained
# HERE, in core, and an unknown third-party server — the case this hook exists
# for — is still capped by default without anyone doing anything.
#
# NOTHING IS EVER LOST. Like the harness's own overflow path, the full response
# is written to a file first and the replacement points at it. If that write
# fails, the hook emits NOTHING and the original untruncated response passes
# through — truncating without a recoverable copy would be data loss, so the
# only acceptable failure here is to not truncate.
#
# SHAPES IT REFUSES TO TOUCH. A response is capped only when it is an all-text
# MCP content-block array or a bare string. Anything else — a content array with
# an image or resource block, an object shape we do not recognise — passes
# through untouched. Replacing a shape we do not understand would corrupt the
# tool result, which is worse than the cost it saves.
#
# Env knobs:
#   WORKBENCH_MCP_OUTPUT_CAP=0          → disable entirely.
#   WORKBENCH_MCP_OUTPUT_MAX_BYTES=N    → cap in bytes (default 60000, ~15k
#                                         tokens). Values under 1024 are
#                                         rejected as a footgun and fall back
#                                         to the default.
#   WORKBENCH_MCP_OUTPUT_DIR=DIR        → where full responses are persisted.
#   WORKBENCH_MCP_OUTPUT_EXEMPT=REGEX   → tool names never capped. Default
#                                         exempts the memory vault's `read`,
#                                         whose 256 KB ceiling is deliberate.
#                                         Set empty to exempt nothing.
#
# Never fails the session. Always exits 0, and every failure path emits nothing
# (which the harness treats as "leave the tool output alone"). A hook that times
# out has its output discarded by the harness, which lands in the same place:
# the original response passes through uncapped.

set -u

# ──────────── Disable switch ────────────
if [ "${WORKBENCH_MCP_OUTPUT_CAP:-}" = "0" ]; then
  exit 0
fi

# ──────────── Read hook payload ────────────
# PostToolUse delivers JSON on stdin:
#   {session_id, cwd, hook_event_name, tool_name, tool_input, tool_response,
#    tool_use_id, duration_ms}
PAYLOAD=""
if [ ! -t 0 ]; then
  PAYLOAD=$(cat)
fi
[ -n "$PAYLOAD" ] || exit 0

command -v jq >/dev/null 2>&1 || exit 0

TOOL_NAME=$(printf '%s' "$PAYLOAD" | jq -r '.tool_name // empty' 2>/dev/null)
TOOL_USE_ID=$(printf '%s' "$PAYLOAD" | jq -r '.tool_use_id // empty' 2>/dev/null)
[ -n "$TOOL_NAME" ] || exit 0

# Defense in depth: the hooks.json matcher already restricts this to `^mcp__`,
# but a hand-edited settings.json could widen it. Built-in tools (Read, Bash,
# Grep) have their own harness-side limits and their own output shapes — never
# rewrite those.
case "$TOOL_NAME" in
  mcp__*) ;;
  *) exit 0 ;;
esac

# ──────────── Deliberate-cap exemptions ────────────
# Note the `-` (not `:-`) default: an explicitly empty value means "exempt
# nothing" and must be honored, whereas an unset variable takes the default.
EXEMPT="${WORKBENCH_MCP_OUTPUT_EXEMPT-^mcp__plugin_workbench-core_memory__read$}"
if [ -n "$EXEMPT" ] && printf '%s' "$TOOL_NAME" | grep -Eq "$EXEMPT" 2>/dev/null; then
  exit 0
fi

# ──────────── Cap resolution ────────────
MAX_BYTES="${WORKBENCH_MCP_OUTPUT_MAX_BYTES:-60000}"
case "$MAX_BYTES" in ''|*[!0-9]*) MAX_BYTES=60000 ;; esac
# A cap of a few bytes would shred every response into a file pointer. Treat an
# absurd value as misconfiguration and use the default rather than honoring it.
[ "$MAX_BYTES" -lt 1024 ] && MAX_BYTES=60000

# ──────────── Extract the cappable text, or bail ────────────
# SHAPE records what we found so the replacement preserves it. `empty` output
# from jq (unrecognised shape) leaves both vars empty and we pass through.
SHAPE=$(printf '%s' "$PAYLOAD" | jq -r '
  .tool_response as $r
  | if ($r | type) == "array"
       and ($r | length) > 0
       and (all($r[]; (type == "object") and (.type? == "text")))
    then "array"
    elif ($r | type) == "string" then "string"
    else empty end
' 2>/dev/null)
[ -n "$SHAPE" ] || exit 0

TEXT=$(printf '%s' "$PAYLOAD" | jq -r '
  .tool_response as $r
  | if ($r | type) == "array" then ($r | map(.text // "") | join(""))
    else $r end
' 2>/dev/null)
[ -n "$TEXT" ] || exit 0

SIZE=$(printf '%s' "$TEXT" | wc -c | tr -d ' ')
case "$SIZE" in ''|*[!0-9]*) exit 0 ;; esac

# Under the cap — the overwhelmingly common path. Emit nothing, touch nothing.
if [ "$SIZE" -le "$MAX_BYTES" ]; then
  exit 0
fi

# ──────────── Persist the full response BEFORE truncating ────────────
OUT_DIR="${WORKBENCH_MCP_OUTPUT_DIR:-$HOME/.claude-workbench/mcp-output}"
mkdir -p "$OUT_DIR" 2>/dev/null || exit 0

# Retention sweep, mirroring the convention in memory-recall.sh and
# session-warmup.sh: these files are a short-lived escape hatch, not an archive.
find "$OUT_DIR" -type f -mtime +3 -delete 2>/dev/null

# Never trust an external id in a path.
SAFE_ID=$(printf '%s' "${TOOL_USE_ID:-unknown}" | tr -c 'A-Za-z0-9._-' '_')
FULL_FILE="$OUT_DIR/${SAFE_ID}.txt"

printf '%s' "$TEXT" > "$FULL_FILE" 2>/dev/null || exit 0
# Verify what landed on disk: a partial write (full disk, quota) would make the
# pointer a lie and the truncation destructive.
WRITTEN=$(wc -c < "$FULL_FILE" 2>/dev/null | tr -d ' ')
if [ "$WRITTEN" != "$SIZE" ]; then
  rm -f "$FULL_FILE" 2>/dev/null
  exit 0
fi

# ──────────── Emit the capped replacement ────────────
# Truncation happens inside jq, which slices by codepoint. Slicing bytes here
# could split a multibyte character and produce invalid UTF-8 that jq then
# refuses to encode. MAX_BYTES codepoints is always <= MAX_BYTES bytes, so this
# errs slightly under the cap — the safe direction.
NOTICE=$(printf '\n\n---\n[workbench-core] This %s response was %s bytes; the cap is %s (WORKBENCH_MCP_OUTPUT_MAX_BYTES). The text above is the truncated head.\nFULL, UNTRUNCATED output: %s\nRead that file with offset/limit, grep it, or jq it for the parts you need. Better still: if %s accepts pagination, filter, or limit parameters, call it again with those rather than reading the whole file back into context.' \
  "$TOOL_NAME" "$SIZE" "$MAX_BYTES" "$FULL_FILE" "$TOOL_NAME")

if [ "$SHAPE" = "array" ]; then
  jq -cn --arg text "$TEXT" --argjson keep "$MAX_BYTES" --arg notice "$NOTICE" \
    '{hookSpecificOutput: {hookEventName: "PostToolUse",
      updatedToolOutput: [{type: "text", text: (($text[:$keep]) + $notice)}]}}' \
    2>/dev/null || true
else
  jq -cn --arg text "$TEXT" --argjson keep "$MAX_BYTES" --arg notice "$NOTICE" \
    '{hookSpecificOutput: {hookEventName: "PostToolUse",
      updatedToolOutput: (($text[:$keep]) + $notice)}}' \
    2>/dev/null || true
fi

exit 0
