#!/bin/bash

set -u
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HOOKS_DIR/.." && pwd)"
SKILL="$ROOT/skills/read-first"
FIND="$SKILL/scripts/find-contract.mjs"
CUT="$SKILL/scripts/cut-diff.mjs"
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); echo "  ✅ $1"; }
no() { FAIL=$((FAIL + 1)); echo "  ❌ $1: $2"; }

command -v node >/dev/null 2>&1 || { echo "FAIL: node is not on PATH, so the read-first scripts cannot be tested"; exit 1; }

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
COMMANDS="$(awk '/^ *```bash$/ {on=1; next} /^ *```$/ {on=0} on {sub(/^ +/, ""); print}' "$SKILL/SKILL.md")"
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
if [ "$COUNT" -eq 5 ]; then ok "the skill carries five commands"; else no "the skill carries five commands" "found $COUNT"; fi
if grep -qE '^[[:space:]]*[A-Z_]+=' "$SKILL/SKILL.md"; then
  no "the skill sets no shell variable for a later call" "$(grep -m1 -E '^[[:space:]]*[A-Z_]+=' "$SKILL/SKILL.md")"
else
  ok "the skill sets no shell variable for a later call"
fi
if grep -qF 'session scratchpad' "$SKILL/SKILL.md" && grep -qF '<scratchpad>/cut/' "$SKILL/SKILL.md"; then
  ok "the skill saves its working files in the session scratchpad"
else
  no "the skill saves its working files in the session scratchpad" "missing"
fi

echo
echo "the skill fires on the moments it covers:"
DESC="$(awk '/^---$/{c++; next} c==1' "$SKILL/SKILL.md" | sed -n 's/^description: //p')"
for word in 'send a body' 'API' 'form' 'CLI' 'MCP tool' 'contract' 'shorten' 'summarize' 'rewrite' 'text a person gave' 'goes stale' 'newest model' 'version' 'price' 'current docs'; do
  if printf '%s' "$DESC" | grep -qF -- "$word"; then ok "the description names '$word'"; else no "the description names '$word'" "$DESC"; fi
done
for rule in '## 1\.' '## 2\.' '## 3\.'; do
  section="$(awk -v r="^$rule" '$0 ~ r {on=1; print; next} on && /^## / {exit} on' "$SKILL/SKILL.md")"
  for part in '**When:**' '**Check:**' '**Done:**' '**Ask the user**'; do
    if printf '%s' "$section" | grep -qF -- "$part"; then ok "rule ${rule:3:1} states $part"; else no "rule ${rule:3:1} states $part" "missing"; fi
  done
done
if found="$(grep -rniE 'Mike|rook|MEGA\.dev' "$SKILL")"; then
  no "the skill names no person and carries no credit" "$found"
else
  ok "the skill names no person and carries no credit"
fi
if found="$(grep -niE "rook|MEGA\.dev" "$ROOT/README.md")"; then
  no "the README carries no read-first credit" "$found"
else
  ok "the README carries no read-first credit"
fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
