#!/usr/bin/env bash
#
# memory-server-down: manually stop the shared HTTP memory server.
#
# NOT a hook. The shared server follows a single never-stop model — once up it
# stays up across sessions — so this is the ONLY stop path, and it is explicit:
# run it (or /workbench-core:memory-status's stop affordance) when you want the
# server gone (e.g. to change ports, free the port, or force a clean restart).
#
# It reads server.pid, verifies the process is actually our server before
# killing (never kill an unrelated PID that happens to match a stale pid file),
# sends SIGTERM (then SIGKILL if it lingers), and tidies the pid/port files and
# any spawn lock. Always exits 0; prints a short human-readable status to stdout
# (this is a CLI tool, not a context-injecting hook).

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/hooks}"
HOOKS_DIR="${HOOKS_DIR:-$SCRIPT_DIR}"

# shellcheck source=hooks/lib/memory-env.sh
. "$HOOKS_DIR/lib/memory-env.sh"
memory_load_env

SERVER_PID_FILE="$CACHE_PATH/server.pid"
SERVER_PORT_FILE="$CACHE_PATH/server.port"
LOCK_DIR="$CACHE_PATH/server.lock"

cleanup_files() {
  rm -f "$SERVER_PID_FILE" "$SERVER_PORT_FILE" 2>/dev/null || true
  rm -rf "$LOCK_DIR" 2>/dev/null || true
}

if [ ! -f "$SERVER_PID_FILE" ]; then
  echo "memory server: no server.pid found; nothing to stop."
  cleanup_files
  exit 0
fi

SERVER_PID="$(cat "$SERVER_PID_FILE" 2>/dev/null)"
if [ -z "$SERVER_PID" ] || ! [[ "$SERVER_PID" =~ ^[0-9]+$ ]]; then
  echo "memory server: server.pid is empty or malformed; clearing stale files."
  cleanup_files
  exit 0
fi

if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "memory server: pid $SERVER_PID is not running; clearing stale files."
  cleanup_files
  exit 0
fi

# Identity guard: only kill if the process command line actually looks like our
# memory server, so a recycled PID is never killed by mistake. Accept the real
# binary (markdown-vault-mcp) OR any process whose command line carries BOTH our
# recorded port and the /mcp http-path — the server's own launch signature (this
# also matches the test fixture, which exec's python with those same args).
PROC_CMD="$(ps -o command= -p "$SERVER_PID" 2>/dev/null)"
RECORDED_PORT="$(cat "$SERVER_PORT_FILE" 2>/dev/null)"
_looks_like_server=0
case "$PROC_CMD" in
  *markdown-vault-mcp*) _looks_like_server=1 ;;
esac
if [ "$_looks_like_server" -eq 0 ] && [ -n "$RECORDED_PORT" ]; then
  case "$PROC_CMD" in
    *"$RECORDED_PORT"*/mcp*|*/mcp*"$RECORDED_PORT"*) _looks_like_server=1 ;;
  esac
fi
if [ "$_looks_like_server" -eq 0 ]; then
  echo "memory server: pid $SERVER_PID does not look like the memory server; refusing to kill."
  echo "  (command: ${PROC_CMD:-unknown})"
  exit 0
fi

echo "memory server: stopping pid $SERVER_PID ..."
kill "$SERVER_PID" 2>/dev/null || true

# Wait up to ~5s for a graceful exit, then SIGKILL.
i=0
while [ "$i" -lt 25 ]; do
  kill -0 "$SERVER_PID" 2>/dev/null || break
  i=$((i + 1))
  sleep 0.2
done
if kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "memory server: still alive; sending SIGKILL."
  kill -9 "$SERVER_PID" 2>/dev/null || true
fi

cleanup_files
echo "memory server: stopped."
exit 0
