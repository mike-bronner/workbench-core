#!/usr/bin/env bash
#
# TEST ORACLE PLUMBING. NOT PART OF THE PLUGIN.
#
# Stands in for a frozen guard while its own suite runs under
# hooks/test-guard-oracles.sh. It runs the guard named by ORACLE_REAL_GUARD on
# the payload it reads, passes the guard's output and exit status on unchanged,
# and appends one JSON line to ORACLE_CASES_OUT: the guard's name, the payload,
# the WORKBENCH_SUMMARY_WRITER flag the call ran under, and the verdict.
#
# The verdict is `deny` when the guard printed permissionDecision "deny" or
# exited 2 (the summary-writer guard's refusal), and `allow` otherwise. A
# payload past 10,000 characters is not recorded: the read-ceiling cases feed
# 200,000, and tests/guards.test.ts pins the ceiling on its own.

set -u

payload=$(cat)
out=$(printf '%s' "$payload" | bash "$ORACLE_REAL_GUARD")
status=$?
printf '%s' "$out"

verdict=allow
if [ "$status" = 2 ] || [ "$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // empty' 2>/dev/null)" = deny ]; then
  verdict=deny
fi

if [ "${#payload}" -le 10000 ]; then
  printf '%s' "$payload" | jq -Rsc --arg guard "$(basename "$ORACLE_REAL_GUARD" .sh)" \
    --arg writer "${WORKBENCH_SUMMARY_WRITER:-}" --arg verdict "$verdict" \
    '{guard: $guard, payload: ., writer: $writer, verdict: $verdict}' >>"$ORACLE_CASES_OUT"
fi
exit "$status"
