#!/usr/bin/env bash
#
# vault-resolve.sh [target ...] — print the memory vault's root, and the
# root-absolute path of each [[link]] target that names exactly one note.
#
# hooks/register.ts runs this on a memory MCP write, edit or append that needs
# it: one with an absolute path to make relative, a new note made by append,
# or [[links]] to rewrite to path links (hooks/mods/vault-write.ts). Output,
# tab-separated, one fact a line:
#
#   root	<absolute vault root>
#   link	<target as given>	</folder/stem.md>
#
# A target resolves when it is a vault-relative path to a note
# (`decisions/2026-06-11-x`, with or without `.md` and a leading slash), or a
# bare stem exactly one note in the vault carries as its file name. A stem two
# notes share, a target holding `..`, a glob character or a backslash, and one
# that matches nothing print no line, so the hook leaves that link as written.
# Hidden folders (.git, .obsidian) are never searched.
#
# The vault root comes from hooks/lib/memory-env.sh, the one resolver. A root
# that is not an absolute directory prints nothing at all. Read-only. Always
# exits 0.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/hooks}"
HOOKS_DIR="${HOOKS_DIR:-$(cd "$SCRIPT_DIR/../hooks" && pwd)}"

# shellcheck source=hooks/lib/memory-env.sh
. "$HOOKS_DIR/lib/memory-env.sh" 2>/dev/null || exit 0
ROOT="$(memory_resolve_memory_path)"
ROOT="${ROOT%/}"
case "$ROOT" in /?*) ;; *) exit 0 ;; esac
[ -d "$ROOT" ] || exit 0
printf 'root\t%s\n' "$ROOT"

[ $# -gt 0 ] || exit 0

NOTES=''
for target in "$@"; do
  t="${target#/}"
  t="${t%.md}"
  case "$t" in
    '' | *..* | *[*?\[\]\\]* | -*) continue ;;
  esac
  case "$t" in
    */*)
      [ -f "$ROOT/$t.md" ] && printf 'link\t%s\t/%s.md\n' "$target" "$t"
      ;;
    *)
      # Listed once, on the first bare stem, and only under the vault root.
      if [ -z "$NOTES" ]; then
        NOTES="$(find "$ROOT" -name '.*' -prune -o -type f -name '*.md' -print 2>/dev/null)"
        [ -n "$NOTES" ] || NOTES=$'\n'
      fi
      match="$(printf '%s\n' "$NOTES" | awk -v stem="$t.md" -F/ '$NF == stem' )"
      if [ -n "$match" ] && [ "$(printf '%s\n' "$match" | wc -l | tr -d ' ')" = 1 ]; then
        printf 'link\t%s\t%s\n' "$target" "${match#"$ROOT"}"
      fi
      ;;
  esac
done
exit 0
