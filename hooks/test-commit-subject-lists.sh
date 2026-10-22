#!/bin/bash
set -u
HOOKS="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HOOKS/.." && pwd)"
SUBJECT="$ROOT/hooks/mods/commit-subject.ts"

holds_refs() { [ -r "$1/skills/git-commit/references/gitmoji.md" ] && [ -r "$1/skills/git-commit/references/conventional-commits.md" ]; }

DEV_TEAM=""
if [ -n "${WORKBENCH_DEV_TEAM_DIR:-}" ]; then
  holds_refs "$WORKBENCH_DEV_TEAM_DIR" && DEV_TEAM="$WORKBENCH_DEV_TEAM_DIR"
elif holds_refs "$(dirname "$ROOT")/workbench-dev-team"; then
  DEV_TEAM="$(dirname "$ROOT")/workbench-dev-team"
else
  while IFS= read -r CANDIDATE; do
    if holds_refs "$CANDIDATE"; then
      DEV_TEAM="$CANDIDATE"
      break
    fi
  done < <(printf '%s\n' "$HOME"/.claude/plugins/cache/*/workbench-dev-team/[0-9]* | sort -V -r)
fi

if [ -z "$DEV_TEAM" ]; then
  echo "  ❌ no workbench-dev-team git-commit references found. Set WORKBENCH_DEV_TEAM_DIR to a workbench-dev-team checkout."
  exit 1
fi
echo "workbench-dev-team: $DEV_TEAM"

exec python3 -I - "$SUBJECT" "$DEV_TEAM/skills/git-commit/references" <<'PY'
import re
import sys

subject_path, refs = sys.argv[1], sys.argv[2]
source = open(subject_path, encoding="utf-8").read()


def listed(name):
    match = re.search(r"export const " + name + r": readonly string\[\] = \[(.*?)\]", source, re.S)
    return re.findall(r"'([^']*)'", match.group(1)) if match else []


def cells(file):
    rows = [line for line in open(f"{refs}/{file}", encoding="utf-8").read().split("\n") if line.startswith("| ")]
    found = [row.split("|")[1].strip() for row in rows]
    return [cell for cell in found if cell and not re.fullmatch(r"-+", cell) and cell not in ("Emoji", "Type")]


emoji = cells("gitmoji.md")
types = [cell[1:-1] for cell in cells("conventional-commits.md") if re.fullmatch(r"`[a-z]+`", cell)]
failed = 0
for label, shipped, reference in (("gitmoji", listed("GITMOJI"), emoji), ("type", listed("TYPES"), types)):
    missing = [x for x in reference if x not in shipped]
    extra = [x for x in shipped if x not in reference]
    if not reference or not shipped:
        failed += 1
        print(f"  ❌ no {label} list was read: the extraction stopped matching")
        continue
    for x in missing:
        failed += 1
        print(f"  ❌ {label} {x} is in the git-commit reference and not in commit-subject.ts")
    for x in extra:
        failed += 1
        print(f"  ❌ {label} {x} is in commit-subject.ts and not in the git-commit reference")
    if not missing and not extra:
        print(f"  ✅ the {len(reference)} {label}s match the git-commit reference")
sys.exit(1 if failed else 0)
PY
