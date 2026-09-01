#!/usr/bin/env bash
#
# memory-refs: live-session reference counting for the shared HTTP memory server.
#
# The shared server historically followed a "single never-stop model" — once up,
# it stayed up until someone ran memory-server-down.sh by hand. That is wrong for
# a laptop: a server nobody is using holds the embedding model resident (a few
# hundred MB) and keeps a git pull loop running for an empty room.
#
# This library is the other half of the lazy-start machinery. memory-server-up.sh
# brings the server up on demand; these refs decide when the last session has
# gone so memory-server-idle-stop.sh can take it back down.
#
# Sourceable and side-effect-free: sourcing only DEFINES functions. Callers must
# source lib/memory-env.sh and call memory_load_env first, so CACHE_PATH is set.
#
# ── Why PIDs and not just SessionEnd ────────────────────────────────────────
# A ref released only by SessionEnd leaks forever the first time a session is
# SIGKILLed, the terminal is closed, or the machine loses power — and one leaked
# ref pins the server on permanently, which is precisely the bug this is meant to
# fix. So a ref records the owning `claude` process id, and liveness is a
# `kill -0` on that pid rather than a promise that a hook will fire. SessionEnd
# is the fast path; the sweep is the correctness guarantee.
#
# ── Why the owner pid is walked, not $PPID ──────────────────────────────────
# A hook's immediate parent is whatever shell the harness used to invoke it, not
# the session. Recording that pid would mark every ref dead the instant the hook
# returned. So walk up the process tree to the nearest `claude` ancestor and
# record THAT — it lives exactly as long as the session does, which is the
# lifetime we actually want to track. $PPID is the fallback when no such ancestor
# is found (an unusual harness, or a test), which degrades to "dies early" rather
# than "pins forever" — the safe direction.

# memory_refs_dir: echo the ref registry directory. One file per live session.
memory_refs_dir() {
  printf '%s' "${WORKBENCH_MEMORY_REFS_DIR:-${CACHE_PATH:?CACHE_PATH must be set}/refs}"
}

# _memory_refs_file: the ref file path for a session id.
#
# The id is sanitized (never trust an external value that becomes a path) and
# then prefixed with a literal `s-`. The prefix is load-bearing, not decoration:
# sanitizing preserves dots, so an id like `../x` becomes `.._x` — a leading dot,
# which the `*.ref` glob in the sweep and the count would both skip. Such a ref
# would be invisible: never counted, so never able to hold the server up for the
# session that owns it. The prefix guarantees every ref file is globbable.
_memory_refs_file() {
  local safe
  safe="$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_')"
  printf '%s/s-%s.ref' "$(memory_refs_dir)" "$safe"
}

# _memory_refs_owner_pid: nearest `claude` ancestor of $1 (default: our parent),
# falling back to that starting pid when none is found. Bounded to 12 hops so a
# pathological process tree can never spin here.
#
# `ps -o comm=` prints a bare name on Linux and sometimes a full path on macOS,
# so compare on the basename to stay portable across both.
_memory_refs_owner_pid() {
  local start="${1:-$PPID}" pid hops=0 comm
  pid="$start"
  while [ "$hops" -lt 12 ]; do
    case "$pid" in ''|*[!0-9]*) break ;; esac
    [ "$pid" -gt 1 ] || break
    comm="$(ps -o comm= -p "$pid" 2>/dev/null | tr -d ' ')"
    case "${comm##*/}" in
      claude|claude-code) printf '%s' "$pid"; return 0 ;;
    esac
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
    hops=$((hops + 1))
  done
  printf '%s' "$start"
}

# memory_ref_register <session_id> [owner_pid]: record this session as live.
#
# Idempotent — re-registering the same session id overwrites its ref rather than
# double-counting, so a SessionStart that fires twice (startup then clear/compact)
# cannot inflate the count. Never fails the caller: an unwritable cache degrades
# to "no ref", which loses auto-stop precision but breaks nothing.
memory_ref_register() {
  local sid="$1" owner refs
  [ -n "$sid" ] || return 0
  owner="${2:-$(_memory_refs_owner_pid)}"
  refs="$(memory_refs_dir)"
  mkdir -p "$refs" 2>/dev/null || return 0
  printf '%s' "$owner" > "$(_memory_refs_file "$sid")" 2>/dev/null || true
  return 0
}

# memory_ref_release <session_id>: drop this session's ref. Always succeeds.
memory_ref_release() {
  local sid="$1"
  [ -n "$sid" ] || return 0
  rm -f "$(_memory_refs_file "$sid")" 2>/dev/null || true
  return 0
}

# memory_refs_sweep: delete refs whose owning process is gone.
#
# This is what makes the count self-healing after a crash. A ref file that is
# empty or malformed is also swept — it can never be proven live, and leaving it
# would pin the server exactly as a leaked ref does.
memory_refs_sweep() {
  local refs f pid
  refs="$(memory_refs_dir)"
  [ -d "$refs" ] || return 0
  for f in "$refs"/s-*.ref; do
    [ -e "$f" ] || continue
    pid="$(cat "$f" 2>/dev/null)"
    case "$pid" in
      ''|*[!0-9]*) rm -f "$f" 2>/dev/null || true; continue ;;
    esac
    kill -0 "$pid" 2>/dev/null || rm -f "$f" 2>/dev/null || true
  done
  return 0
}

# memory_refs_count: sweep, then echo the number of live sessions. Always echoes
# an integer, so callers can compare without guarding for empty output.
memory_refs_count() {
  local refs n=0 f
  memory_refs_sweep
  refs="$(memory_refs_dir)"
  if [ -d "$refs" ]; then
    for f in "$refs"/s-*.ref; do
      [ -e "$f" ] && n=$((n + 1))
    done
  fi
  printf '%s' "$n"
}
