#!/bin/bash
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GUARD="$ROOT/hooks/mods/vault-write.ts"
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); echo "  ✅ $1"; }
no() { FAIL=$((FAIL + 1)); echo "  ❌ $1: $2"; }

WHEEL="$(ls -t "$ROOT"/hooks/wheels/markdown_vault_mcp-*.whl 2>/dev/null | head -n 1)"
echo "the vault write guard knows every write tool the bundled server registers:"
if [ -z "$WHEEL" ] || [ ! -r "$GUARD" ]; then
  no "the wheel and the guard are readable" "wheel=[$WHEEL] guard=[$GUARD]"
  echo
  echo "$PASS passed, $FAIL failed"
  exit 1
fi

SERVER="$(unzip -p "$WHEEL" markdown_vault_mcp/_write_tools.py \
  | awk '/^WRITE_TOOL_NAMES/ {on = 1; next} on && /^\)/ {exit} on' \
  | sed -n 's/^ *"\([a-z_]*\)",.*/\1/p' | sort)"
KNOWN="$(awk '/^export const WRITE_TOOLS/ {on = 1; next} on && /^}/ {exit} on' "$GUARD" \
  | sed -n 's/^ *\([a-z_]*\):.*/\1/p' | sort)"

if [ "$(printf '%s\n' "$SERVER" | grep -c .)" -lt 10 ]; then
  no "the server's list was read" "found: $(printf '%s' "$SERVER" | tr '\n' ' ')"
else
  ok "the server's list was read ($(printf '%s\n' "$SERVER" | grep -c .) tools)"
fi

MISSING="$(comm -23 <(printf '%s\n' "$SERVER") <(printf '%s\n' "$KNOWN"))"
EXTRA="$(comm -13 <(printf '%s\n' "$SERVER") <(printf '%s\n' "$KNOWN"))"
if [ -z "$MISSING" ]; then ok "every server write tool is in the guard's table"; else no "every server write tool is in the guard's table" "missing: $(printf '%s' "$MISSING" | tr '\n' ' ')"; fi
if [ -z "$EXTRA" ]; then ok "the guard's table names no tool the server lacks"; else no "the guard's table names no tool the server lacks" "extra: $(printf '%s' "$EXTRA" | tr '\n' ' ')"; fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
