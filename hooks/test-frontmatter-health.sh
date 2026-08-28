#!/bin/bash
# Tests for skills/memory-lint/scripts/check-frontmatter-health.py.
# Run directly: ./test-frontmatter-truncation.sh
#
# The scan flags frontmatter whose PARSED value is shorter than the text that was
# written — the ` #`-starts-a-comment truncation that indexes a document
# successfully while silently discarding half its summary.
#
# Exit contract: 1 when an indexed field lost content, 0 otherwise.

set -u
CHECK="$(cd "$(dirname "$0")/.." && pwd)/skills/memory-lint/scripts/check-frontmatter-health.py"
PASS=0
FAIL=0

if ! python3 -c 'import yaml' 2>/dev/null; then
  echo "SKIP: PyYAML unavailable in this python3"
  exit 0
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

note() {  # note <file> <frontmatter-body>
  printf -- '---\n%s\n---\n\nbody text\n' "$2" > "$TMP/$1"
}

ok()  { PASS=$((PASS + 1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  ❌ $1 — $2"; }

# Assert the scan flags (or does not flag) a given vault, by exit code.
assert_rc() {
  local desc="$1" want="$2"
  python3 "$CHECK" "$TMP" >/dev/null 2>&1
  local got=$?
  [ "$got" -eq "$want" ] && ok "$desc" || bad "$desc" "expected exit $want, got $got"
}

assert_names() {  # assert the reported files are exactly these
  local desc="$1" want="$2" got
  got=$(python3 "$CHECK" "$TMP" 2>/dev/null | grep -oE 'TRUNCATED  [^ ]+' | awk '{print $2}' | sort | tr '\n' ' ' | sed 's/ $//')
  [ "$got" = "$want" ] && ok "$desc" || bad "$desc" "expected '$want', got '$got'"
}

echo "check-frontmatter-health.py"

# --- the bug it exists to catch -----------------------------------------
rm -f "$TMP"/*.md
note truncated.md 'name: t
type: insight
summary: Mike corrected me on laravel-lsp PR #284. I enabled class rename but carved out three shapes.'
assert_rc "flags a summary truncated by an unquoted #" 1
assert_names "names the offending file" "truncated.md"

# --- shapes that must NOT be flagged ------------------------------------
rm -f "$TMP"/*.md
note folded.md 'name: t
type: insight
summary: >-
  Mike corrected me on laravel-lsp PR #284. I enabled class rename but carved out
  three shapes.'
assert_rc "a folded block scalar containing # is clean" 0

rm -f "$TMP"/*.md
note quoted.md "name: 'zed-laravel PR #336 — modular monolith review'
type: insight"
assert_rc "a single-quoted value containing # is clean" 0

rm -f "$TMP"/*.md
note plain.md 'name: t
type: insight
summary: A perfectly ordinary summary with no hash in it at all.'
assert_rc "an ordinary plain scalar is clean" 0

rm -f "$TMP"/*.md
note wrapped.md 'name: t
type: insight
summary: A summary that wraps across
  two source lines without any hash.'
assert_rc "a multi-line plain scalar without # is clean" 0

# Regression: an early version compared str(parsed) for every type and flagged
# all 814 `tags: [a, b]` lines in the vault as truncated.
rm -f "$TMP"/*.md
note flowseq.md 'name: t
type: insight
tags: [alpha, beta, gamma]
summary: Fine.'
assert_rc "an inline flow-sequence tags list is clean" 0

# Regression: without the string-only guard, `name: 1.50` parses to the float 1.5
# and would be reported as a 1-character truncation. Version-named documents are a
# real shape in this vault.
rm -f "$TMP"/*.md
note versioned.md 'name: 1.50
type: insight
summary: Fine.'
assert_rc "a numeric-looking name is not mistaken for truncation" 0

rm -f "$TMP"/*.md
note dated.md 'name: t
type: insight
date: 2026-08-28
summary: Fine.'
assert_rc "an unquoted date is clean" 0

# --- misfiled abstracts: description: is never searched ------------------
rm -f "$TMP"/*.md
note desconly.md 'name: t
type: insight
description: An abstract living under a key nothing searches.'
assert_rc "an abstract under description: with no summary: fails" 1

rm -f "$TMP"/*.md
note descplus.md 'name: t
type: insight
summary: The real, indexed abstract.
description: A leftover duplicate.'
assert_rc "description: alongside a summary: is not a loss" 0

# A truncated value in a key that was never searched costs nothing extra.
rm -f "$TMP"/*.md
note benign.md 'name: t
type: insight
summary: The real abstract.
description: Truncated at PR #284 but this key is unindexed anyway.'
assert_rc "a truncated unindexed value reports but exits 0" 0

# --- robustness ----------------------------------------------------------
rm -f "$TMP"/*.md
note nofm.md 'name: t
type: insight
summary: Fine.'
printf 'no frontmatter here at all\n' > "$TMP/bare.md"
printf -- '---\nname: [unclosed\n---\n\nbody\n' > "$TMP/broken.md"
assert_rc "files without or with unparseable frontmatter are skipped, not crashed" 0

rm -f "$TMP"/*.md
assert_rc "an empty vault is clean" 0

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
