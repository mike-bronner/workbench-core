#!/usr/bin/env bash
#
# memory-recall-nudge: keep the "search the vault before you scan the repo, and
# build the query from the TASK" rule SALIENT across long sessions, at near-zero
# context cost. The read-side twin of memory-capture-nudge.sh.
#
# Invoked by the `core` plugin's UserPromptSubmit hook. Reads the hook payload
# from stdin and, when the turn looks recall-worthy, prints a single short nudge
# line as `additionalContext` for Claude Code to inject into the turn.
#
# WHY A REMINDER AND NOT A SECOND RECALL. memory-recall.sh already searches the
# vault and injects hits. It can only ever search the USER'S PROMPT, because that
# is the only text a UserPromptSubmit hook receives. Two things follow, and this
# hook exists for the second:
#   - A topic the agent uncovers mid-task was never searched at all.
#   - Even on the opening prompt, the agent can ask a BETTER question than the
#     prompt contains. Measured: replaying "go ahead and push and create a
#     release" ranked skills/release.learnings.md nowhere in the top 8, while the
#     query an agent forms from the task itself — "release title naming
#     convention" — ranked it 5th. The rule the agent needs is therefore about
#     what to search for, not only when.
# The baseline for both is injected once at SessionStart (session-warmup.sh, the
# "Memory routing" block, and its per-project router-stub twin). That warmup is
# the always-on floor. This hook only REINFORCES it, because a SessionStart-only
# rule decays deep into a long session — the same reason capture has a nudge.
#
# THIS HOOK NEVER GATES A RECALL. It emits a reminder or it emits nothing; it
# reads no vault, cancels nothing, and memory-recall.sh does not know it exists.
# The fire policy is an OR, so signal detection can only ever ADD a nudge on top
# of the unconditional heartbeat floor, never remove one. That asymmetry is the
# whole safety argument, and it is deliberate: the rejected alternative was a
# conditional that SKIPS recall when the agent judges the vault unlikely to help,
# which is the classifier shape hooks/agent-dispatch-gate.sh already measured
# here at 83% precision / 26% recall against 34% / 84%. A wrong skip also teaches
# the agent the rule is optional, and the judgement it would skip on is exactly
# the one that already failed.
#
# Fire policy (signal-gated + sparse heartbeat), mirroring capture:
#   - Signal: the prompt matches a recall-worthy regex (prior art, a convention
#     question, or a procedure that has a recorded way of being done) → nudge now.
#   - Heartbeat: every Nth low-signal turn (default 8) → nudge once, for the
#     mid-task topics that never appear in any prompt at all.
#   - Otherwise: emit NOTHING (exit 0, no stdout) — that is the cost lever.
#   - Scheduled-task fires are skipped outright, before any of the above.
#
# COST: UserPromptSubmit additionalContext ACCUMULATES in the transcript (N turns
# = N copies, no dedup), and a per-turn nudge was removed from this codebase once
# already for exactly that. So the payload is ONE line, the heartbeat is sparse,
# an unattended cron fire gets nothing, and there is a hard off switch.
#
# Env knobs:
#   WORKBENCH_MEMORY_RECALL_NUDGE=0           → disable entirely.
#   WORKBENCH_MEMORY_RECALL_NUDGE_INTERVAL=N  → heartbeat interval (default 8).
#   WORKBENCH_MEMORY_RECALL_NUDGE_STATE=DIR   → state dir override (tests use this).
#
# Deliberately NOT tied to WORKBENCH_MEMORY_RECALL=0. That switch turns off the
# automatic injection; with it off, an agent-initiated search is the ONLY recall
# left, so the reminder matters more, not less.
#
# Never fails the session. Always exits 0 — bad input, missing jq, or a
# malformed payload all degrade to a silent no-op.

set -u

# ──────────── Disable switch ────────────
# Honored before any work so disabling is unconditional and cheap.
if [ "${WORKBENCH_MEMORY_RECALL_NUDGE:-}" = "0" ]; then
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

# ──────────── Scheduled-task guard ────────────
# An unattended cron fire gets no nudge: no human is present, the prompt is a
# fixed skill body rather than a question, and every tick is a fresh session_id,
# so the heartbeat counter restarts at zero each time and can never throttle
# across ticks. Worse, a nudge is volatile text near the top of an otherwise
# byte-identical prompt, which breaks prompt-cache reuse for everything below it.
#
# The harness wraps a scheduled task's prompt in a `<scheduled-task name="..."
# file="...">` element; it is the only available signal. See the matching guard
# in memory-recall.sh for the full evidence on what was ruled out.
case "$(printf '%s' "$PROMPT" | tr '\n' ' ' | sed 's/^ *//')" in
  '<scheduled-task '*) exit 0 ;;
esac

# ──────────── Heartbeat interval ────────────
INTERVAL="${WORKBENCH_MEMORY_RECALL_NUDGE_INTERVAL:-8}"
# Clamp to a positive integer; fall back to the default on garbage input.
case "$INTERVAL" in
  ''|*[!0-9]*) INTERVAL=8 ;;
esac
[ "$INTERVAL" -lt 1 ] && INTERVAL=8

# ──────────── State dir (per-session heartbeat counter) ────────────
# Follow the workbench state-dir convention (~/.claude-workbench/). Its own
# directory rather than memory-nudge's: the two counters must not share a file,
# or a capture nudge would silently reset the recall heartbeat. Tests point this
# elsewhere via WORKBENCH_MEMORY_RECALL_NUDGE_STATE so real state is untouched.
STATE_DIR="${WORKBENCH_MEMORY_RECALL_NUDGE_STATE:-$HOME/.claude-workbench/memory-recall-nudge}"
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
# Case-insensitive match over the prompt for recall-worthy classes. Kept tight to
# avoid firing on every message. EDIT THE ARRAY BELOW to tune sensitivity — each
# element is one extended-regex alternative; they are OR'd together into a single
# pattern. (An array, not a heredoc, so parens in patterns don't trip shell
# paren-matching.) Sensitivity is cheap to get wrong in only one direction: a
# missed signal costs one reminder that the heartbeat will make anyway.
#
# Three classes:
#   1. Prior art       — "again", "last time", "how did we", "same as"…
#                        Overlaps capture's recurrence class on purpose:
#                        recurrence means both "write this down" and "you have
#                        been here before, go look".
#   2. Convention      — "convention", "naming", "format", "standard",
#                        "how do we", "which approach"…
#   3. Recorded procedure — the repeatable operations whose steps live in the
#                        vault rather than in the repo: releases, publishes,
#                        deploys, setup and migration.
SIGNAL_PATTERNS=(
  # Prior art
  'again'
  'last time'
  'how did (we|you|i)'
  'same as'
  'like (the|we did)'
  'we (already|previously) (did|set up|built|decided)'
  '(do|did) we (have|use|already)'
  # Convention / standard
  'convention'
  'standard'
  'naming'
  'format'
  'template'
  'best practice'
  'how (do|should) (we|you|i)'
  "what('s| is) (our|the) (usual|standard|convention)"
  'which (approach|option|one)'
  'prefer'
  # Recorded procedure
  'release'
  'publish'
  'deploy'
  'bump'
  'set ?up'
  'configure'
  'migrat'
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
# Fire if a signal matched OR the heartbeat counter has reached the interval —
# an OR, never an AND and never an "unless", so no signal verdict can suppress
# the floor. Either way, reset the counter to 0, so the heartbeat means "at
# least one reminder per N turns since the last nudge" and never fires right
# after a signal nudge. Otherwise increment and stay silent.
if [ "$SIGNAL_MATCH" -eq 1 ] || [ "$COUNT" -ge "$INTERVAL" ]; then
  printf '0' > "$STATE_FILE" 2>/dev/null || true

  # Payload: ONE short line carrying both halves of the rule — search before you
  # scan (when), and build the query from the task (what). It's a trigger, not
  # the full spec; the warmup floor carries the detail.
  NUDGE='🧠 Recall check — `search` the vault (mcp__plugin_workbench-core_memory__search) before you scan the repo or settle a convention, a format, or a procedure. Build the query from the TASK — the thing you are about to produce or decide, in the words a note about it would use — not from the wording of this prompt. Auto-recall only ever ran the opening prompt, so a lesson filed under another phrase never arrives on its own.'

  # Emit as UserPromptSubmit additionalContext (explicit JSON form).
  jq -cn --arg ctx "$NUDGE" \
    '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: $ctx}}' \
    2>/dev/null || true
  exit 0
fi

# No fire — increment the counter and stay silent.
printf '%s' "$((COUNT + 1))" > "$STATE_FILE" 2>/dev/null || true
exit 0
