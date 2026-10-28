#!/bin/bash
# Tests for scripts/omit-claude-md-check.py, the CI check that OMITS_CLAUDE_MD
# in hooks/mods/prompt-rules.ts names every agent defined with omitClaudeMd and
# nothing else. These cases run it against small fake binaries and a fake
# plugin root, so each verdict is pinned without the CLI.
# Run directly: ./test-omit-claude-md-check.sh

set -u
HOOKS="$(cd "$(dirname "$0")" && pwd)"
CHECK="$HOOKS/../scripts/omit-claude-md-check.py"
SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT
PASS=0
FAIL=0

# A built-in definition as the minified bundle writes it.
GP='Wv={agentType:"general-purpose",whenToUse:a,tools:["*"],source:"built-in",baseDir:"built-in",getSystemPrompt:()=>b};'
EXPLORE='Xv={agentType:"Explore",whenToUse:c,source:"built-in",baseDir:"built-in",model:"inherit",omitClaudeMd:!0,getSystemPrompt:()=>d};'
FETCH='var Tv="web-fetch",fBn=g(Tv);var Lht={agentType:Tv,whenToUse:`long text`,source:"built-in",maxTurns:15,omitClaudeMd:!0,getSystemPrompt:e};'
FLAG='var Tv="flag",hBn=g(Tv);'
BUN='// @bun
'
PLUGIN_AGENT='{agentType:"runner",source:"plugin",omitClaudeMd:!0,getSystemPrompt:f};'
EXPORTS_FETCH='var IE="web-fetch";export{IE,zq};'
EXPORTS_FETCH_AS='var k="web-fetch";export{a,k as IE};'
IMPORTS_FETCH='import{IE,uin}from"/$bunfs/root/chunk-a.js";var Lht={agentType:IE,source:"built-in",omitClaudeMd:!0,getSystemPrompt:e};'
IMPORTS_FETCH_AS='import{IE as Tv}from"/$bunfs/root/chunk-a.js";var Lht={agentType:Tv,source:"built-in",omitClaudeMd:!0,getSystemPrompt:e};'

# plugin_root <dir> <OMITS_CLAUDE_MD entries> [an agent file's omitClaudeMd value]
plugin_root() {
  local dir="$1" entries="$2" omit="${3:-}"
  mkdir -p "$dir/.claude-plugin" "$dir/hooks/mods" "$dir/agents"
  printf '{"name":"demo"}\n' > "$dir/.claude-plugin/plugin.json"
  printf 'export const OMITS_CLAUDE_MD: ReadonlySet<string> = new Set([\n%s\n])\n' "$entries" > "$dir/hooks/mods/prompt-rules.ts"
  if [ -n "$omit" ]; then
    printf -- '---\nname: writer\ndescription: x\nomitClaudeMd: %s\n---\nbody\n' "$omit" > "$dir/agents/writer.md"
  fi
}

# check <desc> <want exit> <binary text> <plugin root>
check() {
  local desc="$1" want="$2" text="$3" root="$4" bin got
  bin="$root.bin"
  printf '\x00\xef%s\x00' "$text" > "$bin"
  python3 "$CHECK" "$bin" "$root" > "$root.out" 2>&1
  got=$?
  if [ "$got" = "$want" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — want exit $want, got $got: $(cat "$root.out")"
  fi
}

# Each case gets a fresh root. It sets r in this shell, not a subshell, so the
# count advances.
n=0
next_root() { n=$((n + 1)); r="$SANDBOX/case$n"; }

echo "a list that matches the definitions passes:"
next_root; plugin_root "$r" "'Explore', 'web-fetch'"
check "built-ins by string and by declared name, in one chunk as 2.1.292 bundles them" 0 "$GP$EXPLORE$FETCH" "$r"
next_root; plugin_root "$r" "'Explore', 'web-fetch'"
check "a declared name read in its own chunk when another chunk gives it another string" 0 "$BUN$FLAG$BUN$GP$EXPLORE$FETCH$BUN$FLAG" "$r"
next_root; plugin_root "$r" "'Explore', 'web-fetch'"
check "an imported name read in the one chunk that exports it, as 2.1.304 bundles them" 0 "$BUN$EXPORTS_FETCH$BUN$FLAG$BUN$GP$EXPLORE$IMPORTS_FETCH" "$r"
next_root; plugin_root "$r" "'Explore', 'web-fetch'"
check "an imported name renamed on both sides" 0 "$BUN$EXPORTS_FETCH_AS$BUN$GP$EXPLORE$IMPORTS_FETCH_AS" "$r"
next_root; plugin_root "$r" "'Explore', 'writer', 'demo:writer'" true
check "a plugin agent counts under its bare and plugin names" 0 "$GP$EXPLORE" "$r"
next_root; plugin_root "$r" "'Explore'"
check "a non-built-in definition with the flag is not counted" 0 "$GP$EXPLORE$PLUGIN_AGENT" "$r"
next_root; plugin_root "$r" "'Explore'" false
check "a plugin agent with omitClaudeMd: false is not counted" 0 "$GP$EXPLORE" "$r"

echo "drift fails:"
next_root; plugin_root "$r" "'Explore'"
check "a built-in missing from the list" 1 "$GP$EXPLORE$FETCH" "$r"
next_root; plugin_root "$r" "'Explore', 'web-fetch', 'Plan'"
check "a list entry no definition backs" 1 "$GP$EXPLORE$FETCH" "$r"
next_root; plugin_root "$r" "'Explore', 'writer'" true
check "a plugin agent missing its plugin name" 1 "$GP$EXPLORE" "$r"
next_root; plugin_root "$r" "'Explore', 'general-purpose'"
check "a built-in without the flag in the list" 1 "$GP$EXPLORE" "$r"
next_root; plugin_root "$r" "'Explore'"
check "an imported built-in missing from the list" 1 "$BUN$EXPORTS_FETCH$BUN$GP$EXPLORE$IMPORTS_FETCH" "$r"

echo "a source it cannot read fails closed:"
next_root; plugin_root "$r" "'Explore'"
check "no general-purpose built-in: a layout this check does not know" 2 "$EXPLORE" "$r"
next_root; plugin_root "$r" "'Explore', 'web-fetch'"
check "a declared name with two values" 2 "$GP$EXPLORE$FETCH;var Tv=\"other\";" "$r"
next_root; plugin_root "$r" "'Explore'"
check "a declared name with no value" 2 "$GP${EXPLORE}{agentType:Qz,source:\"built-in\",omitClaudeMd:!0,getSystemPrompt:h};" "$r"
next_root; plugin_root "$r" "'Explore', 'web-fetch'"
check "a declared name with two values in its own chunk" 2 "$BUN$GP$EXPLORE$BUN$FLAG$FETCH" "$r"
next_root; plugin_root "$r" "'Explore', 'web-fetch'"
check "a declared name whose value sits only in another chunk" 2 "${BUN}var Tv=\"web-fetch\";$BUN$GP${EXPLORE}var Lht={agentType:Tv,source:\"built-in\",omitClaudeMd:!0,getSystemPrompt:e};" "$r"
next_root; plugin_root "$r" "'Explore', 'web-fetch'"
check "an imported name no chunk exports" 2 "$BUN$FLAG$BUN$GP$EXPLORE$IMPORTS_FETCH" "$r"
next_root; plugin_root "$r" "'Explore', 'web-fetch'"
check "an imported name two chunks export" 2 "$BUN$EXPORTS_FETCH$BUN${EXPORTS_FETCH_AS}$BUN$GP$EXPLORE$IMPORTS_FETCH" "$r"
next_root; plugin_root "$r" "'Explore', 'web-fetch'"
check "an imported name its exporter gives no string" 2 "${BUN}var IE=g(1);export{IE};$BUN$GP$EXPLORE$IMPORTS_FETCH" "$r"
next_root; plugin_root "$r" "'Explore'"; printf 'export const OTHER = 1\n' > "$r/hooks/mods/prompt-rules.ts"
check "no OMITS_CLAUDE_MD in prompt-rules.ts" 2 "$GP$EXPLORE" "$r"
next_root; plugin_root "$r" "'Explore'"
if python3 "$CHECK" "$SANDBOX/no-such-binary" "$r" > /dev/null 2>&1; then
  FAIL=$((FAIL + 1)); echo "  ❌ a missing binary — want exit 2, got 0"
else
  PASS=$((PASS + 1)); echo "  ✅ a missing binary"
fi

echo
echo "omit-claude-md-check: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
