#!/bin/bash
# Tests for hooks/vault-git-guard.sh — the PreToolUse memory-vault git guard.
# Run directly: ./test-vault-git-guard.sh
# Each case feeds the hook one PreToolUse payload on stdin and asserts its exit
# code: 2 = blocked, 0 = allowed. Pure stdin/exit-code checks — no network, no
# server, and the vault is a throwaway directory, never the user's real one.
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

# check <expected-exit> <description> <payload-json>
check() {
  local expected="$1" desc="$2" payload="$3" actual
  printf '%s' "$payload" | run_guard >/dev/null 2>&1
  actual=$?
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected exit $expected, got $actual"
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

bash_json() { jq -nc --arg c "$1" '{tool_name: "Bash", tool_input: {command: $c}}'; }
# The cwd key is what a bare `git commit` acts on, so most cases need it. Note
# `${2-}` rather than `${2:-}`: an EMPTY cwd is a case under test, and it must
# reach the payload rather than being defaulted.
cwd_json() {
  jq -nc --arg c "$1" --arg d "${2-}" \
    '{tool_name: "Bash", tool_input: {command: $c}, cwd: $d}'
}

# The command that lost a profile's provenance on 2026-09-04. It staged a
# deletion the memory server then swept into commit 014f51b1, whose message
# describes an unrelated note being written.
echo "blocks the command from the incident this guard exists for:"
check 2 "the exact incident command" \
  "$(bash_json "git -C $VAULT rm identity/profile.md")"

# Four shapes. A prefix deny rule can express none of them, because the verdict
# turns on which REPOSITORY the command resolves to, not on its first words.
echo "blocks each of the four ways a command names the vault:"
check 2 "git -C the vault"        "$(bash_json "git -C $VAULT commit -m x")"
check 2 "git -C a subdirectory"   "$(bash_json "git -C $VAULT/insights add .")"
check 2 "git -C, relative to cwd" "$(cwd_json 'git -C insights add .' "$VAULT")"
check 2 "cd then git"             "$(bash_json "cd $VAULT && git commit -am x")"
check 2 "cd a subdir then git"    "$(bash_json "cd $VAULT/insights && git add .")"
check 2 "cd relative to the cwd"  "$(cwd_json 'cd insights && git add .' "$VAULT")"
check 2 "a bare command, cwd"     "$(cwd_json 'git commit -am x' "$VAULT")"
check 2 "a bare command, subdir"  "$(cwd_json 'git add .' "$VAULT/insights")"
check 2 "--git-dir="              "$(bash_json "git --git-dir=$VAULT/.git rm x")"
check 2 "--git-dir, separate arg" "$(bash_json "git --git-dir $VAULT/.git rm x")"
check 2 "--work-tree="            "$(bash_json "git --work-tree=$VAULT add .")"
# An absolute cd settles the target with no cwd to resolve against, so this
# shape must block on a payload that carries none.
check 2 "cd with no cwd at all"   "$(bash_json "cd $VAULT && git rm x")"

echo "blocks every write verb it was told to block:"
for VERB in commit add rm mv push pull fetch reset checkout switch restore \
            merge rebase cherry-pick revert clean apply am init; do
  check 2 "git $VERB" "$(bash_json "git -C $VAULT $VERB")"
done
# The seven added beyond the obvious set, each reaching the object store or the
# ref namespace directly — the same blast radius as a commit.
for VERB in update-ref gc repack prune worktree notes symbolic-ref; do
  check 2 "git $VERB" "$(bash_json "git -C $VAULT $VERB")"
done

# Three listed verbs have a read-only form an agent uses routinely, so for those
# the arguments decide rather than the verb alone.
echo "blocks the mutating form of the three verbs that also have a read form:"
check 2 "git tag <name>"      "$(bash_json "git -C $VAULT tag v1.0")"
check 2 "git tag -d"          "$(bash_json "git -C $VAULT tag -d v1.0")"
check 2 "git tag -a -m"       "$(bash_json "git -C $VAULT tag -a v1.0 -m msg")"
check 2 "bare git stash"      "$(bash_json "git -C $VAULT stash")"
check 2 "git stash push"      "$(bash_json "git -C $VAULT stash push")"
check 2 "git stash pop"       "$(bash_json "git -C $VAULT stash pop")"
check 2 "git stash drop"      "$(bash_json "git -C $VAULT stash drop")"
check 2 "git branch -d"       "$(bash_json "git -C $VAULT branch -d topic")"
check 2 "git branch -D"       "$(bash_json "git -C $VAULT branch -D topic")"
check 2 "git branch --delete" "$(bash_json "git -C $VAULT branch --delete topic")"

# A prefix permission rule sees the first word and nothing else. Every shape
# below hides the verb behind something.
echo "blocks through wrappers and compound commands:"
check 2 "sudo"                "$(bash_json "sudo git -C $VAULT reset --hard")"
check 2 "env assignment"      "$(bash_json "GIT_AUTHOR_NAME=x git -C $VAULT commit -m y")"
check 2 "env with a var"      "$(bash_json "env GIT_PAGER=cat git -C $VAULT rm x")"
check 2 "nice"                "$(bash_json "nice git -C $VAULT gc")"
check 2 "an absolute git path" "$(bash_json "/usr/bin/git -C $VAULT rm x")"
check 2 "after a semicolon"   "$(bash_json "echo start; git -C $VAULT commit -m x")"
check 2 "on the || arm"       "$(bash_json "test -f x || git -C $VAULT rm x")"
check 2 "on the && arm"       "$(bash_json "true && git -C $VAULT add .")"
check 2 "bash -c"             "$(bash_json "bash -c \"cd $VAULT && git rm x\"")"
check 2 "sh -c"               "$(bash_json "sh -c \"git -C $VAULT commit -m x\"")"
check 2 "a later pipeline stage" "$(bash_json "echo x | git -C $VAULT apply")"
check 2 "-c config before -C" "$(bash_json "git -c user.name=x -C $VAULT commit -m y")"
check 2 "--no-pager before -C" "$(bash_json "git --no-pager -C $VAULT rm x")"
# Two -C flags compose, each relative to the one before it.
check 2 "composed -C flags"   "$(bash_json "git -C $VAULT -C insights add .")"

# THE PRIORITY REQUIREMENT. These are the commands the 2026-09-04 incident was
# investigated with. A guard that blocks them has cost more than it saved.
echo "allows read-only git in the vault — the whole point of the block list:"
for VERB in status log show diff ls-files rev-parse rev-list cat-file blame describe; do
  check 0 "git $VERB via -C"  "$(bash_json "git -C $VAULT $VERB")"
  check 0 "git $VERB via cwd" "$(cwd_json "git $VERB" "$VAULT")"
done
check 0 "git remote -v"       "$(bash_json "git -C $VAULT remote -v")"
check 0 "git config --get"    "$(bash_json "git -C $VAULT config --get user.email")"
check 0 "git log with args"   "$(bash_json "git -C $VAULT log --oneline -5")"
check 0 "git show a commit"   "$(bash_json "git -C $VAULT show 014f51b1")"
check 0 "git diff --stat"     "$(bash_json "git -C $VAULT diff --stat")"
check 0 "git status after cd" "$(bash_json "cd $VAULT && git status")"
check 0 "git log after cd"    "$(bash_json "cd $VAULT && git log --oneline -1")"

# Unlisted subcommands pass, which is the stated consequence of a block list.
# Each of these is a read that an allow-list guard would have had to enumerate.
echo "allows the unlisted read subcommands a block list leaves alone:"
for VERB in grep shortlog for-each-ref ls-tree count-objects help var whatchanged; do
  check 0 "git $VERB" "$(bash_json "git -C $VAULT $VERB")"
done

echo "allows the read-only form of the three dual-purpose verbs:"
check 0 "bare git tag"        "$(bash_json "git -C $VAULT tag")"
check 0 "git tag -l"          "$(bash_json "git -C $VAULT tag -l")"
check 0 "git tag -l a glob"   "$(bash_json "git -C $VAULT tag -l 'v*'")"
check 0 "git tag --list"      "$(bash_json "git -C $VAULT tag --list")"
check 0 "git tag -n"          "$(bash_json "git -C $VAULT tag -n")"
check 0 "git tag --sort="     "$(bash_json "git -C $VAULT tag --sort=-creatordate")"
check 0 "git stash list"      "$(bash_json "git -C $VAULT stash list")"
check 0 "git stash show"      "$(bash_json "git -C $VAULT stash show")"
check 0 "bare git branch"     "$(bash_json "git -C $VAULT branch")"
check 0 "git branch -a"       "$(bash_json "git -C $VAULT branch -a")"
check 0 "git branch --list"   "$(bash_json "git -C $VAULT branch --list")"

# THE OTHER PRIORITY REQUIREMENT. This guard must be invisible everywhere that
# is not the vault. Every write verb it blocks is tested again here, allowed.
echo "allows every write verb in an unrelated repository:"
for VERB in commit add rm mv push pull fetch reset checkout switch restore \
            stash merge rebase cherry-pick revert clean apply am tag init \
            update-ref gc repack prune worktree notes symbolic-ref branch; do
  check 0 "git $VERB in a project" "$(cwd_json "git $VERB" "$PROJECT")"
done
check 0 "git -C a project"      "$(bash_json "git -C $PROJECT rm x")"
check 0 "cd a project then git" "$(bash_json "cd $PROJECT && git commit -am x")"
check 0 "the incident verb elsewhere" \
  "$(cwd_json 'git rm identity/profile.md' "$PROJECT")"
check 0 "a real-world commit"   "$(cwd_json 'git commit -m "feat: add"' "$PROJECT")"
check 0 "a push from a project" "$(cwd_json 'git push origin main' "$PROJECT")"

# The prefix trap. `vault-old` starts with the vault's own path, and only a
# comparison that respects the separator keeps it a separate repository.
echo "a sibling whose name merely starts the same is not the vault:"
check 0 "vault-old via -C"      "$(bash_json "git -C $VAULT_OLD rm x")"
check 0 "vault-old via cd"      "$(bash_json "cd $VAULT_OLD && git commit -am x")"
check 0 "vault-old via cwd"     "$(cwd_json 'git rm x' "$VAULT_OLD")"
check 0 "vault-old --git-dir"   "$(bash_json "git --git-dir=$VAULT_OLD/.git rm x")"

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
check 0 "ssh"                   "$(bash_json "ssh box \"git -C $VAULT rm x\"")"
check 0 "ssh with a port flag"  "$(bash_json "ssh -p 2222 box \"git -C $VAULT commit -m x\"")"
check 0 "docker exec"           "$(bash_json "docker exec -it api git -C $VAULT rm x")"
check 0 "docker compose exec"   "$(bash_json "docker compose exec app git -C $VAULT commit -m x")"
check 0 "kubectl exec"          "$(bash_json "kubectl exec pod/api -- git -C $VAULT rm x")"
check 0 "podman exec"           "$(bash_json "podman exec api git -C $VAULT add .")"

# Naming a destructive verb is not running it. A guard that stops code search
# has repeated the mistake the database guard's suite is weighted against.
echo "allows code search and prose that merely mentions a git write:"
check 0 "grep for git rm"       "$(cwd_json "grep -rn 'git rm' hooks/" "$VAULT")"
check 0 "grep in the vault"     "$(cwd_json 'grep -rn "git commit" .' "$VAULT")"
check 0 "rg for the verb"       "$(cwd_json 'rg "git -C" --glob "*.sh"' "$VAULT")"
check 0 "echo about git rm"     "$(cwd_json 'echo "never run git rm in the vault"' "$VAULT")"
check 0 "cat a file named git"  "$(cwd_json 'cat notes/git-rm-incident.md' "$VAULT")"
check 0 "ls the vault"          "$(cwd_json 'ls -la' "$VAULT")"
check 0 "a non-git command"     "$(cwd_json 'python3 -c "print(1)"' "$VAULT")"
# gh is not git. Nothing here touches the vault's repository.
check 0 "gh pr list"            "$(cwd_json 'gh pr list' "$VAULT")"

echo "allows anything it cannot resolve or parse — this hook is not an OS boundary:"
check 0 "malformed json"          'not json at all'
check 0 "empty object"            '{}'
check 0 "an unmatched tool name"  "$(jq -nc '{tool_name: "Read", tool_input: {file_path: "/tmp/x"}}')"
check 0 "an empty command"        "$(bash_json '')"
# No cwd and a relative target means no basis for deciding, and a guess is how
# this guard would block somebody else's repository.
check 0 "no cwd, bare git commit" "$(bash_json 'git commit -am x')"
check 0 "no cwd, relative -C"     "$(bash_json 'git -C sub rm x')"
check 0 "an empty cwd"            "$(cwd_json 'git commit -am x' '')"
# An unbalanced quote is shell bash itself would reject. Blocking it would break
# ordinary one-liners and stop nothing that could actually run.
check 0 "an unbalanced quote"     "$(bash_json "git -C $VAULT rm \"unclosed")"

echo "explains the block on stderr:"
OUT=$(bash_json "git -C $VAULT rm identity/profile.md" | run_guard 2>&1)
assert_contains "names the guard"      "$OUT" "vault-git-guard"
assert_contains "names the verb"       "$OUT" "git rm"
assert_contains "names the vault path" "$OUT" "$VAULT"
assert_contains "explains the sweep"   "$OUT" "deferred queue"
assert_contains "offers the MCP tools" "$OUT" "delete, edit, write, append, rename"
assert_contains "offers git_sync"      "$OUT" "git_sync"
assert_contains "says reads are fine"  "$OUT" "Read-only git here is fine."

# The shared parser is imported by path relative to the CHECKER's own file, not
# to the working directory. A PreToolUse hook runs with whatever cwd the tool
# call had, so an import resolved from the cwd would fail everywhere but here —
# and it would fail SILENTLY, because this guard fails open.
echo "the shared-parser import survives an arbitrary working directory:"
INCIDENT="$(bash_json "git -C $VAULT rm identity/profile.md")"
for DIR in / /tmp "$HOME" "$PROJECT"; do
  printf '%s' "$INCIDENT" | (cd "$DIR" && WORKBENCH_MEMORY_PATH="$VAULT" \
    WORKBENCH_CONFIG_FILE="$SANDBOX/no-such-config.json" bash "$GUARD") >/dev/null 2>&1
  if [ "$?" = "2" ]; then
    PASS=$((PASS + 1)); echo "  ✅ still blocks when invoked from $DIR"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ failed open when invoked from $DIR"
  fi
done
printf '%s' "$INCIDENT" | (cd "$HOOKS_DIR" && WORKBENCH_MEMORY_PATH="$VAULT" \
  WORKBENCH_CONFIG_FILE="$SANDBOX/no-such-config.json" \
  bash ./vault-git-guard.sh) >/dev/null 2>&1
if [ "$?" = "2" ]; then
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
