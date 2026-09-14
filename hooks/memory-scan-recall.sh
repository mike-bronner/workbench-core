#!/usr/bin/env bash
#
# memory-scan-recall: MID-TURN recall — the half of the loop a prompt hook
# cannot reach.
#
# memory-recall.sh searches the vault with the user's PROMPT, because a
# UserPromptSubmit hook receives the prompt and nothing else. So a topic the
# agent uncovers after the turn starts — while scanning the repo, following a
# trail the opening prompt never named — is never searched at all. This hook
# closes that: it rides along on a scan the agent is ALREADY running, searches
# the vault with that scan's own query, and injects any fresh hits as
# PostToolUse `additionalContext`, in the same turn, beside the scan's results.
#
# WHY THIS IS NOT A CLASSIFIER, WHICH IS THE WHOLE SAFETY ARGUMENT. It never
# judges whether a search is worthwhile. There is no "does this turn need a
# memory" question anywhere in it, so there is no precision-and-recall figure to
# degrade — the shape this codebase measured at 34% precision in
# agent-dispatch-gate.sh and has now rejected twice (vault:
# 2026-09-14-conditional-that-adds-versus-gates). What the matcher and
# lib/scan-query.py decide is narrower and purely structural: does this tool call
# CARRY a search query. No query means "there is none here", never "this one is
# not worth running". And memory-recall.sh stays the unconditional floor on every
# prompt, so a scan this hook misses costs one missed extra and never removes the
# mechanism.
#
# WHAT IT ATTACHES TO, AND WHY THAT IS Grep AND Bash BUT NOT Glob:
#   Grep   — the tool built for content search. Its `pattern` is the scan's query
#            verbatim, which is the strongest extraction available.
#   Bash   — not optional, and not a fallback. Grep and Glob are not granted to
#            every agent: in the session that commissioned this hook the agent
#            had NEITHER, and every repo scan it ran went through Bash. A
#            Grep-only matcher would have fired zero times there. Under Bash only
#            content searchers are read (`rg`, `grep`, `git grep`, `ag`, `ack`),
#            by argument SLOT rather than substring, so `git log --grep=` and
#            `npm test` carry no query and nothing fires.
#   Glob   — deliberately OUT. Its `pattern` is a path expression, so it names a
#            filename shape and not a topic: `**/*.test.ts` carries nothing at
#            all and `src/**/*.ts` carries two words of noise. The same goes for
#            `find -name` and `fd` under Bash. Each fire costs a permanently
#            persisted transcript record, so a matcher that mostly returns noise
#            is worse than one that stays quiet.
#
# COST, WHICH IS WHAT SHAPES EVERY LEVER BELOW. Measured 2026-09-14 (vault:
# 2026-09-14-posttooluse-additionalcontext-measured): every fire persists TWO
# transcript records, `hook_success` and `hook_additional_context`, and NOTHING
# evicts them — fire #1 was still present after five fires. Observed 225 to 1317
# bytes each; a realistic vault-hit payload implies ~500-600 bytes persisted per
# fire. That is the same accumulation property UserPromptSubmit has, and a
# per-turn nudge was removed from this codebase once already for exactly it. A
# tool call is far more frequent than a turn, so:
#   1. Per-session dedup on the MEMORY PATH — mandatory, not an optimization,
#      and SHARED with memory-recall.sh through one seen-file. Without it the
#      cost scales with the number of scans, which is unbounded. With it the
#      bound is the number of DISTINCT relevant memories, across both hooks: a
#      memory the opening prompt already surfaced is never repeated here.
#   2. Per-session dedup on the QUERY — the same scan repeated costs no
#      subprocess and no bytes. Path dedup alone would already suppress the
#      output, but only after paying ~1s of CLI time on every repeat, on the
#      critical path of a tool call.
#   3. Top-K of 1, against memory-recall.sh's 2. That hook fires once a turn;
#      this one can fire many times, so its per-fire payload is smaller.
#   4. Scheduled-task guard — an unattended tick has no human to serve, and its
#      fresh-per-tick session_id defeats levers 1 and 2 completely.
#
# Env knobs:
#   WORKBENCH_MEMORY_SCAN_RECALL=0            → disable entirely.
#   WORKBENCH_MEMORY_SCAN_RECALL_LIMIT=N      → max hits per fire (default 1).
#   WORKBENCH_MEMORY_SCAN_RECALL_MIN_CHARS=N  → min query length, spaces not
#                                               counted (default 6).
#   WORKBENCH_MEMORY_SCAN_RECALL_MODE=...     → search mode (default hybrid).
#   WORKBENCH_MEMORY_SCAN_RECALL_TIMEOUT=N    → watchdog seconds (default 8).
#   WORKBENCH_MEMORY_RECALL_STATE=DIR         → state dir. SHARED with
#                                               memory-recall.sh on purpose: one
#                                               seen-file is what makes lever 1
#                                               bound both hooks together.
#   WORKBENCH_MEMORY_SCAN_RECALL_TYPES=a,b    → eligible frontmatter types
#                                               (default in
#                                               lib/memory-recall-core.sh; set
#                                               empty to disable the filter).
#
# Also honors WORKBENCH_MEMORY_RECALL=0, which means "no automatic vault
# injection". Unlike memory-recall-nudge.sh, which is only ever a reminder and so
# stays independent, this hook DOES inject, so the global off switch has to reach
# it.
#
# Never fails a tool call. Always exits 0 — missing jq or python3, an
# unresolvable binary, a malformed payload, an unparseable command, or a
# subprocess that hangs past the watchdog all degrade to a silent no-op.

set -u

# install/vacuum-lib chatter must never touch stdout (this hook's stdout is
# either nothing or one additionalContext JSON block) — route it to stderr.
_memory_scan_recall_noop_log() { echo "memory-scan-recall: $*" >&2; }

# ──────────── Disable switches ────────────
if [ "${WORKBENCH_MEMORY_SCAN_RECALL:-}" = "0" ] \
    || [ "${WORKBENCH_MEMORY_RECALL:-}" = "0" ]; then
  exit 0
fi

# ──────────── Read hook payload ────────────
# PostToolUse delivers JSON on stdin. Measured keys (2026-09-14): cwd,
# duration_ms, effort, hook_event_name, permission_mode, prompt_id,
# scratchpad_dir, session_id, tool_input, tool_name, tool_response, tool_use_id,
# transcript_path. `tool_input` arrives intact. Note the result field is
# `tool_response`, NOT `tool_result`.
PAYLOAD=""
if [ ! -t 0 ]; then
  PAYLOAD=$(cat)
fi
[ -n "$PAYLOAD" ] || exit 0

command -v jq >/dev/null 2>&1 || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

TOOL=$(printf '%s' "$PAYLOAD" | jq -r '.tool_name // empty' 2>/dev/null)
SESSION_ID=$(printf '%s' "$PAYLOAD" | jq -r '.session_id // empty' 2>/dev/null)

# No session to key dedup state on → the accumulation bound cannot be honored,
# so nothing is injected. This fails closed on purpose: unbounded is the one
# outcome worth refusing.
[ -n "$SESSION_ID" ] || exit 0

# ──────────── Read this scan's own query out of the tool call ────────────
# Grep carries its pattern directly; Bash carries a whole command line that has
# to be read by argument slot. Both extractions live in lib/scan-query.py, which
# prints the query or prints nothing.
case "$TOOL" in
  Grep) RAW=$(printf '%s' "$PAYLOAD" | jq -r '(.tool_input // {}).pattern // empty' 2>/dev/null) ;;
  Bash) RAW=$(printf '%s' "$PAYLOAD" | jq -r '(.tool_input // {}).command // empty' 2>/dev/null) ;;
  *)    exit 0 ;;
esac
[ -n "$RAW" ] || exit 0

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTRACTOR="$HOOK_DIR/lib/scan-query.py"
[ -f "$EXTRACTOR" ] || exit 0

QUERY=$(printf '%s' "$RAW" | python3 "$EXTRACTOR" "$TOOL" 2>/dev/null)
[ -n "$QUERY" ] || exit 0

# shellcheck source=hooks/lib/memory-recall-core.sh
. "$HOOK_DIR/lib/memory-recall-core.sh" 2>/dev/null || exit 0

# ──────────── Substance gate on the extracted query ────────────
# This asks whether there is a QUERY here, never whether the query deserves a
# search. `rg 'it'`, `grep TODO`, and a bare numeric pattern reduce to nothing a
# prose vault can match; a version string or a line number is not a topic.
MIN_CHARS=$(memory_recall_int "${WORKBENCH_MEMORY_SCAN_RECALL_MIN_CHARS:-6}" 6)
_dense=$(printf '%s' "$QUERY" | tr -d ' ')
[ "${#_dense}" -ge "$MIN_CHARS" ] || exit 0
printf '%s' "$QUERY" | grep -q '[A-Za-z]' 2>/dev/null || exit 0

# ──────────── Per-session state ────────────
# The same dir and the same seen-file memory-recall.sh writes — that sharing IS
# the accumulation bound, not a convenience. Retention is 3 days, mirroring
# capture-nudge and the warmup sweep. The session id is sanitized before it
# becomes a filename: ids are normally hex/UUID, but an external value never
# belongs in a path unfiltered.
STATE_DIR="${WORKBENCH_MEMORY_RECALL_STATE:-$HOME/.claude-workbench/memory-recall}"
mkdir -p "$STATE_DIR" 2>/dev/null || exit 0
find "$STATE_DIR" \( -name '*.queries' -o -name '*.origin' \) -mtime +3 -delete 2>/dev/null
SAFE_SID=$(printf '%s' "$SESSION_ID" | tr -c 'A-Za-z0-9._-' '_')

# ──────────── Scheduled-task guard ────────────
# An unattended tick gets nothing. It has no human to serve, and every tick runs
# under a fresh session_id, so neither dedup lever carries across ticks and the
# same hits re-inject on every tick, forever.
#
# A PostToolUse payload has NO prompt, so the `<scheduled-task name="..."
# file="...">` wrapper the harness puts around a scheduled prompt — the only
# signal that exists, per the matching guard in memory-recall.sh — has to be read
# out of the transcript's first user record instead. That read is done ONCE per
# session and cached here, because it is the one part of this hook whose cost
# would otherwise scale with tool calls.
#
# The verdict is cached only when the transcript actually yielded text. Caching
# an empty read would freeze a wrong "human" answer for the whole session if the
# transcript had simply not been flushed yet.
ORIGIN_FILE="$STATE_DIR/${SAFE_SID}.origin"
if [ -f "$ORIGIN_FILE" ]; then
  ORIGIN=$(cat "$ORIGIN_FILE" 2>/dev/null)
else
  ORIGIN="human"
  TRANSCRIPT=$(printf '%s' "$PAYLOAD" | jq -r '.transcript_path // empty' 2>/dev/null)
  FIRST_PROMPT=""
  if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
    # `grep -m1` stops at the first user record, so this reads a prefix of the
    # transcript rather than the whole file. Content is a bare string on a typed
    # prompt and an array of blocks when the harness attaches anything.
    FIRST_PROMPT=$(grep -m1 '"type":"user"' "$TRANSCRIPT" 2>/dev/null | jq -r '
      .message.content
      | if type == "array" then (map(select(.type == "text") | .text // "") | join(" "))
        elif type == "string" then .
        else "" end' 2>/dev/null)
  fi
  if [ -n "$FIRST_PROMPT" ]; then
    case "$(printf '%s' "$FIRST_PROMPT" | tr '\n' ' ' | sed 's/^ *//')" in
      '<scheduled-task '*) ORIGIN="scheduled" ;;
    esac
    printf '%s' "$ORIGIN" > "$ORIGIN_FILE" 2>/dev/null || true
  fi
fi
[ "$ORIGIN" = "scheduled" ] && exit 0

# ──────────── Per-session query dedup ────────────
# The same scan run twice searches the vault once. Path dedup below would
# suppress the second injection anyway, but only after paying the CLI's ~1s on
# the critical path of a tool call, every repeat.
#
# Recorded BEFORE the search, not after: a query whose search fails will most
# likely fail again, and retrying it on every scan is the unbounded cost this
# lever exists to stop. One missed recall is the cheap side of that trade.
QUERY_FILE="$STATE_DIR/${SAFE_SID}.queries"
grep -Fxq "$QUERY" "$QUERY_FILE" 2>/dev/null && exit 0
printf '%s\n' "$QUERY" >> "$QUERY_FILE" 2>/dev/null || true

# ──────────── Resolve vault env + search binary ────────────
memory_recall_prepare _memory_scan_recall_noop_log || exit 0

LIMIT=$(memory_recall_int "${WORKBENCH_MEMORY_SCAN_RECALL_LIMIT:-1}" 1)
MODE="${WORKBENCH_MEMORY_SCAN_RECALL_MODE:-hybrid}"
TIMEOUT=$(memory_recall_int "${WORKBENCH_MEMORY_SCAN_RECALL_TIMEOUT:-8}" 8)
TYPES="${WORKBENCH_MEMORY_SCAN_RECALL_TYPES-$MEMORY_RECALL_DEFAULT_TYPES}"
# Over-fetch so the client-side curated-type filter has room to drop the session
# summaries that dominate the index.
FETCH=$((LIMIT * 4))

# Deliberately does NOT stamp the last-attempt liveness breadcrumb. That stamp
# answers "did recall fire for a real human prompt", which the warmup's 48h
# staleness check depends on; a tool-call hook stamping it would mask a dead
# memory-recall.sh.

# ──────────── Search, filter, dedup ────────────
RESPONSE=$(memory_recall_search "$SERVER_BIN" "$QUERY" "$MODE" "$FETCH" "$TIMEOUT") || exit 0
ROWS=$(memory_recall_rows "$RESPONSE" "$LIMIT" "$TYPES")
[ -n "$ROWS" ] || exit 0

SEEN_FILE=$(memory_recall_seen_file "$STATE_DIR" "$SESSION_ID") || exit 0
memory_recall_bullets "$ROWS" "$SEEN_FILE"

# Every hit already injected this session → stay silent (the bound at work).
[ -n "$MEMORY_RECALL_BULLETS" ] || exit 0

# Commit the newly-injected paths FIRST, and emit ONLY if that record succeeded,
# so dedup state and emitted output never diverge.
if memory_recall_commit "$SEEN_FILE" "$MEMORY_RECALL_NEW_PATHS"; then
  # ──────────── Emit the recall block ────────────
  # The query is echoed back, truncated, because the block arrives mid-turn with
  # no prompt to explain it and the agent needs to know which scan produced it.
  # Truncated rather than whole: the measured record sizes tracked payload size
  # directly, and this text persists for the life of the transcript.
  HEADER="🧠 Vault recall for this scan — \"${QUERY:0:60}\" (verify against current code before acting; these reflect what was true when written):"
  CTX="${HEADER}
${MEMORY_RECALL_BULLETS}"

  jq -cn --arg ctx "$CTX" \
    '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $ctx}}' \
    2>/dev/null || true
fi
exit 0
