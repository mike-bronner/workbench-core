#!/bin/bash

set -u
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HOOKS_DIR/.." && pwd)"
SKILLS="read-the-contract show-every-cut check-a-live-source use-the-owners-logic recheck-before-done"
FIND="$ROOT/skills/read-the-contract/scripts/find-contract.mjs"
CUT="$ROOT/skills/show-every-cut/scripts/cut-diff.mjs"
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); echo "  ✅ $1"; }
no() { FAIL=$((FAIL + 1)); echo "  ❌ $1: $2"; }

command -v node >/dev/null 2>&1 || { echo "FAIL: node is not on PATH, so the source-skill scripts cannot be tested"; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
WORK="$TMP/work"
mkdir -p "$WORK"

OUT=""
RC=0
run() { OUT=$(cd "$WORK" && env -u CLAUDE_CODE_SESSION_ID "$@" 2>&1); RC=$?; }
expect() {
  if [ "$RC" -ne "$2" ]; then no "$1" "exit $RC, wanted $2: $OUT"
  elif ! printf '%s' "$OUT" | grep -qF -- "$3"; then no "$1" "no '$3' in: $OUT"
  else ok "$1"; fi
}

echo "the self-tests pass, with no network:"
run node "$FIND" --self-test
expect "find-contract self-test" 0 "self-test ok"
run node "$CUT" --self-test
expect "cut-diff self-test" 0 "self-test ok"

echo
echo "the contract check reads a saved page, stdin and help text:"
cat > "$WORK/page.html" <<'HTML'
<html><head><link rel="service-desc" href="openapi.json"></head>
<body><p>Our newest model is <b>Nova 3</b>.</p>
<form action="/notes" method="post"><input name="title" required maxlength="80"></form></body></html>
HTML
run node "$FIND" page.html --base https://example.test/app/
expect "a saved page resolves its links against --base" 0 "service-desc https://example.test/app/openapi.json"
expect "a saved page lists its form fields and limits" 0 "title  text  required  maxlength=80"
printf '<link rel="describedby" href="/note.schema.json"><link rel="service-doc" href="https://docs.example.test/">\n' > "$WORK/links.html"
run node "$FIND" links.html --base https://example.test/app/
expect "a describedby link is listed" 0 "describedby  https://example.test/note.schema.json"
expect "a service-doc link is listed" 0 "service-doc  https://docs.example.test/"
printf '\357\273\277{"type":"object","required":["id"],"properties":{"id":{"type":"string"}}}\n' > "$WORK/bom.json"
run node "$FIND" bom.json
expect "a JSON contract with a byte-order mark is read" 0 "- id  string  required"
printf '<p>nothing here</p>\n' > "$WORK/empty.html"
run node "$FIND" empty.html
expect "a page that declares nothing exits 2 and says to ask" 2 "Ask the user where the contract is"
run sh -c "printf '%s' '{\"tools\":[{\"name\":\"add\",\"inputSchema\":{\"type\":\"object\",\"required\":[\"n\"],\"properties\":{\"n\":{\"type\":\"integer\"}}}}]}' | node '$FIND' -"
expect "an MCP tools/list on stdin lists the tool's fields" 0 "- n  integer  required"
run sh -c "printf 'USAGE\n  tool run [flags]\n\nFLAGS\n  -v, --verbose   Talk more\n' | node '$FIND' - --cli"
expect "help text on stdin lists its flags" 0 "1. -v, --verbose   Talk more"
run sh -c "printf 'no options at all\n' | node '$FIND' - --cli"
expect "help text with no flags exits 2" 2 "flags: none found"

echo
echo "the source check confirms a quote word for word:"
run node "$FIND" page.html --quote "Our newest model is Nova 3."
expect "a quote on the page is found" 0 "quote: found on the page"
run node "$FIND" page.html --quote "Our newest model is Nova 4."
expect "a quote not on the page exits 2" 2 "quote: NOT found"

echo
echo "the scripts refuse what they must not do:"
printf 'secret\n' > "$TMP/outside.txt"
run node "$CUT" ../outside.txt page.html
expect "cut-diff refuses a file outside the working folder" 1 "outside the working folder"
run node "$FIND" ../outside.txt
expect "find-contract refuses a file outside the working folder" 1 "outside the working folder"
run node "$FIND" file:///etc/hosts
expect "find-contract refuses a non-http URL" 1 "give an http or https URL"
run node "$FIND" https://example.test/ --cli
expect "find-contract refuses --cli on a URL before it fetches" 1 "--cli reads help text"
run node "$FIND" page.html --open --quote "x"
expect "find-contract refuses two modes at once" 1 "do not go together"
ln -s "$TMP/outside.txt" "$WORK/link.txt"
run node "$FIND" link.txt
expect "find-contract refuses a symlink that leaves the folder" 1 "outside the working folder"
run node "$CUT" link.txt page.html
expect "cut-diff refuses a symlink that leaves the folder" 1 "outside the working folder"
run node "$FIND" "$TMP/outside.txt"
expect "find-contract refuses an absolute path outside the folder" 1 "outside the working folder"
run node "$CUT" "$TMP/outside.txt" page.html
expect "cut-diff refuses an absolute path outside the folder" 1 "outside the working folder"
run node "$CUT" page.html page.html --keep-file ../outside.txt
expect "cut-diff refuses a keep file outside the folder" 1 "outside the working folder"
run node "$FIND" page.html --base notaurl
expect "find-contract refuses an invalid --base" 1 "--base takes an http or https URL"
run node "$FIND" page.html --base 'https://'
expect "find-contract refuses a --base that does not parse" 1 "--base takes an http or https URL"
for f in "$FIND" "$CUT"; do
  name="$(basename "$f")"
  hit="$(grep -niE 'writeFile|appendFile|createWriteStream|mkdir|unlink|child_process|cookie|authorization|token' "$f" | head -1)"
  if [ -z "$hit" ]; then ok "$name writes nothing, runs nothing, and carries no credentials"; else no "$name writes nothing, runs nothing, and carries no credentials" "$hit"; fi
  hit="$(awk '/fetch\(/ {on=1} on {print} on && /\}\);/ {on=0}' "$f" | grep -nE '(method|body|headers: \{[^}]*(auth|cookie)):' | head -1)"
  if [ -z "$hit" ]; then ok "$name sends no body and no method but GET"; else no "$name sends no body and no method but GET" "$hit"; fi
  hit="$(tail -n +2 "$f" | grep -nE '^[[:space:]]*(//|/\*)|[;,{}()][[:space:]]+//' | head -1)"
  if [ -z "$hit" ]; then ok "$name carries no code comments"; else no "$name carries no code comments" "$hit"; fi
done
hit="$(tail -n +2 "$0" | grep -nE '^[[:space:]]*#' | head -1)"
if [ -z "$hit" ]; then ok "this test carries no comments"; else no "this test carries no comments" "$hit"; fi

echo
echo "the scripts read this session's scratchpad, and no other folder outside:"
SID="${CLAUDE_CODE_SESSION_ID:-}"
REAL_TMP="$(cd -P "$TMP" && pwd -P)"
case "$REAL_TMP" in
  /private/tmp/claude-"$(id -u)"/*/"$SID"/scratchpad/* | /tmp/claude-"$(id -u)"/*/"$SID"/scratchpad/*)
    OUT=$(cd "$ROOT" && node "$FIND" "$TMP/work/page.html" 2>&1); RC=$?
    expect "a saved page in the session scratchpad is read from another folder" 0 "service-desc"
    OUT=$(cd "$ROOT" && CLAUDE_CODE_SESSION_ID=another-session node "$FIND" "$TMP/work/page.html" 2>&1); RC=$?
    expect "another session's scratchpad is refused" 1 "outside the working folder" ;;
  *) echo "  ⏭️  not run inside a session scratchpad, so the self-tests carry this check" ;;
esac

echo
echo "the cut check counts, keeps and lists cuts from files:"
printf 'One. Two stays exactly.\n\nThree.\n' > "$WORK/original.txt"
printf 'Two stays exactly.\n' > "$WORK/new.txt"
printf 'Two stays exactly.\n' > "$WORK/keep.txt"
run node "$CUT" original.txt new.txt --keep-file keep.txt --max-chars 20
expect "a kept passage under the limit passes" 0 "result: ok"
expect "every dropped sentence is listed" 0 "  - p2  Three."
run node "$CUT" original.txt new.txt --keep-file keep.txt --max-words 2
expect "a version over the word limit fails" 1 "1 word over the limit"
printf 'Two stays exactly!\n' > "$WORK/new.txt"
run node "$CUT" original.txt new.txt --keep-file keep.txt
expect "a changed keep passage names the differing code point" 1 "expected . U+002E, found ! U+0021"

echo
echo "every command in the skill runs as written in a fresh shell:"
SCR="$WORK/scratch"
mkdir -p "$SCR/cut"
cp "$WORK/page.html" "$SCR/page.html"
printf 'Keep me. Drop me.\n' > "$SCR/cut/original.txt"
printf 'Keep me.\n' > "$SCR/cut/new.txt"
printf 'Keep me.\n' > "$SCR/cut/keep.txt"
printf 'FLAGS\n  -d, --draft   Mark as a draft\n' > "$WORK/cli-help.txt"
PLUGIN_ROOT_TOKEN='${CLAUDE_PLUGIN_ROOT}'
GH_HELP='gh pr create --help'
COMMANDS="$(for s in $SKILLS; do awk '/^ *```bash$/ {on=1; next} /^ *```$/ {on=0} on {sub(/^ +/, ""); print}' "$ROOT/skills/$s/SKILL.md"; done)"
COUNT=0
while IFS= read -r cmd; do
  [ -n "$cmd" ] || continue
  COUNT=$((COUNT + 1))
  script="$(printf '%s' "$cmd" | grep -oE '\$\{CLAUDE_PLUGIN_ROOT\}/[^"]+' | head -1)"
  if [ -n "$script" ] && [ -f "$ROOT/${script#"$PLUGIN_ROOT_TOKEN"/}" ]; then
    ok "command $COUNT names its script by a full path that exists"
  else
    no "command $COUNT names its script by a full path that exists" "$cmd"
  fi
  case "$cmd" in *'<url>'*) continue ;; esac
  line="${cmd//"$PLUGIN_ROOT_TOKEN"/$ROOT}"
  line="${line//<scratchpad>/$SCR}"
  line="${line//<its URL>/https://example.test/}"
  line="${line//<n>/500}"
  line="${line//"$GH_HELP"/cat cli-help.txt}"
  OUT=$(cd "$WORK" && env -u CLAUDE_CODE_SESSION_ID bash -c "$line" 2>&1); RC=$?
  expect "command $COUNT runs in a fresh shell" 0 ""
done <<< "$COMMANDS"
if [ "$COUNT" -eq 5 ]; then ok "the skills carry five commands"; else no "the skills carry five commands" "found $COUNT"; fi
for s in $SKILLS; do
  if grep -qE '^[[:space:]]*[A-Z_]+=' "$ROOT/skills/$s/SKILL.md"; then
    no "$s sets no shell variable for a later call" "$(grep -m1 -E '^[[:space:]]*[A-Z_]+=' "$ROOT/skills/$s/SKILL.md")"
  else
    ok "$s sets no shell variable for a later call"
  fi
done
if grep -qF 'session scratchpad' "$ROOT/skills/show-every-cut/SKILL.md" && grep -qF '<scratchpad>/cut/' "$ROOT/skills/show-every-cut/SKILL.md"; then
  ok "show-every-cut saves its working files in the session scratchpad"
else
  no "show-every-cut saves its working files in the session scratchpad" "missing"
fi

echo
echo "each skill fires on its own moments, and no other description claims them:"
description() { awk '/^---$/{c++; next} c==1' "$ROOT/skills/$1/SKILL.md" | sed -n 's/^description: //p'; }
moments() {
  case "$1" in
    read-the-contract) printf '%s\n' 'HTTP POST' 'PUT' 'PATCH' 'DELETE' 'webhook' 'form submit' "CLI's flags" 'config or schema file' 'MCP tool call' 'system you do not own' 'accepted shape' 'no sourced value' 'another tool hands' '{}' 'placeholder' 'a guess' 'offer the user a choice' 'refusal gives no reason' 'same refusal' 'empty value' 'even when the user asks for it' 'linter, build or CI config' ;;
    show-every-cut) printf '%s\n' 'shorten' 'summarize' 'condense' 'trim' 'paraphrase' 'rewrite' 'text a person gave' 'notes, a document, a post, a quote' 'character or word limit' 'word for word' ;;
    check-a-live-source) printf '%s\n' 'name or rely on' 'into code, a config, a commit or a reply' 'goes stale' 'from training' 'newest or latest model' 'model ID' 'library or tool version' 'price' 'limit or quota' 'release date' "product's current docs" ;;
    use-the-owners-logic) printf '%s\n' 'compute' 'count' 'classify' 'add a file' "someone else's project" 'export or artifact' 'dependencies alone' 'ships its own logic, views or build' 'a script, a component, a query, a report generator, a test suite' 'already computes' "owner's table, page or report" 'SQL view' 'dashboard' 'work out by hand' ;;
    recheck-before-done) printf '%s\n' 'submit, claim, publish, release or close' 'mark a pull request ready' 'report work as done' 'send it out' 'read earlier in the session' 'keeps changing' 'is live' 'gets updated' 'minutes or hours ago' 'its owner updates' 'Reread that source' ;;
  esac
}
for s in $SKILLS; do
  own="$(description "$s")"
  while IFS= read -r word; do
    if printf '%s' "$own" | grep -qF -- "$word"; then ok "$s names '$word'"; else no "$s names '$word'" "$own"; fi
    for other in $SKILLS; do
      [ "$other" = "$s" ] && continue
      if description "$other" | grep -qF -- "$word"; then no "only $s claims '$word'" "$other names it too"; fi
    done
  done <<< "$(moments "$s")"
  bytes="$(printf '%s' "$own" | wc -c | tr -d ' ')"
  if [ "$bytes" -le 1536 ]; then ok "$s fits the listing's per-skill cap ($bytes bytes)"; else no "$s fits the listing's per-skill cap" "$bytes bytes"; fi
  section="$(awk '/^## 1\./ {on=1; print; next} on && /^## / {exit} on' "$ROOT/skills/$s/SKILL.md")"
  for part in '**When:**' '**Check:**' '**Done:**' '**Ask the user**'; do
    if printf '%s' "$section" | grep -qF -- "$part"; then ok "$s states $part"; else no "$s states $part" "missing"; fi
  done
done

echo
echo "the skills carry the rules they own:"
has() { if grep -qF -- "$3" "$ROOT/skills/$2/SKILL.md"; then ok "$1"; else no "$1" "no '$3' in $2"; fi; }
has "read-the-contract covers a field another tool hands out" read-the-contract "field whose description says another tool hands it out, and that tool has not"
has "read-the-contract stops on the same refusal twice" read-the-contract "The same refusal twice means the"
has "use-the-owners-logic runs the owner's logic" use-the-owners-logic "when the input ships its own logic, views or build, run it and quote"
has "use-the-owners-logic builds with the owner's code" use-the-owners-logic "build it with their code"
RULE='Never offer the user a choice between guessed values for a field an outside'
count="$(grep -rF -- "$RULE" "$ROOT/skills" | wc -l | tr -d ' ')"
if [ "$count" -eq 1 ] && grep -qF -- "$RULE" "$ROOT/skills/intake/SKILL.md"; then
  ok "the intake skill carries the guessed-choice rule, worded once"
else
  no "the intake skill carries the guessed-choice rule, worded once" "found $count"
fi

echo
echo "the trigger evals hold three positives and two negatives per skill:"
for s in $SKILLS; do
  fires="$(find "$ROOT/evals" -path "*/$s--fires--*/prompt.md" | wc -l | tr -d ' ')"
  quiet="$(find "$ROOT/evals" -path "*/$s--quiet--*/prompt.md" | wc -l | tr -d ' ')"
  if [ "$fires" -ge 3 ] && [ "$quiet" -ge 2 ]; then ok "$s has $fires positives and $quiet negatives"; else no "$s has three positives and two negatives" "found $fires and $quiet"; fi
done
both() {
  local dir="$ROOT/evals/$1" s
  for s in "$2" "$3"; do
    if grep -lx "input_match: \"$s\"" "$dir"/graders/*.md 2>/dev/null | xargs grep -lx 'min: 1' > /dev/null 2>&1; then
      ok "$1 asserts that $s fires"
    else
      no "$1 asserts that $s fires" "no min: 1 grader for $s"
    fi
  done
}
both both--fires--claim-after-earlier-reads read-the-contract recheck-before-done
both both--fires--config-in-their-project read-the-contract use-the-owners-logic
boundary() {
  local dir="$ROOT/evals/$1"
  if grep -lx "input_match: \"$2\"" "$dir"/graders/*.md 2>/dev/null | xargs grep -lx 'min: 1' > /dev/null 2>&1; then
    ok "$1 asserts that $2 fires"
  else
    no "$1 asserts that $2 fires" "no min: 1 grader for $2"
  fi
  if grep -lx "input_match: \"$3\"" "$dir"/graders/*.md 2>/dev/null | xargs grep -lx 'max: 0' > /dev/null 2>&1; then
    ok "$1 asserts that $3 stays quiet"
  else
    no "$1 asserts that $3 stays quiet" "no max: 0 grader for $3"
  fi
}
boundary recheck-before-done--fires--submit-quoted-schema-after-earlier-reads recheck-before-done read-the-contract
boundary recheck-before-done--quiet--first-post-unread-api read-the-contract recheck-before-done
boundary check-a-live-source--fires--stale-fact-not-stale-read check-a-live-source recheck-before-done
dupes="$(for f in "$ROOT"/evals/*/prompt.md; do awk '/^---$/ && c < 2 {c++; next} c >= 2' "$f" | shasum; done | sort | uniq -d)"
if [ -z "$dupes" ]; then ok "no two eval prompts are the same"; else no "no two eval prompts are the same" "$dupes"; fi

echo
echo "the skills and evals stay generic:"
for s in $SKILLS; do
  if found="$(grep -rniE 'Mike|rook|MEGA|course' "$ROOT/skills/$s")"; then
    no "$s names no person, course or credit" "$found"
  else
    ok "$s names no person, course or credit"
  fi
done
if found="$(grep -rniE --exclude-dir=results 'Mike|rook|MEGA|course|challenge' "$ROOT/evals")"; then
  no "the evals name no person, course or credit" "$found"
else
  ok "the evals name no person, course or credit"
fi
if found="$(grep -niE "rook|MEGA\.dev" "$ROOT/README.md")"; then
  no "the README carries no course credit" "$found"
else
  ok "the README carries no course credit"
fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
