#!/usr/bin/env bash
#
# scope-facts: the file system facts the destructive-scope guard reads.
#
# hooks/register.ts runs this file to answer the guard's questions
# (hooks/mods/destructive-scope.ts). The guard itself is pure, so whatever
# touches the disk is here:
#
#   scope-facts.sh roots <session-id>
#       The scratch roots, one `root<TAB>path` line each, every one physical
#       and none of them taken from anything the caller can set:
#         - this session's scratchpad, matched by session id under
#           /private/tmp/claude-*/ and /tmp/claude-*/, and dropped when any
#           level of it is a symbolic link;
#         - the login home's Developer/scratchpad, the home read from the
#           password database through `~user`, never from $HOME;
#         - this account's per-user temporary folder on Darwin, where
#           `mktemp -d` lands, from getconf rather than $TMPDIR.
#       Then `tmp<TAB>path`, where /tmp lands, and `markers<TAB>path`, the
#       memory cache's pending-summaries folder, when it and the cache above it
#       are real folders this account owns. The project root is the session's,
#       read by the module itself.
#
#   scope-facts.sh dir <path>
#       The folder's physical path from `cd -P` and `pwd -P`: every link
#       followed, and `..` and `//` folded. Each name keeps the case it was
#       given, not the case it has on disk (use `name` for that). Nothing when
#       the path is no folder.
#
#   scope-facts.sh entry <path>
#       The entry itself, its links not followed: `missing`, or `link`, `dir`,
#       `file` or `other`, a colon, and 1 when this account owns it.
#
#   scope-facts.sh name <folder> <name>
#       The name an entry of the folder carries on disk: the name as given
#       when an entry has it exactly, else the one entry whose name matches it
#       without regard to case, else nothing. On APFS `/tmp/Claude-503` and
#       `/tmp/claude-503` are one entry, and this gives the spelling it has.
#
# Read-only. Always exits 0.

set -u

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

physical_dir() {
  [ -d "$1" ] && (cd -P -- "$1" 2>/dev/null && pwd -P)
}

roots() {
  local sid="${1:-}" candidate real user home temp cache pending
  case "$sid" in
    '' | *[!A-Za-z0-9._-]*) ;;
    *)
      for candidate in /private/tmp/claude-*/*/"$sid"/scratchpad \
                       /tmp/claude-*/*/"$sid"/scratchpad; do
        real=$(physical_dir "$candidate") || continue
        [ "$real" = "$candidate" ] && printf 'root\t%s\n' "$real"
      done
      ;;
  esac
  user=$(id -un 2>/dev/null)
  case "$user" in
    '' | -* | *[!A-Za-z0-9._-]*) ;;
    *)
      eval "home=~$user"
      case "$home" in
        /*) real=$(physical_dir "$home/Developer/scratchpad") && printf 'root\t%s\n' "$real" ;;
      esac
      ;;
  esac
  temp=$(/usr/bin/getconf DARWIN_USER_TEMP_DIR 2>/dev/null)
  case "$temp" in
    /*) real=$(physical_dir "$temp") && [ "$real" != / ] && printf 'root\t%s\n' "$real" ;;
  esac
  real=$(physical_dir /tmp) && printf 'tmp\t%s\n' "$real"
  # The folder the marker writer uses, resolved the way it resolves it.
  if [ -f "$HOOKS_DIR/lib/memory-env.sh" ]; then
    # shellcheck source=hooks/lib/memory-env.sh
    . "$HOOKS_DIR/lib/memory-env.sh" 2>/dev/null || return 0
    cache=$(memory_resolve_cache_path 2>/dev/null) || return 0
    pending="$cache/pending-summaries"
    case "$pending" in /*) ;; *) return 0 ;; esac
    for candidate in "$cache" "$pending"; do
      [ -d "$candidate" ] && [ ! -L "$candidate" ] && [ -O "$candidate" ] || return 0
    done
    real=$(physical_dir "$pending") && [ "$real" != / ] && printf 'markers\t%s\n' "$real"
  fi
  return 0
}

entry() {
  local kind owned=0
  if [ -L "$1" ]; then kind="link"
  elif [ -d "$1" ]; then kind=dir
  elif [ -f "$1" ]; then kind="file"
  elif [ -e "$1" ]; then kind=other
  else
    printf 'missing\n'
    return 0
  fi
  [ "$kind" != link ] && [ -O "$1" ] && owned=1
  printf '%s:%s\n' "$kind" "$owned"
}

name() {
  local listing
  listing=$(ls -1A -- "$1" 2>/dev/null) || return 0
  printf '%s\n' "$listing" | awk -v want="$2" '
    $0 == want { exact = 1 }
    tolower($0) == tolower(want) { folded[++n] = $0 }
    END { if (exact) print want; else if (n == 1) print folded[1] }'
}

case "${1:-}" in
  roots) roots "${2:-}" ;;
  dir) physical_dir "${2:-}" ;;
  entry) entry "${2:-}" ;;
  name) name "${2:-}" "${3:-}" ;;
esac
exit 0
