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

# Isolate the interactive (unset) path: if the runner itself is an --agent
# dispatch, CLAUDE_CODE_AGENT leaks into every child warmup and the whole suite
# would trip the new skip guard. Unset it here so every invocation below tests
# the unset case unless it opts into an agent via run_warmup's second argument.
unset CLAUDE_CODE_AGENT

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
  local agent="${2:-}"
  printf '{"source":"%s"}' "$source" | (
    [ -n "$agent" ] && export CLAUDE_CODE_AGENT="$agent"
    HOME="$SANDBOX/home" \
    WORKBENCH_MEMORY_PATH="$SANDBOX/memory" \
    WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" \
    CLAUDE_PLUGIN_ROOT="$REPO_ROOT" \
    bash "$WARMUP" 2>/dev/null
  )
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

echo "startup — no phantom shared-server health notices (per-session stdio):"
# $OUT still holds the startup run above. The v0.12 shared-HTTP health probe
# printed "Memory server starting" (plus port-drift/conflict notices) on EVERY
# startup once the transport reverted to stdio, because nothing listens on the
# loopback port. That block was removed; assert its notices never appear.
assert_missing "no phantom 'server starting' notice" "$OUT" "Memory server starting"
assert_missing "no shared-server port-drift notice"  "$OUT" "Memory server port drift"
assert_missing "no shared-server conflict notice"    "$OUT" "Memory server port conflict"

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

echo "agent dispatch — CLAUDE_CODE_AGENT set skips the entire warmup:"
# Seed pending-summary markers so we can prove even the summary-dispatch
# housekeeping is skipped, not just identity injection.
mkdir -p "$SANDBOX/cache/pending-summaries"
printf '{"session_id":"agent-skip","log_path":"/nonexistent/agent-skip.log.md"}\n' \
  > "$SANDBOX/cache/pending-summaries/agent-skip.json"
OUT=$(run_warmup startup "workbench-dev-team:watson")
if [ -z "$OUT" ]; then
  PASS=$((PASS + 1)); echo "  ✅ produces no output at all"
else
  FAIL=$((FAIL + 1)); echo "  ❌ expected empty output, got: $OUT"
fi
assert_missing "no warmup header"                  "$OUT" "session warmup"
assert_missing "no guardrails"                     "$OUT" "Guardrails — absolute rules"
assert_missing "no memory-routing block"           "$OUT" "## Memory routing"
assert_missing "no soul-hot"                        "$OUT" "SOULHOT-CANARY"
assert_missing "no profile"                         "$OUT" "PROFILE-CANARY"
assert_missing "no pending-summary housekeeping"   "$OUT" "Pending session summaries"
OUT=$(run_warmup resume "some-plugin:some-agent")
assert_missing "skip is source-independent (resume)" "$OUT" "SOULHOT-CANARY"
if printf '{"source":"startup"}' | ( export CLAUDE_CODE_AGENT="workbench-dev-team:holmes"; \
    HOME="$SANDBOX/home" WORKBENCH_MEMORY_PATH="$SANDBOX/memory" \
    WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" \
    CLAUDE_PLUGIN_ROOT="$REPO_ROOT" bash "$WARMUP" >/dev/null 2>&1 ); then
  PASS=$((PASS + 1)); echo "  ✅ still exits 0 (never breaks the session)"
else
  FAIL=$((FAIL + 1)); echo "  ❌ agent-skip exited non-zero"
fi
rm -f "$SANDBOX/cache/pending-summaries/agent-skip.json"

echo "agent dispatch — no persistent-file side effects on ~/.claude:"
AGENT_HOME="$SANDBOX/agent-home"
mkdir -p "$AGENT_HOME"
printf '{"source":"startup"}' | ( export CLAUDE_CODE_AGENT="workbench-dev-team:watson"; \
  HOME="$AGENT_HOME" WORKBENCH_MEMORY_PATH="$SANDBOX/memory" \
  WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" \
  CLAUDE_PLUGIN_ROOT="$REPO_ROOT" bash "$WARMUP" >/dev/null 2>&1 )
if [ ! -f "$AGENT_HOME/.claude/CLAUDE.md" ]; then
  PASS=$((PASS + 1)); echo "  ✅ does not write ~/.claude/CLAUDE.md"
else
  FAIL=$((FAIL + 1)); echo "  ❌ wrote ~/.claude/CLAUDE.md"
fi
if [ ! -f "$AGENT_HOME/.claude/system-overrides.md" ]; then
  PASS=$((PASS + 1)); echo "  ✅ does not write ~/.claude/system-overrides.md"
else
  FAIL=$((FAIL + 1)); echo "  ❌ wrote ~/.claude/system-overrides.md"
fi

echo "interactive (unset) — persistent-file enforcement still runs:"
UNSET_HOME="$SANDBOX/unset-home"
mkdir -p "$UNSET_HOME"
printf '{"source":"startup"}' | \
  HOME="$UNSET_HOME" WORKBENCH_MEMORY_PATH="$SANDBOX/memory" \
  WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" \
  CLAUDE_PLUGIN_ROOT="$REPO_ROOT" bash "$WARMUP" >/dev/null 2>&1
if [ -f "$UNSET_HOME/.claude/CLAUDE.md" ]; then
  PASS=$((PASS + 1)); echo "  ✅ writes ~/.claude/CLAUDE.md as before"
else
  FAIL=$((FAIL + 1)); echo "  ❌ did not write ~/.claude/CLAUDE.md when unset"
fi
if [ -f "$UNSET_HOME/.claude/system-overrides.md" ]; then
  PASS=$((PASS + 1)); echo "  ✅ writes ~/.claude/system-overrides.md as before"
else
  FAIL=$((FAIL + 1)); echo "  ❌ did not write ~/.claude/system-overrides.md when unset"
fi

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
  WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" \
  CLAUDE_PLUGIN_ROOT="$REPO_ROOT" bash "$WARMUP" 2>/dev/null)
assert_contains "warns about stray summaries"          "$OUT" "Stray session summaries in this project"
assert_contains "lists the stray file"                 "$OUT" "xyz.summary.md"

echo "stray-summary detector — clean project stays quiet:"
CLEAN_PROJ="$SANDBOX/clean"
mkdir -p "$CLEAN_PROJ"
OUT=$(cd "$CLEAN_PROJ" && printf '{"source":"startup"}' | \
  HOME="$SANDBOX/home" WORKBENCH_MEMORY_PATH="$SANDBOX/memory" \
  WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" \
  CLAUDE_PLUGIN_ROOT="$REPO_ROOT" bash "$WARMUP" 2>/dev/null)
assert_missing "no stray warning when project is clean" "$OUT" "Stray session summaries"

echo "retention sweep — pending marker protects an old log:"
mkdir -p "$SANDBOX/memory/sessions/2026-01-01" "$SANDBOX/cache/pending-summaries"
PROTECTED_LOG="$SANDBOX/memory/sessions/2026-01-01/aaaa1111-protected.log.md"
DOOMED_LOG="$SANDBOX/memory/sessions/2026-01-01/bbbb2222-doomed.log.md"
printf 'protected raw log\n' > "$PROTECTED_LOG"
printf 'doomed raw log\n' > "$DOOMED_LOG"
touch -t 202601010000 "$PROTECTED_LOG" "$DOOMED_LOG"
printf '{"session_id":"aaaa1111-protected","log_path":"%s"}\n' "$PROTECTED_LOG" \
  > "$SANDBOX/cache/pending-summaries/aaaa1111-protected.json"
OUT=$(run_warmup startup)
if [ -f "$PROTECTED_LOG" ]; then
  PASS=$((PASS + 1)); echo "  ✅ marker-protected log survives the sweep"
else
  FAIL=$((FAIL + 1)); echo "  ❌ marker-protected log was deleted"
fi
if [ ! -f "$DOOMED_LOG" ]; then
  PASS=$((PASS + 1)); echo "  ✅ markerless old log is deleted"
else
  FAIL=$((FAIL + 1)); echo "  ❌ markerless old log survived"
fi

echo "pending-summary notice — uses the workbench-core namespace:"
assert_contains "drain command namespaced correctly" "$OUT" "/workbench-core:process-pending-summaries"
assert_missing  "no stale pre-rename namespace"      "$OUT" "\`/workbench:process-pending-summaries\`"
rm -f "$SANDBOX/cache/pending-summaries/aaaa1111-protected.json" "$PROTECTED_LOG"

echo "pending listing — capped at count + 3 oldest:"
mkdir -p "$SANDBOX/cache/pending-summaries"
for i in 1 2 3 4 5; do
  printf '{"session_id":"sid-%s","log_path":"/nonexistent/sid-%s.log.md"}\n' "$i" "$i" \
    > "$SANDBOX/cache/pending-summaries/sid-$i.json"
  touch -t "2026010${i}0000" "$SANDBOX/cache/pending-summaries/sid-$i.json"
done
OUT=$(run_warmup startup)
assert_contains "count reflects all markers"   "$OUT" "Pending session summaries (5)"
assert_contains "oldest marker listed"         "$OUT" "sid-1"
assert_missing  "newest marker not enumerated" "$OUT" "sid-5"
assert_missing  "log paths not enumerated"     "$OUT" "/nonexistent/sid-1.log.md"

echo "PostCompact payload routes to the compact branch:"
OUT=$(printf '{"hook_event_name":"PostCompact","trigger":"auto"}' | \
  HOME="$SANDBOX/home" WORKBENCH_MEMORY_PATH="$SANDBOX/memory" \
  WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" \
  CLAUDE_PLUGIN_ROOT="$REPO_ROOT" bash "$WARMUP" 2>/dev/null)
assert_missing  "profile not inlined on PostCompact"  "$OUT" "PROFILE-CANARY"
assert_contains "profile pointer present"             "$OUT" "User profile: re-read"
assert_missing  "no pending block on PostCompact"     "$OUT" "Pending session summaries"
rm -f "$SANDBOX/cache/pending-summaries"/sid-*.json

echo "exit code is always 0:"
if printf '{"source":"compact"}' | HOME="$SANDBOX/home" WORKBENCH_MEMORY_PATH="$SANDBOX/memory" WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" CLAUDE_PLUGIN_ROOT="$REPO_ROOT" bash "$WARMUP" >/dev/null 2>&1; then
  PASS=$((PASS + 1)); echo "  ✅ compact exits 0"
else
  FAIL=$((FAIL + 1)); echo "  ❌ compact exited non-zero"
fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
