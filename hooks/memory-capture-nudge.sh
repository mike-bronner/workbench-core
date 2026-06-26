#!/usr/bin/env bash
#
# memory-capture-nudge: keep the "proactively capture durable knowledge to the
# memory vault, don't ask" rule SALIENT across long sessions, at near-zero
# context cost.
#
# Invoked by the `core` plugin's UserPromptSubmit hook. Reads the hook payload
# from stdin and, when the turn looks capture-worthy, prints a single short
# nudge line as `additionalContext` for Claude Code to inject into the turn.
#
# The baseline rule is injected once at SessionStart (session-warmup.sh, the
# "Memory routing" block) — that warmup is the always-on floor. This hook only
# REINFORCES it: it fires sparingly so it never accumulates tokens every turn.
#
# Fire policy (signal-gated + sparse heartbeat):
#   - Signal: the prompt matches a capture-worthy regex (recurrence, a
#     decision/solution, or feedback/insight) → nudge now.
#   - Heartbeat: every Nth low-signal turn (default 8) → nudge once, to catch
#     captures that surface from the agent's own work rather than the prompt.
#   - Otherwise: emit NOTHING (exit 0, no stdout) — that is the cost lever.
#
# Env knobs:
#   WORKBENCH_MEMORY_NUDGE=0            → disable entirely.
#   WORKBENCH_MEMORY_NUDGE_INTERVAL=N  → heartbeat interval (default 8).
#   WORKBENCH_MEMORY_NUDGE_STATE=DIR   → state dir override (tests use this).
#
# Never fails the session. Always exits 0 — bad input, missing jq, or a
# malformed payload all degrade to a silent no-op.

set -u

# ──────────── Disable switch ────────────
# Honored before any work so disabling is unconditional and cheap.
if [ "${WORKBENCH_MEMORY_NUDGE:-}" = "0" ]; then
  exit 0
fi

# ──────────── Read hook payload ────────────
# UserPromptSubmit delivers JSON on stdin:
#   {session_id, transcript_path, cwd, permission_mode, hook_event_name, prompt}
PAYLOAD=""
if [ ! -t 0 ]; then
  PAYLOAD=$(cat)
fi

if [ -z "$PAYLOAD" ]; then
  # Nothing to inspect. Exit silently.
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  # jq missing — can't parse the payload. Exit silently.
  exit 0
fi

PROMPT=$(printf '%s' "$PAYLOAD" | jq -r '.prompt // empty' 2>/dev/null)
SESSION_ID=$(printf '%s' "$PAYLOAD" | jq -r '.session_id // empty' 2>/dev/null)

# Malformed JSON (jq error) or no session to key state on → silent no-op.
if [ -z "$SESSION_ID" ]; then
  exit 0
fi

# ──────────── Heartbeat interval ────────────
INTERVAL="${WORKBENCH_MEMORY_NUDGE_INTERVAL:-8}"
# Clamp to a positive integer; fall back to the default on garbage input.
case "$INTERVAL" in
  ''|*[!0-9]*) INTERVAL=8 ;;
esac
[ "$INTERVAL" -lt 1 ] && INTERVAL=8

# ──────────── State dir (per-session heartbeat counter) ────────────
# Follow the workbench state-dir convention (~/.claude-workbench/, where
# session-warmup keeps chat-skills-state.json). Tests point this elsewhere via
# WORKBENCH_MEMORY_NUDGE_STATE so real session state is never touched.
STATE_DIR="${WORKBENCH_MEMORY_NUDGE_STATE:-$HOME/.claude-workbench/memory-nudge}"
mkdir -p "$STATE_DIR" 2>/dev/null || exit 0

# Sanitize the session id before using it as a filename (defense in depth —
# ids are normally hex/UUID, but never trust an external value in a path).
SAFE_SID=$(printf '%s' "$SESSION_ID" | tr -c 'A-Za-z0-9._-' '_')
STATE_FILE="$STATE_DIR/${SAFE_SID}.count"

# ──────────── State hygiene ────────────
# Prune counter files older than 3 days so the dir doesn't grow unbounded —
# mirrors session-warmup's find -mtime retention sweep. Fire-and-forget.
find "$STATE_DIR" -name '*.count' -mtime +3 -delete 2>/dev/null

# ──────────── Signal detection ────────────
# Case-insensitive match over the prompt for capture-worthy classes. Kept tight
# to avoid firing on every message. EDIT THE ARRAY BELOW to tune sensitivity —
# each element is one extended-regex alternative; they are OR'd together into a
# single pattern. (An array, not a heredoc, so the parens in patterns like
# "you should(n't)?" don't trip shell paren-matching.)
#
# Three classes:
#   1. Recurrence        — "we discussed", "again", "still broken", "every time"…
#   2. Decision/solution — "decided", "the fix is", "root cause", "turns out"…
#   3. Feedback/insight   — "you should", "next time", "don't ask", "FYI", "TIL"…
SIGNAL_PATTERNS=(
  # Recurrence
  'we (went over|talked about|discussed|covered)'
  'again'
  'still (happening|broken|failing)'
  'every time'
  'keeps? (happening|doing)'
  'like i (said|mentioned)'
  'as i (said|mentioned)'
  # Decision / solution
  'decided'
  'the (fix|solution|answer) (is|was)'
  'root cause'
  'turns out'
  'from now on'
  'going forward'
  "let's (always|never)"
  'the right (way|approach)'
  # Feedback / insight
  "you should(n't)?"
  'next time'
  'remember to'
  "don't ask"
  'for (future|the) (reference|record)'
  'fyi'
  'note that'
  'insight'
  'til'
  'lesson'
)

# Join the alternatives with "|" into one extended-regex pattern.
SIGNAL_REGEX=""
for _p in "${SIGNAL_PATTERNS[@]}"; do
  SIGNAL_REGEX="${SIGNAL_REGEX:+$SIGNAL_REGEX|}$_p"
done

SIGNAL_MATCH=0
if [ -n "$PROMPT" ] && [ -n "$SIGNAL_REGEX" ] \
    && printf '%s' "$PROMPT" | grep -Eiq "$SIGNAL_REGEX" 2>/dev/null; then
  SIGNAL_MATCH=1
fi

# ──────────── Read current heartbeat counter ────────────
COUNT=0
if [ -f "$STATE_FILE" ]; then
  COUNT=$(cat "$STATE_FILE" 2>/dev/null)
  case "$COUNT" in
    ''|*[!0-9]*) COUNT=0 ;;
  esac
fi

# ──────────── Fire decision ────────────
# Fire if a signal matched OR the heartbeat counter has reached the interval.
# Either way, reset the counter to 0 — so the heartbeat means "at least one
# reminder per N turns since the last nudge", and a heartbeat never fires right
# after a signal nudge. Otherwise increment and stay silent.
if [ "$SIGNAL_MATCH" -eq 1 ] || [ "$COUNT" -ge "$INTERVAL" ]; then
  printf '0' > "$STATE_FILE" 2>/dev/null || true

  # Payload: ONE short line. It's a trigger, not the full spec — the warmup
  # floor carries the detail. Keep it tight (~tweet-length).
  NUDGE='💾 Capture check — if this turn produced a decision (+ rationale), a root-cause, a recurring issue, a design choice, or feedback on how to work, write it to the memory vault now via mcp__plugin_workbench-core_memory__write with the right type. Standing authorization — do not ask first.'

  # Emit as UserPromptSubmit additionalContext (explicit JSON form).
  jq -cn --arg ctx "$NUDGE" \
    '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: $ctx}}' \
    2>/dev/null || true
  exit 0
fi

# No fire — increment the counter and stay silent.
printf '%s' "$((COUNT + 1))" > "$STATE_FILE" 2>/dev/null || true
exit 0
