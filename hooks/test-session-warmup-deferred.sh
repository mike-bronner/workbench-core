#!/bin/bash
# Tests for session-warmup.sh's two parts. Run directly:
#   ./test-session-warmup-deferred.sh
# The SessionStart hook runs `session-warmup.sh --defer`, which leaves out the
# pending-summary drain and the Chat-skill scan, so they no longer hold up the
# session start. hooks/register.ts then runs `session-warmup.sh --deferred` for
# those two (tests/deferred-start.test.ts). With no argument the script still
# does the whole warmup in one run, which test-session-warmup.sh covers.

set -u
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
WARMUP="$HOOKS_DIR/session-warmup.sh"
REPO_ROOT="$(cd "$HOOKS_DIR/.." && pwd)"
PASS=0
FAIL=0

# A runner inside Claude Code may export these. Set, they would point the
# reconciler at the developer's real transcripts, or skip the warmup outright.
unset CLAUDE_CODE_AGENT CLAUDE_CONFIG_DIR WORKBENCH_SKIP_WARMUP

SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

ok() { PASS=$((PASS + 1)); echo "  ✅ $1"; }
no() { FAIL=$((FAIL + 1)); echo "  ❌ $1"; }
assert_contains() { if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else no "$1 — expected to find: $3"; fi; }
assert_missing() { if printf '%s' "$2" | grep -qF -- "$3"; then no "$1 — expected NOT to find: $3"; else ok "$1"; fi; }

# A free port, so the memory probe never reaches a real server on 8765.
port_is_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
PROBE_PORT=""
_candidate=$(( 20000 + (RANDOM % 20000) ))
for _ in $(seq 1 500); do
  if port_is_free "$_candidate"; then PROBE_PORT="$_candidate"; break; fi
  _candidate=$((_candidate + 1))
done
[ -n "$PROBE_PORT" ] || { echo "FATAL: no free TCP port found for the probe" >&2; exit 1; }

HOME_DIR="$SANDBOX/home"
# An empty live-session registry: no session is live. The drain skips live
# sessions, and when it cannot read the registry it also holds back markers
# written in the last 30 minutes, which every marker here is.
mkdir -p "$HOME_DIR/.claude/sessions"
NOTICES_FILE="$HOME_DIR/.claude-workbench/warmup-notices.md"
MARKERS="$SANDBOX/cache/pending-summaries"
LOGDIR="$SANDBOX/memory/sessions/2026-02-02"
STARTED="$SANDBOX/cache/warmup-deferred.started"
DONE="$SANDBOX/cache/warmup-deferred.done"
STAMP="$SANDBOX/cache/summary-drain.stamp"
mkdir -p "$HOME_DIR/.claude/plugins" "$SANDBOX/memory" "$SANDBOX/bin"
printf '#!/bin/sh\nexit 0\n' > "$SANDBOX/bin/claude"
chmod +x "$SANDBOX/bin/claude"

# One workbench plugin with two Chat-installable skills, none installed yet.
PLUGIN="$SANDBOX/plugins/workbench-x/1.0.0"
for skill in alpha beta; do
  mkdir -p "$PLUGIN/skills/$skill"
  printf -- '---\nname: %s\ndescription: d\n---\n' "$skill" > "$PLUGIN/skills/$skill/SKILL.md"
done
printf '{"plugins":{"workbench-x@claude-workbench":[{"installPath":"%s","version":"1.0.0"}]}}\n' \
  "$PLUGIN" > "$HOME_DIR/.claude/plugins/installed_plugins.json"

# Three drainable markers, oldest first: old, mid, new.
reset() {
  rm -rf "$MARKERS" "$LOGDIR" "$SANDBOX/cache/summary-drain.lock" "$HOME_DIR/.claude-workbench"
  rm -f "$SANDBOX/cache/summary-drain.stamp" "$STARTED" "$DONE"
  mkdir -p "$MARKERS" "$LOGDIR"
  local stamp=202601010000 sid
  for sid in old mid new; do
    printf '# log\n' > "$LOGDIR/$sid.log.md"
    printf '{"session_id":"%s","transcript_path":"%s/none.jsonl","log_path":"%s/%s.log.md"}\n' \
      "$sid" "$SANDBOX" "$LOGDIR" "$sid" > "$MARKERS/$sid.json"
    touch -t "$stamp" "$MARKERS/$sid.json"
    stamp=$((stamp + 10000))
  done
}

# $1: source, $2: the warmup's argument (may be empty), $3: extra env.
run() {
  local source="$1" arg="${2:-}" extra="${3:-}"
  # shellcheck disable=SC2086
  printf '{"source":"%s","session_id":"current"}' "$source" | \
    env HOME="$HOME_DIR" PATH="$SANDBOX/bin:$PATH" \
      WORKBENCH_MEMORY_PATH="$SANDBOX/memory" WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" \
      WORKBENCH_MEMORY_PORT="$PROBE_PORT" CLAUDE_PLUGIN_ROOT="$REPO_ROOT" \
      WORKBENCH_DISPATCH_DRY_RUN=1 WORKBENCH_AUTO_SUMMARIZE=1 WORKBENCH_DRAIN_COOLDOWN_MIN=0 \
      $extra \
      bash "$WARMUP" $arg 2>/dev/null
}

notices() { cat "$NOTICES_FILE" 2>/dev/null; }

echo "--defer, the SessionStart hook's part, leaves out the drain and the Chat-skill scan:"
reset
OUT=$(run startup --defer)
assert_missing  "no writer is dispatched"                 "$OUT" "DISPATCH sid="
assert_missing  "no part prints the rules (system prompt)" "$OUT" "Memory routing"
assert_contains "the pending notice is still written"     "$(notices)" "Pending session summaries (3)"
assert_missing  "no Chat-skill notice"                    "$(notices)" "New Chat-installable skills"
DEFER_NOTICES=$(notices)

echo "--deferred, the module's part, runs only the drain and the Chat-skill scan:"
OUT=$(run startup --deferred)
assert_contains "the oldest marker is dispatched"         "$OUT" "DISPATCH sid=old"
assert_contains "the batch goes on in age order"          "$OUT" "DISPATCH sid=new"
assert_missing  "no rules are printed"                    "$OUT" "Memory routing"
assert_missing  "no warmup header is printed"             "$OUT" "session warmup"
assert_contains "the Chat-skill notice is added"          "$(notices)" "New Chat-installable skills"
assert_contains "it names each skill"                     "$(notices)" '`beta` (from `workbench-x`)'
assert_contains "the --defer run's notices are kept"      "$(notices)" "Pending session summaries (3)"
AFTER=$(notices)
if [ "${AFTER#"$DEFER_NOTICES"}" != "$AFTER" ] \
   && [ $(( $(printf '%s\n' "$AFTER" | grep -c '^## ') - $(printf '%s\n' "$DEFER_NOTICES" | grep -c '^## ') )) = 1 ]; then
  ok "it adds one notice after the others, and rewrites none"
else
  no "it adds one notice after the others, and rewrites none"
fi

echo "the two parts together do what one whole run does:"
reset
WHOLE=$(run startup)
WHOLE_DISPATCH=$(printf '%s\n' "$WHOLE" | grep '^DISPATCH sid=')
WHOLE_NOTICES=$(notices | grep '^## ')
reset
run startup --defer >/dev/null
SPLIT_DISPATCH=$(run startup --deferred | grep '^DISPATCH sid=')
[ -n "$WHOLE_DISPATCH" ] && [ "$WHOLE_DISPATCH" = "$SPLIT_DISPATCH" ] \
  && ok "the same writers, in the same order" || no "the same writers, in the same order"
[ "$WHOLE_NOTICES" = "$(notices | grep '^## ')" ] \
  && ok "the same notices" || no "the same notices — whole: $WHOLE_NOTICES / split: $(notices | grep '^## ')"
assert_contains "a whole run still scans for Chat skills" "$WHOLE_NOTICES" "New Chat-installable skills"

echo "--deferred takes the place of \"No outstanding notices.\":"
reset
mkdir -p "$(dirname "$NOTICES_FILE")"
printf '# Warmup notices\n\n_Written by session-warmup.sh at startup session start. Rewritten every run._\n\nNo outstanding notices.\n' > "$NOTICES_FILE"
run startup --deferred >/dev/null
assert_missing  "the empty line goes"                     "$(notices)" "No outstanding notices."
assert_contains "the header stays"                        "$(notices)" "# Warmup notices"
assert_contains "the Chat-skill notice is there"          "$(notices)" "New Chat-installable skills"

echo "--deferred with no notices file writes one:"
reset
run startup --deferred >/dev/null
assert_contains "a header"                                "$(notices)" "# Warmup notices"
assert_contains "and the Chat-skill notice"               "$(notices)" "New Chat-installable skills"

echo "--deferred with nothing new for Chat leaves the notices file alone:"
reset
mkdir -p "$(dirname "$NOTICES_FILE")"
printf 'NOTICES-CANARY\n' > "$NOTICES_FILE"
# The scan's fast path: a state file newer than the plugin registry.
printf '{"installed":[]}\n' > "$HOME_DIR/.claude-workbench/chat-skills-state.json"
touch -t 202001010000 "$HOME_DIR/.claude/plugins/installed_plugins.json"
BEFORE_SUM=$(cksum < "$NOTICES_FILE")
run startup --deferred >/dev/null
[ "$(cksum < "$NOTICES_FILE")" = "$BEFORE_SUM" ] && ok "byte-identical" || no "byte-identical — got: $(notices)"
touch "$HOME_DIR/.claude/plugins/installed_plugins.json"

echo "--deferred on resume drains, and scans for Chat skills only at startup, as before:"
reset
OUT=$(run resume --deferred)
assert_contains "resume drains"                           "$OUT" "DISPATCH sid=old"
assert_missing  "no Chat-skill notice on resume"          "$(notices)" "New Chat-installable skills"

echo "--deferred on clear or compact does nothing:"
for source in clear compact; do
  reset
  OUT=$(run "$source" --deferred)
  assert_missing "$source: no writer"                     "$OUT" "DISPATCH"
  assert_missing "$source: no Chat-skill notice"          "$(notices)" "New Chat-installable skills"
done

echo "--deferred keeps the warmup's skip guards:"
reset
OUT=$(run startup --deferred "CLAUDE_CODE_AGENT=watson")
assert_missing  "an --agent run drains nothing"           "$OUT" "DISPATCH"
assert_missing  "and writes no notice"                    "$(notices)" "New Chat-installable skills"
OUT=$(run startup --deferred "WORKBENCH_SKIP_WARMUP=1")
assert_missing  "a summary-writer drains nothing"         "$OUT" "DISPATCH"

echo "an argument it does not know runs the whole warmup, so no work is skipped:"
reset
OUT=$(run startup --bogus)
assert_contains "it drains"                               "$OUT" "DISPATCH sid=old"
assert_missing  "it prints no rules (system prompt)"      "$OUT" "Memory routing"
assert_contains "it scans for Chat skills"                "$(notices)" "New Chat-installable skills"

echo "the stamps: --defer notes its start last, --deferred notes it done last:"
reset
run startup --defer >/dev/null
check_stamp() { if [ "$(cat "$1" 2>/dev/null)" = "$2" ]; then ok "$3"; else no "$3 — got: $(cat "$1" 2>/dev/null)"; fi; }
check_stamp "$STARTED" current "--defer writes the started stamp"
[ ! -e "$DONE" ] && ok "and no done stamp" || no "and no done stamp"
run startup --deferred >/dev/null
check_stamp "$DONE" current "--deferred writes the done stamp"
reset
run clear --defer >/dev/null
[ ! -e "$STARTED" ] && ok "a clear owes no deferred run, so it writes no stamp" || no "a clear owes no deferred run, so it writes no stamp"
reset
run startup >/dev/null
[ ! -e "$STARTED" ] && ok "a whole run writes no stamp" || no "a whole run writes no stamp"

echo "when the deferred run finished, the next --defer start does not drain inline:"
reset
run startup --defer >/dev/null
run startup --deferred >/dev/null
reset_markers_only() { rm -f "$MARKERS"/*.json; for sid in old mid new; do printf '{"session_id":"%s","transcript_path":"%s/none.jsonl","log_path":"%s/%s.log.md"}\n' "$sid" "$SANDBOX" "$LOGDIR" "$sid" > "$MARKERS/$sid.json"; done; rm -rf "$HOME_DIR/.claude-workbench"; }
reset_markers_only
OUT=$(run startup --defer)
assert_missing  "no writer inline"                        "$OUT" "DISPATCH"
assert_missing  "no Chat-skill notice inline"             "$(notices)" "New Chat-installable skills"

echo "with no deferred run at all (no hooks module), the next start drains and scans inline:"
reset
run startup --defer >/dev/null
OUT=$(run startup --defer)
assert_contains "the oldest marker is dispatched inline"  "$OUT" "DISPATCH sid=old"
assert_contains "the Chat-skill notice is written inline" "$(notices)" "New Chat-installable skills"
assert_missing  "no part prints the rules (system prompt)" "$OUT" "Memory routing"
check_stamp "$STARTED" current "it notes its own start again"
[ "$(grep -c '^## 📦' "$NOTICES_FILE")" = "1" ] && ok "one Chat-skill notice" || no "one Chat-skill notice"
run startup --deferred >/dev/null
[ "$(grep -c '^## 📦' "$NOTICES_FILE")" = "1" ] && ok "a deferred run after the fallback does not add it twice" || no "a deferred run after the fallback does not add it twice"
echo "  and with no hooks module, the cooldown still holds between starts:"
reset
run startup --defer >/dev/null
OUT=$(run startup --defer "WORKBENCH_DRAIN_COOLDOWN_MIN=5")
assert_contains "the first fallback drains"               "$OUT" "DISPATCH sid=old"
OUT=$(run startup --defer "WORKBENCH_DRAIN_COOLDOWN_MIN=5")
assert_missing  "the next start inside the cooldown does not" "$OUT" "DISPATCH"
echo "  a resumed session falls back too:"
reset
run startup --defer >/dev/null
OUT=$(run resume --defer)
assert_contains "resume drains inline"                    "$OUT" "DISPATCH sid=old"

# A deferred run that drained and has not written its done stamp: the drain's
# cooldown stamp is its own, and its PID and start are in the started stamp.
deferred_mid_run() {  # deferred_mid_run <pid> <start epoch>
  reset
  run startup --defer >/dev/null
  printf 'current %s %s\n' "$1" "$2" > "$STARTED"
  printf 'deferred current\n' > "$STAMP"
}
echo "while the deferred run is still running, another start leaves it alone:"
sleep 30 &
LIVE_PID=$!
deferred_mid_run "$LIVE_PID" "$(date +%s)"
OUT=$(run startup --defer "WORKBENCH_DRAIN_COOLDOWN_MIN=5")
assert_missing  "a start during the live run drains nothing" "$OUT" "DISPATCH"
assert_missing  "and scans nothing inline"                "$(notices)" "New Chat-installable skills"
echo "  a live PID with a start past the 120 s timeout is taken as dead:"
deferred_mid_run "$LIVE_PID" "$(( $(date +%s) - 121 ))"
OUT=$(run startup --defer "WORKBENCH_DRAIN_COOLDOWN_MIN=5")
assert_contains "the next start drains despite the fresh cooldown stamp" "$OUT" "DISPATCH sid=old"
kill "$LIVE_PID" 2>/dev/null
wait "$LIVE_PID" 2>/dev/null
echo "when the deferred run was killed after the drain wrote its cooldown stamp:"
deferred_mid_run "$LIVE_PID" "$(date +%s)"
OUT=$(run startup --defer "WORKBENCH_DRAIN_COOLDOWN_MIN=5")
assert_contains "a dead PID: the next start drains despite the fresh cooldown stamp" "$OUT" "DISPATCH sid=old"
echo "  and when it never recorded a PID:"
reset
run startup --defer >/dev/null
printf 'deferred current\n' > "$STAMP"
OUT=$(run startup --defer "WORKBENCH_DRAIN_COOLDOWN_MIN=5")
assert_contains "it counts as dead too"                   "$OUT" "DISPATCH sid=old"
echo "  and when it was killed after a done stamp from an earlier session:"
reset
run startup --defer >/dev/null
printf 'earlier\n' > "$DONE"
OUT=$(run startup --defer)
assert_contains "a done stamp for another session does not count" "$OUT" "DISPATCH sid=old"

echo "a real deferred run killed partway leaves its start owed:"
reset
run startup --defer >/dev/null
# A jq that hangs on a marker, so the deferred run stops inside the drain,
# after the drain wrote its cooldown stamp, as a short claude -p that exits
# would leave it. It is killed there. Every other jq call runs the real one.
mkdir -p "$SANDBOX/hangbin"
cat > "$SANDBOX/hangbin/jq" <<HANG
#!/bin/bash
for arg in "\$@"; do case "\$arg" in */pending-summaries/*.json) sleep 5 ;; esac; done
exec "$(command -v jq)" "\$@"
HANG
chmod +x "$SANDBOX/hangbin/jq"
rm -f "$STAMP"
printf '{"source":"startup","session_id":"current"}' | \
  env HOME="$HOME_DIR" PATH="$SANDBOX/hangbin:$SANDBOX/bin:$PATH" \
    WORKBENCH_MEMORY_PATH="$SANDBOX/memory" WORKBENCH_MEMORY_CACHE="$SANDBOX/cache" \
    WORKBENCH_MEMORY_PORT="$PROBE_PORT" CLAUDE_PLUGIN_ROOT="$REPO_ROOT" \
    WORKBENCH_DISPATCH_DRY_RUN=1 WORKBENCH_AUTO_SUMMARIZE=1 \
    bash "$WARMUP" --deferred >/dev/null 2>&1 &
KILLED=$!
sleep 2
kill "$KILLED" 2>/dev/null
wait "$KILLED" 2>/dev/null
[ -e "$STAMP" ] && ok "it was killed after the drain wrote its cooldown stamp" || no "it was killed after the drain wrote its cooldown stamp"
[ ! -e "$DONE" ] && ok "no done stamp was written" || no "no done stamp was written"
[[ "$(cat "$STARTED")" =~ ^current\ [0-9]+\ [0-9]+$ ]] && ok "it had recorded its PID and start" || no "it had recorded its PID and start — got: $(cat "$STARTED")"
# The killed run also left the drain's lock. A start within the minute that
# lock lasts drains nothing, and the markers wait. A start after it drains.
LOCK="$SANDBOX/cache/summary-drain.lock"
[ -d "$LOCK" ] && ok "it left the drain's lock" || no "it left the drain's lock"
touch -t 202601010000 "$LOCK"
OUT=$(run startup --defer "WORKBENCH_DRAIN_COOLDOWN_MIN=5")
assert_contains "the next start after the lock's minute drains inline" "$OUT" "DISPATCH sid=old"

echo "two spawns on one marker start one writer:"
reset
# shellcheck source=hooks/lib/summary-dispatch.sh
SPAWNS=$(
  export MEMORY_PATH="$SANDBOX/memory" CACHE_PATH="$SANDBOX/cache" WORKBENCH_DISPATCH_DRY_RUN=1
  _cfg() { :; }
  . "$HOOKS_DIR/lib/summary-dispatch.sh"
  summary_dispatch_spawn old "$MARKERS/old.json" "$LOGDIR/old.log.md" "" &
  summary_dispatch_spawn old "$MARKERS/old.json" "$LOGDIR/old.log.md" ""
  wait
)
[ "$(printf '%s\n' "$SPAWNS" | grep -c '^DISPATCH sid=old$')" = "1" ] && ok "one writer for two spawns at once" || no "one writer for two spawns at once — got: $(printf '%s\n' "$SPAWNS" | grep -c '^DISPATCH sid=old$')"
OUT=$(run startup --defer >/dev/null; run startup --deferred)
assert_missing  "a drain skips the claimed marker"       "$OUT" "DISPATCH sid=old"
assert_contains "and takes the next one"                 "$OUT" "DISPATCH sid=mid"
rm -f "$MARKERS/old.json"
(
  _cfg() { :; }
  CACHE_PATH="$SANDBOX/cache"
  . "$HOOKS_DIR/lib/summary-dispatch.sh"
  summary_dispatch_sweep_claims "$MARKERS"
)
[ ! -e "$MARKERS/.claims/old.json" ] && ok "a claim whose marker is gone is swept" || no "a claim whose marker is gone is swept"
[ -d "$MARKERS/.claims/mid.json" ] && ok "a claim whose marker is there stays" || no "a claim whose marker is there stays"
touch -t 202001010000 "$MARKERS/.claims/mid.json"
SPAWNS=$(
  export MEMORY_PATH="$SANDBOX/memory" CACHE_PATH="$SANDBOX/cache" WORKBENCH_DISPATCH_DRY_RUN=1
  _cfg() { :; }
  . "$HOOKS_DIR/lib/summary-dispatch.sh"
  summary_dispatch_spawn mid "$MARKERS/mid.json" "$LOGDIR/mid.log.md" ""
)
assert_contains "a claim past its TTL is taken over"     "$SPAWNS" "DISPATCH sid=mid"
# session-log.sh writes a new marker for a later segment: a marker newer than
# its claim is a new job, inside the TTL too.
python3 -c 'import os, sys, time; t = time.time() - 300; os.utime(sys.argv[1], (t, t))' "$MARKERS/.claims/mid.json"
touch "$MARKERS/mid.json"
SPAWNS=$(
  export MEMORY_PATH="$SANDBOX/memory" CACHE_PATH="$SANDBOX/cache" WORKBENCH_DISPATCH_DRY_RUN=1
  _cfg() { :; }
  . "$HOOKS_DIR/lib/summary-dispatch.sh"
  summary_dispatch_spawn mid "$MARKERS/mid.json" "$LOGDIR/mid.log.md" ""
)
assert_contains "a marker newer than its claim is claimed again" "$SPAWNS" "DISPATCH sid=mid"
SPAWNS=$(
  export MEMORY_PATH="$SANDBOX/memory" CACHE_PATH="$SANDBOX/cache" WORKBENCH_DISPATCH_DRY_RUN=1
  _cfg() { :; }
  . "$HOOKS_DIR/lib/summary-dispatch.sh"
  summary_dispatch_spawn mid "$MARKERS/mid.json" "$LOGDIR/mid.log.md" ""
)
assert_missing  "and then holds again"                   "$SPAWNS" "DISPATCH sid=mid"

echo "two callers on one stale claim: exactly one spawns, every time:"
reset
spawn_mid() {
  (
    export MEMORY_PATH="$SANDBOX/memory" CACHE_PATH="$SANDBOX/cache" WORKBENCH_DISPATCH_DRY_RUN=1
    _cfg() { :; }
    . "$HOOKS_DIR/lib/summary-dispatch.sh"
    summary_dispatch_spawn mid "$MARKERS/mid.json" "$LOGDIR/mid.log.md" ""
  )
}
CLAIM="$MARKERS/.claims/mid.json"
mkdir -p "$CLAIM"
RACES_LOST=0
for _ in $(seq 1 40); do
  touch -t 202001010000 "$CLAIM"
  WINS=$( { spawn_mid & spawn_mid & spawn_mid & wait; } | grep -c '^DISPATCH sid=mid$')
  [ "$WINS" = "1" ] || RACES_LOST=$((RACES_LOST + 1))
done
check_zero() { if [ "$1" = "0" ]; then ok "$2"; else no "$2 — $1 rounds were not exactly one"; fi; }
check_zero "$RACES_LOST" "in 40 rounds of three callers, each round started one writer"
[ -z "$(find "$MARKERS/.claims" -name '*.takeover')" ] && ok "and no takeover lock is left" || no "and no takeover lock is left"
echo "  a takeover lock held by another caller means this caller gets nothing:"
touch -t 202001010000 "$CLAIM"
mkdir "$CLAIM.takeover"
assert_missing  "no writer while the lock is held"       "$(spawn_mid)" "DISPATCH sid=mid"
(
  _cfg() { :; }
  CACHE_PATH="$SANDBOX/cache"
  . "$HOOKS_DIR/lib/summary-dispatch.sh"
  summary_dispatch_sweep_claims "$MARKERS"
)
[ -d "$CLAIM.takeover" ] && ok "a fresh takeover lock is not swept" || no "a fresh takeover lock is not swept"
touch -t 202001010000 "$CLAIM.takeover"
(
  _cfg() { :; }
  CACHE_PATH="$SANDBOX/cache"
  . "$HOOKS_DIR/lib/summary-dispatch.sh"
  summary_dispatch_sweep_claims "$MARKERS"
)
[ ! -e "$CLAIM.takeover" ] && ok "a takeover lock left for over a minute is swept" || no "a takeover lock left for over a minute is swept"
assert_contains "and the stale claim can be taken over again" "$(spawn_mid)" "DISPATCH sid=mid"

echo "  a takeover lock a killed caller left blocks the claim for a minute, not for good:"
# Without a sweep: the next claim breaks the stale takeover itself, under
# <claim>.takeover.takeover, checked again there (lib/dir-lock.sh).
touch -t 202001010000 "$CLAIM"
mkdir "$CLAIM.takeover"
touch -t 202001010000 "$CLAIM.takeover"
assert_contains "the stale claim behind a stale takeover is taken over" "$(spawn_mid)" "DISPATCH sid=mid"
[ -z "$(find "$MARKERS/.claims" -name '*.takeover*')" ] && ok "and no takeover lock is left at any level" || no "and no takeover lock is left at any level"
touch -t 202001010000 "$CLAIM"
mkdir "$CLAIM.takeover" "$CLAIM.takeover.takeover"
touch -t 202001010000 "$CLAIM.takeover"
assert_missing  "a stale takeover whose own takeover is held fresh is not broken" "$(spawn_mid)" "DISPATCH sid=mid"
(
  _cfg() { :; }
  CACHE_PATH="$SANDBOX/cache"
  . "$HOOKS_DIR/lib/summary-dispatch.sh"
  summary_dispatch_sweep_claims "$MARKERS"
)
[ -d "$CLAIM.takeover" ] && ok "nor swept while its own takeover is held" || no "nor swept while its own takeover is held"
rmdir "$CLAIM.takeover.takeover"
RACES_LOST=0
for _ in $(seq 1 30); do
  touch -t 202001010000 "$CLAIM"
  mkdir -p "$CLAIM.takeover"
  touch -t 202001010000 "$CLAIM.takeover"
  WINS=$( { spawn_mid & spawn_mid & spawn_mid & wait; } | grep -c '^DISPATCH sid=mid$')
  [ "$WINS" = "1" ] || RACES_LOST=$((RACES_LOST + 1))
done
check_zero "$RACES_LOST" "in 30 rounds of three callers behind a stale takeover, each round started one writer"

echo "the hooks run the parts:"
SS=$(jq -r '.hooks.SessionStart[].hooks[].command' "$HOOKS_DIR/hooks.json")
PC=$(jq -r '.hooks.PostCompact[].hooks[].command' "$HOOKS_DIR/hooks.json")
assert_contains "SessionStart runs the warmup with --defer" "$SS" 'session-warmup.sh" --defer'
assert_contains "PostCompact runs the whole warmup"       "$PC" 'session-warmup.sh"'
assert_missing  "and not a part of it"                    "$PC" "--defer"
grep -q "'--deferred'" "$HOOKS_DIR/register.ts" \
  && ok "the hooks module runs --deferred" || no "the hooks module runs --deferred"

echo "startup sweeps cache-meter records older than a week:"
reset
METER="$HOME_DIR/.claude-workbench/cache-meter"
mkdir -p "$METER"
printf '{}' > "$METER/old.json"
printf '{}' > "$METER/new.json"
touch -t 202001010000 "$METER/old.json"
run startup --defer >/dev/null
[ ! -e "$METER/old.json" ] && ok "an old record goes" || no "an old record goes"
[ -e "$METER/new.json" ] && ok "a new record stays" || no "a new record stays"
run resume --defer >/dev/null
touch -t 202001010000 "$METER/new.json"
run resume --defer >/dev/null
[ -e "$METER/new.json" ] && ok "only startup sweeps" || no "only startup sweeps"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
