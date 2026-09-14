#!/usr/bin/env bash
#
# memory-recall: PROACTIVE recall — the mirror of memory-capture-nudge.
#
# capture-nudge reminds the agent to WRITE durable knowledge. This hook does the
# opposite half of the compounding loop: on prompt submit it SEARCHES the vault
# with the user's prompt and injects the top matches as `additionalContext`, so
# a past lesson surfaces WITHOUT the agent having to decide to search for it.
# That "recall fires when you don't know to ask" is the whole point — reactive
# search (agent-initiated) misses exactly the turns where the agent is about to
# repeat a known mistake.
#
# Invoked by the `core` plugin's UserPromptSubmit hook, alongside
# memory-capture-nudge.sh. Reads the hook payload from stdin; when the prompt is
# substantive AND the vault returns fresh hits, prints one short recall block.
#
# THE PROMPT IS ALL THIS HOOK EVER SEES. A UserPromptSubmit hook receives the
# prompt and nothing else, so a topic the agent uncovers mid-task — while
# scanning the repo, reading a file, following a trail the opening prompt never
# named — is never searched here. memory-scan-recall.sh (PostToolUse) closes
# that: it piggybacks on a scan the agent is already running and searches with
# that scan's own query. The two share every lever below through
# lib/memory-recall-core.sh, including the seen-file, so a memory this hook
# already injected is never repeated by a later scan.
#
# COST DISCIPLINE (this is load-bearing, not optional — see the vault insights
# 2026-06-26-claude-code-hook-context-cost and -memory-capture-authorization-drift):
# UserPromptSubmit additionalContext ACCUMULATES in the transcript (N turns = N
# copies, no dedup/throttle), and a per-turn nudge was removed once already for
# context cost. So this hook holds four levers:
#   1. Per-session dedup — a memory path is injected AT MOST ONCE per session.
#      Accumulation is bounded by the number of DISTINCT relevant memories, not
#      turns. A recurring topic never re-injects the same note.
#   2. Substance gate — trivial prompts (short, bare confirmations, slash
#      commands) emit nothing, so most turns cost zero tokens.
#   3. Scheduled-task guard — an unattended cron fire gets nothing at all. It
#      has no human to serve, and its fresh-per-tick session_id defeats lever 1.
#   4. Small top-K — default 2 hits, each trimmed to a one-line summary.
# Levers 1 and 4, the vault resolution, the search transport and the curated-type
# filter all live in lib/memory-recall-core.sh now; the reasoning for each moved
# with it. Levers 2 and 3 are this hook's own, because they read a prompt.
#
# Env knobs:
#   WORKBENCH_MEMORY_RECALL=0           → disable entirely.
#   WORKBENCH_MEMORY_RECALL_LIMIT=N     → max hits to inject (default 2).
#   WORKBENCH_MEMORY_RECALL_MIN_CHARS=N → min prompt length to search (default 16).
#   WORKBENCH_MEMORY_RECALL_MODE=...    → search mode (default hybrid).
#   WORKBENCH_MEMORY_RECALL_TIMEOUT=N   → search subprocess watchdog seconds
#                                         (default 8 — the call itself takes ~1s;
#                                         this only bounds a pathological hang).
#   WORKBENCH_MEMORY_RECALL_STATE=DIR   → per-session seen-paths state dir override.
#                                         Shared with memory-scan-recall.sh: one
#                                         dir, one seen-file, one bound.
#   WORKBENCH_MEMORY_RECALL_TYPES=a,b   → frontmatter types eligible for injection
#                                         (default in lib/memory-recall-core.sh;
#                                         set empty to disable the filter).
#   (vault location comes from lib/memory-env.sh, like every other hook.)
#
# Never fails the session. Always exits 0 — missing jq, a binary that can't be
# resolved, a malformed payload, or a subprocess that hangs past the watchdog
# all degrade to a silent no-op.

set -u

# install/vacuum-lib chatter must never touch stdout (this hook's stdout is
# either nothing or one additionalContext JSON block) — route it to stderr.
_memory_recall_noop_log() { echo "memory-recall: $*" >&2; }

# ──────────── Disable switch ────────────
if [ "${WORKBENCH_MEMORY_RECALL:-}" = "0" ]; then
  exit 0
fi

# ──────────── Read hook payload ────────────
# UserPromptSubmit delivers JSON on stdin:
#   {session_id, transcript_path, cwd, permission_mode, hook_event_name, prompt}
PAYLOAD=""
if [ ! -t 0 ]; then
  PAYLOAD=$(cat)
fi
[ -n "$PAYLOAD" ] || exit 0

command -v jq >/dev/null 2>&1 || exit 0

PROMPT=$(printf '%s' "$PAYLOAD" | jq -r '.prompt // empty' 2>/dev/null)
SESSION_ID=$(printf '%s' "$PAYLOAD" | jq -r '.session_id // empty' 2>/dev/null)

# No session to key dedup state on → can't honor the accumulation bound, so don't
# inject. No prompt → nothing to search.
[ -n "$SESSION_ID" ] || exit 0
[ -n "$PROMPT" ] || exit 0

# ──────────── Substance gate ────────────
# Skip turns where recall is unlikely to help and would only add tokens:
#   - slash-command invocations (the skill carries its own context)
#   - very short prompts (below MIN_CHARS)
#   - bare confirmations / continuations
MIN_CHARS="${WORKBENCH_MEMORY_RECALL_MIN_CHARS:-16}"
case "$MIN_CHARS" in ''|*[!0-9]*) MIN_CHARS=16 ;; esac

case "$PROMPT" in
  /*) exit 0 ;;  # slash command
esac

# Trim leading/trailing whitespace for the length + triviality checks.
_trimmed=$(printf '%s' "$PROMPT" | tr '\n' ' ' | sed 's/^ *//; s/ *$//')
if [ "${#_trimmed}" -lt "$MIN_CHARS" ]; then
  exit 0
fi
if printf '%s' "$_trimmed" \
    | grep -Eiq '^(y|n|ok|okay|yes|no|yep|nope|sure|thanks|thank you|ty|go|go ahead|do it|continue|proceed|next|done|stop|wait)[.!? ]*$' 2>/dev/null; then
  exit 0
fi

# ──────────── Scheduled-task guard ────────────
# A scheduled-task fire is not a human turn: nobody is present to benefit from
# a recalled memory, the task prompt is a fixed skill body rather than a
# question, and every tick gets a fresh session_id — so the per-session dedup
# above never carries over and the SAME hits re-inject on every single tick,
# forever. Worse, that injection is volatile text near the top of an otherwise
# byte-identical prompt, which breaks prompt-cache reuse for everything
# downstream (the confirmed cause of the dev-team Dispatch tick's ~36k-token
# non-caching tail).
#
# Detection: the harness wraps a scheduled task's prompt in a `<scheduled-task
# name="..." file="...">` element. That wrapper is the ONLY signal available —
# there is no env var and no payload field. `CLAUDE_CODE_ENTRYPOINT` is
# identical for scheduled and interactive runs; the UserPromptSubmit payload's
# `source` field (whose enum includes `schedule_wakeup`) is documented as
# "only set for Anthropic-internal sessions while the field is trialed" and is
# compiled out of external builds. Re-check that field on harness upgrades: if
# it ever ships externally, it is the more precise signal and also covers
# `loop_wakeup`.
#
# Note the interaction with the liveness breadcrumb below: skipping here means
# a scheduled fire does NOT stamp last-attempt, so the warmup's 48h staleness
# check measures "recall fired for a real human prompt", not "the hook is
# wired up". That is the more useful question of the two.
case "$_trimmed" in
  '<scheduled-task '*) exit 0 ;;
esac

# ──────────── Resolve vault env + search binary ────────────
# Same resolution every other memory hook uses, so we always agree on where the
# vault and its index live, and the same one-shot CLI transport memory-scan-
# recall.sh uses. A failure to resolve either is a silent no-op — the fail-open
# contract, identical to every other failure mode in this hook.
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hooks/lib/memory-recall-core.sh
. "$HOOK_DIR/lib/memory-recall-core.sh" 2>/dev/null || exit 0
memory_recall_prepare _memory_recall_noop_log || exit 0

LIMIT=$(memory_recall_int "${WORKBENCH_MEMORY_RECALL_LIMIT:-2}" 2)
MODE="${WORKBENCH_MEMORY_RECALL_MODE:-hybrid}"
TIMEOUT=$(memory_recall_int "${WORKBENCH_MEMORY_RECALL_TIMEOUT:-8}" 8)

# Over-fetch 4× the limit so the client-side curated-type filter has room to
# drop the session summaries that dominate the index.
TYPES="${WORKBENCH_MEMORY_RECALL_TYPES-$MEMORY_RECALL_DEFAULT_TYPES}"
FETCH=$((LIMIT * 4))

# Truncate the search query: the raw prompt can carry pasted logs or diffs;
# the first ~500 chars carry the intent and the rest just skews ranking.
QUERY="${_trimmed:0:500}"

# Liveness breadcrumb — stamped on every substantive-prompt attempt (before
# the server call, so a down server still counts as "hook alive"). The warmup
# alerts when this goes stale >48h; a silent hook death is otherwise invisible.
# Deliberately NOT stamped by memory-scan-recall.sh: the question worth asking
# is "did recall fire for a real human prompt", not "is some hook wired up".
STATE_DIR="${WORKBENCH_MEMORY_RECALL_STATE:-$HOME/.claude-workbench/memory-recall}"
if mkdir -p "$STATE_DIR" 2>/dev/null; then
  date +%s > "$STATE_DIR/last-attempt" 2>/dev/null || true
fi

# ──────────── Search, filter, dedup ────────────
RESPONSE=$(memory_recall_search "$SERVER_BIN" "$QUERY" "$MODE" "$FETCH" "$TIMEOUT") || exit 0
ROWS=$(memory_recall_rows "$RESPONSE" "$LIMIT" "$TYPES")
[ -n "$ROWS" ] || exit 0

SEEN_FILE=$(memory_recall_seen_file "$STATE_DIR" "$SESSION_ID") || exit 0
memory_recall_bullets "$ROWS" "$SEEN_FILE"

# Nothing new for this session → stay silent (the dedup bound at work).
[ -n "$MEMORY_RECALL_BULLETS" ] || exit 0

# Commit the newly-injected paths FIRST, and emit ONLY if that record succeeded,
# so dedup state and emitted output never diverge.
if memory_recall_commit "$SEEN_FILE" "$MEMORY_RECALL_NEW_PATHS"; then
  # ──────────── Emit the recall block ────────────
  # A short header + the bullets. The verify caveat is deliberate: recalled
  # memories reflect what was true WHEN WRITTEN — the agent must check them
  # against current code before acting, never treat them as ground truth.
  HEADER='🧠 Possibly-relevant past memories (vault auto-recall — verify against current code before acting; these reflect what was true when written):'
  CTX="${HEADER}
${MEMORY_RECALL_BULLETS}"

  jq -cn --arg ctx "$CTX" \
    '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: $ctx}}' \
    2>/dev/null || true
fi
exit 0
