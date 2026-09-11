#!/usr/bin/env bash
#
# summary-writer-guard: PreToolUse(Bash) guard that blocks the detached
# summary-writer from writing summaries — or any markdown vault file — with Bash.
#
# The summary-writer must write only through the memory MCP with a vault-relative
# `sessions/…` path. A Bash filesystem write resolves against the process cwd —
# which, for the detached writer dispatched by session-log.sh, is the source
# project, not the vault. That misroutes summaries into project directories
# (see the summary-misroute RCA). This guard turns that silent failure into a
# loud one (exit 2), catching a stochastic tool-choice slip the instructions
# alone can't guarantee against.
#
# Scope: only active when WORKBENCH_SUMMARY_WRITER=1, which session-log.sh sets
# ONLY on the detached summary-writer process. In every other session this hook
# is a no-op — interactive Bash is never touched.
#
# Exit codes: 0 = allow (default). 2 = block; stderr is surfaced to the model
# on a blocking PreToolUse hook.

set -u

# Guard only the detached summary-writer context. Everywhere else, do nothing.
if [ "${WORKBENCH_SUMMARY_WRITER:-}" != "1" ]; then
  exit 0
fi

PAYLOAD=""
if [ ! -t 0 ]; then
  PAYLOAD=$(cat)
fi
[ -n "$PAYLOAD" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

CMD=$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -n "$CMD" ] || exit 0

# The whitespace this guard recognises, spelled out rather than [[:space:]].
#
# Same C-library dependence measured on the bash side in
# hooks/workbench-stale-bundle-guard.sh: glibc excludes U+00A0, U+202F and
# U+2007 from [[:space:]] in every locale, and Darwin includes them. Here that
# reached the FILENAME class, where it opened a real hole rather than a
# cosmetic difference. Measured through this guard:
#
#   `> foo<NBSP>.md`   allowed on Darwin, BLOCKED on glibc
#
# Bash redirects that to a file literally named foo<NBSP>.md, so it is a genuine
# markdown write, and on macOS the guard did not see it. NBSP counted as space
# on Darwin, so [^[:space:]|&;<>"]* stopped at "foo" and the \.md never matched.
#
# The ASCII set closes it in the right direction on both platforms: an exotic
# space is an ordinary filename character, so the name runs through it to the
# .md and the write is caught. It also drops a Darwin-only false positive —
# `tee<NBSP>foo.md` was blocked there and is not a tee invocation at all, since
# bash does not split words on NBSP.
#
# Newline is absent: grep matches within a line. \t is a literal tab via $'...',
# because POSIX gives a backslash no meaning inside a bracket expression.
WS=$' \t\r\v\f'

# Does the command WRITE to a markdown (.md) file? Three write shapes:
#   1. a redirect whose target is a .md file:   > foo.summary.md   >>a.md
#   2. tee/cp/mv/install/rsync touching a .md argument
#   3. sed -i editing a .md in place
# Reads of .md (cat/grep/… or `cat x.md > /dev/null`) are left alone.
writes_md=0
if printf '%s' "$CMD" | grep -Eq ">>?[$WS]*\"?[^$WS|&;<>\"]*\\.md"; then
  writes_md=1
elif printf '%s' "$CMD" | grep -Eq '\.md([^[:alnum:]]|$)' \
  && printf '%s' "$CMD" | grep -Eq "(^|[$WS])(tee|cp|mv|install|rsync)[$WS]"; then
  writes_md=1
elif printf '%s' "$CMD" | grep -Eq '\.md([^[:alnum:]]|$)' \
  && printf '%s' "$CMD" | grep -Eq "(^|[$WS])sed[$WS]+-i"; then
  writes_md=1
fi

if [ "$writes_md" = "1" ]; then
  echo "🛑 Blocked: the summary-writer must write summaries (and all vault files) via mcp__plugin_workbench-core_memory__write with a vault-relative 'sessions/…' path — never with Bash. A shell write resolves against the current directory and misroutes the file out of the vault. If the MCP write is unavailable, leave the marker and exit; do not fall back to Bash. See references/summary-format.md." >&2
  exit 2
fi

exit 0
