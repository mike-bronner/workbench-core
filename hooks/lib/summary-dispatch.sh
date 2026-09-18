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

The log is a 7-day cache inside the vault. The transcript is the original
Claude Code JSONL and lives about 30 days. A missing log therefore means the
cache expired, never that the session is lost — summarize from transcript_path
whenever log_path is gone, and stamp `source: transcript` in the frontmatter.

Follow your agent definition. Write the summary via the memory MCP using a
vault-relative path (starting with '"'"'sessions/'"'"'), promote any decisions, delete
the marker, and exit. Never write summary files with Bash.
' "$1" "$2" "$3" "$4" "$MEMORY_PATH"
}

# summary_dispatch_spawn <session_id> <marker_path> <log_path> [transcript_path]
#
# Spawns one detached writer and returns immediately. Returns non-zero without
# spawning when NEITHER source is readable — the writer cannot produce a summary
# from nothing, and such a marker would otherwise spin forever on every session
# start. A readable transcript is enough on its own.
summary_dispatch_spawn() {
  local session_id="$1" marker_path="$2" log_path="$3" transcript_path="${4:-}"
  local model errlog

  summary_dispatch_readable "$log_path" "$transcript_path" || return 1

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
