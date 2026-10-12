#!/bin/bash
# Pins the read-before-write rule in core's automated vault writers that run on
# prose: the summary-writer agent and its dispatch brief, the references it
# follows for decisions, topic pages and README.md, compact-learnings, and the
# scheduled writers evaluate-decisions, propose-upgrades and memory-lint.
# Memory capture is code, and tests/capture.test.ts covers it.
# Run directly: ./test-vault-write-rule.sh
#
# The memory MCP's write replaces any note at its path. On 2026-10-09 core's
# session replaced a note dev-team had written 20 seconds earlier, and the
# write's created:false went unread. Each writer below must read or search a
# new path before it writes, and treat an unintended created:false as an error.
# Each check reads only the section that holds the write, so the same words
# elsewhere in the file cannot satisfy it.

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0

# section <file> <start regex> <end regex> — the lines from the first match of
# start up to, not including, the next match of end.
section() {
  awk -v s="$2" -v e="$3" 'on && $0 ~ e { exit } $0 ~ s { on = 1 } on' "$1"
}

has() {
  local desc="$1" text="$2" needle="$3"
  if [ -n "$text" ] && printf '%s' "$text" | grep -qF -- "$needle"; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — the section lacks: $needle"
  fi
}

AGENT="$ROOT/agents/summary-writer.md"
echo "summary-writer, step 3 (the summary, and every other new note):"
STEP3="$(section "$AGENT" '^### 3\.' '^### 4\.')"
has "reads the summary path before it writes"        "$STEP3" 'Read the path before you write it.'
has "replaces only this session's own summary"       "$STEP3" 'only when its frontmatter `session_id` is yours'
has "a created:false after an empty read is an error" "$STEP3" 'summary-writer: error sid={sid} replaced={path}'
has "every other new note is read or searched first" "$STEP3" '`read` the exact path, or `search` for the note'"'"'s name'
has "a replaced decision, page or index is reported" "$STEP3" 'add `replaced={path}` to your step 7 line'
STEP7="$(section "$AGENT" '^### 7\.' '^## Failure modes')"
has "the confirmation line carries replaced paths"   "$STEP7" 'Append ` replaced={path}`'
FAILS="$(sed -n '/^## Failure modes/,$p' "$AGENT")"
has "the failure modes name the collision"           "$FAILS" 'path-taken={path}'

echo "the dispatch brief the writer starts from:"
BRIEF="$(MEMORY_PATH=/vault bash -c '. "$0" 2>/dev/null; summary_dispatch_prompt sid /m /l /t' "$ROOT/hooks/lib/summary-dispatch.sh")"
has "says to read every path first"                  "$BRIEF" 'Read every path before you'
has "makes created:false an error"                   "$BRIEF" 'That is an error,'

echo "decision promotion:"
DECISION="$(grep -F 'Write to `decisions/' "$ROOT/references/decision-promotion.md")"
has "reads or searches the decision path first"      "$DECISION" 'First `read` that exact path, or `search`'
has "checks created after the write"                 "$DECISION" 'check `created` in its answer'

echo "topic pages and README.md (linking-synthesis):"
LINKING="$ROOT/references/linking-synthesis.md"
TOPIC="$(section "$LINKING" 'No topic page exists AND' '^- \*\*Neither')"
has "a new topic page's path is read first"          "$TOPIC" '`read` the new'
has "a new topic page checks created"                "$TOPIC" 'check `created` in its'
README="$(section "$LINKING" 'If `README.md` does not exist' '^- Keep entries')"
has "README.md is read just before it is created"    "$README" 'by a `read` of `README.md` just before the `write`'
has "README.md names created:false an error"         "$README" '`created` in the write'"'"'s answer: `false`'

echo "compact-learnings (an intended replace, guarded by etag):"
COMPACT="$(section "$ROOT/skills/compact-learnings/SKILL.md" '^### Compact the learnings file' '^### Integrate')"
has "reads just before the write"                    "$COMPACT" '`read` the file just before the write'
has "passes the etag as if_match"                    "$COMPACT" 'pass it to `write` as `if_match`'
has "a changed file is read again and merged"        "$COMPACT" 'add the new entries to your kept list'
has "created:true is an error for a replace"         "$COMPACT" '`true` means the file was gone'

CREATED_ERROR='`false` means the write replaced a note another writer had just made: that is an error'

echo "evaluate-decisions (the learnings report):"
EVAL="$(grep -F 'Write via MCP `write` to `learnings/YYYY-MM-DD-eval.md`' "$ROOT/skills/evaluate-decisions/SKILL.md")"
has "reads the report path first"                    "$EVAL" '`read` that exact path first'
has "an earlier report today is not replaced"        "$EVAL" 'do not replace it'
has "created:false is an error"                      "$EVAL" "$CREATED_ERROR"

echo "propose-upgrades (the ledger, the digest, a new feedback doc):"
PROPOSE="$ROOT/skills/propose-upgrades/SKILL.md"
LEDGER="$(grep -F 'Load the rejection ledger' "$PROPOSE")"
has "the ledger is created only after a read"        "$LEDGER" 'decide it is absent by a `read` of that path'
has "the ledger checks created"                      "$LEDGER" "$CREATED_ERROR"
DIGEST="$(grep -F 'Write via MCP `write` to `proposals/YYYY-MM-DD.md`' "$PROPOSE")"
has "the digest path is read first"                  "$DIGEST" '`read` that exact path first'
has "the digest checks created"                      "$DIGEST" "$CREATED_ERROR"
FEEDBACK="$(grep -F 'new `feedback` doc with proper frontmatter' "$PROPOSE")"
has "a new feedback doc is read or searched first"   "$FEEDBACK" '`read` its path or `search` for its name'
has "a new feedback doc checks created"              "$FEEDBACK" "$CREATED_ERROR"

echo "memory-lint (a rescue, README.md, the audit report):"
LINT="$ROOT/skills/memory-lint/SKILL.md"
RESCUE="$(grep -F 'Write via the MCP `write` tool' "$LINT")"
has "a rescue is an intended replace: created must be false" "$RESCUE" 'it must be `false`. `true` means the file was gone'
LREADME="$(grep -F 'If `README.md` doesn'"'"'t exist at all' "$LINT")"
has "README.md is read just before it is created"    "$LREADME" 'by a `read` of `README.md` just before the `write`'
has "README.md checks created"                       "$LREADME" "$CREATED_ERROR"
REPORT="$(grep -F 'Write the audit report via MCP `write`' "$LINT")"
has "the audit report path is read first"            "$REPORT" '`read` that path first'
has "the audit report checks created"                "$REPORT" "$CREATED_ERROR"

echo "the shared convention (vault-conventions):"
CONV="$(section "$ROOT/references/vault-conventions.md" '^## Writing vs editing' '^## Vault structure')"
has "write replaces any note at its path"            "$CONV" 'It replaces any note already at the path'
has "read or search a new path first"                "$CONV" '`read` that exact path or `search`'
has "created:false where you meant to create is an error" "$CONV" '`false` where you meant to create is an error'

echo
echo "vault-write-rule: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
