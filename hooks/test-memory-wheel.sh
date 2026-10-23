#!/bin/bash
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/scripts/build-memory-wheel.sh"
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); echo "  ✅ $1"; }
no() { FAIL=$((FAIL + 1)); echo "  ❌ $1: $2"; }

WHEELS="$(cd "$ROOT/hooks/wheels" && ls markdown_vault_mcp-*.whl 2>/dev/null | tr '\n' ' ')"
if [ "$WHEELS" = "markdown_vault_mcp-5.1.0-py3-none-any.whl " ]; then
  ok "exactly one wheel is bundled, and it is 5.1.0"
else
  no "exactly one wheel is bundled, and it is 5.1.0" "found: ${WHEELS:-none}"
fi

if grep -qxF 'UPSTREAM_URL="https://github.com/pvliesdonk/markdown-vault-mcp.git"' "$SCRIPT"; then
  ok "the build script clones upstream"
else
  no "the build script clones upstream" "no pvliesdonk UPSTREAM_URL line"
fi

if grep -qxF 'DEFAULT_TAG="v5.1.0"' "$SCRIPT"; then
  ok "the build script defaults to v5.1.0"
else
  no "the build script defaults to v5.1.0" "no DEFAULT_TAG=\"v5.1.0\" line"
fi

if grep -qE 'TAG="\$\{1:-\$DEFAULT_TAG\}"' "$SCRIPT" && grep -qF '"$UPSTREAM_URL" "$CLONE/src"' "$SCRIPT"; then
  ok "a run with no argument builds the default tag from the upstream clone"
else
  no "a run with no argument builds the default tag from the upstream clone" "the default path does not clone UPSTREAM_URL at DEFAULT_TAG"
fi

if grep -qiE 'forks/|mikebronner/markdown-vault-mcp' "$SCRIPT"; then
  no "the build script names no fork" "it still names a fork path or the fork repository"
else
  ok "the build script names no fork"
fi

USAGE="$(bash "$SCRIPT" --help 2>&1)"
case "$USAGE" in
  *pvliesdonk/markdown-vault-mcp*"default v5.1.0"*) ok "--help names upstream and v5.1.0" ;;
  *) no "--help names upstream and v5.1.0" "$USAGE" ;;
esac

echo
echo "memory-wheel: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
