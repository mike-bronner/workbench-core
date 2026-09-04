#!/bin/bash
# Tests for hooks/delegation-gate.sh — the PreToolUse orchestrator delegation
# gate. Run directly: ./test-delegation-gate.sh
# Each case feeds one synthetic PreToolUse payload on stdin and asserts whether
# the gate denies (emits permissionDecision "deny") or stays silent (allows).
# Pure stdin/stdout checks — no network, no server, nothing read from the real
# home directory.
#
# Allow branches (a)-(f) from the script header are each covered independently,
# so no one branch can mask another.

set -u
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
GATE="$HOOKS_DIR/delegation-gate.sh"
HOOKS_JSON="$HOOKS_DIR/hooks.json"
SKILL="$HOOKS_DIR/../skills/orchestrator/SKILL.md"
PASS=0
FAIL=0

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/delegation-gate.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT

# Both pieces of external state this gate reads are isolated. The state dir is
# overridden so the human's real toggle never decides this suite's verdicts, and
# HOME is faked so the deny message's dev-team probe reads a directory we
# control rather than the real plugin cache.
STATE_DIR="$SANDBOX/state"
FAKE_HOME="$SANDBOX/home"            # no plugin cache: the plain deny message
DEVTEAM_HOME="$SANDBOX/home-devteam"  # plugin cache present: enriched message
mkdir -p "$STATE_DIR" "$FAKE_HOME" \
  "$DEVTEAM_HOME/.claude/plugins/cache/claude-workbench/workbench-dev-team"

SESSION="b94bbff5-0f68-4c1c-b3ec-3a899d30bc05"

# The exact bytes the gate must emit on a deny with no dev-team plugin present.
# Asserted verbatim below: the harness parses this, and a stray space or a
# reordered key is a silent break.
EXPECTED_DENY='{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"🚦 Delegation gate: the main agent orchestrates and does not edit files. Dispatch a sub-agent with the Agent tool to make this change. To edit inline in this session, run /workbench-core:orchestrator off."}}'
DEVTEAM_LINE='For development work, dispatch Dr. Watson in Direct mode per /workbench-dev-team:orchestrate.'

# Builds a payload from key=value pairs. A value of - omits the key entirely,
# which is how "main agent" is expressed: agent_id and agent_type are ABSENT,
# not empty. Verified against a live logging hook.
payload() {
  local obj='{"hook_event_name":"PreToolUse"}' arg k v
  for arg in "$@"; do
    k="${arg%%=*}"
    v="${arg#*=}"
    [ "$v" = "-" ] && continue
    obj=$(printf '%s' "$obj" | jq -c --arg k "$k" --arg v "$v" '.[$k] = $v')
  done
  printf '%s' "$obj"
}

# The gate under the suite's controlled environment. WORKBENCH_ORCHESTRATOR is
# unset so a value inherited from the caller cannot silently allow every case.
gate() {
  env -u WORKBENCH_ORCHESTRATOR HOME="$FAKE_HOME" \
    WORKBENCH_ORCHESTRATOR_STATE_DIR="$STATE_DIR" bash "$GATE"
}

check() {
  local desc="$1" output="$2" expect="$3" verdict
  if printf '%s' "$output" | grep -q '"permissionDecision":"deny"'; then
    verdict=deny
  else
    verdict=silent
  fi
  if [ "$verdict" = "$expect" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected $expect, got $verdict"
  fi
}

run_case() {
  local desc="$1" expect="$2"; shift 2
  check "$desc" "$(payload "$@" | gate)" "$expect"
}

assert_jq() {
  local desc="$1" file="$2" filter="$3" expected="$4" actual
  actual="$(jq -r "$filter" "$file" 2>/dev/null)"
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected [$expected], got [$actual]"
  fi
}

assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if printf '%s\n' "$haystack" | grep -qF -- "$needle"; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — output missing: $needle"
  fi
}

assert_missing() {
  local desc="$1" haystack="$2" needle="$3"
  if printf '%s\n' "$haystack" | grep -qF -- "$needle"; then
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — output unexpectedly contains: $needle"
  else
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  fi
}

assert_grep() {
  local desc="$1" needle="$2" file="$3"
  if grep -qF -- "$needle" "$file" 2>/dev/null; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc"
  fi
}

echo "the deny path (main agent, gate on):"
run_case "main agent Write"        deny tool_name=Write        session_id="$SESSION" agent_id=- agent_type=-
run_case "main agent Edit"         deny tool_name=Edit         session_id="$SESSION" agent_id=- agent_type=-
run_case "main agent NotebookEdit" deny tool_name=NotebookEdit session_id="$SESSION" agent_id=- agent_type=-

echo "(a) sub-agent calls are allowed:"
run_case "Task sub-agent (agent_id + agent_type)" silent \
  tool_name=Write session_id="$SESSION" agent_id=a79d47fc851cc123f agent_type=general-purpose
run_case "agent_id alone still allows" silent \
  tool_name=Write session_id="$SESSION" agent_id=a79d47fc851cc123f agent_type=-

echo "(b) top-level --agent dispatch is allowed:"
run_case "claude -p --agent (agent_type, NO agent_id)" silent \
  tool_name=Write session_id="$SESSION" agent_id=- agent_type=workbench-dev-team:watson
# Field-separator pin. Present-but-empty agent_id/agent_type is the shape that
# breaks under an @tsv join: bash collapses runs of IFS whitespace, so a tab
# record with empty leading fields shifts tool_name into agent_id's slot and the
# gate allows everything. US (0x1f) is not IFS whitespace, so the empties
# survive. Swap the join for a tab and this case goes green-to-silent.
run_case "empty agent_id does not count as a sub-agent" deny \
  tool_name=Write session_id="$SESSION" agent_id= agent_type=

echo "(c) the environment escape hatch:"
out=$(payload tool_name=Write session_id="$SESSION" agent_id=- agent_type=- \
  | env HOME="$FAKE_HOME" WORKBENCH_ORCHESTRATOR_STATE_DIR="$STATE_DIR" \
        WORKBENCH_ORCHESTRATOR=0 bash "$GATE")
check "WORKBENCH_ORCHESTRATOR=0 allows" "$out" silent
# Only the literal 0 opts out. Any other value, including a truthy-looking one,
# leaves the gate armed — this is what stops `=1` reading as "on, so allow".
out=$(payload tool_name=Write session_id="$SESSION" agent_id=- agent_type=- \
  | env HOME="$FAKE_HOME" WORKBENCH_ORCHESTRATOR_STATE_DIR="$STATE_DIR" \
        WORKBENCH_ORCHESTRATOR=1 bash "$GATE")
check "WORKBENCH_ORCHESTRATOR=1 does NOT allow" "$out" deny

echo "(d) the session toggle:"
run_case "no state file -> gate is ON by default" deny tool_name=Write session_id="$SESSION" agent_id=- agent_type=-
touch "$STATE_DIR/$SESSION"
run_case "state file for this session allows" silent tool_name=Write session_id="$SESSION" agent_id=- agent_type=-
run_case "state file for ANOTHER session does not allow" deny \
  tool_name=Write session_id=11111111-2222-3333-4444-555555555555 agent_id=- agent_type=-
rm -f "$STATE_DIR/$SESSION"
run_case "removing the state file re-enables the gate" deny tool_name=Write session_id="$SESSION" agent_id=- agent_type=-

# An unset override must fall back to the documented default under $HOME, and a
# fresh fake HOME has no state file there — so the gate still denies. This is
# what proves the default path is a real lookup, not a silent allow.
DEFAULT_HOME="$SANDBOX/default-home"
mkdir -p "$DEFAULT_HOME"
out=$(payload tool_name=Write session_id="$SESSION" agent_id=- agent_type=- \
  | env -u WORKBENCH_ORCHESTRATOR -u WORKBENCH_ORCHESTRATOR_STATE_DIR \
        HOME="$DEFAULT_HOME" bash "$GATE")
check "unset state dir falls back to \$HOME and still denies" "$out" deny

# ...and the fallback resolves to the documented path, not somewhere else.
mkdir -p "$DEFAULT_HOME/.claude-workbench/orchestrator-mode"
touch "$DEFAULT_HOME/.claude-workbench/orchestrator-mode/$SESSION"
out=$(payload tool_name=Write session_id="$SESSION" agent_id=- agent_type=- \
  | env -u WORKBENCH_ORCHESTRATOR -u WORKBENCH_ORCHESTRATOR_STATE_DIR \
        HOME="$DEFAULT_HOME" bash "$GATE")
check "default path is \$HOME/.claude-workbench/orchestrator-mode/<session_id>" "$out" silent

run_case "absent session_id cannot address the toggle -> fails open" silent \
  tool_name=Write session_id=- agent_id=- agent_type=-
run_case "empty session_id -> fails open" silent \
  tool_name=Write session_id= agent_id=- agent_type=-
run_case "session_id with a path separator -> fails open, no traversal" silent \
  tool_name=Write session_id="../../etc/passwd" agent_id=- agent_type=-
# Traversal is refused, not resolved: a state file planted at the destination
# the payload points to must not be what allows the call. Drop the character
# class and this case still reads silent, so it is paired with the deny case
# above — together they pin refusal rather than mere absence.
mkdir -p "$SANDBOX/escape"
touch "$SANDBOX/escape/planted"
out=$(payload tool_name=Write session_id="../escape/planted" agent_id=- agent_type=- | gate)
check "a planted file outside the state dir is never consulted" "$out" silent

echo "(e) out-of-scope tools:"
run_case "Bash"              silent tool_name=Bash session_id="$SESSION" agent_id=- agent_type=-
run_case "Read"              silent tool_name=Read session_id="$SESSION" agent_id=- agent_type=-
run_case "missing tool_name" silent tool_name=-    session_id="$SESSION" agent_id=- agent_type=-

echo "(f) errors fail open:"
out=$(printf '%s' 'not json at all {{{' | gate)
check "malformed JSON" "$out" silent
out=$(printf '%s' '{"tool_name":"Write","session_id":' | gate)
check "truncated JSON" "$out" silent
out=$(printf '%s' '' | gate)
check "empty payload" "$out" silent
out=$(printf '%s' '["a","json","array"]' | gate)
check "JSON that is not an object" "$out" silent

# jq is the only hard dependency. Without it the gate must allow, never deny.
NOJQ_BIN="$SANDBOX/nojq-bin"
mkdir -p "$NOJQ_BIN"
for tool in bash cat grep sed; do
  src="$(command -v "$tool" 2>/dev/null)" && ln -sf "$src" "$NOJQ_BIN/$tool"
done
out=$(payload tool_name=Write session_id="$SESSION" agent_id=- agent_type=- \
  | env -u WORKBENCH_ORCHESTRATOR HOME="$FAKE_HOME" \
        WORKBENCH_ORCHESTRATOR_STATE_DIR="$STATE_DIR" PATH="$NOJQ_BIN" bash "$GATE")
check "jq missing" "$out" silent

echo "the deny payload is byte-exact:"
DENY_OUT=$(payload tool_name=Write session_id="$SESSION" agent_id=- agent_type=- | gate)
if [ "$DENY_OUT" = "$EXPECTED_DENY" ]; then
  PASS=$((PASS + 1)); echo "  ✅ deny JSON matches byte for byte"
else
  FAIL=$((FAIL + 1)); echo "  ❌ deny JSON drifted"
  echo "     want: $EXPECTED_DENY"
  echo "     got:  $DENY_OUT"
fi
if printf '%s' "$DENY_OUT" | jq -e . >/dev/null 2>&1; then
  PASS=$((PASS + 1)); echo "  ✅ deny JSON parses"
else
  FAIL=$((FAIL + 1)); echo "  ❌ deny JSON does not parse"
fi
assert_contains "reason names the behaviour" "$DENY_OUT" "orchestrates and does not edit files"
assert_contains "reason names the destination" "$DENY_OUT" "Dispatch a sub-agent with the Agent tool"
assert_contains "reason names the toggle" "$DENY_OUT" "/workbench-core:orchestrator off"

echo "the deny reason names a dev-team plugin only when one is installed:"
# A runtime directory probe, not a build-time dependency. Core ships the same
# script either way; only the home directory it reads differs between these two
# cases, which is what makes the pair discriminating.
out=$(payload tool_name=Write session_id="$SESSION" agent_id=- agent_type=- \
  | env -u WORKBENCH_ORCHESTRATOR HOME="$DEVTEAM_HOME" \
        WORKBENCH_ORCHESTRATOR_STATE_DIR="$STATE_DIR" bash "$GATE")
check "still denies with the plugin installed" "$out" deny
assert_contains "names Watson when the plugin cache is present" "$out" "$DEVTEAM_LINE"
assert_missing "stays generic when the plugin cache is absent" "$DENY_OUT" "$DEVTEAM_LINE"

# Registration is part of the behaviour: a gate nothing calls gates nothing.
echo "the hook is registered in hooks.json:"
assert_jq "matcher covers exactly the three file-writing tools" "$HOOKS_JSON" \
  '[.hooks.PreToolUse[] | select(.hooks[].command | test("delegation-gate.sh")) | .matcher] | join(",")' \
  "Edit|Write|NotebookEdit"
assert_jq "registered exactly once" "$HOOKS_JSON" \
  '[.hooks.PreToolUse[].hooks[] | select(.command | test("delegation-gate.sh"))] | length' "1"
assert_jq "no if condition narrows it" "$HOOKS_JSON" \
  '[.hooks.PreToolUse[] | select(.hooks[].command | test("delegation-gate.sh")) | .if // empty] | length' "0"

# The harness expands ${CLAUDE_PLUGIN_ROOT} into a shell command line, and an
# unquoted expansion word-splits on a plugin path containing a space (the norm
# under ".../Application Support/Claude/..."). The script is then never found
# and the gate silently fails open.
CMD_TEMPLATE="$(jq -r '
  [.hooks.PreToolUse[] | select(.hooks[].command | test("delegation-gate.sh")) | .hooks[].command][0] // ""
' "$HOOKS_JSON")"
SPACED_ROOT="$SANDBOX/plugin root"  # deliberate space
mkdir -p "$SPACED_ROOT/hooks"
cp "$GATE" "$SPACED_ROOT/hooks/delegation-gate.sh"
out=$(payload tool_name=Write session_id="$SESSION" agent_id=- agent_type=- \
  | env -u WORKBENCH_ORCHESTRATOR HOME="$FAKE_HOME" \
        WORKBENCH_ORCHESTRATOR_STATE_DIR="$STATE_DIR" \
        CLAUDE_PLUGIN_ROOT="$SPACED_ROOT" sh -c "${CMD_TEMPLATE:-false}")
check "gate fires when the plugin path contains a space" "$out" deny

echo "the toggle skill agrees with the gate:"
# The skill writes the file the gate reads. If either side renames the env var
# or the default directory, the toggle stops working and nothing else notices.
for token in "WORKBENCH_ORCHESTRATOR_STATE_DIR" ".claude-workbench/orchestrator-mode"; do
  assert_grep "skill uses $token" "$token" "$SKILL"
  assert_grep "gate uses $token"  "$token" "$GATE"
done
# The toggle keys its filename by $CLAUDE_CODE_SESSION_ID; the gate keys its
# lookup by the payload's .session_id. The two are equal (verified live), and
# each side must keep using its own name for that key.
assert_grep "skill keys the file by \$CLAUDE_CODE_SESSION_ID" 'CLAUDE_CODE_SESSION_ID' "$SKILL"
assert_grep "gate keys the lookup by .session_id"             '.session_id'            "$GATE"
assert_grep "skill prunes state files after 7 days"           '-mtime +7'              "$SKILL"

echo "guardrail 10 agrees with the gate:"
# guardrails.md is injected at session start, so a guardrail that contradicts an
# enforced hook is worse than no guardrail: the agent follows it into a deny.
# Guardrail 10 used to end with "a single Edit to a known string — do it inline",
# which is exactly the call the gate now refuses.
GUARDRAILS="$HOOKS_DIR/../references/guardrails.md"
assert_grep "guardrail 10 names the enforcing hook" 'hooks/delegation-gate.sh' "$GUARDRAILS"
assert_missing "guardrail 10 no longer allows an inline Edit" \
  "$(cat "$GUARDRAILS")" '✅ A single `Edit`'

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
