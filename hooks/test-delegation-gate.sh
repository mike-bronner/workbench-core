#!/bin/bash
# Tests for hooks/delegation-gate.sh — the PreToolUse orchestrator delegation
# gate. Run directly: ./test-delegation-gate.sh
# Each case feeds one synthetic PreToolUse payload on stdin and asserts one of
# three verdicts: remind (additionalContext and no permission verdict), silent
# (no output), or deny (permissionDecision "deny"). The gate is advisory since
# 2026-10-05, so no case expects deny, and the verdict exists so a deny that
# comes back turns cases red. Pure stdin/stdout checks — no network, no server,
# nothing written to the real home directory.
#
# Silent branches (a)-(f) from the script header are each covered
# independently, so no one branch can mask another.

set -u
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
GATE="$HOOKS_DIR/delegation-gate.sh"
HOOKS_JSON="$HOOKS_DIR/hooks.json"
TOGGLE="$HOOKS_DIR/mods/orchestrator.ts"  # /orchestrator, in hooks/register.ts
MODULE="$HOOKS_DIR/register.ts"
PASS=0
FAIL=0

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/delegation-gate.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT

# Every piece of external state this gate reads or writes is isolated. The
# state dir is overridden so the human's real toggle never decides this suite's
# verdicts, and HOME is faked so the reminder's dev-team probe reads a directory
# we control and the once-per-session marker lands in the sandbox.
STATE_DIR="$SANDBOX/state"
FAKE_HOME="$SANDBOX/home"            # no plugin cache: the plain reminder
DEVTEAM_HOME="$SANDBOX/home-devteam"  # plugin cache present: enriched reminder
mkdir -p "$STATE_DIR" "$FAKE_HOME" \
  "$DEVTEAM_HOME/.claude/plugins/cache/claude-workbench/workbench-dev-team"
MARK_DIR="$FAKE_HOME/.claude-workbench/delegation-reminder"

SESSION="b94bbff5-0f68-4c1c-b3ec-3a899d30bc05"

# The exact bytes the gate must emit on a reminder with no dev-team plugin
# present. Asserted verbatim below: the harness parses this, and a stray space
# or a reordered key is a silent break. There is no permissionDecision key at
# all: an "allow" would skip the permission prompt, and a "deny" would block.
EXPECTED_REMIND='{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"Delegation reminder (workbench-core, advisory, this write goes ahead). The main conversation orchestrates, and its context stays lean when whole-file work goes to a sub-agent dispatched with the Agent tool. Use Edit for a partial change. This reminder shows once per session."}}'
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
# gate() clears the once-per-session marker first, so each case is judged on
# its own branch and not on whether an earlier case already drew the reminder.
# gate_keep() leaves the marker, for the cases that test the once-only rule.
gate_keep() {
  env -u WORKBENCH_ORCHESTRATOR HOME="$FAKE_HOME" \
    WORKBENCH_ORCHESTRATOR_STATE_DIR="$STATE_DIR" bash "$GATE"
}
reset_marks() {
  rm -rf "$MARK_DIR" "$SANDBOX"/*/.claude-workbench/delegation-reminder
}
gate() {
  reset_marks
  gate_keep
}

check() {
  local desc="$1" output="$2" expect="$3" verdict
  if printf '%s' "$output" | grep -q '"permissionDecision":"deny"'; then
    verdict=deny
  elif printf '%s' "$output" | grep -q '"additionalContext"'; then
    verdict=remind
  elif [ -z "$output" ]; then
    verdict=silent
  else
    verdict=other
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

echo "the reminder path (main agent, gate on):"
run_case "main agent Write"        remind tool_name=Write        session_id="$SESSION" agent_id=- agent_type=-
run_case "main agent NotebookEdit" remind tool_name=NotebookEdit session_id="$SESSION" agent_id=- agent_type=-

echo "Edit is allowed from the main agent (a one-line change costs ~200 tokens inline):"
run_case "main agent Edit"         silent tool_name=Edit       session_id="$SESSION" agent_id=- agent_type=-
out=$(jq -cn --arg s "$SESSION" \
  '{hook_event_name: "PreToolUse", tool_name: "Edit", session_id: $s,
    tool_input: {file_path: "/etc/hosts"}}' | gate)
check "main agent Edit outside every scratch root" "$out" silent

echo "(a) sub-agent calls are silent:"
run_case "Task sub-agent (agent_id + agent_type)" silent \
  tool_name=Write session_id="$SESSION" agent_id=a79d47fc851cc123f agent_type=general-purpose
run_case "agent_id alone is still silent" silent \
  tool_name=Write session_id="$SESSION" agent_id=a79d47fc851cc123f agent_type=-

echo "(b) top-level --agent dispatch is silent:"
run_case "claude -p --agent (agent_type, NO agent_id)" silent \
  tool_name=Write session_id="$SESSION" agent_id=- agent_type=workbench-dev-team:watson
# Field-separator pin. Present-but-empty agent_id/agent_type is the shape that
# breaks under an @tsv join: bash collapses runs of IFS whitespace, so a tab
# record with empty leading fields shifts tool_name into agent_id's slot and the
# gate allows everything. US (0x1f) is not IFS whitespace, so the empties
# survive. Swap the join for a tab and this case goes green-to-silent.
run_case "empty agent_id does not count as a sub-agent" remind \
  tool_name=Write session_id="$SESSION" agent_id= agent_type=

echo "(c) the environment silencer:"
reset_marks
out=$(payload tool_name=Write session_id="$SESSION" agent_id=- agent_type=- \
  | env HOME="$FAKE_HOME" WORKBENCH_ORCHESTRATOR_STATE_DIR="$STATE_DIR" \
        WORKBENCH_ORCHESTRATOR=0 bash "$GATE")
check "WORKBENCH_ORCHESTRATOR=0 silences" "$out" silent
# Only the literal 0 opts out. Any other value, including a truthy-looking one,
# leaves the gate armed — this is what stops `=1` reading as "on, so allow".
reset_marks
out=$(payload tool_name=Write session_id="$SESSION" agent_id=- agent_type=- \
  | env HOME="$FAKE_HOME" WORKBENCH_ORCHESTRATOR_STATE_DIR="$STATE_DIR" \
        WORKBENCH_ORCHESTRATOR=1 bash "$GATE")
check "WORKBENCH_ORCHESTRATOR=1 does NOT silence" "$out" remind

echo "(d) the session toggle:"
run_case "no state file -> gate is ON by default" remind tool_name=Write session_id="$SESSION" agent_id=- agent_type=-
touch "$STATE_DIR/$SESSION"
run_case "state file for this session silences" silent tool_name=Write session_id="$SESSION" agent_id=- agent_type=-
run_case "state file for ANOTHER session does not silence" remind \
  tool_name=Write session_id=11111111-2222-3333-4444-555555555555 agent_id=- agent_type=-
rm -f "$STATE_DIR/$SESSION"
run_case "removing the state file re-enables the gate" remind tool_name=Write session_id="$SESSION" agent_id=- agent_type=-
# Off is a regular file that is not a link. A directory or a link planted at the
# path, which `[ -e ]` once read as off, switches nothing off.
mkdir "$STATE_DIR/$SESSION"
run_case "a directory planted at the path does not silence it" remind tool_name=Write session_id="$SESSION" agent_id=- agent_type=-
rmdir "$STATE_DIR/$SESSION"
: >"$SANDBOX/real-file"
ln -s "$SANDBOX/real-file" "$STATE_DIR/$SESSION"
run_case "a link to a regular file does not silence it" remind tool_name=Write session_id="$SESSION" agent_id=- agent_type=-
rm -f "$STATE_DIR/$SESSION"

# An unset override must fall back to the documented default under $HOME, and a
# fresh fake HOME has no state file there — so the gate still reminds. This is
# what proves the default path is a real lookup, not a silent allow.
DEFAULT_HOME="$SANDBOX/default-home"
mkdir -p "$DEFAULT_HOME"
out=$(payload tool_name=Write session_id="$SESSION" agent_id=- agent_type=- \
  | env -u WORKBENCH_ORCHESTRATOR -u WORKBENCH_ORCHESTRATOR_STATE_DIR \
        HOME="$DEFAULT_HOME" bash "$GATE")
check "unset state dir falls back to \$HOME and still reminds" "$out" remind

# ...and the fallback resolves to the documented path, not somewhere else.
mkdir -p "$DEFAULT_HOME/.claude-workbench/orchestrator-mode"
touch "$DEFAULT_HOME/.claude-workbench/orchestrator-mode/$SESSION"
reset_marks
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
# class and this case still reads silent, so it is paired with the remind case
# above — together they pin refusal rather than mere absence.
mkdir -p "$SANDBOX/escape"
touch "$SANDBOX/escape/planted"
out=$(payload tool_name=Write session_id="../escape/planted" agent_id=- agent_type=- | gate)
check "a planted file outside the state dir is never consulted" "$out" silent

echo "(e) out-of-scope tools:"
run_case "Bash"              silent tool_name=Bash session_id="$SESSION" agent_id=- agent_type=-
run_case "Read"              silent tool_name=Read session_id="$SESSION" agent_id=- agent_type=-
run_case "missing tool_name" silent tool_name=-    session_id="$SESSION" agent_id=- agent_type=-

echo "(f) scratch files and plans draw no reminder:"
# A session scratchpad of the real shape, found by session id under
# /tmp/claude-*/. The gate refuses one with a symlink at any level, so the
# sibling session's pad, a linked pad, and a link inside a real pad are built
# beside it to prove each is refused rather than followed.
SCRATCH_TREE="/tmp/claude-dgate-test-$$"
SCRATCH_SID="dgate-$$-aaaa"
PAD="$SCRATCH_TREE/-fake-project/$SCRATCH_SID/scratchpad"
OTHER_PAD="$SCRATCH_TREE/-fake-project/dgate-$$-bbbb/scratchpad"
LINK_SID="dgate-$$-link"
mkdir -p "$PAD/sub" "$OTHER_PAD" "$SANDBOX/outside" "$SCRATCH_TREE/-fake-project/$LINK_SID"
ln -s "$SANDBOX/outside" "$SCRATCH_TREE/-fake-project/$LINK_SID/scratchpad"
ln -s "$SANDBOX/outside" "$PAD/escape"
ln -s "$SANDBOX/outside/target.txt" "$PAD/linked-file.txt"
trap 'rm -rf "$SANDBOX" "$SCRATCH_TREE"' EXIT

# write_case <description> <expect> <tool> <file_path> [session_id]
write_case() {
  local out
  out=$(jq -nc --arg t "$3" --arg f "$4" --arg s "${5:-$SCRATCH_SID}" \
    '{hook_event_name: "PreToolUse", tool_name: $t, session_id: $s,
      tool_input: {file_path: $f}}' | gate)
  check "$1" "$out" "$2"
}

write_case "Write a commit message in the session scratchpad" silent Write "$PAD/commit-msg.txt"
write_case "Edit a file in the session scratchpad"            silent Edit  "$PAD/pr-body.md"
write_case "Write into a subfolder not made yet"               silent Write "$PAD/new/deeper/x.md"
if [ /private/tmp -ef /tmp ]; then
  write_case "the pad by its /private spelling"                silent Write "/private$PAD/msg.txt"
fi
# NotebookEdit names its target `notebook_path`, never `file_path`, so only the
# fallback in the gate's extraction can find it.
out=$(jq -nc --arg f "$PAD/scratch.ipynb" --arg s "$SCRATCH_SID" \
  '{hook_event_name: "PreToolUse", tool_name: "NotebookEdit", session_id: $s,
    tool_input: {notebook_path: $f}}' | gate)
check "NotebookEdit with only notebook_path in the pad" "$out" silent
write_case "a project file draws the reminder"                remind   Write "$SANDBOX/project/file.txt"
write_case "the scratchpad folder itself is not a file in it" remind   Write "$PAD"
write_case "another session's scratchpad"                     remind   Write "$OTHER_PAD/msg.txt"
write_case "a scratchpad that is a symlink out"               remind   Write "$SCRATCH_TREE/-fake-project/$LINK_SID/scratchpad/x.txt" "$LINK_SID"
write_case "a symlinked folder inside the pad"                remind   Write "$PAD/escape/x.txt"
write_case "a symlinked file inside the pad"                  remind   Write "$PAD/linked-file.txt"
write_case "climbing out with .."                             remind   Write "$PAD/../../../../outside.txt"
write_case "climbing out of a folder not made yet"            remind   Write "$PAD/never/../../x.txt"
write_case "a relative path"                                  remind   Write "scratchpad/msg.txt"
write_case "no file_path at all"                              remind   Write ""
write_case "a sibling sharing the pad's prefix"               remind   Write "${PAD}-evil/x.txt"

# The login home comes from the password database, so a faked HOME holding a
# Developer/scratchpad must not count. The suite's gate() already runs with
# HOME pointed at the sandbox.
mkdir -p "$FAKE_HOME/Developer/scratchpad"
write_case "a \$HOME-relative scratchpad does not count"      remind   Write "$FAKE_HOME/Developer/scratchpad/x.txt"
# The real one is read, never written: the gate only judges the path.
LOGIN_USER=$(id -un)
eval "LOGIN_HOME=~$LOGIN_USER"
if [ -d "$LOGIN_HOME/Developer/scratchpad" ]; then
  write_case "the login home's Developer/scratchpad"           silent Write "$LOGIN_HOME/Developer/scratchpad/dgate-$$-never-written.txt"
fi
# Plan mode lets the main agent write one file, its plan under ~/.claude/plans/.
# The same login-home rule applies: a faked HOME's plans folder does not count.
mkdir -p "$FAKE_HOME/.claude/plans"
write_case "a \$HOME-relative plans folder does not count"     remind   Write "$FAKE_HOME/.claude/plans/x.md"
if [ -d "$LOGIN_HOME/.claude/plans" ]; then
  write_case "a plan in the login home's .claude/plans"        silent Write "$LOGIN_HOME/.claude/plans/dgate-$$-never-written.md"
  write_case "a plans folder lookalike beside it"              remind Write "$LOGIN_HOME/.claude/plans-evil/x.md"
else
  echo "  ⏭️  skipped: $LOGIN_HOME/.claude/plans does not exist on this machine"
fi
# Plan mode's first write can come before plans/ exists. The real folder cannot
# be removed here, so a copy of the gate looks for a plans folder under a name
# that never exists, and nothing creates it: the gate only judges the path.
if [ -d "$LOGIN_HOME/.claude" ]; then
  MISSING="dgate-$$-plans"
  [ ! -e "$LOGIN_HOME/.claude/$MISSING" ] || echo "  ⚠️  $LOGIN_HOME/.claude/$MISSING exists, so the next case proves less"
  # The plans root is resolved in the lib the gate sources from beside itself,
  # so the copy gets a lib of its own with the same rename.
  mkdir -p "$SANDBOX/lib"
  sed "s#/plans#/$MISSING#g" "$HOOKS_DIR/lib/scratch-roots.sh" >"$SANDBOX/lib/scratch-roots.sh"
  cp "$GATE" "$SANDBOX/missing-plans-gate.sh"
  out=$(jq -nc --arg f "$LOGIN_HOME/.claude/$MISSING/first-plan.md" --arg s "$SESSION" \
    '{hook_event_name: "PreToolUse", tool_name: "Write", session_id: $s,
      tool_input: {file_path: $f}}' \
    | { reset_marks; env -u WORKBENCH_ORCHESTRATOR HOME="$FAKE_HOME" \
          WORKBENCH_ORCHESTRATOR_STATE_DIR="$STATE_DIR" bash "$SANDBOX/missing-plans-gate.sh"; })
  check "a plan whose plans folder does not exist yet" "$out" silent
  out=$(jq -nc --arg f "$LOGIN_HOME/.claude/$MISSING-evil/x.md" --arg s "$SESSION" \
    '{hook_event_name: "PreToolUse", tool_name: "Write", session_id: $s,
      tool_input: {file_path: $f}}' \
    | { reset_marks; env -u WORKBENCH_ORCHESTRATOR HOME="$FAKE_HOME" \
          WORKBENCH_ORCHESTRATOR_STATE_DIR="$STATE_DIR" bash "$SANDBOX/missing-plans-gate.sh"; })
  check "a lookalike of the missing plans folder" "$out" remind
else
  echo "  ⏭️  skipped: $LOGIN_HOME/.claude does not exist on this machine"
fi

echo "(g) errors fail open:"
out=$(printf '%s' 'not json at all {{{' | gate)
check "malformed JSON" "$out" silent
out=$(printf '%s' '{"tool_name":"Write","session_id":' | gate)
check "truncated JSON" "$out" silent
out=$(printf '%s' '' | gate)
check "empty payload" "$out" silent
out=$(printf '%s' '["a","json","array"]' | gate)
check "JSON that is not an object" "$out" silent

# jq is the only hard dependency. Without it the gate must stay silent.
NOJQ_BIN="$SANDBOX/nojq-bin"
mkdir -p "$NOJQ_BIN"
for tool in bash cat grep sed; do
  src="$(command -v "$tool" 2>/dev/null)" && ln -sf "$src" "$NOJQ_BIN/$tool"
done
reset_marks
out=$(payload tool_name=Write session_id="$SESSION" agent_id=- agent_type=- \
  | env -u WORKBENCH_ORCHESTRATOR HOME="$FAKE_HOME" \
        WORKBENCH_ORCHESTRATOR_STATE_DIR="$STATE_DIR" PATH="$NOJQ_BIN" bash "$GATE")
check "jq missing" "$out" silent

echo "the reminder payload is byte-exact:"
REMIND_OUT=$(payload tool_name=Write session_id="$SESSION" agent_id=- agent_type=- | gate)
if [ "$REMIND_OUT" = "$EXPECTED_REMIND" ]; then
  PASS=$((PASS + 1)); echo "  ✅ reminder JSON matches byte for byte"
else
  FAIL=$((FAIL + 1)); echo "  ❌ reminder JSON drifted"
  echo "     want: $EXPECTED_REMIND"
  echo "     got:  $REMIND_OUT"
fi
if printf '%s' "$REMIND_OUT" | jq -e . >/dev/null 2>&1; then
  PASS=$((PASS + 1)); echo "  ✅ reminder JSON parses"
else
  FAIL=$((FAIL + 1)); echo "  ❌ reminder JSON does not parse"
fi
# No permission verdict of any kind. "allow" would skip the permission prompt
# the write would otherwise have had, and "deny" would block it. Checked as a
# key, apart from the byte-exact pin, so the reason survives a reworded text.
assert_jq_str() {
  local desc="$1" json="$2" filter="$3" expected="$4" actual
  actual="$(printf '%s' "$json" | jq -r "$filter" 2>/dev/null)"
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected [$expected], got [$actual]"
  fi
}
assert_jq_str "the reminder carries no permissionDecision" "$REMIND_OUT" \
  '.hookSpecificOutput | has("permissionDecision")' "false"
assert_jq_str "the reminder carries no permissionDecisionReason" "$REMIND_OUT" \
  '.hookSpecificOutput | has("permissionDecisionReason")' "false"
REMIND_CONTEXT=$(printf '%s' "$REMIND_OUT" | jq -r '.hookSpecificOutput.additionalContext')
assert_contains "context says the write goes ahead" "$REMIND_CONTEXT" "advisory, this write goes ahead"
assert_contains "context names the destination" "$REMIND_CONTEXT" "a sub-agent dispatched with the Agent tool"
assert_contains "context names Edit as the inline route" "$REMIND_CONTEXT" "Use Edit for a partial change"
assert_contains "context says it shows once" "$REMIND_CONTEXT" "once per session"
# No Markdown emphasis: the model gets the raw source, so asterisks would just
# show up as asterisks. And no leftover refusal wording.
assert_missing "context carries no Markdown emphasis" "$REMIND_CONTEXT" "**"
assert_missing "context does not speak of a deny" "$REMIND_CONTEXT" "deny"
if [ "${#REMIND_CONTEXT}" -le 300 ]; then
  PASS=$((PASS + 1)); echo "  ✅ the reminder stays short (${#REMIND_CONTEXT} chars)"
else
  FAIL=$((FAIL + 1)); echo "  ❌ the reminder grew long (${#REMIND_CONTEXT} chars)"
fi

echo "the reminder names a dev-team plugin only when one is installed:"
# A runtime directory probe, not a build-time dependency. Core ships the same
# script either way; only the home directory it reads differs between these two
# cases, which is what makes the pair discriminating.
reset_marks
out=$(payload tool_name=Write session_id="$SESSION" agent_id=- agent_type=- \
  | env -u WORKBENCH_ORCHESTRATOR HOME="$DEVTEAM_HOME" \
        WORKBENCH_ORCHESTRATOR_STATE_DIR="$STATE_DIR" bash "$GATE")
check "still reminds with the plugin installed" "$out" remind
assert_contains "names Watson when the plugin cache is present" "$out" "$DEVTEAM_LINE"
assert_missing "stays generic when the plugin cache is absent" "$REMIND_OUT" "$DEVTEAM_LINE"

echo "the reminder fires at most once per session:"
reset_marks
out=$(payload tool_name=Write session_id="$SESSION" agent_id=- agent_type=- | gate_keep)
check "the first write of the session is reminded" "$out" remind
out=$(payload tool_name=Write session_id="$SESSION" agent_id=- agent_type=- | gate_keep)
check "the second write of the same session is silent" "$out" silent
out=$(payload tool_name=NotebookEdit session_id="$SESSION" agent_id=- agent_type=- | gate_keep)
check "a NotebookEdit later in the same session is silent" "$out" silent
out=$(payload tool_name=Write session_id=22222222-3333-4444-5555-666666666666 agent_id=- agent_type=- | gate_keep)
check "a different session still gets its own reminder" "$out" remind
# The marker is swept after 3 days like the sibling state dirs, so the
# directory does not grow by one file per session forever.
touch -t 202001010000 "$MARK_DIR/$SESSION"
out=$(payload tool_name=Write session_id=33333333-4444-5555-6666-777777777777 agent_id=- agent_type=- | gate_keep)
check "a third session is reminded" "$out" remind
if [ -e "$MARK_DIR/$SESSION" ]; then
  FAIL=$((FAIL + 1)); echo "  ❌ a marker older than 3 days was not swept"
else
  PASS=$((PASS + 1)); echo "  ✅ a marker older than 3 days is swept"
fi
# A marker that cannot be written fails silent, never toward repeating.
reset_marks
mkdir -p "$FAKE_HOME/.claude-workbench"
: >"$MARK_DIR"   # a plain file where the marker dir should be
out=$(payload tool_name=Write session_id="$SESSION" agent_id=- agent_type=- | gate_keep)
check "an unwritable marker dir stays silent" "$out" silent
rm -f "$MARK_DIR"
out=$(payload tool_name=Write session_id="$SESSION" agent_id=- agent_type=- \
  | env -u WORKBENCH_ORCHESTRATOR HOME= WORKBENCH_ORCHESTRATOR_STATE_DIR="$STATE_DIR" bash "$GATE")
check "an empty HOME stays silent" "$out" silent

# Registration is part of the behaviour: a gate nothing calls gates nothing.
echo "the hook is registered in hooks.json:"
assert_jq "matcher covers exactly the two whole-file tools, not Edit" "$HOOKS_JSON" \
  '[.hooks.PreToolUse[] | select(.hooks[].command | test("delegation-gate.sh")) | .matcher] | join(",")' \
  "Write|NotebookEdit"
assert_jq "registered exactly once" "$HOOKS_JSON" \
  '[.hooks.PreToolUse[].hooks[] | select(.command | test("delegation-gate.sh"))] | length' "1"
assert_jq "no if condition narrows it" "$HOOKS_JSON" \
  '[.hooks.PreToolUse[] | select(.hooks[].command | test("delegation-gate.sh")) | .if // empty] | length' "0"

# The harness expands ${CLAUDE_PLUGIN_ROOT} into a shell command line, and an
# unquoted expansion word-splits on a plugin path containing a space (the norm
# under ".../Application Support/Claude/..."). The script is then never found
# and the reminder silently never fires.
CMD_TEMPLATE="$(jq -r '
  [.hooks.PreToolUse[] | select(.hooks[].command | test("delegation-gate.sh")) | .hooks[].command][0] // ""
' "$HOOKS_JSON")"
SPACED_ROOT="$SANDBOX/plugin root"  # deliberate space
mkdir -p "$SPACED_ROOT/hooks/lib"
cp "$GATE" "$SPACED_ROOT/hooks/delegation-gate.sh"
cp "$HOOKS_DIR/lib/scratch-roots.sh" "$SPACED_ROOT/hooks/lib/scratch-roots.sh"
reset_marks
out=$(payload tool_name=Write session_id="$SESSION" agent_id=- agent_type=- \
  | env -u WORKBENCH_ORCHESTRATOR HOME="$FAKE_HOME" \
        WORKBENCH_ORCHESTRATOR_STATE_DIR="$STATE_DIR" \
        CLAUDE_PLUGIN_ROOT="$SPACED_ROOT" sh -c "${CMD_TEMPLATE:-false}")
check "gate fires when the plugin path contains a space" "$out" remind

echo "the scratch-root resolver, run directly as \$.workbench.scratchRoots() runs it:"
# hooks/register.ts runs `bash lib/scratch-roots.sh <sid>` and keeps each
# absolute line. The gate cases above cover what the roots mean. These cover
# the command-line door: the session's pad for its own id only, and no
# session root at all for an id that could walk out of the tree.
RESOLVER="$HOOKS_DIR/lib/scratch-roots.sh"
REAL_PAD="$(cd -P "$PAD" && pwd -P)"
assert_contains "the session's own pad is a root"   "$(bash "$RESOLVER" "$SCRATCH_SID")" "$REAL_PAD"
assert_missing  "another session's pad is not"      "$(bash "$RESOLVER" "$SCRATCH_SID")" "$(cd -P "$OTHER_PAD" && pwd -P)"
assert_missing  "a symlinked pad is not"            "$(bash "$RESOLVER" "$LINK_SID")" "$SANDBOX/outside"
assert_missing  "an id with a path separator names no session root" \
  "$(bash "$RESOLVER" "../$SCRATCH_SID")" "$REAL_PAD"
# A glob in the id would match every session's pad, real paths and all.
assert_missing  "an id that is a glob names no session root" "$(bash "$RESOLVER" '*')" "$REAL_PAD"
if bash "$RESOLVER" '../x' >/dev/null 2>&1; then RESOLVER_EXIT=""; else RESOLVER_EXIT="failed"; fi
check "the resolver exits 0 on a bad id" "$RESOLVER_EXIT" silent

echo "the /orchestrator command agrees with the gate:"
# The command mirrors its mode into the file the gate reads. If either side
# renames the env var or the default directory, the toggle stops working and
# nothing else notices.
for token in "WORKBENCH_ORCHESTRATOR_STATE_DIR" ".claude-workbench/orchestrator-mode"; do
  assert_grep "toggle uses $token" "$token" "$TOGGLE"
  assert_grep "gate uses $token"   "$token" "$GATE"
done
# The command keys the file by the session id the engine reports; the gate keys
# its lookup by the payload's .session_id. The two are the same id.
assert_grep "toggle keys the file by the session id" 'legacyFileOf(await $.session.id()' "$MODULE"
assert_grep "gate keys the lookup by .session_id"    '.session_id'                       "$GATE"
assert_grep "toggle keeps a stored mode 7 days"      'KEEP_DAYS = 7'                     "$TOGGLE"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
