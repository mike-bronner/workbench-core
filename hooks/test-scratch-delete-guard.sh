#!/bin/bash
# Tests for hooks/scratch-delete-guard.sh — the PreToolUse guard that refuses an
# `rm` aimed at a scratchpad path and hands back the command that deletes it
# with no prompt.
# Run directly: ./test-scratch-delete-guard.sh
#
# Each case feeds the hook one PreToolUse payload on stdin and asserts its
# VERDICT: deny (the call is refused) or allow (nothing is printed, so the
# ordinary permission flow applies, prompt and all). Pure stdin/stdout checks —
# no network, and no file is deleted by any case here, because the guard's only
# contact with the helper is `--check`, which deletes nothing by construction.
#
# THE SUITE IS WEIGHTED AT TWO FAILURES, AND THEY ARE NOT THE SAME FAILURE.
#
# The first is DISAGREEMENT. The guard refuses an `rm` and names scratch-rm.sh
# as the way through. If it ever refuses a delete that scratch-rm.sh ALSO
# refuses — a scratch root itself, a `..` escape, a symlink out — the agent is
# left with two closed doors and no route at all. That is worse than the prompt
# this whole design removes, so every one of those shapes has a case, and each
# asserts `allow`.
#
# The second is OVER-REACH. A deny costs the entire command, not the part the
# guard understood. So a command that deletes something outside a scratch root,
# or does anything besides delete, must pass through untouched — and those cases
# outnumber the denials below.
#
# WHICH ROOT THE CASES RUN AGAINST, AND WHY IT IS THE SESSION ONE.
# For the reason hooks/test-scratch-rm.sh gives: the persistent root comes from
# the password database and the temporary root from getconf, and neither ignores
# a test the way it ignores an attacker — they ignore it identically. The
# session root is found by matching CLAUDE_CODE_SESSION_ID under /tmp/claude-*/,
# which a test CAN stand up, so every case uses it. That also makes the
# session-id plumbing testable, which matters: the guard reads the id out of the
# hook payload rather than its own environment, and a case below proves it.
#
# The helper the guard consults is the INSTALLED copy at
# $HOME/.claude-workbench/bin/scratch-rm.sh, so $HOME is pointed at a sandbox
# holding a copy of this repo's bin/scratch-rm.sh. A side effect worth naming:
# scratch-rm.sh accepts $HOME only when it is this account's login home, so the
# persistent root is dropped throughout this suite. That is the state under
# test, not a hole in it — the session root is what these cases use.

set -u
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$HOOKS_DIR/.." && pwd)"
GUARD="$HOOKS_DIR/scratch-delete-guard.sh"
HOOKS_JSON="$HOOKS_DIR/hooks.json"
WARMUP="$HOOKS_DIR/session-warmup.sh"
RAILS="$ROOT_DIR/assets/permissions/rails.json"
PASS=0
FAIL=0

# The fixture tree sits in /tmp, which is under no approved root: the session
# glob needs a `claude-` prefix at that level, the login home is elsewhere, and
# on Darwin /tmp resolves to /private/tmp rather than into the
# /private/var/folders tree the temporary root lives in. A victim that a bug
# could delete has to be somewhere the helper will never accept, or a case
# asserting it survives proves nothing.
SANDBOX="/tmp/scratchdelete-sandbox-$$"
FAKE_TMP="/tmp/claude-scratchdelete-test-$$"
trap 'rm -rf "$SANDBOX" "$FAKE_TMP"' EXIT

SID="scratchdelete-$$-aaaa"
OTHER_SID="scratchdelete-$$-bbbb"

PROJECT="$FAKE_TMP/-fake-project/$SID"
SCRATCH="$PROJECT/scratchpad"
# A second session's scratchpad, identical in shape and approved for nobody
# here. The guard must not offer to delete another session's work.
OTHER_SCRATCH="$FAKE_TMP/-fake-project/$OTHER_SID/scratchpad"
# Outside every root, reachable from the scratchpad only by traversal.
VICTIM="$SANDBOX/victim"

# Two homes: one with the helper installed, one without. The second is the
# fail-open case that matters most — with no installed helper the sanctioned
# command does not exist, so a deny would send the agent nowhere.
FAKE_HOME="$SANDBOX/home"
BARE_HOME="$SANDBOX/bare-home"

# The `~` directory is literal, and it is there to make the tilde case
# discriminate. With it on disk, a guard that failed to notice the `~` in
# `rm -rf ~/sub` would resolve that text against the cwd, find a real directory
# beneath an approved root, and offer to delete it — while the shell the agent
# retyped it into would have expanded `~` and deleted something in the home
# directory instead. That mismatch is the hazard, and it needs both paths to
# exist to be visible.
mkdir -p "$SCRATCH/sub" "$SCRATCH/~/sub" "$OTHER_SCRATCH" "$VICTIM" \
         "$FAKE_HOME/.claude-workbench/bin" "$BARE_HOME"
cp "$ROOT_DIR/bin/scratch-rm.sh" "$FAKE_HOME/.claude-workbench/bin/scratch-rm.sh"
echo "scratch" > "$SCRATCH/file.txt"
echo "do not delete" > "$VICTIM/keep.txt"
echo "another session's work" > "$OTHER_SCRATCH/file.txt"
ln -s "$VICTIM" "$SCRATCH/escape"

# run_guard [home] — stdin is the payload. The session id reaches the guard
# through the PAYLOAD, never the environment, so CLAUDE_CODE_SESSION_ID is unset
# here: any case that passes is passing on the payload's id alone.
run_guard() {
  (unset CLAUDE_CODE_SESSION_ID; HOME="${1:-$FAKE_HOME}" bash "$GUARD")
}

verdict_of() {
  local decision
  decision=$(printf '%s' "$1" | jq -r '.hookSpecificOutput.permissionDecision // empty' 2>/dev/null)
  echo "${decision:-allow}"
}
reason_of()  { printf '%s' "$1" | jq -r '.hookSpecificOutput.permissionDecisionReason // empty' 2>/dev/null; }
context_of() { printf '%s' "$1" | jq -r '.hookSpecificOutput.additionalContext // empty' 2>/dev/null; }

# payload <command> [cwd] [session-id]
# `${2-}` rather than `${2:-}`: an EMPTY cwd is a case under test and must reach
# the payload instead of being defaulted away. Same for the session id.
payload() {
  jq -nc --arg c "$1" --arg d "${2-}" --arg s "${3-$SID}" \
    '{tool_name: "Bash", tool_input: {command: $c}, cwd: $d, session_id: $s}'
}

check() {
  local expected="$1" desc="$2" cmd="$3" actual
  actual=$(verdict_of "$(payload "$cmd" "${4-}" "${5-$SID}" | run_guard 2>/dev/null)")
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected $expected, got $actual"
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

refute_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if printf '%s\n' "$haystack" | grep -qF -- "$needle"; then
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — output contains: $needle"
  else
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  fi
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

assert_survives() {
  local desc="$1" path="$2"
  if [ -e "$path" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — $path was deleted"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# The reflex this guard exists to intercept: an agent clearing its own
# scratchpad, which prompts today on every single call.
echo "blocks a delete aimed beneath the session scratchpad:"
check deny "rm -rf a directory"      "rm -rf $SCRATCH/sub"
check deny "rm -rf a file"           "rm -rf $SCRATCH/file.txt"
check deny "a path that does not exist yet" "rm -rf $SCRATCH/never-made"
check deny "a symlink inside the root" "rm -rf $SCRATCH/escape"

# The four delete spellings, and why all four are here. `rm -rf` is the one
# people notice, because `Bash(rm -rf:*)` prompts on it. The other three match
# no permission rule at all and fall through to the auto-mode classifier, which
# can prompt too — and no rule can cover them for the reason scratch-rm.sh
# documents at length. This guard is the only place that reaches them.
echo "covers the delete spellings no permission rule reaches:"
check deny "rm -r without -f"        "rm -r $SCRATCH/sub"
check deny "plain rm"                "rm $SCRATCH/file.txt"
check deny "rm -f"                   "rm -f $SCRATCH/file.txt"
check deny "rmdir"                   "rmdir $SCRATCH/sub"
check deny "rm with -- before paths" "rm -rf -- $SCRATCH/sub"
check deny "an absolute rm binary"   "/bin/rm -rf $SCRATCH/sub"

echo "resolves the shapes a relative path arrives in:"
check deny "relative to the call's cwd" "rm -rf sub" "$SCRATCH"
check deny "cd then rm"                 "cd $SCRATCH && rm -rf sub" ""
check deny "cd relative, then rm"       "cd sub && rm -rf inner" "$SCRATCH"
check deny "two paths, both inside"     "rm -rf $SCRATCH/sub $SCRATCH/file.txt"

# ─────────────────────────────────────────────────────────────────────────────
# THE DISAGREEMENT CASES. Every command here is one scratch-rm.sh would refuse,
# so a deny would name a command that then refuses too — two closed doors, and
# no route at all. Each asserts the verdict AND that the victim is still there,
# because the guard reaching the right verdict for the wrong reason is not a
# pass.
echo "never refuses a delete the helper would also refuse:"
check allow "the scratch root itself"    "rm -rf $SCRATCH"
check allow "the scratch root, trailing slash" "rm -rf $SCRATCH/"
check allow "a .. escape out of the root" "rm -rf $SCRATCH/../../keep.txt"
check allow "through a symlink out"       "rm -rf $SCRATCH/escape/keep.txt"
check allow "another session's scratchpad" "rm -rf $OTHER_SCRATCH/file.txt"
check allow "a path under no root at all" "rm -rf $VICTIM/keep.txt"
check allow "a system path"               "rm -rf /etc/hosts"
check allow "a relative path with no cwd" "rm -rf sub" ""
assert_survives "the victim outside every root" "$VICTIM/keep.txt"
assert_survives "the other session's work"      "$OTHER_SCRATCH/file.txt"
assert_survives "the scratch root itself"       "$SCRATCH"

# ─────────────────────────────────────────────────────────────────────────────
# THE OVER-REACH CASES. A deny costs the whole command, and the recovery this
# guard offers is "run scratch-rm instead". Where that sentence is not true of
# the entire call, the command goes through to its ordinary prompt.
echo "leaves a command alone when scratch-rm cannot replace all of it:"
check allow "one path inside, one outside" "rm -rf $SCRATCH/sub $VICTIM/keep.txt"
check allow "a delete plus another command" "rm -rf $SCRATCH/sub && echo done"
check allow "another command plus a delete" "mkdir -p $SCRATCH/x && rm -rf $SCRATCH/sub"
# The redirect cases run WITH a cwd, and inside the scratchpad, on purpose.
# With the redirect target outside the root, or with no cwd to resolve it
# against, they would pass whether or not the guard reads redirections at all —
# the target would simply fail its own root check and take the command with it.
# Pointing the redirect at a path the helper WOULD accept removes that second
# reason, so only the redirection itself can produce the allow.
check allow "a delete with a redirect"      "rm -rf sub > out.log" "$SCRATCH"
check allow "a delete with an append"       "rm -rf sub >> out.log" "$SCRATCH"
check allow "rm with no path at all"        "rm -rf"
check allow "a glob, which names a set"     "rm -rf $SCRATCH/*"

# THESE TWO RUN FROM INSIDE THE SCRATCHPAD, and the shape is chosen so that the
# unexpanded text is the ONLY reason the command passes through. Resolve
# `${X}sub` or `~/sub` against this cwd as if it were a literal and both land
# beneath the root, so the helper would accept them and the guard would offer to
# delete a path the shell was never going to touch. A case pointing outside the
# root instead would pass whether the guard reads the expansion or not.
check allow "a variable, which names nothing yet" 'rm -rf "${X}sub"' "$SCRATCH"
check allow "a tilde path, which names another root" "rm -rf ~/sub" "$SCRATCH"

echo "reads the verb slot, not the characters:"
check allow "rm inside a grep pattern"  "grep -rn 'rm -rf $SCRATCH' ."
check allow "rm as an echo argument"    "echo rm -rf $SCRATCH/sub"
check allow "a command that merely lists" "ls -la $SCRATCH/sub"
check allow "a path with rm in its name"  "cat $SCRATCH/scratch-rm.log"
check allow "the sanctioned command itself" \
  "bash \"\$HOME/.claude-workbench/bin/scratch-rm.sh\" $SCRATCH/sub"

# ─────────────────────────────────────────────────────────────────────────────
# The session root is found by matching the session id, and the guard takes that
# id from the PAYLOAD rather than its own environment — the payload's id is the
# one belonging to the call being judged. Both directions are asserted: with the
# right id the same command denies, with a wrong or absent one it does not.
echo "takes the session id from the payload:"
check deny  "the payload's own session id"  "rm -rf $SCRATCH/sub" "" "$SID"
check allow "a different session's id"      "rm -rf $SCRATCH/sub" "" "$OTHER_SID"
check allow "no session id at all"          "rm -rf $SCRATCH/sub" "" ""
check allow "a malformed session id"        "rm -rf $SCRATCH/sub" "" "../../etc"

# ─────────────────────────────────────────────────────────────────────────────
# FAIL OPEN. Each of these leaves the call to the prompt it would have hit
# anyway, which is the status quo and costs nothing. The missing-helper case is
# the one that matters: with no installed scratch-rm.sh there is no sanctioned
# command to name, so a deny would be a dead end rather than a route.
echo "fails open when it cannot do its job:"
OUT=$(payload "rm -rf $SCRATCH/sub" | run_guard "$BARE_HOME" 2>/dev/null)
if [ "$(verdict_of "$OUT")" = "allow" ]; then
  PASS=$((PASS + 1)); echo "  ✅ allows when \$HOME has no installed helper"
else
  FAIL=$((FAIL + 1)); echo "  ❌ denied with no helper to route to"
fi
OUT=$(jq -nc --arg c "rm -rf $SCRATCH/sub" \
  '{tool_name: "Read", tool_input: {command: $c}, session_id: "'"$SID"'"}' | run_guard 2>/dev/null)
if [ "$(verdict_of "$OUT")" = "allow" ]; then
  PASS=$((PASS + 1)); echo "  ✅ ignores a tool that is not Bash"
else
  FAIL=$((FAIL + 1)); echo "  ❌ judged a non-Bash tool call"
fi
OUT=$(printf '' | run_guard 2>/dev/null)
if [ -z "$OUT" ]; then
  PASS=$((PASS + 1)); echo "  ✅ empty stdin prints nothing"
else
  FAIL=$((FAIL + 1)); echo "  ❌ empty stdin produced output"
fi
OUT=$(printf 'not json at all' | run_guard 2>/dev/null)
if [ "$(verdict_of "$OUT")" = "allow" ]; then
  PASS=$((PASS + 1)); echo "  ✅ a payload that is not JSON allows"
else
  FAIL=$((FAIL + 1)); echo "  ❌ a malformed payload produced a deny"
fi
OUT=$(payload "rm -rf $SCRATCH/sub" | (cd / && run_guard) 2>/dev/null)
if [ "$(verdict_of "$OUT")" = "deny" ]; then
  PASS=$((PASS + 1)); echo "  ✅ still blocks when invoked from another directory"
else
  FAIL=$((FAIL + 1)); echo "  ❌ failed open when invoked from another directory"
fi

# ─────────────────────────────────────────────────────────────────────────────
# THE DENIAL IS A ROUTE, AND THE ROUTE IS THE SPELLING. Only the `"$HOME"` form
# matches the shipped allow entry, so a message carrying any other form sends
# the agent straight back to a prompt — the guard would have cost a round trip
# and bought nothing. These assert the exact text.
echo "the refusal carries the command that works:"
DENIAL=$(payload "rm -rf $SCRATCH/sub" | run_guard 2>/dev/null)
CONTEXT=$(context_of "$DENIAL")
REASON=$(reason_of "$DENIAL")
assert_contains "names the sanctioned command in the \$HOME form" "$CONTEXT" \
  'bash "$HOME/.claude-workbench/bin/scratch-rm.sh"'
assert_contains "carries the absolute path to delete" "$CONTEXT" "$SCRATCH/sub"
assert_contains "says the spelling is load-bearing"   "$CONTEXT" "load-bearing"
assert_contains "says the denial is not a dead end"   "$CONTEXT" "not a dead end"
# The tilde is built from a variable so shellcheck reads it as data rather than
# a path it should have expanded (SC2088). Unexpanded is exactly the point: a
# `~/` spelling in the message is matched by no allow rule and prompts, so this
# asserts the literal character never reaches the agent.
TILDE='~'
refute_contains "never suggests a tilde path"         "$CONTEXT" "$TILDE/.claude-workbench"
# Anchored to the start of a line, because every suggested command occupies one
# and `bash "$HOME` ends with the very substring an unanchored search for the
# `sh` spelling would find. That is not a quibble about the test: `sh` instead
# of `bash` is matched by no allow rule and prompts, so a command line starting
# with it would undo the entire point of the denial.
if printf '%s\n' "$CONTEXT" | grep -qE '^sh "'; then
  FAIL=$((FAIL + 1)); echo "  ❌ never suggests the sh spelling — a command line starts with sh"
else
  PASS=$((PASS + 1)); echo "  ✅ never suggests the sh spelling"
fi
# Every command line offered is the bash/$HOME form and no other.
OFFERED=$(printf '%s\n' "$CONTEXT" | grep -c 'scratch-rm\.sh" ' | tr -d ' ')
ANCHORED=$(printf '%s\n' "$CONTEXT" | grep -c '^bash "\$HOME/\.claude-workbench/bin/scratch-rm\.sh" ' | tr -d ' ')
if [ "$OFFERED" = "$ANCHORED" ] && [ "$ANCHORED" -ge 1 ]; then
  PASS=$((PASS + 1)); echo "  ✅ every command offered is the \$HOME form"
else
  FAIL=$((FAIL + 1)); echo "  ❌ $OFFERED commands offered, only $ANCHORED in the \$HOME form"
fi
# The expanded absolute path is the spelling that matches no rule. Naming it
# would be the guard handing over the one form guaranteed to prompt.
refute_contains "never suggests the expanded helper path" "$CONTEXT" \
  "bash \"$FAKE_HOME/.claude-workbench"

# The human's line names the action and stops; the command lives in the model's
# channel. A filesystem path in the reason is the exact defect the JSON deny was
# adopted to remove, so it must not creep back in through the author's half.
refute_contains "the human line carries no path" "$REASON" "/"
if [ "$(printf '%s' "$REASON" | wc -l | tr -d ' ')" = "0" ]; then
  PASS=$((PASS + 1)); echo "  ✅ the human line is one line"
else
  FAIL=$((FAIL + 1)); echo "  ❌ the human line runs to more than one line"
fi

# An ordinary path is offered bare, matching the spelling scratch-rm.sh's header
# and the setup skill document. A path that needs quoting gets it, because a
# command the agent cannot paste back is not the route this guard promises.
echo "the suggested command is one the agent can paste:"
assert_contains "an ordinary path is offered bare" "$CONTEXT" \
  "scratch-rm.sh\" $SCRATCH/sub"
mkdir -p "$SCRATCH/needs quoting"
SPACED=$(payload "rm -rf '$SCRATCH/needs quoting'" | run_guard 2>/dev/null)
assert_contains "a path with a space is quoted" "$(context_of "$SPACED")" \
  "scratch-rm.sh\" '$SCRATCH/needs quoting'"
assert_survives "the spaced directory survives" "$SCRATCH/needs quoting"

echo "a two-path denial names a command for each path:"
DENIAL=$(payload "rm -rf $SCRATCH/sub $SCRATCH/file.txt" | run_guard 2>/dev/null)
CONTEXT=$(context_of "$DENIAL")
assert_contains "the first path" "$CONTEXT" "$SCRATCH/sub"
assert_contains "the second path" "$CONTEXT" "$SCRATCH/file.txt"
COMMAND_COUNT=$(printf '%s\n' "$CONTEXT" | grep -cF 'scratch-rm.sh' | tr -d ' ')
if [ "$COMMAND_COUNT" -ge 2 ]; then
  PASS=$((PASS + 1)); echo "  ✅ one command per path"
else
  FAIL=$((FAIL + 1)); echo "  ❌ expected a command per path, found $COMMAND_COUNT"
fi

# ─────────────────────────────────────────────────────────────────────────────
# The guard's only contact with the helper is `--check`, and this asserts that
# mode is a verdict rather than an action. If it ever deletes, every case above
# that asserts a deny has been quietly destroying its own fixture.
echo "--check answers without deleting:"
CLAUDE_CODE_SESSION_ID="$SID" HOME="$FAKE_HOME" \
  bash "$ROOT_DIR/bin/scratch-rm.sh" --check "$SCRATCH/file.txt" >/dev/null 2>&1
CHECK_STATUS=$?
if [ "$CHECK_STATUS" = "0" ]; then
  PASS=$((PASS + 1)); echo "  ✅ accepts a path it would delete"
else
  FAIL=$((FAIL + 1)); echo "  ❌ refused a path it would delete"
fi
assert_survives "the file --check accepted is still there" "$SCRATCH/file.txt"
CLAUDE_CODE_SESSION_ID="$SID" HOME="$FAKE_HOME" \
  bash "$ROOT_DIR/bin/scratch-rm.sh" --check "$VICTIM/keep.txt" >/dev/null 2>&1
CHECK_STATUS=$?
if [ "$CHECK_STATUS" = "1" ]; then
  PASS=$((PASS + 1)); echo "  ✅ refuses a path outside every root"
else
  FAIL=$((FAIL + 1)); echo "  ❌ accepted a path outside every root"
fi
OUT=$(CLAUDE_CODE_SESSION_ID="$SID" HOME="$FAKE_HOME" \
  bash "$ROOT_DIR/bin/scratch-rm.sh" --check "$SCRATCH/file.txt" 2>&1)
if [ -z "$OUT" ]; then
  PASS=$((PASS + 1)); echo "  ✅ prints nothing, so the status is the whole answer"
else
  FAIL=$((FAIL + 1)); echo "  ❌ printed output in check mode: $OUT"
fi

# ─────────────────────────────────────────────────────────────────────────────
# A guard nothing calls guards nothing, so registration is part of the
# behaviour.
echo "the hook is registered in hooks.json:"
assert_jq "matcher is Bash" "$HOOKS_JSON" \
  '[.hooks.PreToolUse[] | select(.hooks[].command | test("scratch-delete-guard.sh")) | .matcher] | join(",")' \
  "Bash"
assert_jq "registered exactly once" "$HOOKS_JSON" \
  '[.hooks.PreToolUse[].hooks[] | select(.command | test("scratch-delete-guard.sh"))] | length' "1"
assert_jq "no if condition narrows it" "$HOOKS_JSON" \
  '[.hooks.PreToolUse[] | select(.hooks[].command | test("scratch-delete-guard.sh")) | .if // empty] | length' "0"

# The hook is the enforcing half. The warmup is the half that reaches an agent
# BEFORE it is ever denied one, and without it every scratchpad cleanup costs a
# denial and a retry that the instruction alone would have saved. Both halves
# ship or neither is worth much, so both are asserted here.
echo "the warmup names the helper, so an agent knows it before being denied:"
WARMUP_TEXT="$(cat "$WARMUP" 2>/dev/null)"
assert_contains "names the sanctioned command" "$WARMUP_TEXT" \
  'bash "$HOME/.claude-workbench/bin/scratch-rm.sh"'
assert_contains "says the spelling must be exact" "$WARMUP_TEXT" "spelling exactly"
assert_contains "says rm -rf prompts"             "$WARMUP_TEXT" "prompts the user"

echo "rails.json documents the guard beside the rule it works around:"
RAILS_TEXT="$(cat "$RAILS" 2>/dev/null)"
assert_contains "names the guard"          "$RAILS_TEXT" "scratch-delete-guard.sh"
assert_contains "keeps the ask rule"       "$RAILS_TEXT" "Bash(rm -rf:*)"
assert_contains "names the allow entry"    "$RAILS_TEXT" "scratch-rm.sh"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
