#!/usr/bin/env bash
#
# build-memory-wheel.sh — rebuild the bundled markdown-vault-mcp server wheel.
#
# The memory MCP launcher (hooks/mcp-memory.sh) installs the server from a wheel
# bundled under hooks/wheels/. That wheel travels with the plugin: shipping a
# new wheel is what makes a plugin update auto-upgrade the server.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WHEELS_DIR="$REPO_ROOT/hooks/wheels"
UPSTREAM_URL="https://github.com/pvliesdonk/markdown-vault-mcp.git"
DEFAULT_TAG="v5.1.0"

usage() {
  echo "Usage: scripts/build-memory-wheel.sh [TAG]" 1>&2
  echo "       scripts/build-memory-wheel.sh --from CHECKOUT_PATH" 1>&2
  echo "Builds the bundled markdown-vault-mcp wheel from $UPSTREAM_URL at TAG (default $DEFAULT_TAG)," 1>&2
  echo "or from a local checkout such as a fork. Needs uv, and git for a tag build." 1>&2
}

case "${1:-}" in -h|--help) usage; exit 0 ;; esac

if ! command -v uv >/dev/null 2>&1; then
  echo "ERROR: uv is not on PATH. Install it from https://docs.astral.sh/uv/." 1>&2
  exit 1
fi

if [ "${1:-}" = "--from" ]; then
  SOURCE="${2:-}"
  if [ ! -f "$SOURCE/pyproject.toml" ]; then
    echo "ERROR: no pyproject.toml under checkout path '$SOURCE'." 1>&2
    usage
    exit 1
  fi
  LABEL="$SOURCE"
else
  TAG="${1:-$DEFAULT_TAG}"
  if ! command -v git >/dev/null 2>&1; then
    echo "ERROR: git is not on PATH." 1>&2
    exit 1
  fi
  CLONE="$(mktemp -d)"
  trap 'rm -rf "$CLONE"' EXIT
  if ! git clone --quiet --depth 1 --branch "$TAG" "$UPSTREAM_URL" "$CLONE/src" 1>&2; then
    echo "ERROR: could not clone tag '$TAG' from $UPSTREAM_URL." 1>&2
    exit 1
  fi
  SOURCE="$CLONE/src"
  LABEL="$UPSTREAM_URL at $TAG"
fi

mkdir -p "$WHEELS_DIR"

# Drop any previously-bundled wheels so only the freshly built one remains.
# The launcher picks the newest by mtime, but keeping a single wheel avoids
# confusion and keeps the binary footprint minimal.
rm -f "$WHEELS_DIR"/markdown_vault_mcp-*.whl

echo "Building markdown-vault-mcp wheel from $LABEL into $WHEELS_DIR ..." 1>&2
uv build --wheel --project "$SOURCE" -o "$WHEELS_DIR"

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
