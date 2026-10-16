#!/usr/bin/env bash
set -u
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPAIR="$HOOKS_DIR/lib/false-bare.sh"
PASS=0
FAIL=0

check() { if [ "$2" = "$3" ]; then PASS=$((PASS + 1)); echo "  ✅ $1"; else FAIL=$((FAIL + 1)); echo "  ❌ $1 (expected '$3', got '$2')"; fi; }

SANDBOX="$(cd -P "$(mktemp -d "${TMPDIR:-/tmp}/false-bare.XXXXXX")" && pwd -P)"
trap 'rm -rf "$SANDBOX"' EXIT
unset GIT_DIR GIT_COMMON_DIR GIT_WORK_TREE
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null

bare_of() { git config --file "$1/config" --get core.bare; }

echo "a working-tree repo with core.bare = true is repaired:"
git init -q "$SANDBOX/main"
mkdir -p "$SANDBOX/main/src"
printf x > "$SANDBOX/main/src/file"
git -C "$SANDBOX/main" add src/file
git -C "$SANDBOX/main" config core.bare true
check "the repair names the repo" "$(bash "$REPAIR" "$SANDBOX/main/src")" "$SANDBOX/main"
check "core.bare is false again" "$(bare_of "$SANDBOX/main/.git")" "false"
check "git works in the tree again" "$(git -C "$SANDBOX/main" rev-parse --is-inside-work-tree 2>&1)" "true"
check "a second run finds nothing to repair" "$(bash "$REPAIR" "$SANDBOX/main")" ""

echo "any true spelling counts:"
git -C "$SANDBOX/main" config core.bare yes
check "core.bare = yes is repaired" "$(bash "$REPAIR" "$SANDBOX/main")" "$SANDBOX/main"
check "and set to false" "$(bare_of "$SANDBOX/main/.git")" "false"

echo "a folder sharing the main checkout's config, as a worktree does, repairs the main checkout:"
git init -q "$SANDBOX/linked"
git -C "$SANDBOX/main" config core.bare true
check "the repair names the main checkout" "$(GIT_DIR="$SANDBOX/linked/.git" GIT_COMMON_DIR="$SANDBOX/main/.git" bash "$REPAIR" "$SANDBOX/linked")" "$SANDBOX/main"
check "the shared config is false again" "$(bare_of "$SANDBOX/main/.git")" "false"
check "the folder's own config is untouched" "$(bare_of "$SANDBOX/linked/.git")" "false"

echo "core.bare = true in the main checkout's config.worktree is repaired too:"
git -C "$SANDBOX/main" config extensions.worktreeConfig true
git config --file "$SANDBOX/main/.git/config.worktree" core.bare true
check "the repair names the repo" "$(bash "$REPAIR" "$SANDBOX/main")" "$SANDBOX/main"
check "config.worktree is false again" "$(git config --file "$SANDBOX/main/.git/config.worktree" --get core.bare)" "false"
check "the shared config stays false" "$(bare_of "$SANDBOX/main/.git")" "false"
git -C "$SANDBOX/main" config core.bare true
git config --file "$SANDBOX/main/.git/config.worktree" core.bare true
check "both files at once are repaired, and the repo is named once" "$(bash "$REPAIR" "$SANDBOX/main")" "$SANDBOX/main"
check "the shared config is false" "$(bare_of "$SANDBOX/main/.git")" "false"
check "and so is config.worktree" "$(git config --file "$SANDBOX/main/.git/config.worktree" --get core.bare)" "false"

echo "a real bare repository is left unchanged:"
git init -q --bare "$SANDBOX/real.git"
BEFORE="$(cat "$SANDBOX/real.git/config")"
check "nothing is reported" "$(bash "$REPAIR" "$SANDBOX/real.git")" ""
check "core.bare stays true" "$(bare_of "$SANDBOX/real.git")" "true"
check "the config is byte for byte the same" "$(cat "$SANDBOX/real.git/config")" "$BEFORE"
mkdir -p "$SANDBOX/host"
git init -q --bare "$SANDBOX/host/nested.git"
check "a bare repo inside another folder is left alone too" "$(bash "$REPAIR" "$SANDBOX/host/nested.git")" ""
check "and keeps core.bare true" "$(bare_of "$SANDBOX/host/nested.git")" "true"
mkdir -p "$SANDBOX/proj"
git init -q --bare "$SANDBOX/proj/.git"
BEFORE="$(cd "$SANDBOX/proj/.git" && find . -type f -exec cksum {} + | sort)"
check "a deliberate bare clone at <folder>/.git, with no index, is left alone" "$(bash "$REPAIR" "$SANDBOX/proj")" ""
check "and its git folder is byte for byte the same" "$(cd "$SANDBOX/proj/.git" && find . -type f -exec cksum {} + | sort)" "$BEFORE"

echo "nothing else is touched:"
git init -q "$SANDBOX/clean"
BEFORE="$(cat "$SANDBOX/clean/.git/config")"
check "a healthy repo reports nothing" "$(bash "$REPAIR" "$SANDBOX/clean")" ""
check "and its config is unchanged" "$(cat "$SANDBOX/clean/.git/config")" "$BEFORE"
mkdir -p "$SANDBOX/plain"
check "a folder in no repo reports nothing" "$(bash "$REPAIR" "$SANDBOX/plain")" ""
check "a missing folder reports nothing" "$(bash "$REPAIR" "$SANDBOX/missing")" ""
check "no argument reports nothing" "$(bash "$REPAIR")" ""
bash "$REPAIR" "$SANDBOX/missing" >/dev/null 2>&1
check "the script exits 0 when there is nothing to do" "$?" "0"

echo "a config the script cannot write fails loudly:"
git -C "$SANDBOX/main" config core.bare true
chmod 555 "$SANDBOX/main/.git"
OUT="$(bash "$REPAIR" "$SANDBOX/main" 2>/dev/null)"
STATUS=$?
chmod 755 "$SANDBOX/main/.git"
check "the script exits 1" "$STATUS" "1"
check "and names no repo" "$OUT" ""

echo
echo "false-bare: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
