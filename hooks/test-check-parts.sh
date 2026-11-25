#!/bin/bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DECLARED="$ROOT/.workbench/suite-parts.json"
PASS=0
FAIL=0

ok() { echo "  ✅ $1"; PASS=$((PASS + 1)); }
no() { echo "  ❌ $1: $2"; FAIL=$((FAIL + 1)); }

echo "the declared suite parts cover scripts/check.sh:"

if jq -e '.parts | type == "array" and length > 0 and all(type == "string")' "$DECLARED" > /dev/null 2>&1; then
  ok "the declaration lists its parts as strings"
else
  no "the declaration lists its parts as strings" "$DECLARED is not {\"parts\": [\"...\"]}"
fi

parts="$(jq -r '.parts[]' "$DECLARED" 2> /dev/null)"
scripts="$(cd "$ROOT" && ls scripts/check-part-*.sh 2> /dev/null | sed 's|^|bash |')"
if [ -n "$parts" ] && [ "$(printf '%s\n' "$parts" | sort)" = "$(printf '%s\n' "$scripts" | sort)" ]; then
  ok "every part script is declared, and every declared part is a plain bash line of one script"
else
  no "every part script is declared" "declared: $(printf '%s' "$parts" | tr '\n' ' '); scripts: $(printf '%s' "$scripts" | tr '\n' ' ')"
fi

default="$(sed -n 's/^CHECKS="\${WORKBENCH_CHECKS-\(.*\)}"$/\1/p' "$ROOT/scripts/check.sh" | tr ' ' '\n' | sed 's/^hook_suites$/hook_suites_odd\nhook_suites_even/' | sort)"
covered=""
while IFS= read -r line; do
  [ -n "$line" ] || continue
  file="$ROOT/${line#bash }"
  checks="$(sed -n 's/^export WORKBENCH_CHECKS="\(.*\)"$/\1/p' "$file")"
  if [ -n "$checks" ] && grep -qxF 'exec /bin/bash "$(dirname "$0")/check.sh"' "$file"; then
    ok "${line#bash } runs check.sh with its own checks"
  else
    no "${line#bash } runs check.sh with its own checks" "no export WORKBENCH_CHECKS line or exec of check.sh"
  fi
  covered="$covered $checks"
done <<< "$parts"
covered="$(printf '%s\n' "$covered" | tr ' ' '\n' | sed '/^$/d' | sort)"

if [ -n "$default" ] && [ "$covered" = "$default" ]; then
  ok "the parts run every check of the full run exactly once"
else
  no "the parts run every check of the full run exactly once" "full run: $(printf '%s' "$default" | tr '\n' ' '); parts: $(printf '%s' "$covered" | tr '\n' ' ')"
fi

for check in hook_suites hook_suites_odd hook_suites_even; do
  if grep -q "^check_${check}() {" "$ROOT/scripts/check.sh"; then ok "check.sh defines check_$check"; else no "check.sh defines check_$check" "missing"; fi
done

SELECTOR="$(awk '/^hook_suites_of\(\) \{$/ {on = 1} on {print} on && /^}$/ {exit}' "$ROOT/scripts/check.sh")"
selected() {
  (
    cd "$ROOT" || exit 1
    bash() { printf '%s\n' "$1"; }
    no_files() { return 0; }
    export SANDBOX=/nonexistent
    eval "$SELECTOR"
    hook_suites_of probe "$1" "$2" | grep -v '^::' | sort
  )
}
all="$(cd "$ROOT" && printf '%s\n' hooks/test-*.sh | sort)"
whole="$(selected 0 1)"
odd="$(selected 0 2)"
even="$(selected 1 2)"
if [ -n "$SELECTOR" ] && [ -n "$all" ] && [ "$whole" = "$all" ]; then
  ok "hook_suites runs exactly the hooks/test-*.sh glob"
else
  no "hook_suites runs exactly the hooks/test-*.sh glob" "it selects: $(printf '%s' "$whole" | tr '\n' ' ')"
fi
if [ -n "$odd" ] && [ -n "$even" ] && [ -z "$(comm -12 <(printf '%s\n' "$odd") <(printf '%s\n' "$even"))" ]; then
  ok "hook_suites_odd and hook_suites_even select disjoint sets"
else
  no "hook_suites_odd and hook_suites_even select disjoint sets" "both select: $(comm -12 <(printf '%s\n' "$odd") <(printf '%s\n' "$even") | tr '\n' ' ')"
fi
if [ "$(printf '%s\n%s\n' "$odd" "$even" | sort)" = "$all" ]; then
  ok "together they select exactly the hooks/test-*.sh glob"
else
  no "together they select exactly the hooks/test-*.sh glob" "odd: $(printf '%s' "$odd" | tr '\n' ' '); even: $(printf '%s' "$even" | tr '\n' ' ')"
fi

for pinned in scripts/check.sh scripts/omit-claude-md-check.py tsconfig.json; do
  if jq -e --arg f "$pinned" '.files | type == "array" and index($f) != null' "$DECLARED" > /dev/null 2>&1 && [ -f "$ROOT/$pinned" ]; then
    ok "the declaration pins $pinned to HEAD under files"
  else
    no "the declaration pins $pinned to HEAD under files" "files does not name it, or it is missing"
  fi
done
if [ "$(jq -r '.whole' "$DECLARED" 2> /dev/null)" = "bash scripts/check.sh" ]; then
  ok "the declaration names bash scripts/check.sh as its one whole-suite line"
else
  no "the declaration names bash scripts/check.sh as its one whole-suite line" "whole is $(jq -r '.whole' "$DECLARED" 2> /dev/null)"
fi

echo
echo "check-parts: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
