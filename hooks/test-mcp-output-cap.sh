#!/bin/bash
# Tests for mcp-output-cap.sh. Run directly: ./test-mcp-output-cap.sh
# Each case feeds a synthetic PostToolUse payload on stdin inside a sandbox and
# asserts whether the tool output is replaced, that the replacement is actually
# smaller, that the full response is recoverable from disk, and that every
# failure or unrecognised-shape path passes the original through untouched.

set -u
HOOK="$(cd "$(dirname "$0")" && pwd)/mcp-output-cap.sh"
PASS=0
FAIL=0

SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT
OUT_DIR="$SANDBOX/mcp-output"

# NOTHING BIG GOES THROUGH ARGV. The payloads here are deliberately larger than
# anything a command line will carry: Linux caps a single argv entry at
# MAX_ARG_STRLEN (32 pages = 131,072 bytes), so `jq --arg s "$(head -c 262144 …)"`
# dies with "Argument list too long" — and a scaffold that dies during setup
# hands the hook an empty payload, which silently satisfies every assert_empty.
# That is how a real fail-open in the hook itself hid here. So: big values reach
# jq through a FILE (--rawfile / --slurpfile) and reach a file through printf,
# which is a bash builtin and never execs.
FILL_N=0

# fill: write exactly N bytes of 'x' to a file, echo its path.
fill() {
  local path="$SANDBOX/fill-$((FILL_N += 1)).txt"
  head -c "$1" /dev/zero | tr '\0' 'x' > "$path"
  printf '%s' "$path"
}

# run: pipe a PostToolUse payload into the hook.
# Args: <tool_name> <tool_response JSON> <tool_use_id> [extra env assignments...]
run() {
  local tool="$1" response="$2" tuid="$3"; shift 3
  local rfile="$SANDBOX/response-$tuid.json"
  printf '%s' "$response" > "$rfile"
  jq -cn --arg t "$tool" --slurpfile r "$rfile" --arg id "$tuid" \
    '{hook_event_name:"PostToolUse", tool_name:$t, tool_input:{}, tool_response:$r[0], tool_use_id:$id}' \
    | env HOME="$SANDBOX/home" WORKBENCH_MCP_OUTPUT_DIR="$OUT_DIR" "$@" bash "$HOOK" 2>/dev/null
}

# Build a text content-block array whose text is exactly N bytes of 'x'.
blob() { jq -cn --rawfile s "$(fill "$1")" '[{type:"text",text:$s}]'; }

assert_empty() {
  local desc="$1" got="$2"
  if [ -z "$got" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected no output, got: ${got:0:160}"
  fi
}
assert_contains() {
  local desc="$1" got="$2" needle="$3"
  case "$got" in
    *"$needle"*) PASS=$((PASS + 1)); echo "  ✅ $desc" ;;
    *) FAIL=$((FAIL + 1)); echo "  ❌ $desc — missing '$needle' in: ${got:0:160}" ;;
  esac
}
ok() { PASS=$((PASS + 1)); echo "  ✅ $1"; }
no() { FAIL=$((FAIL + 1)); echo "  ❌ $1"; }

# ─────────────────────────────────────────────────────────────────────────────
echo "Under the cap — response passes through untouched:"
GOT=$(run "mcp__the-index__list_review_items" "$(blob 500)" tu-small)
assert_empty "small response emits nothing" "$GOT"
GOT=$(run "mcp__x__y" "$(blob 60000)" tu-exact)
assert_empty "response exactly at the cap is not truncated" "$GOT"
# One byte over must flip it — pins the boundary from both sides.
GOT=$(run "mcp__x__y" "$(blob 60001)" tu-over-by-one)
assert_contains "one byte over the cap is truncated" "$GOT" '"updatedToolOutput"'

echo "Over the cap — response is replaced and shrunk:"
# A third-party server with no deliberate cap of its own — the case this hook
# exists for. (Deliberately NOT the memory vault's `read`, which is exempt; see
# the regression section below.)
GOT=$(run "mcp__ynab__list_transactions" "$(blob 120000)" tu-big)
assert_contains "emits a PostToolUse hookSpecificOutput" "$GOT" '"hookEventName":"PostToolUse"'
assert_contains "uses updatedToolOutput"                 "$GOT" '"updatedToolOutput"'
assert_contains "explains the truncation"                "$GOT" "workbench-core] This mcp__ynab__list_transactions response was 120000 bytes"
assert_contains "preserves the content-block shape"      "$GOT" '"type":"text"'

# The point of the whole exercise: the replacement must actually be smaller.
NEW_LEN=$(printf '%s' "$GOT" | jq -r '.hookSpecificOutput.updatedToolOutput[0].text | length' 2>/dev/null)
if [ -n "$NEW_LEN" ] && [ "$NEW_LEN" -lt 120000 ] && [ "$NEW_LEN" -gt 60000 ]; then
  ok "replacement is capped (${NEW_LEN} chars: cap + notice, well under 120000)"
else
  no "replacement length wrong — got '${NEW_LEN}', want between 60000 and 120000"
fi

echo "Nothing is lost — the full response is recoverable from disk:"
if [ -f "$OUT_DIR/tu-big.txt" ]; then
  ok "full response persisted under the tool_use_id"
  DISK=$(wc -c < "$OUT_DIR/tu-big.txt" | tr -d ' ')
  [ "$DISK" = "120000" ] && ok "persisted copy is byte-complete (120000)" \
                         || no "persisted copy truncated — $DISK bytes"
  assert_contains "replacement points at the persisted file" "$GOT" "$OUT_DIR/tu-big.txt"
else
  no "full response was not persisted"
fi

echo "Persist failure — passes through rather than truncating destructively:"
# An unwritable output dir must NOT produce a truncation: losing data is worse
# than the context cost this hook exists to save.
BAD_DIR="$SANDBOX/readonly"
mkdir -p "$BAD_DIR"; chmod 500 "$BAD_DIR"
GOT=$(jq -cn --rawfile s "$(fill 120000)" \
  '{hook_event_name:"PostToolUse", tool_name:"mcp__x__y", tool_input:{},
    tool_response:[{type:"text",text:$s}], tool_use_id:"tu-ro"}' \
  | env HOME="$SANDBOX/home" WORKBENCH_MCP_OUTPUT_DIR="$BAD_DIR/nested" bash "$HOOK" 2>/dev/null)
assert_empty "unwritable output dir → no truncation" "$GOT"
chmod 700 "$BAD_DIR"

# ─────────────────────────────────────────────────────────────────────────────
# REGRESSION: responses past the kernel's argv ceiling must still be capped.
# The hook used to hand the response text to jq as `--arg text "$TEXT"`. Linux
# caps a single argv entry at MAX_ARG_STRLEN (32 pages = 131,072 bytes) and
# macOS caps the whole argument block at ARG_MAX (1 MiB), so past that ceiling
# the exec failed with E2BIG, the `2>/dev/null || true` swallowed it, and the
# hook emitted nothing — which the harness reads as "leave the tool output
# alone". It failed open on precisely the oversized responses it exists to cut,
# and orphaned the full copy it had already written to disk.
#
# End-to-end, not just "some output appeared": each size below must produce a
# replacement that is actually the capped head, and leave the complete original
# recoverable. 262144 clears the Linux ceiling, 1200000 clears macOS's too, so
# a regression fails on either platform rather than only in CI.
echo "REGRESSION — responses past the kernel argv ceiling are still capped:"
for size in 262144 1200000; do
  GOT=$(run "mcp__ynab__list_transactions" "$(blob "$size")" "tu-argv-$size")
  assert_contains "${size}-byte response is capped" "$GOT" '"updatedToolOutput"'
  NEW_LEN=$(printf '%s' "$GOT" | jq -r '.hookSpecificOutput.updatedToolOutput[0].text | length' 2>/dev/null)
  # Just over the cap: the 60000-char head plus the ~500-char notice. An upper
  # bound of 62000 is what makes this discriminating — a hook that passed the
  # whole response through would land at $size, not just past 60000.
  if [ -n "$NEW_LEN" ] && [ "$NEW_LEN" -gt 60000 ] && [ "$NEW_LEN" -lt 62000 ]; then
    ok "${size}-byte replacement is the capped head plus notice (${NEW_LEN} chars)"
  else
    no "${size}-byte replacement length wrong — got '${NEW_LEN}', want just over 60000"
  fi
  DISK=$(wc -c < "$OUT_DIR/tu-argv-$size.txt" 2>/dev/null | tr -d ' ')
  [ "$DISK" = "$size" ] && ok "all $size bytes stay recoverable from disk" \
                        || no "persisted copy is '$DISK' bytes, want $size"
  assert_contains "${size}-byte replacement points at the persisted file" \
    "$GOT" "$OUT_DIR/tu-argv-$size.txt"
done

# ─────────────────────────────────────────────────────────────────────────────
# REGRESSION: markdown-vault-mcp deliberately allows .md reads up to 262,144
# bytes (MARKDOWN_VAULT_MCP_MAX_NOTE_READ_BYTES, reader.py). That ceiling is a
# design decision — "raise the limit, don't truncate" — and byte-truncating a
# note the server chose to return whole would contradict the very standard
# docs/mcp-output-capping.md sets out. Session logs and synthesis notes in the
# 60 KB–256 KB range are ordinary in this vault, so this is a live case, not a
# hypothetical.
echo "REGRESSION — a 256KB memory-vault read passes through untouched:"
GOT=$(run "mcp__plugin_workbench-core_memory__read" "$(blob 262144)" tu-vault-ceiling)
assert_empty "note read at markdown-vault-mcp's 262144-byte ceiling is not capped" "$GOT"
if [ ! -f "$OUT_DIR/tu-vault-ceiling.txt" ]; then
  ok "exempt tool is not persisted to disk either"
else
  no "exempt tool was persisted — it should have been skipped outright"
fi
# Mid-band too: the conflict is worst between the default cap and the harness's
# own ~100KB effective persistence point, where nothing else would truncate.
# Sized above the default so this stays a real test of the exemption rather than
# passing merely because the response is under the cap.
GOT=$(run "mcp__plugin_workbench-core_memory__read" "$(blob 80000)" tu-vault-mid)
assert_empty "80KB note read (over the default cap) is not capped" "$GOT"

echo "The exemption is specific, not a blanket:"
# Same size, different tool — a server with no deliberate cap must still be cut.
GOT=$(run "mcp__ynab__list_transactions" "$(blob 262144)" tu-notexempt)
assert_contains "non-exempt tool at 262144 bytes is still capped" "$GOT" '"updatedToolOutput"'
# Sibling tools on the exempt server are NOT exempt — `search` is bounded by
# design and has no business returning 256KB.
GOT=$(run "mcp__plugin_workbench-core_memory__search" "$(blob 262144)" tu-sibling)
assert_contains "sibling tool on the same server is still capped" "$GOT" '"updatedToolOutput"'
GOT=$(run "mcp__plugin_workbench-core_memory__read_attachment" "$(blob 262144)" tu-prefix)
assert_contains "anchored regex does not leak to prefix-matching names" "$GOT" '"updatedToolOutput"'

echo "Exemption list is configurable:"
GOT=$(run "mcp__ynab__list_transactions" "$(blob 120000)" tu-customex WORKBENCH_MCP_OUTPUT_EXEMPT='^mcp__ynab__')
assert_empty "custom exempt regex suppresses capping" "$GOT"
GOT=$(run "mcp__plugin_workbench-core_memory__read" "$(blob 120000)" tu-noex WORKBENCH_MCP_OUTPUT_EXEMPT=)
assert_contains "empty exempt regex exempts nothing" "$GOT" '"updatedToolOutput"'

echo "Shapes it refuses to touch:"
# An image block would be destroyed by replacement with text.
MIXED=$(jq -cn --rawfile s "$(fill 120000)" \
  '[{type:"text",text:$s},{type:"image",source:{type:"base64",data:"AAAA"}}]')
GOT=$(run "mcp__x__y" "$MIXED" tu-img)
assert_empty "content array containing a non-text block passes through" "$GOT"
GOT=$(run "mcp__x__y" '{"some":"object","shape":"unrecognised"}' tu-obj)
assert_empty "unrecognised object shape passes through" "$GOT"
GOT=$(run "mcp__x__y" '[]' tu-empty)
assert_empty "empty content array passes through" "$GOT"

echo "Bare-string responses are capped in kind (shape preserved):"
BIGSTR=$(jq -cn --rawfile s "$(fill 120000)" '$s')
GOT=$(run "mcp__x__y" "$BIGSTR" tu-str)
STR_TYPE=$(printf '%s' "$GOT" | jq -r '.hookSpecificOutput.updatedToolOutput | type' 2>/dev/null)
[ "$STR_TYPE" = "string" ] && ok "string response replaced with a string, not an array" \
                           || no "string response shape changed to '$STR_TYPE'"

echo "Scope — non-MCP tools are never rewritten:"
GOT=$(run "Bash" "$(blob 120000)" tu-bash)
assert_empty "built-in tool passes through even when oversized" "$GOT"
GOT=$(run "Read" "$(blob 120000)" tu-read)
assert_empty "Read passes through even when oversized" "$GOT"

echo "Disable switch and cap override:"
GOT=$(run "mcp__x__y" "$(blob 120000)" tu-off WORKBENCH_MCP_OUTPUT_CAP=0)
assert_empty "WORKBENCH_MCP_OUTPUT_CAP=0 disables the hook" "$GOT"
GOT=$(run "mcp__x__y" "$(blob 5000)" tu-lowcap WORKBENCH_MCP_OUTPUT_MAX_BYTES=2048)
assert_contains "a lower cap truncates a response the default would allow" "$GOT" '"updatedToolOutput"'
# A footgun cap must fall back to the default rather than shredding everything.
GOT=$(run "mcp__x__y" "$(blob 5000)" tu-tinycap WORKBENCH_MCP_OUTPUT_MAX_BYTES=8)
assert_empty "absurd cap (<1024) falls back to the default" "$GOT"
GOT=$(run "mcp__x__y" "$(blob 5000)" tu-junkcap WORKBENCH_MCP_OUTPUT_MAX_BYTES=banana)
assert_empty "non-numeric cap falls back to the default" "$GOT"
# Sized so the fallback VALUE matters, not just that some fallback happened:
# 50000 is under the 60000 default and over the previous 40000 one, so a
# fallback left at a stale number fails here instead of passing silently.
GOT=$(run "mcp__x__y" "$(blob 50000)" tu-tinycap2 WORKBENCH_MCP_OUTPUT_MAX_BYTES=8)
assert_empty "absurd cap falls back to the CURRENT default, not a stale one" "$GOT"
GOT=$(run "mcp__x__y" "$(blob 50000)" tu-junkcap2 WORKBENCH_MCP_OUTPUT_MAX_BYTES=banana)
assert_empty "non-numeric cap falls back to the CURRENT default, not a stale one" "$GOT"

echo "Malformed input fails open (never breaks the tool call):"
GOT=$(printf 'not json at all' | env HOME="$SANDBOX/home" WORKBENCH_MCP_OUTPUT_DIR="$OUT_DIR" bash "$HOOK" 2>/dev/null)
assert_empty "garbage payload → no-op" "$GOT"
GOT=$(printf '' | env HOME="$SANDBOX/home" WORKBENCH_MCP_OUTPUT_DIR="$OUT_DIR" bash "$HOOK" 2>/dev/null)
assert_empty "empty payload → no-op" "$GOT"
GOT=$(printf '{"hook_event_name":"PostToolUse"}' | env HOME="$SANDBOX/home" WORKBENCH_MCP_OUTPUT_DIR="$OUT_DIR" bash "$HOOK" 2>/dev/null)
assert_empty "payload with no tool_name → no-op" "$GOT"

echo "Exit code is always 0:"
if printf 'garbage' | env HOME="$SANDBOX/home" bash "$HOOK" >/dev/null 2>&1; then
  ok "exits 0 on malformed input"
else
  no "returned non-zero"
fi

# The harness discards a hook's output if it exceeds the hook timeout, which
# means a slow cap hook fails open — the original, uncapped response reaches the
# model. That is the harness's contract, not ours to enforce, but it makes our
# runtime a correctness concern rather than just a nicety: keep it far below any
# plausible timeout even on a large payload.
echo "Runtime stays far below any plausible hook timeout:"
START=$(date +%s)
GOT=$(run "mcp__x__y" "$(blob 400000)" tu-perf)
ELAPSED=$(( $(date +%s) - START ))
# Assert the work actually happened before timing it. A hook that bails out
# early is trivially fast, so timing alone would have called the argv-ceiling
# fail-open above a pass.
assert_contains "400KB payload is capped (not just fast because it no-opped)" \
  "$GOT" '"updatedToolOutput"'
if [ "$ELAPSED" -le 5 ]; then
  ok "400KB payload handled in ${ELAPSED}s (fails open only if it ever exceeds the timeout)"
else
  no "took ${ELAPSED}s on a 400KB payload — too close to timeout territory"
fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
