#!/bin/bash

set -u
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HOOKS_DIR/.." && pwd)"
SKILLS="$ROOT/skills"
README="$ROOT/README.md"
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); echo "  ✅ $1"; }
no() { FAIL=$((FAIL + 1)); echo "  ❌ $1: $2"; }

frontmatter() { awk '/^---$/{c++; next} c==1' "$SKILLS/$1/SKILL.md"; }
restricted() { frontmatter "$1" | grep -qx 'disable-model-invocation: true'; }
description() { frontmatter "$1" | sed -n 's/^description: //p'; }
thousands() { if [ "$1" -ge 1000 ]; then printf "%d,%03d" $(($1 / 1000)) $(($1 % 1000)); else printf "%d" "$1"; fi; }

echo "scheduled skills stay in the listing:"
for s in memory-lint evaluate-decisions propose-upgrades; do
  if restricted "$s"; then no "$s is model-invocable" "carries disable-model-invocation"; else ok "$s is model-invocable"; fi
done
if grep -q '"prompt": "/workbench-core:memory-lint"' "$SKILLS/setup/SKILL.md"; then
  ok "setup schedules memory-lint"
else
  no "setup schedules memory-lint" "no memory-lint task prompt in setup"
fi
if frontmatter memory-lint | grep -qx 'context: fork'; then ok "memory-lint still forks"; else no "memory-lint still forks" "no context: fork"; fi

echo
echo "interactive skills stay user-only:"
for s in setup log-now compact-learnings install-chat-skills; do
  if restricted "$s"; then ok "$s carries disable-model-invocation"; else no "$s carries disable-model-invocation" "flag missing"; fi
done

echo
echo "the README's listing figures match the skill files:"
COUNT=0
BYTES=0
for f in "$SKILLS"/*/SKILL.md; do
  s="$(basename "$(dirname "$f")")"
  restricted "$s" && continue
  COUNT=$((COUNT + 1))
  BYTES=$((BYTES + $(description "$s" | tr -d '\n' | wc -c)))
done
WORDS=(zero one two three four five six seven eight nine ten)
CLAIM="the ${WORDS[$COUNT]} listed descriptions total $(thousands "$BYTES") bytes"
if grep -qF -- "$CLAIM" "$README"; then ok "README states: $CLAIM"; else no "README states the listing total" "expected: $CLAIM"; fi
if grep -qF 'still runs them, the monthly' "$README"; then
  no "README drops the scheduled slash-command claim" "claim still present"
else
  ok "README drops the scheduled slash-command claim"
fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
