#!/bin/bash
# Tests for hooks/destructive-scope-guard.sh — the PreToolUse guard that permits
# a destructive command whose every target resolves inside the project or a
# scratch root, and refuses one that reaches outside or that it cannot read.
# Run directly: ./test-destructive-scope-guard.sh
#
# Each case feeds the hook one PreToolUse payload on stdin and asserts its
# VERDICT: allow (the call goes through unprompted), deny (the call is refused),
# or neutral (nothing is printed, so the ordinary permission flow applies).
# Pure stdin/stdout checks — no network, and nothing on disk is deleted by any
# case here, because the guard's only outputs are JSON.
#
# THE SUITE IS WEIGHTED AT ONE FAILURE ABOVE ALL OTHERS, AND IT IS NOT THE ONE
# THE SIBLING SUITES ARE WEIGHTED AT.
#
# Every other guard in this repo fails open, and their suites are weighted at
# OVER-REACH: a deny costs the whole command, and an unparseable command fell
# through to `Bash(rm -rf:*)` in permissions.ask, so a miss cost one prompt.
# Those ask entries are gone. This guard is the only thing standing between a
# destructive command and the auto-mode classifier, so the failure that matters
# here is a SILENT PASS: a command whose targets the guard could not resolve,
# waved through because nothing said otherwise.
#
# So the fail-closed block below is the heart of the suite. Every case in it
# asserts `deny`, and each one is a shape the retired hooks/lib/
# scratch-delete-check.py documented as printing nothing: `bash -c`, `ssh`,
# `xargs`, `find -delete`, globs, `$variables`, command substitution. They were
# holes-that-prompted there; they are denies here.
#
# WHICH ROOTS THE CASES RUN AGAINST. The project root, because
# CLAUDE_PROJECT_DIR is set for hook commands and a test can set it too, and the
# session scratchpad, because it is found by matching the session id and a test
# can stand one up. The other two roots — the login home's Developer/scratchpad
# and this account's per-user temporary directory — are deliberately NOT
# exercised: they come from the password database and from getconf, and neither
# ignores a test the way it ignores an attacker. They ignore it identically,
# which is the property that makes them trustworthy roots.

set -u
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$HOOKS_DIR/.." && pwd)"
GUARD="$HOOKS_DIR/destructive-scope-guard.sh"
HOOKS_JSON="$HOOKS_DIR/hooks.json"
PASS=0
FAIL=0

# The fixture tree sits in /tmp, which is under no real root: the session glob
# needs a `claude-` prefix at that level, the login home is elsewhere, and on
# Darwin /tmp resolves to /private/tmp rather than into the /private/var/folders
# tree the temporary root lives in. A victim that a bug could delete has to sit
# somewhere the guard will never approve, or a case asserting it survives proves
# nothing.
SANDBOX="/tmp/dscope-sandbox-$$"
FAKE_TMP="/tmp/claude-dscope-test-$$"
trap 'rm -rf "$SANDBOX" "$FAKE_TMP"' EXIT

SID="dscope-$$-aaaa"
OTHER_SID="dscope-$$-bbbb"

PROJECT="$SANDBOX/project"
SCRATCH="$FAKE_TMP/-fake-project/$SID/scratchpad"
# A second session's scratchpad, identical in shape and approved for nobody
# here. The guard must never permit a delete of another session's work.
OTHER_SCRATCH="$FAKE_TMP/-fake-project/$OTHER_SID/scratchpad"
# Outside every root, reachable from the project only by traversal.
VICTIM="$SANDBOX/victim"

# The `~` directory is literal, and it makes the tilde case discriminate. With
# it on disk, a guard that failed to notice the `~` in `rm -rf ~/sub` would
# resolve that text against the cwd, find a real directory inside the project,
# and permit a delete the shell was never going to perform — it would have
# expanded `~` and deleted something in the home directory instead.
mkdir -p "$PROJECT/sub" "$PROJECT/~/sub" "$SCRATCH/sub" "$OTHER_SCRATCH" \
         "$VICTIM"
echo "project" > "$PROJECT/file.txt"
echo "do not delete" > "$VICTIM/keep.txt"
echo "another session's work" > "$OTHER_SCRATCH/file.txt"
ln -s "$VICTIM" "$PROJECT/escape"

# A sibling of the project whose path SHARES ITS PREFIX. Nothing here needs it
# except the containment test, and that is the point: with `beneath` reduced to
# a bare `startswith(root)`, "$PROJECT-evil/..." reads as inside the project,
# and every other case in this suite stays green. A mutation proved exactly
# that, so the fixture exists to make the mutation red.
PREFIX_TWIN="$SANDBOX/project-evil"
mkdir -p "$PREFIX_TWIN"
echo "not the project" > "$PREFIX_TWIN/keep.txt"

# Two git worktrees: one inside the project, one outside every root. The git
# verbs destroy uncommitted state inside a worktree, so the worktree root is
# what the scope question is asked about.
IN_REPO="$PROJECT/repo"
OUT_REPO="$SANDBOX/outside-repo"
mkdir -p "$IN_REPO" "$OUT_REPO"
git -C "$IN_REPO" init -q . 2>/dev/null
git -C "$OUT_REPO" init -q . 2>/dev/null

# run_guard — stdin is the payload. The session id reaches the guard through the
# PAYLOAD, so CLAUDE_CODE_SESSION_ID is unset here: any case that passes is
# passing on the payload's id alone. $1 overrides the project root, so the
# no-project case can be exercised.
run_guard() {
  (unset CLAUDE_CODE_SESSION_ID
   CLAUDE_PROJECT_DIR="${1-$PROJECT}" bash "$GUARD")
}

verdict_of() {
  local decision
  decision=$(printf '%s' "$1" | jq -r '.hookSpecificOutput.permissionDecision // empty' 2>/dev/null)
  echo "${decision:-neutral}"
}
reason_of()  { printf '%s' "$1" | jq -r '.hookSpecificOutput.permissionDecisionReason // empty' 2>/dev/null; }
context_of() { printf '%s' "$1" | jq -r '.hookSpecificOutput.additionalContext // empty' 2>/dev/null; }

# payload <command> [cwd] [session-id]
# `${2-}` rather than `${2:-}`: an EMPTY cwd is a case under test and must reach
# the payload instead of being defaulted away. Same for the session id.
#
# THE COMMAND REACHES jq ON STDIN, NOT AS AN ARGUMENT, AND THAT IS LOAD-BEARING.
# `--arg c "$1"` put the whole command in a single argv entry, and Linux caps
# ONE argument at MAX_ARG_STRLEN — 32 pages, 128KB on a 4KB-page system —
# independently of the total ARG_MAX budget. The read-ceiling case below feeds
# 200,000 characters on purpose, so on a GitHub Linux runner jq died with
# "Argument list too long", the payload came back empty, and the guard read an
# empty payload as neutral. The assertion then failed for a reason that had
# nothing to do with the ceiling it exists to pin. macOS caps only the total,
# which is why the same suite passed here; the runner's ARG_MAX is twice this
# machine's and still failed, which is what rules the total out.
#
# `printf` is a bash builtin, so the command never crosses an execve on its way
# to the pipe. `-R` reads stdin raw and `-s` slurps it whole, so `.` is the
# entire command as one string — newlines, quotes and backslashes intact — and
# `printf '%s'` appends nothing, so the empty command still produces "".
payload() {
  printf '%s' "$1" | jq -Rsc --arg d "${2-}" --arg s "${3-$SID}" \
    '{tool_name: "Bash", tool_input: {command: .}, cwd: $d, session_id: $s}'
}

# check <expected> <description> <command> [cwd] [session-id]
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

assert_absent() {
  local desc="$1" path="$2"
  if [ -e "$ROOT_DIR/$path" ]; then
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — $path is still in the repo"
  else
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# The whole point of the change: an in-project delete goes through with nobody
# asked. Each case asserts `allow` rather than neutral, because neutral would
# leave the call to the auto-mode classifier and the prompt is what this
# replaces.
echo "permits a delete whose every target is inside the project:"
check allow "rm -rf a directory"        "rm -rf $PROJECT/sub"
check allow "rm -rf a file"             "rm -rf $PROJECT/file.txt"
check allow "a path that does not exist yet" "rm -rf $PROJECT/never-made"
check allow "a symlink inside the root" "rm -rf $PROJECT/escape"
check allow "two paths, both inside"    "rm -rf $PROJECT/sub $PROJECT/file.txt"
# The idiom every idempotent cleanup script uses. It deletes nothing, so
# refusing it would be friction protecting against no outcome — and the anchor
# it resolves against is the deepest ancestor that DOES exist, which is still a
# physical resolution.
check allow "a whole missing subtree inside the root" "rm -rf $PROJECT/nope/deeper/x"

# The four delete spellings. `rm -rf` is the one that used to prompt; the other
# three matched no permission rule at all and fell through to the classifier.
echo "covers every delete spelling, not only the one that had a rule:"
check allow "rm -r without -f"          "rm -r $PROJECT/sub"
check allow "plain rm"                  "rm $PROJECT/file.txt"
check allow "rm -f"                     "rm -f $PROJECT/file.txt"
check allow "rmdir"                     "rmdir $PROJECT/sub"
check allow "rm with -- before paths"   "rm -rf -- $PROJECT/sub"
check allow "an absolute rm binary"     "/bin/rm -rf $PROJECT/sub"

echo "resolves the shapes a relative path arrives in:"
check allow "relative to the call's cwd" "rm -rf sub" "$PROJECT"
check allow "cd then rm"                 "cd $PROJECT && rm -rf sub" ""
check allow "cd relative, then rm"       "cd sub && rm -rf inner" "$PROJECT"

echo "permits a delete inside this session's scratchpad:"
check allow "a directory in the scratchpad" "rm -rf $SCRATCH/sub"
check allow "a path that does not exist yet" "rm -rf $SCRATCH/never-made"

# ─────────────────────────────────────────────────────────────────────────────
# The git half. These verbs destroy uncommitted state INSIDE a worktree without
# removing the worktree, so the worktree root being the project root is the
# ordinary case and is permitted — the asymmetry with `rm`, which is refused on
# a root itself, is the blast radius rather than an oversight.
echo "permits the destructive git verbs inside the project:"
check allow "git reset --hard"   "git reset --hard" "$IN_REPO"
check allow "git clean -fd"      "git clean -fd" "$IN_REPO"
check allow "git stash clear"    "git stash clear" "$IN_REPO"
check allow "git stash drop"     "git stash drop" "$IN_REPO"
check allow "git -C an in-scope repo" "git -C $IN_REPO reset --hard" "$SANDBOX"
check allow "cd then git reset"  "cd $IN_REPO && git reset --hard" ""

echo "reads the git subcommand slot, not the characters:"
check neutral "git status"           "git status" "$IN_REPO"
check neutral "git log over a needle" "git log --grep=git clean -fd" "$IN_REPO"
check neutral "git clean --dry-run"  "git clean --dry-run" "$IN_REPO"
check neutral "git clean -nd"        "git clean -nd" "$IN_REPO"
check neutral "git reset without --hard" "git reset HEAD~1" "$IN_REPO"
check neutral "git stash push"       "git stash push -m wip" "$IN_REPO"

# ─────────────────────────────────────────────────────────────────────────────
# OUT OF SCOPE. Every command here names a real path, and the guard resolves it
# perfectly well — it simply lands outside. Each asserts the deny AND that the
# victim survived, because reaching the right verdict for the wrong reason is
# not a pass.
echo "refuses a delete that reaches outside every root:"
check deny "a path under no root at all" "rm -rf $VICTIM/keep.txt"
check deny "a system path"               "rm -rf /etc/hosts"
check deny "a .. escape out of the root" "rm -rf $PROJECT/../victim/keep.txt"
check deny "through a symlink out"       "rm -rf $PROJECT/escape/keep.txt"
check deny "another session's scratchpad" "rm -rf $OTHER_SCRATCH/file.txt"
check deny "the filesystem root"          "rm -rf /"
check deny "one path inside, one outside" "rm -rf $PROJECT/sub $VICTIM/keep.txt"
assert_survives "the victim outside every root" "$VICTIM/keep.txt"
assert_survives "the other session's work"      "$OTHER_SCRATCH/file.txt"

# A root itself is never a delete target: each holds live state that is not this
# session's to destroy. This is where `rm` and the git verbs part company.
# ─────────────────────────────────────────────────────────────────────────────
# THE PERIMETER IS THE TOKENISER, NOT THE VERB TABLE. Every case in this block
# is a shape that used to reach NO verb slot at all, so the guard returned
# silence — which, with no permission rule underneath it, is permission. These
# are not resolution errors; they are the guard never seeing the command.
echo "sees the destructive verb through every statement separator:"
check deny "after a parenthesised group"   "(true); rm -rf $VICTIM/keep.txt"
check deny "after a nested group"          "(cd /; (true)); rm -rf $VICTIM/keep.txt"
check deny "after a brace group"           "{ true; }; rm -rf $VICTIM/keep.txt"
# The `;;` and `;&` cases put the delete DIRECTLY after the terminator, with no
# other separator between. Written as a whole `case` statement they prove
# nothing: the `)` that opens the next arm is a separator already, so the verb
# is found whether or not `;;` is one, and the assertion passes against the
# unfixed code. This shape is what the tokeniser actually has to survive.
check deny "straight after a case-arm terminator" "true;; rm -rf $VICTIM/keep.txt"
check deny "straight after a fallthrough terminator" "true;& rm -rf $VICTIM/keep.txt"
check deny "inside a real case statement"  "case x in a) rm -rf $VICTIM/keep.txt;; esac"
check deny "behind a |& pipe"              "true |& rm -rf $VICTIM/keep.txt"
assert_survives "the victim survived every separator" "$VICTIM/keep.txt"

# A `cd` the real shell throws away must be thrown away here too — and one it
# KEEPS must be kept. Both directions are a bypass. Measured against bash 3.2:
# a paren group runs in a subshell and its cd is undone, a brace group runs in
# this shell and its cd persists.
echo "follows a cd exactly as far as the real shell does:"
check deny  "a paren cd does not survive its group" \
  "(cd $PROJECT) ; rm -rf keep.txt" "$VICTIM"
check allow "a paren cd out of scope is likewise undone" \
  "(cd $VICTIM) ; rm -rf file.txt" "$PROJECT"
check deny  "a brace cd out of scope DOES survive" \
  "{ cd $VICTIM; } ; rm -rf keep.txt" "$PROJECT"
check allow "a brace cd into scope likewise survives" \
  "{ cd $PROJECT; } ; rm -rf sub" "$VICTIM"
check deny  "a cd in a pipeline stage does not survive" \
  "cd $PROJECT | true ; rm -rf keep.txt" "$VICTIM"
# THE OPERAND HERE IS RELATIVE, AND ONLY A RELATIVE ONE EXERCISES THE RESTORE.
# With an absolute target the verdict is settled by the path alone and the
# working-directory bookkeeping is never consulted, so the case passes whether
# the paren `cd` is undone or not. Both directions are pinned, because each is
# a bypass on its own: believing a paren cd resolves an outside delete as
# though it were inside, and the mirror hides a delete that really is outside.
check deny  "paren cd in, relative operand, real target outside" \
  "(cd $PROJECT) ; rm -rf keep.txt" "$VICTIM"
check allow "paren cd out, relative operand, real target inside" \
  "(cd $VICTIM) ; rm -rf file.txt" "$PROJECT"
check deny  "paren cd in, two relative operands" \
  "(cd $PROJECT) ; rm -rf keep.txt other.txt" "$VICTIM"
check deny  "a nested paren cd is undone at its own depth" \
  "(cd /; (cd $PROJECT)) ; rm -rf keep.txt" "$VICTIM"
assert_survives "the victim survived every cd shape" "$VICTIM/keep.txt"

# `rm -rf link` removes the link. `rm -rf link/` empties the TARGET — measured
# on BSD rm — so the trailing slash is a different command and has to resolve
# through the final component. Tab completion appends that slash, which makes
# this the routine spelling rather than the exotic one.
echo "reads a trailing slash as the directory it names:"
check deny  "a symlink out of scope, with the slash" "rm -rf $PROJECT/escape/"
check allow "the same symlink without the slash"     "rm -rf $PROJECT/escape"
check allow "an ordinary in-scope directory with a slash" "rm -rf $PROJECT/sub/"
assert_survives "the symlink's target survived" "$VICTIM/keep.txt"

# strip_noop drops `env` and `nice` but not their own options, so the option
# landed in the verb slot and the delete behind it was read as an argument.
echo "refuses a verb slot filled by a wrapper's own option:"
check deny "env -i"        "env -i rm -rf $VICTIM/keep.txt"
check deny "nice -n"       "nice -n 10 rm -rf $VICTIM/keep.txt"
check deny "env -i, in scope too" "env -i rm -rf $PROJECT/sub"
check neutral "a wrapper option with no delete behind it" "nice -n 10 make build"

# A keyword that takes a COMMAND as its condition left that keyword in the verb
# slot, and the delete in the condition went unread. The tell was that
# `if true; then rm ...; fi` denied correctly — only the condition was blind,
# and `if rm -rf "$dir"; then` is the ordinary delete-and-check idiom.
echo "reads a delete sitting in a condition, not only in a body:"
check deny "an if condition"    "if rm -rf $VICTIM/keep.txt; then true; fi"
check deny "a while condition"  "while rm -rf $VICTIM/keep.txt; do true; done"
check deny "an until condition" "until rm -rf $VICTIM/keep.txt; do true; done"
check deny "an elif condition"  "if false; then true; elif rm -rf $VICTIM/keep.txt; then true; fi"
check deny "a then body, which already worked" "if true; then rm -rf $VICTIM/keep.txt; fi"
check deny "a negated condition" "if ! rm -rf $VICTIM/keep.txt; then true; fi"
assert_survives "the victim survived every condition shape" "$VICTIM/keep.txt"

# The keyword set is COMPLETE rather than long, and this is what makes that
# claim checkable. POSIX defines fifteen reserved words; every one either
# precedes a command (and must be stripped, or the verb slot holds the keyword)
# or does not (and must not be, or a real command name gets eaten). A keyword
# added to either side without thought fails here.
echo "the shell-keyword set is the complete POSIX partition:"
KW_REPORT=$(cd "$ROOT_DIR/hooks/lib" && python3 -c "
import importlib.util
spec = importlib.util.spec_from_file_location('c', 'destructive-scope-check.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
precede = {'!', 'do', 'then', 'else', 'if', 'elif', 'while', 'until'}
rest    = {'{', '}', 'case', 'done', 'esac', 'fi', 'for', 'in'}
print('EXTRA' if m.KEYWORD_PREFIX - precede else '', end=' ')
print('MISSING' if precede - m.KEYWORD_PREFIX else '', end=' ')
print('PARTITION' if m.POSIX_RESERVED != precede | rest else '', end=' ')
print('OVERLAP' if precede & rest else '', end='')
" 2>&1)
if [ -z "${KW_REPORT// /}" ]; then
  PASS=$((PASS + 1)); echo "  ✅ every POSIX reserved word is on exactly the right side"
else
  FAIL=$((FAIL + 1)); echo "  ❌ keyword partition is wrong: $KW_REPORT"
fi

# The third instance of one class in two rounds — `);`, `env -i`, condition
# keywords — so the rule replaced the list: a verb slot that is not a plain
# program name is unreadable, and unreadable is refused. These are the shapes
# where the command is computed at runtime, and bash runs every one of them.
echo "refuses a verb slot computed at runtime:"
check deny "a command substitution"   "\$(echo rm) -rf $VICTIM/keep.txt"
check deny "a backtick substitution"  "\`echo rm\` -rf $VICTIM/keep.txt"
check deny "a resolved path"          "\$(which rm) -rf $VICTIM/keep.txt"
check deny "a braced variable"        "\${RM} -rf $VICTIM/keep.txt"
check deny "a bare variable"          "\$RM -rf $VICTIM/keep.txt"
# The variable case only reaches the checker at all because the guard's
# prefilter folds case: shell convention spells the variable `RM`, and the
# command carries no lower-case `rm` anywhere.
check deny "a braced variable, in scope too" "\${RM} -rf $PROJECT/sub"
# A quoted verb is NOT computed — the tokeniser strips the quotes and the name
# is right there — so it must keep resolving normally rather than being swept
# up by the rule above.
check deny "a quoted verb still resolves" "'rm' -rf $VICTIM/keep.txt"
check allow "a quoted verb, in scope"     "'rm' -rf $PROJECT/sub"
# And a computed verb with no destructive evidence stays out of the way. This
# is the friction bound on the rule: it refuses a runtime-computed command only
# when the line also names a destructive verb.
check neutral "a computed verb with no delete in sight" "\${EDITOR} notes.txt"
check neutral "a computed verb running a build"         "\$(which make) clean-build-dir"
assert_survives "the victim survived every computed verb" "$VICTIM/keep.txt"

# A heredoc fed to a shell is a script; fed to anything else it is data.
echo "reads a heredoc body only when it is a script:"
check deny    "bash fed a destructive heredoc" "$(printf 'bash <<EOF\nrm -rf %s/keep.txt\nEOF' "$VICTIM")"
check neutral "cat fed the same TEXT"          "$(printf 'cat <<EOF\nrm -rf %s/keep.txt\nEOF' "$VICTIM")"
check neutral "cat fed a path that looks like a delete" "$(printf 'cat <<EOF\nrm -rf /\nEOF')"

echo "refuses what it could not read in full or read exactly:"
# The padding is 200,000 characters against the checker's 200,000-byte ceiling,
# so the command clears it by the comment marker and the rm line alone. Shrink
# the padding and this case stops reaching the branch it exists to pin.
OVERSIZED=$(python3 -c "print('# ' + 'x' * 200000); print('rm -rf $VICTIM/keep.txt')")
check deny "a command past the read ceiling" "$OVERSIZED"
# The verdict alone does not discriminate: several branches deny, so a deny
# arriving from any OTHER one would read as a pass while the ceiling went
# unchecked. The reason is what says the ceiling is what refused it.
assert_contains "the refusal names the read ceiling, not another branch" \
  "$(reason_of "$(payload "$OVERSIZED" | run_guard 2>/dev/null)")" \
  "too long for this guard to read"
# THE SAME DELETE, PADDED WITH SPACES INSTEAD OF `x`. The padding is an INPUT,
# not filler, and its character class is the whole question: 200,001 whitespace
# characters `.strip()` to "", so an emptiness test placed above the length
# check reads this as an empty command and returns silence while the delete sits
# past the cutoff unread. That ordering shipped in the vault-git checker on
# 2026-09-21 and was caught in review. This checker orders them the other way
# round; nothing but this case says so, and here silence is a permitted delete.
WS_OVERSIZED=$(python3 -c "print(' ' * 200001); print('rm -rf $VICTIM/keep.txt')")
check deny "the same delete behind whitespace padding" "$WS_OVERSIZED"
assert_contains "whitespace reaches the ceiling branch, not the empty-command branch" \
  "$(reason_of "$(payload "$WS_OVERSIZED" | run_guard 2>/dev/null)")" \
  "too long for this guard to read"
unset OVERSIZED WS_OVERSIZED
check deny "lines merged by a multi-line quote" \
  "$(printf 'M="a\nb"\nmkdir -p %s/x\nrm -rf %s/keep.txt' "$PROJECT" "$VICTIM")"
assert_survives "the victim survived the unreadable commands" "$VICTIM/keep.txt"

echo "refuses a delete aimed at a root itself:"
check deny "the project root"             "rm -rf $PROJECT"
check deny "the project root, trailing slash" "rm -rf $PROJECT/"
check deny "the session scratchpad root"  "rm -rf $SCRATCH"
assert_survives "the project root survives"  "$PROJECT"
assert_survives "the scratchpad root survives" "$SCRATCH"
# The VERDICT alone does not discriminate here, and a mutation proved it: the
# containment test already refuses a root, because it demands strictly-beneath.
# What the dedicated branch adds is a refusal a reader can act on — "delete what
# is inside it instead" rather than "not inside any approved root", which reads
# as nonsense when the path IS the root. So the message is what gets pinned.
ROOT_DENIAL=$(payload "rm -rf $PROJECT" | run_guard 2>/dev/null)
assert_contains "the refusal says the target is a root, not an outsider" \
  "$(reason_of "$ROOT_DENIAL")" "deleting a scope root itself"
assert_contains "the refusal says what to do instead" \
  "$(context_of "$ROOT_DENIAL")" "Delete what is inside it instead"

echo "refuses a destructive git verb outside every root:"
check deny "git reset --hard in an outside repo" "git reset --hard" "$OUT_REPO"
check deny "git clean -fd in an outside repo"    "git clean -fd" "$OUT_REPO"
check deny "git stash clear in an outside repo"  "git stash clear" "$OUT_REPO"
check deny "git -C an outside repo"  "git -C $OUT_REPO reset --hard" "$IN_REPO"

# ─────────────────────────────────────────────────────────────────────────────
# FAIL CLOSED — the block this suite exists for. Every case names a destructive
# verb whose targets the guard cannot resolve, and every one must DENY. Under
# the retired guard each of these printed nothing and fell through to a prompt;
# with the ask entries gone, printing nothing would be a hole.
echo "denies a delete whose target it cannot resolve:"
check deny "a variable, which names nothing yet" 'rm -rf "${SP}sub"' "$PROJECT"
check deny "a bare variable"              'rm -rf $SP' "$PROJECT"
check deny "a glob, which names a set"    "rm -rf $PROJECT/*"
check deny "a brace expansion"            "rm -rf $PROJECT/{a,b}"
# The tilde runs from INSIDE the project on purpose. Resolve `~/sub` against
# this cwd as a literal and it lands on the `~` directory the fixture created,
# so the guard would permit a delete the shell was never going to perform. A
# case pointing outside the root would pass whether the guard reads `~` or not.
check deny "a tilde path, which names another root" "rm -rf ~/sub" "$PROJECT"
check deny "command substitution in the operand" 'rm -rf $(cat list)' "$PROJECT"
check deny "a relative path with no cwd"  "rm -rf sub" ""
# The other half of the deepest-ancestor rule: resolving from an ancestor never
# lets a missing subtree launder a path INTO scope. The anchor here is the
# sandbox, which is outside every root, so the whole branch is outside it too.
check deny "a missing subtree outside every root" "rm -rf $VICTIM/nope/deeper/x"
# And a missing subtree hung off a symlink still resolves through the link,
# because the anchor is the deepest ancestor that exists — which is the link's
# target, outside the project.
check deny "a missing subtree behind a symlink out" "rm -rf $PROJECT/escape/nope/x"
check deny "a target naming itself by position" "rm -rf $PROJECT/sub/."
check deny "a target naming its parent"   "rm -rf $PROJECT/sub/.."
check deny "an unbalanced quote"          "rm -rf '$PROJECT/sub"

echo "denies a destructive verb it cannot follow into a wrapper:"
check deny "bash -c"    "bash -c \"rm -rf $PROJECT/sub\""
check deny "sh -c"      "sh -c \"rm -rf $PROJECT/sub\""
check deny "eval"       "eval \"rm -rf $PROJECT/sub\""
check deny "ssh"        "ssh host \"rm -rf /var/lib/thing\""
check deny "xargs"      "find . -name x | xargs rm -rf"
check deny "find -delete" "find $PROJECT -name '*.log' -delete"
check deny "find -exec rm" "find $PROJECT -name x -exec rm -rf {} ;"
check deny "timeout, whose command starts at argument two" "timeout 5 rm -rf $PROJECT/sub"
check deny "xargs behind an option"     "find . -name x | xargs -n1 rm -rf"
# The over-reach the suffix scan buys, pinned so it is a decision rather than a
# surprise: one suffix of `xargs grep rm` is the single token `rm`, and a
# wrapper argument that merely spells a delete verb denies. That direction is
# chosen — with no permission rule underneath this guard, a missed wrapper is a
# hole and a denied `grep` is one ! prefix.
check deny "a wrapper argument that merely spells rm" "find . -name x | xargs grep rm"
check deny "a loop body"  'for f in *; do rm -rf "$f"; done' "$PROJECT"
check deny "bash -c hiding a git verb" "bash -c \"git reset --hard\"" "$IN_REPO"

echo "denies a destructive git verb whose repository it cannot resolve:"
check deny "no working directory"      "git reset --hard" ""
check deny "a cwd that is no worktree" "git clean -fd" "$SANDBOX"
check deny "--git-dir moves the repo"  "git --git-dir=$OUT_REPO/.git reset --hard" "$IN_REPO"
check deny "--work-tree moves the repo" "git --work-tree=$OUT_REPO reset --hard" "$IN_REPO"
check deny "a -C operand holding a variable" 'git -C "$D" reset --hard' "$IN_REPO"

# With no project root resolved at all, the scratch roots are the whole scope
# and a project path is outside it. Nothing falls back to the working directory.
echo "never treats the working directory as a scope root:"
OUT=$(payload "rm -rf $PROJECT/sub" "$PROJECT" | run_guard "" 2>/dev/null)
if [ "$(verdict_of "$OUT")" = "deny" ]; then
  PASS=$((PASS + 1)); echo "  ✅ an unset project root approves no project path"
else
  FAIL=$((FAIL + 1)); echo "  ❌ approved a project path with no project root set"
fi
# The mutation this closes: scope_roots() extended with os.getcwd(). That is the
# "can a caller nominate a root" question asked of the one directory nobody
# passes in explicitly, and the whole suite stayed green against it — every
# other case runs from a directory that is already outside every root, so a
# cwd-derived root changed nothing they assert. Here the guard PROCESS is run
# from inside the victim, so a cwd root would approve the victim.
OUT=$(payload "rm -rf $VICTIM/keep.txt" | (cd "$VICTIM" && run_guard) 2>/dev/null)
if [ "$(verdict_of "$OUT")" = "deny" ]; then
  PASS=$((PASS + 1)); echo "  ✅ the guard's own working directory is not a root"
else
  FAIL=$((FAIL + 1)); echo "  ❌ approved a delete because the guard was run from that directory"
fi
OUT=$(payload "rm -rf keep.txt" "$VICTIM" | (cd "$VICTIM" && run_guard) 2>/dev/null)
if [ "$(verdict_of "$OUT")" = "deny" ]; then
  PASS=$((PASS + 1)); echo "  ✅ the CALL's working directory is not a root either"
else
  FAIL=$((FAIL + 1)); echo "  ❌ approved a delete because the call ran in that directory"
fi
assert_survives "the victim survived the cwd cases" "$VICTIM/keep.txt"

# The mutation this closes: `beneath` reduced to a bare `startswith(root)`, with
# no separator. A sibling directory sharing the project's name as a prefix then
# reads as inside it, and nothing else in this suite notices.
echo "containment is a path test, not a string prefix:"
check deny "a sibling sharing the project's prefix" "rm -rf $PREFIX_TWIN/keep.txt"
check deny "a sibling of the scratchpad root"       "rm -rf ${SCRATCH}-evil/keep.txt"
assert_survives "the prefix twin survived" "$PREFIX_TWIN/keep.txt"

# ─────────────────────────────────────────────────────────────────────────────
# THE SESSION ROOT IS THE ONE FOUND BY PATTERN RATHER THAN READ FROM A SOURCE
# THE CALLER CANNOT REDIRECT, so it is the one an agent can fabricate. Both
# `mkdir -p` and `ln -s` are non-destructive, so neither is gated by this guard,
# and the session id sits in the ordinary Bash environment. A symlink anywhere
# in the matched path therefore builds a fifth fully-approved root pointing
# wherever the caller likes.
echo "never approves a session root reached through a symlink:"
FAKE_ROOT="$FAKE_TMP/-fabricated/$SID"
mkdir -p "$FAKE_ROOT"
ln -s "$VICTIM" "$FAKE_ROOT/scratchpad"
check deny "a scratchpad that is a symlink out"   "rm -rf $FAKE_ROOT/scratchpad/keep.txt"
# A link one level UP redirects exactly as well, so the check has to refuse a
# symlink at ANY level and not only the last.
FAKE_UP="$FAKE_TMP/-fabricated-up"
mkdir -p "$FAKE_UP"
ln -s "$VICTIM" "$FAKE_UP/$SID"
check deny "a symlink above the scratchpad"       "rm -rf $FAKE_UP/$SID/scratchpad/keep.txt"
assert_survives "the victim survived the fabricated roots" "$VICTIM/keep.txt"
# And the genuine article, built with real directories, still works — or the
# check above would have bought its safety by disabling the root.
check allow "a real session scratchpad is unaffected" "rm -rf $SCRATCH/sub"

echo "takes the session id from the payload:"
check allow "the payload's own session id" "rm -rf $SCRATCH/sub" "" "$SID"
check deny  "a different session's id"     "rm -rf $SCRATCH/sub" "" "$OTHER_SID"
check deny  "no session id at all"         "rm -rf $SCRATCH/sub" "" ""
check deny  "a malformed session id"       "rm -rf $SCRATCH/sub" "" "../../etc"

# ─────────────────────────────────────────────────────────────────────────────
# NEUTRAL. A hook allow bypasses the permission system for the WHOLE call, so a
# command that also does something else gets silence: not a deny, because
# nothing about it is out of scope, and not an allow, because the grant would
# cover the other statement too.
echo "says nothing about a command it has no business granting:"
check neutral "a delete plus another command" "rm -rf $PROJECT/sub && echo done"
check neutral "another command plus a delete" "mkdir -p $PROJECT/x && rm -rf $PROJECT/sub"
check neutral "a delete with a redirect"      "rm -rf $PROJECT/sub > $PROJECT/out.log"
check neutral "rm with no path at all"        "rm -rf"

echo "reads the verb slot, not the characters:"
check neutral "rm inside a grep pattern"  "grep -rn 'rm -rf $PROJECT' ."
check neutral "rm as an echo argument"    "echo rm -rf $PROJECT/sub"
check neutral "a command that merely lists" "ls -la $PROJECT/sub"
check neutral "a path with rm in its name"  "cat $PROJECT/confirm.log"
check neutral "find without -delete"        "find $PROJECT -name '*.log'"
check neutral "a command naming none of the verbs" "ls -la /etc"

# ─────────────────────────────────────────────────────────────────────────────
# The line between the verdict failing closed and the DEPLOYMENT failing closed.
# A payload this guard cannot read is nothing to judge and exits silent. A
# checker that cannot run, on a command already known to name a destructive
# verb, is a destructive command nobody judged — and that denies.
echo "a payload it cannot read is nothing to judge:"
OUT=$(jq -nc --arg c "rm -rf $VICTIM" \
  '{tool_name: "Read", tool_input: {command: $c}}' | run_guard 2>/dev/null)
if [ "$(verdict_of "$OUT")" = "neutral" ]; then
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
if [ "$(verdict_of "$OUT")" = "neutral" ]; then
  PASS=$((PASS + 1)); echo "  ✅ a payload that is not JSON says nothing"
else
  FAIL=$((FAIL + 1)); echo "  ❌ a malformed payload produced a verdict"
fi

echo "a checker it cannot run is a destructive command nobody judged:"
BROKEN="$SANDBOX/broken-install"
mkdir -p "$BROKEN/lib"
cp "$GUARD" "$BROKEN/destructive-scope-guard.sh"
OUT=$(payload "rm -rf $PROJECT/sub" | \
  (unset CLAUDE_CODE_SESSION_ID
   CLAUDE_PROJECT_DIR="$PROJECT" bash "$BROKEN/destructive-scope-guard.sh") 2>/dev/null)
if [ "$(verdict_of "$OUT")" = "deny" ]; then
  PASS=$((PASS + 1)); echo "  ✅ denies when the checker is missing"
else
  FAIL=$((FAIL + 1)); echo "  ❌ a missing checker let a destructive command through"
fi
# And the same install says nothing about a command that names no destructive
# verb, so a broken install does not take every Bash call down with it.
OUT=$(payload "ls -la /etc" | \
  (unset CLAUDE_CODE_SESSION_ID
   CLAUDE_PROJECT_DIR="$PROJECT" bash "$BROKEN/destructive-scope-guard.sh") 2>/dev/null)
if [ -z "$OUT" ]; then
  PASS=$((PASS + 1)); echo "  ✅ a missing checker still ignores a harmless command"
else
  FAIL=$((FAIL + 1)); echo "  ❌ a missing checker denied a harmless command"
fi

OUT=$(payload "rm -rf $PROJECT/sub" | (cd / && run_guard) 2>/dev/null)
if [ "$(verdict_of "$OUT")" = "allow" ]; then
  PASS=$((PASS + 1)); echo "  ✅ finds its own checker from any directory"
else
  FAIL=$((FAIL + 1)); echo "  ❌ failed to resolve the checker from another directory"
fi

# ─────────────────────────────────────────────────────────────────────────────
# THE REFUSAL IS THE ROUTE, AND THE ROUTE IS THE ! PREFIX. Of the three verdicts
# a hook can return only deny binds — a hook "ask" is silently auto-approved by
# the classifier, measured 2026-09-11 — so there is no prompt to fall back to
# and the message has to carry the way through.
echo "the refusal names the action, and the way through:"
DENIAL=$(payload "rm -rf $VICTIM/keep.txt" | run_guard 2>/dev/null)
REASON=$(reason_of "$DENIAL")
CONTEXT=$(context_of "$DENIAL")
assert_contains "the human line names the action" "$REASON" "deleting a path outside"
assert_contains "the human line names the ! prefix" "$REASON" "! prefix"
# A filesystem path in the reason is the exact defect the JSON deny was adopted
# to remove, so it must not creep back in through the author's half.
refute_contains "the human line carries no path" "$REASON" "/"
if [ "$(printf '%s' "$REASON" | wc -l | tr -d ' ')" = "0" ]; then
  PASS=$((PASS + 1)); echo "  ✅ the human line is one line"
else
  FAIL=$((FAIL + 1)); echo "  ❌ the human line runs to more than one line"
fi
assert_contains "the detail names the offending target" "$CONTEXT" "$VICTIM/keep.txt"
assert_contains "the detail names the project root"     "$CONTEXT" "$PROJECT"
assert_contains "the detail says there is no rule underneath" "$CONTEXT" \
  "no permission rule underneath it"
# An agent once relayed this refusal to the human as a `! rm -rf` for a probe
# root it had made by hand under /tmp. The model's half now says scratch cleanup
# is never routed to the human, and where new scratch belongs.
assert_contains "the detail keeps scratch cleanup off the human" "$CONTEXT" \
  "Scratch cleanup is never the user's job"
assert_contains "the detail names where scratch belongs" "$CONTEXT" \
  "never anywhere under /tmp outside your session scratchpad"

echo "an unresolvable target says WHY it could not be read:"
DENIAL=$(payload 'rm -rf "$SP/x"' "$PROJECT" | run_guard 2>/dev/null)
# The checker's own detail for this refusal ends "or run the command yourself
# with the ! prefix". The scratch sentence has to come FIRST, or an agent reads
# the ! route and relays it to the user for its own scratch.
UNREAD_CONTEXT=$(context_of "$DENIAL")
SCRATCH_AT=${UNREAD_CONTEXT%%Scratch cleanup is never*}
BANG_AT=${UNREAD_CONTEXT%%! prefix*}
if [ "${#SCRATCH_AT}" -lt "${#UNREAD_CONTEXT}" ] \
    && [ "${#SCRATCH_AT}" -lt "${#BANG_AT}" ]; then
  PASS=$((PASS + 1)); echo "  ✅ the scratch sentence comes before any ! wording"
else
  FAIL=$((FAIL + 1)); echo "  ❌ the ! wording comes before the scratch sentence"
fi
assert_contains "names the operand" "$(context_of "$DENIAL")" '$SP/x'
assert_contains "says the text settles no path" "$(context_of "$DENIAL")" \
  "does not say which paths are meant"

echo "the allow is one line and grants nothing it need not:"
GRANT=$(payload "rm -rf $PROJECT/sub" | run_guard 2>/dev/null)
assert_contains "names the scope it checked" "$(reason_of "$GRANT")" "inside the project"
if [ -z "$(context_of "$GRANT")" ]; then
  PASS=$((PASS + 1)); echo "  ✅ an allow carries no context block"
else
  FAIL=$((FAIL + 1)); echo "  ❌ an allow carried a context block"
fi

# ─────────────────────────────────────────────────────────────────────────────
# A guard nothing calls guards nothing, so registration is part of the
# behaviour.
echo "the hook is registered in hooks.json:"
assert_jq "matcher is Bash" "$HOOKS_JSON" \
  '[.hooks.PreToolUse[] | select(.hooks[].command | test("destructive-scope-guard.sh")) | .matcher] | join(",")' \
  "Bash"
assert_jq "registered exactly once" "$HOOKS_JSON" \
  '[.hooks.PreToolUse[].hooks[] | select(.command | test("destructive-scope-guard.sh"))] | length' "1"
assert_jq "no if condition narrows it" "$HOOKS_JSON" \
  '[.hooks.PreToolUse[] | select(.hooks[].command | test("destructive-scope-guard.sh")) | .if // empty] | length' "0"

# ─────────────────────────────────────────────────────────────────────────────
# THE RETIRED ROUTE. This guard replaces hooks/scratch-delete-guard.sh and the
# bin/scratch-rm.sh command it routed to, and a hook deny binds absolutely — so
# leaving that guard registered would block precisely the in-scratch deletes
# this one permits. The two cannot coexist, and a stray mention of the helper is
# an instruction to run a command that is not installed any more.
echo "nothing points at the retired scratch-delete route:"
assert_absent "the old guard is gone"   "hooks/scratch-delete-guard.sh"
assert_absent "its checker is gone"     "hooks/lib/scratch-delete-check.py"
assert_absent "its suite is gone"       "hooks/test-scratch-delete-guard.sh"
assert_absent "the helper is gone"      "bin/scratch-rm.sh"
assert_absent "the helper's suite is gone" "hooks/test-scratch-rm.sh"
# Whole-repo, and scoped to the RUNNABLE SPELLING rather than to the name.
# rails.json, the README, the setup skill and this file all still discuss the
# retired helper, and they should — a reader who meets the new guard deserves to
# know what it replaced and why the two could not coexist. What must not survive
# is an instruction to RUN it: that spelling is the one an agent copies, and it
# names a file `/workbench-core:setup` no longer installs. Both warmup channels
# carried it verbatim, which is how it would have reached every session.
#
# The needle is ASSEMBLED rather than written out, and that is not a flourish:
# spelled literally it sits in this file, `git ls-files` lists this file, and
# the assertion matches itself the moment the suite is staged. It passed while
# the file was untracked and failed on `git add` — a self-matching grep that
# would have gone red for the first time in somebody else's commit.
HELPER_NAME="scratch-rm.sh"
STRAY=$(cd "$ROOT_DIR" && git ls-files -z \
  | xargs -0 grep -lF "bash \"\$HOME/.claude-workbench/bin/$HELPER_NAME\"" 2>/dev/null)
if [ -z "$STRAY" ]; then
  PASS=$((PASS + 1)); echo "  ✅ no tracked file still tells anyone to run the helper"
else
  FAIL=$((FAIL + 1)); echo "  ❌ the runnable spelling survives in: $(echo "$STRAY" | tr '\n' ' ')"
fi
# And the grant it depended on is out of the rails, so setup cannot re-add a
# rule naming a path with no file behind it.
assert_jq "no Bash allow entry names the helper" \
  "$ROOT_DIR/assets/permissions/rails.json" \
  '[(.allow // [])[] | select(.rule | test("scratch-rm"))] | length' "0"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
