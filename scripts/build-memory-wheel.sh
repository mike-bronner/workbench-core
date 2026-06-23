#!/usr/bin/env bash
#
# build-memory-wheel.sh — rebuild the bundled markdown-vault-mcp server wheel.
#
# The memory MCP launcher (hooks/mcp-memory.sh) installs the server from a wheel
# bundled under hooks/wheels/. That wheel travels with the plugin: shipping a
# new wheel is what makes a plugin update auto-upgrade the server. This script
# rebuilds that wheel from a local fork of markdown-vault-mcp and drops it into
# hooks/wheels/, removing any older wheel so exactly one is bundled.
#
# Usage:
#   scripts/build-memory-wheel.sh [FORK_PATH]
#
#   FORK_PATH  Path to the markdown-vault-mcp fork checkout to build from.
#              Defaults to /Users/mike/Developer/forks/markdown-vault-mcp.
#
# Requires: uv (https://docs.astral.sh/uv/).
#
# Exit codes: 0 ok · 1 preflight failure (missing uv, bad fork path, no wheel).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WHEELS_DIR="$REPO_ROOT/hooks/wheels"

FORK_PATH="${1:-/Users/mike/Developer/forks/markdown-vault-mcp}"

if ! command -v uv >/dev/null 2>&1; then
  echo "ERROR: uv is not on PATH. Install it from https://docs.astral.sh/uv/." 1>&2
  exit 1
fi

if [ ! -f "$FORK_PATH/pyproject.toml" ]; then
  echo "ERROR: no pyproject.toml under fork path '$FORK_PATH'." 1>&2
  echo "Pass the markdown-vault-mcp fork checkout path as the first argument." 1>&2
  exit 1
fi

mkdir -p "$WHEELS_DIR"

# Drop any previously-bundled wheels so only the freshly built one remains.
# The launcher picks the newest by mtime, but keeping a single wheel avoids
# confusion and keeps the binary footprint minimal.
rm -f "$WHEELS_DIR"/markdown_vault_mcp-*.whl

echo "Building markdown-vault-mcp wheel from $FORK_PATH into $WHEELS_DIR ..." 1>&2
uv build --wheel --project "$FORK_PATH" -o "$WHEELS_DIR"

# `uv build` drops a `.gitignore` containing `*` into its output dir. Left in
# place that would gitignore the very wheel (and .gitkeep) we need to commit,
# silently un-tracking the bundle. Remove it so the wheel stays committable.
rm -f "$WHEELS_DIR/.gitignore"

BUILT="$(ls -t "$WHEELS_DIR"/markdown_vault_mcp-*.whl 2>/dev/null | head -n 1)"
if [ -z "$BUILT" ]; then
  echo "ERROR: build completed but no markdown_vault_mcp-*.whl landed in $WHEELS_DIR." 1>&2
  exit 1
fi

echo "Built: $BUILT" 1>&2
echo "SHA-256: $(shasum -a 256 "$BUILT" | cut -d' ' -f1)" 1>&2
echo "Done. Commit the new wheel to ship the server upgrade with the plugin." 1>&2
