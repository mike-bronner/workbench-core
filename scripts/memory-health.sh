#!/usr/bin/env bash
#
# memory-health.sh — print the memory server's health as one status word.
#
# The status line's `mem` entry (hooks/register.ts) runs this once shortly after
# session start and then every minute. It is the identity-checked probe from
# hooks/lib/memory-probe.sh and nothing else, so the word is the one
# scripts/memory-status.sh reports on its health line: UP, BUILDING, PORT_DRIFT,
# DOWN_FOREIGN, DOWN_FAILED or DOWN_NONE.
#
# Read-only. Always exits 0. A probe that cannot run prints DOWN_NONE, as
# memory-status.sh reads it.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/hooks}"
HOOKS_DIR="${HOOKS_DIR:-$(cd "$SCRIPT_DIR/../hooks" && pwd)}"

# shellcheck source=hooks/lib/memory-env.sh
. "$HOOKS_DIR/lib/memory-env.sh" 2>/dev/null || { echo DOWN_NONE; exit 0; }
memory_load_env
# shellcheck source=hooks/lib/memory-probe.sh
. "$HOOKS_DIR/lib/memory-probe.sh" 2>/dev/null || { echo DOWN_NONE; exit 0; }
STATUS="$(memory_probe 2>/dev/null)"
echo "${STATUS:-DOWN_NONE}"
exit 0
