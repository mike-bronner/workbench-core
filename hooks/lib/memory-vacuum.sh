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
