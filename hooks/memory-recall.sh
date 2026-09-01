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
#
# TRANSPORT: this hook shells out to the `markdown-vault-mcp search` CLI — a
# one-shot subprocess that loads the index, runs the query, prints JSON, and
# exits. NOT the `serve` command: no port, no daemon, nothing left running
# afterward. That makes it consistent with the per-session stdio MCP transport
# (mcp-memory.sh) — no shared server for either to depend on — at the cost of
# ~1s per call (process start + loading the embedding index fresh every time,
# vs. a warm daemon's ~25ms). Deliberate trade: see the vault insight
# 2026-07-26-memory-recall-cli-migration for the measurement and the
# alternative (a properly-supervised daemon) that was rejected in favor of
# this. Before this, the hook curled a shared HTTP server on port 8765 that
# the per-session-stdio revert (PR #14) left undersupervised — an orphaned
# instance from the old shared-server model kept it silently "working" for
# 18 days after the revert, until it was found and killed.
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
#   WORKBENCH_MEMORY_RECALL_TYPES=a,b   → frontmatter types eligible for injection
#                                         (default decision,insight,topic,feedback,reference;
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

# ──────────── Resolve vault env (source dir / index / cache) ────────────
# Same resolution every other memory hook uses, so we always agree on where the
# vault and its index live. memory_load_env exports the MARKDOWN_VAULT_MCP_*
# env the CLI reads (precedence: WORKBENCH_* override → config.json → default).
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# SC2034: HOOKS_DIR is not read in this file — it is read by memory-install.sh
# (`${HOOKS_DIR:?HOOKS_DIR must be set}/wheels`), which memory-env.sh pulls in
# transitively. shellcheck cannot follow that far, so the use is invisible here.
# shellcheck disable=SC2034
HOOKS_DIR="$HOOK_DIR"
# shellcheck source=hooks/lib/memory-env.sh
. "$HOOK_DIR/lib/memory-env.sh" 2>/dev/null || exit 0
memory_load_env 2>/dev/null || exit 0

LIMIT="${WORKBENCH_MEMORY_RECALL_LIMIT:-2}"
case "$LIMIT" in ''|*[!0-9]*) LIMIT=2 ;; esac
[ "$LIMIT" -lt 1 ] && LIMIT=2
MODE="${WORKBENCH_MEMORY_RECALL_MODE:-hybrid}"
TIMEOUT="${WORKBENCH_MEMORY_RECALL_TIMEOUT:-8}"
case "$TIMEOUT" in ''|*[!0-9]*) TIMEOUT=8 ;; esac

# ──────────── Resolve the server binary ────────────
# Same shared resolution mcp-memory.sh and memory-server-spawn.sh use.
# WORKBENCH_MEMORY_SERVER_BIN short-circuits it — the test suite points that at
# the fake-binary fixture; a missing/unresolvable binary is a silent no-op, the
# same fail-open contract as every other failure mode in this hook.
# shellcheck source=hooks/lib/memory-install.sh
. "$HOOK_DIR/lib/memory-install.sh" 2>/dev/null || exit 0
if [ -n "${WORKBENCH_MEMORY_SERVER_BIN:-}" ]; then
  SERVER_BIN="$WORKBENCH_MEMORY_SERVER_BIN"
else
  # Never block a prompt on another session's install: a 0s lock timeout makes
  # the resolve fail closed instead of waiting, and this hook's contract is a
  # silent no-op on any failure. The installing session gets memory; this
  # prompt simply goes without recall.
  WORKBENCH_MEMORY_INSTALL_LOCK_TIMEOUT=0 \
    memory_install_server _memory_recall_noop_log 2>/dev/null || exit 0
fi
[ -n "${SERVER_BIN:-}" ] && [ -x "$SERVER_BIN" ] || exit 0

# Curated-type filter: 77% of the index is session summaries, and unfiltered
# recall spends its whole injection budget on them (2026-07-08 audit). Over-
# fetch 4× the limit, then keep only curated types. The server's `filters`
# param can't express type-IN-set (single value, ANDed), so filter client-side.
TYPES="${WORKBENCH_MEMORY_RECALL_TYPES-decision,insight,topic,feedback,reference}"
FETCH=$((LIMIT * 4))

# Truncate the search query: the raw prompt can carry pasted logs or diffs;
# the first ~500 chars carry the intent and the rest just skews ranking.
QUERY="${_trimmed:0:500}"

# Liveness breadcrumb — stamped on every substantive-prompt attempt (before
# the server call, so a down server still counts as "hook alive"). The warmup
# alerts when this goes stale >48h; a silent hook death is otherwise invisible.
STATE_DIR="${WORKBENCH_MEMORY_RECALL_STATE:-$HOME/.claude-workbench/memory-recall}"
if mkdir -p "$STATE_DIR" 2>/dev/null; then
  date +%s > "$STATE_DIR/last-attempt" 2>/dev/null || true
fi

# ──────────── Call the vault's search CLI (one-shot subprocess) ────────────
# `search --json` prints a bare JSON array [{path,title,frontmatter,sections,…}]
# straight to stdout and exits — no handshake, no session id, no framing (that
# was all Streamable-HTTP transport ceremony; the CLI has none of it). Guarded
# by a portable bash watchdog (no `timeout`/`gtimeout` on stock macOS): run in
# the background, race a `sleep $TIMEOUT` killer against it, capture stdout via
# a temp file since a backgrounded `VAR=$(cmd) &` would run the assignment in a
# subshell and lose the result. Deliberately NOT `disown`ed (unlike the
# detach-and-outlive use in memory-server-spawn.sh) — disowning stops bash from
# tracking the job, and `wait "$CLI_PID"` on an untracked pid returns before the
# process has actually finished writing, racing the read below. The watchdog
# SIGTERMs only CLI_PID itself (no process-group kill — job control is off in a
# non-interactive script, so `-$CLI_PID` would target this hook's OWN group);
# fine for the real CLI, which is a single process with no children.
OUT_FILE="$(mktemp 2>/dev/null)" || exit 0
"$SERVER_BIN" search "$QUERY" --mode "$MODE" --limit "$FETCH" --json \
  >"$OUT_FILE" 2>/dev/null &
CLI_PID=$!
( sleep "$TIMEOUT"; kill -TERM "$CLI_PID" 2>/dev/null ) &
WATCHDOG_PID=$!
wait "$CLI_PID" 2>/dev/null
CLI_RC=$?
kill "$WATCHDOG_PID" 2>/dev/null; wait "$WATCHDOG_PID" 2>/dev/null

RESPONSE=""
[ "$CLI_RC" -eq 0 ] && RESPONSE="$(cat "$OUT_FILE" 2>/dev/null)"
rm -f "$OUT_FILE" 2>/dev/null
[ -n "$RESPONSE" ] || exit 0

# ──────────── Parse the search hits ────────────
# Each hit becomes a TSV row of path / title / type / one-line summary.
_extract() {
  printf '%s\n' "$RESPONSE" | jq -r --argjson n "$LIMIT" --arg types "$TYPES" '
    ($types | if . == "" then [] else split(",") end) as $allowed
    | ( if ($allowed | length) > 0
        then map(select((.frontmatter.type // "note") as $t | $allowed | index($t)))
        else . end )
    | .[:$n][]
    | [ (.path // ""),
        (.title // .frontmatter.name // .path // ""),
        (.frontmatter.type // "note"),
        ( ( .frontmatter.summary
            // (.sections[0].content // "")
            ) | gsub("[\r\n\t]+"; " ") | gsub("^ +| +$"; "") )
      ]
    | @tsv
  ' 2>/dev/null
}
ROWS=$(_extract)
[ -n "$ROWS" ] || exit 0

# ──────────── Per-session dedup (the accumulation bound) ────────────
# A memory path is injected at most once per session. Track seen paths in a
# per-session file; filter this turn's hits against it; append the survivors.
# If every hit was already injected this session → emit nothing.
mkdir -p "$STATE_DIR" 2>/dev/null || exit 0
# Prune seen-files older than 3 days (mirrors capture-nudge / warmup retention).
find "$STATE_DIR" -name '*.seen' -mtime +3 -delete 2>/dev/null
SAFE_SID=$(printf '%s' "$SESSION_ID" | tr -c 'A-Za-z0-9._-' '_')
SEEN_FILE="$STATE_DIR/${SAFE_SID}.seen"
touch "$SEEN_FILE" 2>/dev/null || exit 0

# Build the bullet list from rows whose path is not already in SEEN_FILE.
BULLETS=""
NEW_PATHS=""
# Cap each summary to keep the injected block tight (~tweet per hit).
_SUMMAX=160
while IFS=$'\t' read -r _path _title _type _sum; do
  [ -n "$_path" ] || continue
  # Skip if already injected this session (persisted seen-file) OR already staged
  # this turn. The second check is belt-and-suspenders against a same-path
  # duplicate within THIS turn's rows — both use the same fixed-string,
  # whole-line match so a path that is a substring of another can't false-hit.
  if grep -Fxq "$_path" "$SEEN_FILE" 2>/dev/null; then
    continue
  fi
  if printf '%s' "$NEW_PATHS" | grep -Fxq "$_path" 2>/dev/null; then
    continue
  fi
  if [ "${#_sum}" -gt "$_SUMMAX" ]; then
    _sum="${_sum:0:$_SUMMAX}…"
  fi
  BULLETS="${BULLETS}• ${_title} [${_type}] — ${_sum} (${_path})
"
  NEW_PATHS="${NEW_PATHS}${_path}
"
done <<EOF
$ROWS
EOF

# Nothing new for this session → stay silent (the dedup bound at work).
[ -n "$BULLETS" ] || exit 0

# Commit the newly-injected paths to the seen file FIRST, and emit ONLY if that
# record succeeded — so dedup state and emitted output never diverge. Emitting
# without recording would re-inject the same memories every subsequent turn (a
# silent, unbounded context-cost regression); recording without emitting just
# costs one missed recall. The former is the only failure worth avoiding here.
if printf '%s' "$NEW_PATHS" >> "$SEEN_FILE" 2>/dev/null; then
  # ──────────── Emit the recall block ────────────
  # A short header + the bullets. The verify caveat is deliberate: recalled
  # memories reflect what was true WHEN WRITTEN — the agent must check them
  # against current code before acting, never treat them as ground truth.
  HEADER='🧠 Possibly-relevant past memories (vault auto-recall — verify against current code before acting; these reflect what was true when written):'
  CTX="${HEADER}
${BULLETS}"

  jq -cn --arg ctx "$CTX" \
    '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: $ctx}}' \
    2>/dev/null || true
fi
exit 0
