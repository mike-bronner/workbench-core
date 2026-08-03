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
  if printf '%s' "$output" | grep -qF -- "$needle"; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected to find: $needle"
  fi
}

assert_missing() {
  local desc="$1" output="$2" needle="$3"
  if printf '%s' "$output" | grep -qF -- "$needle"; then
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — should NOT contain: $needle"
  else
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  fi
}

# Contiguous multi-line containment. `grep -F` with a multi-line pattern matches
# if ANY single line matches, which would pass on a file that merely mentions one
# rule; a case-glob compares the whole block as one uninterrupted substring, which
# is exactly the "fully inlined, in order, unedited" property under test.
assert_block() {
  local desc="$1" haystack="$2" needle="$3"
  case "$haystack" in
    *"$needle"*) PASS=$((PASS + 1)); echo "  ✅ $desc" ;;
    *) FAIL=$((FAIL + 1)); echo "  ❌ $desc — block not found verbatim" ;;
  esac
}

# Volatile notices are no longer injected into the warmup payload — they are
# written to this file and surfaced by a byte-stable pointer. Tests that used
# to grep stdout for a notice now read here instead.
NOTICES_FILE="$SANDBOX/home/.claude-workbench/warmup-notices.md"
notices() { cat "$NOTICES_FILE" 2>/dev/null; }

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

echo "behavioral overrides — one shipped source, fully inlined into BOTH layers:"
# Layer 1 (~/.claude/system-overrides.md, system-prompt tier) and layer 2 (the
# managed CLAUDE.md block, user-message tier) are separate authority tiers that
# must each carry the rules verbatim — a pointer in either destination would
# break its tier. What they share is the SOURCE the hook renders from.
OVERRIDES_SRC="$REPO_ROOT/references/behavioral-overrides.md"
OV_HOME="$SANDBOX/overrides-home"
OV_CONFIG_DIR="$OV_HOME/.claude/plugins/data/workbench-core-claude-workbench"
mkdir -p "$OV_CONFIG_DIR"
printf '{"agent_name":"OverrideCanary"}\n' > "$OV_CONFIG_DIR/config.json"
printf '{"source":"startup"}' | \
  HOME="$OV_HOME" WORKBENCH_MEMORY_PATH="$SANDBOX/memory" \
  WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" \
  CLAUDE_PLUGIN_ROOT="$REPO_ROOT" bash "$WARMUP" >/dev/null 2>&1
OV_SYSTEM="$(cat "$OV_HOME/.claude/system-overrides.md" 2>/dev/null)"
OV_CLAUDE="$(cat "$OV_HOME/.claude/CLAUDE.md" 2>/dev/null)"

# The shipped source is the union of what the two heredocs used to carry
# separately: layer 2's numbered structure PLUS layer 1's anti-examples. Pin the
# anti-examples on the source itself — if they are stripped there, both layers
# "converge" on weaker content and the verbatim checks below would still pass.
OV_SRC_TEXT="$(cat "$OVERRIDES_SRC" 2>/dev/null)"
assert_contains "source keeps the emoji-override anti-example"   "$OV_SRC_TEXT" 'no emojis unless asked.'
assert_contains "source keeps the sycophancy anti-examples"      "$OV_SRC_TEXT" 'No "Great question!"'
assert_contains "source keeps the hedging anti-example"          "$OV_SRC_TEXT" '"that said"'
assert_contains "source keeps the corporate-speak ban list"      "$OV_SRC_TEXT" 'circle back'
assert_contains "source keeps the no-preambles rule"             "$OV_SRC_TEXT" 'No preambles.'
assert_contains "source parameterizes the agent name"            "$OV_SRC_TEXT" 'AGENT_NAME_PLACEHOLDER'

# Both destinations must contain the rendered block VERBATIM and CONTIGUOUS —
# this is the convergence guarantee. Drift either heredoc away from the source
# (or leave one layer on its old, thinner wording) and this goes red.
EXPECTED_OVERRIDES="${OV_SRC_TEXT//AGENT_NAME_PLACEHOLDER/OverrideCanary}"
assert_block "layer 1 inlines the shipped block verbatim" "$OV_SYSTEM" "$EXPECTED_OVERRIDES"
assert_block "layer 2 inlines the shipped block verbatim" "$OV_CLAUDE" "$EXPECTED_OVERRIDES"

# Inlined, not pointed at: neither destination may defer to the plugin path,
# which is version-pinned and read long after this hook exits.
assert_missing "layer 1 carries no pointer to the source" "$OV_SYSTEM" "references/behavioral-overrides.md"
assert_missing "layer 2 carries no pointer to the source" "$OV_CLAUDE" "references/behavioral-overrides.md"
assert_missing "layer 1 leaves no unsubstituted token"    "$OV_SYSTEM" "PLACEHOLDER"
assert_missing "layer 2 leaves no unsubstituted token"    "$OV_CLAUDE" "PLACEHOLDER"
assert_contains "layer 1 substitutes the agent name"      "$OV_SYSTEM" "OverrideCanary"
assert_contains "layer 2 substitutes the agent name"      "$OV_CLAUDE" "OverrideCanary"

# Per-destination chrome survives the convergence — each tier keeps its own
# wrapper around the shared body.
assert_contains "layer 1 keeps its load-instruction banner" "$OV_SYSTEM" "--append-system-prompt-file"
assert_contains "layer 2 keeps its start marker"            "$OV_CLAUDE" "<!-- workbench-identity:start -->"
assert_contains "layer 2 keeps its end marker"              "$OV_CLAUDE" "<!-- workbench-identity:end -->"
assert_contains "layer 2 keeps the identity-files section"  "$OV_CLAUDE" "## Identity files (loaded by SessionStart hook)"
assert_contains "layer 2 keeps the authority sentence"      "$OV_CLAUDE" "the identity files win."

echo "behavioral overrides — an unreadable source fails CLOSED, never blanks a layer:"
# A missing shipped source must leave both destinations exactly as they were.
# Stale-but-good content beats a truncated or emptied identity block.
FC_HOME="$SANDBOX/failclosed-home"
FC_ROOT="$SANDBOX/failclosed-root"
mkdir -p "$FC_HOME/.claude" "$FC_ROOT/references"
# A plugin root that is otherwise intact — the hook still sources its libs from
# here — but ships no behavioral-overrides.md. Isolating the one missing file is
# the point: a wholesale-bogus root would die in the library source instead.
ln -sfn "$REPO_ROOT/hooks" "$FC_ROOT/hooks"
printf 'SENTINEL-SYSTEM previously rendered overrides\n'  > "$FC_HOME/.claude/system-overrides.md"
printf 'SENTINEL-CLAUDE previously rendered identity\n'   > "$FC_HOME/.claude/CLAUDE.md"
cp "$FC_HOME/.claude/system-overrides.md" "$SANDBOX/fc-system.before"
cp "$FC_HOME/.claude/CLAUDE.md" "$SANDBOX/fc-claude.before"
if printf '{"source":"startup"}' | \
  HOME="$FC_HOME" WORKBENCH_MEMORY_PATH="$SANDBOX/memory" \
  WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" \
  CLAUDE_PLUGIN_ROOT="$FC_ROOT" bash "$WARMUP" >/dev/null 2>&1; then
  PASS=$((PASS + 1)); echo "  ✅ still exits 0 with the source missing"
else
  FAIL=$((FAIL + 1)); echo "  ❌ exited non-zero with the source missing"
fi
if cmp -s "$SANDBOX/fc-system.before" "$FC_HOME/.claude/system-overrides.md"; then
  PASS=$((PASS + 1)); echo "  ✅ system-overrides.md left byte-for-byte untouched"
else
  FAIL=$((FAIL + 1)); echo "  ❌ system-overrides.md was rewritten without a source"
fi
if cmp -s "$SANDBOX/fc-claude.before" "$FC_HOME/.claude/CLAUDE.md"; then
  PASS=$((PASS + 1)); echo "  ✅ CLAUDE.md left byte-for-byte untouched"
else
  FAIL=$((FAIL + 1)); echo "  ❌ CLAUDE.md was rewritten without a source"
fi

# Same for an EMPTY source — a zero-byte file is a broken install, not a licence
# to render an identity block with no rules in it.
printf '' > "$FC_ROOT/references/behavioral-overrides.md"
printf '{"source":"startup"}' | \
  HOME="$FC_HOME" WORKBENCH_MEMORY_PATH="$SANDBOX/memory" \
  WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" \
  CLAUDE_PLUGIN_ROOT="$FC_ROOT" bash "$WARMUP" >/dev/null 2>&1
if cmp -s "$SANDBOX/fc-system.before" "$FC_HOME/.claude/system-overrides.md" && \
   cmp -s "$SANDBOX/fc-claude.before" "$FC_HOME/.claude/CLAUDE.md"; then
  PASS=$((PASS + 1)); echo "  ✅ empty source also leaves both layers untouched"
else
  FAIL=$((FAIL + 1)); echo "  ❌ empty source rewrote a layer"
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
assert_contains "warns about stray summaries"          "$(notices)" "Stray session summaries in this project"
assert_contains "lists the stray file"                 "$(notices)" "xyz.summary.md"
assert_missing  "notice is NOT injected into stdout"   "$OUT" "Stray session summaries in this project"
assert_contains "stdout carries the stable pointer"    "$OUT" "Session health notices"

echo "stray-summary detector — clean project stays quiet:"
CLEAN_PROJ="$SANDBOX/clean"
mkdir -p "$CLEAN_PROJ"
OUT=$(cd "$CLEAN_PROJ" && printf '{"source":"startup"}' | \
  HOME="$SANDBOX/home" WORKBENCH_MEMORY_PATH="$SANDBOX/memory" \
  WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" \
  CLAUDE_PLUGIN_ROOT="$REPO_ROOT" bash "$WARMUP" 2>/dev/null)
assert_missing  "no stray warning when project is clean" "$(notices)" "Stray session summaries"
assert_contains "notices file rewritten, not appended"   "$(notices)" "No outstanding notices."
assert_contains "pointer still printed with no notices"  "$OUT" "Session health notices"
# The instruction must be unconditional. A pointer that says "read this if
# housekeeping seems relevant" is strictly weaker than the push banner it
# replaced, because judging relevance is what requires reading the file.
assert_contains "pointer names the file and orders a read" "$OUT" "Read \`$NOTICES_FILE\` at the start of this session."
assert_missing  "pointer is not conditional on perceived relevance" "$OUT" "when starting work that touches"

# ──────────── Cache stability (volatile notices are pulled, not pushed) ────────
# Anthropic prompt caching matches on an exact request prefix: one drifting byte
# in the warmup output invalidates the cache for everything downstream — which
# is why a scheduled Dispatch tick's ~36k-token tail never cached. The fix is
# that NO volatile notice is injected at all; they go to the notices file and a
# constant pointer line stands in. So the property to pin is not "stable prefix"
# but "byte-identical ENTIRE payload", regardless of how much notice state
# churns underneath it.

echo "cache stability — the whole warmup payload is byte-identical across notice states:"
PREFIX_PROJ="$SANDBOX/prefix-proj"
mkdir -p "$PREFIX_PROJ"
run_in_prefix_proj() {
  (cd "$PREFIX_PROJ" && printf '{"source":"startup"}' | \
    HOME="$SANDBOX/home" WORKBENCH_MEMORY_PATH="$SANDBOX/memory" \
    WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" \
    CLAUDE_PLUGIN_ROOT="$REPO_ROOT" bash "$WARMUP" 2>/dev/null)
}

# State A: clean project, fresh recall stamp, no pending markers → no notices.
RECALL_STATE="$SANDBOX/home/.claude-workbench/memory-recall"
mkdir -p "$RECALL_STATE" "$SANDBOX/cache/pending-summaries"
rm -f "$SANDBOX/cache/pending-summaries"/*.json
date +%s > "$RECALL_STATE/last-attempt"
OUT_A=$(run_in_prefix_proj)
NOTICES_A=$(notices)

# State B: stray summaries, a 3-day-old recall stamp, AND pending markers →
# all three notice sources fire at once.
mkdir -p "$PREFIX_PROJ/memory"
printf 'stray\n' > "$PREFIX_PROJ/memory/prefix-canary.summary.md"
touch -t "$(date -v-3d +%Y%m%d%H%M 2>/dev/null || date -d '3 days ago' +%Y%m%d%H%M)" \
  "$RECALL_STATE/last-attempt"
printf '{"session_id":"cache-canary","log_path":"/nonexistent/cache-canary.log.md"}\n' \
  > "$SANDBOX/cache/pending-summaries/cache-canary.json"
OUT_B=$(run_in_prefix_proj)
NOTICES_B=$(notices)

# Guard against a vacuous pass: the notice STATE must genuinely differ between
# the two runs, or identical payloads would prove nothing.
assert_contains "state B notices carry the stray-summary block" "$NOTICES_B" "Stray session summaries in this project"
assert_contains "state B notices carry the recall-dead block"   "$NOTICES_B" "Memory recall may be dead"
assert_contains "state B notices carry the pending block"       "$NOTICES_B" "Pending session summaries"
assert_contains "state A notices are empty"                     "$NOTICES_A" "No outstanding notices."
if [ "$NOTICES_A" != "$NOTICES_B" ]; then
  PASS=$((PASS + 1)); echo "  ✅ notice state genuinely differs between the two runs"
else
  FAIL=$((FAIL + 1)); echo "  ❌ notice state identical — payload comparison would be vacuous"
fi

# The property itself: same bytes out, despite all that churn.
if [ -z "$OUT_A" ]; then
  FAIL=$((FAIL + 1)); echo "  ❌ warmup produced no output — comparison is meaningless"
elif [ "$OUT_A" = "$OUT_B" ]; then
  PASS=$((PASS + 1)); echo "  ✅ warmup payload is byte-identical across notice states"
else
  FAIL=$((FAIL + 1))
  echo "  ❌ warmup payload drifted with notice state — cache stability broken:"
  diff <(printf '%s\n' "$OUT_A") <(printf '%s\n' "$OUT_B") | head -20
fi

# No volatile notice may leak into the payload by any route.
for leak in "Stray session summaries in this project" "Memory recall may be dead" \
            "Pending session summaries" "New Chat-installable skills"; do
  assert_missing "payload omits: $leak" "$OUT_B" "$leak"
done
assert_contains "payload carries the constant pointer instead" "$OUT_B" "Session health notices"

rm -f "$PREFIX_PROJ/memory/prefix-canary.summary.md" "$RECALL_STATE/last-attempt" \
      "$SANDBOX/cache/pending-summaries/cache-canary.json"

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
assert_contains "drain command namespaced correctly" "$(notices)" "/workbench-core:process-pending-summaries"
assert_missing  "no stale pre-rename namespace"      "$(notices)" "\`/workbench:process-pending-summaries\`"
rm -f "$SANDBOX/cache/pending-summaries/aaaa1111-protected.json" "$PROTECTED_LOG"

echo "pending listing — capped at count + 3 oldest:"
mkdir -p "$SANDBOX/cache/pending-summaries"
for i in 1 2 3 4 5; do
  printf '{"session_id":"sid-%s","log_path":"/nonexistent/sid-%s.log.md"}\n' "$i" "$i" \
    > "$SANDBOX/cache/pending-summaries/sid-$i.json"
  touch -t "2026010${i}0000" "$SANDBOX/cache/pending-summaries/sid-$i.json"
done
OUT=$(run_warmup startup)
assert_contains "count reflects all markers"   "$(notices)" "Pending session summaries (5)"
assert_contains "oldest marker listed"         "$(notices)" "sid-1"
assert_missing  "newest marker not enumerated" "$(notices)" "sid-5"
assert_missing  "log paths not enumerated"     "$(notices)" "/nonexistent/sid-1.log.md"

echo "PostCompact payload routes to the compact branch:"
OUT=$(printf '{"hook_event_name":"PostCompact","trigger":"auto"}' | \
  HOME="$SANDBOX/home" WORKBENCH_MEMORY_PATH="$SANDBOX/memory" \
  WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" \
  CLAUDE_PLUGIN_ROOT="$REPO_ROOT" bash "$WARMUP" 2>/dev/null)
assert_missing  "profile not inlined on PostCompact"  "$OUT" "PROFILE-CANARY"
assert_contains "profile pointer present"             "$OUT" "User profile: re-read"
assert_missing  "no pending block on PostCompact"     "$(notices)" "Pending session summaries"
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
