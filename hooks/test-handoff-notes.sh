#!/bin/bash
set -u
CHECK="$(cd "$(dirname "$0")/.." && pwd)/skills/memory-lint/scripts/check-handoff-notes.py"
PASS=0
FAIL=0

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

ok()  { PASS=$((PASS + 1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  ❌ $1 — $2"; }
has() { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1" "output lacks: $3" ;; esac; }
lacks() { case "$2" in *"$3"*) bad "$1" "output has: $3" ;; *) ok "$1" ;; esac; }

echo "no PyYAML means a loud failure, never a clean result:"
mkdir -p "$TMP/noyaml" "$TMP/empty"
printf 'raise ImportError("stubbed out")\n' > "$TMP/noyaml/yaml.py"
ERR=$(PYTHONPATH="$TMP/noyaml" python3 "$CHECK" "$TMP/empty" 2>&1 >/dev/null)
RC=$?
[ "$RC" -eq 2 ] && ok "exits 2 without PyYAML" || bad "exits 2 without PyYAML" "got exit $RC"
has "says the vault was not checked" "$ERR" "NOT checked"

if ! python3 -c 'import yaml' 2>/dev/null; then
  echo "  ⏭  PyYAML missing: the scan cases are skipped"
  echo
  echo "$PASS passed, $FAIL failed"
  [ "$FAIL" -eq 0 ]
  exit
fi

V="$TMP/vault"
mkdir -p "$V/progress" "$V/insights" "$V/sessions/2026-10-27"
TWO='sources:
  - {id: audio, title: Audio, resource: "a.m4a"}
  - {id: video, title: Video, resource: "v.mp4"}'

cat > "$V/insights/tagged.md" <<EOF
---
name: tagged
type: insight
$TWO
---

# Tagged

- Batch start 03:50 (UTC+2)[^audio]; 01:50 UTC[^video]
- Both agree on the key[^audio][^video]

A paragraph that runs on
and is tagged on its second line[^video]

| Fact | Where |
|---|---|
| Start 01:50 UTC | [^video] |

\`\`\`
- an untagged line inside code
\`\`\`

## Related

- [Other](/insights/other.md)

[^audio]: Audio
[^video]: Video
EOF

cat > "$V/insights/untagged.md" <<EOF
---
name: untagged
type: insight
$TWO
---

- Batch start 03:50 (UTC+2)[^audio]
- Batch start 01:50 UTC
- [12:04] A timestamp is not a tag
- See [audio](/insights/other.md) for a link that is not a tag

An untagged paragraph.

| Fact | Where |
|---|---|
| Start 01:50 UTC | video |

- A plain tag is not a footnote [video]

[^audio]: Audio
EOF

cat > "$V/insights/single.md" <<'EOF'
---
name: single
type: insight
sources:
  - {id: audio, title: Audio, resource: "a.m4a"}
---

- One source needs no tag
EOF

cat > "$V/progress/current.md" <<'EOF'
---
name: current
type: progress
task_status: open
updated: 2026-10-22
sources:
  - {id: session, title: The session, resource: "session:sid-1"}
---

- Next: transcribe the second recording
EOF

cat > "$V/progress/stale.md" <<'EOF'
---
name: stale
type: progress
task_status: open
updated: 2026-10-07
---

- Next: nothing has moved
EOF

cat > "$V/progress/ended.md" <<'EOF'
---
name: ended
type: progress
task_status: ended
updated: 2026-10-26
---

- Done
EOF

cat > "$V/progress/undated.md" <<'EOF'
---
name: undated
type: progress
task_status: open
---

- Next: something
EOF

cat > "$V/insights/unsourced.md" <<'EOF'
---
name: unsourced
type: decision
---

- A decision with no source named
EOF

cat > "$V/insights/empty-list.md" <<'EOF'
---
name: empty list
type: insight
sources: []
---

- An empty list names no source
EOF

mkdir -p "$V/topics/sub"
printf -- '---\nokf_version: "0.2"\n---\n' > "$V/index.md"
printf -- '## 2026-10-27\n\n- pulled in\n' > "$V/topics/log.md"
printf -- '# Index\n' > "$V/topics/sub/Index.MD"
printf -- '- a raw log\n' > "$V/sessions/2026-10-27/abc.log.md"

cat > "$V/README.md" <<'EOF'
---
name: vault-index
type: index
---

- [Tagged](/insights/tagged.md)
EOF

cat > "$V/sessions/2026-10-27/raw.log.md" <<EOF
---
name: raw
type: session
$TWO
---

- An untagged raw log line
EOF

BEFORE=$(find "$V" -type f -exec shasum {} + | sort)
OUT=$(python3 "$CHECK" "$V" --today=2026-10-27)
RC=$?
AFTER=$(find "$V" -type f -exec shasum {} + | sort)

echo "a note with two or more sources flags each untagged fact, for review:"
[ "$RC" -eq 1 ] && ok "exits 1 when it flags" || bad "exits 1 when it flags" "got exit $RC"
has   "an untagged bullet is flagged with its line"   "$OUT" $'untagged\tinsights/untagged.md:10\t- Batch start 01:50 UTC'
lacks "a tagged bullet is not flagged"                "$OUT" $'insights/untagged.md:9\t'
has   "a timestamp in brackets is not a tag"          "$OUT" $'insights/untagged.md:11\t'
has   "a markdown link is not a tag"                  "$OUT" $'insights/untagged.md:12\t'
has   "an untagged paragraph is flagged"              "$OUT" $'insights/untagged.md:14\t'
has   "an untagged table row is flagged"              "$OUT" $'insights/untagged.md:18\t'
has   "a plain [id] is not a footnote"              "$OUT" $'insights/untagged.md:20\t'
lacks "a footnote definition is not a fact"          "$OUT" $'insights/untagged.md:22\t'
lacks "a table header is not a fact"                  "$OUT" $'insights/untagged.md:16\t'
lacks "a fully tagged note is left alone"             "$OUT" 'insights/tagged.md'
lacks "a one-source note is left alone"               "$OUT" 'insights/single.md'
lacks "a raw session log is not scanned"              "$OUT" 'raw.log.md'

echo "a progress note that ended or went stale is flagged, and a current one is not:"
has   "an ended task is flagged"                      "$OUT" $'progress\tprogress/ended.md\ttask ended'
has   "a note not updated for 20 days is flagged"     "$OUT" $'progress\tprogress/stale.md\tnot updated for 20 days'
has   "a note with no updated date is flagged"        "$OUT" $'progress\tprogress/undated.md\tno valid updated date'
lacks "a note updated 5 days ago is left alone"       "$OUT" 'progress/current.md'

echo "a note with no sources list is flagged, and a catalog is not:"
has   "a note with no list is flagged"                "$OUT" $'unsourced\tinsights/unsourced.md\t'
has   "an empty list is flagged"                      "$OUT" $'unsourced\tinsights/empty-list.md'
has   "an unsourced progress note is flagged"         "$OUT" $'unsourced\tprogress/stale.md'
lacks "a sourced note is not flagged as unsourced"    "$OUT" $'unsourced\tinsights/single.md'
lacks "the README catalog is not flagged"             "$OUT" $'unsourced\tREADME.md'

echo "any index.md or log.md a pull brought in is listed for review:"
has   "a root index.md is listed"                     "$OUT" $'reserved\tindex.md'
has   "a folder log.md is listed"                     "$OUT" $'reserved\ttopics/log.md'
has   "a mixed-case index.md is listed"               "$OUT" $'reserved\ttopics/sub/Index.MD'
lacks "a session log ending in .log.md is not"        "$OUT" $'reserved\tsessions/2026-10-27/abc.log.md'
lacks "a reserved file is not also flagged unsourced" "$OUT" $'unsourced\tindex.md'

echo "the scan only reports:"
[ "$BEFORE" = "$AFTER" ] && ok "no file is changed or deleted" || bad "no file is changed or deleted" "the vault changed"

C="$TMP/clean"
mkdir -p "$C/insights" "$C/progress" "$C/sessions/2026-10-27"
cp "$V/insights/tagged.md" "$V/insights/single.md" "$C/insights/"
cp "$V/progress/current.md" "$C/progress/"
cp "$V/README.md" "$C/"
cp "$V/sessions/2026-10-27/raw.log.md" "$C/sessions/2026-10-27/"
OUT=$(python3 "$CHECK" "$C" --today=2026-10-27)
RC=$?
[ "$RC" -eq 0 ] && [ -z "$OUT" ] && ok "a clean vault exits 0 with no output" || bad "a clean vault exits 0 with no output" "exit $RC: $OUT"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
