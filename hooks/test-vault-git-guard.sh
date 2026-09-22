#!/bin/bash
# Tests for hooks/vault-git-guard.sh — the PreToolUse memory-vault git guard.
# Run directly: ./test-vault-git-guard.sh
# Each case feeds the hook one PreToolUse payload on stdin and asserts its
# VERDICT: deny (the call is refused) or allow (nothing is printed, so the normal
# permission flow applies). Pure stdin/stdout checks — no network, no server, and
# the vault is a throwaway directory, never the user's real one.
#
# The verdict is read out of the hook's JSON, never out of an exit code. The
# guard used to block by exiting 2, which prefixed the model's message with the
# guard's own absolute filesystem path and threw stdout away; it now returns
# permissionDecision "deny" on exit 0, which refuses the call just as hard and
# leaves the author in control of the first line a person reads.
#
# The suite is weighted towards the ALLOW cases on purpose, on two axes. A guard
# that stops `git status` in the vault has broken the very commands the incident
# was investigated with, and a guard that stops `git commit` in an unrelated
# repository has broken every repository on the machine. Both are worse failures
# than the one it was built to prevent.

set -u
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
GUARD="$HOOKS_DIR/vault-git-guard.sh"
HOOKS_JSON="$HOOKS_DIR/hooks.json"
PASS=0
FAIL=0

# A throwaway vault, plus two directories that must never be mistaken for it.
# `vault-old` is the prefix trap: its path starts with the vault's own path, and
# only comparing with a separator keeps it a different repository.
SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT
VAULT="$SANDBOX/vault"
VAULT_OLD="$SANDBOX/vault-old"
PROJECT="$SANDBOX/project"
mkdir -p "$VAULT/insights" "$VAULT_OLD" "$PROJECT"

# The hook resolves the vault through lib/memory-env.sh, which reads
# WORKBENCH_MEMORY_PATH before anything else. Pointing WORKBENCH_CONFIG_FILE at
# a file that does not exist keeps the real config out of the run entirely, so
# the suite behaves the same on a machine that has customised its vault path.
run_guard() {
  WORKBENCH_MEMORY_PATH="$VAULT" \
  WORKBENCH_CONFIG_FILE="$SANDBOX/no-such-config.json" \
    bash "$GUARD"
}

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

# check <deny|allow> <description> <payload-json>
check() {
  local expected="$1" desc="$2" payload="$3" actual
  actual=$(verdict_of "$(printf '%s' "$payload" | run_guard 2>/dev/null)")
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected $expected, got $actual"
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

assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  # `--` matters: a needle such as "--git-dir" is otherwise read as a grep flag.
  if printf '%s\n' "$haystack" | grep -qF -- "$needle"; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — output missing: $needle"
  fi
}

# THE COMMAND REACHES jq ON STDIN, NOT AS AN ARGUMENT. `--arg c "$1"` puts the
# whole command in one argv entry, and Linux caps a single argument at
# MAX_ARG_STRLEN — 32 pages, 128KB on a 4KB-page system — independently of the
# total ARG_MAX budget. The read-ceiling case below feeds more than 200,000
# characters, so the argv form dies with "Argument list too long" there, hands
# the guard an EMPTY payload, and the case then passes or fails for a reason
# that has nothing to do with the ceiling it exists to pin. macOS caps only the
# total, so the argv form looks fine here and breaks on a Linux runner. Measured
# that way once already; the full note is in hooks/test-destructive-scope-guard.sh.
#
# `printf` is a bash builtin, so the command never crosses an execve on its way
# to the pipe. `-R` reads stdin raw and `-s` slurps it whole, so `.` is the
# whole command — newlines, quotes and backslashes intact — and `printf '%s'`
# appends nothing, so an empty command still produces "".
bash_json() { printf '%s' "$1" | jq -Rsc '{tool_name: "Bash", tool_input: {command: .}}'; }
# The cwd key is what a bare `git commit` acts on, so most cases need it. Note
# `${2-}` rather than `${2:-}`: an EMPTY cwd is a case under test, and it must
# reach the payload rather than being defaulted.
cwd_json() {
  printf '%s' "$1" | jq -Rsc --arg d "${2-}" \
    '{tool_name: "Bash", tool_input: {command: .}, cwd: $d}'
}

# The command that lost a profile's provenance on 2026-09-04. It staged a
# deletion the memory server then swept into commit 014f51b1, whose message
# describes an unrelated note being written.
echo "blocks the command from the incident this guard exists for:"
check deny "the exact incident command" \
  "$(bash_json "git -C $VAULT rm identity/profile.md")"

# Four shapes. A prefix deny rule can express none of them, because the verdict
# turns on which REPOSITORY the command resolves to, not on its first words.
echo "blocks each of the four ways a command names the vault:"
check deny "git -C the vault"        "$(bash_json "git -C $VAULT commit -m x")"
check deny "git -C a subdirectory"   "$(bash_json "git -C $VAULT/insights add .")"
check deny "git -C, relative to cwd" "$(cwd_json 'git -C insights add .' "$VAULT")"
check deny "cd then git"             "$(bash_json "cd $VAULT && git commit -am x")"
check deny "cd a subdir then git"    "$(bash_json "cd $VAULT/insights && git add .")"
check deny "cd relative to the cwd"  "$(cwd_json 'cd insights && git add .' "$VAULT")"
check deny "a bare command, cwd"     "$(cwd_json 'git commit -am x' "$VAULT")"
check deny "a bare command, subdir"  "$(cwd_json 'git add .' "$VAULT/insights")"
check deny "--git-dir="              "$(bash_json "git --git-dir=$VAULT/.git rm x")"
check deny "--git-dir, separate arg" "$(bash_json "git --git-dir $VAULT/.git rm x")"
check deny "--work-tree="            "$(bash_json "git --work-tree=$VAULT add .")"
# An absolute cd settles the target with no cwd to resolve against, so this
# shape must block on a payload that carries none.
check deny "cd with no cwd at all"   "$(bash_json "cd $VAULT && git rm x")"

echo "blocks every write verb it was told to block:"
for VERB in commit add rm mv push pull fetch reset checkout switch restore \
            merge rebase cherry-pick revert clean apply am init; do
  check deny "git $VERB" "$(bash_json "git -C $VAULT $VERB")"
done
# The seven added beyond the obvious set, each reaching the object store or the
# ref namespace directly — the same blast radius as a commit.
for VERB in update-ref gc repack prune worktree notes symbolic-ref; do
  check deny "git $VERB" "$(bash_json "git -C $VAULT $VERB")"
done

# Three listed verbs have a read-only form an agent uses routinely, so for those
# the arguments decide rather than the verb alone.
echo "blocks the mutating form of the three verbs that also have a read form:"
check deny "git tag <name>"      "$(bash_json "git -C $VAULT tag v1.0")"
check deny "git tag -d"          "$(bash_json "git -C $VAULT tag -d v1.0")"
check deny "git tag -a -m"       "$(bash_json "git -C $VAULT tag -a v1.0 -m msg")"
check deny "bare git stash"      "$(bash_json "git -C $VAULT stash")"
check deny "git stash push"      "$(bash_json "git -C $VAULT stash push")"
check deny "git stash pop"       "$(bash_json "git -C $VAULT stash pop")"
check deny "git stash drop"      "$(bash_json "git -C $VAULT stash drop")"
check deny "git branch -d"       "$(bash_json "git -C $VAULT branch -d topic")"
check deny "git branch -D"       "$(bash_json "git -C $VAULT branch -D topic")"
check deny "git branch --delete" "$(bash_json "git -C $VAULT branch --delete topic")"

# A prefix permission rule sees the first word and nothing else. Every shape
# below hides the verb behind something.
echo "blocks through wrappers and compound commands:"
check deny "sudo"                "$(bash_json "sudo git -C $VAULT reset --hard")"
check deny "env assignment"      "$(bash_json "GIT_AUTHOR_NAME=x git -C $VAULT commit -m y")"
check deny "env with a var"      "$(bash_json "env GIT_PAGER=cat git -C $VAULT rm x")"
check deny "nice"                "$(bash_json "nice git -C $VAULT gc")"
check deny "an absolute git path" "$(bash_json "/usr/bin/git -C $VAULT rm x")"
check deny "after a semicolon"   "$(bash_json "echo start; git -C $VAULT commit -m x")"
check deny "on the || arm"       "$(bash_json "test -f x || git -C $VAULT rm x")"
check deny "on the && arm"       "$(bash_json "true && git -C $VAULT add .")"
check deny "bash -c"             "$(bash_json "bash -c \"cd $VAULT && git rm x\"")"
check deny "sh -c"               "$(bash_json "sh -c \"git -C $VAULT commit -m x\"")"
check deny "a later pipeline stage" "$(bash_json "echo x | git -C $VAULT apply")"
check deny "-c config before -C" "$(bash_json "git -c user.name=x -C $VAULT commit -m y")"
check deny "--no-pager before -C" "$(bash_json "git --no-pager -C $VAULT rm x")"
# Two -C flags compose, each relative to the one before it.
check deny "composed -C flags"   "$(bash_json "git -C $VAULT -C insights add .")"

# THE PRIORITY REQUIREMENT. These are the commands the 2026-09-04 incident was
# investigated with. A guard that blocks them has cost more than it saved.
echo "allows read-only git in the vault — the whole point of the block list:"
for VERB in status log show diff ls-files rev-parse rev-list cat-file blame describe; do
  check allow "git $VERB via -C"  "$(bash_json "git -C $VAULT $VERB")"
  check allow "git $VERB via cwd" "$(cwd_json "git $VERB" "$VAULT")"
done
check allow "git remote -v"       "$(bash_json "git -C $VAULT remote -v")"
check allow "git config --get"    "$(bash_json "git -C $VAULT config --get user.email")"
check allow "git log with args"   "$(bash_json "git -C $VAULT log --oneline -5")"
check allow "git show a commit"   "$(bash_json "git -C $VAULT show 014f51b1")"
check allow "git diff --stat"     "$(bash_json "git -C $VAULT diff --stat")"
check allow "git status after cd" "$(bash_json "cd $VAULT && git status")"
check allow "git log after cd"    "$(bash_json "cd $VAULT && git log --oneline -1")"

# Unlisted subcommands pass, which is the stated consequence of a block list.
# Each of these is a read that an allow-list guard would have had to enumerate.
echo "allows the unlisted read subcommands a block list leaves alone:"
for VERB in grep shortlog for-each-ref ls-tree count-objects help var whatchanged; do
  check allow "git $VERB" "$(bash_json "git -C $VAULT $VERB")"
done

echo "allows the read-only form of the three dual-purpose verbs:"
check allow "bare git tag"        "$(bash_json "git -C $VAULT tag")"
check allow "git tag -l"          "$(bash_json "git -C $VAULT tag -l")"
check allow "git tag -l a glob"   "$(bash_json "git -C $VAULT tag -l 'v*'")"
check allow "git tag --list"      "$(bash_json "git -C $VAULT tag --list")"
check allow "git tag -n"          "$(bash_json "git -C $VAULT tag -n")"
check allow "git tag --sort="     "$(bash_json "git -C $VAULT tag --sort=-creatordate")"
check allow "git stash list"      "$(bash_json "git -C $VAULT stash list")"
check allow "git stash show"      "$(bash_json "git -C $VAULT stash show")"
check allow "bare git branch"     "$(bash_json "git -C $VAULT branch")"
check allow "git branch -a"       "$(bash_json "git -C $VAULT branch -a")"
check allow "git branch --list"   "$(bash_json "git -C $VAULT branch --list")"

# THE OTHER PRIORITY REQUIREMENT. This guard must be invisible everywhere that
# is not the vault. Every write verb it blocks is tested again here, allowed.
echo "allows every write verb in an unrelated repository:"
for VERB in commit add rm mv push pull fetch reset checkout switch restore \
            stash merge rebase cherry-pick revert clean apply am tag init \
            update-ref gc repack prune worktree notes symbolic-ref branch; do
  check allow "git $VERB in a project" "$(cwd_json "git $VERB" "$PROJECT")"
done
check allow "git -C a project"      "$(bash_json "git -C $PROJECT rm x")"
check allow "cd a project then git" "$(bash_json "cd $PROJECT && git commit -am x")"
check allow "the incident verb elsewhere" \
  "$(cwd_json 'git rm identity/profile.md' "$PROJECT")"
check allow "a real-world commit"   "$(cwd_json 'git commit -m "feat: add"' "$PROJECT")"
check allow "a push from a project" "$(cwd_json 'git push origin main' "$PROJECT")"

# The prefix trap. `vault-old` starts with the vault's own path, and only a
# comparison that respects the separator keeps it a separate repository.
echo "a sibling whose name merely starts the same is not the vault:"
check allow "vault-old via -C"      "$(bash_json "git -C $VAULT_OLD rm x")"
check allow "vault-old via cd"      "$(bash_json "cd $VAULT_OLD && git commit -am x")"
check allow "vault-old via cwd"     "$(cwd_json 'git rm x' "$VAULT_OLD")"
check allow "vault-old --git-dir"   "$(bash_json "git --git-dir=$VAULT_OLD/.git rm x")"

# The remote machine has its own filesystem, so a local path of the same name is
# the wrong path. This is where the guard deliberately disagrees with
# destructive-database-guard.sh, which follows a command THROUGH ssh.
#
# These pin BEHAVIOUR, not a boundary list. The checker carried an explicit list
# of remote wrappers until a mutation test showed no input could reach it: a
# stage whose first word is not `git` is never judged, so these were already
# allowed. The list went; these cases stayed, because the behaviour is what
# matters and it must not regress if descent is ever added.
echo "stops at every remote and container boundary:"
check allow "ssh"                   "$(bash_json "ssh box \"git -C $VAULT rm x\"")"
check allow "ssh with a port flag"  "$(bash_json "ssh -p 2222 box \"git -C $VAULT commit -m x\"")"
check allow "docker exec"           "$(bash_json "docker exec -it api git -C $VAULT rm x")"
check allow "docker compose exec"   "$(bash_json "docker compose exec app git -C $VAULT commit -m x")"
check allow "kubectl exec"          "$(bash_json "kubectl exec pod/api -- git -C $VAULT rm x")"
check allow "podman exec"           "$(bash_json "podman exec api git -C $VAULT add .")"

# Naming a destructive verb is not running it. A guard that stops code search
# has repeated the mistake the database guard's suite is weighted against.
echo "allows code search and prose that merely mentions a git write:"
check allow "grep for git rm"       "$(cwd_json "grep -rn 'git rm' hooks/" "$VAULT")"
check allow "grep in the vault"     "$(cwd_json 'grep -rn "git commit" .' "$VAULT")"
check allow "rg for the verb"       "$(cwd_json 'rg "git -C" --glob "*.sh"' "$VAULT")"
check allow "echo about git rm"     "$(cwd_json 'echo "never run git rm in the vault"' "$VAULT")"
check allow "cat a file named git"  "$(cwd_json 'cat notes/git-rm-incident.md' "$VAULT")"
check allow "ls the vault"          "$(cwd_json 'ls -la' "$VAULT")"
check allow "a non-git command"     "$(cwd_json 'python3 -c "print(1)"' "$VAULT")"
# gh is not git. Nothing here touches the vault's repository.
check allow "gh pr list"            "$(cwd_json 'gh pr list' "$VAULT")"

echo "allows anything it cannot resolve or parse — this hook is not an OS boundary:"
check allow "malformed json"          'not json at all'
check allow "empty object"            '{}'
check allow "an unmatched tool name"  "$(jq -nc '{tool_name: "Read", tool_input: {file_path: "/tmp/x"}}')"
check allow "an empty command"        "$(bash_json '')"
# No cwd and a relative target means no basis for deciding, and a guess is how
# this guard would block somebody else's repository.
check allow "no cwd, bare git commit" "$(bash_json 'git commit -am x')"
check allow "no cwd, relative -C"     "$(bash_json 'git -C sub rm x')"
check allow "an empty cwd"            "$(cwd_json 'git commit -am x' '')"
# An unbalanced quote is shell bash itself would reject. Blocking it would break
# ordinary one-liners and stop nothing that could actually run.
check allow "an unbalanced quote"     "$(bash_json "git -C $VAULT rm \"unclosed")"

# The one unreadable shape this guard REFUSES, and the contrast with the blocks
# above is the whole distinction: text the checker read and could not parse or
# resolve is allowed, text it never read at all is not. The padding is 200,000
# characters against the checker's 200,000-byte ceiling, so the command clears
# it by the `echo` and the git line alone. Shrink the padding and this case
# stops reaching the branch it exists to pin.
echo "refuses a command too long to read, where the vault write hides past the cutoff:"
OVERSIZED=$(python3 -c "print('echo ' + 'x' * 200000); print('git -C $VAULT commit -m x')")
check deny "a vault commit hidden past the read ceiling" "$(bash_json "$OVERSIZED")"
# The verdict alone does not discriminate: every deny above would satisfy it,
# and before 2026-09-21 this payload was SILENT while the bare command denied.
# The human line is what says the ceiling refused it, and it names THIS guard's
# subject rather than a sibling's.
OUT=$(bash_json "$OVERSIZED" | run_guard 2>/dev/null)
assert_contains "the human line names the ceiling, not another branch" \
  "$(reason_of "$OUT")" "too long for the vault-git guard to read"
assert_contains "the detail names the vault stake" \
  "$(context_of "$OUT")" "git write inside the memory vault past that point"
# THE SAME COMMAND, PADDED WITH SPACES INSTEAD OF `x`, AND THIS GUARD IS WHERE
# THAT MATTERED. The padding is an INPUT, not filler: 200,001 whitespace
# characters `.strip()` to "", and the first cut of this fix tested emptiness
# ABOVE the length check, so this exact payload came back silent while the vault
# write sat past the cutoff unread. Swapping an `x` for a space was the entire
# attack, and a suite padded only with `x` stayed green through it.
WS_OVERSIZED=$(python3 -c "print(' ' * 200001); print('git -C $VAULT commit -m x')")
check deny "the same vault commit behind whitespace padding" "$(bash_json "$WS_OVERSIZED")"
assert_contains "whitespace reaches the ceiling branch, not the empty-command branch" \
  "$(reason_of "$(bash_json "$WS_OVERSIZED" | run_guard 2>/dev/null)")" \
  "too long for the vault-git guard to read"
# An empty command is still nothing to guard, and the early return that says so
# survived the move — it now sits BELOW the length check rather than above it.
check allow "an all-whitespace command under the ceiling" "$(bash_json "   ")"
# With no vault to protect there is nothing to fail closed FOR, so the checker
# reads its vault argument BEFORE it judges the length. Asserted against the
# checker directly, because the guard shell exits earlier on an unset vault and
# could never show this. Without that ordering, a machine with no memory vault
# would have every oversized command refused by a guard with nothing to defend.
NOVAULT=$(printf '%s' "$OVERSIZED" | python3 "$HOOKS_DIR/lib/vault-git-check.py" "" ""; echo "exit=$?")
if [ "$NOVAULT" = "exit=0" ]; then
  PASS=$((PASS + 1)); echo "  ✅ the checker stays silent when no vault is named"
else
  FAIL=$((FAIL + 1)); echo "  ❌ an oversized command was judged with no vault to protect — [$NOVAULT]"
fi
unset OVERSIZED WS_OVERSIZED OUT NOVAULT

# The refusal is split across the hook's two channels, and each half is asserted
# on the channel it belongs to. The human line is ONE line naming the ACTION —
# which git verb, in which repository — and nothing else.
echo "the human line names the action, in one line:"
OUT=$(bash_json "git -C $VAULT rm identity/profile.md" | run_guard 2>/dev/null)
REASON=$(reason_of "$OUT")
assert_contains "leads with the verb"  "$REASON" '🛑 Blocked: `git rm` in the memory vault.'
assert_contains "points at the MCP"    "$REASON" "Use the memory MCP instead."
if [ "$(printf '%s' "$REASON" | wc -l | tr -d ' ')" = "0" ] && [ "${#REASON}" -le 120 ]; then
  PASS=$((PASS + 1)); echo "  ✅ is one line and stays short (${#REASON} chars)"
else
  FAIL=$((FAIL + 1)); echo "  ❌ the human line grew past one short line (${#REASON} chars)"
fi
# The vault path is a long absolute path, and it is detail rather than decision.
if printf '%s\n' "$REASON" | grep -qF -- "$VAULT"; then
  FAIL=$((FAIL + 1)); echo "  ❌ the human line carries the absolute vault path"
else
  PASS=$((PASS + 1)); echo "  ✅ the human line carries no absolute path"
fi
if printf '%s' "$REASON" | grep -qF -- "**"; then
  FAIL=$((FAIL + 1)); echo "  ❌ the human line uses Markdown emphasis"
else
  PASS=$((PASS + 1)); echo "  ✅ the human line carries no Markdown emphasis"
fi

echo "the detail the model needs survives, in additionalContext:"
CONTEXT=$(context_of "$OUT")
assert_contains "names the guard"      "$CONTEXT" "Vault-git guard"
assert_contains "names the verb"       "$CONTEXT" "git rm"
assert_contains "names the vault path" "$CONTEXT" "$VAULT"
assert_contains "explains the sweep"   "$CONTEXT" "deferred queue"
assert_contains "offers the MCP tools" "$CONTEXT" "delete, edit, write, append, rename"
assert_contains "offers git_sync"      "$CONTEXT" "git_sync"
assert_contains "says reads are fine"  "$CONTEXT" "Read-only git here is fine."

# The shared parser is imported by path relative to the CHECKER's own file, not
# to the working directory. A PreToolUse hook runs with whatever cwd the tool
# call had, so an import resolved from the cwd would fail everywhere but here —
# and it would fail SILENTLY, because this guard fails open.
echo "the shared-parser import survives an arbitrary working directory:"
INCIDENT="$(bash_json "git -C $VAULT rm identity/profile.md")"
for DIR in / /tmp "$HOME" "$PROJECT"; do
  OUT=$(printf '%s' "$INCIDENT" | (cd "$DIR" && WORKBENCH_MEMORY_PATH="$VAULT" \
    WORKBENCH_CONFIG_FILE="$SANDBOX/no-such-config.json" bash "$GUARD") 2>/dev/null)
  if [ "$(verdict_of "$OUT")" = "deny" ]; then
    PASS=$((PASS + 1)); echo "  ✅ still blocks when invoked from $DIR"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ failed open when invoked from $DIR"
  fi
done
OUT=$(printf '%s' "$INCIDENT" | (cd "$HOOKS_DIR" && WORKBENCH_MEMORY_PATH="$VAULT" \
  WORKBENCH_CONFIG_FILE="$SANDBOX/no-such-config.json" \
  bash ./vault-git-guard.sh) 2>/dev/null)
if [ "$(verdict_of "$OUT")" = "deny" ]; then
  PASS=$((PASS + 1)); echo "  ✅ still blocks when invoked by a relative path"
else
  FAIL=$((FAIL + 1)); echo "  ❌ failed open when invoked by a relative path"
fi

# A guard nothing calls guards nothing, so registration is part of the behaviour.
echo "the hook is registered in hooks.json:"
assert_jq "matcher is Bash" "$HOOKS_JSON" \
  '[.hooks.PreToolUse[] | select(.hooks[].command | test("vault-git-guard.sh")) | .matcher] | join(",")' \
  "Bash"
assert_jq "registered exactly once" "$HOOKS_JSON" \
  '[.hooks.PreToolUse[].hooks[] | select(.command | test("vault-git-guard.sh"))] | length' "1"
assert_jq "no if condition narrows it" "$HOOKS_JSON" \
  '[.hooks.PreToolUse[] | select(.hooks[].command | test("vault-git-guard.sh")) | .if // empty] | length' "0"

# The vault's git is unreachable by a permission rule in the other direction
# too: the memory server commits from its own process, as
# `markdown-vault-mcp <noreply@markdown-vault-mcp>`, where no PreToolUse hook
# and no permission rule can ever see it. That is structural and needs nothing.
# What DOES need asserting is that the reference document explains the rule, so
# an agent reading conventions learns it before a hook has to enforce it.
echo "vault-conventions.md documents the rule and cites the incident:"
CONVENTIONS="$(cd "$HOOKS_DIR/.." && pwd)/references/vault-conventions.md"
CONV="$(cat "$CONVENTIONS" 2>/dev/null)"
assert_contains "names the incident commit" "$CONV" "014f51b1"
assert_contains "points at the delete tool" "$CONV" "delete"
assert_contains "points at git_sync"        "$CONV" "git_sync"
assert_contains "says the server owns it"   "$CONV" "deferred"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
