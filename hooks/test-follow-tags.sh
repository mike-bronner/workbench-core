#!/usr/bin/env bash
set -u
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
MODULE="$HOOKS_DIR/mods/follow-tags.ts"
PASS=0
FAIL=0

check() { if [ "$2" = "$3" ]; then PASS=$((PASS + 1)); echo "  ✅ $1"; else FAIL=$((FAIL + 1)); echo "  ❌ $1 (expected '$3', got '$2')"; fi; }

command -v node >/dev/null 2>&1 || { echo "FAIL: node is not on PATH, so the follow-tags module cannot be tested"; exit 1; }

SANDBOX="$(cd -P "$(mktemp -d "${TMPDIR:-/tmp}/follow-tags.XXXXXX")" && pwd -P)"
trap 'rm -rf "$SANDBOX"' EXIT
unset GIT_DIR GIT_COMMON_DIR GIT_WORK_TREE
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid

WORK="$SANDBOX/work"
git init -q --bare "$SANDBOX/remote.git"
git init -q -b main "$WORK"
git -C "$WORK" config push.followTags true
git -C "$WORK" remote add origin "$SANDBOX/remote.git"
git -C "$WORK" commit -q --allow-empty -m base
git -C "$WORK" tag -a held -m held
git -C "$WORK" push -q origin refs/heads/main:refs/heads/main refs/tags/held:refs/tags/held 2>/dev/null

tags_of() {
  MODULE="$MODULE" DIR="$WORK" BRANCH="$1" node --no-warnings --input-type=module -e '
    const { dryRunArgvOf, followedTagsOf } = await import(`file://${process.env.MODULE}`)
    const { spawnSync } = await import("node:child_process")
    const [command, ...args] = dryRunArgvOf(process.env.DIR, "origin", process.env.BRANCH)
    const ran = spawnSync(command, args, { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
    process.stdout.write(`${ran.status} ${JSON.stringify(followedTagsOf(ran.stdout, process.env.BRANCH) ?? null)}`)
  '
}

branch_from_main() {
  git -C "$WORK" checkout -q -b "$1" main
  git -C "$WORK" commit -q --allow-empty -m "$1"
}

echo "real git output, read by followedTagsOf through the dry-run argv the gate runs:"
branch_from_main annotated
git -C "$WORK" tag -a v1.0.0 -m v1.0.0
check "an annotated tag on a pushed commit is found" "$(tags_of annotated)" '0 ["v1.0.0"]'

branch_from_main plain
check "a push with no tag finds none" "$(tags_of plain)" '0 []'

branch_from_main light
git -C "$WORK" tag v-light
check "a lightweight tag on a pushed commit finds none" "$(tags_of light)" '0 []'

check "an annotated tag the remote already has finds none, on a push of main" "$(git -C "$WORK" checkout -q main && tags_of main)" '0 []'

git -C "$WORK" commit -q --allow-empty -m next
check "an annotated tag the remote already has finds none, on a fast-forward of main" "$(tags_of main)" '0 []'

check "output with no ref line for the pushed branch recognises nothing" "$(MODULE="$MODULE" node --no-warnings --input-type=module -e '
  const { followedTagsOf } = await import(`file://${process.env.MODULE}`)
  process.stdout.write(JSON.stringify(followedTagsOf("Everything up-to-date\n", "main") ?? null))
')" 'null'

git -C "$WORK" checkout -q annotated
git -C "$WORK" remote set-url origin "$SANDBOX/missing.git"
check "a dry run to a remote that cannot be read exits non-zero" "$(tags_of annotated | cut -d' ' -f1)" '128'

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
