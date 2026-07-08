#!/bin/bash
# Tests for hooks/memory-recall.sh — the proactive vault-recall UserPromptSubmit
# hook. Run directly: ./test-memory-recall.sh
#
# Each case feeds a hook payload on stdin and asserts the hook's stdout (an
# additionalContext JSON block, or nothing). The vault is the fake-server fixture
# (fixtures/fake-markdown-vault-mcp.sh) answering tools/call/search with canned
# hits — no real server, no embeddings, no outbound network. The hook is steered
# at the fixture via the same WORKBENCH_* overrides memory-env.sh honors.

set -u
HOOKS="$(cd "$(dirname "$0")" && pwd)"
HOOK="$HOOKS/memory-recall.sh"
FAKE="$HOOKS/fixtures/fake-markdown-vault-mcp.sh"
PASS=0
FAIL=0

SANDBOX=$(mktemp -d)
NO_CONFIG="$SANDBOX/absent-config.json"   # never created → memory-env uses overrides
FAKE_PIDS=()
cleanup() {
  for p in "${FAKE_PIDS[@]:-}"; do
    [ -n "$p" ] && kill "$p" 2>/dev/null
  done
  rm -rf "$SANDBOX"
}
trap cleanup EXIT

# Hand out a fresh loopback port per fake so cases never clash (file-backed
# counter survives the command-substitution subshell — see test-memory-probe.sh).
PORT_COUNTER="$SANDBOX/.port"
echo 18820 > "$PORT_COUNTER"
next_port() {
  local n
  n=$(( $(cat "$PORT_COUNTER") + 1 ))
  echo "$n" > "$PORT_COUNTER"
  echo "$n"
}

# start_fake <port> [VAR=value ...] — launch the fixture and wait until it
# actually LISTENs (lsof as ground truth), so a case never races the bind.
start_fake() {
  local port="$1"; shift
  env MARKDOWN_VAULT_MCP_SERVER_NAME=test-vault "$@" \
    bash "$FAKE" serve --transport http --host 127.0.0.1 --port "$port" --http-path /mcp \
    >/dev/null 2>&1 &
  FAKE_PIDS+=("$!")
  # Drop the job from the shell's table so cleanup's kill doesn't print an async
  # "Terminated" job-control notice (we still hold the pid to kill it).
  disown 2>/dev/null || true
  local i=0
  while [ "$i" -lt 120 ]; do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then return 0; fi
    i=$((i + 1)); sleep 0.05
  done
  return 0
}

# run_hook <prompt> <session_id> <cache> <port> [EXTRA_ENV=val ...] — feed the
# hook a UserPromptSubmit payload and echo its stdout.
run_hook() {
  local prompt="$1" sid="$2" cache="$3" port="$4"; shift 4
  local payload
  payload=$(jq -cn --arg p "$prompt" --arg s "$sid" \
    '{prompt:$p, session_id:$s, hook_event_name:"UserPromptSubmit"}')
  printf '%s' "$payload" | env \
    WORKBENCH_CONFIG_FILE="$NO_CONFIG" \
    WORKBENCH_MEMORY_PORT="$port" \
    WORKBENCH_MEMORY_CACHE="$cache" \
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

# A cache dir with a server.token, mirroring a real running server.
mk_cache() {
  local d="$1" tok="$2"
  mkdir -p "$d"
  [ -n "$tok" ] && printf '%s' "$tok" > "$d/server.token"
}

# ─────────────────────────────────────────────────────────────────────────────
echo "Disable switch — WORKBENCH_MEMORY_RECALL=0 emits nothing:"
CACHE="$SANDBOX/disabled"; mk_cache "$CACHE" ""
P=$(next_port); start_fake "$P"
GOT=$(run_hook "how should I design the recall mechanism" s-dis "$CACHE" "$P" WORKBENCH_MEMORY_RECALL=0)
assert_empty "disabled hook is a no-op" "$GOT"

echo "Substance gate — slash command is skipped:"
CACHE="$SANDBOX/slash"; mk_cache "$CACHE" ""
P=$(next_port); start_fake "$P"
GOT=$(run_hook "/bujo today please review" s-slash "$CACHE" "$P")
assert_empty "slash-command prompt skipped" "$GOT"

echo "Substance gate — too-short prompt is skipped:"
CACHE="$SANDBOX/short"; mk_cache "$CACHE" ""
P=$(next_port); start_fake "$P"
GOT=$(run_hook "hi there" s-short "$CACHE" "$P")
assert_empty "prompt under MIN_CHARS skipped" "$GOT"

echo "Substance gate — trivial confirmation skipped even with MIN_CHARS=1:"
CACHE="$SANDBOX/trivial"; mk_cache "$CACHE" ""
P=$(next_port); start_fake "$P"
GOT=$(run_hook "continue" s-triv "$CACHE" "$P" WORKBENCH_MEMORY_RECALL_MIN_CHARS=1)
assert_empty "bare 'continue' skipped by triviality regex" "$GOT"

echo "Fail-open — server down (dead port) emits nothing, never errors:"
CACHE="$SANDBOX/down"; mk_cache "$CACHE" ""
GOT=$(run_hook "how should I design the recall mechanism" s-down "$CACHE" 18999)
assert_empty "down server → silent no-op" "$GOT"

echo "Happy path — substantive prompt injects canned hits:"
CACHE="$SANDBOX/happy"; mk_cache "$CACHE" ""
P=$(next_port); start_fake "$P"
GOT=$(run_hook "how should I design the memory recall mechanism" s-happy "$CACHE" "$P")
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
GOT2=$(run_hook "remind me about the recall mechanism design again" s-happy "$CACHE" "$P")
assert_empty "already-seen paths not re-injected in same session" "$GOT2"

echo "Dedup is per-session — a DIFFERENT session injects the hits again:"
GOT3=$(run_hook "how should I design the memory recall mechanism" s-other "$CACHE" "$P")
assert_contains "fresh session re-injects" "$GOT3" "Canned recall hit one"

echo "Empty result set — vault returns no hits → no-op:"
CACHE="$SANDBOX/none"; mk_cache "$CACHE" ""
P=$(next_port); start_fake "$P" FAKE_SEARCH_EMPTY=1
GOT=$(run_hook "a perfectly substantive question about nothing indexed" s-none "$CACHE" "$P")
assert_empty "no hits → no injection" "$GOT"

echo "LIMIT — WORKBENCH_MEMORY_RECALL_LIMIT=1 injects a single hit:"
CACHE="$SANDBOX/limit"; mk_cache "$CACHE" ""
P=$(next_port); start_fake "$P"
GOT=$(run_hook "how should I design the memory recall mechanism" s-lim "$CACHE" "$P" WORKBENCH_MEMORY_RECALL_LIMIT=1)
assert_contains "limit=1 includes the top hit" "$GOT" "Canned recall hit one"
assert_not_contains "limit=1 excludes the second hit" "$GOT" "Canned recall hit two"

echo "Bearer token reaches the server (token-validating fixture):"
TOK='s3cr3t-recall-token'
CACHE="$SANDBOX/auth-ok"; mk_cache "$CACHE" "$TOK"
P=$(next_port); start_fake "$P" FAKE_SERVER_REQUIRE_TOKEN="$TOK"
GOT=$(run_hook "how should I design the memory recall mechanism" s-authok "$CACHE" "$P")
assert_contains "correct token → search succeeds → injects" "$GOT" "Canned recall hit one"

CACHE="$SANDBOX/auth-missing"; mk_cache "$CACHE" ""   # no server.token
P=$(next_port); start_fake "$P" FAKE_SERVER_REQUIRE_TOKEN="$TOK"
GOT=$(run_hook "how should I design the memory recall mechanism" s-authmiss "$CACHE" "$P")
assert_empty "missing token → 401 → fail-open no-op" "$GOT"

echo "SSE-framed search response is parsed (event:/data: framing):"
CACHE="$SANDBOX/sse"; mk_cache "$CACHE" ""
P=$(next_port); start_fake "$P" FAKE_SERVER_SSE=1
GOT=$(run_hook "how should I design the memory recall mechanism" s-sse "$CACHE" "$P")
assert_contains "SSE-framed result still injects" "$GOT" "Canned recall hit one"

echo "Dual content+structuredContent (live-server shape) injects each hit ONCE:"
# Regression for the duplicate-injection bug: the live server mirrors the same
# hits into BOTH content[].text and structuredContent. With LIMIT (3) > distinct
# hits (2), a parser that UNIONS the two sources before slicing would inject a
# hit twice. The hook must prefer one source and inject each path exactly once.
CACHE="$SANDBOX/dual"; mk_cache "$CACHE" ""
P=$(next_port); start_fake "$P" FAKE_SEARCH_SHAPE=dual
GOT=$(run_hook "how should I design the memory recall mechanism" s-dual "$CACHE" "$P" WORKBENCH_MEMORY_RECALL_LIMIT=3)
assert_contains "dual-shape still injects" "$GOT" "Canned recall hit one"
assert_count "first hit injected exactly once (not duplicated)" "$GOT" "Canned recall hit one" 1
assert_count "second hit injected exactly once (not duplicated)" "$GOT" "Canned recall hit two" 1

echo "structuredContent-only response is parsed via the fallback branch:"
CACHE="$SANDBOX/structured"; mk_cache "$CACHE" ""
P=$(next_port); start_fake "$P" FAKE_SEARCH_SHAPE=structured
GOT=$(run_hook "how should I design the memory recall mechanism" s-struct "$CACHE" "$P")
assert_contains "structuredContent-only still injects" "$GOT" "Canned recall hit one"
assert_count "fallback path injects the hit once" "$GOT" "Canned recall hit one" 1

echo "Injection-shaped prompt (quotes/braces/backslashes/subshell) is safely encoded:"
CACHE="$SANDBOX/inject"; mk_cache "$CACHE" ""
P=$(next_port); start_fake "$P"
GOT=$(run_hook 'what about "}],"x":{ and \ backslashes and $(whoami) `id` in my design?' s-inj "$CACHE" "$P")
assert_contains "metachar prompt still injects" "$GOT" "Canned recall hit one"
if printf '%s' "$GOT" | jq -e . >/dev/null 2>&1; then
  PASS=$((PASS+1)); echo "  ✅ emitted additionalContext is valid JSON despite metachars"
else
  FAIL=$((FAIL+1)); echo "  ❌ emitted additionalContext is not valid JSON"
fi

echo "Malformed / empty payloads fail open (no output):"
P=$(next_port); start_fake "$P"
CACHE="$SANDBOX/payload"; mk_cache "$CACHE" ""
feed_payload() {  # feed_payload <raw-stdin>
  printf '%s' "$1" | env \
    WORKBENCH_CONFIG_FILE="$NO_CONFIG" WORKBENCH_MEMORY_PORT="$P" \
    WORKBENCH_MEMORY_CACHE="$CACHE" WORKBENCH_MEMORY_RECALL_STATE="$SANDBOX/state" \
    bash "$HOOK"
}
assert_empty "empty stdin → no-op" "$(feed_payload '')"
assert_empty "empty JSON object {} → no-op" "$(feed_payload '{}')"
assert_empty "prompt but no session_id → no-op" "$(feed_payload '{"prompt":"a perfectly substantive design question here"}')"

echo "Hook always exits 0 (down server path):"
printf '%s' "$(jq -cn '{prompt:"a substantive question here", session_id:"s-rc", hook_event_name:"UserPromptSubmit"}')" \
  | env WORKBENCH_CONFIG_FILE="$NO_CONFIG" WORKBENCH_MEMORY_PORT=18998 \
        WORKBENCH_MEMORY_CACHE="$SANDBOX/rc" WORKBENCH_MEMORY_RECALL_STATE="$SANDBOX/state" \
    bash "$HOOK" >/dev/null 2>&1
[ "$?" -eq 0 ] && { PASS=$((PASS+1)); echo "  ✅ exits 0 even with server down"; } \
              || { FAIL=$((FAIL+1)); echo "  ❌ hook returned non-zero"; }

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
