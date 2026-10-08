#!/bin/bash
# Tests for hooks/lib/scan-query.py, which reads a repo scan's own search query
# out of a Bash command. The hooks module runs it for scan recall
# (hooks/register.ts, scanRecall), and tests/recall.test.ts covers what the
# module does with the query. Run directly: ./test-scan-query.sh
#
# These are the extraction cases of the retired memory-scan-recall.sh suite:
# the extractor fires on content searches that read files, and on nothing else.

set -u
HOOKS="$(cd "$(dirname "$0")" && pwd)"
EXTRACTOR="$HOOKS/lib/scan-query.py"
PASS=0
FAIL=0

query() { printf '%s' "$2" | python3 "$EXTRACTOR" "$1" 2>/dev/null; }

assert_query() {
  local desc="$1" tool="$2" input="$3" want="$4" got
  got="$(query "$tool" "$input")"
  if [ "$got" = "$want" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — want '$want', got '$got'"
  fi
}

echo "a content search yields its query:"
assert_query "grep -rn with a quoted phrase" Bash 'grep -rn "memory recall dedup" hooks/' 'memory recall dedup'
assert_query "rg with a pattern"             Bash "rg -n 'memory recall dedup' hooks"      'memory recall dedup'
assert_query "git grep"                      Bash 'git grep -n "memory recall dedup" -- hooks' 'memory recall dedup'
assert_query "behind a no-op prefix"         Bash 'sudo grep -rn "memory recall dedup" /etc' 'memory recall dedup'
assert_query "an alternation is reduced to its words, once each" Bash "rg 'memory-recall|memory_recall' hooks" 'memory recall'
assert_query "the file-reading search before a pipe" Bash 'grep -rn "memory recall dedup" hooks | grep -v test' 'memory recall dedup'

echo "a call with no content search yields nothing:"
assert_query "a test runner"                 Bash 'npm test -- --watch=false' ''
assert_query "a path search (find)"          Bash 'find . -name "*.recall.test.ts"' ''
assert_query "a directory listing"           Bash 'ls -la hooks/memory-recall' ''
assert_query "rg --files has no pattern"     Bash 'rg --files -g "*.markdown"' ''
assert_query "patterns read from a file"     Bash 'grep -f patterns.txt hooks/memory/recall' ''

echo "the search word is read by argument slot, never as a substring:"
assert_query "git log --grep is no repo scan" Bash 'git log --grep="rg memory recall dedup" --oneline' ''
assert_query "a search word in a string literal is data" Bash 'echo "run rg memory recall dedup later" >> notes.md' ''

echo "a search that reads stdin filters output, so it is no repo scan:"
assert_query "grep after a pipe"             Bash 'cat notes.md | grep -i "memory recall dedup"' ''
assert_query "a pipeline filter's alternation" Bash 'git diff | grep -E "real|allow|deny"' ''
assert_query "a here-string search"          Bash 'grep -c "memory recall dedup" <<< "$notes"' ''

echo
echo "scan-query: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
