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
#
# The outbound prose guard reads body files, so each refused call of it
# carries, as `world`, the files and folders of the sandbox it ran in.

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

# The outbound prose guard reads body files and lists the vault root. For it, a
# refused call carries the files under the folder it ran in (the suite's
# sandbox), the folders there, and the vault root it was given, so the port can
# be run against the same files (tests/guard-differential.test.ts).
world=null
if [ "$guard" = outbound-prose-guard ] && [ "$verdict" = deny ]; then
  world=$(printf '%s' "$payload" | python3 -c '
import json, os, sys
cwd = (json.load(sys.stdin).get("cwd") or "")
files, dirs = {}, []
if os.path.isabs(cwd) and os.path.isdir(cwd):
    for top, subdirs, names in os.walk(cwd):
        subdirs[:] = sorted(d for d in subdirs if d != "stub")
        dirs.append(top)
        for name in sorted(names):
            path = os.path.join(top, name)
            # Body files only: not the stderr of the suite, nor a shim it plants,
            # whose text names the sandbox in another spelling.
            if name not in ("stderr", "starts") and os.path.isfile(path) and not os.access(path, os.X_OK) and os.path.getsize(path) <= 20000:
                with open(path, encoding="utf-8", errors="replace") as f:
                    files[path] = f.read()
print(json.dumps({"cwd": cwd, "vault": os.environ.get("WORKBENCH_MEMORY_PATH", ""), "files": files, "dirs": dirs}))
' 2>/dev/null)
  [ -n "$world" ] || world='{"error": true}'
fi

if [ "${#payload}" -le 10000 ]; then
  printf '%s' "$payload" | jq -Rsc --arg guard "$guard" \
    --arg writer "${WORKBENCH_SUMMARY_WRITER:-}" --arg verdict "$verdict" --argjson port "$port" --argjson world "$world" \
    '{guard: $guard, payload: ., writer: $writer, verdict: $verdict} + (if $port == null then {} else {port: $port} end) + (if $world == null then {} else {world: $world} end)' >>"$ORACLE_CASES_OUT"
fi
exit "$status"
