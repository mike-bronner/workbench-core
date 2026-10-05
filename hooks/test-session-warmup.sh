#!/bin/bash
# Tests for session-warmup.sh. Run directly: ./test-session-warmup.sh
# Each case invokes the hook with a synthetic SessionStart payload inside a
# sandbox (fake HOME + memory path) and asserts what is injected for that
# source, and what housekeeping it does.

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
# The reconciler reads transcripts from ${CLAUDE_CONFIG_DIR:-$HOME/.claude}. A
# runner inside Claude Code may export CLAUDE_CONFIG_DIR, which would point every
# warmup below at the developer's real transcripts. Unset, it follows the
# sandbox HOME.
unset CLAUDE_CONFIG_DIR

SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

# Sandbox layout: fake HOME so the script's persistent-file management never
# touches the real ~/.claude. The three canary files are the persona and protocol
# files the warmup used to inject. They stay on disk, as they may in a real vault,
# so every "not injected" assertion below is made with the file present.
mkdir -p "$SANDBOX/home" "$SANDBOX/memory/identity" "$SANDBOX/cache"
printf 'SOULHOT-CANARY soul rules\n' > "$SANDBOX/memory/identity/soul-hot.md"
printf 'PROFILE-CANARY user facts\n' > "$SANDBOX/memory/identity/profile.md"
printf 'SKILLSPROTO-CANARY skill learnings\n' > "$SANDBOX/memory/identity/skills-protocol.md"

# The health probe reads the CONFIGURED port, and without a pin that resolves to
# the plugin's 8765 default — where a developer running this plugin has a real
# memory server listening. The probe then correctly reports a foreign listener,
# and the "server is merely down" assertions below go red on a working machine
# while staying green on CI, which has nothing on 8765. Pin a genuinely free port
# in the high ephemeral band instead, the same defence test-memory-server-up.sh
# applies for the same reason.
port_is_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
PROBE_PORT=""
_candidate=$(( 20000 + (RANDOM % 20000) ))
for _ in $(seq 1 500); do
  if port_is_free "$_candidate"; then PROBE_PORT="$_candidate"; break; fi
  _candidate=$((_candidate + 1))
done
if [ -z "$PROBE_PORT" ]; then
  # Fail closed: handing back an occupied port reproduces the exact red the pin
  # exists to prevent, but somewhere far from here.
  echo "FATAL: no free TCP port found for the probe" >&2
  exit 1
fi

run_warmup() {
  local source="$1"
  local agent="${2:-}"
  printf '{"source":"%s"}' "$source" | (
    [ -n "$agent" ] && export CLAUDE_CODE_AGENT="$agent"
    HOME="$SANDBOX/home" \
    WORKBENCH_MEMORY_PATH="$SANDBOX/memory" \
    WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" \
    WORKBENCH_MEMORY_PORT="$PROBE_PORT" \
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

assert_path() {
  if [ -e "$2" ]; then PASS=$((PASS + 1)); echo "  ✅ $1"
  else FAIL=$((FAIL + 1)); echo "  ❌ $1 — expected to exist: $2"; fi
}

assert_no_path() {
  if [ -e "$2" ]; then FAIL=$((FAIL + 1)); echo "  ❌ $1 — should NOT exist: $2"
  else PASS=$((PASS + 1)); echo "  ✅ $1"; fi
}

# Volatile notices are no longer injected into the warmup payload — they are
# written to this file and surfaced by a byte-stable pointer. Tests that used
# to grep stdout for a notice now read here instead.
NOTICES_FILE="$SANDBOX/home/.claude-workbench/warmup-notices.md"
notices() { cat "$NOTICES_FILE" 2>/dev/null; }

# The retired persona files and the skills-protocol pointer, asserted absent on
# every source. The output style is the only persona, and hooks/skill-learnings.sh
# hands each skill its own learnings, so none of the three has a reader left.
assert_no_persona() {  # assert_no_persona <source-label> <output>
  assert_missing "$1: no soul file injected"        "$2" "SOULHOT-CANARY"
  assert_missing "$1: no profile injected"          "$2" "PROFILE-CANARY"
  assert_missing "$1: no profile pointer"           "$2" "User profile"
  assert_missing "$1: no skills-protocol text"      "$2" "SKILLSPROTO-CANARY"
  assert_missing "$1: no skills-protocol pointer"   "$2" "Skills protocol"
}

echo "startup — the rules, and no persona file:"
OUT=$(run_warmup startup)
assert_no_persona startup "$OUT"
# The behavioural rules load from the output style alone. hooks/test-rule-source.sh
# proves no rule text reaches stdout; this pins the heading that used to carry it.
assert_missing  "no guardrails payload injected"   "$OUT" "## Guardrails"
# Memory capture is standing authorization. The guardrails payload used to carry
# that exemption, so the routing block now states it on its own.
assert_contains "memory capture needs no confirmation" "$OUT" "a memory-capture write needs no options round and no confirmation"
# The recall-ORDERING rule has no hook that can carry it in full — memory-recall.sh
# only ever sees the main session's prompts, and memory-scan-recall.sh only fires
# on a file search that carries an extractable query — so the injected routing
# block is the only
# thing that carries the whole rule, and these are the only assertions that prove
# it is still there.
# The where-rule is asserted alongside it because the two answer different
# questions and a rewrite that collapses them into one bullet loses the answer
# to "where", which is the older of the two.
assert_contains "routing block orders recall first"     "$OUT" "Recall comes FIRST"
assert_contains "recall precedes the repo scan"         "$OUT" "BEFORE you scan the repo"
assert_contains "the ordering rule carries its reason"  "$OUT" "Auto-recall searches only the wording of each prompt and the patterns of your file searches"
# memory-recall.sh runs on every substantive prompt, so a claim that auto-recall
# saw only the opening prompt is false. It shipped in this block until 2026-09-27.
assert_missing  "no claim that recall saw only the opening prompt" "$OUT" "opening prompt"
assert_contains "recall still routes to the vault"      "$OUT" "Recall = vault \`search\`, not directory reads."
# The server's default mode is "auto", which falls back to keyword on a vault
# with no embeddings. Naming hybrid here broke that fallback.
assert_contains "recall leaves the mode to the server"  "$OUT" "Omit \`mode\`: the server picks hybrid when the vault has embeddings"
assert_missing  "recall does not force hybrid"          "$OUT" "(mode hybrid)"
# WHEN to search and WHAT to search for are different rules, and the block is
# the only floor for both. The ordering bullet alone leaves the agent running
# the prompt's own wording, which is the weaker query and the measured failure:
# an agent-formed query found a release-naming rule the prompt's wording missed.
assert_contains "routing block says what to query"      "$OUT" "Build the recall QUERY from the TASK"
assert_contains "the query rule rejects the prompt's wording" "$OUT" "not from the prompt"
assert_contains "the query rule carries its reason"     "$OUT" "your advantage over it is asking the better question"

echo "startup — the shared-server health probe reports a server that is not up:"
# $OUT still holds the startup run above, where nothing is listening on the
# configured port — so the probe returns DOWN_NONE and the warmup should say the
# server is starting. This assertion is the inverse of the one it replaced: under
# per-session stdio there was no external listener to probe, so the notice was
# pure noise and the block was removed. With the shared HTTP transport restored
# there IS a listener to speak for, and staying silent about a down server would
# hide the one failure the user most needs to see.
assert_contains "reports a server that is not yet up" "$OUT" "Memory server starting"

# The other probe branches must stay quiet in this state: a down server is not a
# port conflict and not a config drift, and conflating them would send the user
# chasing the wrong fix.
assert_missing "no port-drift notice when merely down" "$OUT" "Memory server port drift"
assert_missing "no conflict notice when merely down"   "$OUT" "Memory server port conflict"

# A healthy server must produce NO health notice at all — the common case needs
# no words. Simulated by pointing the probe at a stub that reports UP.
PROBE_STUB="$SANDBOX/probe-up"
mkdir -p "$PROBE_STUB"
cat > "$PROBE_STUB/memory-probe.sh" <<'STUB'
memory_probe() { echo UP; }
STUB
OUT_UP=$(WORKBENCH_PROBE_OVERRIDE="$PROBE_STUB/memory-probe.sh" run_warmup startup)
assert_missing "healthy server prints no notice" "$OUT_UP" "Memory server"

echo "startup — the per-project router stub carries the routing rules:"
# The stub is the SECOND home of the routing rules, and the only one a context
# that skips this warmup still sees — a sub-agent dispatch exits at the
# CLAUDE_CODE_AGENT guard, while the harness keeps injecting the project's
# MEMORY.md. So the ordering rule has to reach the stub too, not just stdout.
# The path is the one ensure_memory_routing_stub builds: fake HOME, cwd encoded
# with "/" replaced by "-". The startup runs above wrote it.
STUB_FILE="$SANDBOX/home/.claude/projects/${PWD//\//-}/memory/MEMORY.md"
STUB_TEXT=$(cat "$STUB_FILE" 2>/dev/null)
assert_contains "stub written on startup"              "$STUB_TEXT" "<!-- workbench-memory-router -->"
assert_contains "stub orders recall first"             "$STUB_TEXT" "**Recall first**"
assert_contains "stub ordering carries its reason"     "$STUB_TEXT" "Automatic recall searches only the main session's prompts and the patterns of file searches"
assert_missing  "stub makes no opening-prompt claim"   "$STUB_TEXT" "opening prompt"
assert_missing  "stub names no retired search-mode hook" "$STUB_TEXT" "memory-search-mode"
assert_contains "stub leaves the mode to the server"   "$STUB_TEXT" "the server picks hybrid when the vault has embeddings and keyword when it does not"
# The stub carries BOTH recall rules or the two homes have drifted apart, and a
# sub-agent — which never runs this warmup — only ever reads the stub.
assert_contains "stub says what to query"              "$STUB_TEXT" "**Query the task, not the prompt**"
assert_contains "stub query rule carries its reason"   "$STUB_TEXT" "asking the better question"
assert_contains "stub still routes recall to the vault" "$STUB_TEXT" "search the vault (\`mcp__plugin_workbench-core_memory__search\`)"

echo "clear, compact and resume — the rules again, and still no persona file:"
for source in clear compact resume; do
  OUT=$(run_warmup "$source")
  assert_no_persona "$source" "$OUT"
  assert_contains "$source: memory routing injected" "$OUT" "## Memory routing"
done

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
assert_missing "no destructive-commands block"     "$OUT" "## Destructive commands"
assert_missing "no memory-routing block"           "$OUT" "## Memory routing"
assert_missing "no pending-summary housekeeping"   "$OUT" "Pending session summaries"
OUT=$(run_warmup resume "some-plugin:some-agent")
assert_missing "skip is source-independent (resume)" "$OUT" "## Memory routing"
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
# system-overrides.md is retired. An absent file stays absent, so a user who
# removed the alias and deleted the file is never handed it back.
if [ ! -e "$UNSET_HOME/.claude/system-overrides.md" ]; then
  PASS=$((PASS + 1)); echo "  ✅ does not create ~/.claude/system-overrides.md"
else
  FAIL=$((FAIL + 1)); echo "  ❌ created ~/.claude/system-overrides.md from nothing"
fi

echo "managed CLAUDE.md block — facts only, and every fact is true:"
# ~/.claude/CLAUDE.md reaches every sub-agent, so the managed block carries
# facts and no behavioural rule. hooks/test-rule-source.sh proves no rule text
# lands here. This section proves the facts are present and match the plugin.
OV_HOME="$SANDBOX/overrides-home"
mkdir -p "$OV_HOME/.claude"
printf '## My own notes\n\nUSER-PROSE-CANARY\n' > "$OV_HOME/.claude/CLAUDE.md"
printf '{"source":"startup"}' | \
  HOME="$OV_HOME" WORKBENCH_MEMORY_PATH="$SANDBOX/memory" \
  WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" \
  CLAUDE_PLUGIN_ROOT="$REPO_ROOT" bash "$WARMUP" >/dev/null 2>&1
OV_CLAUDE="$(cat "$OV_HOME/.claude/CLAUDE.md" 2>/dev/null)"
# Scoped to the managed block, never to the whole file: ~/.claude/CLAUDE.md also
# carries the warmup block and the user's own prose below it, and either could
# satisfy a whole-file grep while the managed block had lost the fact.
OV_ID_BLOCK=$(awk '
  $0 == "<!-- workbench-identity:start -->" { inblock=1 }
  inblock { print }
  $0 == "<!-- workbench-identity:end -->"   { inblock=0 }
' "$OV_HOME/.claude/CLAUDE.md" 2>/dev/null)
assert_contains "block keeps its start marker"         "$OV_CLAUDE" "<!-- workbench-identity:start -->"
assert_contains "block keeps its end marker"           "$OV_CLAUDE" "<!-- workbench-identity:end -->"
assert_contains "user prose below the block survives"  "$OV_CLAUDE" "USER-PROSE-CANARY"
assert_missing  "block no longer lists identity files" "$OV_ID_BLOCK" "## Identity files"
# The delegation gate is announced here and nowhere else. Core is excluded from
# collect_session_warmup_contributions by design, so there is no root
# session-warmup.md to carry it. The gate is advisory since 2026-10-05, and the
# block must say so, or the model reads every reminder as a refusal.
assert_contains "block announces the delegation gate"  "$OV_ID_BLOCK" "| Delegation gate |"
assert_contains "block says the gate never denies"     "$OV_ID_BLOCK" "It never denies: a main-agent \`Write\` or \`NotebookEdit\` goes ahead with a reminder, once per session."
assert_contains "block names the silent targets"       "$OV_ID_BLOCK" "Plans and scratch roots draw none."
assert_missing  "block no longer says Write is denied" "$OV_ID_BLOCK" "denied \`Write\`"
assert_contains "block names the gate's silencer"      "$OV_ID_BLOCK" "/workbench-core:orchestrator off"
# Every gate the block names must be a hook this plugin ships AND registers. The
# list is read from the block, so a renamed or retired hook turns the row red
# instead of leaving the block telling every sub-agent about a gate that is gone.
GATE_ROWS=$(printf '%s\n' "$OV_ID_BLOCK" | sed -nE 's/^\| ([A-Z][a-z]* [a-z ]*(gate|guard)) \|.*/\1/p')
if [ "$(printf '%s\n' "$GATE_ROWS" | grep -c .)" -lt 5 ]; then
  FAIL=$((FAIL + 1)); echo "  ❌ block names fewer than five gates: $(printf '%s' "$GATE_ROWS" | tr '\n' ',')"
fi
while IFS= read -r gate; do
  [ -n "$gate" ] || continue
  hook="$(printf '%s' "$gate" | tr '[:upper:] ' '[:lower:]-').sh"
  registered=$(jq -r --arg h "$hook" '[.hooks.PreToolUse[].hooks[]
    | select(.command | endswith("/" + $h + "\""))] | length' "$REPO_ROOT/hooks/hooks.json" 2>/dev/null)
  if [ -f "$REPO_ROOT/hooks/$hook" ] && [ "${registered:-0}" -ge 1 ]; then
    PASS=$((PASS + 1)); echo "  ✅ $gate is shipped and registered ($hook)"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ block names $gate, but $hook is not shipped and registered"
  fi
done <<< "$GATE_ROWS"

echo "the destructive scope guard and its roots ride in the managed block:"
# This block is the ONLY channel that reaches a sub-agent. A freshly spawned one
# starts with ~/.claude/CLAUDE.md in context and without this hook's stdout, so
# the stdout copy reaches the main session and nothing else. The block names the
# guard and the scratch roots. How to satisfy the guard is the deny's job: its
# reason text names the unreadable shapes and the way through.
assert_contains "block names the destructive scope guard" "$OV_ID_BLOCK" \
  "| Destructive scope guard |"

# Pin the instruction against the layer that ENFORCES it, not against a second
# copy of itself. The block promises these commands run unprompted inside scope,
# and only hooks/destructive-scope-guard.sh makes that true — retire the guard
# and the promise becomes a lie the machine now tells every sub-agent at
# startup. Registration is checked as well as the file, because an unregistered
# guard is a file that runs never.
if [ -f "$REPO_ROOT/hooks/destructive-scope-guard.sh" ]; then
  PASS=$((PASS + 1)); echo "  ✅ the guard the block promises is shipped"
else
  FAIL=$((FAIL + 1)); echo "  ❌ block promises a guard this plugin does not ship"
fi
GUARD_HOOKS=$(jq -r '[.hooks.PreToolUse[].hooks[]
  | select(.command | test("destructive-scope-guard.sh"))] | length' \
  "$REPO_ROOT/hooks/hooks.json" 2>/dev/null)
if [ "$GUARD_HOOKS" = "1" ]; then
  PASS=$((PASS + 1)); echo "  ✅ the guard is registered, so the promise holds"
else
  FAIL=$((FAIL + 1)); echo "  ❌ the guard the block promises is not registered once"
fi

# The hook carries the rule TWICE — this block for sub-agents, and its own
# stdout for the main session. Pin them against EACH OTHER on a string DERIVED
# from one of them rather than on a third literal: two independently written
# copies let an edit update one and leave the other stating the old roots, which
# puts an agent back to a hard deny while the suite stays green.
#
# A fresh capture, not the $OUT already in scope: the last assignment to it
# above is the agent-dispatch run, whose entire stdout is deliberately empty.
#
# That emptiness speaks for one population only. A headless `claude -p --agent`
# run — Watson under cron — misses the stdout because the warmup exits at the
# CLAUDE_CODE_AGENT guard. An in-process Agent-tool sub-agent leaves that
# variable UNSET (measured) and misses the stdout for an unrelated reason:
# SessionStart never fires on sub-agent spawn, so the hook does not run at all.
# The second population is the one that hit the original bug. Neither reads
# stdout and both load ~/.claude/CLAUDE.md, which is why the rule lives in the
# managed block and why stdout is pinned beside it rather than instead of it.
SCRATCH_STDOUT=$(run_warmup startup)
assert_contains "stdout copy heads its own section" "$SCRATCH_STDOUT" \
  "## Destructive commands"
# The root list, lifted out of the stdout copy and required of the block. An
# empty extraction is a sentinel rather than an empty needle, because `grep -F
# ""` matches everything and would go green on exactly the drift this catches.
SCRATCH_ROOTS=$(printf '%s\n' "$SCRATCH_STDOUT" \
  | sed -n 's/.*\(the session scratchpad[^.]*sandbox\).*/\1/p' | head -1)
[ -n "$SCRATCH_ROOTS" ] || SCRATCH_ROOTS="<the stdout copy names no scratchpad roots>"
assert_contains "both copies name the same scratchpad roots" \
  "$OV_ID_BLOCK" "$SCRATCH_ROOTS"
# Agents made probe roots by hand under /tmp, which is no root, and then handed
# the cleanup to the user. Both copies have to steer new scratch into the
# scratchpads, or one of them goes on teaching the old habit.
SCRATCH_WHERE="Never create it anywhere under \`/tmp\` outside your session scratchpad."
assert_contains "stdout copy says where new scratch goes" \
  "$SCRATCH_STDOUT" "$SCRATCH_WHERE"
assert_contains "block says where new scratch goes" \
  "$OV_ID_BLOCK" "$SCRATCH_WHERE"
# The refusal once routed an agent's own scratch cleanup to the human as a
# `! rm -rf`. The stdout copy says that is not the route. The block leaves it to
# the guard's deny, which carries the same sentence as its recovery text.
assert_contains "stdout copy keeps scratch cleanup off the user" \
  "$SCRATCH_STDOUT" "Never hand the user a \`!\` command to delete your own scratch."

echo "retired system-overrides.md — a rule-free stub while the alias still names it:"
# The user's shell alias passes this file to `claude --append-system-prompt-file`,
# and the CLI refuses to start when the file is missing (measured: "Append
# system prompt file not found", exit 1). So the warmup never deletes it. It
# rewrites an existing file to a stub that carries no rule, and it never creates
# one, so the user can finish the retirement by hand.
RT_HOME="$SANDBOX/retire-home"
mkdir -p "$RT_HOME/.claude"
printf '# Agent identity\n\n1. **Lead with the answer.**\n' > "$RT_HOME/.claude/system-overrides.md"
run_retire() {
  printf '{"source":"%s"}' "$1" | \
    HOME="$RT_HOME" WORKBENCH_MEMORY_PATH="$SANDBOX/memory" \
    WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" WORKBENCH_MEMORY_PORT="$PROBE_PORT" \
    CLAUDE_PLUGIN_ROOT="$REPO_ROOT" bash "$WARMUP" >/dev/null 2>&1
}
RT_NOTICES="$RT_HOME/.claude-workbench/warmup-notices.md"
# compact is not startup: the file is left as it was until a real start.
run_retire compact
assert_contains "compact leaves the file alone" \
  "$(cat "$RT_HOME/.claude/system-overrides.md")" "Lead with the answer."
run_retire startup
RT_TEXT="$(cat "$RT_HOME/.claude/system-overrides.md" 2>/dev/null)"
if [ -s "$RT_HOME/.claude/system-overrides.md" ]; then
  PASS=$((PASS + 1)); echo "  ✅ startup keeps the file, non-empty, so the alias still starts"
else
  FAIL=$((FAIL + 1)); echo "  ❌ startup removed or emptied the file the alias names"
fi
assert_missing  "the old rules are gone from it"   "$RT_TEXT" "Lead with the answer."
assert_contains "the stub says why it exists"      "$RT_TEXT" "--append-system-prompt-file"
if [ "$(printf '%s\n' "$RT_TEXT" | grep -c .)" -eq 1 ]; then
  PASS=$((PASS + 1)); echo "  ✅ the stub is one line"
else
  FAIL=$((FAIL + 1)); echo "  ❌ the stub grew past one line"
fi
# Tell the user to finish it, alias first. Deleting the file first is the order
# that stops the CLI from starting, so the order is pinned.
assert_contains "a notice asks the user to finish the retirement" \
  "$(cat "$RT_NOTICES" 2>/dev/null)" "Retired system-overrides file"
assert_contains "the notice puts the alias before the file" \
  "$(cat "$RT_NOTICES" 2>/dev/null)" "Remove any such alias from your shell profile, open a new shell, then delete the file."
# Once the user deletes it, it stays deleted and the notice stops.
rm "$RT_HOME/.claude/system-overrides.md"
run_retire startup
if [ ! -e "$RT_HOME/.claude/system-overrides.md" ]; then
  PASS=$((PASS + 1)); echo "  ✅ a deleted file is not recreated"
else
  FAIL=$((FAIL + 1)); echo "  ❌ the warmup recreated a file the user deleted"
fi
assert_missing "the notice stops once the file is gone" \
  "$(cat "$RT_NOTICES" 2>/dev/null)" "Retired system-overrides file"

echo "an empty identity folder changes nothing:"
mkdir -p "$SANDBOX/aside"
mv "$SANDBOX/memory/identity" "$SANDBOX/aside/identity"
OUT=$(run_warmup startup)
assert_missing  "no not-found notice"                  "$OUT" "not found"
assert_contains "the rest of startup still runs"       "$OUT" "## Memory routing"
mv "$SANDBOX/aside/identity" "$SANDBOX/memory/identity"

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
# The marker keeps a live transcript, or the dead-marker sweep would delete it
# before the notice could count it.
: > "$SANDBOX/cache-canary.jsonl"
printf '{"session_id":"cache-canary","log_path":"/nonexistent/cache-canary.log.md","transcript_path":"%s"}\n' \
  "$SANDBOX/cache-canary.jsonl" > "$SANDBOX/cache/pending-summaries/cache-canary.json"
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
mkdir -p "$SANDBOX/cache/pending-summaries" "$SANDBOX/listing-transcripts"
# Each marker keeps a live transcript, so the dead-marker sweep leaves it alone
# and the listing below has five markers to count.
for i in 1 2 3 4 5; do
  : > "$SANDBOX/listing-transcripts/sid-$i.jsonl"
  printf '{"session_id":"sid-%s","log_path":"/nonexistent/sid-%s.log.md","transcript_path":"%s"}\n' \
    "$i" "$i" "$SANDBOX/listing-transcripts/sid-$i.jsonl" \
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
assert_contains "the header names the compact source" "$OUT" "session warmup (compact)"
assert_missing  "no pending block on PostCompact"     "$(notices)" "Pending session summaries"
rm -f "$SANDBOX/cache/pending-summaries"/sid-*.json

# ──────────── Pending-summary drain ────────────
# session-log.sh no longer spawns a writer at SessionEnd (the child is killed
# during teardown — 968 stranded markers). This drain is the other half of that
# fix, so these assertions are the ones that prove those sessions still get
# summarized. WORKBENCH_DISPATCH_DRY_RUN makes the shared spawn helper print its
# resolved invocation instead of launching claude.
mkdir -p "$SANDBOX/bin"
printf '#!/bin/sh\nexit 0\n' > "$SANDBOX/bin/claude"
chmod +x "$SANDBOX/bin/claude"
DRAIN_LOGDIR="$SANDBOX/memory/sessions/2026-02-02"
DRAIN_TRANSCRIPTDIR="$SANDBOX/transcripts"

# Create marker $1 with mtime $2 (touch -t stamp). $3 selects which of the
# marker's two sources exist on disk — the marker always names both, exactly as
# session-log.sh writes it:
#   log        (default) log only, transcript already past its ~30-day retention
#   both       log and transcript present
#   nolog      log pruned at 7 days, transcript still readable — RECOVERABLE
#   nosource   both gone — the dead-marker sweep deletes it before the drain
make_marker() {
  local sid="$1" stamp="$2" mode="${3:-log}"
  local logpath="$DRAIN_LOGDIR/$sid.log.md"
  local transcript="$DRAIN_TRANSCRIPTDIR/$sid.jsonl"
  mkdir -p "$DRAIN_LOGDIR" "$DRAIN_TRANSCRIPTDIR" "$SANDBOX/cache/pending-summaries"
  case "$mode" in
    log|both) printf '# log for %s\n' "$sid" > "$logpath" ;;
  esac
  case "$mode" in
    both|nolog) printf '{"type":"user","sessionId":"%s"}\n' "$sid" > "$transcript" ;;
  esac
  printf '{"session_id":"%s","transcript_path":"%s","log_path":"%s","mode":"final","event":"SessionEnd"}\n' \
    "$sid" "$transcript" "$logpath" > "$SANDBOX/cache/pending-summaries/$sid.json"
  touch -t "$stamp" "$SANDBOX/cache/pending-summaries/$sid.json"
}

reset_drain() {
  rm -f "$SANDBOX/cache/pending-summaries"/*.json 2>/dev/null
  rm -rf "$DRAIN_LOGDIR" "$DRAIN_TRANSCRIPTDIR" "$SANDBOX/cache/summary-drain.lock" 2>/dev/null
  rm -f "$SANDBOX/cache/summary-drain.stamp" "$SANDBOX/cache/summary-dispatch-errors.log" 2>/dev/null
}

# $1: source, $2: extra env assignments
run_drain() {
  local source="$1" extra="${2:-}"
  printf '{"source":"%s"}' "$source" | \
    env HOME="$SANDBOX/home" \
      PATH="$SANDBOX/bin:$PATH" \
      WORKBENCH_MEMORY_PATH="$SANDBOX/memory" \
      WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" \
      CLAUDE_PLUGIN_ROOT="$REPO_ROOT" \
      WORKBENCH_DISPATCH_DRY_RUN=1 \
      WORKBENCH_AUTO_SUMMARIZE=1 \
      $extra \
      bash "$WARMUP" 2>/dev/null
}

echo "drain — spawns writers at startup, oldest first, bounded by batch:"
reset_drain
make_marker "drain-old"  "202601010000"
make_marker "drain-mid"  "202601020000"
make_marker "drain-new"  "202601030000"
OUT=$(run_drain startup "WORKBENCH_DRAIN_BATCH=2")
assert_contains "oldest marker dispatched"        "$OUT" "DISPATCH sid=drain-old"
assert_contains "second-oldest dispatched"        "$OUT" "DISPATCH sid=drain-mid"
assert_missing  "batch bound stops at 2"          "$OUT" "DISPATCH sid=drain-new"

echo "drain — batch of 1 takes the OLDEST, not the newest:"
# Oldest-first matters: the startup retention sweep refuses to delete any raw log
# that still has a marker, so newest-first would pin the oldest logs forever.
reset_drain
make_marker "pin-old" "202601010000"
make_marker "pin-new" "202601050000"
OUT=$(run_drain startup "WORKBENCH_DRAIN_BATCH=1")
assert_contains "oldest chosen"                   "$OUT" "DISPATCH sid=pin-old"
assert_missing  "newest skipped"                  "$OUT" "DISPATCH sid=pin-new"

echo "drain — runs on resume, not on clear or compact:"
reset_drain
make_marker "src-probe" "202601010000"
OUT=$(run_drain resume "WORKBENCH_DRAIN_BATCH=1")
assert_contains "resume drains"                   "$OUT" "DISPATCH sid=src-probe"
reset_drain
make_marker "src-probe" "202601010000"
OUT=$(run_drain clear "WORKBENCH_DRAIN_BATCH=1")
assert_missing  "clear does not drain"            "$OUT" "DISPATCH sid=src-probe"
reset_drain
make_marker "src-probe" "202601010000"
OUT=$(run_drain compact "WORKBENCH_DRAIN_BATCH=1")
assert_missing  "compact does not drain"          "$OUT" "DISPATCH sid=src-probe"

echo "drain — cooldown suppresses a second start inside the window:"
reset_drain
make_marker "cool-1" "202601010000"
make_marker "cool-2" "202601020000"
OUT=$(run_drain startup "WORKBENCH_DRAIN_BATCH=1")
assert_contains "first start drains"              "$OUT" "DISPATCH sid=cool-1"
OUT=$(run_drain startup "WORKBENCH_DRAIN_BATCH=1")
assert_missing  "second start inside cooldown is suppressed" "$OUT" "DISPATCH sid="
# ...and lifting the cooldown lets it through again, proving the suppression was
# the cooldown and not some unrelated failure to dispatch.
OUT=$(run_drain startup "WORKBENCH_DRAIN_BATCH=1 WORKBENCH_DRAIN_COOLDOWN_MIN=0")
assert_contains "cooldown of 0 drains again"      "$OUT" "DISPATCH sid=cool-1"

echo "drain — a pruned log with a live transcript is DRAINED, not rejected:"
# The log is a 7-day vault cache; the transcript is the ~30-day original, and
# agents/summary-writer.md step 2 tells the writer to fall back to it. Gating on
# the log alone made this drain stricter than the agent it gates: on 2026-09-18
# it rejected 778 of 779 markers, 503 with a readable transcript still on disk.
reset_drain
make_marker "cache-expired" "202601010000" nolog
OUT=$(run_drain startup "WORKBENCH_DRAIN_BATCH=1")
assert_contains "marker with only a transcript is dispatched" "$OUT" "DISPATCH sid=cache-expired"
assert_contains "the writer is handed the transcript"         "$OUT" "DISPATCH transcript=$DRAIN_TRANSCRIPTDIR/cache-expired.jsonl"
assert_missing  "and is not written off as undrainable"       \
  "$(cat "$SANDBOX/cache/summary-dispatch-errors.log" 2>/dev/null)" "cache-expired"

echo "drain — both sources present still dispatches, and names both:"
reset_drain
make_marker "both-live" "202601010000" both
OUT=$(run_drain startup "WORKBENCH_DRAIN_BATCH=1")
assert_contains "dispatched"          "$OUT" "DISPATCH sid=both-live"
assert_contains "log path passed"     "$OUT" "DISPATCH log=$DRAIN_LOGDIR/both-live.log.md"
assert_contains "transcript passed"   "$OUT" "DISPATCH transcript=$DRAIN_TRANSCRIPTDIR/both-live.jsonl"

echo "drain — only a marker with BOTH sources gone is swept, never drained:"
reset_drain
make_marker "all-gone" "202601010000" nosource
make_marker "good-1"   "202601020000"
make_marker "good-2"   "202601030000"
OUT=$(run_drain startup "WORKBENCH_DRAIN_BATCH=2")
assert_missing  "marker with no log and no transcript not dispatched" "$OUT" "DISPATCH sid=all-gone"
assert_contains "slot passed to next marker"        "$OUT" "DISPATCH sid=good-1"
assert_contains "second slot still available"       "$OUT" "DISPATCH sid=good-2"
# The dead-marker sweep runs before the drain and deletes this marker, so the
# drain never sees it again. Before the sweep, the drain logged it as
# undrainable on every start, forever.
assert_no_path "the both-sources-gone marker is deleted" \
  "$SANDBOX/cache/pending-summaries/all-gone.json"
if grep -q "purged-dead-marker marker=.*all-gone.json reason=no-source" \
     "$SANDBOX/cache/summary-dispatch-errors.log" 2>/dev/null; then
  PASS=$((PASS + 1)); echo "  ✅ the purge is recorded in the dispatch log"
else
  FAIL=$((FAIL + 1)); echo "  ❌ the purge is not recorded in the dispatch log"
fi
assert_missing "and it is no longer re-logged as undrainable" \
  "$(cat "$SANDBOX/cache/summary-dispatch-errors.log" 2>/dev/null)" "undrainable marker=$SANDBOX/cache/pending-summaries/all-gone.json"

echo "drain — a marker with no session id is undrainable whatever its sources:"
reset_drain
# Both sources on disk, so only the empty session id can reject this one.
make_marker "sidless" "202601010000" both
printf '{"log_path":"%s","transcript_path":"%s"}\n' \
  "$DRAIN_LOGDIR/sidless.log.md" "$DRAIN_TRANSCRIPTDIR/sidless.jsonl" \
  > "$SANDBOX/cache/pending-summaries/sidless.json"
touch -t "202601010000" "$SANDBOX/cache/pending-summaries/sidless.json"
make_marker "after-sidless" "202601020000"
OUT=$(run_drain startup "WORKBENCH_DRAIN_BATCH=1")
assert_contains "slot passed to the next marker" "$OUT" "DISPATCH sid=after-sidless"
if [ "$(printf '%s' "$OUT" | grep -c '^DISPATCH sid=')" = "1" ]; then
  PASS=$((PASS + 1)); echo "  ✅ the sidless marker spawned nothing"
else
  FAIL=$((FAIL + 1)); echo "  ❌ the sidless marker spawned a writer"
fi
if grep -q "undrainable marker=.*sidless.*sid=?" "$SANDBOX/cache/summary-dispatch-errors.log" 2>/dev/null; then
  PASS=$((PASS + 1)); echo "  ✅ the sidless marker is recorded as undrainable"
else
  FAIL=$((FAIL + 1)); echo "  ❌ the sidless marker is not recorded as undrainable"
fi

echo "drain — the writer's brief carries both pointers and the fallback rule:"
# The dry-run print is a test affordance; the prompt is what the child actually
# reads. Assert on the prompt itself so a regression in one cannot hide in the
# other.
BRIEF=$(env MEMORY_PATH="$SANDBOX/memory" bash -c '
  . "$0" 2>/dev/null
  summary_dispatch_prompt sid-x /marker.json /vault/sid-x.log.md /projects/sid-x.jsonl' \
  "$REPO_ROOT/hooks/lib/summary-dispatch.sh")
assert_contains "brief carries session_id"      "$BRIEF" "session_id: sid-x"
assert_contains "brief carries marker_path"     "$BRIEF" "marker_path: /marker.json"
assert_contains "brief carries log_path"        "$BRIEF" "log_path: /vault/sid-x.log.md"
assert_contains "brief carries transcript_path" "$BRIEF" "transcript_path: /projects/sid-x.jsonl"
assert_contains "brief states the fallback"     "$BRIEF" "summarize from transcript_path"
assert_contains "brief asks for the source stamp" "$BRIEF" "source: transcript"

echo "drain — disabled and zero-batch paths spawn nothing:"
reset_drain
make_marker "off-probe" "202601010000"
OUT=$(printf '{"source":"startup"}' | \
  env HOME="$SANDBOX/home" PATH="$SANDBOX/bin:$PATH" \
    WORKBENCH_MEMORY_PATH="$SANDBOX/memory" WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" \
    CLAUDE_PLUGIN_ROOT="$REPO_ROOT" WORKBENCH_DISPATCH_DRY_RUN=1 \
    WORKBENCH_AUTO_SUMMARIZE=0 bash "$WARMUP" 2>/dev/null)
assert_missing "auto-summarize off drains nothing" "$OUT" "DISPATCH sid="
reset_drain
make_marker "zero-probe" "202601010000"
OUT=$(run_drain startup "WORKBENCH_DRAIN_BATCH=0")
assert_missing "batch of 0 drains nothing"         "$OUT" "DISPATCH sid="

echo "drain — a held lock blocks a concurrent start:"
reset_drain
make_marker "lock-probe" "202601010000"
mkdir -p "$SANDBOX/cache/summary-drain.lock"
OUT=$(run_drain startup "WORKBENCH_DRAIN_BATCH=1")
assert_missing "fresh lock suppresses the drain"   "$OUT" "DISPATCH sid=lock-probe"
# A lock older than a minute is debris from a session that died mid-drain and
# must be broken, or the drain wedges permanently.
touch -t "202601010000" "$SANDBOX/cache/summary-drain.lock"
OUT=$(run_drain startup "WORKBENCH_DRAIN_BATCH=1")
assert_contains "stale lock is broken"             "$OUT" "DISPATCH sid=lock-probe"
reset_drain

echo "a config that still carries identity_files is ignored:"
# setup no longer writes identity_files, and the warmup no longer reads it. A
# config written before the retirement may still hold the keys, pointing at a
# file that exists or at a typo. Neither may produce a heading or a warning:
# either one would tell the agent about a persona layer that is gone.
OLD_MEM="$SANDBOX/old-config-memory"
OLD_HOME="$SANDBOX/old-config-home"
OLD_CFG_DIR="$OLD_HOME/.claude/plugins/data/workbench-core-claude-workbench"
mkdir -p "$OLD_MEM/identity" "$OLD_CFG_DIR"
printf 'SOULLESS-CANARY legacy soul\n' > "$OLD_MEM/identity/soul-hot.md"
printf '{"memory_path":"%s","identity_files":{"soul_hot":"identity/soul-hot.md","profile":"identity/typo-profile.md"}}\n' \
  "$OLD_MEM" > "$OLD_CFG_DIR/config.json"
run_old_warmup() {
  printf '{"source":"startup"}' | \
    HOME="$OLD_HOME" WORKBENCH_MEMORY_PATH="$OLD_MEM" \
    WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" \
    WORKBENCH_MEMORY_PORT="$PROBE_PORT" \
    CLAUDE_PLUGIN_ROOT="$REPO_ROOT" bash "$WARMUP" 2>/dev/null
}
OUT=$(run_old_warmup)
assert_missing  "a configured soul file is not injected" "$OUT" "SOULLESS-CANARY"
assert_missing  "a configured typo draws no warning"     "$OUT" "not found"
assert_contains "the rest of the warmup still runs"      "$OUT" "## Memory routing"

# The rules block must be byte-identical across runs for identical config:
# prompt caching matches an exact request prefix, so one drifting byte here
# invalidates the cache for everything after it.
A=$(run_old_warmup); B=$(run_old_warmup)
if [ "$A" = "$B" ]; then
  PASS=$((PASS + 1)); echo "  ✅ identical config produces identical bytes"
else
  FAIL=$((FAIL + 1)); echo "  ❌ warmup output drifted between two identical runs"
fi

echo "output-style drift — a stale live style is reported, never rewritten:"
# The live copy once ran 8 days behind the shipped one, still telling the model
# to run an options round before a push. The warmup re-syncs other live files,
# but not this one, so the notice is the only thing that makes the lag visible.
STYLES_DIR="$SANDBOX/home/.claude/output-styles"
SHIPPED_DIRS=("$REPO_ROOT"/assets/personas/*/)
SHIPPED_DIR="${SHIPPED_DIRS[0]%/}"
LIVE_STYLE="$STYLES_DIR/${SHIPPED_DIR##*/}.md"
rm -rf "$STYLES_DIR"
run_warmup startup >/dev/null
assert_missing "no live style: no notice (the persona is opt-in)" "$(notices)" "Output style out of date"
mkdir -p "$STYLES_DIR"
cp "$SHIPPED_DIR/output-style.md" "$LIVE_STYLE"
run_warmup startup >/dev/null
assert_missing "a current live style: no notice" "$(notices)" "Output style out of date"
printf 'Run an options round before every push.\n' >> "$LIVE_STYLE"
STALE_BEFORE=$(cat "$LIVE_STYLE")
OUT_STYLE=$(run_warmup startup)
assert_contains "a stale live style: the notice appears" "$(notices)" "Output style out of date"
assert_contains "the notice names the live file" "$(notices)" "$LIVE_STYLE"
assert_contains "the notice points at setup" "$(notices)" "/workbench-core:setup"
assert_missing "the notice stays out of the cached payload" "$OUT_STYLE" "Output style out of date"
run_warmup resume >/dev/null
assert_contains "a resumed session reports it too" "$(notices)" "Output style out of date"
if [ "$(cat "$LIVE_STYLE")" = "$STALE_BEFORE" ]; then
  PASS=$((PASS + 1)); echo "  ✅ the warmup leaves the live style untouched"
else
  FAIL=$((FAIL + 1)); echo "  ❌ the warmup rewrote the live style"
fi
rm -rf "$STYLES_DIR"

echo "the persona installs through setup, the one entry point:"
SETUP_SKILL="$REPO_ROOT/skills/setup/SKILL.md"
assert_contains "setup previews the persona install" "$(cat "$SETUP_SKILL")" \
  'bash "${CLAUDE_PLUGIN_ROOT}/scripts/install.sh" --dry-run'
assert_contains "setup applies it" "$(cat "$SETUP_SKILL")" \
  'bash "${CLAUDE_PLUGIN_ROOT}/scripts/install.sh"'
# The warmup notice promises that setup shows the diff before it writes, so the
# dry run has to print one for a stale live style, and must write nothing.
mkdir -p "$STYLES_DIR"
cp "$SHIPPED_DIR/output-style.md" "$LIVE_STYLE"
printf 'STALE-STYLE-CANARY\n' >> "$LIVE_STYLE"
DRY=$(WORKBENCH_OUTPUT_STYLES_DIR="$STYLES_DIR" \
      WORKBENCH_SETTINGS_FILE="$SANDBOX/home/.claude/settings.json" \
      WORKBENCH_MEMORY_PATH="$SANDBOX/memory" HOME="$SANDBOX/home" \
      CLAUDE_PLUGIN_ROOT="$REPO_ROOT" bash "$REPO_ROOT/scripts/install.sh" --dry-run 2>&1)
assert_contains "the dry run shows the stale line it would remove" "$DRY" "-STALE-STYLE-CANARY"
assert_contains "the live style is still the stale one" "$(cat "$LIVE_STYLE")" "STALE-STYLE-CANARY"
rm -rf "$STYLES_DIR"
if [ ! -e "$REPO_ROOT/skills/install" ]; then
  PASS=$((PASS + 1)); echo "  ✅ no second install command"
else
  FAIL=$((FAIL + 1)); echo "  ❌ skills/install still ships beside setup"
fi

echo "exit code is always 0:"
if printf '{"source":"compact"}' | HOME="$SANDBOX/home" WORKBENCH_MEMORY_PATH="$SANDBOX/memory" WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" CLAUDE_PLUGIN_ROOT="$REPO_ROOT" bash "$WARMUP" >/dev/null 2>&1; then
  PASS=$((PASS + 1)); echo "  ✅ compact exits 0"
else
  FAIL=$((FAIL + 1)); echo "  ❌ compact exited non-zero"
fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
