#!/usr/bin/env bash
#
# memory-refs: live-process reference counting for the shared HTTP memory server.
#
# The shared server historically followed a "single never-stop model" — once up,
# it stayed up until someone ran memory-server-down.sh by hand. That is wrong for
# a laptop: a server nobody is using holds the embedding model resident (a few
# hundred MB) and keeps a git pull loop running for an empty room.
#
# This library is the other half of the lazy-start machinery. memory-server-up.sh
# brings the server up on demand; these refs decide when the last Claude Code
# process has gone so memory-server-idle-stop.sh can take it back down.
#
# Sourceable and side-effect-free: sourcing only DEFINES functions. Callers must
# source lib/memory-env.sh and call memory_load_env first, so CACHE_PATH is set.
#
# ── A ref is one PROCESS, not one session ──────────────────────────────────
# Refs were originally keyed by session id, which was wrong in a way that only
# showed up in use: one Claude Code process owns MANY session ids over its life
# (a resume, a /clear, a plugin reload each mint a new one), so a single running
# process accumulated a ref per session and the count read 7 when one process
# was live. Nothing broke — every ref pointed at the same live pid, so they all
# swept together when it exited — but the number meant nothing, and the reaper
# could only ever fire on process exit rather than at the moment it claimed to.
#
# Keying by the owning `claude` pid makes the count mean what it says: how many
# Claude Code processes are live. It is also naturally idempotent — a resume or
# reload re-stamps the same key instead of adding another.
#
# ── Liveness is a pid check, not a promise ─────────────────────────────────
# A ref released only by SessionEnd leaks the first time a process is SIGKILLed,
# its terminal is closed, or the machine loses power — and one leaked ref pins
# the server on forever, which is precisely the bug this exists to prevent. So a
# ref IS a pid, and liveness is `kill -0` on it. The sweep is the correctness
# guarantee; nothing has to be promised by a hook that may never run.
#
# This is also why SessionEnd does not delete its own ref: at the moment that
# hook runs, the process is still alive, and its other sessions may still need
# the server. The dying process is reclaimed by the sweep instead — which the
# reaper performs after its grace period, by which time the process is gone.
#
# ── Why the owner pid is walked, not $PPID ─────────────────────────────────
# A hook's immediate parent is whatever shell the harness used to invoke it, not
# the session. Recording that pid would mark every ref dead the instant the hook
# returned. So walk up the process tree to the nearest `claude` ancestor and
# record THAT — it lives exactly as long as the Claude Code process does, which
# is the lifetime we actually want to track. $PPID is the fallback when no such
# ancestor is found (an unusual harness, or a test), which degrades to "dies
# early" rather than "pins forever" — the safe direction.

# memory_refs_dir: echo the ref registry directory. One file per live process.
memory_refs_dir() {
  printf '%s' "${WORKBENCH_MEMORY_REFS_DIR:-${CACHE_PATH:?CACHE_PATH must be set}/refs}"
}

# _memory_refs_file <pid>: the ref file path for an owner pid.
#
# The pid is digits-only by construction, but it is sanitized anyway (never
# build a path from an unvalidated value) and prefixed with a literal `p-` so
# every ref file is matched by the `p-*.ref` glob the sweep and count use.
_memory_refs_file() {
  local safe
  safe="$(printf '%s' "$1" | tr -c '0-9' '_')"
  printf '%s/p-%s.ref' "$(memory_refs_dir)" "$safe"
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

# memory_ref_register [owner_pid]: record this Claude Code process as live.
#
# Idempotent by construction — the pid IS the key, so every SessionStart in one
# process re-stamps the same file rather than adding another. Never fails the
# caller: an unwritable cache degrades to "no ref", which loses auto-stop
# precision but breaks nothing.
memory_ref_register() {
  local owner refs
  owner="${1:-$(_memory_refs_owner_pid)}"
  case "$owner" in ''|*[!0-9]*) return 0 ;; esac
  refs="$(memory_refs_dir)"
  mkdir -p "$refs" 2>/dev/null || return 0
  printf '%s' "$owner" > "$(_memory_refs_file "$owner")" 2>/dev/null || true
  return 0
}

# memory_ref_release [owner_pid]: drop a ref explicitly.
#
# NOT called on SessionEnd — see the header. It exists for a caller that knows a
# process is finished (and for tests). Always succeeds.
memory_ref_release() {
  local owner
  owner="${1:-$(_memory_refs_owner_pid)}"
  case "$owner" in ''|*[!0-9]*) return 0 ;; esac
  rm -f "$(_memory_refs_file "$owner")" 2>/dev/null || true
  return 0
}

# memory_refs_sweep: delete refs whose owning process is gone.
#
# This is what makes the count self-healing after a crash, and it is the only
# mechanism that reclaims a ref at all in normal operation. A ref file that is
# empty or malformed is also swept — it can never be proven live, and leaving it
# would pin the server exactly as a leaked ref does.
memory_refs_sweep() {
  local refs f pid
  refs="$(memory_refs_dir)"
  [ -d "$refs" ] || return 0
  for f in "$refs"/p-*.ref; do
    [ -e "$f" ] || continue
    pid="$(cat "$f" 2>/dev/null)"
    case "$pid" in
      ''|*[!0-9]*) rm -f "$f" 2>/dev/null || true; continue ;;
    esac
    kill -0 "$pid" 2>/dev/null || rm -f "$f" 2>/dev/null || true
  done
  return 0
}

# memory_refs_count: sweep, then echo the number of live Claude Code processes.
# Always echoes an integer, so callers can compare without guarding for empty.
memory_refs_count() {
  local refs n=0 f
  memory_refs_sweep
  refs="$(memory_refs_dir)"
  if [ -d "$refs" ]; then
    for f in "$refs"/p-*.ref; do
      [ -e "$f" ] && n=$((n + 1))
    done
  fi
  printf '%s' "$n"
}

# memory_refs_migrate_legacy: remove session-keyed ref files from before refs
# were keyed by pid. They use the `s-` prefix, so the current glob ignores them
# and they would otherwise sit in the cache forever. Cheap and idempotent.
memory_refs_migrate_legacy() {
  local refs
  refs="$(memory_refs_dir)"
  [ -d "$refs" ] || return 0
  rm -f "$refs"/s-*.ref 2>/dev/null || true
  return 0
}
