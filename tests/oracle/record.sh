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
#
# The destructive-scope, destructive-database and vault-git guards read the
# disk and git. For them, with ORACLE_WORLD_FACTS=1 (hooks/test-guard-oracles.sh
# --write), a refused call also runs tests/oracle/port-facts.js here, in the
# environment the suite gave the guard, and the line carries what the port
# made of it and the facts it asked about. That needs deno.

set -u

payload=$(cat)
out=$(printf '%s' "$payload" | bash "$ORACLE_REAL_GUARD")
status=$?
printf '%s' "$out"

verdict=allow
if [ "$status" = 2 ] || [ "$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // empty' 2>/dev/null)" = deny ]; then
  verdict=deny
fi

guard=$(basename "$ORACLE_REAL_GUARD" .sh)
port='null'
case "$guard" in
  destructive-scope-guard | destructive-database-guard | vault-git-guard)
    if [ "${ORACLE_WORLD_FACTS:-}" = 1 ] && [ "$verdict" = deny ] && [ "${#payload}" -le 10000 ]; then
      port=$(printf '%s' "$payload" | deno run -A --quiet --unstable-sloppy-imports "$(dirname "$0")/port-facts.js" 2>/dev/null)
      [ -n "$port" ] || port='{"verdict": "error"}'
    fi
    ;;
esac

if [ "${#payload}" -le 10000 ]; then
  printf '%s' "$payload" | jq -Rsc --arg guard "$guard" \
    --arg writer "${WORKBENCH_SUMMARY_WRITER:-}" --arg verdict "$verdict" --argjson port "$port" \
    '{guard: $guard, payload: ., writer: $writer, verdict: $verdict} + (if $port == null then {} else {port: $port} end)' >>"$ORACLE_CASES_OUT"
fi
exit "$status"
