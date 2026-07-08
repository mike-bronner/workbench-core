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
# context cost. So this hook holds three levers:
#   1. Per-session dedup — a memory path is injected AT MOST ONCE per session.
#      Accumulation is bounded by the number of DISTINCT relevant memories, not
#      turns. A recurring topic never re-injects the same note.
#   2. Substance gate — trivial prompts (short, bare confirmations, slash
#      commands) emit nothing, so most turns cost zero tokens.
#   3. Small top-K — default 2 hits, each trimmed to a one-line summary.
#
# Env knobs:
#   WORKBENCH_MEMORY_RECALL=0           → disable entirely.
#   WORKBENCH_MEMORY_RECALL_LIMIT=N     → max hits to inject (default 2).
#   WORKBENCH_MEMORY_RECALL_MIN_CHARS=N → min prompt length to search (default 16).
#   WORKBENCH_MEMORY_RECALL_MODE=...    → search mode (default hybrid).
#   WORKBENCH_MEMORY_RECALL_TIMEOUT=N   → curl --max-time seconds (default 4).
#   WORKBENCH_MEMORY_RECALL_STATE=DIR   → per-session seen-paths state dir override.
#   (vault location/port/token come from lib/memory-env.sh, like every other hook.)
#
# Never fails the session. Always exits 0 — missing jq, a down server, a
# malformed payload, or a curl timeout all degrade to a silent no-op.

set -u

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
command -v curl >/dev/null 2>&1 || exit 0

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

# ──────────── Resolve vault env (port / cache / name) ────────────
# Same resolution every other memory hook uses, so we always agree on where the
# vault and its token live. memory_load_env sets MEMORY_PORT / MCP_NAME /
# CACHE_PATH (precedence: WORKBENCH_* override → config.json → default).
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hooks/lib/memory-env.sh
. "$HOOK_DIR/lib/memory-env.sh" 2>/dev/null || exit 0
memory_load_env 2>/dev/null || exit 0

PORT="${MEMORY_PORT:-8765}"
CACHE="${CACHE_PATH:-$HOME/.claude-memory-cache}"
LIMIT="${WORKBENCH_MEMORY_RECALL_LIMIT:-2}"
case "$LIMIT" in ''|*[!0-9]*) LIMIT=2 ;; esac
[ "$LIMIT" -lt 1 ] && LIMIT=2
MODE="${WORKBENCH_MEMORY_RECALL_MODE:-hybrid}"
TIMEOUT="${WORKBENCH_MEMORY_RECALL_TIMEOUT:-4}"
case "$TIMEOUT" in ''|*[!0-9]*) TIMEOUT=4 ;; esac

# ──────────── Call the vault's search tool over the HTTP MCP ────────────
# Wire conventions match lib/memory-probe.sh: JSON-RPC POST to /mcp, the dual
# Accept header the Streamable-HTTP transport needs, and the bearer token carried
# through a curl -K - stdin config (NEVER on argv, where ps / /proc/<pid>/cmdline
# would leak it).
#
# Unlike the probe (which only ever calls `initialize`), a `tools/call` needs an
# established MCP session: the transport rejects a bare tool call with
# "Missing session ID". So this is a two-step handshake —
#   1. POST `initialize`; the server returns an `Mcp-Session-Id` response header.
#   2. POST `tools/call` for `search`, echoing that header.
# (The `notifications/initialized` step is not required by this server.)
TOKEN=""
[ -f "$CACHE/server.token" ] && TOKEN="$(cat "$CACHE/server.token" 2>/dev/null)"
CONFIG=""
[ -n "$TOKEN" ] && CONFIG="header = \"Authorization: Bearer $TOKEN\""
URL="http://127.0.0.1:$PORT/mcp"

# Step 1: initialize, capturing response headers (-D -, body discarded) to read
# the session id the transport mints for this exchange.
INIT_BODY='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"memory-recall","version":"1"}}}'
INIT_HDRS=$(printf '%s\n' "$CONFIG" \
  | curl -fsS --max-time "$TIMEOUT" -K - -D - -o /dev/null \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -X POST "$URL" -d "$INIT_BODY" 2>/dev/null) || exit 0
SID=$(printf '%s' "$INIT_HDRS" \
  | grep -i '^mcp-session-id:' | head -n 1 | sed 's/^[^:]*: *//' | tr -d '\r\n')
[ -n "$SID" ] || exit 0

# Step 2: the search call, carrying the session id.
BODY=$(jq -cn --arg q "$PROMPT" --arg mode "$MODE" --argjson lim "$LIMIT" \
  '{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"search",arguments:{query:$q,mode:$mode,limit:$lim,chunks_per_file:1,snippet_words:28}}}' \
  2>/dev/null) || exit 0

RESPONSE=$(printf '%s\n' "$CONFIG" \
  | curl -fsS --max-time "$TIMEOUT" -K - \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H "Mcp-Session-Id: $SID" \
    -X POST "$URL" -d "$BODY" 2>/dev/null)
[ -n "$RESPONSE" ] || exit 0

# ──────────── Parse the search hits ────────────
# The transport answers as a single JSON object or an SSE stream
# (`event: message\ndata: {json}\n\n`). Strip the SSE framing the same way
# memory-probe does (`sed -n 's/^data: *//; /^{/p'`), then pull the tool result.
# markdown-vault-mcp returns the search payload as a JSON string in
# result.content[].text — a BARE ARRAY [{path,title,frontmatter,sections,…}]
# (confirmed against the live server), each text accepting either an array OR a
# {"result":[…]} object. The live server ALSO mirrors the same hits into
# result.structuredContent, so the two sources must NOT be unioned (that would
# inject every hit twice). Prefer content; fall back to structuredContent only
# when content yields nothing. Each hit becomes a TSV row of
# path / title / type / one-line summary.
DEFRAMED=$(printf '%s\n' "$RESPONSE" | sed -n 's/^data: *//; /^{/p')
[ -n "$DEFRAMED" ] || exit 0

_extract() {
  printf '%s\n' "$DEFRAMED" | jq -rR --argjson n "$LIMIT" '
    fromjson?
    | ( [ .result.content[]?.text | fromjson? ]
        | map( if type == "array" then .
               elif type == "object" then (.result // [])
               else [] end )
        | add // [] ) as $fromcontent
    | ( if ($fromcontent | length) > 0 then $fromcontent
        else ( .result.structuredContent
               | if type == "object" then (.result // [])
                 elif type == "array" then .
                 else [] end )
        end )
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
STATE_DIR="${WORKBENCH_MEMORY_RECALL_STATE:-$HOME/.claude-workbench/memory-recall}"
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
