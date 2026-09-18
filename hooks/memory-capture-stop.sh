#!/usr/bin/env bash
#
# memory-capture-stop: make the LIVE session write its durable findings to the
# memory vault, while it still holds the context that produced them.
#
# The gap this closes. The session-logging pipeline already fires on quit, on
# /clear and on compaction, and it reliably produces a narrative summary per
# session — but that summary is written by a background agent reading a raw
# JSONL transcript with no lived context, and agents/summary-writer.md rightly
# forbids it from padding a thin reconstruction into a confident one. Curated
# decisions, root causes and corrections exist only inside the session that
# formed them. Nothing was asking that session for them unless the human did.
#
# Why Stop, and why not PreCompact. Only two hook events can make a live model
# act: UserPromptSubmit (additionalContext on the next human turn) and Stop
# (`decision: block` + `reason`, which refuses the stop and hands the model the
# reason as its next instruction). PreCompact is NOT one of them — measured
# against the shipped CLI (2.1.277), its executor collects each hook's stdout
# and its blocked/succeeded state and nothing else; there is no additionalContext
# path, and no model turn is open at that point to run a tool in. A PreCompact
# hook can block compaction or say nothing, and neither writes a memory. A hard
# quit cannot be covered at all, for the same reason SessionEnd cannot dispatch
# a summary-writer: the model is already gone.
#
# Stop, by contrast, fires at the end of every assistant turn, which is the only
# moment that is both live and guaranteed to arrive.
#
# What this hook is FOR. It is a backstop against the per-turn capture nudge
# (hooks/memory-capture-nudge.sh) being ignored, not a periodic reminder. That
# distinction sets the whole fire policy: a backstop has to fire at least once
# per session to be a backstop at all, so WHEN IT FIRES FIRST matters far more
# than how often it repeats.
#
# It is not tuned to beat compaction, and deliberately so. Across 467
# transcripts of this project exactly ONE session ever compacted. The real
# context-loss events here are quit and /clear, and neither gives any warning a
# hook can read — the Stop payload carries no context-pressure field, so
# "fire when the shed is near" is not available at any price.
#
# Fire policy (throttled — this is not a free reminder):
#   - On the FIRST-th turn end (default 5) → fire once. Measured coverage over
#     those 467 transcripts: turn 5 reaches 88% of sessions, turn 9 reaches 55%,
#     turn 21 reaches 16%.
#   - Then every REPEAT turn ends (default 40) → sparse, and only to catch
#     findings that crystallize late in a long session.
#   - Otherwise: emit NOTHING (exit 0) — the cost lever.
#   - Never when stop_hook_active is true: that IS our own block, and blocking
#     again is an infinite loop.
#   - Never inside a sub-agent, a summary-writer child, an unattended dev-team
#     agent, or a scheduled task.
#
# Blocking a stop is far more expensive than the nudge next door: that one adds
# a line of context, this one buys a whole extra model turn. Hence the sparse
# repeat, and an instruction that explicitly permits a no-op. The early first
# fire makes that permission MORE important, not less: at turn 5 a session
# often genuinely has nothing worth recording.
#
# Env knobs:
#   WORKBENCH_CAPTURE_STOP=0            → disable entirely.
#   WORKBENCH_MEMORY_NUDGE=0            → disable entirely (family kill switch:
#                                         "no memory-capture reminders" means
#                                         this one too, not just the nudge).
#   WORKBENCH_CAPTURE_STOP_FIRST=N     → turn end of the first fire (default 5).
#   WORKBENCH_CAPTURE_STOP_INTERVAL=N  → turn ends between later fires (default
#                                        40). Independent of FIRST on purpose:
#                                        both are estimates from one project's
#                                        history and need retuning separately.
#   WORKBENCH_MEMORY_NUDGE_STATE=DIR   → state dir override, shared with the
#                                        nudge (tests use this).
#
# Never fails the session. Always exits 0 — bad input, missing jq, or a
# malformed payload all degrade to a silent no-op.

set -u

# ──────────── Disable switches ────────────
# Honored before any work so disabling is unconditional and cheap.
if [ "${WORKBENCH_CAPTURE_STOP:-}" = "0" ] || [ "${WORKBENCH_MEMORY_NUDGE:-}" = "0" ]; then
  exit 0
fi

# The background summary-writer is spawned with WORKBENCH_SUMMARY_WRITER=1 (see
# hooks/lib/summary-dispatch.sh). It is a headless child whose entire job is to
# write ONE summary from a log it was handed; telling it to capture findings of
# its own is noise at best, and it runs under a PreToolUse guard that exists to
# keep it from writing stray files at worst.
if [ "${WORKBENCH_SUMMARY_WRITER:-}" = "1" ]; then
  exit 0
fi

# The dev-team pipeline's scheduled agents are the other headless children on
# this machine (bin/dispatch-agent.sh exports this onto every one it spawns).
# They run unattended under a budget cap, and in `claude -p` a blocked stop
# turns the capture reply into the run's final output — which is the text the
# dispatcher logs as the agent's report. Same reasoning as the scheduled-task
# guard below: nobody is present to judge what got written.
if [ "${WORKBENCH_DEV_TEAM_PIPELINE:-}" = "1" ]; then
  exit 0
fi

# ──────────── Read hook payload ────────────
# Stop delivers JSON on stdin:
#   {session_id, transcript_path, cwd, permission_mode, hook_event_name,
#    stop_hook_active, last_assistant_message, agent_id?, agent_type?}
PAYLOAD=""
if [ ! -t 0 ]; then
  PAYLOAD=$(cat)
fi

if [ -z "$PAYLOAD" ]; then
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  # jq missing — can't parse the payload. Exit silently.
  exit 0
fi

SESSION_ID=$(printf '%s' "$PAYLOAD" | jq -r '.session_id // empty' 2>/dev/null)
STOP_ACTIVE=$(printf '%s' "$PAYLOAD" | jq -r '.stop_hook_active // false' 2>/dev/null)
AGENT_ID=$(printf '%s' "$PAYLOAD" | jq -r '.agent_id // empty' 2>/dev/null)

# Malformed JSON (jq error) or no session to key state on → silent no-op.
if [ -z "$SESSION_ID" ]; then
  exit 0
fi

# ──────────── Loop guard ────────────
# stop_hook_active is true when the model is already continuing because a Stop
# hook blocked it. Blocking again from inside that continuation is an infinite
# loop, which is why the CLI ships a block cap at all. Fail closed: anything
# other than a definite "false" is treated as active.
if [ "$STOP_ACTIVE" != "false" ]; then
  exit 0
fi

# ──────────── Sub-agent guard ────────────
# agent_id is present only when the hook fires from inside a sub-agent. A
# sub-agent's job ends at its hand-back to the caller; the findings belong to
# the session that dispatched it, which gets its own turn ends.
if [ -n "$AGENT_ID" ]; then
  exit 0
fi

# ──────────── Throttle: an early first fire, then a sparse repeat ────────────
# Two thresholds, not one, because they do two different jobs.
#
# FIRST is the one that matters. This hook is a backstop against the per-turn
# capture nudge being ignored, and a backstop that never fires is not one. Across
# 467 transcripts of this project, a flat interval of 20 (first fire at turn 21)
# reached 76 sessions — 84% would have captured nothing at all. Turn 9 reaches
# 55%. Turn 5 reaches 411 of 467, which is 88%.
#
# REPEAT only catches findings that crystallize late in a long session, so it is
# deliberately sparse: at 40, it fires in the small minority of sessions that run
# that long, which is exactly the set it is for.
#
# Both numbers are estimates from one project's history, so both are overridable
# without a code change.
FIRST="${WORKBENCH_CAPTURE_STOP_FIRST:-5}"
REPEAT="${WORKBENCH_CAPTURE_STOP_INTERVAL:-40}"
# Clamp each to a positive integer; fall back to the default on garbage input.
case "$FIRST" in
  ''|*[!0-9]*) FIRST=5 ;;
esac
[ "$FIRST" -lt 1 ] && FIRST=5
case "$REPEAT" in
  ''|*[!0-9]*) REPEAT=40 ;;
esac
[ "$REPEAT" -lt 1 ] && REPEAT=40

# ──────────── State dir (shared with the capture nudge) ────────────
STATE_DIR="${WORKBENCH_MEMORY_NUDGE_STATE:-$HOME/.claude-workbench/memory-nudge}"
mkdir -p "$STATE_DIR" 2>/dev/null || exit 0

# Sanitize the session id before using it as a filename (defense in depth —
# ids are normally hex/UUID, but never trust an external value in a path).
SAFE_SID=$(printf '%s' "$SESSION_ID" | tr -c 'A-Za-z0-9._-' '_')
STATE_FILE="$STATE_DIR/${SAFE_SID}.stopcount"
# Presence means this session has already had its first capture, which is the
# only thing that selects REPEAT over FIRST. A separate file rather than a
# sentinel value in the counter: the counter is read by an arithmetic test, and
# an out-of-band value there would have to be defended on every read.
FIRED_FILE="$STATE_DIR/${SAFE_SID}.stopfired"

# ──────────── Scheduled-task guard ────────────
# A Stop payload carries no prompt, so the `<scheduled-task …>` wrapper that
# memory-capture-nudge.sh matches on is not visible here. The nudge drops a
# marker beside its own state instead, and this hook reads it: UserPromptSubmit
# always fires before the turn it belongs to ends, so the marker is on disk by
# the time the first Stop of that tick runs.
#
# Same reasoning as the nudge's own guard: an unattended tick capturing memories
# about its own routing decisions is exactly the noise the vault does not want.
if [ -f "$STATE_DIR/${SAFE_SID}.scheduled" ]; then
  exit 0
fi

# ──────────── State hygiene ────────────
# Prune per-session state older than 3 days so the dir doesn't grow unbounded —
# mirrors session-warmup's find -mtime retention sweep. Fire-and-forget.
find "$STATE_DIR" \( -name '*.stopcount' -o -name '*.stopfired' \) -mtime +3 -delete 2>/dev/null

# ──────────── Count this turn end ────────────
# Counted BEFORE the decision, and including the current turn, so a threshold
# of 5 means "fires on the 5th turn end" and not "on the 6th".
COUNT=0
if [ -f "$STATE_FILE" ]; then
  COUNT=$(cat "$STATE_FILE" 2>/dev/null)
  case "$COUNT" in
    ''|*[!0-9]*) COUNT=0 ;;
  esac
fi
COUNT=$((COUNT + 1))

# ──────────── Fire decision ────────────
if [ -f "$FIRED_FILE" ]; then
  THRESHOLD="$REPEAT"
else
  THRESHOLD="$FIRST"
fi

if [ "$COUNT" -lt "$THRESHOLD" ]; then
  # No fire — bank this turn end and stay silent.
  printf '%s' "$COUNT" > "$STATE_FILE" 2>/dev/null || true
  exit 0
fi

printf '0' > "$STATE_FILE" 2>/dev/null || true
: > "$FIRED_FILE" 2>/dev/null || true

# The instruction. Three things it must do, in this order of importance:
#   1. Say plainly that nothing is required when nothing qualifies. Without
#      that, a forced turn manufactures a memory to justify itself, and the
#      vault fills with restatements of the obvious.
#   2. Name what only THIS session can supply — the curated shape a background
#      summarizer reading raw JSONL cannot reconstruct.
#   3. Say it is automatic, so the model does not answer the human with it.
read -r -d '' CAPTURE_INSTRUCTION <<'EOF' || true
💾 Memory capture checkpoint (automatic, not from the user).

Before this turn ends: if this session has produced anything durable that is
not in the vault yet, write it now with
mcp__plugin_workbench-core_memory__write, under the right type — a decision
with its rationale and the alternatives rejected, a root cause, a correction
the user made to how you work, or a procedure worth reusing.

Write it now because you are the only one who can. The background summarizer
reads a raw transcript with no lived context, and it is forbidden from padding
a thin reconstruction into a confident one — a finding you do not record here
is not recoverable later in this form.

If nothing in this session qualifies, or it is already recorded, write nothing.
Say so in one short line and stop. A manufactured memory is worse than none.

Standing authorization — do not ask first. Do not report this checkpoint to the
user beyond that one line.
EOF

jq -cn --arg reason "$CAPTURE_INSTRUCTION" \
  '{decision: "block", reason: $reason}' 2>/dev/null || true
exit 0
