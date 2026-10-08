#!/usr/bin/env bash
#
# release-summary-marker.sh <marker_path> <marked_at>
#
# The summary-writer's last step (agents/summary-writer.md, step 6): delete the
# pending-summary marker it summarized, but only if nobody rewrote it since.
#
# Why the check. The hooks module checkpoints the session log after every turn
# (hooks/session-log.sh mode=turn), and each checkpoint rewrites the session's
# marker. A writer started at PreCompact can still be running when later turns
# rewrite it. If the writer then deleted the marker, and the last turn's
# checkpoint had already copied every line (so SessionEnd writes no new one),
# the later turns would never be summarized. So the writer passes the
# `marked_at` it read at its start, and the marker goes only while it still
# holds that value. A rewritten marker stays for the next drain, which then
# summarizes the whole log again.
#
# Why the lock. session-log.sh writes the marker while it holds the session's
# lock, log-checkpoints/<sid>.lock. This script takes the same lock
# (lib/dir-lock.sh) around its check and its delete, so no rewrite can land
# between the two. A kill while it holds the lock leaves only the lock, which
# goes stale after a minute and is broken, and never moves the marker anywhere
# the drain does not read.
#
# `marked_at` has one-second resolution. A rewrite in the same second as the
# write the writer read cannot happen after its read: a writer starts seconds
# after its dispatch. An old marker with no `marked_at` is read as the empty
# string, and the writer passes the empty string for it. Any value but the
# empty string or a UTC time shaped YYYY-MM-DDTHH:MM:SSZ is refused.
#
# The path must name a regular file `<session-id>.json` directly in the
# configured pending-summaries folder (memory_resolve_cache_path, as
# session-log.sh resolves it), checked after resolving every symbolic link in
# its folder. No other file is ever deleted.
#
# Prints one line and exits 0, whatever happened:
#   marker=deleted                 it still held <marked_at>, and is gone
#   marker=kept reason=rewritten   a later write changed it, so it stays
#   marker=kept reason=busy        a log writer holds the session's lock
#   marker=already-gone            nothing at the path
#   marker=kept reason=invalid     the path or the value is not one it takes

set -u

say() { printf '%s\n' "$1"; exit 0; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/hooks}"
HOOKS_DIR="${HOOKS_DIR:-$(cd "$SCRIPT_DIR/../hooks" && pwd)}"

[ $# -eq 2 ] || say 'marker=kept reason=invalid'
MARKER="$1"
WANT="$2"
case "$WANT" in
  '' | [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z) ;;
  *) say 'marker=kept reason=invalid' ;;
esac
case "$MARKER" in /*.json) ;; *) say 'marker=kept reason=invalid' ;; esac
SID="${MARKER##*/}"
SID="${SID%.json}"
case "$SID" in '' | *[!A-Za-z0-9_-]*) say 'marker=kept reason=invalid' ;; esac
command -v jq >/dev/null 2>&1 || say 'marker=kept reason=invalid'

# shellcheck source=hooks/lib/memory-env.sh
. "$HOOKS_DIR/lib/memory-env.sh" || say 'marker=kept reason=invalid'
# shellcheck source=hooks/lib/dir-lock.sh
. "$HOOKS_DIR/lib/dir-lock.sh" || say 'marker=kept reason=invalid'
CACHE_PATH="$(memory_resolve_cache_path)"
PENDING="$(cd -P "$CACHE_PATH/pending-summaries" 2>/dev/null && pwd)" || say 'marker=kept reason=invalid'
FOLDER="$(cd -P "${MARKER%/*}" 2>/dev/null && pwd)" || say 'marker=kept reason=invalid'
[ "$FOLDER" = "$PENDING" ] || say 'marker=kept reason=invalid'
MARKER="$PENDING/$SID.json"
[ -e "$MARKER" ] || [ -L "$MARKER" ] || say 'marker=already-gone'
[ -f "$MARKER" ] && [ ! -L "$MARKER" ] || say 'marker=kept reason=invalid'

LOCK="$CACHE_PATH/log-checkpoints/$SID.lock"
mkdir -p "$CACHE_PATH/log-checkpoints" 2>/dev/null || say 'marker=kept reason=invalid'
dir_lock_acquire "$LOCK" 20 || say 'marker=kept reason=busy'
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

[ -f "$MARKER" ] || say 'marker=already-gone'
HAVE="$(jq -r '.marked_at // ""' "$MARKER" 2>/dev/null)" || say 'marker=kept reason=invalid'
[ "$HAVE" = "$WANT" ] || say 'marker=kept reason=rewritten'
rm -f -- "$MARKER"
say 'marker=deleted'
