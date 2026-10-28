#!/bin/bash
set -u
HOOKS="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HOOKS/.." && pwd)"
SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT
PASS=0
FAIL=0
CASE=0
FV_SERVE="$SANDBOX/fv-serve"

if ! command -v node >/dev/null 2>&1; then
  echo "FAIL: node is not on PATH, so the fallbacks cannot be tested"
  exit 1
fi

echo "Node-process tier. Criteria:"
echo "  F1 rules and memory routing context, built as the mod composes it"
echo "  F2 a marker for this session keeps every fallback silent and inert"
echo "  F3 transcript record, deferred warmup after --defer, meeting check"
echo "  F4 sub-agent rules, none for OMITS_CLAUDE_MD types or fork"
echo "  F5 hooks.json runs Node from the plugin root, and no Node is a no-op"
echo "  F6 Stop re-prompt once per attended main-session turn, with the mod's reason"
echo "  F7 PreToolUse asks where the mod's destructive-scope check asks, Bash only"
echo "  F8 meetings folder watched, a change inside it rings the doorbell once"

ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; [ -n "${2:-}" ] && printf '  %s\n' "$2"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$3], got [$2]"; fi; }

FAKE="$SANDBOX/root"
mkdir -p "$FAKE/hooks/lib" "$FAKE/scripts"
cp -R "$ROOT/hooks/fallback" "$ROOT/hooks/mods" "$FAKE/hooks/"
cp -R "$ROOT/types" "$FAKE/"
sed -i.orig -e "s#^export const FV_SERVE = .*#export const FV_SERVE = '$FV_SERVE'#" -e "s#^export const DOORBELL_MS = .*#export const DOORBELL_MS = 300#" "$FAKE/hooks/mods/meetings.ts"
rm -f "$FAKE/hooks/mods/meetings.ts.orig"
cat > "$FAKE/hooks/lib/memory-env.sh" <<EOF
memory_resolve_cache_path() { printf '%s' "$SANDBOX/cache"; }
EOF
cat > "$FAKE/hooks/session-warmup.sh" <<EOF
order=before
[ -e "$SANDBOX/defer-done" ] && order=after
printf '%s|%s|%s\n' "\$*" "\$(cat)" "\$order" >> "$SANDBOX/warmup.log"
EOF
cat > "$FAKE/scripts/meeting-notes.sh" <<EOF
printf 'ran\n' >> "$SANDBOX/meetings.log"
EOF

CONFIG="$SANDBOX/config"
mkdir -p "$CONFIG"

fresh_home() {
  CASE=$((CASE + 1))
  SID="0f0e0d0c-1111-2222-3333-$(printf '%012d' "$CASE")"
  rm -rf "${SANDBOX:?}/home" "${SANDBOX:?}/cache" "${SANDBOX:?}/warmup.log" "${SANDBOX:?}/meetings.log" "${SANDBOX:?}/defer-done" "${SANDBOX:?}/fv-serve"
  mkdir -p "$SANDBOX/home" "$SANDBOX/cache"
}

run() {
  printf '%s' "$2" | env -u WORKBENCH_SKIP_WARMUP -u CLAUDE_CODE_AGENT \
    HOME="$SANDBOX/home" CLAUDE_CONFIG_DIR="$CONFIG" CLAUDE_PLUGIN_ROOT="$FAKE" \
    node "$FAKE/hooks/fallback/$1.ts" 2>"$SANDBOX/stderr"
}

start_payload() { printf '{"session_id":"%s","transcript_path":"/x/%s.jsonl","source":"%s","hook_event_name":"SessionStart"}' "$SID" "$SID" "${1:-startup}"; }
agent_payload() { printf '{"session_id":"%s","agent_type":"%s","agent_id":"a1","hook_event_name":"SubagentStart"}' "$SID" "$1"; }
context_of() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s).hookSpecificOutput;process.stdout.write(o.hookEventName+"\n"+o.additionalContext)})'; }

days_ago() { date -v-"$1"d +%Y%m%d%H%M 2>/dev/null || date -d "$1 days ago" +%Y%m%d%H%M; }
finish_defer() { sleep "${1:-0}"; : > "$SANDBOX/defer-done"; printf '%s\n' "$SID" > "$SANDBOX/cache/warmup-deferred.started"; }
wait_for() { for _ in $(seq 1 50); do [ -s "$1" ] && return 0; sleep 0.1; done; return 1; }

expected_rules() {
  (cd "$ROOT" && node --input-type=module -e '
const { readFileSync, existsSync } = await import("node:fs")
const m = await import("./hooks/mods/prompt-rules.ts")
const read = path => (existsSync(path) ? readFileSync(path, "utf8") : undefined)
process.stdout.write(m.rulesContextOf({ HOME: process.argv[1] }, read))' "$SANDBOX/home" 2>/dev/null)
}

fresh_home
EXPECTED_MAIN="SessionStart"$'\n'"$(expected_rules)"
EXPECTED_AGENT="SubagentStart${EXPECTED_MAIN#SessionStart}"
OUT="$(run session-start "$(start_payload)")"
check "node F1: a session the mod never marked gets the rules and memory routing as SessionStart context" "$(printf '%s' "$OUT" | context_of)" "$EXPECTED_MAIN"
case "$EXPECTED_MAIN" in *"# Workbench gates and scratch roots"*"## Memory routing"*) ok "node F1: the expected text comes from prompt-rules.ts" ;; *) bad "node F1: the expected text comes from prompt-rules.ts" ;; esac

fresh_home
mkdir -p "$SANDBOX/home/.claude/plugins" "$SANDBOX/sibling"
printf 'Sibling rules.\n' > "$SANDBOX/sibling/session-warmup.md"
printf '{"plugins":{"workbench-dev-team@claude-workbench":[{"installPath":"%s"}]}}' "$SANDBOX/sibling" > "$SANDBOX/home/.claude/plugins/installed_plugins.json"
OUT="$(run session-start "$(start_payload)")"
check "node F1: a sibling plugin's session-warmup.md follows the rules" "$(printf '%s' "$OUT" | context_of)" "SessionStart"$'\n'"$(expected_rules)"
case "$OUT" in *"Sibling rules."*) ok "node F1: the sibling text is in the context" ;; *) bad "node F1: the sibling text is in the context" ;; esac

fresh_home
mkdir -p "$SANDBOX/home/.claude-workbench/mod-ran/$SID"
printf '%s 1 1\n' "$SID" > "$SANDBOX/cache/warmup-deferred.started"
check "node F2: SessionStart prints nothing once the mod marked this session" "$(run session-start "$(start_payload)")" ""
check "node F2: SessionStart records no transcript once the mod marked this session" "$([ -e "$SANDBOX/home/.claude-workbench/fallback-transcripts" ] && echo recorded)" ""
sleep 1
check "node F2: SessionStart starts no deferred warmup once the mod marked this session" "$([ -e "$SANDBOX/warmup.log" ] && echo started)" ""

for hook in session-start prompt-compose subagent-start; do
  fresh_home
  mkdir -p "$SANDBOX/home/.claude-workbench/mod-ran/$SID"
  : > "$SANDBOX/home/.claude-workbench/mod-ran/$SID/$hook"
  check "node F2: SessionStart prints nothing after the mod's $hook marker" "$(run session-start "$(start_payload)")" ""
  check "node F2: SubagentStart prints nothing after the mod's $hook marker" "$(run subagent-start "$(agent_payload general-purpose)")" ""
done
fresh_home
mkdir -p "$SANDBOX/home/.claude-workbench/mod-ran/another-session"
check "node F2: another session's marker leaves this one's fallback on" "$(run session-start "$(start_payload)" | context_of)" "$EXPECTED_MAIN"
fresh_home
check "node F2: a payload with no session id prints nothing" "$(run session-start '{"source":"startup"}')" ""

for source in startup resume; do
  fresh_home
  run session-start "$(start_payload "$source")" >/dev/null
  finish_defer
  check "node F3 ($source): the transcript path is recorded where the checkpoint reads it" \
    "$(cat "$SANDBOX/home/.claude-workbench/fallback-transcripts/$SID" 2>/dev/null)" "/x/$SID.jsonl"
  wait_for "$SANDBOX/warmup.log"
  check "node F3 ($source): the deferred warmup runs with the session's payload" \
    "$(cat "$SANDBOX/warmup.log" 2>/dev/null)" "--deferred|{\"source\":\"$source\",\"session_id\":\"$SID\"}|after"
done

fresh_home
printf '%s 4242 1\n' "$SID" > "$SANDBOX/cache/warmup-deferred.started"
touch -t "$(days_ago 1)" "$SANDBOX/cache/warmup-deferred.started"
run session-start "$(start_payload resume)" >/dev/null
finish_defer 2 &
sleep 1
check "node F3: on a resume, a stale stamp with this session id starts no deferred warmup" "$([ -e "$SANDBOX/warmup.log" ] && echo started)" ""
wait
wait_for "$SANDBOX/warmup.log"
check "node F3: on a resume, the deferred warmup starts only after a slow --defer updates the stamp" \
  "$(cut -d'|' -f1,3 "$SANDBOX/warmup.log" 2>/dev/null)" "--deferred|after"

fresh_home
finish_defer
sleep 1.2
run session-start "$(start_payload resume)" >/dev/null
wait_for "$SANDBOX/warmup.log"
check "node F3: a --defer run that finished just before the fallback still starts the deferred warmup" \
  "$(cut -d'|' -f1,3 "$SANDBOX/warmup.log" 2>/dev/null)" "--deferred|after"

fresh_home
printf 'another-session\n' > "$SANDBOX/cache/warmup-deferred.started"
run session-start "$(start_payload)" >/dev/null
sleep 1
check "node F3: another session's fresh stamp starts no deferred warmup" "$([ -e "$SANDBOX/warmup.log" ] && echo started)" ""

fresh_home
run session-start "$(start_payload clear)" >/dev/null
finish_defer
sleep 1
check "node F3: a clear starts no deferred warmup" "$([ -e "$SANDBOX/warmup.log" ] && echo started)" ""
check "node F3: a clear still records the transcript" "$(cat "$SANDBOX/home/.claude-workbench/fallback-transcripts/$SID" 2>/dev/null)" "/x/$SID.jsonl"

fresh_home
mkdir -p "$SANDBOX/home/Library/Application Support/FluidVoice/Meetings"
: > "$FV_SERVE"
run session-start "$(start_payload)" >/dev/null
wait_for "$SANDBOX/meetings.log"
check "node F3: the meeting check runs when fv-serve and the meetings folder are there" "$(cat "$SANDBOX/meetings.log" 2>/dev/null)" "ran"

fresh_home
mkdir -p "$SANDBOX/home/Library/Application Support/FluidVoice/Meetings"
run session-start "$(start_payload)" >/dev/null
sleep 1
check "node F3: the meeting check stays off without fv-serve" "$([ -e "$SANDBOX/meetings.log" ] && echo ran)" ""

fresh_home
check "node F4: a general-purpose sub-agent gets the rules in a session the mod never marked" \
  "$(run subagent-start "$(agent_payload general-purpose)" | context_of)" "$EXPECTED_AGENT"
for agent in Explore Plan summary-writer workbench-core:meeting-writer fork; do
  check "node F4: $agent gets no rules" "$(run subagent-start "$(agent_payload "$agent")")" ""
done

reason_of() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(o.decision+"\n"+o.reason)})'; }
REPROMPT="$(cd "$ROOT" && node --input-type=module -e 'process.stdout.write((await import("./hooks/mods/question-rule.ts")).REPROMPT_REASON)')"
ASKS='Done. Shall I also update the docs?'
TELLS='Done. The tests pass.'
transcript() {
  printf '{"type":"user","uuid":"%s","message":{"role":"user","content":"%s"}}\n' "$1" "${2:-Fix the bug.}" > "$SANDBOX/transcript.jsonl"
  printf '{"type":"user","uuid":"tool-%s","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}}\n' "$1" >> "$SANDBOX/transcript.jsonl"
}
stop_payload() { printf '{"session_id":"%s","transcript_path":"%s","stop_hook_active":%s,"last_assistant_message":"%s"%s}' "$SID" "$SANDBOX/transcript.jsonl" "${2:-false}" "$1" "${3:-}"; }
stop() { printf '%s' "$1" | env -u CLAUDE_CODE_AGENT -u WORKBENCH_DEV_TEAM_PIPELINE HOME="$SANDBOX/home" CLAUDE_CODE_ENTRYPOINT="${2:-cli}" node "$FAKE/hooks/fallback/stop.ts" 2>/dev/null; }

fresh_home
transcript turn-1
check "node F6: an attended main-session reply that asks in prose is blocked with the mod's REPROMPT_REASON" "$(stop "$(stop_payload "$ASKS")" | reason_of)" "block"$'\n'"$REPROMPT"
case "$REPROMPT" in *AskUserQuestion*) ok "node F6: the expected reason comes from question-rule.ts" ;; *) bad "node F6: the expected reason comes from question-rule.ts" ;; esac
check "node F6: a second Stop in the same turn is not blocked" "$(stop "$(stop_payload "$ASKS")")" ""
transcript turn-2
check "node F6: the next turn's question is blocked again" "$(stop "$(stop_payload "$ASKS")" | reason_of)" "block"$'\n'"$REPROMPT"
fresh_home
transcript turn-1
check "node F6: a reply that asks nothing is not blocked" "$(stop "$(stop_payload "$TELLS")")" ""
check "node F6: a Stop with stop_hook_active is not blocked" "$(stop "$(stop_payload "$ASKS" true)")" ""
check "node F6: a sub-agent's Stop is not blocked" "$(stop "$(stop_payload "$ASKS" false ',"agent_id":"a1","agent_type":"general-purpose"')")" ""
check "node F6: a -p session is not blocked" "$(stop "$(stop_payload "$ASKS")" sdk-cli)" ""
check "node F6: a session with no entrypoint is not blocked" "$(printf '%s' "$(stop_payload "$ASKS")" | env -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_AGENT HOME="$SANDBOX/home" node "$FAKE/hooks/fallback/stop.ts")" ""
check "node F6: an agent session is not blocked" "$(printf '%s' "$(stop_payload "$ASKS")" | env HOME="$SANDBOX/home" CLAUDE_CODE_ENTRYPOINT=cli CLAUDE_CODE_AGENT=watson node "$FAKE/hooks/fallback/stop.ts")" ""
check "node F6: a pipeline session is not blocked" "$(printf '%s' "$(stop_payload "$ASKS")" | env -u CLAUDE_CODE_AGENT HOME="$SANDBOX/home" CLAUDE_CODE_ENTRYPOINT=cli WORKBENCH_DEV_TEAM_PIPELINE=1 node "$FAKE/hooks/fallback/stop.ts")" ""
SCHEDULED_PROMPT="$(cd "$ROOT" && node --input-type=module -e 'const m=await import("./hooks/mods/lane.ts");for (const t of ["<scheduled-task name=nightly>Run it."]) if (m.isScheduledFire(t)) { process.stdout.write(t); break }')"
if [ -n "$SCHEDULED_PROMPT" ]; then
  transcript turn-3 "$SCHEDULED_PROMPT"
  check "node F6: a scheduled turn is not blocked" "$(stop "$(stop_payload "$ASKS")")" ""
else
  bad "node F6: a scheduled prompt text was found in lane.ts"
fi
rm -f "$SANDBOX/transcript.jsonl"
check "node F6: an unreadable transcript blocks nothing" "$(stop "$(stop_payload "$ASKS")")" ""

mkdir -p "$SANDBOX/scope/home/outside" "$SANDBOX/scope/project"
SCOPE="$(cd "$ROOT" && node tests/fallback-scope.ts "$ROOT" "$ROOT/hooks/fallback/pre-tool-use.ts" "$SANDBOX/scope/home" "$SANDBOX/scope/project" "0f0e0d0c-aaaa-bbbb-cccc-000000000001" 5 2>&1)"
case "$SCOPE" in *"kinds ask,deny,none, 0 mismatched") ok "node F7: the PreToolUse fallback answers as the mod's destructive-scope check does on its own guard corpus" ;; *) bad "node F7: the PreToolUse fallback answers as the mod's destructive-scope check does on its own guard corpus" "$SCOPE" ;; esac
pre() { printf '{"session_id":"%s","cwd":"%s","tool_name":"%s","tool_input":{"command":"%s"}}' "$SID" "$SANDBOX/scope/project" "${2:-Bash}" "$1"; }
pre_run() { printf '%s' "$1" | env -u CLAUDE_CODE_AGENT -u WORKBENCH_DEV_TEAM_PIPELINE HOME="$SANDBOX/home" CLAUDE_PLUGIN_ROOT="$ROOT" CLAUDE_PROJECT_DIR="$SANDBOX/scope/project" CLAUDE_CODE_ENTRYPOINT="${2:-cli}" node "$FAKE/hooks/fallback/pre-tool-use.ts" 2>/dev/null; }
decision_of() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(s&&JSON.parse(s).hookSpecificOutput.permissionDecision))'; }
fresh_home
check "node F7: an out-of-root delete asks" "$(pre_run "$(pre 'rm -rf /victim/keep.txt')" | decision_of)" "ask"
check "node F7: an out-of-root delete in an unattended session is refused, as the mod refuses it" "$(pre_run "$(pre 'rm -rf /victim/keep.txt')" sdk-cli | decision_of)" "deny"
check "node F7: a delete inside the project gets no answer" "$(pre_run "$(pre "rm -rf $SANDBOX/scope/project/build")")" ""
check "node F7: a non-Bash tool gets no answer" "$(pre_run "$(pre 'rm -rf /victim/keep.txt' Read)")" ""
check "node F7: a fallback with no plugin root refuses rather than lets the call through" \
  "$(printf '%s' "$(pre 'rm -rf /victim/keep.txt')" | env -u CLAUDE_PLUGIN_ROOT HOME="$SANDBOX/home" CLAUDE_CODE_ENTRYPOINT=cli node "$FAKE/hooks/fallback/pre-tool-use.ts" | decision_of)" "deny"
MATCHER="$(jq -r '[.hooks.PreToolUse[] | select(any(.hooks[]; .command | contains("fallback/pre-tool-use.ts"))) | .matcher] | join(",")' "$HOOKS/hooks.json")"
check "node F7: the PreToolUse fallback runs only for Bash, the one tool the destructive-scope check reads" "$MATCHER" "Bash"

MEET="$SANDBOX/home/Library/Application Support/FluidVoice/Meetings"
changed() { printf '{"session_id":"%s","file_path":"%s","event":"change"}' "$SID" "$1" | env -u WORKBENCH_SKIP_WARMUP HOME="$SANDBOX/home" CLAUDE_PLUGIN_ROOT="$FAKE" node "$FAKE/hooks/fallback/file-changed.ts" 2>/dev/null; }
watched() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write((JSON.parse(s).hookSpecificOutput.watchPaths||[]).join(",")))'; }
fresh_home
mkdir -p "$MEET"
: > "$FV_SERVE"
check "node F8: SessionStart returns the meetings folder to watch, as the mod does" "$(run session-start "$(start_payload clear)" | watched)" "$MEET"
changed "$MEET/m1.json"
changed "$MEET/m2.json"
wait_for "$SANDBOX/meetings.log"
sleep 1
check "node F8: a burst of changes inside the meetings folder rings the doorbell once" "$(cat "$SANDBOX/meetings.log" 2>/dev/null)" "ran"
fresh_home
mkdir -p "$MEET"
: > "$FV_SERVE"
changed "$SANDBOX/home/elsewhere.json"
sleep 1
check "node F8: a change outside the meetings folder does nothing" "$([ -e "$SANDBOX/meetings.log" ] && echo ran)$([ -e "$SANDBOX/home/.claude-workbench/fallback-doorbell" ] && echo rung)" ""
fresh_home
mkdir -p "$MEET"
check "node F8: without fv-serve, SessionStart watches nothing" "$(run session-start "$(start_payload clear)" | watched)" ""
changed "$MEET/m1.json"
sleep 1
check "node F8: without fv-serve a change does nothing" "$([ -e "$SANDBOX/meetings.log" ] && echo ran)" ""

fresh_home
mkdir -p "$SANDBOX/home/.claude-workbench/mod-ran/$SID" "$MEET"
: > "$FV_SERVE"
transcript turn-1
check "node F2: Stop prints nothing once the mod marked this session" "$(stop "$(stop_payload "$ASKS")")" ""
check "node F2: Stop records no reprompt once the mod marked this session" "$([ -e "$SANDBOX/home/.claude-workbench/fallback-reprompted" ] && echo recorded)" ""
check "node F2: PreToolUse prints nothing once the mod marked this session" "$(pre_run "$(pre 'rm -rf /victim/keep.txt')")" ""
changed "$MEET/m1.json"
sleep 1
check "node F2: FileChanged rings nothing once the mod marked this session" "$([ -e "$SANDBOX/meetings.log" ] && echo ran)$([ -e "$SANDBOX/home/.claude-workbench/fallback-doorbell" ] && echo rung)" ""

fresh_home
transcript turn-1
check "node F6: a GitHub Actions run is not blocked" "$(stop "$(stop_payload "$ASKS")" claude-code-github-action)" ""
check "node F7: an out-of-root delete in a GitHub Actions run is refused, as in any unattended session" "$(pre_run "$(pre 'rm -rf /victim/keep.txt')" claude-code-github-action | decision_of)" "deny"

SLOW="$SANDBOX/slow-root"
mkdir -p "$SLOW/hooks/lib"
printf 'sleep 5\n' > "$SLOW/hooks/lib/scope-facts.sh"
DEADLINE_FAKE="$SANDBOX/deadline-root"
cp -R "$FAKE" "$DEADLINE_FAKE"
sed -i.orig 's#^const DEADLINE_MS = .*#const DEADLINE_MS = 1_500#' "$DEADLINE_FAKE/hooks/fallback/pre-tool-use.ts"
fresh_home
BEFORE=$(node -e 'process.stdout.write(String(Date.now()))')
OUT="$(printf '%s' "$(pre 'rm -rf /victim/keep.txt')" | env -u CLAUDE_CODE_AGENT HOME="$SANDBOX/home" CLAUDE_PLUGIN_ROOT="$SLOW" CLAUDE_PROJECT_DIR="$SANDBOX/scope/project" CLAUDE_CODE_ENTRYPOINT=cli node "$DEADLINE_FAKE/hooks/fallback/pre-tool-use.ts" 2>/dev/null)"
AFTER=$(node -e 'process.stdout.write(String(Date.now()))')
GUARD_FAILED_TEXT="$(cd "$ROOT" && node --input-type=module -e 'process.stdout.write((await import("./hooks/mods/guard-failed.ts")).GUARD_FAILED)')"
check "node F7: checks that overrun the deadline answer deny with GUARD_FAILED" \
  "$(printf '%s' "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s||"{}").hookSpecificOutput||{};process.stdout.write(o.permissionDecision+"|"+o.permissionDecisionReason)})')" "deny|$GUARD_FAILED_TEXT"
if [ $((AFTER - BEFORE)) -lt 4000 ]; then ok "node F7: the deadline answer comes before the slow check ends ($((AFTER - BEFORE)) ms)"; else bad "node F7: the deadline answer comes before the slow check ends" "$((AFTER - BEFORE)) ms"; fi
DEADLINE_S=$(( $(sed -n 's/^const DEADLINE_MS = \([0-9_]*\)$/\1/p' "$HOOKS/fallback/pre-tool-use.ts" | tr -d _) / 1000 ))
TIMEOUT_S="$(jq -r '[.hooks.PreToolUse[].hooks[] | select(.command | contains("fallback/pre-tool-use.ts")) | .timeout][0] // 0' "$HOOKS/hooks.json")"
if [ "$DEADLINE_S" -gt 0 ] && [ "$DEADLINE_S" -lt "$TIMEOUT_S" ]; then ok "node F7: the ${DEADLINE_S} s deadline ends before the ${TIMEOUT_S} s hook timeout"; else bad "node F7: the deadline ends before the hook timeout" "deadline ${DEADLINE_S} s, timeout ${TIMEOUT_S} s"; fi

LOAD_FAKE="$SANDBOX/load-root"
cp -R "$FAKE" "$LOAD_FAKE"
for heavy in question-rule guards shell destructive-scope scope-facts; do
  printf "\n;(await import('node:fs')).writeFileSync('%s', '%s')\n" "$SANDBOX/loaded-$heavy" "$heavy" >> "$LOAD_FAKE/hooks/mods/$heavy.ts"
done
loaded() { for heavy in question-rule guards shell destructive-scope scope-facts; do [ -e "$SANDBOX/loaded-$heavy" ] && printf '%s ' "$heavy"; done; rm -f "$SANDBOX"/loaded-*; }
fresh_home
transcript turn-1
mkdir -p "$SANDBOX/home/.claude-workbench/mod-ran/$SID"
printf '%s' "$(stop_payload "$ASKS")" | env -u CLAUDE_CODE_AGENT HOME="$SANDBOX/home" CLAUDE_CODE_ENTRYPOINT=cli node "$LOAD_FAKE/hooks/fallback/stop.ts" >/dev/null 2>&1
check "node F2: with the marker, Stop loads none of the question or guard modules" "$(loaded)" ""
printf '%s' "$(pre 'rm -rf /victim/keep.txt')" | env -u CLAUDE_CODE_AGENT HOME="$SANDBOX/home" CLAUDE_PLUGIN_ROOT="$ROOT" CLAUDE_CODE_ENTRYPOINT=cli node "$LOAD_FAKE/hooks/fallback/pre-tool-use.ts" >/dev/null 2>&1
check "node F2: with the marker, PreToolUse loads none of the question or guard modules" "$(loaded)" ""
rm -rf "$SANDBOX/home/.claude-workbench/mod-ran/$SID"
printf '%s' "$(stop_payload "$ASKS")" | env -u CLAUDE_CODE_AGENT HOME="$SANDBOX/home" CLAUDE_CODE_ENTRYPOINT=cli node "$LOAD_FAKE/hooks/fallback/stop.ts" >/dev/null 2>&1
check "node F2: without the marker, Stop does load the question module (the probe works)" "$(loaded)" "question-rule "
printf '%s' "$(pre 'rm -rf /victim/keep.txt')" | env -u CLAUDE_CODE_AGENT HOME="$SANDBOX/home" CLAUDE_PLUGIN_ROOT="$ROOT" CLAUDE_PROJECT_DIR="$SANDBOX/scope/project" CLAUDE_CODE_ENTRYPOINT=cli node "$LOAD_FAKE/hooks/fallback/pre-tool-use.ts" >/dev/null 2>&1
check "node F2: without the marker, PreToolUse does load the guard modules (the probe works)" "$(loaded)" "guards shell destructive-scope scope-facts "

for heavy in guards destructive-scope scope-facts shell; do
  BROKEN="$SANDBOX/broken-$heavy"
  rm -rf "$BROKEN"
  cp -R "$FAKE" "$BROKEN"
  printf "\n;throw new Error('broken %s')\n" "$heavy" >> "$BROKEN/hooks/mods/$heavy.ts"
  fresh_home
  OUT="$(printf '%s' "$(pre 'rm -rf /victim/keep.txt')" | env -u CLAUDE_CODE_AGENT HOME="$SANDBOX/home" CLAUDE_PLUGIN_ROOT="$ROOT" CLAUDE_PROJECT_DIR="$SANDBOX/scope/project" CLAUDE_CODE_ENTRYPOINT=cli node "$BROKEN/hooks/fallback/pre-tool-use.ts" 2>/dev/null)"
  check "node F7: when $heavy.ts fails to load, PreToolUse denies with GUARD_FAILED" \
    "$(printf '%s' "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s||"{}").hookSpecificOutput||{};process.stdout.write(o.permissionDecision+"|"+o.permissionDecisionReason)})')" "deny|$GUARD_FAILED_TEXT"
done
DEFINED="$(grep -rl --include="*.ts" "the guards that judge this call could not finish" "$ROOT/hooks" | sed "s#^$ROOT/##")"
check "node F7: GUARD_FAILED's text is defined in one file" "$DEFINED" "hooks/mods/guard-failed.ts"

for entry in session-start subagent-start stop pre-tool-use file-changed; do
  CMD="$(jq -r --arg f "hooks/fallback/$entry.ts" '[.hooks[][].hooks[].command | select(contains($f))][0] // empty' "$HOOKS/hooks.json")"
  case "$CMD" in *"node \"\${CLAUDE_PLUGIN_ROOT}/hooks/fallback/$entry.ts\""*) ok "node F5: hooks.json runs $entry.ts with node from CLAUDE_PLUGIN_ROOT" ;; *) bad "node F5: hooks.json runs $entry.ts with node from CLAUDE_PLUGIN_ROOT" "$CMD" ;; esac
  mkdir -p "$SANDBOX/nonode"
  OUT="$(printf '%s' "$(start_payload)" | env -i PATH="$SANDBOX/nonode" HOME="$SANDBOX/home" CLAUDE_CONFIG_DIR="$CONFIG" CLAUDE_PLUGIN_ROOT="$FAKE" /bin/bash -c "$CMD" 2>&1)"
  STATUS=$?
  check "node F5: with no node, $entry exits 0 and prints nothing" "$STATUS:$OUT" "0:"
done

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
