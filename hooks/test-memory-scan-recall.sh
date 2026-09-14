#!/bin/bash
# Tests for hooks/memory-scan-recall.sh — the mid-turn vault-recall PostToolUse
# hook. Run directly: ./test-memory-scan-recall.sh
#
# Each case feeds a PostToolUse payload on stdin and asserts the hook's stdout
# (an additionalContext JSON block, or nothing). The hook shells out to the
# markdown-vault-mcp `search` CLI via WORKBENCH_MEMORY_SERVER_BIN, pointed at the
# fake-server fixture's `search` subcommand (fixtures/fake-markdown-vault-mcp.sh)
# — canned hits, no real embeddings, no outbound network, no process left running
# afterward. The same fixture the memory-recall.sh suite uses, unchanged.
#
# Three properties carry most of the weight here, because each one is the
# difference between a bounded cost and an unbounded one:
#   - the matcher/extractor fires on content searches and nothing else,
#   - a memory is injected at most once per session, ACROSS BOTH recall hooks,
#   - every failure path is silent and exits 0.

set -u
HOOKS="$(cd "$(dirname "$0")" && pwd)"
HOOK="$HOOKS/memory-scan-recall.sh"
FAKE="$HOOKS/fixtures/fake-markdown-vault-mcp.sh"
PASS=0
FAIL=0

SANDBOX=$(mktemp -d)
NO_CONFIG="$SANDBOX/absent-config.json"   # never created → memory-env uses overrides
cleanup() { rm -rf "$SANDBOX"; }
trap cleanup EXIT

# Reassigned by individual cases so each one gets its own dedup state.
STATE="$SANDBOX/state"
# Set by the scheduled-task cases; empty means the payload carries no transcript.
TRANSCRIPT_PATH=""

# run_hook <tool> <raw-input> <session_id> <cache> <SERVER_BIN> [EXTRA_ENV=val ...]
# <raw-input> lands in tool_input.pattern for Grep and tool_input.command for
# everything else, matching the real payload shape.
run_hook() {
  local tool="$1" raw="$2" sid="$3" cache="$4" bin="$5"; shift 5
  local payload key
  if [ "$tool" = "Grep" ] || [ "$tool" = "Glob" ]; then key="pattern"; else key="command"; fi
  payload=$(jq -cn --arg t "$tool" --arg k "$key" --arg v "$raw" --arg s "$sid" \
                   --arg tr "$TRANSCRIPT_PATH" '
    {tool_name:$t, tool_input:{($k):$v}, session_id:$s, hook_event_name:"PostToolUse"}
    + (if $tr == "" then {} else {transcript_path:$tr} end)')
  printf '%s' "$payload" | env \
    WORKBENCH_CONFIG_FILE="$NO_CONFIG" \
    WORKBENCH_MEMORY_CACHE="$cache" \
    WORKBENCH_MEMORY_SERVER_BIN="$bin" \
    WORKBENCH_MEMORY_RECALL_STATE="$STATE" \
    "$@" \
    bash "$HOOK"
}

assert_empty() {
  local desc="$1" got="$2"
  if [ -z "$got" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc (no output)"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected no output, got: $got"
  fi
}
assert_contains() {
  local desc="$1" got="$2" needle="$3"
  case "$got" in
    *"$needle"*) PASS=$((PASS + 1)); echo "  ✅ $desc" ;;
    *) FAIL=$((FAIL + 1)); echo "  ❌ $desc — output missing '$needle': $got" ;;
  esac
}
assert_not_contains() {
  local desc="$1" got="$2" needle="$3"
  case "$got" in
    *"$needle"*) FAIL=$((FAIL + 1)); echo "  ❌ $desc — output unexpectedly had '$needle'" ;;
    *) PASS=$((PASS + 1)); echo "  ✅ $desc" ;;
  esac
}
assert_ok() {
  local desc="$1" cond="$2"
  if [ "$cond" = "1" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc"
  fi
}

mk_cache() { mkdir -p "$1"; }
CACHE="$SANDBOX/cache"; mk_cache "$CACHE"

SCAN='grep -rn "memory recall dedup" hooks/'

# ─────────────────────────────────────────────────────────────────────────────
echo "Happy path — a Bash content search injects a hit beside the scan:"
STATE="$SANDBOX/s-happy"
GOT=$(run_hook Bash "$SCAN" s-happy "$CACHE" "$FAKE")
assert_contains "emits the recall header"        "$GOT" "🧠"
assert_contains "injects the top canned hit"     "$GOT" "Canned recall hit one"
assert_contains "carries the hit's type tag"     "$GOT" "[insight]"
assert_contains "echoes the scan's own query"    "$GOT" "memory recall dedup"
assert_contains "uses additionalContext"         "$GOT" "additionalContext"

echo "Output is well-formed JSON carrying the PostToolUse event name:"
EVT=$(printf '%s' "$GOT" | jq -r '.hookSpecificOutput.hookEventName' 2>/dev/null)
assert_ok "valid JSON, hookEventName=PostToolUse" "$([ "$EVT" = "PostToolUse" ] && echo 1 || echo 0)"

echo "Top-K defaults to 1, against memory-recall.sh's 2 (this hook fires far more often):"
assert_not_contains "second hit not injected by default" "$GOT" "Canned recall hit two"

echo "Happy path — the Grep tool's pattern is the query verbatim:"
STATE="$SANDBOX/s-grep"
GOT=$(run_hook Grep 'memory-recall|memory_recall' s-grep "$CACHE" "$FAKE")
assert_contains "Grep tool injects"                 "$GOT" "Canned recall hit one"
assert_contains "alternation reduced to its words"  "$GOT" "memory recall"
assert_not_contains "duplicate word not echoed twice" "$GOT" "memory recall memory recall"

# ── Matcher and extraction: what must NOT fire ──────────────────────────────
echo "Glob is deliberately out — a path pattern is a filename shape, not a topic:"
STATE="$SANDBOX/s-glob"
assert_empty "Glob tool never fires" "$(run_hook Glob '**/*.recall.test.ts' s-glob "$CACHE" "$FAKE")"

echo "A non-scanning tool never fires:"
STATE="$SANDBOX/s-read"
assert_empty "Read tool never fires" "$(run_hook Read 'hooks/memory-recall.sh' s-read "$CACHE" "$FAKE")"

echo "Bash calls that carry no search query stay silent:"
STATE="$SANDBOX/s-noquery"
assert_empty "plain test runner"      "$(run_hook Bash 'npm test -- --watch=false' s-nq1 "$CACHE" "$FAKE")"
assert_empty "path search (find)"     "$(run_hook Bash 'find . -name "*.recall.test.ts"' s-nq2 "$CACHE" "$FAKE")"
assert_empty "directory listing"      "$(run_hook Bash 'ls -la hooks/memory-recall' s-nq3 "$CACHE" "$FAKE")"
assert_empty "rg --files, no pattern" "$(run_hook Bash 'rg --files -g "*.markdown"' s-nq4 "$CACHE" "$FAKE")"
assert_empty "patterns come from a file, first positional is a PATH" \
  "$(run_hook Bash 'grep -f patterns.txt hooks/memory/recall' s-nq5 "$CACHE" "$FAKE")"

echo "The search word is read by argument SLOT, never as a substring:"
# `git log --grep=` searches commit messages, not the tree, and the word `rg`
# inside the quoted value is data. A substring match would fire on both.
STATE="$SANDBOX/s-slot"
assert_empty "git log --grep is not a repo scan" \
  "$(run_hook Bash 'git log --grep="rg memory recall dedup" --oneline' s-slot1 "$CACHE" "$FAKE")"
assert_empty "a search word inside a string literal is data" \
  "$(run_hook Bash 'echo "run rg memory recall dedup later" >> notes.md' s-slot2 "$CACHE" "$FAKE")"

echo "The search is found in a later pipeline stage, and behind a no-op prefix:"
STATE="$SANDBOX/s-stage"
assert_contains "grep after a pipe fires" \
  "$(run_hook Bash 'cat notes.md | grep -i "memory recall dedup"' s-stage1 "$CACHE" "$FAKE")" \
  "Canned recall hit one"
STATE="$SANDBOX/s-stage2"
assert_contains "sudo-prefixed grep fires" \
  "$(run_hook Bash 'sudo grep -rn "memory recall dedup" /etc' s-stage2 "$CACHE" "$FAKE")" \
  "Canned recall hit one"
STATE="$SANDBOX/s-stage3"
assert_contains "git grep fires" \
  "$(run_hook Bash 'git grep -n "memory recall dedup" -- hooks' s-stage3 "$CACHE" "$FAKE")" \
  "Canned recall hit one"

echo "Substance gate — a query with nothing to match on emits nothing:"
STATE="$SANDBOX/s-thin"
assert_empty "pattern below MIN_CHARS"   "$(run_hook Bash "rg 'it'" s-thin1 "$CACHE" "$FAKE")"
assert_empty "purely numeric pattern"    "$(run_hook Bash 'grep -rn "0123456789" .' s-thin2 "$CACHE" "$FAKE")"
STATE="$SANDBOX/s-thin3"
assert_contains "MIN_CHARS=2 lets the short one through" \
  "$(run_hook Bash "rg 'it'" s-thin3 "$CACHE" "$FAKE" WORKBENCH_MEMORY_SCAN_RECALL_MIN_CHARS=2)" \
  "Canned recall hit one"

# ── The accumulation bound ──────────────────────────────────────────────────
echo "Per-session dedup — a second scan injects only the memory not yet seen:"
# The first scan (LIMIT=1) took hit one. A different query with room for two now
# returns both, and only hit TWO may be injected. Remove the seen-file check and
# this reddens on the unexpected reappearance of hit one.
STATE="$SANDBOX/s-dedup"
run_hook Bash "$SCAN" s-dedup "$CACHE" "$FAKE" >/dev/null
GOT=$(run_hook Bash 'rg -n "vault recall accumulation" hooks/' s-dedup "$CACHE" "$FAKE" \
        WORKBENCH_MEMORY_SCAN_RECALL_LIMIT=2)
assert_contains     "the unseen memory is injected"   "$GOT" "Canned recall hit two"
assert_not_contains "the seen memory is NOT repeated" "$GOT" "Canned recall hit one"

echo "Per-session dedup — a third scan, everything seen, emits nothing:"
GOT=$(run_hook Bash 'rg -n "bounded by distinct memories" hooks/' s-dedup "$CACHE" "$FAKE" \
        WORKBENCH_MEMORY_SCAN_RECALL_LIMIT=2)
assert_empty "all hits already injected → silent" "$GOT"

echo "The seen-file is SHARED with memory-recall.sh, so the bound spans both hooks:"
# Seed the seen-file exactly as memory-recall.sh would have on the opening
# prompt. A memory already in context must not be injected again by a scan.
STATE="$SANDBOX/s-shared"; mkdir -p "$STATE"
printf '%s\n' "insights/canned-recall-one.md" > "$STATE/s-shared.seen"
GOT=$(run_hook Bash "$SCAN" s-shared "$CACHE" "$FAKE")
assert_empty "a memory the prompt hook already injected is not repeated" "$GOT"
assert_contains "and the unseen sibling still comes through" \
  "$(run_hook Bash 'rg -n "vault recall accumulation" hooks/' s-shared "$CACHE" "$FAKE" \
       WORKBENCH_MEMORY_SCAN_RECALL_LIMIT=2)" \
  "Canned recall hit two"

echo "Dedup is per-session — a DIFFERENT session injects the same memory again:"
STATE="$SANDBOX/s-dedup"
assert_contains "fresh session re-injects" \
  "$(run_hook Bash "$SCAN" s-other-session "$CACHE" "$FAKE")" "Canned recall hit one"

echo "Per-session QUERY dedup — the same scan repeated never searches twice:"
# Discriminating: the repeat runs against a fixture that would return four
# DIFFERENT, entirely unseen memories. Path dedup alone cannot suppress those, so
# only the query check can keep this silent — and silence is also what proves the
# CLI was never spawned.
STATE="$SANDBOX/s-qdedup"
run_hook Bash "$SCAN" s-qdedup "$CACHE" "$FAKE" >/dev/null
GOT=$(run_hook Bash "$SCAN" s-qdedup "$CACHE" "$FAKE" FAKE_SEARCH_LESSONS=1 \
        WORKBENCH_MEMORY_SCAN_RECALL_LIMIT=3)
assert_empty "repeat of a seen query is not searched at all" "$GOT"
assert_contains "a NEW query in the same session still searches" \
  "$(run_hook Bash 'rg -n "release naming convention" .' s-qdedup "$CACHE" "$FAKE" \
       FAKE_SEARCH_LESSONS=1 WORKBENCH_MEMORY_SCAN_RECALL_LIMIT=3)" \
  "skills/release.learnings.md"

echo "Curated-type filter — a session summary is never injected:"
STATE="$SANDBOX/s-types"
GOT=$(run_hook Bash "$SCAN" s-types "$CACHE" "$FAKE" FAKE_SEARCH_NOISE=1)
assert_not_contains "session noise filtered out" "$GOT" "noise-tick.summary.md"
assert_contains     "curated hit injected"       "$GOT" "canned-recall-one.md"

# ── Scheduled-task guard ────────────────────────────────────────────────────
SCHED_BODY='<scheduled-task name="workbench-dev-team-dispatch" file="/Users/x/.claude/scheduled-tasks/d/SKILL.md">
This is an automated run of a scheduled task. The user is not present to answer questions.'

echo "Scheduled-task guard — an unattended tick is skipped entirely:"
STATE="$SANDBOX/s-sched"
SCHED_TR="$SANDBOX/sched.jsonl"
jq -cn --arg p "$SCHED_BODY" '{type:"user", message:{role:"user", content:$p}}' > "$SCHED_TR"
TRANSCRIPT_PATH="$SCHED_TR"
assert_empty "scheduled transcript → no injection" "$(run_hook Bash "$SCAN" s-sched "$CACHE" "$FAKE")"

echo "Scheduled-task guard — the skip survives a fresh session id every tick:"
# Every tick gets a new session, so neither dedup lever can suppress a
# re-injection. If the guard regresses, THIS is what makes it cost money forever.
assert_empty "second tick, different session, still skipped" \
  "$(run_hook Bash "$SCAN" s-sched-tick-2 "$CACHE" "$FAKE")"

echo "Scheduled-task guard — a human session with the same query is NOT skipped:"
STATE="$SANDBOX/s-human"
HUMAN_TR="$SANDBOX/human.jsonl"
jq -cn '{type:"user", message:{role:"user", content:"why does the <scheduled-task wrapper break prompt caching"}}' > "$HUMAN_TR"
TRANSCRIPT_PATH="$HUMAN_TR"
assert_contains "human prompt mentioning the wrapper still recalls" \
  "$(run_hook Bash "$SCAN" s-human "$CACHE" "$FAKE")" "Canned recall hit one"

echo "Scheduled-task guard — an array-shaped transcript content is read too:"
STATE="$SANDBOX/s-sched-arr"
ARR_TR="$SANDBOX/sched-array.jsonl"
jq -cn --arg p "$SCHED_BODY" \
  '{type:"assistant"}, {type:"user", message:{role:"user", content:[{type:"text", text:$p}]}}' > "$ARR_TR"
TRANSCRIPT_PATH="$ARR_TR"
assert_empty "wrapper inside a content block is still detected" \
  "$(run_hook Bash "$SCAN" s-sched-arr "$CACHE" "$FAKE")"

echo "Scheduled-task guard — an unreadable transcript fails OPEN (recall still runs):"
STATE="$SANDBOX/s-notr"
TRANSCRIPT_PATH="$SANDBOX/does-not-exist.jsonl"
assert_contains "missing transcript does not suppress recall" \
  "$(run_hook Bash "$SCAN" s-notr "$CACHE" "$FAKE")" "Canned recall hit one"
TRANSCRIPT_PATH=""

# ── Fail-open contract ──────────────────────────────────────────────────────
echo "Fail open — the disable switches emit nothing:"
STATE="$SANDBOX/s-off"
assert_empty "WORKBENCH_MEMORY_SCAN_RECALL=0" \
  "$(run_hook Bash "$SCAN" s-off1 "$CACHE" "$FAKE" WORKBENCH_MEMORY_SCAN_RECALL=0)"
assert_empty "WORKBENCH_MEMORY_RECALL=0 reaches this hook too" \
  "$(run_hook Bash "$SCAN" s-off2 "$CACHE" "$FAKE" WORKBENCH_MEMORY_RECALL=0)"

echo "Fail open — an unresolvable binary emits nothing, never errors:"
STATE="$SANDBOX/s-nobin"
assert_empty "unresolvable binary → silent no-op" \
  "$(run_hook Bash "$SCAN" s-nobin "$CACHE" "$SANDBOX/does-not-exist")"

echo "Fail open — a crashed CLI emits nothing, never errors:"
STATE="$SANDBOX/s-crash"
assert_empty "crashed CLI → silent no-op" \
  "$(run_hook Bash "$SCAN" s-crash "$CACHE" "$FAKE" FAKE_SEARCH_EXIT_NONZERO=1)"

echo "Fail open — an empty result set emits nothing:"
STATE="$SANDBOX/s-none"
assert_empty "no hits → no injection" \
  "$(run_hook Bash "$SCAN" s-none "$CACHE" "$FAKE" FAKE_SEARCH_EMPTY=1)"

echo "Watchdog — a hung CLI is killed at the timeout and fails open:"
STATE="$SANDBOX/s-hang"
START=$(date +%s)
GOT=$(run_hook Bash "$SCAN" s-hang "$CACHE" "$FAKE" \
        FAKE_SEARCH_HANG_SECONDS=30 WORKBENCH_MEMORY_SCAN_RECALL_TIMEOUT=1)
ELAPSED=$(( $(date +%s) - START ))
assert_empty "hung CLI past the watchdog → silent no-op" "$GOT"
assert_ok "watchdog bounded the wait (${ELAPSED}s, not the full 30s hang)" \
  "$([ "$ELAPSED" -le 5 ] && echo 1 || echo 0)"

echo "The happy path does NOT pay the watchdog timeout (an orphaned sleep would):"
# The watchdog forks a `sleep $TIMEOUT` that outlives the kill. If it inherits
# this hook's stdout, a caller reading to EOF blocks for the full timeout on
# every successful search — measured at 8s per fire before the fix, which alone
# makes a per-tool-call hook unusable.
STATE="$SANDBOX/s-fast"
START=$(date +%s)
GOT=$(run_hook Bash "$SCAN" s-fast "$CACHE" "$FAKE" WORKBENCH_MEMORY_SCAN_RECALL_TIMEOUT=30)
ELAPSED=$(( $(date +%s) - START ))
assert_contains "fast search still injects" "$GOT" "Canned recall hit one"
assert_ok "returned in ${ELAPSED}s, not the 30s watchdog window" \
  "$([ "$ELAPSED" -le 5 ] && echo 1 || echo 0)"

echo "Fail open — malformed and empty payloads emit nothing:"
STATE="$SANDBOX/s-payload"
feed_payload() {
  printf '%s' "$1" | env \
    WORKBENCH_CONFIG_FILE="$NO_CONFIG" WORKBENCH_MEMORY_CACHE="$CACHE" \
    WORKBENCH_MEMORY_SERVER_BIN="$FAKE" WORKBENCH_MEMORY_RECALL_STATE="$STATE" \
    bash "$HOOK"
}
assert_empty "empty stdin → no-op"       "$(feed_payload '')"
assert_empty "empty JSON object → no-op" "$(feed_payload '{}')"
assert_empty "no session_id → no-op" \
  "$(feed_payload '{"tool_name":"Bash","tool_input":{"command":"grep -rn \"memory recall dedup\" ."}}')"
assert_empty "tool_input missing → no-op" \
  "$(feed_payload '{"tool_name":"Bash","session_id":"s-p4"}')"
assert_empty "unparseable command → no-op" \
  "$(feed_payload '{"tool_name":"Bash","session_id":"s-p5","tool_input":{"command":"grep -rn \"unterminated memory recall"}}')"

echo "Injection-shaped input stays valid JSON on the way out:"
STATE="$SANDBOX/s-inject"
GOT=$(run_hook Grep 'recall"}],"x":{ $(whoami) `id` dedup' s-inject "$CACHE" "$FAKE")
assert_contains "metachar pattern still injects" "$GOT" "Canned recall hit one"
assert_ok "emitted additionalContext is valid JSON despite metachars" \
  "$(printf '%s' "$GOT" | jq -e . >/dev/null 2>&1 && echo 1 || echo 0)"

echo "The liveness breadcrumb belongs to memory-recall.sh alone:"
# The warmup's 48h staleness check asks "did recall fire for a real human
# prompt". A tool-call hook stamping it would mask a dead memory-recall.sh.
STATE="$SANDBOX/s-stamp"
run_hook Bash "$SCAN" s-stamp "$CACHE" "$FAKE" >/dev/null 2>&1
assert_ok "scan recall leaves last-attempt unstamped" \
  "$([ ! -f "$STATE/last-attempt" ] && echo 1 || echo 0)"

echo "Hook always exits 0 (unresolvable binary path):"
STATE="$SANDBOX/s-rc"
run_hook Bash "$SCAN" s-rc "$CACHE" "$SANDBOX/does-not-exist" >/dev/null 2>&1
assert_ok "exits 0 even with an unresolvable binary" "$([ "$?" -eq 0 ] && echo 1 || echo 0)"

echo "Registered in hooks.json on PostToolUse, matching Grep and Bash:"
HOOKS_JSON="$HOOKS/hooks.json"
REGISTERED=$(jq -r '
  .hooks.PostToolUse[]
  | select(.hooks[]?.command | test("memory-scan-recall\\.sh"))
  | .matcher' "$HOOKS_JSON" 2>/dev/null)
assert_ok "PostToolUse entry exists" "$([ -n "$REGISTERED" ] && echo 1 || echo 0)"
assert_ok "matcher covers Grep" "$(printf '%s' "Grep" | grep -Eq "$REGISTERED" && echo 1 || echo 0)"
assert_ok "matcher covers Bash" "$(printf '%s' "Bash" | grep -Eq "$REGISTERED" && echo 1 || echo 0)"
assert_ok "matcher excludes Glob" "$(printf '%s' "Glob" | grep -Eq "$REGISTERED" && echo 0 || echo 1)"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
