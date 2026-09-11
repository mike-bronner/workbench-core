#!/bin/bash
# Tests for hooks/agent-dispatch-gate.sh — the PreToolUse gate that requires the
# five-slot brief on every Agent dispatch from the main session.
# Run directly: ./test-agent-dispatch-gate.sh
#
# Each case feeds one synthetic PreToolUse payload on stdin and asserts one of
# three verdicts: deny (permissionDecision "deny"), hint (additionalContext and
# NO permissionDecision), or silent (no output at all). Pure stdin/stdout checks
# — no network, no server, nothing read from the real home directory.
#
# Allow branches (a)-(g) from the script header are each covered independently,
# so no one branch can mask another. Each of the five slots is pinned by its own
# omission fixture, because a closed set with no fixture per member degrades
# silently.

set -u
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
GATE="$HOOKS_DIR/agent-dispatch-gate.sh"
HOOKS_JSON="$HOOKS_DIR/hooks.json"
DELEGATION="$HOOKS_DIR/delegation-gate.sh"
SKILL="$HOOKS_DIR/../skills/orchestrator/SKILL.md"
SUMMARY_SKILL="$HOOKS_DIR/../skills/process-pending-summaries/SKILL.md"
README="$HOOKS_DIR/../README.md"
PASS=0
FAIL=0

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/agent-dispatch-gate.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT

# Both pieces of external state this gate reads are isolated. The state dir is
# overridden so the human's real toggle never decides this suite's verdicts, and
# HOME is faked so the deny message's dev-team probe reads a directory we
# control rather than the real plugin cache.
STATE_DIR="$SANDBOX/state"
FAKE_HOME="$SANDBOX/home"             # no plugin cache: the plain deny message
DEVTEAM_HOME="$SANDBOX/home-devteam"  # plugin cache present: enriched message
mkdir -p "$STATE_DIR" "$FAKE_HOME" \
  "$DEVTEAM_HOME/.claude/plugins/cache/claude-workbench/workbench-dev-team"

SESSION="b94bbff5-0f68-4c1c-b3ec-3a899d30bc05"
DEVTEAM_LINE='The dev-team specialists and the brief they expect are in /workbench-dev-team:orchestrate.'

# ---------------------------------------------------------------------------
# Fixtures. The briefs below are real dispatch text from the 14-day transcript
# sample, trimmed and fitted to the five-slot template. Using real prose rather
# than "lorem ipsum" is what makes the read-only pass-through case meaningful.
# ---------------------------------------------------------------------------

# A well-formed brief with no prescriptive markers at all.
read -r -d '' GOOD_BRIEF <<'EOF'
Workdir: /Users/mike/Developer/workbench-core
Goal: Make the credential guard stop matching .env by substring.
Context: The guard matches .env anywhere in the raw command text, so any command
mentioning a path containing .envrc trips it. Three false positives in one day.
Constraints: none
Done when: The guard rejects .envrc and still catches .env, with a test per case.
EOF

# A realistic READ-ONLY investigation brief. This is the majority of legitimate
# traffic and must pass clean — a gate that refuses it is worse than no gate.
read -r -d '' READONLY_BRIEF <<'EOF'
Workdir: /Users/mike/Developer/zed-laravel
Goal: Report correctness defects in the PHP translation-catalogue AST walker.
Context: The branch replaced a regex parser with a tree-sitter walk. Read-only,
no write tools, no patching. Do not edit any file. Report findings only.
Constraints:
- Read-only. Do not modify anything.
Done when: Every finding is reported with a file, a line, and a failing input.
EOF

# A brief missing every slot: the plain "someone typed a paragraph" case.
FREEFORM='Go read the config parser and fix whatever looks wrong in it.'

# Builds a payload from key=value pairs. A value of - omits the key entirely,
# which is how "main agent" is expressed: agent_id and agent_type are ABSENT,
# not empty. Verified against a live logging hook.
payload() {
  local obj='{"hook_event_name":"PreToolUse","tool_name":"Agent"}' arg k v
  for arg in "$@"; do
    k="${arg%%=*}"
    v="${arg#*=}"
    [ "$v" = "-" ] && continue
    if [ "$k" = "prompt" ] || [ "$k" = "subagent_type" ]; then
      obj=$(printf '%s' "$obj" | jq -c --arg k "$k" --arg v "$v" '.tool_input[$k] = $v')
    else
      obj=$(printf '%s' "$obj" | jq -c --arg k "$k" --arg v "$v" '.[$k] = $v')
    fi
  done
  printf '%s' "$obj"
}

# A main-agent dispatch carrying the given prompt. The common shape.
main_payload() { payload session_id="$SESSION" agent_id=- agent_type=- prompt="$1"; }

# The gate under the suite's controlled environment. WORKBENCH_ORCHESTRATOR is
# unset so a value inherited from the caller cannot silently allow every case.
gate() {
  env -u WORKBENCH_ORCHESTRATOR HOME="$FAKE_HOME" \
    WORKBENCH_ORCHESTRATOR_STATE_DIR="$STATE_DIR" bash "$GATE"
}

# Every [[:space:]] left in THIS file is safe, and each is left alone on the same
# ground: none of them reads a prompt. The class is a property of the C library —
# glibc excludes U+00A0, U+202F and U+2007 in every locale, Darwin includes them
# — which is why the gate and lib/brief-template.sh now spell their whitespace
# out in ASCII, and why the block further down tests exactly that. Here the
# subjects are the gate's own jq output (below) and files from this repo, README
# and SKILL.md included. Neither can carry an exotic space at the position tested
# without the repo itself changing, so there is no untrusted input to diverge on.
verdict_of() {
  if printf '%s' "$1" | grep -q '"permissionDecision":"deny"'; then
    printf 'deny'
  elif printf '%s' "$1" | grep -q '"additionalContext"'; then
    printf 'hint'
  # The bash-glob form that 0.27.0 replaced in the shipping hooks, kept here on
  # purpose: this one is quadratic over its subject and does not care, because
  # the subject is a short jq object or the empty string, never a 12 KB prompt.
  elif [ -z "${1//[[:space:]]/}" ]; then
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

run_prompt() { check "$1" "$(main_payload "$2" | gate)" "$3"; }

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

echo "the deny path (main agent, no template):"
run_prompt "a free-form paragraph"      "$FREEFORM"                       deny
run_prompt "an empty-ish prompt of dots" "..."                            deny
run_prompt "slot headers only in prose" "Mention the repo and the goal."  deny

echo "each of the five slots is required, pinned independently:"
# Every fixture below is the GOOD brief with exactly one slot line removed, so a
# pass proves that slot alone is load-bearing. Drop any single grep from the
# gate and exactly one of these five goes deny-to-hint.
for slot in "Workdir:" "Goal:" "Context:" "Constraints:" "Done when:"; do
  stripped="$(printf '%s\n' "$GOOD_BRIEF" | grep -v "^${slot}")"
  out="$(main_payload "$stripped" | gate)"
  check "missing '$slot' is denied" "$out" deny
  assert_contains "the deny names the missing '$slot'" "$out" "Missing: $slot"
done

echo "the first slot is Workdir:, and the old Repo: name is gone:"
# The slot was renamed from Repo: to Workdir: because core dispatches work that
# has no repo — summary-writer works in the memory vault. Stripping Workdir:
# above cannot catch a gate that accepts BOTH names, because the good brief
# carries no Repo: line to fall back on. This pair can.
run_prompt "a brief using the old Repo: name is refused" \
  "${GOOD_BRIEF/Workdir:/Repo:}" deny
assert_contains "and the refusal asks for Workdir:" \
  "$(main_payload "${GOOD_BRIEF/Workdir:/Repo:}" | gate)" "Missing: Workdir:"
# No stale Repo: slot HEADER may survive where a brief is written or documented.
# Anchored at line start on purpose: that is what a slot header is, and it lets
# prose still name the old slot when explaining the rename, which the README
# does. An unanchored match would forbid documenting the migration at all.
# `Repo sweep:` is a pipeline dispatch shape, not a slot, so it is excluded.
for f in "$README" "$SUMMARY_SKILL"; do
  if grep -nE '^[[:space:]]*Repo:' "$f" 2>/dev/null | grep -qv 'Repo sweep:'; then
    FAIL=$((FAIL + 1)); echo "  ❌ stale Repo: slot header still in $(basename "$f")"
  else
    PASS=$((PASS + 1)); echo "  ✅ no stale Repo: slot header in $(basename "$f")"
  fi
done
# The gate is covered more strictly further down: a test asserts it restates NO
# slot header inline at all, derived from the shared definition, so it cannot
# carry a stale one by construction.
# ...and the rename did not eat the unrelated pipeline shape.
assert_grep "Repo sweep: survived the rename" 'Repo sweep:' "$GATE"

echo "a complete brief passes:"
run_prompt "all five slots, no prescriptive markers" "$GOOD_BRIEF" silent
# Slot ORDER is deliberately not enforced: a reordered brief still uses the
# template. Reversing the lines must not change the verdict.
REVERSED="$(printf '%s\n' "$GOOD_BRIEF" | sed -n '1!G;h;$p')"
run_prompt "slots in a different order still pass" "$REVERSED" silent
run_prompt "lower-case headers still pass" "$(printf '%s' "$GOOD_BRIEF" | tr 'A-Z' 'a-z')" silent
run_prompt "'Done  when:' with extra spacing passes" \
  "${GOOD_BRIEF/Done when:/Done   when:}" silent
run_prompt "indented headers pass" "$(printf '%s\n' "$GOOD_BRIEF" | sed 's/^/   /')" silent
run_prompt "tab-separated 'Done<TAB>when:' passes" \
  "${GOOD_BRIEF/Done when:/Done$(printf '\t')when:}" silent

echo "an exotic space is content, never whitespace — the same verdict on every libc:"
# Whether a character is [[:space:]] depends on the C library, not only on the
# locale: glibc excludes U+00A0, U+202F and U+2007 in every locale because they
# are non-breaking, and Darwin includes all three. The gate and
# lib/brief-template.sh therefore spell their whitespace out as ASCII literals.
# Before that, each case below took ONE verdict on macOS and the OPPOSITE on
# Linux — the same brief refused on one machine and dispatched on the other.
#
# Two characters, chosen so that neither platform can pass this block vacuously:
#
#   U+00A0 NBSP   space on Darwin only. These cases were `silent` on macOS
#                 before the fix, and already `deny` on glibc.
#   U+3000 IDSP   space to BOTH in a UTF-8 locale. These cases were `silent`
#                 on both before the fix, so they are what reddens on the CI
#                 runner if the ASCII set is ever reverted.
#
# Each of the three constructs that read whitespace is covered, because fixing
# one and leaving the others is exactly how this defect survived the first pass.
NBSP=$(printf '\302\240')
IDSP=$(printf '\343\200\200')

# 1. the slot patterns in lib/brief-template.sh. "Done<exotic>when:" must NOT
#    satisfy the last slot, or a brief missing it dispatches anyway.
run_prompt "'Done<NBSP>when:' does not satisfy the slot" \
  "${GOOD_BRIEF/Done when:/Done${NBSP}when:}" deny
run_prompt "'Done<IDSP>when:' does not satisfy the slot" \
  "${GOOD_BRIEF/Done when:/Done${IDSP}when:}" deny
run_prompt "a slot header indented with NBSP is still a slot" \
  "$(printf '%s\n' "$GOOD_BRIEF" | sed "s/^/${NBSP}/")" deny

# 2. the blankness check. A prompt built only from exotic spaces is content
#    with no slots in it, so it is judged and refused — never waved through as
#    empty. Fail-closed is the direction a gate has to miss in.
run_prompt "a prompt of nothing but NBSPs is judged, not skipped" "${NBSP}${NBSP}${NBSP}" deny
run_prompt "a prompt of nothing but ideographic spaces is judged" "${IDSP}${IDSP}" deny
# The ASCII half of the same check must keep its old behaviour: genuinely blank
# stays silent. This is what a careless widening of the set would break.
run_prompt "an all-ASCII-whitespace prompt is still skipped" "$(printf '  \t\n  ')" silent

# 3. the machine-shape exemptions. An exotic space must not let a prompt wear
#    the pipeline shape and dispatch with no brief at all.
run_prompt "'Item ID:<NBSP>12' is not the exempt shape" "Item ID:${NBSP}12" deny
run_prompt "'Item ID:<IDSP>12' is not the exempt shape" "Item ID:${IDSP}12" deny
# Repo sweep: needs its exotic space in TRAILING position, after an ASCII one.
# "Repo sweep:<NBSP>owner/repo" looks like the obvious fixture and proves
# nothing: NBSP there is admitted by the owner's own [^<ws>/]+ class as an
# ordinary character, so it matched on BOTH libcs before the fix and still
# matches now. Measured, not assumed. Only a trailing exotic space has to be
# consumed AS whitespace for the anchor to reach the end of the line, and the
# preceding ASCII space is what stops the repo token absorbing it instead.
run_prompt "trailing NBSP breaks the exempt shape" "Repo sweep: owner/repo ${NBSP}" deny
run_prompt "trailing IDSP breaks the exempt shape" "Repo sweep: owner/repo ${IDSP}" deny
# That the REAL shapes still pass — so the tightening did not cost the pipeline
# its dispatch — is pinned by the "(g) the fixed machine-built dispatch shapes
# pass" block below, not repeated here.

echo "Workdir: may carry the branch or worktree the human settled on:"
# workbench-dev-team asks the human before it creates a branch or a worktree,
# and the answer travels in Workdir: because that slot names the tree. The gate
# greps the header and never the slot's content, so both shapes pass without a
# pattern change. These two cases are what would catch a Workdir: pattern later
# tightened to a bare path: nothing else here would, and the plugin now sends
# the longer shape on every dispatch that settled one. The bare-path shape is
# pinned by the complete-brief case above, which is why it is not repeated.
BRIEF_TAIL="$(printf '%s\n' "$GOOD_BRIEF" | grep -v '^Workdir:')"
run_prompt "a Workdir: naming a branch passes" \
  "Workdir: /Users/mike/Developer/workbench-core (branch: fix/env-prefix, to be created off main)
$BRIEF_TAIL" silent
run_prompt "a Workdir: naming a worktree passes" \
  "Workdir: /Users/mike/Developer/workbench-core-wt/env-prefix (worktree off main)
$BRIEF_TAIL" silent

echo "a realistic READ-ONLY dispatch passes clean:"
# This is the traffic the brief called the majority of legitimate dispatches.
# It names no code file to write, it says "read-only" outright, and it must not
# be refused or even flagged.
run_prompt "read-only investigation brief" "$READONLY_BRIEF" silent

echo "the Context slot's VALUE is never inspected:"
# Whether Context may read "none" is still being settled by the plugin that owns
# the brief. Both answers must behave identically here, or this gate has quietly
# decided it. These two cases are what stop that.
run_prompt "Context: none"  "${GOOD_BRIEF/Context: The guard matches/Context: none
OldContext: The guard matches}" silent
LONG_CONTEXT="$GOOD_BRIEF"
run_prompt "Context: prose" "$LONG_CONTEXT" silent

echo "no length is enforced, in either direction:"
# A prose Context slot runs long by design (measured median 4,788 chars). A
# ceiling would deny essentially every well-formed brief, so there must be none.
BIG="$GOOD_BRIEF"
for _ in 1 2 3 4 5 6 7 8; do BIG="$BIG
Context continues with more prose that a real brief would carry, at length."; done
run_prompt "a very long complete brief still passes" "$BIG" silent
run_prompt "a very short complete brief still passes" \
  "Workdir: /x
Goal: g
Context: none
Constraints: none
Done when: d" silent

echo "(a) sub-agent dispatches are allowed:"
# The 422 review-lens dispatches in the 14-day sample land here. They carry no
# template and must never be refused.
check "Agent dispatch from a sub-agent" \
  "$(payload session_id="$SESSION" agent_id=a79d47fc851cc123f agent_type=general-purpose prompt="$FREEFORM" | gate)" silent
check "agent_id alone still allows" \
  "$(payload session_id="$SESSION" agent_id=a79d47fc851cc123f agent_type=- prompt="$FREEFORM" | gate)" silent

echo "(b) top-level --agent dispatch is allowed:"
check "claude -p --agent (agent_type, NO agent_id)" \
  "$(payload session_id="$SESSION" agent_id=- agent_type=workbench-dev-team:holmes prompt="$FREEFORM" | gate)" silent
# Field-separator pin. Present-but-empty agent_id/agent_type is the shape that
# breaks under an @tsv join: bash collapses runs of IFS whitespace, so a tab
# record with empty leading fields shifts tool_name into agent_id's slot and the
# gate allows everything. US (0x1f) is not IFS whitespace, so the empties
# survive. Swap the join for a tab and this case goes deny-to-silent.
check "empty agent_id does not count as a sub-agent" \
  "$(payload session_id="$SESSION" agent_id= agent_type= prompt="$FREEFORM" | gate)" deny

echo "(c) the environment escape hatch:"
out=$(main_payload "$FREEFORM" | env HOME="$FAKE_HOME" \
  WORKBENCH_ORCHESTRATOR_STATE_DIR="$STATE_DIR" WORKBENCH_ORCHESTRATOR=0 bash "$GATE")
check "WORKBENCH_ORCHESTRATOR=0 allows" "$out" silent
# Only the literal 0 opts out. Any other value, including a truthy-looking one,
# leaves the gate armed — this is what stops `=1` reading as "on, so allow".
out=$(main_payload "$FREEFORM" | env HOME="$FAKE_HOME" \
  WORKBENCH_ORCHESTRATOR_STATE_DIR="$STATE_DIR" WORKBENCH_ORCHESTRATOR=1 bash "$GATE")
check "WORKBENCH_ORCHESTRATOR=1 does NOT allow" "$out" deny

echo "(d) the session toggle, shared with the delegation gate:"
run_prompt "no state file -> gate is ON by default" "$FREEFORM" deny
touch "$STATE_DIR/$SESSION"
run_prompt "state file for this session allows" "$FREEFORM" silent
check "state file for ANOTHER session does not allow" \
  "$(payload session_id=11111111-2222-3333-4444-555555555555 agent_id=- agent_type=- prompt="$FREEFORM" | gate)" deny
rm -f "$STATE_DIR/$SESSION"
run_prompt "removing the state file re-enables the gate" "$FREEFORM" deny

# An unset override must fall back to the documented default under $HOME, and a
# fresh fake HOME has no state file there — so the gate still denies. This is
# what proves the default path is a real lookup, not a silent allow.
DEFAULT_HOME="$SANDBOX/default-home"
mkdir -p "$DEFAULT_HOME"
out=$(main_payload "$FREEFORM" | env -u WORKBENCH_ORCHESTRATOR \
  -u WORKBENCH_ORCHESTRATOR_STATE_DIR HOME="$DEFAULT_HOME" bash "$GATE")
check "unset state dir falls back to \$HOME and still denies" "$out" deny
# ...and the fallback resolves to the documented path, not somewhere else.
mkdir -p "$DEFAULT_HOME/.claude-workbench/orchestrator-mode"
touch "$DEFAULT_HOME/.claude-workbench/orchestrator-mode/$SESSION"
out=$(main_payload "$FREEFORM" | env -u WORKBENCH_ORCHESTRATOR \
  -u WORKBENCH_ORCHESTRATOR_STATE_DIR HOME="$DEFAULT_HOME" bash "$GATE")
check "default path is \$HOME/.claude-workbench/orchestrator-mode/<session_id>" "$out" silent

check "absent session_id cannot address the toggle -> fails open" \
  "$(payload session_id=- agent_id=- agent_type=- prompt="$FREEFORM" | gate)" silent
check "empty session_id -> fails open" \
  "$(payload session_id= agent_id=- agent_type=- prompt="$FREEFORM" | gate)" silent
check "session_id with a path separator -> fails open, no traversal" \
  "$(payload session_id="../../etc/passwd" agent_id=- agent_type=- prompt="$FREEFORM" | gate)" silent
# Traversal is refused, not resolved: a state file planted at the destination
# the payload points to must not be what allows the call. Paired with the deny
# case above, the two together pin refusal rather than mere absence.
mkdir -p "$SANDBOX/escape"
touch "$SANDBOX/escape/planted"
check "a planted file outside the state dir is never consulted" \
  "$(payload session_id="../escape/planted" agent_id=- agent_type=- prompt="$FREEFORM" | gate)" silent

echo "(e) out-of-scope tools:"
for tool in Bash Read Edit Write Task; do
  out=$(printf '%s' "$(main_payload "$FREEFORM")" \
    | jq -c --arg t "$tool" '.tool_name = $t' | gate)
  check "$tool is not gated" "$out" silent
done
out=$(printf '%s' "$(main_payload "$FREEFORM")" | jq -c 'del(.tool_name)' | gate)
check "missing tool_name" "$out" silent

echo "(f) an absent or unusable prompt fails open:"
check "no prompt key" \
  "$(payload session_id="$SESSION" agent_id=- agent_type=- prompt=- | gate)" silent
check "empty prompt" \
  "$(payload session_id="$SESSION" agent_id=- agent_type=- prompt= | gate)" silent
check "whitespace-only prompt" \
  "$(payload session_id="$SESSION" agent_id=- agent_type=- prompt="   " | gate)" silent
out=$(printf '%s' '{"hook_event_name":"PreToolUse","tool_name":"Agent","session_id":"'"$SESSION"'","tool_input":{"prompt":{"not":"a string"}}}' | gate)
check "non-string prompt" "$out" silent
out=$(printf '%s' '{"hook_event_name":"PreToolUse","tool_name":"Agent","session_id":"'"$SESSION"'","tool_input":"not an object"}' | gate)
check "non-object tool_input" "$out" silent

echo "(g) the fixed machine-built dispatch shapes pass:"
run_prompt "Item ID: 369"                       "Item ID: 369"                       silent
run_prompt "Item ID with surrounding whitespace" "  Item ID: 369
"                                                                                    silent
run_prompt "Repo sweep: owner/repo"             "Repo sweep: mike-bronner/phpcs-rules" silent
# The sentinel that used to exempt core's own summary-writer dispatch is GONE.
# It was a bypass string in an enforcement path, and any prompt could wear it.
# The caller now sends a real brief (pinned further down), so the old preamble
# earns no special treatment and is refused like any other slotless prompt.
run_prompt "the retired summary-writer sentinel is NOT exempt" "Process pending session summary.
session_id: d640e864-4bed-4e3c-8b35-85d9e4c79588
marker_path: /Users/mike/.claude-memory-cache/pending-summaries/d640e864.json" deny
# Searched over the gate's CODE lines, for the sentinel phrase itself. The
# needle used to be the whole check, spelled `grep -qE '^[[:space:]]*Process
# pending`, and that made this assertion a hostage to how the gate writes
# whitespace: the move to an ASCII set turned the same needle into a string the
# gate could never contain, so it passed for the wrong reason and would have
# missed a re-introduced sentinel entirely. The phrase cannot go stale that way.
# Comments are stripped because the gate's own (g) block names the retired
# sentinel to explain why it is gone — an unstripped search would match that
# prose and fail on a correct file.
assert_missing "the sentinel is gone from the gate" \
  "$(grep -vE '^[[:space:]]*#' "$GATE")" "Process pending"
# The exemption is anchored at BOTH ends for the two pipeline shapes, so it
# cannot be used as a prefix to smuggle a free-form brief past the gate.
#
# TWO guards enforce that, and they are not interchangeable:
#
#   NONBLANK -eq 1        rejects a second line
#   trailing [[:space:]]*$ rejects trailing content on the SAME line
#
# The multi-line cases below are stopped by the first guard whatever the anchor
# does, so on their own they leave the anchor freely deletable — mutation-tested
# and confirmed: removing it left all 157 cases green while opening a real
# single-line bypass. The single-line cases are the anchor's own coverage.
#
# This is the third instance of one shape in this hook: two guards with
# overlapping coverage, a test reaching only the stronger one, and the weaker
# one silently deletable. The others were the ${ARR+set} fail-open guard and the
# per-slot omission loop against a dual-name check. A test that looks redundant
# beside its neighbour is worth checking before it is trimmed.
run_prompt "Item ID prefix + free prose is NOT exempt" "Item ID: 369
Now go and refactor the whole parser however you see fit." deny
run_prompt "Repo sweep prefix + free prose is NOT exempt" "Repo sweep: a/b
Also rewrite the test suite." deny
# Single line, trailing content. Only the trailing anchor can refuse these, so
# these two are what make it load-bearing.
run_prompt "Item ID + trailing prose on ONE line is NOT exempt" \
  "Item ID: 369 and refactor the whole parser however you see fit" deny
run_prompt "Repo sweep + trailing prose on ONE line is NOT exempt" \
  "Repo sweep: a/b and also rewrite the test suite" deny
run_prompt "Item ID with a non-numeric target is NOT exempt" "Item ID: whatever" deny
run_prompt "Repo sweep with no slug is NOT exempt"          "Repo sweep: notaslug" deny
# ...and the exempt shapes themselves still pass, so the cases above are not
# green merely because the exemption stopped working altogether.
run_prompt "a bare Item ID is still exempt"    "Item ID: 369"                        silent
run_prompt "a bare Repo sweep is still exempt" "Repo sweep: mike-bronner/phpcs-rules" silent

echo "the hint path: advisory, and never a permission grant:"
# Each marker is pinned on its own, so no one marker can mask another.
HINT_FENCE="$GOOD_BRIEF
\`\`\`bash
sed -i '' 's/a/b/' file.sh
\`\`\`"
HINT_SHELL="$GOOD_BRIEF
git rebase -i origin/main"
HINT_STEPS="$GOOD_BRIEF
1. Open the file.
2. Change the regex.
3. Run the suite."
run_prompt "fenced code block flags"            "$HINT_FENCE" hint
run_prompt "shell command on its own line flags" "$HINT_SHELL" hint
run_prompt "three numbered steps flag"           "$HINT_STEPS" hint
# Boundary: the threshold is three, so two must stay silent. Without this pair
# the >=3 comparison could be >=1 and every test above would still pass.
run_prompt "two numbered steps do NOT flag" "$GOOD_BRIEF
1. Open the file.
2. Change the regex." silent
# Prose that merely mentions a command must not flag. This is why the shell
# marker is line-anchored: matched anywhere, it fires on 91% of real briefs.
run_prompt "an inline mention of git does NOT flag" "$GOOD_BRIEF
The reason is that git history shows the guard was added later." silent
# Ordinary English words that open a sentence and also name a command. Each is
# excluded from the command list on purpose, and each is real brief prose. Put
# any one of them back and exactly one of these four goes silent-to-hint.
run_prompt "'make sure ...' does NOT flag" "$GOOD_BRIEF
make sure the suite is green before reporting." silent
run_prompt "'touch only ...' does NOT flag" "$GOOD_BRIEF
touch only the files listed above." silent
run_prompt "'go through ...' does NOT flag" "$GOOD_BRIEF
go through the parser and note what it misses." silent
run_prompt "'sh' as a sentence opener does NOT flag" "$GOOD_BRIEF
sh scripts in this repo follow the same helper layout." silent
# ...but a real command on its own line still flags, so the exclusions above
# did not simply disable the marker.
run_prompt "a real command still flags after the exclusions" "$GOOD_BRIEF
composer update crossbibleinc/bible-models" hint

HINT_OUT="$(main_payload "$HINT_FENCE" | gate)"
assert_contains "the hint names the marker found" "$HINT_OUT" "a fenced code block"
assert_contains "the hint says nothing was blocked" "$HINT_OUT" "nothing was blocked"
# The load-bearing property of the hint path. `additionalContext` alone leaves
# permission behaviour untouched, but a stray "allow" here would silently grant
# a permission the call would otherwise have had to ask for.
assert_missing "the hint carries NO permissionDecision" "$HINT_OUT" "permissionDecision"
assert_missing "the hint never says allow"              "$HINT_OUT" '"allow"'
if printf '%s' "$HINT_OUT" | jq -e '.hookSpecificOutput.hookEventName == "PreToolUse"' >/dev/null 2>&1; then
  PASS=$((PASS + 1)); echo "  ✅ the hint declares the PreToolUse event"
else
  FAIL=$((FAIL + 1)); echo "  ❌ the hint does not declare the PreToolUse event"
fi
# A denied brief gets the deny, not both. Markers are only consulted once the
# template is satisfied.
check "a prescriptive brief MISSING slots is denied, not hinted" \
  "$(main_payload "$FREEFORM
\`\`\`
git status
\`\`\`" | gate)" deny

echo "a realistically long brief is judged quickly:"
# A regression test with teeth. The gate first used "${PROMPT//[[:space:]]/}"
# and a two-step bash trim, both of which are quadratic over a multi-kilobyte
# string: 5.7 KB took 10s, 6.9 KB 18s, 8.0 KB 29s, measured on real briefs whose
# median length is 4,788 characters. Every dispatch would have stalled for tens
# of seconds. Restore either construct and this case blows its budget.
BIG_PROMPT="$GOOD_BRIEF"
while [ "${#BIG_PROMPT}" -lt 12000 ]; do
  BIG_PROMPT="$BIG_PROMPT
Additional context prose that a real brief carries, explaining why the task
exists and what the receiving agent cannot derive from the repository itself."
done
START=$(date +%s)
BIG_OUT="$(main_payload "$BIG_PROMPT" | gate)"
ELAPSED=$(( $(date +%s) - START ))
if [ "$ELAPSED" -le 3 ]; then
  PASS=$((PASS + 1)); echo "  ✅ a ${#BIG_PROMPT}-char brief is judged in ${ELAPSED}s (budget 3s)"
else
  FAIL=$((FAIL + 1)); echo "  ❌ a ${#BIG_PROMPT}-char brief took ${ELAPSED}s, over the 3s budget"
fi
# ...and it is still judged correctly, so the budget is not met by bailing out.
check "the long brief still passes the slot check" "$BIG_OUT" silent
check "a long brief MISSING a slot is still denied" \
  "$(main_payload "${BIG_PROMPT/Goal:/Aim:}" | gate)" deny

echo "errors fail open:"
check "malformed JSON"          "$(printf '%s' 'not json at all {{{' | gate)" silent
check "truncated JSON"          "$(printf '%s' '{"tool_name":"Agent","session_id":' | gate)" silent
check "empty payload"           "$(printf '%s' '' | gate)" silent
check "JSON that is not an object" "$(printf '%s' '["a","json","array"]' | gate)" silent

# jq is the only hard dependency. Without it the gate must allow, never deny.
NOJQ_BIN="$SANDBOX/nojq-bin"
mkdir -p "$NOJQ_BIN"
for tool in bash cat grep sed tr; do
  src="$(command -v "$tool" 2>/dev/null)" && ln -sf "$src" "$NOJQ_BIN/$tool"
done
out=$(main_payload "$FREEFORM" | env -u WORKBENCH_ORCHESTRATOR HOME="$FAKE_HOME" \
  WORKBENCH_ORCHESTRATOR_STATE_DIR="$STATE_DIR" PATH="$NOJQ_BIN" bash "$GATE")
check "jq missing" "$out" silent

echo "the deny payload is well formed:"
DENY_OUT="$(main_payload "$FREEFORM" | gate)"
if printf '%s' "$DENY_OUT" | jq -e . >/dev/null 2>&1; then
  PASS=$((PASS + 1)); echo "  ✅ deny JSON parses"
else
  FAIL=$((FAIL + 1)); echo "  ❌ deny JSON does not parse"
fi
assert_jq_out() {
  local desc="$1" filter="$2" expected="$3" actual
  actual="$(printf '%s' "$DENY_OUT" | jq -r "$filter" 2>/dev/null)"
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected [$expected], got [$actual]"
  fi
}
assert_jq_out "declares the PreToolUse event" '.hookSpecificOutput.hookEventName' "PreToolUse"
assert_jq_out "decision is deny"              '.hookSpecificOutput.permissionDecision' "deny"
assert_contains "reason names the template"   "$DENY_OUT" "five-slot brief"
assert_contains "reason says research counts" "$DENY_OUT" "research included"
assert_contains "reason lists every slot"     "$DENY_OUT" "Done when: (observable finish line)"
assert_contains "reason names the toggle"     "$DENY_OUT" "/workbench-core:orchestrator off"
# The gate must never claim to judge substance — that belongs to the receiving
# agent, and a deny that implies otherwise sends the model chasing a fix the
# hook cannot check.
assert_missing "reason does not claim to judge code work" "$DENY_OUT" "code work"

echo "the deny reason names a dev-team plugin only when one is installed:"
# A runtime directory probe, not a build-time dependency. Core ships the same
# script either way; only the home directory it reads differs between these two
# cases, which is what makes the pair discriminating.
out=$(main_payload "$FREEFORM" | env -u WORKBENCH_ORCHESTRATOR HOME="$DEVTEAM_HOME" \
  WORKBENCH_ORCHESTRATOR_STATE_DIR="$STATE_DIR" bash "$GATE")
check "still denies with the plugin installed" "$out" deny
assert_contains "names the dev team when the plugin cache is present" "$out" "$DEVTEAM_LINE"
assert_missing "stays generic when the plugin cache is absent" "$DENY_OUT" "$DEVTEAM_LINE"
# Routing covers the whole team, not one agent. Naming only Watson here would
# contradict the prose the sibling plugin ships.
assert_missing "does not single out one agent" "$out" "Dr. Watson"

# Registration is part of the behaviour: a gate nothing calls gates nothing.
echo "the hook is registered in hooks.json:"
assert_jq "matcher covers exactly the Agent tool" "$HOOKS_JSON" \
  '[.hooks.PreToolUse[] | select(.hooks[].command | test("agent-dispatch-gate.sh")) | .matcher] | join(",")' \
  "Agent"
assert_jq "registered exactly once" "$HOOKS_JSON" \
  '[.hooks.PreToolUse[].hooks[] | select(.command | test("agent-dispatch-gate.sh"))] | length' "1"
assert_jq "no if condition narrows it" "$HOOKS_JSON" \
  '[.hooks.PreToolUse[] | select(.hooks[].command | test("agent-dispatch-gate.sh")) | .if // empty] | length' "0"

# The harness expands ${CLAUDE_PLUGIN_ROOT} into a shell command line, and an
# unquoted expansion word-splits on a plugin path containing a space (the norm
# under ".../Application Support/Claude/..."). The script is then never found
# and the gate silently fails open.
CMD_TEMPLATE="$(jq -r '
  [.hooks.PreToolUse[] | select(.hooks[].command | test("agent-dispatch-gate.sh")) | .hooks[].command][0] // ""
' "$HOOKS_JSON")"
SPACED_ROOT="$SANDBOX/plugin root"  # deliberate space
mkdir -p "$SPACED_ROOT/hooks/lib"
cp "$GATE" "$SPACED_ROOT/hooks/agent-dispatch-gate.sh"
# The shared definition travels with the gate. Without it the gate fails open,
# which would make this case pass for the wrong reason: silent, but because the
# template was unreadable rather than because the path resolved.
cp "$HOOKS_DIR/lib/brief-template.sh" "$SPACED_ROOT/hooks/lib/brief-template.sh"
out=$(main_payload "$FREEFORM" | env -u WORKBENCH_ORCHESTRATOR HOME="$FAKE_HOME" \
  WORKBENCH_ORCHESTRATOR_STATE_DIR="$STATE_DIR" \
  CLAUDE_PLUGIN_ROOT="$SPACED_ROOT" sh -c "${CMD_TEMPLATE:-false}")
check "gate fires when the plugin path contains a space" "$out" deny

echo "the two gates agree on their shared escape hatches:"
# One toggle stands both gates down. If either side renames the env var or the
# default directory, the human is left with a gate they cannot turn off.
for token in "WORKBENCH_ORCHESTRATOR_STATE_DIR" ".claude-workbench/orchestrator-mode"; do
  assert_grep "dispatch gate uses $token"   "$token" "$GATE"
  assert_grep "delegation gate uses $token" "$token" "$DELEGATION"
  assert_grep "toggle skill uses $token"    "$token" "$SKILL"
done
assert_grep "dispatch gate honours WORKBENCH_ORCHESTRATOR=0" 'WORKBENCH_ORCHESTRATOR:-' "$GATE"

echo "core's own summary-writer dispatch is a real brief, not an exemption:"
# The brief is EXTRACTED from the skill that sends it, never retyped here. If
# the skill drops a slot, this goes red, which is the only thing standing
# between core's memory pipeline and a silent denial now that the sentinel is
# gone.
SUMMARY_BRIEF="$(awk '/^  prompt: \|$/{f=1;next} f&&/^```$/{exit} f{sub(/^    /,"");print}' \
  "$SUMMARY_SKILL")"
if [ -n "$SUMMARY_BRIEF" ]; then
  PASS=$((PASS + 1)); echo "  ✅ the skill's dispatch prompt is extractable"
else
  FAIL=$((FAIL + 1)); echo "  ❌ could not extract the skill's dispatch prompt"
fi
# Placeholders substituted the way the skill instructs, so what is judged is what
# actually gets dispatched.
SUMMARY_REAL="${SUMMARY_BRIEF//\{MEMORY_PATH\}//Users/mike/Documents/Claude/Memory}"
SUMMARY_REAL="${SUMMARY_REAL//\{session_id\}/d640e864-4bed-4e3c-8b35-85d9e4c79588}"
SUMMARY_REAL="${SUMMARY_REAL//\{marker_path\}//Users/mike/.claude-memory-cache/pending-summaries/d640e864.json}"
SUMMARY_REAL="${SUMMARY_REAL//\{log_path\}//Users/mike/Documents/Claude/Memory/sessions/2026-08-19/d640e864.log.md}"
SUMMARY_REAL="${SUMMARY_REAL//\{transcript_path\}//Users/mike/.claude/projects/x/d640e864.jsonl}"
run_prompt "the skill's brief passes the gate unaided" "$SUMMARY_REAL" silent
# The receiving agent parses its inputs from labeled lines and aborts on a
# mismatch, so each label has to survive into the brief. Burying session_id in
# the Goal prose would pass the gate and break the agent.
for label in "session_id:" "marker_path:" "log_path:" "transcript_path:"; do
  assert_contains "the brief carries a labeled $label" "$SUMMARY_REAL" "$label"
done
# ...and it passes because it carries the slots, not because of where it starts.
run_prompt "the skill's brief minus a slot is refused" \
  "$(printf '%s\n' "$SUMMARY_REAL" | grep -v '^Goal:')" deny
assert_missing "no unsubstituted placeholder remains" "$SUMMARY_REAL" "{"
assert_missing "the skill no longer emits the sentinel" "$(cat "$SUMMARY_SKILL")" \
  'Process pending session summary.'
# Workdir: carries the vault root, and the skill resolves it through the repo's
# existing single source of truth rather than hardcoding a path.
assert_grep "the skill resolves the vault via memory-env" 'lib/memory-env.sh' "$SUMMARY_SKILL"

echo "the shared definition is the only place the slots are written:"
# The drift guard. The gate greps patterns from hooks/lib/brief-template.sh and
# the deny message prints descriptions from it. If a consumer ever restates a
# slot inline again, these go red.
# shellcheck source=hooks/lib/brief-template.sh
. "$HOOKS_DIR/lib/brief-template.sh"
if [ "${#WORKBENCH_BRIEF_SLOTS[@]}" -eq 5 ]; then
  PASS=$((PASS + 1)); echo "  ✅ the definition holds exactly five slots"
else
  FAIL=$((FAIL + 1)); echo "  ❌ the definition holds ${#WORKBENCH_BRIEF_SLOTS[@]} slots, expected 5"
fi
# Every slot in the definition is actually enforced: drop it from an otherwise
# complete brief and the gate must refuse, naming that slot. This is what makes
# the definition load-bearing rather than decorative — add a sixth record and
# this loop demands the gate enforce it too.
for record in "${WORKBENCH_BRIEF_SLOTS[@]}"; do
  header="$(brief_slot_field "$record" 1)"
  pattern="$(brief_slot_field "$record" 2)"
  stripped="$(printf '%s\n' "$GOOD_BRIEF" | grep -viE "$pattern")"
  out="$(main_payload "$stripped" | gate)"
  check "definition slot '$header' is enforced by the gate" "$out" deny
  assert_contains "the deny names '$header'" "$out" "Missing: $header"
done
# The gate must not restate any slot header itself — the loop is the only reader.
for record in "${WORKBENCH_BRIEF_SLOTS[@]}"; do
  header="$(brief_slot_field "$record" 1)"
  if grep -qF "add_missing \"$header\"" "$GATE"; then
    FAIL=$((FAIL + 1)); echo "  ❌ the gate restates '$header' inline"
  else
    PASS=$((PASS + 1)); echo "  ✅ the gate does not restate '$header' inline"
  fi
done
# The deny message's slot list is generated, so every description must appear.
DENY_SLOTS="$(main_payload "$FREEFORM" | gate)"
for record in "${WORKBENCH_BRIEF_SLOTS[@]}"; do
  assert_contains "the deny message carries '$(brief_slot_field "$record" 1)' and its description" \
    "$DENY_SLOTS" "$(brief_slot_field "$record" 1) ($(brief_slot_field "$record" 3))"
done
# The README documents the same five headers. It is static prose and cannot
# derive at runtime, so a test is what keeps it honest.
for record in "${WORKBENCH_BRIEF_SLOTS[@]}"; do
  assert_grep "README documents the '$(brief_slot_field "$record" 1)' slot" \
    "$(brief_slot_field "$record" 1)" "$README"
done
assert_grep "README points at the shared definition" 'hooks/lib/brief-template.sh' "$README"
# Workdir: carrying a branch is documented in exactly two places — the
# description the deny message prints, and the README gloss, which is static
# prose. Pin both, so reverting one half fails instead of passing on the other
# half's text. The README assertion is scoped to the Workdir row rather than run
# over the whole file, where any prose mentioning a branch would satisfy it.
WORKDIR_RECORD=""
for record in "${WORKBENCH_BRIEF_SLOTS[@]}"; do
  [ "$(brief_slot_field "$record" 1)" = "Workdir:" ] && WORKDIR_RECORD="$record"
done
assert_contains "the definition's Workdir: description names the branch" \
  "$(brief_slot_field "$WORKDIR_RECORD" 3)" "branch"
assert_contains "the README's Workdir: row names the branch" \
  "$(grep -E '^[[:space:]]*Workdir:' "$README")" "branch"

echo "an unreadable definition fails open, never closed:"
# One missing file must not turn into a session where every handoff is refused.
NOLIB="$SANDBOX/nolib"
mkdir -p "$NOLIB/hooks/lib"
cp "$GATE" "$NOLIB/hooks/agent-dispatch-gate.sh"
out=$(main_payload "$FREEFORM" | env -u WORKBENCH_ORCHESTRATOR HOME="$FAKE_HOME" \
  WORKBENCH_ORCHESTRATOR_STATE_DIR="$STATE_DIR" bash "$NOLIB/hooks/agent-dispatch-gate.sh")
check "a missing definition allows rather than denies" "$out" silent
# A file that sources cleanly but defines no array. Under `set -u` a bare
# ${#ARRAY[@]} aborts here with an unbound-variable error, so this case also
# pins that the guard uses the +set form. Stderr is asserted empty: failing open
# loudly is still a bug.
printf '%s\n' '#!/usr/bin/env bash' '# truncated: defines nothing' \
  > "$NOLIB/hooks/lib/brief-template.sh"
NOLIB_ERR="$SANDBOX/nolib.err"
out=$(main_payload "$FREEFORM" | env -u WORKBENCH_ORCHESTRATOR HOME="$FAKE_HOME" \
  WORKBENCH_ORCHESTRATOR_STATE_DIR="$STATE_DIR" bash "$NOLIB/hooks/agent-dispatch-gate.sh" \
  2>"$NOLIB_ERR")
check "a definition that defines no array allows" "$out" silent
if [ -s "$NOLIB_ERR" ]; then
  FAIL=$((FAIL + 1)); echo "  ❌ it failed open noisily: $(head -1 "$NOLIB_ERR")"
else
  PASS=$((PASS + 1)); echo "  ✅ ...and it does so silently, with no bash error"
fi
# A DEFINED BUT EMPTY array. On bash 3.2 — macOS's system bash, and what these
# hooks run under — "${ARR[@]}" under `set -u` is an unbound-variable error, so
# without the -gt 0 guard the slot loop aborts the script rather than looping
# zero times. Bash 5 on the CI runner loops fine, which is precisely why the
# stderr assertion matters: without it this platform difference passes CI and
# fails on the developer's machine.
printf '%s\n' '#!/usr/bin/env bash' 'WORKBENCH_BRIEF_SLOTS=()' > "$NOLIB/hooks/lib/brief-template.sh"
out=$(main_payload "$FREEFORM" | env -u WORKBENCH_ORCHESTRATOR HOME="$FAKE_HOME" \
  WORKBENCH_ORCHESTRATOR_STATE_DIR="$STATE_DIR" bash "$NOLIB/hooks/agent-dispatch-gate.sh" \
  2>"$NOLIB_ERR")
check "an empty definition allows rather than denies" "$out" silent
if [ -s "$NOLIB_ERR" ]; then
  FAIL=$((FAIL + 1)); echo "  ❌ empty definition failed open noisily: $(head -1 "$NOLIB_ERR")"
else
  PASS=$((PASS + 1)); echo "  ✅ ...and it does so silently, with no bash error"
fi
# ...and a definition that IS readable still gates, so the two cases above are
# not passing because the copied gate is broken.
cp "$HOOKS_DIR/lib/brief-template.sh" "$NOLIB/hooks/lib/brief-template.sh"
out=$(main_payload "$FREEFORM" | env -u WORKBENCH_ORCHESTRATOR HOME="$FAKE_HOME" \
  WORKBENCH_ORCHESTRATOR_STATE_DIR="$STATE_DIR" bash "$NOLIB/hooks/agent-dispatch-gate.sh")
check "the same gate with a readable definition still denies" "$out" deny

echo "the README documents the gate:"
assert_grep "README names the script"      'hooks/agent-dispatch-gate.sh' "$README"
assert_grep "README names the test suite"  'hooks/test-agent-dispatch-gate.sh' "$README"
assert_grep "README documents fail-open"   'enforcement stops silently' "$README"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
