#!/usr/bin/env bash
set -u

dir=${1:-}
[ -n "$dir" ] || exit 0
common=$(git -C "$dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
common=${common%/}
[ "${common##*/}" = .git ] || exit 0
[ -f "$common/index" ] || exit 0
repaired=
for file in "$common/config" "$common/config.worktree"; do
  [ -f "$file" ] || continue
  [ "$(git config --file "$file" --type=bool --get core.bare 2>/dev/null)" = true ] || continue
  git config --file "$file" core.bare false || exit 1
  repaired=1
done
[ -n "$repaired" ] && printf '%s\n' "${common%/.git}"
exit 0
