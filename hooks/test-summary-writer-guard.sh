#!/bin/bash
# Tests for summary-writer-guard.sh. Run directly: ./test-summary-writer-guard.sh
# The guard is a PreToolUse(Bash) hook that blocks the detached summary-writer
# from writing markdown vault files with Bash (it must use the memory MCP). It
# is scoped to WORKBENCH_SUMMARY_WRITER=1 and is a no-op everywhere else.

set -u
GUARD="$(cd "$(dirname "$0")" && pwd)/summary-writer-guard.sh"
PASS=0
FAIL=0

# Run the guard with a synthetic PreToolUse Bash payload.
#   $1 = the bash command string
#   $2 = WORKBENCH_SUMMARY_WRITER value ("1" or "")
# Prints nothing; returns the guard's exit code.
run_guard() {
  local cmd="$1" flag="$2"
  local payload
  payload=$(jq -cn --arg c "$cmd" '{tool_name:"Bash", tool_input:{command:$c}}')
  printf '%s' "$payload" | WORKBENCH_SUMMARY_WRITER="$flag" bash "$GUARD" 2>/dev/null
}

assert_blocked() {
  local desc="$1" cmd="$2" flag="$3"
  run_guard "$cmd" "$flag"
  if [ "$?" -eq 2 ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected block (exit 2)"
  fi
}

assert_allowed() {
  local desc="$1" cmd="$2" flag="$3"
  run_guard "$cmd" "$flag"
  if [ "$?" -eq 0 ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected allow (exit 0)"
  fi
}

echo "in summary-writer context (WORKBENCH_SUMMARY_WRITER=1) — Bash .md writes are blocked:"
assert_blocked "redirect into a .summary.md"     'cat > memory/sessions/2026-07-01/abc.summary.md <<EOF' "1"
assert_blocked "append into a .md"               'echo hi >> notes.md'                                   "1"
assert_blocked "heredoc redirect to abs .md"     'cat > /tmp/x.summary.md <<EOF'                          "1"
assert_blocked "tee a .md"                       'echo x | tee out.md'                                    "1"
assert_blocked "cp to a .md destination"         'cp a.txt b.summary.md'                                  "1"
assert_blocked "sed -i on a .md"                 'sed -i "s/a/b/" notes.md'                               "1"

echo "an exotic space in a filename does not hide the write:"
# The guard spells its whitespace out as ASCII literals rather than using
# [[:space:]], because that class is a property of the C library and not only of
# the locale: glibc excludes U+00A0, U+202F and U+2007 in every locale, and
# Darwin includes them. That reached the FILENAME class here, and it was a hole
# rather than a cosmetic difference. Measured before the fix:
#
#   `> foo<NBSP>.md`   allowed on Darwin, blocked on glibc
#
# Bash redirects that to a file literally named foo<NBSP>.md, so it is a real
# markdown write that macOS waved through — NBSP counted as space there, so
# [^[:space:]|&;<>"]* stopped at "foo" and never reached the .md.
#
# U+3000 covers the other direction: both libcs call it space in a UTF-8 locale,
# so that case was missed on BOTH before the fix, and it is what reddens on the
# Linux runner if the ASCII set is reverted.
NBSP=$(printf '\302\240')
IDSP=$(printf '\343\200\200')
assert_blocked "redirect to a .md named with an NBSP" "> foo${NBSP}.md"        "1"
assert_blocked "redirect to a .md named with an IDSP" "> foo${IDSP}.md"        "1"
assert_blocked "append to a .md named with an NBSP"   "echo hi >> a${NBSP}b.md" "1"

echo "in summary-writer context — non-.md-write commands are allowed:"
# The mirror of the cases above, and the reason the fix is an ASCII set rather
# than a wider class. Bash does not split words on an exotic space, so
# `tee<NBSP>out.md` is one unknown command name and writes nothing. Darwin
# blocked it before the fix purely because NBSP satisfied the preceder class.
assert_allowed "NBSP-joined 'tee' is not a tee invocation" "tee${NBSP}out.md"  "1"
assert_allowed "NBSP-joined 'sed -i' is not a sed call"    "sed${NBSP}-i x.md" "1"
assert_allowed "delete the .json marker"         'rm /cache/pending-summaries/abc.json'                   "1"
assert_allowed "read a .md (redirect to null)"   'cat sessions/x.md > /dev/null'                          "1"
assert_allowed "grep a .md"                      'grep foo sessions/x.md'                                 "1"

echo "outside summary-writer context (flag unset) — never interferes:"
assert_allowed "Bash .md write allowed normally" 'cat > notes.summary.md <<EOF'                           ""

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
