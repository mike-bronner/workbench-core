#!/usr/bin/env bash
#
# scratch-roots: the scratch roots a session may write to, resolved physically.
#
# One copy, two callers:
#
#   hooks/delegation-gate.sh   sources this file and calls scratch_roots, so a
#                              write under a root draws no reminder
#   hooks/register.ts          runs this file as `bash scratch-roots.sh <sid>`
#                              to answer $.workbench.scratchRoots()
#
# The roots, none of them taken from anything the caller can set:
#   - this session's scratchpad, matched by session id under
#     /private/tmp/claude-*/ and /tmp/claude-*/, and refused when any level of
#     it is a symlink, because anyone can build a directory of that shape and
#     point it somewhere else;
#   - the login home's Developer/scratchpad and .claude/plans, where the home
#     comes from the password database through `~user` expansion, never from
#     $HOME. When plans/ does not exist yet, its root is the resolved .claude
#     folder plus /plans, so plan mode's first write, which creates the folder,
#     is still inside a root.
#
# Sourcing defines physical_dir and scratch_roots and does nothing else. Run
# directly, it prints one root per line for the session id given, and prints
# nothing for an id outside [A-Za-z0-9._-]. It always exits 0.

# The physical path of an existing directory, or failure.
physical_dir() {
  [ -d "$1" ] && (cd -P -- "$1" 2>/dev/null && pwd -P)
}

# scratch_roots <session_id> — one physical root per line.
scratch_roots() {
  local sid="${1:-}" candidate real user home plans claude_dir
  case "$sid" in
    '' | *[!A-Za-z0-9._-]*) ;;
    *)
      for candidate in /private/tmp/claude-*/*/"$sid"/scratchpad \
                       /tmp/claude-*/*/"$sid"/scratchpad; do
        real=$(physical_dir "$candidate") || continue
        [ "$real" = "$candidate" ] && printf '%s\n' "$real"
      done
      ;;
  esac
  user=$(id -un 2>/dev/null)
  case "$user" in
    '' | -* | *[!A-Za-z0-9._-]*) return 0 ;;
  esac
  eval "home=~$user"
  case "$home" in
    /*) physical_dir "$home/Developer/scratchpad"
        # Plan mode's first write can come before plans/ exists. The root is
        # then built from .claude, which does exist, giving the same prefix a
        # target under the missing folder resolves to.
        if plans=$(physical_dir "$home/.claude/plans"); then
          printf '%s\n' "$plans"
        elif claude_dir=$(physical_dir "$home/.claude"); then
          printf '%s/plans\n' "${claude_dir%/}"
        fi ;;
  esac
  return 0
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  scratch_roots "${1:-}"
  exit 0
fi
