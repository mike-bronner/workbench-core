#!/bin/bash
set -u
HOOKS="$(cd "$(dirname "$0")" && pwd)"
SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT
PASS=0
FAIL=0

ROOT="$SANDBOX/root"
mkdir -p "$ROOT/scripts"
cp "$HOOKS/../scripts/check.sh" "$ROOT/scripts/check.sh"

stub() {
  printf '#!/bin/bash\n%s\n' "$2" > "$1"
  chmod +x "$1"
}

make_bin() {
  local bin="$1" skip="${2:-}" tool
  mkdir -p "$bin"
  for tool in dirname mktemp rm sed awk env; do
    ln -s "$(command -v "$tool")" "$bin/$tool"
  done
  stub "$bin/git" 'exit 0'
  stub "$bin/python3" 'exit 0'
  stub "$bin/shellcheck" 'echo ShellCheck; echo "version: ${FAKE_SC:-0.11.0}"'
  stub "$bin/node" 'echo "${FAKE_NODE:-v24.1.0}"'
  stub "$bin/npx" "[ -n \"\${ANTHROPIC_API_KEY+x}\${CLAUDE_CODE_USE_BEDROCK+x}\" ] && echo LEAKED >> '$LEAK'
case \" \$* \" in *\" --version \"*) echo \"\${FAKE_CLAUDE:-2.1.308} (Claude Code)\" ;; esac
exit 0"
  stub "$bin/jq" 'case " $* " in *" -r "*) echo 1.0.0 ;; esac; exit "${FAKE_JQ_EXIT:-0}"'
  if [ -n "$skip" ]; then
    rm "$bin/$skip"
  fi
}

LEAK="$SANDBOX/leaked"
make_bin "$SANDBOX/bin"
make_bin "$SANDBOX/bin-no-python" python3
make_bin "$SANDBOX/bin-no-npx" npx

OUT="$SANDBOX/out"

run() {
  local bin="$1"
  shift
  env -i PATH="$bin" TMPDIR="$SANDBOX" WORKBENCH_CHECKS=plugin_json "$@" /bin/bash "$ROOT/scripts/check.sh" > "$OUT" 2>&1
}

expect() {
  local desc="$1" want="$2" got="$3"
  shift 3
  local ok=1 line
  [ "$got" = "$want" ] || ok=0
  for line in "$@"; do
    case "$line" in
      '!'*) grep -qF -- "${line#!}" "$OUT" && ok=0 ;;
      *) grep -qF -- "$line" "$OUT" || ok=0 ;;
    esac
  done
  if [ "$ok" -eq 1 ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — want exit $want, got $got"; sed 's/^/     /' "$OUT"
  fi
}

run "$SANDBOX/bin-no-python"
expect "a missing tool is named and no check runs" 2 $? \
  "MISSING TOOL: python3 is not on PATH." "FAIL preflight" "!== plugin_json"

run "$SANDBOX/bin" FAKE_SC=0.10.0
expect "a wrong shellcheck version is named and no check runs" 2 $? \
  "WRONG VERSION: shellcheck is '0.10.0'" "!== plugin_json"

run "$SANDBOX/bin" FAKE_NODE=v22.3.0
expect "a wrong node version is named and no check runs" 2 $? \
  "WRONG VERSION: node is 'v22.3.0'" "!== plugin_json"

run "$SANDBOX/bin" FAKE_CLAUDE=2.1.312
expect "a wrong claude version is named and no check runs" 2 $? \
  "WRONG VERSION: claude through npx is '2.1.312'" "!== plugin_json"

run "$SANDBOX/bin" FAKE_JQ_EXIT=1
expect "a failing check is named and fails the run" 1 $? \
  "FAIL plugin_json" "FAILED: plugin_json" "!All checks passed."

run "$SANDBOX/bin"
expect "a clean subset run passes and says it was a subset" 0 $? \
  "PASS plugin_json" "SUBSET PASSED: only plugin_json ran" "!All checks passed." "!FAILED"

run "$SANDBOX/bin" WORKBENCH_CHECKS="plugin_json mcp_refs"
expect "a partial list names every check it ran" 0 $? \
  "PASS plugin_json" "PASS mcp_refs" "SUBSET PASSED: only plugin_json mcp_refs ran" "!All checks passed."

run "$SANDBOX/bin" WORKBENCH_CHECKS="   "
expect "a blank check list fails before any check" 2 $? \
  "WORKBENCH_CHECKS names no check" "!== plugin_json" "!All checks passed." "!SUBSET PASSED"

run "$SANDBOX/bin-no-npx"
expect "a missing npx is named and no check runs" 2 $? \
  "MISSING TOOL: npx is not on PATH." "!== plugin_json"

rm -f "$LEAK"
run "$SANDBOX/bin" ANTHROPIC_API_KEY=x CLAUDE_CODE_USE_BEDROCK=1
code=$?
[ -e "$LEAK" ] && echo "LEAKED: a credential or provider switch reached the CLI" >> "$OUT"
expect "no credential or provider switch reaches the CLI" 0 "$code" "!LEAKED" "PASS plugin_json"

for check in shellcheck bash_syntax hook_suites frontmatter; do
  run "$SANDBOX/bin" WORKBENCH_CHECKS="$check"
  expect "$check fails on an empty file list" 1 $? \
    "$check found no files to check" "FAIL $check" "FAILED: $check"
done

echo
echo "check-script: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
