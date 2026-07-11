#!/usr/bin/env bash
#
# memory-vacuum: out-of-band index reclamation (gated full VACUUM).
#
# Sourceable and side-effect-free: sourcing only DEFINES memory_vacuum. We keep
# the markdown-vault-mcp server a pristine mirror of upstream 3.0.1, so index
# maintenance happens here rather than inside the server — matching upstream's
# own guidance ("run VACUUM on the index file").
#
# WHERE this runs changed with the shared-server model. Previously the per-
# session stdio launcher VACUUMed on every connect, which could race a sibling
# session holding the same index. Now it runs ONLY at a confirmed cold start, in
# the detached supervisor, inside the spawn lock, with NO server alive — so
# there is no writer to race. The caller (memory-server-spawn.sh) is responsible
# for that "no server alive" guarantee; this function only adds the freelist
# gate and a once/day cooldown.
#
# A *gated full* VACUUM is the right out-of-band choice:
#   - The index is auto_vacuum=NONE, so `PRAGMA incremental_vacuum` is a no-op —
#     only a full VACUUM actually reclaims space.
#   - A full VACUUM also defragments the file and avoids the permanent ptrmap
#     overhead that switching to auto_vacuum=FULL would impose on every write.
#
# Gating keeps cold start fast: VACUUM only when the reclaimable freelist exceeds
# a threshold (freelist_count * page_size). Most cold starts have a tiny freelist
# → skip. A once/day cooldown stamp ($CACHE_PATH/.last-vacuum) prevents repeated
# VACUUMs when sessions churn (each restart is a cold start for a stopped server).
#
# Hard rules: never fail the caller; treat every error (busy/locked, missing
# sqlite3, absent file) as skip-and-continue. The busy timeout is set with the
# `.timeout` dot-command, not `PRAGMA busy_timeout` — the PRAGMA emits a result
# row that would pollute the freelist read.
#
# Args: $1 = path to the index sqlite file. Env knobs:
#   WORKBENCH_MEMORY_VACUUM_THRESHOLD_MB  freelist threshold (default 50)
#   WORKBENCH_MEMORY_VACUUM_COOLDOWN_HOURS  min hours between VACUUMs (default 24)
# Logging: pass a logger function name in $2 (defaults to a stderr echo). The
# logger is called as `$logger "message"`.
memory_vacuum() {
  local index_path="$1"
  local logger="${2:-_memory_vacuum_log}"
  local threshold_mb="${WORKBENCH_MEMORY_VACUUM_THRESHOLD_MB:-50}"
  local cooldown_hours="${WORKBENCH_MEMORY_VACUUM_COOLDOWN_HOURS:-24}"

  if ! command -v sqlite3 >/dev/null 2>&1; then
    "$logger" "vacuum: sqlite3 not on PATH; skipping index reclamation"
    return 0
  fi
  if [ ! -f "$index_path" ]; then
    "$logger" "vacuum: index not present yet; skipping reclamation"
    return 0
  fi

  # Once/day cooldown: skip if the stamp is newer than the cooldown window. The
  # stamp lives beside the index. find -mmin is the portable "younger than"
  # test (macOS bash 3.2 has no stat-format portability guarantee).
  local stamp="${index_path%/*}/.last-vacuum"
  if [ -f "$stamp" ]; then
    local cooldown_min=$(( cooldown_hours * 60 ))
    if [ -n "$(find "$stamp" -mmin "-${cooldown_min}" 2>/dev/null)" ]; then
      "$logger" "vacuum: last run within ${cooldown_hours}h cooldown; skipping"
      return 0
    fi
  fi

  local freelist_bytes
  freelist_bytes=$(sqlite3 "$index_path" -cmd ".timeout 2000" \
    "SELECT freelist_count * page_size FROM pragma_freelist_count, pragma_page_size;" \
    2>/dev/null)
  if ! [[ "$freelist_bytes" =~ ^[0-9]+$ ]]; then
    "$logger" "vacuum: could not read freelist (locked or unreadable); skipping"
    return 0
  fi

  if [ "$freelist_bytes" -gt $(( threshold_mb * 1024 * 1024 )) ]; then
    "$logger" "vacuum: reclaimable freelist ${freelist_bytes}B > ${threshold_mb}MB threshold; running VACUUM"
    if sqlite3 "$index_path" -cmd ".timeout 2000" "VACUUM;" >&2; then
      "$logger" "vacuum: reclaimed index space"
      # Stamp only on a successful VACUUM so a skipped/failed run retries next
      # cold start rather than waiting out the cooldown.
      touch "$stamp" 2>/dev/null || true
    else
      "$logger" "vacuum: VACUUM failed; continuing"
    fi
  else
    "$logger" "vacuum: freelist ${freelist_bytes}B under ${threshold_mb}MB threshold; skipping"
  fi
  return 0
}

# Default logger: a plain stderr line. Callers with their own _log (the
# supervisor) pass it as $2 so vacuum output joins the server log.
_memory_vacuum_log() { echo "memory-vacuum: $*" >&2; }

# memory_vacuum_locked: race-safe wrapper around memory_vacuum for the
# per-session stdio launcher (hooks/mcp-memory.sh).
#
# WHY a lock here but not in the supervisor: the shared-server supervisor holds
# the spawn lock and VACUUMs in a guaranteed "no server alive" window, so it
# calls memory_vacuum directly. The stdio launcher has no such window — it runs
# once per session and sibling sessions' servers may be live. This wrapper adds
# a NON-BLOCKING atomic-mkdir lock so that among concurrently starting launchers
# exactly one attempts the VACUUM and the rest skip immediately (one session
# VACUUMs, others skip if held) rather than piling onto the same index.
#
# The lock only dedups concurrent *launchers*. A VACUUM that still contends with
# a live sibling server's writes is handled one layer down: memory_vacuum sets a
# SQLite busy timeout and treats a busy/locked index as skip-and-continue, so it
# degrades safely — no corruption, no blocking. That SQLite-level busy handler is
# the true safety net; this mkdir lock is a cheap best-effort dedup on top of it.
# Skipping when a sibling server holds the index is the honest multi-session
# tradeoff the Mac knowingly re-accepts by choosing per-session stdio.
#
# Staleness is PID-liveness, never wall-clock (mirrors memory-server-up.sh's
# lock): a crashed launcher's lock is stolen once when its pid is dead. Because
# the SQLite busy handler already prevents corruption, a lost steal-race just
# means a redundant skip — so this deliberately omits the heavier lock-generation
# nonce the spawn lock carries. Never fails the caller; releases the lock inline
# (no EXIT trap — the launcher execs the server after this, where a trap would
# fire in the wrong process).
#
# Args: $1 = index sqlite path (as memory_vacuum). $2 = optional logger name.
memory_vacuum_locked() {
  local index_path="$1"
  local logger="${2:-_memory_vacuum_log}"
  local lock_dir="${index_path%/*}/vacuum.lock"
  local pid_file="$lock_dir/pid"

  # Non-blocking claim: mkdir is atomic, so exactly one concurrent launcher wins.
  if ! mkdir "$lock_dir" 2>/dev/null; then
    local holder=""
    [ -f "$pid_file" ] && holder="$(cat "$pid_file" 2>/dev/null)"
    if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
      "$logger" "vacuum: lock held by live pid $holder; skipping"
      return 0
    fi
    # Stale lock (holder dead or never stamped) — steal once and retry the claim.
    "$logger" "vacuum: stealing stale lock (holder '${holder:-none}' not alive)"
    rm -rf "$lock_dir" 2>/dev/null || true
    if ! mkdir "$lock_dir" 2>/dev/null; then
      "$logger" "vacuum: lost re-claim race; another launcher owns the lock; skipping"
      return 0
    fi
  fi

  # We hold the lock. Stamp our pid for the liveness check above, run the gated
  # VACUUM, then always release (rm -rf, since the dir holds pid).
  echo "$$" > "$pid_file" 2>/dev/null || true
  memory_vacuum "$index_path" "$logger"
  rm -rf "$lock_dir" 2>/dev/null || true
  return 0
}
