#!/bin/bash
# Tests for scripts/vault-resolve.sh, which hooks/register.ts runs on a memory
# MCP write that needs the vault root or holds [[links]]. Run directly:
# ./test-vault-resolve.sh. Every case runs against a throwaway vault, never the
# user's real one.

set -u
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$(cd "$HOOKS_DIR/.." && pwd)/scripts/vault-resolve.sh"
PASS=0
FAIL=0

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/vault-resolve.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT
VAULT="$SANDBOX/vault"
mkdir -p "$VAULT/insights" "$VAULT/decisions" "$VAULT/topics" "$VAULT/.git/x" "$VAULT/archive"
for f in insights/gate-design decisions/2026-10-06-x topics/twice archive/twice .git/x/hidden "insights/spaced name"; do
  printf -- '---\nname: x\ntype: insight\n---\n' > "$VAULT/$f.md"
done

resolve() { WORKBENCH_MEMORY_PATH="$VAULT" WORKBENCH_CONFIG_FILE="$SANDBOX/none.json" bash "$SCRIPT" "$@"; }

ok() { PASS=$((PASS + 1)); echo "  ✅ $1"; }
no() { FAIL=$((FAIL + 1)); echo "  ❌ $1"; }
assert_eq()       { if [ "$2" = "$3" ]; then ok "$1"; else no "$1 (got: $2)"; fi; }
assert_contains() { if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else no "$1 (missing: $3)"; fi; }
assert_missing()  { if printf '%s' "$2" | grep -qF -- "$3"; then no "$1 (found: $3)"; else ok "$1"; fi; }

TAB=$'\t'

echo "the root comes first, on its own when no target is given:"
assert_eq "root only" "$(resolve)" "root${TAB}$VAULT"
assert_eq "a trailing slash is dropped" "$(WORKBENCH_MEMORY_PATH="$VAULT/" WORKBENCH_CONFIG_FILE="$SANDBOX/none.json" bash "$SCRIPT")" "root${TAB}$VAULT"

echo "a bare stem resolves when exactly one note carries it:"
OUT="$(resolve gate-design twice missing hidden)"
assert_contains "a unique stem"            "$OUT" "link${TAB}gate-design${TAB}/insights/gate-design.md"
assert_missing  "a stem two notes share"   "$OUT" "${TAB}twice${TAB}"
assert_missing  "a stem nothing carries"   "$OUT" "${TAB}missing${TAB}"
assert_missing  "a hidden folder is never searched" "$OUT" "${TAB}hidden${TAB}"

echo "a path target resolves when the note is there:"
OUT="$(resolve decisions/2026-10-06-x /decisions/2026-10-06-x.md decisions/nope)"
assert_contains "a vault-relative path"       "$OUT" "link${TAB}decisions/2026-10-06-x${TAB}/decisions/2026-10-06-x.md"
assert_contains "a leading slash and .md"     "$OUT" "link${TAB}/decisions/2026-10-06-x.md${TAB}/decisions/2026-10-06-x.md"
assert_missing  "a path to nothing"           "$OUT" "decisions/nope"

echo "a target that could leave the vault or glob is never resolved:"
printf 'x' > "$SANDBOX/outside.md"
OUT="$(resolve ../outside 'insights/*' 'gate-d?sign' '-name' 'a\b')"
assert_eq "nothing but the root" "$OUT" "root${TAB}$VAULT"

echo "a path with a space is printed as it is, and the hook leaves it:"
assert_contains "the spaced note" "$(resolve 'spaced name')" "/insights/spaced name.md"

echo "a vault root that is not there prints nothing:"
assert_eq "missing root" "$(WORKBENCH_MEMORY_PATH="$SANDBOX/none" WORKBENCH_CONFIG_FILE="$SANDBOX/none.json" bash "$SCRIPT" gate-design)" ""
assert_eq "relative root" "$(cd "$SANDBOX" && WORKBENCH_MEMORY_PATH="vault" WORKBENCH_CONFIG_FILE="$SANDBOX/none.json" bash "$SCRIPT")" ""

echo
echo "vault-resolve: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
