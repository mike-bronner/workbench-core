#!/bin/bash

set -u
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HOOKS_DIR/.." && pwd)"
SKILL="$ROOT/skills/session-timeline/SKILL.md"
SCRIPT="$ROOT/skills/session-timeline/scripts/timeline.mjs"
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); echo "  ✅ $1"; }
no() { FAIL=$((FAIL + 1)); echo "  ❌ $1: $2"; }

command -v node >/dev/null 2>&1 || { echo "FAIL: node is not on PATH, so the timeline script cannot be tested"; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
LOGS="$TMP/logs"
SESSION=0f3c2a1e-1111-4222-8333-444455556666
PROJECT="$LOGS/.claude/projects/-work-app"
mkdir -p "$PROJECT/$SESSION/subagents" "$LOGS/.codex/sessions/2026/03/01" "$TMP/empty"

cat > "$PROJECT/$SESSION.jsonl" <<JSONL
{"type":"user","sessionId":"$SESSION","timestamp":"2026-03-01T09:10:00.000Z","message":{"role":"user","content":"Rebuild the service."}}
{"type":"assistant","sessionId":"$SESSION","timestamp":"2026-03-01T09:30:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Final draft: port 9090."}]}}
{"type":"last-prompt","sessionId":"$SESSION"}
JSONL
cat > "$PROJECT/$SESSION/subagents/agent-a1b2c3d4e5f6.jsonl" <<JSONL
{"type":"assistant","sessionId":"$SESSION","isSidechain":true,"agentId":"a1b2c3d4e5f6","timestamp":"2026-03-01T09:20:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Sub-agent picked the config path."}]}}
JSONL
printf '{"agentType":"researcher"}\n' > "$PROJECT/$SESSION/subagents/agent-a1b2c3d4e5f6.meta.json"
cat > "$LOGS/.codex/sessions/2026/03/01/rollout-2026-03-01T10-15-00-6aab86ac-3a96-49de-a696-cfbbf066cea8.jsonl" <<'JSONL'
{"timestamp":"2026-03-01T09:15:00.000Z","type":"session_meta","payload":{"id":"6aab86ac-3a96-49de-a696-cfbbf066cea8","cwd":"/work/app","originator":"codex_cli_rs"}}
{"timestamp":"2026-03-01T09:25:00+00:00","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Older draft: port 8080."}]}}
{"timestamp":"2026-03-01T09:25:01.000Z","type":"event_msg","payload":{"type":"agent_message","message":"Older draft: port 8080."}}
JSONL
ln -s "$PROJECT/$SESSION.jsonl" "$TMP/link.jsonl"

OUT=""
RC=0
run() { OUT=$("$@" 2>&1); RC=$?; }
expect() {
  if [ "$RC" -ne "$2" ]; then no "$1" "exit $RC, wanted $2: $OUT"
  elif ! printf '%s' "$OUT" | grep -qF -- "$3"; then no "$1" "no '$3' in: $OUT"
  else ok "$1"; fi
}

echo "the script tests itself with no files:"
run node "$SCRIPT" --self-test
expect "the self-test passes" 0 "self-test ok"

echo
echo "the logs merge into one UTC timeline:"
run node "$SCRIPT" "$LOGS"
expect "the timeline reads" 0 "Rebuild the service."
order="$(printf '%s\n' "$OUT" | grep -oE 'Rebuild|session: cwd|Sub-agent|Older draft|Final draft' | tr '\n' ' ')"
if [ "$order" = "Rebuild session: cwd Sub-agent Older draft Final draft " ]; then ok "records sort by their UTC time, not by file name"; else no "records sort by their UTC time, not by file name" "$order"; fi
expect "a sub-agent file is read and labeled by its agent type" 0 "claude 0f3c2a1e/researcher assistant/text: Sub-agent picked the config path."
expect "a rollout is labeled by its id, its offset time turned into Z" 0 "2026-03-01T09:25:00.000Z codex 6aab86ac assistant/text: Older draft: port 8080."
count="$(printf '%s\n' "$OUT" | grep -c 'Older draft')"
if [ "$count" -eq 1 ]; then ok "a rollout event that repeats a message is left out"; else no "a rollout event that repeats a message is left out" "found $count"; fi
expect "a line with no time is counted on stderr" 0 "1 untimed line(s)"

echo
echo "the options:"
run node "$SCRIPT" "$LOGS" --files
expect "--files lists each log with its first and last time" 0 "2026-03-01T09:20:00.000Z  2026-03-01T09:20:00.000Z       1  claude 0f3c2a1e/researcher"
logs="$(printf '%s\n' "$OUT" | grep -c '\.jsonl$')"
if [ "$logs" -eq 3 ]; then ok "--files lists the three logs"; else no "--files lists the three logs" "found $logs"; fi
run node "$SCRIPT" "$LOGS" --since 2026-03-01T09:22:00Z --until 2026-03-01T09:26:00Z
lines="$(printf '%s\n' "$OUT" | grep -c '^2026-')"
if [ "$lines" -eq 1 ]; then ok "--since and --until keep the records between them"; else no "--since and --until keep the records between them" "$OUT"; fi
run node "$SCRIPT" "$LOGS" --since 2026-03-01T09:22:00
expect "a bound with no zone is refused" 1 "a time with Z or an offset"
run node "$SCRIPT" "$LOGS" --width 0
expect "a width of 0 is refused" 1 "--width takes a whole number above 0"
run node "$SCRIPT" "$TMP/empty"
expect "a folder with no log is refused" 1 "no .jsonl log found"
run node "$SCRIPT" "$TMP/link.jsonl"
expect "a symbolic link is not followed" 1 "no .jsonl log found"
run node "$SCRIPT" "$LOGS" --bogus
expect "an unknown option is refused" 1 "unknown option --bogus"

echo
echo "the skill ships what it runs, and stays generic:"
while IFS= read -r ref; do
  path="${ref#\$\{CLAUDE_PLUGIN_ROOT\}/}"
  if [ -f "$ROOT/$path" ]; then ok "the skill's command names $path, which exists"; else no "the skill's command names a script that exists" "$ref"; fi
done < <(grep -oE '\$\{CLAUDE_PLUGIN_ROOT\}/[A-Za-z0-9_./-]+' "$SKILL" | sort -u)
hit="$(grep -niE 'writeFile|appendFile|createWriteStream|mkdir|unlink|child_process|fetch\(|http' "$SCRIPT" | head -1)"
if [ -z "$hit" ]; then ok "the script writes nothing, runs nothing and uses no network"; else no "the script writes nothing, runs nothing and uses no network" "$hit"; fi
hit="$(tail -n +2 "$SCRIPT" | grep -nE '^[[:space:]]*(//|/\*)|[;,{}()][[:space:]]+//' | head -1)"
if [ -z "$hit" ]; then ok "the script carries no code comments"; else no "the script carries no code comments" "$hit"; fi
if found="$(grep -rniE 'course|challenge' "$ROOT/skills/session-timeline")"; then
  no "the skill names no course or challenge" "$found"
else
  ok "the skill names no course or challenge"
fi
if awk '/^---$/{c++; next} c==1' "$SKILL" | grep -qE '^description: Use '; then ok "the description says when to use it"; else no "the description says when to use it" "missing"; fi
hit="$(tail -n +2 "$0" | grep -nE '^[[:space:]]*#' | head -1)"
if [ -z "$hit" ]; then ok "this test carries no comments"; else no "this test carries no comments" "$hit"; fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
