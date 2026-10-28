#!/bin/bash
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0

section() {
  awk -v s="$2" -v e="$3" 'on && $0 ~ e { exit } $0 ~ s { on = 1 } on' "$1" | tr '\n' ' ' | tr -s ' '
}

has() {
  if [ -n "$2" ] && printf '%s' "$2" | grep -qF -- "$3"; then
    PASS=$((PASS + 1)); echo "  ✅ $1"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $1 — the section lacks: $3"
  fi
}

CONV="$ROOT/references/vault-conventions.md"
echo "vault-conventions defines the sources list and the fact tag:"
SOURCES="$(section "$CONV" '^## Sources$' '^## Progress notes')"
has "names the three entry fields"            "$SOURCES" '`id`: a short label, unique in the note'
has "names the required resource"            "$SOURCES" '`resource`: where the source is. OKF requires it.'
has "names the resource forms"               "$SOURCES" '`session:<session id>`, `commit:<owner/repo>@<sha>`, `pr:<owner/repo>#<number>`, `person:Mike`, `fluidvoice:<meeting id>`.'
has "a commit names its repository"           "$SOURCES" 'A commit names its repository, because a short SHA can match in more than one'
has "quotes a title with a hash"              "$SOURCES" 'Quote a `title` that holds a space, `#` and digits, such as `"PR #43"`.'
has "the example quotes its PR title"         "$SOURCES" 'title: "PR #43"'
has "the example names a PR"                  "$SOURCES" 'resource: pr:mike-bronner/workbench-core#43'
has "follows the OKF shape"                   "$SOURCES" 'The list follows the OKF v0.2 `sources` shape'
has "every note carries sources"              "$SOURCES" 'Every vault note carries a `sources:` list in its frontmatter whenever any source can be named.'
has "not only hand-off notes"                 "$SOURCES" 'Sources are not only for hand-off notes.'
has "Mike's words are a source"               "$SOURCES" "- Mike's own words"
has "footnotes every fact with two or more"   "$SOURCES" 'With two or more sources, every fact carries the OKF footnote `[^id]` of its source.'
has "defines each footnote"                   "$SOURCES" 'Define each footnote once, at the end of the note, as `[^id]: <title>`.'
has "keeps the crossed-recordings tag"        "$SOURCES" '`Batch start 03:50 (UTC+2)[^audio]; 01:50 UTC[^video]`'
has "the worked example is an ordinary note"  "$SOURCES" 'A decision Mike stated in a session, which a commit then shipped:'
has "the example footnotes each fact"         "$SOURCES" '- The bundled wheel is markdown-vault-mcp 5.1.0[^commit]'
has "the example defines its footnotes"       "$SOURCES" '[^commit]: The commit that bundled the wheel'
has "the example uses resource"               "$SOURCES" 'resource: commit:mike-bronner/workbench-core@7277f26'
has "lint flags an unsourced note"            "$SOURCES" 'flags a note with no `sources:` list'
has "says what the server shows"              "$SOURCES" '`read` returns it under `okf.sources`'
has "says the write check only advises"       "$SOURCES" 'gives advice, never a refusal'

echo "vault-conventions makes the vault the hand-off store:"
PROGRESS="$(section "$CONV" '^## Progress notes' '^## Reserved OKF names')"
has "a resumable task gets a progress note"   "$PROGRESS" 'When a task may be resumed by another or a later session, write one progress note right away, and keep it current.'
has "the note carries its frontmatter"        "$PROGRESS" '`type: progress`, `task_status: open` or `ended`'
has "search before re-deriving"               "$PROGRESS" 'Before you re-derive anything on a task that has history, `search` the vault'
has "a peer session is not a store"           "$PROGRESS" "A peer session's context is not a store"
has "lint flags, never deletes"               "$PROGRESS" 'It never deletes one.'

echo "vault-conventions reserves index.md and log.md:"
RESERVED="$(section "$CONV" '^## Reserved OKF names' '^## Writing vs editing')"
has "OKF is on by a server setting"           "$RESERVED" 'Core switches that on with `MARKDOWN_VAULT_MCP_OKF_MODE=on`, a server setting'
has "core writes no index.md"                 "$RESERVED" 'core writes none into the vault'
has "the server stamps nothing"               "$RESERVED" '`MARKDOWN_VAULT_MCP_OKF_WRITE=false`'
has "every write tool is covered"             "$RESERVED" 'The vault write check covers every write tool the server has'
has "bulk tools are refused"                  "$RESERVED" '`move_folder` and `okf_convert_links` are refused outright'
has "delete writes nothing"                   "$RESERVED" '`delete` writes nothing, so it goes through.'
has "a pull is outside the guard"             "$RESERVED" 'A pull can bring in files another machine wrote, `index.md` and `log.md` included, and the guard cannot see them.'
has "the server's request does not apply"     "$RESERVED" "even when the memory server's instructions ask you to update them"

FORMAT="$ROOT/references/summary-format.md"
echo "summary-format lists the summary's sources and tags its facts:"
FRONT="$(section "$FORMAT" '^## Required frontmatter' '^## Source tags')"
has "the session is always a source"          "$FRONT" 'resource: "session:<session_id>"'
has "only what the session read"              "$FRONT" 'List nothing the session did not read.'
has "every summary carries it"              "$FRONT" 'Every summary carries it.'
TAGS="$(section "$FORMAT" '^## Source tags' '^## Body structure')"
has "two or more sources footnote every fact" "$TAGS" 'With two or more sources, end each fact in the body with the OKF footnote `[^id]` of its source'

AGENT="$ROOT/agents/summary-writer.md"
echo "summary-writer emits sources from what the session read:"
STEP3="$(section "$AGENT" '^### 3\.' '^### 4\.')"
has "every summary carries sources"          "$STEP3" 'Every summary carries a `sources:` list.'
has "builds sources from the tool calls"      "$STEP3" "Build it from what the session actually read, as the transcript's tool calls show it"
has "Mike's words are a source"               "$SOURCES" "- Mike's own words"
has "uses the OKF entry shape"                "$STEP3" 'Each entry has the OKF shape `{id, title, resource}`'
has "uses the one commit and pr form"         "$STEP3" '`commit:<owner/repo>@<sha>`, `pr:<owner/repo>#<number>`'
has "footnotes each fact with two or more"    "$STEP3" 'With two or more sources, end each fact in the body with the OKF footnote `[^id]` of its source'

MEET="$ROOT/agents/meeting-writer.md"
echo "meeting-writer emits the recording as the source:"
STEP4="$(section "$MEET" '^### 4\.' '^### 5\.')"
has "the meeting is the source"               "$STEP4" 'resource: "fluidvoice:{meeting_id}"}'
has "the saved summary is no second source"   "$STEP4" 'it is not a second source'
has "every note it writes carries sources"   "$STEP4" 'Every note you write carries `sources:`'
has "a timestamp is not a footnote"           "$STEP4" 'A timestamp in brackets is not a source footnote.'
STEP3M="$(section "$MEET" '^### 3\.' '^### 4\.')"
has "a promoted decision carries it too"      "$STEP3M" 'resource: "fluidvoice:{meeting_id}"'

LINT="$ROOT/skills/memory-lint/SKILL.md"
echo "memory-lint flags hand-off notes for review and never fixes them:"
STEP1G="$(section "$LINT" '^### 1g\.' '^## Step 2')"
has "runs the scan"                           "$STEP1G" 'check-handoff-notes.py'
has "lists reserved files"                   "$STEP1G" 'Any `index.md` or `log.md`, in any folder and any letter case, is listed.'
has "flags unsourced notes"                   "$STEP1G" 'A note with no `sources:` list, or an empty one, is flagged.'
has "lists only the newest unsourced notes"   "$STEP1G" 'For unsourced notes, give the count, and list at most 25'
has "flags facts with no footnote"           "$STEP1G" 'A fact with no `[^id]` from that list is flagged.'
has "flags ended and stale progress notes"    "$STEP1G" 'when `updated` is more than 14 days old'
has "never fixes or deletes"                  "$STEP1G" 'Never tag, edit, end or delete a flagged note.'

echo "one commit form and one pr form, everywhere they are named:"
OLD="$(grep -rnE 'commit:<sha>|pr:<repo>|ref: "|\{id, ref, kind\}' "$ROOT/references" "$ROOT/agents" "$ROOT/skills" "$ROOT/hooks/mods" "$ROOT/README.md" 2>/dev/null)"
if [ -z "$OLD" ]; then
  PASS=$((PASS + 1)); echo "  ✅ no doc or rule names an old source form"
else
  FAIL=$((FAIL + 1)); echo "  ❌ no doc or rule names an old source form — $(printf '%s' "$OLD" | head -2)"
fi
for FILE in "$ROOT/references/vault-conventions.md" "$ROOT/agents/summary-writer.md" "$ROOT/hooks/mods/prompt-rules.ts"; do
  has "$(basename "$FILE") names both forms" "$(sed 's/\\`/`/g' "$FILE" | tr '\n' ' ' | tr -s ' ')" 'commit:<owner/repo>@<sha>`, `pr:<owner/repo>#<number>`'
done

PEER="$ROOT/skills/cross-session-messaging/SKILL.md"
echo "cross-session-messaging keeps the vault as the store:"
STORE="$(section "$PEER" '^## A peer session is not a store' '^## When a peer message arrives')"
has "a message coordinates"                   "$STORE" 'A message coordinates, and the vault stores.'
has "the peer context ends"                   "$STORE" "A peer session's context ends with that session"
has "send the path"                           "$STORE" "send the note's path in the message"
has "a resumable task gets a progress note"   "$STORE" 'When a task may be resumed by another or a later session (multi-step work, a challenge, an investigation in progress, or facts derived from files, recordings or sessions), write one progress note right away'
has "the progress note is kept current"       "$STORE" 'keep it current as the task moves'
has "the progress note carries its sources"   "$STORE" 'Give it `sources:` and `[^id]` footnotes'
has "search before re-deriving"               "$STORE" 'Before you re-derive anything on a task that has history, search the vault for it'

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
