#!/bin/bash
# Tests for session-warmup.sh identity injection. Run directly: ./test-session-warmup.sh
# Each case invokes the hook with a synthetic SessionStart payload inside a
# sandbox (fake HOME + memory path) and asserts which identity pieces are
# injected for that source: full files, one-line pointers, or nothing.

set -u
WARMUP="$(cd "$(dirname "$0")" && pwd)/session-warmup.sh"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0

SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

# Sandbox layout: fake HOME so the script's persistent-file management never
# touches the real ~/.claude; fixture identity files carry canary strings.
mkdir -p "$SANDBOX/home" "$SANDBOX/memory/identity" "$SANDBOX/cache"
printf 'SOULHOT-CANARY soul rules\n' > "$SANDBOX/memory/identity/soul-hot.md"
printf 'PROFILE-CANARY user facts\n' > "$SANDBOX/memory/identity/profile.md"
printf 'SKILLSPROTO-CANARY skill learnings\n' > "$SANDBOX/memory/identity/skills-protocol.md"

run_warmup() {
  local source="$1"
  printf '{"source":"%s"}' "$source" | \
    HOME="$SANDBOX/home" \
    WORKBENCH_MEMORY_PATH="$SANDBOX/memory" \
    WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" \
    WORKBENCH_AGENT_NAME="TestAgent" \
    CLAUDE_PLUGIN_ROOT="$REPO_ROOT" \
    bash "$WARMUP" 2>/dev/null
}

assert_contains() {
  local desc="$1" output="$2" needle="$3"
  if printf '%s' "$output" | grep -qF "$needle"; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected to find: $needle"
  fi
}

assert_missing() {
  local desc="$1" output="$2" needle="$3"
  if printf '%s' "$output" | grep -qF "$needle"; then
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — should NOT contain: $needle"
  else
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  fi
}

echo "startup — fresh context gets full identity:"
OUT=$(run_warmup startup)
assert_contains "soul-hot injected in full"        "$OUT" "SOULHOT-CANARY"
assert_contains "profile injected in full"         "$OUT" "PROFILE-CANARY"
assert_contains "guardrails injected"              "$OUT" "Guardrails — absolute rules"
assert_contains "guardrails exempt memory vault"   "$OUT" "personal memory vault is exempt"
assert_missing  "skills-protocol not inlined"      "$OUT" "SKILLSPROTO-CANARY"
assert_contains "skills-protocol pointer present"  "$OUT" "Skills protocol: read \`$SANDBOX/memory/identity/skills-protocol.md\`"

echo "clear — wiped context gets full identity:"
OUT=$(run_warmup clear)
assert_contains "soul-hot injected in full"        "$OUT" "SOULHOT-CANARY"
assert_contains "profile injected in full"         "$OUT" "PROFILE-CANARY"

echo "compact — recurring refresh gets pointers:"
OUT=$(run_warmup compact)
assert_contains "soul-hot still injected in full"  "$OUT" "SOULHOT-CANARY"
assert_missing  "profile not inlined"              "$OUT" "PROFILE-CANARY"
assert_contains "profile pointer present"          "$OUT" "User profile: re-read \`$SANDBOX/memory/identity/profile.md\`"
assert_missing  "skills-protocol not inlined"      "$OUT" "SKILLSPROTO-CANARY"
assert_contains "guardrails still injected"        "$OUT" "Guardrails — absolute rules"

echo "resume — same trim as compact:"
OUT=$(run_warmup resume)
assert_missing  "profile not inlined"              "$OUT" "PROFILE-CANARY"
assert_contains "profile pointer present"          "$OUT" "User profile: re-read"
assert_contains "soul-hot injected in full"        "$OUT" "SOULHOT-CANARY"

echo "missing files degrade gracefully:"
rm "$SANDBOX/memory/identity/profile.md" "$SANDBOX/memory/identity/skills-protocol.md"
OUT=$(run_warmup compact)
assert_missing  "no profile pointer when file absent"  "$OUT" "User profile: re-read"
assert_missing  "no skills pointer when file absent"   "$OUT" "Skills protocol: read"
OUT=$(run_warmup startup)
assert_contains "startup notes missing profile"        "$OUT" "profile.md not found"
printf 'PROFILE-CANARY user facts\n' > "$SANDBOX/memory/identity/profile.md"
printf 'SKILLSPROTO-CANARY skill learnings\n' > "$SANDBOX/memory/identity/skills-protocol.md"

echo "stray-summary detector — startup flags project-dir summaries:"
STRAY_PROJ="$SANDBOX/proj"
mkdir -p "$STRAY_PROJ/memory/sessions/2026-07-01"
printf 'stray\n' > "$STRAY_PROJ/memory/sessions/2026-07-01/xyz.summary.md"
OUT=$(cd "$STRAY_PROJ" && printf '{"source":"startup"}' | \
  HOME="$SANDBOX/home" WORKBENCH_MEMORY_PATH="$SANDBOX/memory" \
  WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" WORKBENCH_AGENT_NAME="TestAgent" \
  CLAUDE_PLUGIN_ROOT="$REPO_ROOT" bash "$WARMUP" 2>/dev/null)
assert_contains "warns about stray summaries"          "$OUT" "Stray session summaries in this project"
assert_contains "lists the stray file"                 "$OUT" "xyz.summary.md"

echo "stray-summary detector — clean project stays quiet:"
CLEAN_PROJ="$SANDBOX/clean"
mkdir -p "$CLEAN_PROJ"
OUT=$(cd "$CLEAN_PROJ" && printf '{"source":"startup"}' | \
  HOME="$SANDBOX/home" WORKBENCH_MEMORY_PATH="$SANDBOX/memory" \
  WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" WORKBENCH_AGENT_NAME="TestAgent" \
  CLAUDE_PLUGIN_ROOT="$REPO_ROOT" bash "$WARMUP" 2>/dev/null)
assert_missing "no stray warning when project is clean" "$OUT" "Stray session summaries"

echo "exit code is always 0:"
if printf '{"source":"compact"}' | HOME="$SANDBOX/home" WORKBENCH_MEMORY_PATH="$SANDBOX/memory" WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" CLAUDE_PLUGIN_ROOT="$REPO_ROOT" bash "$WARMUP" >/dev/null 2>&1; then
  PASS=$((PASS + 1)); echo "  ✅ compact exits 0"
else
  FAIL=$((FAIL + 1)); echo "  ❌ compact exited non-zero"
fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
