#!/usr/bin/env bash
#
# summary-dispatch: spawn a detached summary-writer for one pending marker.
#
# Extracted from session-log.sh because there are now two call sites with
# different lifetime guarantees:
#
#   - session-log.sh on PreCompact / manual — the parent session is alive and
#     stays alive, so a detached child survives to finish its work.
#   - session-warmup.sh at session start   — same guarantee, from the other end.
#
# The call site that is deliberately ABSENT is SessionEnd. A child spawned as
# the parent CLI exits is killed during teardown: `nohup` immunises against
# SIGHUP only, not against a process-group SIGTERM or the OS reaping the job
# when the parent goes away. Between 2026-07-31 and 2026-08-14 that silently
# stranded 968 markers — every one of them `event: SessionEnd`, not a single
# PreCompact, which is the asymmetry that identified the bug. Work triggered at
# process death cannot be made to outlive the process by backgrounding it.
#
# Sourced, never executed. Callers must have MEMORY_PATH and CACHE_PATH set.

# The takeover lock behind a marker claim (lib/dir-lock.sh), from beside this
# file, so every caller gets it whatever its own HOOKS_DIR.
# shellcheck source=hooks/lib/dir-lock.sh
. "$(dirname "${BASH_SOURCE[0]}")/dir-lock.sh"

# Resolve the model for the writer. Precedence matches every other config read
# in this plugin: env override → config.json → hardcoded default.
# Requires the caller to have defined _cfg (both call sites do).
summary_dispatch_model() {
  local model
  model="${WORKBENCH_SUMMARY_MODEL:-$(_cfg '.summary_model')}"
  printf '%s' "${model:-sonnet}"
}

# True when auto-summarize is on AND a claude binary is actually reachable.
# Checked separately from the spawn so callers can skip the surrounding work
# (marker enumeration, lock acquisition) when dispatch is off entirely.
summary_dispatch_enabled() {
  [[ "${WORKBENCH_AUTO_SUMMARIZE:-$(_cfg '.auto_summarize')}" =~ ^(1|true)$ ]] \
    && command -v claude >/dev/null 2>&1
}

# Append-only dispatch trail. NOT named summary-writer-*.log: session-warmup.sh
# deletes that glob on every startup as legacy cleanup, which would silently eat
# this file and restore the exact blind spot it exists to close. Capped so an
# unattended failure loop can't fill the disk.
summary_dispatch_logfile() {
  printf '%s' "$CACHE_PATH/summary-dispatch-errors.log"
}

_summary_dispatch_cap_log() {
  local log="$1" size
  size=$(wc -c < "$log" 2>/dev/null || echo 0)
  if [ "${size:-0}" -gt 1048576 ]; then
    tail -c 524288 "$log" > "$log.tmp" 2>/dev/null && mv "$log.tmp" "$log" 2>/dev/null
  fi
}

# summary_dispatch_readable <log_path> <transcript_path>
#
# True when at least one of the writer's two sources is on disk. A marker
# carries two pointers to the same session with different lifetimes: the vault
# log is a 7-day cache (session-warmup.sh prunes at -mtime +7) and the
# transcript is the original Claude Code JSONL, which lives about 30 days. A
# missing log therefore means the cache expired, never that the session is lost,
# and agents/summary-writer.md step 2 tells the writer to fall back to the
# transcript and stamp `source: transcript`.
#
# Gating on the log alone made this helper stricter than the agent it gates, so
# the documented fallback was unreachable: on 2026-09-18, 778 of 779 markers
# were refused here and 503 of them still had a readable transcript on disk.
summary_dispatch_readable() {
  local log_path="${1:-}" transcript_path="${2:-}"
  { [ -n "$log_path" ] && [ -r "$log_path" ]; } \
    || { [ -n "$transcript_path" ] && [ -r "$transcript_path" ]; }
}

# summary_dispatch_prompt <session_id> <marker_path> <log_path> <transcript_path>
#
# The writer's whole brief, on stdout. Split out of the spawn so a test can read
# what the child is actually told without launching one — the pointers and the
# fallback rule ARE the fix, so they need an assertion of their own.
summary_dispatch_prompt() {
  printf 'Process pending session summary.

session_id: %s
marker_path: %s
log_path: %s
transcript_path: %s
memory_vault: %s
release_helper: %s

The log is a 7-day cache inside the vault. The transcript is the original
Claude Code JSONL and lives about 30 days. A missing log therefore means the
cache expired, never that the session is lost — summarize from transcript_path
whenever log_path is gone, and stamp `source: transcript` in the frontmatter.

Follow your agent definition. Write the summary via the memory MCP using a
vault-relative path (starting with '"'"'sessions/'"'"'), promote any decisions, release
the marker with release_helper, and exit. Never write summary files with Bash.
' "$1" "$2" "$3" "$4" "$MEMORY_PATH" "$SUMMARY_RELEASE_HELPER"
}

# The script the writer releases its marker with (agents/summary-writer.md,
# step 6): it deletes the marker only while it still holds the `marked_at` the
# writer read at its start. Resolved from beside this file, so it is right
# whatever the caller's working directory.
SUMMARY_RELEASE_HELPER="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/scripts/release-summary-marker.sh"

# How long a claim on a marker stands. A writer finishes well inside it, and a
# writer that died leaves its marker claimable again once it passes.
SUMMARY_CLAIM_TTL_MIN=60

# summary_dispatch_claim_dir <marker_path>
#
# Where the claim on a marker lives: a directory named for it under .claims/
# beside the markers, so no `*.json` listing of the markers ever sees it.
summary_dispatch_claim_dir() {
  printf '%s/.claims/%s' "$(dirname "$1")" "$(basename "$1")"
}

# _summary_dispatch_claim_stale <marker_path> <claim_dir>
#
# True when the claim no longer holds its marker: the marker is gone (its
# writer finished), the marker is newer than the claim (session-log.sh wrote a
# new marker for a later segment), or the claim is past the TTL.
_summary_dispatch_claim_stale() {
  [ ! -e "$1" ] || [ "$1" -nt "$2" ] \
    || [ -n "$(find "$2" -maxdepth 0 -mmin +"$SUMMARY_CLAIM_TTL_MIN" 2>/dev/null)" ]
}

# _summary_dispatch_drop_stale <marker_path> <claim_dir> [retake]
#
# Removes a stale claim, and with `retake` claims the marker in its place.
# Checking, removing and re-creating are three steps, so they run under a
# second mkdir lock (<claim>.takeover), and the claim is checked again once the
# lock is held. Without that, two callers that both saw the claim stale could
# both remove it, and the second would remove the first one's fresh claim. A
# caller that does not get the lock gets nothing. True when this caller holds
# the claim (retake), or removed it. The takeover lock is taken with
# dir_lock_take (lib/dir-lock.sh), so one its holder left behind when killed is
# itself broken after a minute, under the same check-again rule, and never
# blocks the claim for good.
_summary_dispatch_drop_stale() {
  local marker="$1" claim="$2" retake="${3:-}" lock="$2.takeover" won=1
  dir_lock_take "$lock" || return 1
  if [ -d "$claim" ] && _summary_dispatch_claim_stale "$marker" "$claim"; then
    rmdir "$claim" 2>/dev/null
    if [ -n "$retake" ]; then
      mkdir "$claim" 2>/dev/null && won=0
    else
      won=0
    fi
  fi
  rmdir "$lock" 2>/dev/null
  return "$won"
}

# summary_dispatch_claim <marker_path>
#
# Claims a marker for one writer. mkdir is the atomic test-and-set, so of two
# spawns on one marker, only one gets it, even from two sessions starting at
# once. The writer never releases a claim: it deletes the marker, and the
# claim then goes stale (_summary_dispatch_claim_stale). A stale claim is taken
# over under its takeover lock. True when this caller holds the claim.
summary_dispatch_claim() {
  local marker="$1" claim
  claim="$(summary_dispatch_claim_dir "$marker")"
  mkdir -p "$(dirname "$claim")" 2>/dev/null || return 1
  mkdir "$claim" 2>/dev/null && return 0
  _summary_dispatch_drop_stale "$marker" "$claim" retake
}

# summary_dispatch_sweep_claims <pending_dir>
#
# Removes the claims nobody needs, each under its takeover lock as above, and
# any takeover lock a caller that died left behind for over a minute. That one
# is taken over under its own takeover, checked again, then removed
# (lib/dir-lock.sh), so the sweep never removes a takeover a live caller has
# just taken. Only empty directories go.
summary_dispatch_sweep_claims() {
  local dir="$1/.claims" claim takeover
  [ -d "$dir" ] || return 0
  for takeover in "$dir"/*.takeover; do
    dir_lock_is_stale "$takeover" && dir_lock_take_stale "$takeover" && rmdir "$takeover" 2>/dev/null
  done
  for claim in "$dir"/*.json; do
    [ -d "$claim" ] || continue
    _summary_dispatch_drop_stale "$1/$(basename "$claim")" "$claim"
  done
  return 0
}

# summary_dispatch_spawn <session_id> <marker_path> <log_path> [transcript_path]
#
# Spawns one detached writer and returns immediately. Returns 1 without
# spawning when NEITHER source is readable — the writer cannot produce a summary
# from nothing, and such a marker would otherwise spin forever on every session
# start. A readable transcript is enough on its own. Returns 2 without spawning
# when another spawn holds the marker's claim (summary_dispatch_claim), so two
# writers never run on one session.
summary_dispatch_spawn() {
  local session_id="$1" marker_path="$2" log_path="$3" transcript_path="${4:-}"
  local model errlog

  summary_dispatch_readable "$log_path" "$transcript_path" || return 1
  if ! summary_dispatch_claim "$marker_path"; then
    printf '%s claimed marker=%s sid=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$marker_path" "$session_id" \
      >> "$(summary_dispatch_logfile)" 2>/dev/null || true
    return 2
  fi

  model="$(summary_dispatch_model)"
  errlog="$(summary_dispatch_logfile)"

  if [ "${WORKBENCH_DISPATCH_DRY_RUN:-}" = "1" ]; then
    # Test hook (hooks/test-session-log.sh, hooks/test-session-warmup.sh): print
    # the resolved invocation instead of spawning. Set only by tests; never in
    # production. Emits the session id so a multi-marker drain can be asserted
    # marker-by-marker rather than only by dispatch count. The two source paths
    # are printed so a test can tell a log dispatch from a transcript-fallback
    # dispatch, which is the whole point of accepting either one.
    printf 'DISPATCH sid=%s\n' "$session_id"
    printf 'DISPATCH log=%s\n' "$log_path"
    printf 'DISPATCH transcript=%s\n' "$transcript_path"
    printf 'DISPATCH cwd=%s\n' "$MEMORY_PATH"
    printf 'DISPATCH env WORKBENCH_MEMORY_PATH=%s\n' "$MEMORY_PATH"
    printf 'DISPATCH env WORKBENCH_SUMMARY_WRITER=1\n'
    printf 'DISPATCH env CLAUDE_CODE_DISABLE_CLAUDE_MDS=1\n'
    printf 'DISPATCH model=%s\n' "$model"
    printf 'DISPATCH logfile=%s\n' "$errlog"
    printf 'DISPATCH args=%s\n' "--add-dir $MEMORY_PATH --model $model --agent summary-writer"
    return 0
  fi

  _summary_dispatch_cap_log "$errlog"

  local prompt
  prompt="$(summary_dispatch_prompt \
    "$session_id" "$marker_path" "$log_path" "$transcript_path")"

  # Safeguards (unchanged from the original session-log.sh dispatch):
  #   - WORKBENCH_SKIP_LOG=1 stops the child's own SessionEnd hook recursing.
  #   - WORKBENCH_SKIP_WARMUP=1 stops identity injection and marker scanning in
  #     the child — critically, it also stops the child from draining markers
  #     itself, which would otherwise fan out geometrically from the warmup.
  #   - --no-session-persistence keeps the child from leaving a transcript that
  #     would become a new pending summary.
  #   - The child is launched FROM the vault dir and granted it via --add-dir so
  #     an accidental relative write lands in the vault, not the source project
  #     (see the summary-misroute RCA).
  #   - WORKBENCH_SUMMARY_WRITER=1 marks the child so the PreToolUse guard
  #     (hooks/summary-writer-guard.sh) can hard-block any Bash write to a .md.
  #   - CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 keeps ~/.claude/CLAUDE.md and every
  #     project CLAUDE.md out of the child. Those files are written for an
  #     interactive session with a human in it, and the child obeyed them: its
  #     runs ended in "Open questions" blocks nobody reads and offered `!rm`
  #     commands to a user who was not there. agents/summary-writer.md sets
  #     `omitClaudeMd: true` too, but Claude Code applies that field only to a
  #     sub-agent spawned through the Agent tool. Measured on 2.1.283: a
  #     top-level `claude -p --agent` run still loaded CLAUDE.md with the field
  #     set, and loaded none of it with this variable. The memory MCP stayed
  #     available either way.
  #
  # Output goes to the dispatch log, NOT /dev/null. The process-group kill was
  # the defect; two weeks of nobody noticing was a consequence of discarding
  # every byte the child produced. A background job with no failure channel is
  # one you diagnose by archaeology.
  (
    cd "$MEMORY_PATH" 2>/dev/null || exit 0
    WORKBENCH_SKIP_LOG=1 WORKBENCH_SKIP_WARMUP=1 \
      WORKBENCH_MEMORY_PATH="$MEMORY_PATH" \
      WORKBENCH_SUMMARY_WRITER=1 \
      CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 \
      nohup claude -p \
      --no-session-persistence \
      --permission-mode bypassPermissions \
      --add-dir "$MEMORY_PATH" \
      --model "$model" \
      --agent summary-writer \
      "$prompt" \
      >> "$errlog" 2>&1 &
    disown 2>/dev/null || true
  )
}
