#!/bin/bash
# Tests for hooks/memory-recall.sh — the proactive vault-recall UserPromptSubmit
# hook. Run directly: ./test-memory-recall.sh
#
# Each case feeds a hook payload on stdin and asserts the hook's stdout (an
# additionalContext JSON block, or nothing). The hook shells out to the
# markdown-vault-mcp `search` CLI (one-shot subprocess, no server, no port) via
# WORKBENCH_MEMORY_SERVER_BIN, pointed at the fake-server fixture's `search`
# subcommand (fixtures/fake-markdown-vault-mcp.sh) — canned hits, no real
# embeddings, no outbound network, no process left running afterward.

set -u
HOOKS="$(cd "$(dirname "$0")" && pwd)"
HOOK="$HOOKS/memory-recall.sh"
FAKE="$HOOKS/fixtures/fake-markdown-vault-mcp.sh"
PASS=0
FAIL=0

SANDBOX=$(mktemp -d)
NO_CONFIG="$SANDBOX/absent-config.json"   # never created → memory-env uses overrides
cleanup() { rm -rf "$SANDBOX"; }
trap cleanup EXIT

# run_hook <prompt> <session_id> <cache> <SERVER_BIN> [EXTRA_ENV=val ...] — feed
# the hook a UserPromptSubmit payload and echo its stdout.
run_hook() {
  local prompt="$1" sid="$2" cache="$3" bin="$4"; shift 4
  local payload
  payload=$(jq -cn --arg p "$prompt" --arg s "$sid" \
    '{prompt:$p, session_id:$s, hook_event_name:"UserPromptSubmit"}')
  printf '%s' "$payload" | env \
    WORKBENCH_CONFIG_FILE="$NO_CONFIG" \
    WORKBENCH_MEMORY_CACHE="$cache" \
    WORKBENCH_MEMORY_SERVER_BIN="$bin" \
    WORKBENCH_MEMORY_RECALL_STATE="$SANDBOX/state" \
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
# Assert a fixed-string needle appears EXACTLY want times — guards the "inject at
# most once per turn" invariant against duplicate-hit regressions.
assert_count() {
  local desc="$1" got="$2" needle="$3" want="$4" n
  n=$(printf '%s' "$got" | grep -oF -- "$needle" | wc -l | tr -d ' ')
  if [ "$n" = "$want" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc (×$n)"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected ×$want, got ×$n"
  fi
}

mk_cache() { mkdir -p "$1"; }

# ─────────────────────────────────────────────────────────────────────────────
echo "Disable switch — WORKBENCH_MEMORY_RECALL=0 emits nothing:"
CACHE="$SANDBOX/disabled"; mk_cache "$CACHE"
GOT=$(run_hook "how should I design the recall mechanism" s-dis "$CACHE" "$FAKE" WORKBENCH_MEMORY_RECALL=0)
assert_empty "disabled hook is a no-op" "$GOT"

echo "Substance gate — slash command is skipped:"
CACHE="$SANDBOX/slash"; mk_cache "$CACHE"
GOT=$(run_hook "/bujo today please review" s-slash "$CACHE" "$FAKE")
assert_empty "slash-command prompt skipped" "$GOT"

echo "Substance gate — too-short prompt is skipped:"
CACHE="$SANDBOX/short"; mk_cache "$CACHE"
GOT=$(run_hook "hi there" s-short "$CACHE" "$FAKE")
assert_empty "prompt under MIN_CHARS skipped" "$GOT"

echo "Substance gate — trivial confirmation skipped even with MIN_CHARS=1:"
CACHE="$SANDBOX/trivial"; mk_cache "$CACHE"
GOT=$(run_hook "continue" s-triv "$CACHE" "$FAKE" WORKBENCH_MEMORY_RECALL_MIN_CHARS=1)
assert_empty "bare 'continue' skipped by triviality regex" "$GOT"

echo "Fail-open — binary cannot be resolved emits nothing, never errors:"
CACHE="$SANDBOX/nobin"; mk_cache "$CACHE"
GOT=$(run_hook "how should I design the recall mechanism" s-nobin "$CACHE" "$SANDBOX/does-not-exist")
assert_empty "unresolvable binary → silent no-op" "$GOT"

echo "Fail-open — CLI exits non-zero emits nothing, never errors:"
CACHE="$SANDBOX/crash"; mk_cache "$CACHE"
GOT=$(run_hook "how should I design the recall mechanism" s-crash "$CACHE" "$FAKE" FAKE_SEARCH_EXIT_NONZERO=1)
assert_empty "crashed CLI → silent no-op" "$GOT"

echo "Watchdog — a hung CLI is killed at the timeout and fails open:"
CACHE="$SANDBOX/hang"; mk_cache "$CACHE"
START=$(date +%s)
GOT=$(run_hook "how should I design the recall mechanism" s-hang "$CACHE" "$FAKE" \
  FAKE_SEARCH_HANG_SECONDS=30 WORKBENCH_MEMORY_RECALL_TIMEOUT=1)
ELAPSED=$(( $(date +%s) - START ))
assert_empty "hung CLI past the watchdog → silent no-op" "$GOT"
if [ "$ELAPSED" -le 5 ]; then
  PASS=$((PASS + 1)); echo "  ✅ watchdog bounded the wait (${ELAPSED}s, not the full 30s hang)"
else
  FAIL=$((FAIL + 1)); echo "  ❌ watchdog did not bound the wait (${ELAPSED}s elapsed)"
fi

echo "Happy path — substantive prompt injects canned hits:"
CACHE="$SANDBOX/happy"; mk_cache "$CACHE"
GOT=$(run_hook "how should I design the memory recall mechanism" s-happy "$CACHE" "$FAKE")
assert_contains "emits recall header" "$GOT" "🧠"
assert_contains "includes first canned hit" "$GOT" "Canned recall hit one"
assert_contains "includes second canned hit" "$GOT" "Canned recall hit two"
assert_contains "carries the hit's type tag" "$GOT" "[insight]"
assert_contains "uses UserPromptSubmit additionalContext" "$GOT" "additionalContext"

echo "Output is well-formed JSON with the expected hook shape:"
EVT=$(printf '%s' "$GOT" | jq -r '.hookSpecificOutput.hookEventName' 2>/dev/null)
[ "$EVT" = "UserPromptSubmit" ] \
  && { PASS=$((PASS+1)); echo "  ✅ valid JSON, hookEventName=UserPromptSubmit"; } \
  || { FAIL=$((FAIL+1)); echo "  ❌ expected UserPromptSubmit hookEventName, got '$EVT'"; }

echo "Per-session dedup — same session, second turn re-injects nothing:"
GOT2=$(run_hook "remind me about the recall mechanism design again" s-happy "$CACHE" "$FAKE")
assert_empty "already-seen paths not re-injected in same session" "$GOT2"

echo "Dedup is per-session — a DIFFERENT session injects the hits again:"
GOT3=$(run_hook "how should I design the memory recall mechanism" s-other "$CACHE" "$FAKE")
assert_contains "fresh session re-injects" "$GOT3" "Canned recall hit one"

echo "Empty result set — vault returns no hits → no-op:"
CACHE="$SANDBOX/none"; mk_cache "$CACHE"
GOT=$(run_hook "a perfectly substantive question about nothing indexed" s-none "$CACHE" "$FAKE" FAKE_SEARCH_EMPTY=1)
assert_empty "no hits → no injection" "$GOT"

echo "LIMIT — WORKBENCH_MEMORY_RECALL_LIMIT=1 injects a single hit:"
CACHE="$SANDBOX/limit"; mk_cache "$CACHE"
GOT=$(run_hook "how should I design the memory recall mechanism" s-lim "$CACHE" "$FAKE" WORKBENCH_MEMORY_RECALL_LIMIT=1)
assert_contains "limit=1 includes the top hit" "$GOT" "Canned recall hit one"
assert_not_contains "limit=1 excludes the second hit" "$GOT" "Canned recall hit two"

echo "Each hit is injected exactly once (no double-counting the bare JSON array):"
CACHE="$SANDBOX/once"; mk_cache "$CACHE"
GOT=$(run_hook "how should I design the memory recall mechanism" s-once "$CACHE" "$FAKE" WORKBENCH_MEMORY_RECALL_LIMIT=3)
assert_count "first hit injected exactly once" "$GOT" "Canned recall hit one" 1
assert_count "second hit injected exactly once" "$GOT" "Canned recall hit two" 1

echo "Injection-shaped prompt (quotes/braces/backslashes/subshell) is safely encoded:"
CACHE="$SANDBOX/inject"; mk_cache "$CACHE"
GOT=$(run_hook 'what about "}],"x":{ and \ backslashes and $(whoami) `id` in my design?' s-inj "$CACHE" "$FAKE")
assert_contains "metachar prompt still injects" "$GOT" "Canned recall hit one"
if printf '%s' "$GOT" | jq -e . >/dev/null 2>&1; then
  PASS=$((PASS+1)); echo "  ✅ emitted additionalContext is valid JSON despite metachars"
else
  FAIL=$((FAIL+1)); echo "  ❌ emitted additionalContext is not valid JSON"
fi

echo "Malformed / empty payloads fail open (no output):"
CACHE="$SANDBOX/payload"; mk_cache "$CACHE"
feed_payload() {  # feed_payload <raw-stdin>
  printf '%s' "$1" | env \
    WORKBENCH_CONFIG_FILE="$NO_CONFIG" WORKBENCH_MEMORY_CACHE="$CACHE" \
    WORKBENCH_MEMORY_SERVER_BIN="$FAKE" WORKBENCH_MEMORY_RECALL_STATE="$SANDBOX/state" \
    bash "$HOOK"
}
assert_empty "empty stdin → no-op" "$(feed_payload '')"
assert_empty "empty JSON object {} → no-op" "$(feed_payload '{}')"
assert_empty "prompt but no session_id → no-op" "$(feed_payload '{"prompt":"a perfectly substantive design question here"}')"

echo "Curated-type filter — session-summary hits are never injected:"
CACHE="$SANDBOX/typefilter"; mk_cache "$CACHE"
GOT=$(run_hook "a substantive design question about the memory system" "s-tf1" "$CACHE" "$FAKE" FAKE_SEARCH_NOISE=1)
assert_contains     "curated hit one injected"      "$GOT" "canned-recall-one.md"
assert_contains     "curated hit two injected"      "$GOT" "canned-recall-two.md"
assert_not_contains "session noise hit filtered"    "$GOT" "noise-tick.summary.md"

echo "Curated-type filter — empty TYPES disables the filter:"
GOT=$(run_hook "a substantive design question about the memory system" "s-tf2" "$CACHE" "$FAKE" FAKE_SEARCH_NOISE=1 WORKBENCH_MEMORY_RECALL_TYPES=)
assert_contains "session hit injected when filter disabled" "$GOT" "noise-tick.summary.md"

echo "Query truncation — oversized prompt still searches and injects:"
CACHE="$SANDBOX/trunc"; mk_cache "$CACHE"
LONGPROMPT="how should the memory vault handle recall $(printf 'x%.0s' $(seq 1 4000))"
GOT=$(run_hook "$LONGPROMPT" "s-tr1" "$CACHE" "$FAKE")
assert_contains "long prompt still injects" "$GOT" "canned-recall-one.md"

echo "Liveness breadcrumb — substantive attempt stamps last-attempt:"
if [ -f "$SANDBOX/state/last-attempt" ]; then
  PASS=$((PASS+1)); echo "  ✅ last-attempt stamp exists"
else
  FAIL=$((FAIL+1)); echo "  ❌ last-attempt stamp missing"
fi

echo "Hook always exits 0 (unresolvable binary path):"
printf '%s' "$(jq -cn '{prompt:"a substantive question here", session_id:"s-rc", hook_event_name:"UserPromptSubmit"}')" \
  | env WORKBENCH_CONFIG_FILE="$NO_CONFIG" WORKBENCH_MEMORY_SERVER_BIN="$SANDBOX/does-not-exist" \
        WORKBENCH_MEMORY_CACHE="$SANDBOX/rc" WORKBENCH_MEMORY_RECALL_STATE="$SANDBOX/state" \
    bash "$HOOK" >/dev/null 2>&1
[ "$?" -eq 0 ] && { PASS=$((PASS+1)); echo "  ✅ exits 0 even with an unresolvable binary"; } \
              || { FAIL=$((FAIL+1)); echo "  ❌ hook returned non-zero"; }

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
