#!/bin/bash
# Tests for scripts/release-summary-marker.sh, the summary-writer's last step:
# delete the pending-summary marker only while it still holds the marked_at the
# writer read at its start. Run directly: ./test-release-summary-marker.sh
#
# Every case runs in a throwaway cache, never the user's real one.

set -u
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HOOKS_DIR/.." && pwd)"
HELPER="$ROOT/scripts/release-summary-marker.sh"
PASS=0
FAIL=0

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/release-summary-marker.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT
CACHE="$SANDBOX/cache"
PENDING="$CACHE/pending-summaries"
mkdir -p "$PENDING" "$SANDBOX/memory" "$SANDBOX/home"

eq() { if [ "$2" = "$3" ]; then PASS=$((PASS + 1)); echo "  ✅ $1"; else FAIL=$((FAIL + 1)); echo "  ❌ $1 — got '$2', want '$3'"; fi; }
release() {
  env HOME="$SANDBOX/home" WORKBENCH_MEMORY_CACHE="$CACHE" WORKBENCH_CONFIG_FILE="$SANDBOX/none.json" \
    bash "$HELPER" "$@"
}
marker() { # <sid> <marked_at or ->
  if [ "$2" = - ]; then
    jq -n --arg s "$1" '{session_id:$s, log_path:"/x.log.md"}' > "$PENDING/$1.json"
  else
    jq -n --arg s "$1" --arg a "$2" '{session_id:$s, log_path:"/x.log.md", marked_at:$a}' > "$PENDING/$1.json"
  fi
}
present() { [ -f "$PENDING/$1.json" ] && echo present || echo gone; }

echo "a marker nobody rewrote is deleted:"
marker sid-a 2026-10-07T10:00:00Z
eq "the helper reports the delete" "$(release "$PENDING/sid-a.json" 2026-10-07T10:00:00Z)" "marker=deleted"
eq "and the marker is gone" "$(present sid-a)" gone

echo "a marker rewritten mid-run survives:"
# The writer read the marker at its start. The session went on, and a turn
# checkpoint (hooks/session-log.sh mode=turn, the real script) rewrote it.
T="$SANDBOX/sid-live.jsonl"
printf '{"type":"user","n":1}\n' > "$T"
turn() {
  jq -nc --arg t "$T" '{session_id:"sid-live", transcript_path:$t, hook_event_name:"TurnComplete"}' | \
    env HOME="$SANDBOX/home" WORKBENCH_MEMORY_PATH="$SANDBOX/memory" WORKBENCH_MEMORY_CACHE="$CACHE" \
      WORKBENCH_LOG_MODE=turn bash "$HOOKS_DIR/session-log.sh" 2>/dev/null
}
turn
READ_AT="$(jq -r '.marked_at' "$PENDING/sid-live.json")"
# The next turn comes a second or more later, as one during the writer's
# minutes-long run does.
sleep 1.1
printf '{"type":"assistant","n":2}\n' >> "$T"
turn
NOW_AT="$(jq -r '.marked_at' "$PENDING/sid-live.json")"
eq "the turn checkpoint rewrote the marker" "$([ "$NOW_AT" != "$READ_AT" ] && echo rewritten)" rewritten
eq "the helper keeps it" "$(release "$PENDING/sid-live.json" "$READ_AT")" "marker=kept reason=rewritten"
eq "the marker is still there" "$(present sid-live)" present
eq "holding the later write" "$(jq -r '.marked_at' "$PENDING/sid-live.json")" "$NOW_AT"
eq "and the session's lock is released" "$([ -e "$CACHE/log-checkpoints/sid-live.lock" ] && echo held || echo released)" released
eq "the next writer, who read the later write, deletes it" "$(release "$PENDING/sid-live.json" "$NOW_AT")" "marker=deleted"

echo "an old marker with no marked_at is released with the empty string:"
marker sid-old -
eq "the empty string matches it" "$(release "$PENDING/sid-old.json" '')" "marker=deleted"
marker sid-old2 -
eq "a value does not" "$(release "$PENDING/sid-old2.json" 2026-10-07T10:00:00Z)" "marker=kept reason=rewritten"
eq "so it stays" "$(present sid-old2)" present

echo "nothing at the path is not an error:"
eq "already gone" "$(release "$PENDING/sid-none.json" 2026-10-07T10:00:00Z)" "marker=already-gone"

echo "a log writer holding the session's lock means the marker is left alone:"
# session-log.sh writes the marker under log-checkpoints/<sid>.lock. While a
# writer holds it, the marker may be about to change, so the helper waits about
# a second and then keeps it.
marker sid-locked 2026-10-07T10:00:00Z
mkdir -p "$CACHE/log-checkpoints/sid-locked.lock"
eq "it reports the marker busy" "$(release "$PENDING/sid-locked.json" 2026-10-07T10:00:00Z)" "marker=kept reason=busy"
eq "and keeps it" "$(present sid-locked)" present
eq "and leaves the holder's lock alone" "$([ -d "$CACHE/log-checkpoints/sid-locked.lock" ] && echo held)" held
touch -t 202601010000 "$CACHE/log-checkpoints/sid-locked.lock"
eq "a lock a killed holder left goes stale, and is broken" "$(release "$PENDING/sid-locked.json" 2026-10-07T10:00:00Z)" "marker=deleted"
eq "and the helper releases the lock it took" "$([ -e "$CACHE/log-checkpoints/sid-locked.lock" ] && echo held || echo released)" released

echo "it deletes only a marker file in the configured pending folder:"
mkdir -p "$SANDBOX/elsewhere/pending-summaries"
printf '{}\n' > "$SANDBOX/elsewhere/pending-summaries/sid-b.json"
eq "a lookalike pending-summaries folder elsewhere is refused" "$(release "$SANDBOX/elsewhere/pending-summaries/sid-b.json" '')" "marker=kept reason=invalid"
eq "and its file kept" "$([ -f "$SANDBOX/elsewhere/pending-summaries/sid-b.json" ] && echo kept)" kept
ln -s "$SANDBOX/elsewhere/pending-summaries" "$SANDBOX/linked"
eq "a symbolically linked parent folder leading elsewhere is refused" "$(release "$SANDBOX/linked/sid-b.json" '')" "marker=kept reason=invalid"
eq "and its file kept" "$([ -f "$SANDBOX/elsewhere/pending-summaries/sid-b.json" ] && echo kept)" kept
ln -s "$PENDING" "$SANDBOX/alias"
marker sid-alias 2026-10-07T10:00:00Z
eq "a linked parent that resolves to the pending folder is the pending folder" "$(release "$SANDBOX/alias/sid-alias.json" 2026-10-07T10:00:00Z)" "marker=deleted"
printf '{"marked_at":"2026-10-07T10:00:00Z"}\n' > "$PENDING/bad name.json"
eq "a name that is no session id is refused" "$(release "$PENDING/bad name.json" 2026-10-07T10:00:00Z)" "marker=kept reason=invalid"
eq "a relative path is refused" "$(cd "$CACHE" && release "pending-summaries/sid-x.json" '')" "marker=kept reason=invalid"
ln -s "$SANDBOX/elsewhere/pending-summaries/sid-b.json" "$PENDING/sid-link.json"
eq "a marker that is a symbolic link is refused" "$(release "$PENDING/sid-link.json" '')" "marker=kept reason=invalid"
eq "and its target kept" "$([ -f "$SANDBOX/elsewhere/pending-summaries/sid-b.json" ] && echo kept)" kept
marker sid-d 2026-10-07T10:00:00Z
eq "one argument is refused" "$(release "$PENDING/sid-d.json")" "marker=kept reason=invalid"
for bad in 'x' "2026-10-07T10:00:00Z'; rm -rf /tmp/x; '" '2026-10-07 10:00:00' '2026-10-07T10:00:00+00:00'; do
  eq "a marked_at shaped like '${bad:0:24}' is refused" "$(release "$PENDING/sid-d.json" "$bad")" "marker=kept reason=invalid"
done
eq "and the marker kept" "$(present sid-d)" present

echo "the writer is told where the helper is:"
PROMPT="$(
  _cfg() { :; }
  export MEMORY_PATH="$SANDBOX/memory" CACHE_PATH="$CACHE"
  . "$HOOKS_DIR/lib/summary-dispatch.sh"
  summary_dispatch_prompt sid-a "$PENDING/sid-a.json" /x.log.md /x.jsonl
)"
HELPER_LINE="$(printf '%s\n' "$PROMPT" | sed -n 's/^release_helper: //p')"
eq "the prompt names the helper by its absolute path" "$HELPER_LINE" "$HELPER"
eq "and tells the writer to release the marker with it" "$(printf '%s' "$PROMPT" | tr '\n' ' ' | grep -c 'release the marker with release_helper')" 1

echo
echo "release-summary-marker: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
