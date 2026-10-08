#!/usr/bin/env bash
#
# session-reconcile: start-up recovery for sessions that never got a usable
# SessionEnd, and the sweep that retires pending-summary markers nothing can
# recover.
#
# Sourced, never executed. Sourcing only DEFINES functions. Two callers:
#
#   - hooks/session-log.sh sources it for session_transcript_disposable, the one
#     copy of the rule that says which transcripts are never logged.
#   - hooks/session-warmup.sh sources it for the reconciler and the marker sweep,
#     which run at startup and resume, just before the pending-summary drain.
#
# Why a reconciler exists. The drain works only from markers, and only
# session-log.sh writes one, at PreCompact, /log-now, or SessionEnd. A session
# with no SessionEnd at all leaves no marker, so the drain cannot see it. On
# 2026-10-05 the Mac rebooted at 08:26 and nine transcripts last written at
# 08:18 were left with no log, no checkpoint, and no marker. One was a 789-line
# working session. Nothing at exit can cover a reboot or a SIGKILL, so the
# recovery has to happen at the next start, from the transcripts themselves.
#
# The reconciler writes nothing itself. It hands each recoverable session to
# session-log.sh in mode=reconcile, so one script owns the log format, the
# checkpoint, and the marker. A later per-turn checkpoint that writes the same
# log-checkpoints files therefore needs no change here: whatever writes the
# checkpoint, the reconciler reads only `next_line` and the file's mtime.
#
# It never spawns a summary writer. mode=reconcile is not a dispatching mode in
# session-log.sh, and the drain that runs right after it in session-warmup.sh is
# the designed place for summarization.

# session_transcript_disposable <transcript_path>
#
# True for a transcript that must never produce a log or a marker: sessions run
# in throwaway scratch, eval, or probe roots. On 2026-08-19 one
# `.../scratchpad/evalroot` fixture accounted for 274 of 332 processable markers.
# See `insights/2026-08-19-eval-fixture-sessions-dominate-the-summary-backlog`.
#
# Claude Code encodes the session cwd into the transcript directory name, so a
# scratch cwd usually shows up as a flattened path segment (the second pattern
# group) rather than as a real directory.
session_transcript_disposable() {
  case "${1:-}" in
    */scratchpad/*|*/evalroot/*|*evalroot*|*/probe-root/*|*probe-root*) return 0 ;;
    */projects/-private-tmp-claude-*|*-scratchpad-*) return 0 ;;
  esac
  return 1
}

# session_live_ids <registry_dir>
#
# Prints the session id of every live Claude Code process, one per line, from
# Claude Code's own registry: one `<pid>.json` per running CLI, carrying its
# `sessionId`. A file whose pid answers `kill -0` is live.
#
# Fails closed (returns 1) when the registry cannot be read, or when a live pid
# has a file this cannot parse: either way some running session is unknown, and
# reconciling a live session would log it twice. Every id it could parse is
# still printed, so a caller that only needs to leave the live sessions alone
# (the drain) keeps them. A stale file whose pid was
# reused after a reboot reads as live, which only defers that session to a
# later start.
session_live_ids() {
  local dir="${1:-}" f pid content whole=0
  [ -n "$dir" ] && [ -d "$dir" ] && [ -r "$dir" ] || return 1
  for f in "$dir"/*.json; do
    [ -f "$f" ] || continue
    pid="${f##*/}"
    pid="${pid%.json}"
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    kill -0 "$pid" 2>/dev/null || continue
    content=""
    IFS= read -r -d '' content < "$f" || true
    if [[ $content =~ \"sessionId\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
      printf '%s\n' "${BASH_REMATCH[1]}"
    else
      whole=1
    fi
  done
  return "$whole"
}

# session_transcript_has_conversation <transcript> <start_line>
#
# True when the transcript holds at least one user or assistant line at or
# after start_line. A transcript can sit a line or two past its checkpoint with
# only bookkeeping records (`cost-state`, `mode`), for example when Claude Code
# writes one after the last log write. Those lines are not a lost segment, and
# re-logging them would queue a summary for a session that lost nothing.
#
# grep is the cheap prefilter. jq confirms, so a quoted "type":"user" inside some
# other record's text cannot pass alone. A torn last line from a crash is
# skipped by `fromjson?` rather than failing the check.
session_transcript_has_conversation() {
  local transcript="$1" start="$2"
  sed -n "${start},\$p" "$transcript" 2>/dev/null \
    | grep -qE '"type"[[:space:]]*:[[:space:]]*"(user|assistant)"' || return 1
  sed -n "${start},\$p" "$transcript" 2>/dev/null \
    | jq -nR -e 'any(inputs | fromjson? ; type == "object" and (.type == "user" or .type == "assistant"))' \
      >/dev/null 2>&1
}

# session_reconcile <projects_dir> <current_sid> <log_hook> <checkpoints_dir>
#                   <pending_dir> <registry_dir>
#
# Hands each recoverable session to session-log.sh in mode=reconcile, oldest
# first, up to WORKBENCH_RECONCILE_BATCH (default 5) per call. Sets
# RECONCILE_STATUS for the caller's notices: "ok", "registry-unreadable", or
# "disabled". Prints nothing.
#
# A transcript is a candidate when ALL of these hold:
#   - it is a top-level `<projects>/<dir>/<sid>.jsonl`. Sub-agent transcripts sit
#     two levels deeper, under `<sid>/subagents/`, and are never scanned.
#   - it was last written inside the window (WORKBENCH_RECONCILE_WINDOW_MIN,
#     default 3 days) and at least WORKBENCH_RECONCILE_QUIET_MIN (default 30)
#     minutes ago. The quiet period is a second guard against a live session
#     the registry does not list.
#   - it is not the session that is starting, not live, not disposable, and not
#     a summary writer's own transcript.
#   - its checkpoint is missing (and no marker is queued), or the transcript
#     was written after the checkpoint AND holds conversation past `next_line`.
#
# A deferral is the exception to the window and the mtime test. A SessionEnd
# that skipped its copy under the size cap in session-log.sh leaves a
# `<sid>.deferred` file beside the checkpoint, holding the transcript path on
# its first line and the SessionEnd reason on its second. Pass 1 walks those
# files as well, with no time window, so a deferral is found even when no
# session starts for days. File times could not show it anyway: the deferring
# SessionEnd writes its checkpoint after the transcript's last line, so the
# checkpoint is always the newer file. Going past the window is safe here: the
# deferral and its checkpoint are written together and pruned together at 7
# days, so the checkpoint's `next_line` is always there, and nothing is logged
# again from line 1.
#
# The window is clamped below the 7-day checkpoint retention in session-warmup.sh.
# A transcript older than its pruned checkpoint would otherwise read as never
# logged, and be logged again from line 1.
# shellcheck disable=SC2034  # RECONCILE_STATUS is read by session-warmup.sh.
session_reconcile() {
  local projects="$1" current_sid="$2" log_hook="$3" checkpoints="$4" pending="$5" registry="$6"
  local batch="${WORKBENCH_RECONCILE_BATCH:-5}"
  local window="${WORKBENCH_RECONCILE_WINDOW_MIN:-4320}"
  local quiet="${WORKBENCH_RECONCILE_QUIET_MIN:-30}"
  local live="" live_read=0 t sid cp start content deferred logged=0 nl=$'\n' d
  local -a found=() ordered=()

  RECONCILE_STATUS="disabled"
  case "$batch" in ''|*[!0-9]*) return 0 ;; esac
  [ "$batch" -gt 0 ] || return 0
  case "$window" in ''|*[!0-9]*) window=4320 ;; esac
  case "$quiet" in ''|*[!0-9]*) quiet=30 ;; esac
  [ "$window" -gt 8640 ] && window=8640
  command -v jq >/dev/null 2>&1 || return 0
  RECONCILE_STATUS="ok"
  [ -d "$projects" ] || return 0

  # Pass 1, every recent transcript, in-shell tests only: one stat per
  # transcript and no process. On a working machine this is a few hundred
  # transcripts, and nearly all of them stop at the checkpoint mtime test.
  while IFS= read -r t; do
    [ -n "$t" ] || continue
    sid="${t##*/}"
    sid="${sid%.jsonl}"
    [ -n "$sid" ] && [ "$sid" != "$current_sid" ] || continue
    session_transcript_disposable "$t" && continue
    # A deferred session is taken from its deferral file below instead.
    [ -e "$checkpoints/$sid.deferred" ] && continue
    cp="$checkpoints/$sid.json"
    if [ -f "$cp" ]; then
      [ "$t" -nt "$cp" ] || continue
    else
      [ -e "$pending/$sid.json" ] && continue
    fi
    found+=("$t")
  done < <(find "$projects" -mindepth 2 -maxdepth 2 -type f -name '*.jsonl' \
             -mmin "-$window" ! -mmin "-$quiet" 2>/dev/null)

  # Pass 1b, every open deferral, whatever its age. A deferral is the largest
  # kind of session (past the size cap), so losing one to the window would lose
  # the most. One builtin read per file, and there are seldom any.
  for d in "$checkpoints"/*.deferred; do
    [ -f "$d" ] || continue
    sid="${d##*/}"
    sid="${sid%.deferred}"
    [ -n "$sid" ] && [ "$sid" != "$current_sid" ] || continue
    [ -f "$checkpoints/$sid.json" ] || continue
    t=""
    IFS= read -r t < "$d" || true
    [ -n "$t" ] && [ -f "$t" ] && [ "${t##*/}" = "$sid.jsonl" ] || continue
    session_transcript_disposable "$t" && continue
    found+=("$t")
  done
  [ "${#found[@]}" -gt 0 ] || return 0

  # Pass 2, the few that may have lost a segment, oldest first.
  while IFS= read -r t; do
    [ -n "$t" ] && ordered+=("$t")
  done < <(ls -tr -- "${found[@]}" 2>/dev/null)

  for t in "${ordered[@]}"; do
    [ "$logged" -ge "$batch" ] && break
    sid="${t##*/}"
    sid="${sid%.jsonl}"
    cp="$checkpoints/$sid.json"
    start=1
    deferred=0
    [ -e "$checkpoints/$sid.deferred" ] && deferred=1
    if [ -f "$cp" ]; then
      content=""
      IFS= read -r -d '' content < "$cp" || true
      [[ $content =~ \"next_line\"[[:space:]]*:[[:space:]]*([0-9]+) ]] && start="${BASH_REMATCH[1]}"
    fi

    # The registry is read once, and only when a transcript has passed pass 1.
    # A start with nothing to recover never reads it, so an unreadable registry
    # raises the notice only when it actually blocked work.
    if [ "$live_read" -eq 0 ]; then
      if ! live="$(session_live_ids "$registry")"; then
        RECONCILE_STATUS="registry-unreadable"
        return 0
      fi
      live_read=1
    fi
    case "$nl$live$nl" in *"$nl$sid$nl"*) continue ;; esac

    # A summary writer launched by summary_dispatch_spawn runs with
    # --no-session-persistence and leaves no transcript. This catches one that
    # did, by the first line of its brief, so it cannot queue a summary of a
    # summary.
    sed -n '1,40p' "$t" 2>/dev/null | grep -qF 'Process pending session summary.' && continue

    # A deferred segment is owed whatever it holds, and logging it is what
    # deletes the deferral file. Every other lag must hold conversation to count.
    if [ "$deferred" -eq 0 ] && ! session_transcript_has_conversation "$t" "$start"; then
      # Bookkeeping only. Touch the checkpoint so the next start stops this
      # transcript at the pass-1 mtime test instead of reading it again.
      [ -f "$cp" ] && touch "$cp" 2>/dev/null
      continue
    fi

    jq -nc --arg sid "$sid" --arg t "$t" \
      '{session_id: $sid, transcript_path: $t, hook_event_name: "Reconcile"}' \
      | env -u WORKBENCH_SKIP_LOG WORKBENCH_LOG_MODE=reconcile bash "$log_hook" >/dev/null 2>&1
    [ -f "$pending/$sid.json" ] && logged=$((logged + 1))
  done
  return 0
}

# pending_marker_sweep <pending_dir> <logfile>
#
# Deletes the pending-summary markers that nothing can ever drain, and records
# each one in the dispatch log. Exactly two kinds go:
#   - a 0-byte marker.
#   - a marker with no surviving source: each of `log_path` and
#     `transcript_path` is absent, null, empty, or names a file that does not
#     exist. The summary writer needs one of the two, so the drain can only
#     skip such a marker, on every start, forever. On 2026-10-05, 276 of them
#     from July and August were rewritten to the dispatch log about six times a
#     day.
#
# Every other marker stays, and the sweep fails closed on anything it cannot
# read with certainty: content that is not a JSON object, or a path field it
# cannot extract cleanly (an escaped character, say). A marker with any
# surviving source is still recoverable.
#
# Pure bash for the read, so a large backlog costs no process per marker. The
# deletes go out as one `rm`.
pending_marker_sweep() {
  local dir="$1" logfile="$2" m content field value ts re_str re_null alive unsure i
  local -a dead=() why=()
  local re_obj='^[[:space:]]*\{.*\}[[:space:]]*$'
  [ -d "$dir" ] || return 0

  for m in "$dir"/*.json; do
    [ -f "$m" ] || continue
    if [ ! -s "$m" ]; then
      dead+=("$m"); why+=("empty")
      continue
    fi
    content=""
    IFS= read -r -d '' content < "$m" || true
    [[ $content =~ $re_obj ]] || continue

    alive=0
    unsure=0
    for field in log_path transcript_path; do
      case "$content" in *"\"$field\""*) ;; *) continue ;; esac
      re_str="\"$field\"[[:space:]]*:[[:space:]]*\"([^\"\\\\]*)\""
      re_null="\"$field\"[[:space:]]*:[[:space:]]*null"
      if [[ $content =~ $re_str ]]; then
        value="${BASH_REMATCH[1]}"
        [ -n "$value" ] && [ -e "$value" ] && alive=1
      elif [[ $content =~ $re_null ]]; then
        :
      else
        unsure=1
      fi
    done
    [ "$alive" -eq 0 ] && [ "$unsure" -eq 0 ] || continue
    dead+=("$m"); why+=("no-source")
  done

  [ "${#dead[@]}" -gt 0 ] || return 0
  rm -f -- "${dead[@]}" 2>/dev/null || true
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  for i in "${!dead[@]}"; do
    [ -e "${dead[$i]}" ] && continue
    printf '%s purged-dead-marker marker=%s reason=%s\n' "$ts" "${dead[$i]}" "${why[$i]}"
  done >> "$logfile" 2>/dev/null || true
}
