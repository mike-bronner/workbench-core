#!/bin/bash
set -uo pipefail

SHELLCHECK_VERSION=0.11.0
TYPESCRIPT_VERSION=7.0.2
NODE_MAJOR=24
CLAUDE_CODE_VERSION=2.1.308

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

SCRUBBED_VARS="ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_REFRESH_TOKEN CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY CLAUDE_CODE_USE_ANTHROPIC_AWS CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD CLAUDE_CODE_USE_GATEWAY CLAUDE_CODE_USE_MANTLE"

in_sandbox() {
  local unset_args=() var
  for var in $SCRUBBED_VARS; do unset_args+=(-u "$var"); done
  env "${unset_args[@]}" HOME="$SANDBOX" CLAUDE_CONFIG_DIR="$SANDBOX/.claude" "$@"
}

claude_cli() {
  in_sandbox npx --yes -p "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" claude "$@"
}

preflight() {
  local problems=0 tool found
  for tool in git jq python3 shellcheck node npx; do
    if ! command -v "$tool" > /dev/null 2>&1; then
      echo "MISSING TOOL: $tool is not on PATH."
      problems=1
    fi
  done
  if command -v shellcheck > /dev/null 2>&1; then
    found=$(shellcheck --version | sed -n 's/^version: //p')
    if [ "$found" != "$SHELLCHECK_VERSION" ]; then
      echo "WRONG VERSION: shellcheck is '$found', the pin is $SHELLCHECK_VERSION."
      problems=1
    fi
  fi
  if command -v node > /dev/null 2>&1; then
    found=$(node --version)
    if [ "${found%%.*}" != "v$NODE_MAJOR" ]; then
      echo "WRONG VERSION: node is '$found', the pin is Node $NODE_MAJOR."
      problems=1
    fi
  fi
  if command -v npx > /dev/null 2>&1; then
    found=$(claude_cli --version 2> /dev/null | awk '{print $1}')
    if [ "$found" != "$CLAUDE_CODE_VERSION" ]; then
      echo "WRONG VERSION: claude through npx is '$found', the pin is $CLAUDE_CODE_VERSION."
      problems=1
    fi
  fi
  return "$problems"
}

tracked_shell_files() {
  git ls-files '*.sh'
}

no_files() {
  echo "::error::$1 found no files to check"
  return 1
}

check_plugin_json() {
  local f=.claude-plugin/plugin.json field version
  jq empty "$f" || return 1
  for field in name version description author; do
    jq -e ".${field}" "$f" > /dev/null \
      || { echo "::error file=${f}::missing required field: ${field}"; return 1; }
  done
  version=$(jq -r '.version' "$f")
  if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9.-]+)?$ ]]; then
    echo "::error file=${f}::version '$version' is not semver"
    return 1
  fi
}

check_mcp_refs() {
  local plugin_name fail=0 ref prefix body matched server
  local servers=() refs=()
  plugin_name=$(jq -r '.name' .claude-plugin/plugin.json)
  while IFS= read -r server; do servers+=("$server"); done \
    < <(jq -r '.mcpServers // {} | keys[]' .claude-plugin/plugin.json)
  while IFS= read -r ref; do refs+=("$ref"); done \
    < <(grep -rhoE 'mcp__plugin_[A-Za-z0-9_-]+__[A-Za-z0-9_]+' \
      --include='*.md' --include='*.sh' --include='*.json' \
      agents hooks references skills assets 2>/dev/null | sort -u)
  for ref in ${refs[@]+"${refs[@]}"}; do
    prefix="${ref%__*}"
    body="${prefix#mcp__plugin_}"
    matched=0
    for server in ${servers[@]+"${servers[@]}"}; do
      if [ "$body" = "${plugin_name}_${server}" ]; then
        matched=1
        break
      fi
    done
    if [ "$matched" -eq 0 ]; then
      echo "::error::stale MCP tool ref: ${ref} (expected prefix for plugin '${plugin_name}', servers: ${servers[*]-})"
      fail=1
    fi
  done
  return "$fail"
}

check_shellcheck() {
  local scripts=() f
  while IFS= read -r f; do scripts+=("$f"); done < <(tracked_shell_files)
  [ "${#scripts[@]}" -gt 0 ] || no_files shellcheck || return 1
  shellcheck --version
  printf '%s\n' "${scripts[@]}"
  shellcheck --severity=warning -x "${scripts[@]}"
}

check_bash_syntax() {
  local fail=0 count=0 f
  while IFS= read -r f; do
    count=$((count + 1))
    bash -n "$f" || fail=1
  done < <(tracked_shell_files)
  [ "$count" -gt 0 ] || no_files bash_syntax || return 1
  return "$fail"
}

check_hook_suites() {
  local fail=0 count=0 t
  for t in hooks/test-*.sh; do
    [ -f "$t" ] || continue
    count=$((count + 1))
    echo "::group::$t"
    if HOME="$SANDBOX" bash "$t"; then
      echo "::endgroup::"
    else
      echo "::endgroup::"
      echo "::error file=${t}::test suite failed"
      fail=1
    fi
  done
  [ "$count" -gt 0 ] || no_files hook_suites || return 1
  return "$fail"
}

check_frontmatter() {
  local fail=0 count=0 f fm
  for f in skills/*/SKILL.md agents/*.md; do
    [ -f "$f" ] || continue
    count=$((count + 1))
    if ! head -1 "$f" | grep -qx -- '---'; then
      echo "::error file=${f}::missing opening frontmatter"
      fail=1
      continue
    fi
    if ! awk 'NR>1 && /^---$/ {print NR; exit}' "$f" | grep -qE '^[0-9]+$'; then
      echo "::error file=${f}::missing closing frontmatter"
      fail=1
      continue
    fi
    fm=$(awk 'NR==1&&/^---$/ {on=1; next} on && /^---$/ {exit} on' "$f")
    if ! echo "$fm" | grep -qE '^description:'; then
      echo "::error file=${f}::frontmatter missing required field: description"
      fail=1
    fi
  done
  [ "$count" -gt 0 ] || no_files frontmatter || return 1
  return "$fail"
}

check_plugin_root_refs() {
  local fail=0 r refs=()
  while IFS= read -r r; do refs+=("$r"); done \
    < <(grep -rhoE '\$\{CLAUDE_PLUGIN_ROOT\}/[A-Za-z0-9_./-]+' \
      --include='*.md' --include='*.sh' \
      agents hooks references skills assets 2>/dev/null \
      | sed 's|${CLAUDE_PLUGIN_ROOT}/||; s|[.]*$||' \
      | sort -u)
  for r in ${refs[@]+"${refs[@]}"}; do
    if [ ! -e "$r" ]; then
      echo "::error::broken reference: \${CLAUDE_PLUGIN_ROOT}/$r"
      fail=1
    fi
  done
  return "$fail"
}

check_plugin_validate() {
  claude_cli plugin validate .
}

check_plugin_test() {
  claude_cli plugin test .
}

check_omits_claude_md() {
  local claude_bin
  claude_bin=$(in_sandbox npx --yes -p "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    python3 -c 'import os, shutil; print(os.path.realpath(shutil.which("claude") or ""))') || return 1
  [ -f "$claude_bin" ] || { echo "::error::cannot resolve the pinned claude binary"; return 1; }
  python3 scripts/omit-claude-md-check.py "$claude_bin"
}

check_typescript() {
  local t
  rm -rf .claude-plugin/types
  CLAUDE_CODE_PLUGIN_DIR_WATCH=1 claude_cli -p 'lay the types' --plugin-dir "$ROOT" < /dev/null || true
  for t in claude-code claude-code-tools claude-code-mcp; do
    [ -f ".claude-plugin/types/$t/index.d.ts" ] \
      || { echo "::error::the CLI laid no $t types, so the type-check cannot run"; return 1; }
  done
  npx --yes -p "typescript@${TYPESCRIPT_VERSION}" tsc -p tsconfig.json
}

CHECKS="${WORKBENCH_CHECKS-plugin_json mcp_refs shellcheck bash_syntax hook_suites frontmatter plugin_root_refs plugin_validate plugin_test omits_claude_md typescript}"
read -r -a CHECK_LIST <<< "$CHECKS"
if [ "${#CHECK_LIST[@]}" -eq 0 ]; then
  echo "FAIL: WORKBENCH_CHECKS names no check. Unset it to run every check."
  exit 2
fi

echo "== preflight: tools and pinned versions"
if ! preflight; then
  echo "FAIL preflight: fix the tools named above. No check ran."
  exit 2
fi

failed=""
results=""
for check in "${CHECK_LIST[@]}"; do
  echo "== $check"
  if "check_$check"; then
    results="${results}PASS $check"$'\n'
  else
    results="${results}FAIL $check"$'\n'
    failed="$failed $check"
  fi
done

echo "== results"
printf '%s' "$results"
if [ -n "$failed" ]; then
  echo "FAILED:$failed"
  exit 1
fi
if [ -n "${WORKBENCH_CHECKS+set}" ]; then
  echo "SUBSET PASSED: only ${CHECK_LIST[*]} ran, because WORKBENCH_CHECKS is set. This is not a full run."
  exit 0
fi
echo "All checks passed."
