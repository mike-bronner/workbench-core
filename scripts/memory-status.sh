#!/usr/bin/env bash
#
# memory-status.sh — report the shared memory server's health and key facts.
#
# A human-facing diagnostic for the lazy-start shared HTTP memory server: it
# resolves the configured vault/cache/port, runs the same identity-checked probe
# the warmup and host use, and prints status plus the artifacts that explain it
# (pid, port, token presence, recent server.log, any failure/conflict markers).
# Read-only by default; pass `start` or `stop` to act.
#
# Usage:
#   memory-status.sh         # print status (default)
#   memory-status.sh start   # kick a lazy start (memory-server-up.sh)
#   memory-status.sh stop     # stop the server (memory-server-down.sh)
#
# Always exits 0 on a plain status read; start/stop propagate nothing fatal.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# scripts/ sits beside hooks/ in the plugin tree. Honor CLAUDE_PLUGIN_ROOT.
HOOKS_DIR="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/hooks}"
HOOKS_DIR="${HOOKS_DIR:-$(cd "$SCRIPT_DIR/../hooks" && pwd)}"

# shellcheck source=hooks/lib/memory-env.sh
. "$HOOKS_DIR/lib/memory-env.sh"
# shellcheck source=hooks/lib/memory-probe.sh
. "$HOOKS_DIR/lib/memory-probe.sh"
memory_load_env

ACTION="${1:-status}"

case "$ACTION" in
  start)
    echo "Kicking a lazy start of the shared memory server ..."
    bash "$HOOKS_DIR/memory-server-up.sh" < /dev/null
    echo "Kicked. The server binds in ~2s; re-run 'memory-status' to confirm."
    exit 0
    ;;
  stop)
    bash "$HOOKS_DIR/memory-server-down.sh"
    exit 0
    ;;
  status|"")
    : # fall through to the report
    ;;
  *)
    echo "Usage: memory-status.sh [status|start|stop]"
    exit 0
    ;;
esac

STATUS="$(memory_probe)"

echo "Memory server status"
echo "===================="
echo "vault (source)   : $MEMORY_PATH"
echo "cache            : $CACHE_PATH"
echo "server name      : $MCP_NAME"
echo "configured port  : $MEMORY_PORT"

# Decode the probe word into a human line.
case "$STATUS" in
  UP)          echo "health           : UP — serving, index built" ;;
  BUILDING)    echo "health           : BUILDING — serving (index still building; search available, keyword-only)" ;;
  DOWN_NONE)   echo "health           : DOWN — nothing listening (run 'memory-status start')" ;;
  DOWN_FAILED) echo "health           : DOWN — last start FAILED (see server.log below)" ;;
  DOWN_FOREIGN)echo "health           : CONFLICT — a different process holds the port" ;;
  PORT_DRIFT)  echo "health           : PORT DRIFT — recorded server.port != configured port" ;;
  *)           echo "health           : $STATUS" ;;
esac

# Recorded artifacts.
if [ -f "$CACHE_PATH/server.pid" ]; then
  PID="$(cat "$CACHE_PATH/server.pid" 2>/dev/null)"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "server.pid       : $PID (alive)"
  else
    echo "server.pid       : ${PID:-?} (not running)"
  fi
fi
[ -f "$CACHE_PATH/server.port" ] && echo "server.port      : $(cat "$CACHE_PATH/server.port" 2>/dev/null)"
if [ -s "$CACHE_PATH/server.token" ]; then
  echo "bearer token     : present (0600)"
else
  echo "bearer token     : MISSING — run /workbench-core:customize to provision it"
fi

# Surface failure / conflict breadcrumbs verbatim.
if [ -f "$CACHE_PATH/.server-failed" ]; then
  echo
  echo "--- .server-failed ---"
  cat "$CACHE_PATH/.server-failed" 2>/dev/null
fi
if [ -f "$CACHE_PATH/.port-conflict" ]; then
  echo
  echo "--- .port-conflict ---"
  cat "$CACHE_PATH/.port-conflict" 2>/dev/null
fi

# A short server.log tail helps diagnose a failed/odd start.
if [ -f "$CACHE_PATH/server.log" ]; then
  echo
  echo "--- server.log (last 15 lines) ---"
  tail -n 15 "$CACHE_PATH/server.log" 2>/dev/null
fi

echo
echo "Actions: 'memory-status start' to start · 'memory-status stop' to stop."
exit 0
