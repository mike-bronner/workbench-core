#!/usr/bin/env bash
#
# memory-recall-core: the levers that every automatic vault-recall hook shares.
#
# Two hooks call this:
#   memory-recall.sh       UserPromptSubmit — searches the user's PROMPT.
#   memory-scan-recall.sh  PostToolUse      — searches with a repo scan's OWN
#                                             query, so a topic the prompt never
#                                             named still surfaces a memory.
#
# WHY A LIBRARY AND NOT A SECOND COPY. Each lever below was tuned by measurement
# against an incident, and memory-recall.sh's header records what each one cost
# to learn. A second hook that re-implemented them would drift from that tuning
# silently, because the failure mode is invisible from the outside: recall that
# quietly costs more context than it saves, or stops arriving at all. One copy,
# two callers.
#
# WHAT BELONGS HERE, AND WHAT DOES NOT. Only the plumbing between a query and a
# deduped list of bullets: resolve the vault, run the search, filter hits by
# type, drop the ones this session already saw. No trigger logic. Nothing here
# decides WHETHER a recall happens or whether one is worth running — each hook
# owns its own trigger, its own knobs, and its own header text, because the two
# fire on different events and a shared decision would have to be wrong for one
# of them.
#
# Every function RETURNS non-zero rather than exiting, so each caller keeps its
# own fail-open contract (always exit 0, never break the turn).

# ──────────── Curated-type filter (shared default) ────────────
# 77% of the index is session summaries, and unfiltered recall spends its whole
# injection budget on them (2026-07-08 audit).
#
# MEMBERSHIP RULE — stated so this list cannot go stale by omission: a type
# belongs here when a note of that type asserts something STILL TRUE NOW that is
# meant to change what the agent does next. Judge a type by that, not by whether
# it appears below.
#
# The first cut of this list named five types and so excluded, silently, the
# ones that carry explicit lessons. All three are admitted by the rule and are
# now in the default:
#   project         — an ongoing effort's state and the constraints it fixed.
#   skill-learnings — the durable per-skill execution notes under skills/.
#   recurring-issue — a fault that keeps coming back, and what settles it.
# Measured, not assumed: replaying the prompt "go ahead and push and create a
# release" against the live vault ranked skills/develop.learnings.md 4th (twice,
# 2026-09-14), where the old five-type list discarded it before injection.
#
# Two types stay OUT on that same rule, deliberately rather than by oversight:
#   session   — narrates one past session. This is the 77% above.
#   learnings — DATED decision-quality evaluation snapshots under learnings/,
#               each superseded by the next. Injecting an old snapshot into a
#               live turn misinforms; the conclusions worth keeping are promoted
#               to decision/insight notes, which ARE eligible.
# Read by the callers, not here, so shellcheck cannot see the use.
# shellcheck disable=SC2034
MEMORY_RECALL_DEFAULT_TYPES='decision,insight,topic,feedback,reference,project,skill-learnings,recurring-issue'

_MEMORY_RECALL_CORE_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ──────────── memory_recall_int <value> <default> ────────────
# Clamp an env knob to a positive integer, falling back to the default on
# garbage or on a value below 1. Echoes the result.
memory_recall_int() {
  local value="$1" default="$2"
  case "$value" in ''|*[!0-9]*) value="$default" ;; esac
  [ "$value" -lt 1 ] && value="$default"
  printf '%s' "$value"
}

# ──────────── memory_recall_prepare <log-fn> ────────────
# Resolve where the vault lives and which binary searches it, exporting the
# MARKDOWN_VAULT_MCP_* env the CLI reads and setting SERVER_BIN. Returns 1 when
# either step fails, which every caller turns into a silent no-op.
#
# TRANSPORT: the resolved binary is invoked as the `markdown-vault-mcp search`
# CLI — a one-shot subprocess that loads the index, runs the query, prints JSON,
# and exits. NOT the `serve` command: no port, no daemon, nothing left running
# afterward. That makes it consistent with the per-session stdio MCP transport
# (mcp-memory.sh) — no shared server for either to depend on — at the cost of
# ~1s per call (process start + loading the embedding index fresh every time,
# vs. a warm daemon's ~25ms). Deliberate trade: see the vault insight
# 2026-07-26-memory-recall-cli-migration for the measurement and the alternative
# (a properly-supervised daemon) that was rejected in favor of this. Before this,
# the hook curled a shared HTTP server on port 8765 that the per-session-stdio
# revert (PR #14) left undersupervised — an orphaned instance from the old
# shared-server model kept it silently "working" for 18 days after the revert,
# until it was found and killed.
memory_recall_prepare() {
  local log_fn="${1:-:}"

  # memory-install.sh reads `${HOOKS_DIR:?}/wheels`. shellcheck cannot follow
  # that far through the source chain, so the use is invisible here.
  # shellcheck disable=SC2034
  HOOKS_DIR="$(dirname "$_MEMORY_RECALL_CORE_LIB")"

  # shellcheck source=hooks/lib/memory-env.sh
  . "$_MEMORY_RECALL_CORE_LIB/memory-env.sh" 2>/dev/null || return 1
  memory_load_env 2>/dev/null || return 1

  # shellcheck source=hooks/lib/memory-install.sh
  . "$_MEMORY_RECALL_CORE_LIB/memory-install.sh" 2>/dev/null || return 1

  # WORKBENCH_MEMORY_SERVER_BIN short-circuits the resolve — the test suite
  # points that at the fake-binary fixture.
  if [ -n "${WORKBENCH_MEMORY_SERVER_BIN:-}" ]; then
    SERVER_BIN="$WORKBENCH_MEMORY_SERVER_BIN"
  else
    # Never block a turn on another session's install: a 0s lock timeout makes
    # the resolve fail closed instead of waiting. The installing session gets
    # memory; this turn simply goes without recall.
    WORKBENCH_MEMORY_INSTALL_LOCK_TIMEOUT=0 \
      memory_install_server "$log_fn" 2>/dev/null || return 1
  fi
  [ -n "${SERVER_BIN:-}" ] && [ -x "$SERVER_BIN" ] || return 1
}

# ──────────── memory_recall_search <bin> <query> <mode> <fetch> <timeout> ────────────
# One-shot CLI search. Echoes the raw JSON array on success; returns 1 on a
# crash, a timeout, or empty output.
#
# `search --json` prints a bare JSON array [{path,title,frontmatter,sections,…}]
# straight to stdout and exits — no handshake, no session id, no framing (that
# was all Streamable-HTTP transport ceremony; the CLI has none of it). Guarded by
# a portable bash watchdog (no `timeout`/`gtimeout` on stock macOS): run in the
# background, race a `sleep $timeout` killer against it, capture stdout via a
# temp file since a backgrounded `VAR=$(cmd) &` would run the assignment in a
# subshell and lose the result. Deliberately NOT `disown`ed (unlike the
# detach-and-outlive use in memory-server-spawn.sh) — disowning stops bash from
# tracking the job, and `wait "$cli_pid"` on an untracked pid returns before the
# process has actually finished writing, racing the read below. The watchdog
# SIGTERMs only cli_pid itself (no process-group kill — job control is off in a
# non-interactive script, so `-$cli_pid` would target this hook's OWN group);
# fine for the real CLI, which is a single process with no children.
#
# THE WATCHDOG'S STDOUT IS /dev/null, AND THAT IS LOAD-BEARING. Killing the
# watchdog subshell does not kill the `sleep` it forked: that child is reparented
# and keeps running until its timeout expires. Whatever fds it inherited, it
# holds. With the hook's own stdout inherited, a caller reading that stdout to
# EOF blocks for the FULL timeout on every successful search, long after the CLI
# answered in milliseconds. Measured 2026-09-14: the hook took 8s wall with
# TIMEOUT=8 and 2s with TIMEOUT=1 on a fixture that replies instantly, and the
# hook suite ran 1m47s instead of sub-second. Redirecting here costs nothing —
# the watchdog has no output — and it is what makes a per-tool-call recall hook
# viable at all.
memory_recall_search() {
  local bin="$1" query="$2" mode="$3" fetch="$4" timeout="$5"
  local out_file cli_pid watchdog_pid cli_rc response

  out_file="$(mktemp 2>/dev/null)" || return 1
  "$bin" search "$query" --mode "$mode" --limit "$fetch" --json \
    >"$out_file" 2>/dev/null &
  cli_pid=$!
  ( sleep "$timeout"; kill -TERM "$cli_pid" 2>/dev/null ) >/dev/null 2>&1 &
  watchdog_pid=$!
  wait "$cli_pid" 2>/dev/null
  cli_rc=$?
  kill "$watchdog_pid" 2>/dev/null; wait "$watchdog_pid" 2>/dev/null

  response=""
  [ "$cli_rc" -eq 0 ] && response="$(cat "$out_file" 2>/dev/null)"
  rm -f "$out_file" 2>/dev/null
  [ -n "$response" ] || return 1
  printf '%s' "$response"
}

# ──────────── memory_recall_rows <response> <limit> <types> ────────────
# Turn the raw search JSON into at most <limit> TSV rows of
# path / title / type / one-line summary, keeping only the curated types.
#
# The server's `filters` param can't express type-IN-set (single value, ANDed),
# so the filter is client-side and the caller over-fetches to leave room for it.
# An EMPTY <types> disables the filter, which is the documented off switch.
memory_recall_rows() {
  local response="$1" limit="$2" types="$3"
  printf '%s\n' "$response" | jq -r --argjson n "$limit" --arg types "$types" '
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

# ──────────── memory_recall_seen_file <state-dir> <session-id> ────────────
# Echo the per-session seen-paths file, creating the state dir and pruning stale
# state on the way. Returns 1 when the dir or the file cannot be created.
#
# Retention: 3 days, mirroring capture-nudge and the warmup sweep. The session id
# is sanitized before it becomes a filename — defense in depth, since ids are
# normally hex/UUID but an external value never belongs in a path unfiltered.
memory_recall_seen_file() {
  local state_dir="$1" session_id="$2" safe_sid seen_file
  mkdir -p "$state_dir" 2>/dev/null || return 1
  find "$state_dir" -name '*.seen' -mtime +3 -delete 2>/dev/null
  safe_sid=$(printf '%s' "$session_id" | tr -c 'A-Za-z0-9._-' '_')
  seen_file="$state_dir/${safe_sid}.seen"
  touch "$seen_file" 2>/dev/null || return 1
  printf '%s' "$seen_file"
}

# ──────────── memory_recall_bullets <rows> <seen-file> [summary-cap] ────────────
# THE ACCUMULATION BOUND. A memory path is injected AT MOST ONCE PER SESSION,
# across every hook that shares the seen file. additionalContext accumulates in
# the transcript and nothing evicts it, so without this the cost scales with the
# number of turns and tool calls — unbounded. With it, the bound is the number of
# DISTINCT relevant memories. A recurring topic never re-injects the same note,
# and a memory the prompt already surfaced is never repeated by a later scan.
#
# Sets two globals rather than echoing, because the caller needs both halves:
#   MEMORY_RECALL_BULLETS    the rendered bullet lines (empty = nothing new)
#   MEMORY_RECALL_NEW_PATHS  the paths to commit once the block is emitted
# Both are read by the callers, not here.
# shellcheck disable=SC2034
memory_recall_bullets() {
  local rows="$1" seen_file="$2" summax="${3:-160}"
  local _path _title _type _sum
  MEMORY_RECALL_BULLETS=""
  MEMORY_RECALL_NEW_PATHS=""
  while IFS=$'\t' read -r _path _title _type _sum; do
    [ -n "$_path" ] || continue
    # Skip if already injected this session (persisted seen-file) OR already
    # staged this turn. The second check is belt-and-suspenders against a
    # same-path duplicate within THIS call's rows — both use the same
    # fixed-string, whole-line match so a path that is a substring of another
    # can't false-hit.
    if grep -Fxq "$_path" "$seen_file" 2>/dev/null; then
      continue
    fi
    if printf '%s' "$MEMORY_RECALL_NEW_PATHS" | grep -Fxq "$_path" 2>/dev/null; then
      continue
    fi
    # Cap each summary to keep the injected block tight (~tweet per hit).
    if [ "${#_sum}" -gt "$summax" ]; then
      _sum="${_sum:0:$summax}…"
    fi
    MEMORY_RECALL_BULLETS="${MEMORY_RECALL_BULLETS}• ${_title} [${_type}] — ${_sum} (${_path})
"
    MEMORY_RECALL_NEW_PATHS="${MEMORY_RECALL_NEW_PATHS}${_path}
"
  done <<EOF
$rows
EOF
}

# ──────────── memory_recall_commit <seen-file> <paths> ────────────
# Record the newly-injected paths BEFORE anything is emitted, and let the caller
# emit only when this succeeds — so dedup state and emitted output never diverge.
# Emitting without recording would re-inject the same memories on every
# subsequent turn and tool call (a silent, unbounded context-cost regression);
# recording without emitting just costs one missed recall. The former is the only
# failure worth avoiding here.
memory_recall_commit() {
  local seen_file="$1" paths="$2"
  printf '%s' "$paths" >> "$seen_file" 2>/dev/null
}
