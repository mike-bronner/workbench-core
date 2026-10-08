#!/bin/bash
# Tests for scripts/process-pending-summaries.sh, the work behind
# /process-pending-summaries. Run directly: ./test-process-pending-summaries.sh
# Every case runs against a throwaway vault and cache, never the user's real
# ones, and with WORKBENCH_DISPATCH_DRY_RUN=1, so the spawn helper prints what
# it would launch and launches nothing.

set -u
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$(cd "$HOOKS_DIR/.." && pwd)/scripts/process-pending-summaries.sh"
PASS=0
FAIL=0

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/process-pending-summaries.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT
VAULT="$SANDBOX/vault"
CACHE="$SANDBOX/cache"
HOMEDIR="$SANDBOX/home"
PENDING="$CACHE/pending-summaries"
mkdir -p "$VAULT/sessions/2026-10-01" "$PENDING" "$HOMEDIR/.claude/projects/p"

drive() {  # drive [args...] -> the script's stdout
  HOME="$HOMEDIR" WORKBENCH_MEMORY_PATH="$VAULT" WORKBENCH_MEMORY_CACHE="$CACHE" \
    WORKBENCH_CONFIG_FILE="$SANDBOX/none.json" WORKBENCH_DISPATCH_DRY_RUN=1 \
    CLAUDE_CONFIG_DIR='' bash "$SCRIPT" "$@"
}
result() { printf '%s\n' "$1" | grep '^result='; }
dispatched() { printf '%s\n' "$1" | sed -n 's/^DISPATCH sid=//p' | paste -sd ' ' -; }

ok() { PASS=$((PASS + 1)); echo "  ✅ $1"; }
no() { FAIL=$((FAIL + 1)); echo "  ❌ $1"; }
assert_eq()       { if [ "$2" = "$3" ]; then ok "$1"; else no "$1 (got: $2)"; fi; }
assert_contains() { if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else no "$1 (missing: $3)"; fi; }
assert_missing()  { if printf '%s' "$2" | grep -qF -- "$3"; then no "$1 (found: $3)"; else ok "$1"; fi; }

# marker <sid> <marked_at|-> <log yes|no> <transcript yes|no>
marker() {
  local sid="$1" at="$2" log='' transcript=''
  if [ "$3" = yes ]; then log="$VAULT/sessions/2026-10-01/$sid.log.md"; printf 'log\n' > "$log"; fi
  if [ "$4" = yes ]; then transcript="$HOMEDIR/.claude/projects/p/$sid.jsonl"; printf '{}\n' > "$transcript"; fi
  if [ "$at" = - ]; then
    jq -n --arg s "$sid" --arg l "$log" --arg t "$transcript" '{session_id:$s, log_path:$l, transcript_path:$t}' > "$PENDING/$sid.json"
  else
    jq -n --arg s "$sid" --arg l "$log" --arg t "$transcript" --arg a "$at" '{session_id:$s, log_path:$l, transcript_path:$t, marked_at:$a}' > "$PENDING/$sid.json"
  fi
}

echo "nothing pending:"
assert_eq "no marker says none" "$(result "$(drive)")" "result=none"

echo "the drain takes the 10 oldest live markers and counts the rest:"
for i in 01 02 03 04 05 06 07 08 09 10 11; do marker "live-$i" "2026-09-$i""T00:00:00Z" yes no; done
marker transcript-only "2026-08-30T00:00:00Z" no yes
marker dead-one "2026-08-01T00:00:00Z" no no
marker dead-two "2026-08-02T00:00:00Z" no no
jq -n '{log_path:"x"}' > "$PENDING/sidless.json"
OUT="$(drive)"
assert_eq "four numbers"  "$(result "$OUT")" "result=drained dispatched=10 live=2 dead=3 total=15"
assert_eq "oldest live first, dead ones skipped" "$(dispatched "$OUT")" \
  "transcript-only live-01 live-02 live-03 live-04 live-05 live-06 live-07 live-08 live-09"
assert_contains "a transcript-only marker passes its transcript" "$OUT" "DISPATCH transcript=$HOMEDIR/.claude/projects/p/transcript-only.jsonl"
assert_contains "the writer runs from the vault" "$OUT" "DISPATCH cwd=$VAULT"
assert_eq "dead markers are left alone" "$(find "$PENDING" -maxdepth 1 -name '*dead*' | grep -c .)" "2"

echo "a marker with no marked_at sorts by its mtime:"
rm -f "$PENDING"/*.json
marker newer "2026-09-20T00:00:00Z" yes no
marker undated - yes no
touch -t 202601010000 "$PENDING/undated.json"
assert_eq "the undated, older file goes first" "$(dispatched "$(drive)")" "undated newer"

echo "one session by id:"
rm -f "$PENDING"/*.json
assert_eq "an id with a slash is refused" "$(result "$(drive '../x')")" "result=invalid-id"
assert_eq "an id with nothing on disk"   "$(result "$(drive gone-session)")" "result=unrecoverable"
printf 'log\n' > "$VAULT/sessions/2026-10-01/one.log.md"
OUT="$(drive one)"
assert_eq "a session with a log dispatches" "$(result "$OUT")" "result=dispatched"
assert_eq "its writer is the one dispatched" "$(dispatched "$OUT")" "one"
assert_eq "a marker is written in session-log's shape" \
  "$(jq -r '[.session_id, .mode, .event, (.marked_at | test("^[0-9]{4}-"))] | join(" ")' "$PENDING/one.json")" \
  "one manual ProcessPendingSummaries true"
# The script decides by itself whether a summary is redone, and asks nobody:
# only a log newer than its summary holds segments the summary has not seen.
LOGF="$VAULT/sessions/2026-10-01/one.log.md"
SUMF="$VAULT/sessions/2026-10-01/one.summary.md"
printf 'summary\n' > "$SUMF"
touch -t 202601010000 "$LOGF"
OUT="$(drive one)"
assert_eq "a summary newer than its log is current, and kept" "$(result "$OUT")" "result=current summary=$SUMF"
assert_eq "and nothing is dispatched" "$(dispatched "$OUT")" ""
touch -t 202601010000 "$SUMF"
touch -t 202601010000 "$LOGF"
assert_eq "a summary as old as its log is current too" "$(result "$(drive one)")" "result=current summary=$SUMF"
touch -t 202601020000 "$LOGF"
# The first writer holds the marker's claim until it deletes the marker, so a
# second writer never runs on one session (lib/summary-dispatch.sh). That is a
# writer at work, not a failure, and it is reported as busy.
OUT="$(drive one)"
assert_eq "a log newer than its summary, while another writer holds the marker, is busy" "$(result "$OUT")" "result=busy"
assert_eq "and a busy marker dispatches nothing" "$(dispatched "$OUT")" ""
rm -f "$PENDING/one.json"
OUT="$(drive one)"
assert_eq "a log newer than its summary is summarized again" "$(result "$OUT")" "result=dispatched"
assert_eq "by one writer for that session" "$(dispatched "$OUT")" "one"
rm -f "$PENDING/one.json"
touch -t 202601030000 "$SUMF"
assert_eq "--overwrite still forces a current summary" "$(result "$(drive one --overwrite)")" "result=dispatched"

echo "with the log pruned, the transcript stands in for it:"
rm -f "$PENDING/one.json"
printf 'summary\n' > "$VAULT/sessions/2026-10-01/two.summary.md"
touch -t 202601030000 "$VAULT/sessions/2026-10-01/two.summary.md"
printf '{}\n' > "$HOMEDIR/.claude/projects/p/two.jsonl"
touch -t 202601020000 "$HOMEDIR/.claude/projects/p/two.jsonl"
assert_eq "a transcript older than the summary is current" "$(result "$(drive two)")" "result=current summary=$VAULT/sessions/2026-10-01/two.summary.md"
touch -t 202601040000 "$HOMEDIR/.claude/projects/p/two.jsonl"
assert_eq "a transcript newer than the summary is summarized again" "$(result "$(drive two)")" "result=dispatched"

echo "a missing prerequisite is named:"
mkdir -p "$SANDBOX/bin"
ln -s "$(command -v jq)" "$SANDBOX/bin/jq"
OUT="$(HOME="$HOMEDIR" WORKBENCH_MEMORY_PATH="$VAULT" WORKBENCH_MEMORY_CACHE="$CACHE" \
  WORKBENCH_CONFIG_FILE="$SANDBOX/none.json" PATH="$SANDBOX/bin:/usr/bin:/bin" bash "$SCRIPT")"
assert_eq "no claude binary" "$(result "$OUT")" "result=unavailable reason=claude"

echo
echo "process-pending-summaries: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
