#!/bin/bash
# Tests for hooks/credential-guard.sh — the PreToolUse credential-path guard.
# Run directly: ./test-credential-guard.sh
# Each case feeds the hook one PreToolUse payload on stdin and asserts its
# VERDICT: deny (the call is refused) or allow (nothing is printed, so the normal
# permission flow applies). Pure stdin/stdout checks — no network, no server, and
# nothing is ever read off disk.
#
# The verdict is read out of the hook's JSON, never out of an exit code. The
# guard used to block by exiting 2, which prefixed the model's message with the
# guard's own absolute filesystem path and threw stdout away; it now returns
# permissionDecision "deny" on exit 0, which refuses the call just as hard and
# leaves the author in control of the first line a person reads. The switch adds
# no fail-open path: stage 1, the decision itself, already ran inside jq.
#
# Paths are built from $HOME so the suite is portable to CI, where the home
# directory is not /Users/mike.

set -u
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
GUARD="$HOOKS_DIR/credential-guard.sh"
HOOKS_JSON="$HOOKS_DIR/hooks.json"
PASS=0
FAIL=0

# The three readers every case below goes through. `verdict_of` treats silence
# as an allow, which is what the harness does: only a printed permissionDecision
# changes anything.
verdict_of() {
  local decision
  decision=$(printf '%s' "$1" | jq -r '.hookSpecificOutput.permissionDecision // empty' 2>/dev/null)
  echo "${decision:-allow}"
}
reason_of()  { printf '%s' "$1" | jq -r '.hookSpecificOutput.permissionDecisionReason // empty' 2>/dev/null; }
context_of() { printf '%s' "$1" | jq -r '.hookSpecificOutput.additionalContext // empty' 2>/dev/null; }

# check_guard <guard-path> <deny|allow> <description> <payload-json>
# Takes the guard as an argument so the fail-closed cases can run a COPY of it
# from a temp directory that has no stage-2 checker beside it.
check_guard() {
  local guard="$1" expected="$2" desc="$3" payload="$4" actual
  actual=$(verdict_of "$(printf '%s' "$payload" | bash "$guard" 2>/dev/null)")
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected $expected, got $actual"
  fi
}

# check <deny|allow> <description> <payload-json>
check() { check_guard "$GUARD" "$@"; }

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
  if printf '%s\n' "$haystack" | grep -qF "$needle"; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — output missing: $needle"
  fi
}

# THE COMMAND REACHES jq ON STDIN, NOT AS AN ARGUMENT. `--arg c "$1"` puts the
# whole command in one argv entry, and Linux caps a single argument at
# MAX_ARG_STRLEN — 32 pages, 128KB on a 4KB-page system — independently of the
# total ARG_MAX budget. The read-ceiling cases below feed 200,000 characters and
# more, so the argv form dies with "Argument list too long" there, hands the
# guard an EMPTY payload, and the case then passes or fails for a reason that
# has nothing to do with the ceiling it exists to pin. macOS caps only the
# total, so the argv form looks fine here and breaks on a Linux runner. Measured
# that way once already; the full note is in hooks/test-destructive-scope-guard.sh.
#
# `printf` is a bash builtin, so the command never crosses an execve on its way
# to the pipe. `-R` reads stdin raw and `-s` slurps it whole, so `.` is the
# whole command — newlines, quotes and backslashes intact — and `printf '%s'`
# appends nothing, so an empty command still produces "".
bash_json() { printf '%s' "$1" | jq -Rsc '{tool_name: "Bash", tool_input: {command: .}}'; }
file_json() { jq -nc --arg t "$1" --arg p "$2" '{tool_name: $t, tool_input: {file_path: $p}}'; }

# The guard's BEFORE/AFTER boundary classes are the only [[:space:]] left in a
# hook that judges untrusted input. Every sibling spells the set out in ASCII,
# because grep and bash both read that class from the C library: glibc excludes
# U+00A0, U+202F and U+2007 in every locale, Darwin includes them, and one input
# then gets two verdicts on two platforms.
#
# These two survive because they never reach a C library — jq evaluates them
# with the Oniguruma engine vendored in its own binary. The two cases below pin
# that, at both levels, because a test of the engine is not a test of the call
# site that rests on it:
#
#   1. the engine answers the same regardless of locale, and
#   2. the guard itself still blocks when the boundary is an exotic space.
#
# CI runs this on glibc, which is what turns "should not diverge" into a
# measured fact. If a future jq changes its tables, case 1 goes red here rather
# than the guard quietly growing a platform-dependent hole.
echo "jq's [[:space:]] is locale- and libc-independent (the boundary classes rest on it):"
check_jq_space() {
  local desc="$1" cp="$2" want="$3" got
  got=$(LC_ALL=C jq -rn --argjson cp "$cp" \
    '("X" + ([$cp] | implode) + "Y") | test("X[[:space:]]Y")' 2>/dev/null)
  if [ "$got" = "$want" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected $want, got ${got:-<none>}"
  fi
}
check_jq_space "U+00A0 NBSP is space to jq under LC_ALL=C"   160  true
check_jq_space "U+202F NNBSP is space to jq under LC_ALL=C"  8239 true
check_jq_space "U+2007 FIGURE SPACE is space under LC_ALL=C" 8199 true
check_jq_space "U+3000 IDEOGRAPHIC SPACE is space too"       12288 true
check_jq_space "a letter is still not space"                 65   false

echo "blocks Bash commands that read a credential directory:"
# Case 2 of the pair above: the boundary class doing its job at the call site.
# An NBSP before the path is what BEFORE has to accept for this to block, so
# this reddens if the class ever stops matching one.
check deny "NBSP boundary before a key path" \
  "$(bash_json "$(printf 'cat foo\302\240~/.ssh/id_rsa')")"
check deny "cat a key via ~"          "$(bash_json 'cat ~/.ssh/id_rsa')"
check deny "cat a key via abs path"   "$(bash_json "cat $HOME/.ssh/id_rsa")"
check deny "\$HOME expansion"         "$(bash_json 'cat "$HOME/.ssh/id_rsa"')"
check deny "\${HOME} expansion"       "$(bash_json 'cat "${HOME}/.ssh/id_rsa"')"
check deny "grep into ~/.aws"         "$(bash_json 'grep -rn key ~/.aws/credentials')"
check deny "cp out of ~/.gnupg"       "$(bash_json 'cp ~/.gnupg/secring.gpg /tmp/x')"
# The whole point of replacing the Read() deny rule: it never caught this one.
check deny "python subprocess read"   "$(bash_json "python3 -c \"print(open('$HOME/.ssh/id_rsa').read())\"")"

# Stage 2 (hooks/lib/credential-check.py) refines these: a dotenv hit blocks
# only when the `.env` sits in an argument SLOT. Every case here puts it in one.
echo "blocks Bash commands that read a dotenv file:"
check deny "grep a secret out of .env" "$(bash_json 'grep DB_PASSWORD .env')"
check deny "cat .env.production"       "$(bash_json 'cat .env.production')"
check deny "cat .env.local"            "$(bash_json 'cat .env.local')"
check deny "a quoted path, no spaces"  "$(bash_json 'cat "$HOME/app/.env"')"
# The reader that the removed Read() deny rule could never see, in its dotenv
# form. The token holds no whitespace, so the prose rule does not clear it.
check deny "python3 opens a dotenv"    "$(bash_json "python3 -c \"print(open('.env').read())\"")"
# A heredoc body is lifted out before tokenising, but it is still SCANNED. Drop
# that and `python3 <<PY … open('.env') … PY` becomes an open door.
HEREDOC_READ=$(cat <<'OUTER'
python3 - <<'PY'
print(open('.env').read())
PY
OUTER
)
check deny "a dotenv read in a heredoc" "$(bash_json "$HEREDOC_READ")"
# `.env.example.bak` is not a template: TEMPLATE_RE anchors on the end of the
# path component, so a suffix past the template name leaves the hit standing.
check deny "a template with a suffix"  "$(bash_json 'cat .env.example.bak')"

echo "blocks the file tools on a protected path:"
check deny "Read on .env"             "$(file_json Read "$HOME/Developer/app/.env")"
check deny "Read on ~/.aws"           "$(file_json Read "$HOME/.aws/credentials")"
check deny "Edit on ~/.gnupg"         "$(file_json Edit "$HOME/.gnupg/gpg.conf")"
check deny "Write on ~/.ssh"          "$(file_json Write "$HOME/.ssh/authorized_keys")"
check deny "NotebookEdit on ~/.ssh"   "$(jq -nc --arg p "$HOME/.ssh/id_rsa" \
  '{tool_name: "NotebookEdit", tool_input: {notebook_path: $p}}')"

# A protected path alone must not block. Listing names exposes no secret, and
# blocking these would make the hook its own source of prompt noise — the exact
# failure the removed Read() deny rules were guilty of.
echo "allows commands that name a protected path without reading it:"
check allow "ls ~/.ssh"                "$(bash_json 'ls -la ~/.ssh')"
check allow "stat a key"               "$(bash_json 'stat ~/.ssh/id_rsa')"
check allow "find -name .env*"         "$(bash_json "find $HOME/Developer/x -name \".env*\"")"

echo "allows unrelated work:"
# The prompt class this whole change exists to kill: cd + a relative path.
check allow "the cd+grep case"         "$(bash_json "cd $HOME/Developer/x && grep -rn foo vendor/")"
check allow "grep inside a project"    "$(bash_json "grep -rn foo $HOME/Developer/x/")"
check allow "echo mentioning .env"     "$(bash_json 'echo "remember to set your .env"')"
check allow ".envrc is out of scope"   "$(bash_json "cat $HOME/Developer/x/.envrc")"
check allow "unrelated .ssh directory" "$(bash_json "cat $HOME/Developer/x/.ssh/notes.txt")"
# `~` only means home at the start of a word. A directory whose name merely
# ends in one is an ordinary tree — this is what DIR_RE's leading group buys.
check allow "a tilde-suffixed sibling" "$(bash_json "cat $HOME/Developer/backup~/.ssh/id_rsa")"
check allow "Read an ordinary file"    "$(file_json Read "$HOME/Developer/x/README.md")"
check allow "an unmatched tool name"   "$(file_json Grep "$HOME/.ssh/id_rsa")"

# The false positives stage 2 exists to kill. Every one of these ran on
# 2026-09-04 or is the same shape as one that did, and not one opens a file.
# The rule: a path is a token with no whitespace in it, and the shell has
# already collapsed the quotes around a sentence, so prose is one token FULL of
# whitespace. Delete the whitespace test in credential-check.py and this whole
# block reddens.
echo "allows prose that merely names a dotenv file:"
check allow "a sentence via python3 -c" \
  "$(bash_json "python3 -c \"print('remember to set your .env before running')\"")"
check allow "a quoted sentence to grep" \
  "$(bash_json 'grep -n "update the .env file" docs/setup.md')"
# The reported case, near enough verbatim: a heredoc whose prose names two
# dotenv files. It blocked three times in one session and read nothing.
HEREDOC_PROSE=$(cat <<'OUTER'
python3 - <<'PY'
print("copy .env.example to .env, then fill in the values")
PY
OUTER
)
check allow "a heredoc naming dotenvs"  "$(bash_json "$HEREDOC_PROSE")"

# Committed templates hold placeholder values by convention, not secrets. The
# suffix list lives twice — TMPL_RE in the guard, TEMPLATE_RE in the checker —
# so every member is pinned here; drop one from either list and its case goes
# red rather than quietly widening the block.
echo "allows the committed dotenv templates:"
check allow "cat .env.example"          "$(bash_json 'cat .env.example')"
check allow "cat .env.sample"           "$(bash_json 'cat .env.sample')"
check allow "cat .env.template"         "$(bash_json 'cat .env.template')"
check allow "cat .env.dist"             "$(bash_json 'cat .env.dist')"
check allow "cat .env.default"          "$(bash_json 'cat .env.default')"
check allow "cat .env.defaults"         "$(bash_json 'cat .env.defaults')"
check allow "Read a template"           "$(file_json Read "$HOME/Developer/app/.env.example")"
check allow "Edit a template"           "$(file_json Edit "$HOME/Developer/app/.env.dist")"
# Per token, not per command: a template in the argument list clears itself and
# nothing else. A whole-string test would clear the real dotenv beside it.
check deny "a template beside a real one" "$(bash_json 'cat .env.example .env')"

# KNOWN LIMIT, asserted so the next reader sees a decision rather than a bug.
# Stage 2 reads the argument SLOT, and it cannot tell a search pattern or a jq
# path expression from a filename: both are bare tokens with no whitespace, in
# the slot a filename would occupy. Closing this needs per-program argument
# knowledge (which grep operands are patterns, which are paths), which is a
# much larger rule set than the false positives left justify.
echo "still blocks a bare dotenv token that is not a path — the stated limit:"
check deny "a grep search pattern"     "$(bash_json 'grep -rn "\.env" docs/')"
check deny "a jq path expression"      "$(bash_json 'jq ".env.WORKBENCH" settings.json')"
# The same limit from the other side, and a fail-closed path in its own right:
# a segment that will not tokenise keeps the block. Stage 2 must never relax a
# block over text it could not read, so an unbalanced quote blocks.
check deny "an unterminated quote"     "$(bash_json "cat 'notes about .env")"
# The heredoc form of it. A body is not shell, so a bare apostrophe outside a
# string defeats shlex where the same word inside one parses fine. Built with
# printf rather than the heredoc the two cases above use, because bash's own
# command-substitution scanner mis-reads that apostrophe inside `$(cat <<…)`.
HEREDOC_UNPARSED=$(printf '%s\n' "python3 - <<'PY'" "it's the .env file" "PY")
check deny "a heredoc body shlex rejects" "$(bash_json "$HEREDOC_UNPARSED")"

echo "allows anything it cannot parse — this hook is not an OS boundary:"
check allow "malformed json"           'not json at all'
check allow "empty object"             '{}'

# Stage 2 may only NARROW a block, so a checker that cannot run has to leave
# that block in place — the opposite of the sibling guards, which all fail open.
# Both cases run a COPY of the guard from a temp directory: a suite that moves
# the live checker aside leaves the machine unguarded if it is interrupted
# between the move and the restore.
echo "keeps the block when stage 2 cannot run — this guard fails closed:"
FAILCLOSED=$(mktemp -d)
trap 'rm -rf "$FAILCLOSED"' EXIT
cp "$GUARD" "$FAILCLOSED/credential-guard.sh"
check_guard "$FAILCLOSED/credential-guard.sh" deny "the checker is missing" \
  "$(bash_json 'grep DB_PASSWORD .env')"
# Not redundant with the case above, and the reason is the whole design of the
# stdout sentinel: a Python traceback exits 1, which is the code the checker
# returns for ALLOW. Only the missing `allow` on stdout separates them. The
# payload is one the working checker would allow, so a guard reading the exit
# code alone would let a crashed checker clear it.
mkdir -p "$FAILCLOSED/lib"
printf 'raise RuntimeError("boom")\n' > "$FAILCLOSED/lib/credential-check.py"
check_guard "$FAILCLOSED/credential-guard.sh" deny "the checker raises" \
  "$(bash_json 'cat .env.example')"

# THE READ CEILING IS THE THIRD WAY STAGE 2 CANNOT READ ITS INPUT, and it is
# asserted as a PAIR one byte apart, because every refusal this guard prints
# reads the same whatever branch produced it. A single deny would prove nothing:
# the prose rule, the template rule and the unparseable branch all deny too. The
# pair leaves the length as the only difference between an allow and a block, so
# the length is what decided.
#
# `pad_to` builds a command of EXACTLY <total> characters, ending in <tail>. The
# padding is one `echo` argument: it tokenises cleanly and matches no rule, so
# only the tail can move a verdict. 200000 is the checker's declared MAX_INPUT,
# read with one byte of headroom, so 200000 is the last length it reads whole
# and 200001 is the first it cannot.
pad_to() {
  python3 -c 'import sys
total, tail = int(sys.argv[1]), sys.argv[2]
head = "echo "
sys.stdout.write(head + "x" * (total - len(head) - len(tail) - 2) + "; " + tail)' "$1" "$2"
}
echo "keeps the block for a command past the checker's read ceiling:"
CEILING_TAIL='cat "a note about the .env file"'
UNDER=$(pad_to 200000 "$CEILING_TAIL")
OVER=$(pad_to 200001 "$CEILING_TAIL")
# The two lengths ARE the premise of the pair, so they are measured rather than
# assumed. A padding bug that left both under the ceiling would leave the allow
# case green and prove nothing, which is the shape of failure this pair exists
# to rule out.
if [ "${#UNDER}" = "200000" ] && [ "${#OVER}" = "200001" ]; then
  PASS=$((PASS + 1)); echo "  ✅ the pair straddles the ceiling exactly (${#UNDER} / ${#OVER})"
else
  FAIL=$((FAIL + 1)); echo "  ❌ the pair misses the ceiling (${#UNDER} / ${#OVER}), so neither case pins it"
fi
check allow "at the ceiling exactly, the prose rule still clears it" "$(bash_json "$UNDER")"
check deny  "one byte past it, the same command keeps the block"     "$(bash_json "$OVER")"
# And the bypass itself, in the shape it was measured in on 2026-09-21: the
# dotenv read sits PAST the cutoff, where a truncated read cannot see it. This
# payload came back as an allow while the bare `cat .env` denied.
check deny "a dotenv read hidden past the read ceiling" \
  "$(bash_json "$(python3 -c "print('echo ' + 'x' * 200000); print('cat .env')")")"
# THE SAME BYPASS, PADDED WITH SPACES INSTEAD OF `x`. The padding is an INPUT,
# not filler: 200,001 whitespace characters `.strip()` to "", so a checker that
# tests emptiness above its length check reads this as an empty command. In the
# vault-git checker that returned silence, and the first cut of this fix shipped
# with it.
#
# THIS CASE PINS NEITHER BRANCH. It is here to document a handled shape, and the
# comment says so because a case that claims coverage it does not have is worse
# than no case. Whitespace padding blocks at this guard however the two branches
# are ordered: both return BLOCK, and both are silent, so nothing in the output
# can name which one answered. MEASURED, not reasoned — the mutations and their
# colours: reverting the read to MAX_INPUT, green; dropping the length refusal,
# green; relaxing the empty-command branch, green. Only rewriting a branch to
# print the allow sentinel outright moves it, and that mutation reddens the
# `x`-padded case and the OVER half of the straddle pair as well. The length
# branch is pinned in this suite by those two cases, and not by this one.
#
# THE RULE UNDERNEATH, for the next suite that needs it: two branches returning
# the same verdict cannot be told apart by a test asserting only the verdict.
# Discriminating them needs output that NAMES the branch. That is why the
# whitespace cases in the scope, database and provisioning suites do
# discriminate — each asserts a ceiling refusal that prints its own line — and
# why this one cannot, since silence is this checker's refusal by design.
check deny "a dotenv read hidden behind whitespace padding" \
  "$(bash_json "$(python3 -c "print(' ' * 200001); print('cat .env')")")"
unset CEILING_TAIL UNDER OVER

# The refusal is split across the hook's two channels, and each half is asserted
# on the channel it belongs to. The human line is ONE line naming the ACTION —
# which of the guard's two kinds was read — and nothing else.
echo "the human line names the action, in one line, per kind:"
OUT=$(bash_json 'cat ~/.ssh/id_rsa' | bash "$GUARD" 2>/dev/null)
REASON=$(reason_of "$OUT")
assert_contains "leads with the action"  "$REASON" "🛑 Blocked: reading a credential directory."
assert_contains "offers the ! escape"    "$REASON" "! prefix"
if [ "$(printf '%s' "$REASON" | wc -l | tr -d ' ')" = "0" ] && [ "${#REASON}" -le 120 ]; then
  PASS=$((PASS + 1)); echo "  ✅ is one line and stays short (${#REASON} chars)"
else
  FAIL=$((FAIL + 1)); echo "  ❌ the human line grew past one short line (${#REASON} chars)"
fi
# The matched path is the noise a person was asked to stop reading, and it is a
# credential path, so it does not belong in the line a terminal scrolls either.
if printf '%s' "$REASON" | grep -qF "id_rsa"; then
  FAIL=$((FAIL + 1)); echo "  ❌ the human line replays the path"
else
  PASS=$((PASS + 1)); echo "  ✅ the human line replays no path"
fi
if printf '%s' "$REASON" | grep -qF "**"; then
  FAIL=$((FAIL + 1)); echo "  ❌ the human line uses Markdown emphasis"
else
  PASS=$((PASS + 1)); echo "  ✅ the human line carries no Markdown emphasis"
fi

echo "the detail the model needs survives, in additionalContext:"
CONTEXT=$(context_of "$OUT")
assert_contains "names the guard"        "$CONTEXT" "Credential guard"
assert_contains "names what was touched" "$CONTEXT" "a protected credential directory"

OUT=$(bash_json 'grep DB_PASSWORD .env' | bash "$GUARD" 2>/dev/null)
assert_contains "the dotenv kind has its own action line" \
  "$(reason_of "$OUT")" "🛑 Blocked: reading a .env file."
assert_contains "names the dotenv hit"   "$(context_of "$OUT")" "a .env file"

# The file tools get the same split. Their detail carries the path, which is the
# one fact the model needs to pick a different file and the one a person does
# not need in their way.
OUT=$(file_json Read "$HOME/.aws/credentials" | bash "$GUARD" 2>/dev/null)
assert_contains "a file-tool deny names the action too" \
  "$(reason_of "$OUT")" "🛑 Blocked: reading a credential directory."
assert_contains "and puts the path in the model's half" \
  "$(context_of "$OUT")" "$HOME/.aws/credentials"

# Registration is part of the behaviour: a guard nothing calls guards nothing.
# The matcher is deliberately every file-touching tool with no `if` condition —
# a pre-filter that misses a case is a hole in the guard.
echo "the hook is registered globally in hooks.json:"
assert_jq "matcher covers every file tool" "$HOOKS_JSON" \
  '[.hooks.PreToolUse[] | select(.hooks[].command | test("credential-guard.sh")) | .matcher] | join(",")' \
  "Bash|Read|Edit|Write|NotebookEdit"
assert_jq "registered exactly once" "$HOOKS_JSON" \
  '[.hooks.PreToolUse[].hooks[] | select(.command | test("credential-guard.sh"))] | length' "1"
assert_jq "no if condition narrows it" "$HOOKS_JSON" \
  '[.hooks.PreToolUse[] | select(.hooks[].command | test("credential-guard.sh")) | .if // empty] | length' "0"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
