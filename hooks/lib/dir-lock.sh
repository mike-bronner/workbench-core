#!/usr/bin/env bash
#
# dir-lock: mkdir locks that a crashed holder cannot leave blocking for good.
#
# Sourced, never executed. Sourcing only DEFINES functions. Two users:
#   - hooks/session-log.sh: the per-session log lock, held from the checkpoint
#     read to the checkpoint write (dir_lock_acquire).
#   - hooks/lib/summary-dispatch.sh: the takeover lock under which a stale
#     marker claim is checked again and replaced (dir_lock_take).
#
# mkdir is the atomic test-and-set. A lock is held for well under a second, so
# one older than a minute is a crashed holder's. Breaking it is a check, a
# remove and a re-create, three steps, so they run under a takeover lock,
# `<dir>.takeover`, and the lock is checked again once that is held. Without
# the second check, two callers that both saw the lock stale could each remove
# it, the second removing the one the first had just taken, and both would
# proceed. The caller that breaks a lock takes it in the same step.
#
# The takeover lock is a lock like any other, so it is taken the same way: a
# takeover older than a minute (its breaker was killed in its few milliseconds)
# is broken under `<dir>.takeover.takeover`, checked again there. Each level
# holds the one below it while it removes anything, so two callers never both
# proceed. The chain stops at DIR_LOCK_DEPTH levels: a stale lock there would
# take one crash inside each level's window, and it is then left alone.

DIR_LOCK_DEPTH=3

# dir_lock_is_stale <dir>: true for a lock directory older than a minute.
dir_lock_is_stale() {
  [ -d "$1" ] && [ -n "$(find "$1" -maxdepth 0 -mmin +1 2>/dev/null)" ]
}

# dir_lock_take <dir> [level]: takes the lock, or takes over a stale one.
# False when another caller holds it, or holds its takeover.
dir_lock_take() {
  mkdir "$1" 2>/dev/null && return 0
  dir_lock_is_stale "$1" || return 1
  dir_lock_take_stale "$1" "${2:-0}"
}

# dir_lock_take_stale <dir> [level]: takes over a stale lock under its takeover
# lock, checking it again there. False when the takeover is held, the chain is
# at its last level, or the lock is no longer stale under the takeover.
dir_lock_take_stale() {
  local dir="$1" level="${2:-0}" won=1
  [ "$level" -lt "$DIR_LOCK_DEPTH" ] || return 1
  dir_lock_take "$dir.takeover" "$((level + 1))" || return 1
  if dir_lock_is_stale "$dir"; then
    rmdir "$dir" 2>/dev/null && mkdir "$dir" 2>/dev/null && won=0
  fi
  rmdir "$dir.takeover" 2>/dev/null
  return "$won"
}

# dir_lock_acquire <dir> <tries>: takes the lock, waiting 0.05 s between
# tries. False when it is still held after <tries> tries.
dir_lock_acquire() {
  local n=0
  until dir_lock_take "$1"; do
    n=$((n + 1))
    [ "$n" -ge "$2" ] && return 1
    sleep 0.05
  done
}
