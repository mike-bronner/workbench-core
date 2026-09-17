#!/bin/bash
# Tests for hooks/peer-message-gate.sh — the PreToolUse gate that stops a
# sub-agent from messaging anything except its own orchestrator or its own
# children.
# Run directly: ./test-peer-message-gate.sh
#
# Each case feeds one synthetic PreToolUse payload on stdin and asserts one of
# three verdicts: deny (permissionDecision "deny"), hint (additionalContext and
# NO permissionDecision), or silent (no output at all). Pure stdin/stdout checks
# — no network, no server, and no message is ever sent to anything.
#
# The suite is weighted towards two things the gate gets wrong at a cost.
#
# Every ALLOW branch is covered independently, because a gate that refuses a
# legitimate send is a gate that gets removed. The top-level caller, the send to
# `main`, and each fail-open path have their own case.
#
# Every DENY branch is covered by the FORM of the destination rather than by one
# example, because the deny is the default and the peer-session form it mainly
# protects against was never measured. Uppercase hex, short hex, hex with a
# separator, and a non-string destination each get a case, so "anything nobody
# measured is refused" is asserted rather than assumed.

set -u
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
GATE="$HOOKS_DIR/peer-message-gate.sh"
HOOKS_JSON="$HOOKS_DIR/hooks.json"
SKILL="$HOOKS_DIR/../skills/cross-session-messaging/SKILL.md"
README="$HOOKS_DIR/../README.md"
PASS=0
FAIL=0

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/peer-message-gate.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT

# ---------------------------------------------------------------------------
# Fixtures. Every value below is a measured one where a measurement exists.
# ---------------------------------------------------------------------------

# The agent id captured live on Claude Code 2.1.274: lowercase hex, 17 chars.
AGENT_ID="a5a2f4470341f9233"
# The sibling id from the same capture round, the send that succeeded and
# resumed an agent the sender had not spawned.
SIBLING_ID="a04bd69e4c1a8f273"
# A sub-agent's own id. Any value: the gate reads presence, never the value.
CALLER_ID="7f31c0de9b4a2e615"
# The two forms a peer session appears as in ListAgents. INFERRED, not measured:
# a peer send was forbidden, so no capture exists. These are the shapes the
# fourth branch has to refuse.
PEER_PLAIN="herdr-b5"
PEER_TAGGED="herdr-b5 [72839a]"
# The 74-character body from the measured send, and the unrelated 50-character
# string the doubled `content` field carried alongside it. Present in the
# payloads so the suite proves the gate ignores both.
BODY="Your bin/build shim drops \$TERM under a Herdr startup command."
OTHER_BODY="unrelated fifty character string measured in content"

# Builds a SendMessage payload from key=value pairs. A value of - omits the key
# entirely, which is how a top-level caller is expressed: agent_id is ABSENT,
# not empty. Verified against a live logging hook.
payload() {
  local obj='{"hook_event_name":"PreToolUse","tool_name":"SendMessage"}' arg k v
  for arg in "$@"; do
    k="${arg%%=*}"
    v="${arg#*=}"
    [ "$v" = "-" ] && continue
    case "$k" in
      to | recipient | message | content | summary)
        obj=$(printf '%s' "$obj" | jq -c --arg k "$k" --arg v "$v" '.tool_input[$k] = $v') ;;
      *)
        obj=$(printf '%s' "$obj" | jq -c --arg k "$k" --arg v "$v" '.[$k] = $v') ;;
    esac
  done
  printf '%s' "$obj"
}

# A sub-agent: agent_id AND agent_type both present. The only gated caller.
sub_payload() { payload agent_id="$CALLER_ID" agent_type=general-purpose "$@"; }
# A human's session: neither field present.
main_payload() { payload agent_id=- agent_type=- "$@"; }
# A top-level `claude -p --agent <name>` run: agent_type present, agent_id ABSENT.
agent_payload() { payload agent_id=- agent_type=watson "$@"; }

gate() { bash "$GATE"; }

verdict_of() {
  if printf '%s' "$1" | grep -q '"permissionDecision":"deny"'; then
    printf 'deny'
  elif printf '%s' "$1" | grep -q '"additionalContext"'; then
    printf 'hint'
  elif [ -z "${1//[[:space:]]/}" ]; then
    # Safe here for the reason test-agent-dispatch-gate.sh gives: the subject is
    # the gate's own short jq object or the empty string, never untrusted text,
    # so the C library's idea of "space" cannot change the answer.
    printf 'silent'
  else
    printf 'other'
  fi
}

check() {
  local desc="$1" output="$2" expect="$3" got
  got="$(verdict_of "$output")"
  if [ "$got" = "$expect" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected $expect, got $got"
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
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — unexpectedly contains: $needle"
  else
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  fi
}

assert_grep() {
  local desc="$1" pattern="$2" file="$3"
  if grep -qF -- "$pattern" "$file" 2>/dev/null; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — not found in $(basename "$file"): $pattern"
  fi
}

assert_eq() {
  local desc="$1" actual="$2" expected="$3"
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected [$expected], got [$actual]"
  fi
}

# Asserts a case is silent AND says nothing on stderr. Failing open loudly is
# still a bug: the call is allowed, but with bash noise the model has to read.
check_quiet() {
  local desc="$1" payload="$2" err out
  err="$SANDBOX/stderr.$$"
  out=$(printf '%s' "$payload" | bash "$GATE" 2>"$err")
  check "$desc" "$out" silent
  if [ -s "$err" ]; then
    FAIL=$((FAIL + 1)); echo "  ❌ ...and it failed open noisily: $(head -1 "$err")"
  else
    PASS=$((PASS + 1)); echo "  ✅ ...and it does so silently, with no bash error"
  fi
  rm -f "$err"
}

echo "🧪 Testing peer-message-gate.sh"
echo

# ---------------------------------------------------------------------------
echo "branch 1 — a top-level caller sends anywhere:"
# The human's own session is never gated. This is why the gate needs no escape
# hatch: there is nothing here for a toggle to stand down.
check "a human's session reaching a peer by name" \
  "$(main_payload to="$PEER_PLAIN" message="$BODY" | gate)" silent
check "a human's session reaching the tagged peer form" \
  "$(main_payload to="$PEER_TAGGED" message="$BODY" | gate)" silent
check "a human's session reaching an agent by id" \
  "$(main_payload to="$AGENT_ID" recipient="$AGENT_ID" message="$BODY" | gate)" silent
check "a human's session sending to main" \
  "$(main_payload to=main message="$BODY" | gate)" silent
# Mike's decision 4, against the recommendation: a pipeline agent launched by
# `claude -p --agent` is top-level and may send. It carries agent_type but NO
# agent_id, so it lands on the allow side of the one test the gate makes.
check "a top-level claude -p --agent run reaching a peer" \
  "$(agent_payload to="$PEER_PLAIN" message="$BODY" | gate)" silent
check "a top-level claude -p --agent run reaching a peer, tagged form" \
  "$(agent_payload to="$PEER_TAGGED" message="$BODY" | gate)" silent

echo
echo "branch 2 — a sub-agent sends up to its orchestrator:"
# `to: "main"` passes through as the literal string `main`, unrewritten. Measured.
check "to: main" "$(sub_payload to=main message="$BODY" | gate)" silent
check "to and recipient both main" \
  "$(sub_payload to=main recipient=main message="$BODY" content="$OTHER_BODY" | gate)" silent
check "recipient: main with no to field at all" \
  "$(sub_payload recipient=main message="$BODY" | gate)" silent

echo
echo "branch 3 — a sub-agent sends to an agent id, allowed WITH an advisory:"
# The down direction cannot be enforced: no spawner identity is recorded
# anywhere, so the gate cannot tell a child from a sibling and says so instead.
check "to: an agent id" "$(sub_payload to="$AGENT_ID" message="$BODY" | gate)" hint
check "to and recipient both the same agent id" \
  "$(sub_payload to="$AGENT_ID" recipient="$AGENT_ID" message="$BODY" | gate)" hint
# The measured sibling send — the one the harness allowed and which resumed an
# agent the sender never spawned. The gate cannot deny it; it must warn.
check "to: a sibling's id, which the harness itself allows" \
  "$(sub_payload to="$SIBLING_ID" message="$BODY" | gate)" hint
# Both halves are allowed classes, so the stricter of the two wins and the
# advisory covers the pair.
check "to: main beside recipient: an agent id" \
  "$(sub_payload to=main recipient="$AGENT_ID" message="$BODY" | gate)" hint

ADVISORY=$(sub_payload to="$AGENT_ID" message="$BODY" | gate)
assert_contains "the advisory asks the question only the model can answer" \
  "$ADVISORY" "If you did not spawn this agent"
assert_contains "the advisory says plainly that nothing was blocked" \
  "$ADVISORY" "nothing was blocked"
assert_contains "the advisory names the skill that carries the protocol" \
  "$ADVISORY" "/workbench-core:cross-session-messaging"
# Load-bearing, not cosmetic: the harness only touches permission behaviour when
# permissionDecision is present, so the advisory must not carry one. With it,
# the note would silently GRANT a permission the send would otherwise have had
# to ask for.
assert_missing "the advisory grants no permission" "$ADVISORY" '"permissionDecision"'
assert_eq "the advisory names the hook event" \
  "$(printf '%s' "$ADVISORY" | jq -r '.hookSpecificOutput.hookEventName')" "PreToolUse"

echo
echo "branch 4 — a sub-agent sends anywhere else, DENIED:"
check "to: a peer session by name" \
  "$(sub_payload to="$PEER_PLAIN" message="$BODY" | gate)" deny
check "to: a peer session in its tagged form" \
  "$(sub_payload to="$PEER_TAGGED" message="$BODY" | gate)" deny
check "recipient: a peer session, with no to field at all" \
  "$(sub_payload recipient="$PEER_PLAIN" message="$BODY" | gate)" deny

DENY=$(sub_payload to="$PEER_PLAIN" message="$BODY" | gate)
assert_contains "the deny states the rule it enforces" \
  "$DENY" "its own orchestrator and its own children"
# One marker per verdict, matching agent-dispatch-gate.sh: 🚦 refuses, and the
# advisory wears something else. Sharing a banner across a deny and an allow is
# how a note gets read as a refusal.
assert_contains "the deny wears the refusal banner" "$DENY" "🚦 Peer message gate"
assert_missing "the advisory does not wear the refusal banner" "$ADVISORY" "🚦"
assert_contains "the deny names the destination that would have worked" "$DENY" '\"main\"'
assert_contains "the deny names the skill that carries the protocol" \
  "$DENY" "/workbench-core:cross-session-messaging"
assert_eq "the deny names the hook event" \
  "$(printf '%s' "$DENY" | jq -r '.hookSpecificOutput.hookEventName')" "PreToolUse"

echo
echo "the deny is the DEFAULT, so every unmeasured destination form lands in it:"
# Each of these is a form nobody has captured. The inference behind branch 4 is
# that a peer destination does not look like an agent id; these assert that the
# gate refuses rather than admits whenever it is outside what WAS measured.
check "uppercase hex is not the measured id form" \
  "$(sub_payload to="A5A2F4470341F9233" message="$BODY" | gate)" deny
check "hex shorter than the 16-character floor" \
  "$(sub_payload to="a5a2f44" message="$BODY" | gate)" deny
check "hex carrying a separator, UUID-shaped" \
  "$(sub_payload to="a5a2f447-0341-f923-3ab1-c0de91827364" message="$BODY" | gate)" deny
check "hex-ish but with a letter outside a-f" \
  "$(sub_payload to="a5a2f4470341z9233" message="$BODY" | gate)" deny
check "Main, capitalised, is not the measured literal" \
  "$(sub_payload to="Main" message="$BODY" | gate)" deny
check "main with surrounding whitespace is not the measured literal" \
  "$(sub_payload to=" main " message="$BODY" | gate)" deny
# Oniguruma's `$` matches before a trailing newline exactly as Perl's does, so a
# regex-anchored id test would have admitted this. The codepoint test does not.
check "an agent id with a trailing newline" \
  "$(printf '%s' '{"hook_event_name":"PreToolUse","tool_name":"SendMessage","agent_id":"c0de","agent_type":"general-purpose","tool_input":{"to":"a5a2f4470341f9233\n"}}' | gate)" deny
check "a numeric destination" \
  "$(printf '%s' '{"hook_event_name":"PreToolUse","tool_name":"SendMessage","agent_id":"c0de","agent_type":"general-purpose","tool_input":{"to":42}}' | gate)" deny
check "an object destination" \
  "$(printf '%s' '{"hook_event_name":"PreToolUse","tool_name":"SendMessage","agent_id":"c0de","agent_type":"general-purpose","tool_input":{"to":{"id":"a5a2f4470341f9233"}}}' | gate)" deny

echo
echo "BOTH destination fields are read, because the measured pair can disagree:"
# tool_input carries doubled fields. In the one measured send `to` and
# `recipient` agreed, but `message` and `content` did NOT, so the pairs are not
# guaranteed to agree and a gate reading only `to` would be checking a field the
# harness might not honour. The strictest verdict across the present values wins.
check "to: main is not enough when recipient names a peer" \
  "$(sub_payload to=main recipient="$PEER_PLAIN" message="$BODY" | gate)" deny
check "an agent id in to is not enough when recipient names a peer" \
  "$(sub_payload to="$AGENT_ID" recipient="$PEER_PLAIN" message="$BODY" | gate)" deny
check "a peer in to is still denied when recipient reads main" \
  "$(sub_payload to="$PEER_PLAIN" recipient=main message="$BODY" | gate)" deny

echo
echo "the body is never read, so no body can change a verdict:"
# The gate checks structure only. Three prompt-classifying heuristics were built
# for agent-dispatch-gate.sh, measured against real traffic, and dropped: 83%
# precision at 26% recall against 34% at 84%, with the wrong answers not tunable
# away. Judging a stated reason belongs to the model, not to this file.
check "a denied send stays denied however well its reason reads" \
  "$(sub_payload to="$PEER_PLAIN" message="$BODY" content="$OTHER_BODY" \
    summary="Shared bin/build shim drops TERM" | gate)" deny
check "an allowed send stays allowed with no body at all" \
  "$(sub_payload to=main | gate)" silent
check "an allowed send stays allowed with an empty body" \
  "$(sub_payload to=main message="" summary="" | gate)" silent

echo
echo "ListAgents is deliberately not gated, for any caller:"
# PreToolUse fires for it and its tool_input arrives EMPTY, so a rule about it
# could only ever key on the caller. Listing peers is read-only, the send is
# where the harm lands, and the send is gated — so the matcher names SendMessage
# alone and this asserts the script agrees even if the matcher ever widens.
check "a sub-agent listing peers" \
  "$(printf '%s' '{"hook_event_name":"PreToolUse","tool_name":"ListAgents","agent_id":"c0de","agent_type":"general-purpose","tool_input":{}}' | gate)" silent
check "a top-level session listing peers" \
  "$(printf '%s' '{"hook_event_name":"PreToolUse","tool_name":"ListAgents","tool_input":{}}' | gate)" silent
check "an unrelated tool from a sub-agent" \
  "$(printf '%s' '{"hook_event_name":"PreToolUse","tool_name":"Read","agent_id":"c0de","agent_type":"general-purpose","tool_input":{"file_path":"/tmp/x"}}' | gate)" silent

echo
echo "it fails open on anything it cannot parse:"
out=$(printf '' | gate)
check "an empty payload" "$out" silent
check_quiet "JSON that is not an object" '["a","json","array"]'
check_quiet "a payload that is not JSON at all" 'not json, just prose'
check_quiet "a truncated JSON object" '{"tool_name":"SendMessage","agent_id":'
# .to on a string errors inside jq, which exits non-zero. A payload shape this
# gate does not understand must allow, never deny.
check_quiet "tool_input that is a string rather than an object" \
  '{"hook_event_name":"PreToolUse","tool_name":"SendMessage","agent_id":"c0de","tool_input":"oops"}'
check_quiet "tool_input that is an array" \
  '{"hook_event_name":"PreToolUse","tool_name":"SendMessage","agent_id":"c0de","tool_input":["a"]}'
check_quiet "a send carrying no destination field at all" \
  '{"hook_event_name":"PreToolUse","tool_name":"SendMessage","agent_id":"c0de","agent_type":"general-purpose","tool_input":{"message":"hello"}}'
check_quiet "a destination that is the empty string" \
  '{"hook_event_name":"PreToolUse","tool_name":"SendMessage","agent_id":"c0de","agent_type":"general-purpose","tool_input":{"to":"","recipient":""}}'
check_quiet "a null destination" \
  '{"hook_event_name":"PreToolUse","tool_name":"SendMessage","agent_id":"c0de","agent_type":"general-purpose","tool_input":{"to":null}}'
check_quiet "tool_input absent entirely" \
  '{"hook_event_name":"PreToolUse","tool_name":"SendMessage","agent_id":"c0de","agent_type":"general-purpose"}'

# jq is the only hard dependency. Without it the gate must allow, never deny.
NOJQ_BIN="$SANDBOX/nojq-bin"
mkdir -p "$NOJQ_BIN"
for tool in bash cat grep sed; do
  src="$(command -v "$tool" 2>/dev/null)" && ln -sf "$src" "$NOJQ_BIN/$tool"
done
out=$(sub_payload to="$PEER_PLAIN" message="$BODY" | env PATH="$NOJQ_BIN" bash "$GATE")
check "jq missing" "$out" silent
# ...and the same payload through the same gate WITH jq still denies, so the
# case above is not passing because the fixture is broken.
check "the same payload with jq present still denies" \
  "$(sub_payload to="$PEER_PLAIN" message="$BODY" | gate)" deny

echo
echo "the gate carries no raw separator byte:"
# The US byte the record is joined on is written as the jq escape \u001f, never
# as a literal 0x1f in the source. A raw control character survives an editor
# round-trip badly and is invisible in review.
if LC_ALL=C grep -q "$(printf '\037')" "$GATE"; then
  FAIL=$((FAIL + 1)); echo "  ❌ the gate holds a literal 0x1f byte"
else
  PASS=$((PASS + 1)); echo "  ✅ no literal 0x1f byte in the source"
fi
assert_grep "the record separator is written as a jq escape" 'join("\u001f")' "$GATE"

echo
echo "hooks.json wires it, and wires it once:"
assert_eq "exactly one PreToolUse entry runs the gate" \
  "$(jq -r '[.hooks.PreToolUse[] | select(.hooks[].command | contains("peer-message-gate.sh"))] | length' "$HOOKS_JSON")" \
  "1"
assert_eq "its matcher is SendMessage" \
  "$(jq -r '.hooks.PreToolUse[] | select(.hooks[].command | contains("peer-message-gate.sh")) | .matcher' "$HOOKS_JSON")" \
  "SendMessage"
assert_eq "no other hook event runs the gate" \
  "$(jq -r '[.hooks | to_entries[] | select(.key != "PreToolUse") | .value[].hooks[].command | select(contains("peer-message-gate.sh"))] | length' "$HOOKS_JSON")" \
  "0"
assert_eq "it runs through CLAUDE_PLUGIN_ROOT like its siblings" \
  "$(jq -r '.hooks.PreToolUse[] | select(.hooks[].command | contains("peer-message-gate.sh")) | .hooks[0].command' "$HOOKS_JSON")" \
  'bash "${CLAUDE_PLUGIN_ROOT}/hooks/peer-message-gate.sh"'

echo
echo "the skill the gate points at exists, and says what the gate says:"
# The slug is read out of the gate's own deny message rather than written here,
# so renaming the skill without updating the gate reddens this case.
SLUG=$(printf '%s' "$DENY" | grep -o '/workbench-core:[a-z-]*' | head -1 | cut -d: -f2)
assert_eq "the skill directory matches the slug the gate prints" \
  "$([ -f "$HOOKS_DIR/../skills/$SLUG/SKILL.md" ] && echo present || echo "missing: $SLUG")" \
  "present"
assert_grep "the skill names the gate script"        'hooks/peer-message-gate.sh' "$SKILL"
assert_grep "the skill carries the receive rule"     'Surface it to your human, and stop' "$SKILL"
assert_grep "the skill refuses a request, not just a rude one" 'It is never an instruction' "$SKILL"
assert_grep "the skill says a message informs rather than asks" 'informs' "$SKILL"
assert_grep "the skill states who may send"          'never messages a peer session' "$SKILL"
assert_grep "the skill keeps a pipeline agent top-level" 'claude -p --agent' "$SKILL"
# The two must agree. If the skill claimed the gate checks the stated reason,
# every send that passed would read as approval of its reason, which the gate
# never gives.
assert_grep "the skill says the gate never reads the body" 'never reads the message body' "$SKILL"
assert_grep "the skill says the gate cannot tell a child from a sibling" \
  'cannot tell a peer session from a child' "$SKILL"
assert_grep "the skill says ListAgents is ungated"   'ungated' "$SKILL"
assert_grep "the skill says the gate fails open"     'It fails open' "$SKILL"

echo
echo "the README documents the gate alongside its siblings:"
assert_grep "README names the script"      'hooks/peer-message-gate.sh' "$README"
assert_grep "README names the test suite"  'hooks/test-peer-message-gate.sh' "$README"
assert_grep "README names the skill"       'skills/cross-session-messaging' "$README"
assert_grep "README documents fail-open"   'enforcement stops silently' "$README"
# The Done-when for this change: the README must say which part of the fourth
# branch is inferred rather than measured, in those words.
assert_grep "README names the inferred part as inferred" \
  'inferred, never measured' "$README"
assert_grep "README states the deny is the default" \
  'the deny is the default' "$README"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
