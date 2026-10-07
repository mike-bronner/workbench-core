---
description: Periodic health-and-repair pass over the memory vault — rescue files skipped for missing frontmatter, repair broken links, conservatively connect orphans, repair vault-index drift, flag duplicates for human review, and write an audit report. Run monthly via the scheduled-tasks MCP, or manually any time.
disable-model-invocation: true
context: fork
---

The user (or a scheduled task) has invoked `/workbench-core:memory-lint`. Perform a lint pass over the markdown memory vault served by the `memory` MCP: gather health signals, apply bounded repairs, write an audit report, and re-verify.

Why this exists: the vault accumulates rot silently. Files written without the required `name`/`type` frontmatter are skipped at index time — they exist on disk but are invisible to `search`. Links break when targets are renamed or deleted. Orphans pile up. This skill is the periodic ritual that finds and repairs that rot, conservatively, with an audit trail.

## Step 0 — Pre-warm tools and resolve paths

Load the memory MCP tools in one ToolSearch call (query: `"memory"`, generous `max_results`) so the whole toolkit is available: `stats`, `search`, `read`, `write`, `edit`, `list_documents`, `get_broken_links`, `get_orphan_notes`, `get_backlinks`, `reindex` — all on the `mcp__plugin_workbench-core_memory__*` prefix.

Resolve the vault path the way every hook does:

```bash
. "${CLAUDE_PLUGIN_ROOT}/hooks/lib/memory-env.sh" && memory_resolve_memory_path
```

Every Bash call starts a fresh shell, so no variable survives from one call to the next. Spell the resolved vault path out in each command below where it reads `$MEMORY_PATH`, or set it again at the top of that call.

Scratch files go in the **session scratchpad**, the directory the harness names at session start. Below it is written `$SCRATCH`: spell that path out too. Never make scratch anywhere else under `/tmp`.

Vault conventions (required frontmatter, write-vs-edit rules, relative paths) are in `${CLAUDE_PLUGIN_ROOT}/references/vault-conventions.md` — read it before the fix pass.

## Step 1 — Gather signals

### 1a. Stats — the "before" snapshot

Call `stats`. Record document count, chunk count, `orphan_count`, `link_count`, `broken_link_count`. These are the "before" numbers in the report — capture them verbatim now. If you reindex in Step 1c, take the "before" numbers again after it, or label which set is pre-reindex.

Then record **external write pressure**: the files other writers changed in the last 30 minutes. Step 4 measures it again, so the report can tell your own edits from theirs.

```bash
find "$MEMORY_PATH" -type f -name '*.md' ! -name '*.log.md' -mmin -30 \
  | sed "s|^$MEMORY_PATH/||" | sort > "$SCRATCH/lint-pressure-start.txt"
```

### 1b. Link health

- `get_broken_links` — every link pointing at a non-existent document, with `source_path`, `target_path`, `raw_target`, and `link_text`.
- `get_orphan_notes` — notes with no inbound or outbound links. **Check `orphan_count` from stats first** — on large vaults this returns everything. If it's in the hundreds, you only need the list for the conservative-linking and duplicate scans, not for per-orphan processing.

### 1c. Skipped-file detection — filesystem vs index

The MCP cannot list files it skipped at index time, so diff the filesystem against the index:

```bash
find "$MEMORY_PATH" -name "*.md" ! -name "*.log.md" \
  | sed "s|^$MEMORY_PATH/||" | sort > "$SCRATCH/lint-disk.txt"
```

Call `list_documents` with no folder filter and no `pattern` (`**/*.md` drops root-level files). A large result is persisted to a file: read it with `jq`, never into context. Write every `path` value, sorted, to `$SCRATCH/lint-indexed.txt`, then:

```bash
comm -23 "$SCRATCH/lint-disk.txt" "$SCRATCH/lint-indexed.txt" > "$SCRATCH/lint-skipped.txt"
wc -l < "$SCRATCH/lint-skipped.txt"
```

The difference is the set of files skipped for missing or invalid frontmatter — real memories invisible to search. Raw `*.log.md` transcripts are excluded by design (write-only archival); **never lint them**.

**Permanent exclusions.** Three files lack frontmatter on purpose, appear in every skipped diff, and are never rescued:

- `CLAUDE.md` and `MEMORY.md`, which other tools read as plain text.
- `projects/github-profile-assets/README-pending-review.md`, which is published verbatim to GitHub, where YAML would render as junk.

The general rule behind them: a file something other than the vault consumes may be frontmatter-free by design. Before rescuing an unfamiliar skipped file, `search` its path and stem. A prior decision or insight about it is binding.

**Intersect the skipped files with the broken-link targets** (from 1b) before any repair. Each hit is a link that is already correct, and only its target is unindexed. One rescue closes all of those links with no link edit, so never "resolve" such a link toward a neighbour.

If the disk-vs-index diff looks implausible (indexed files missing from disk, or the index appears stale relative to recent disk changes), call `reindex` once **before** the fix pass and re-run the comparison. Never call `reindex` after `write`/`edit` — those update the index immediately.

### 1d. Sync-collision detection — run this BEFORE anything resolves a link

The vault lives inside iCloud-synced `~/Documents` and is written from more than one machine. That is deliberate — sessions are meant to sync — but it means iCloud will periodically leave **conflict copies** when the same path is written from two machines before a sync completes:

```bash
find "$MEMORY_PATH" -type d -name '* [0-9]'      # e.g. "sessions/2026-07-23 2"
find "$MEMORY_PATH" -type f -name '* [0-9].md'   # e.g. "topics/foo 2.md"
```

**Detect these first and repair them before any link work** (Step 2a′). A conflict copy is not link rot — it is the *filesystem* being wrong while the links are right — and every link-resolution heuristic this skill uses will happily "resolve" a correct link *into* the conflict folder, because the file genuinely is sitting there. Applying that rewrite cements the corruption and makes the damage permanent. On 2026-08-19 this affected 165 broken links, including all 62 in one topic page that looked like the single best fix-to-link ratio on the board.

Whatever survives into the link buckets must exclude them: `grep -v ' [0-9]/'`.

### 1e. Frontmatter health — the failures the skipped-file diff cannot see

Step 1c finds files the indexer *rejected*. It cannot find files the indexer
**accepted with a mutilated field**, and those are the more expensive half.

In a plain (unquoted) YAML scalar, ` #` — space then hash — begins a comment. A
value that mentions an issue or PR number therefore ends early:

```yaml
summary: Mike corrected me on laravel-lsp PR #284. I enabled class rename but…
#                                              ^ everything from here is discarded
```

That indexes as `Mike corrected me on laravel-lsp PR`. **No error, no warning, no
entry in `skipped_files`** — the document looks healthy and simply never matches
the search it should. On 2026-08-28 four indexed fields were losing 438, 136, 80,
and 31 characters this way, and had been for weeks.

Run the scan. It needs PyYAML, which the vault server already depends on. Without
it the scan exits 2 and says the vault was NOT checked: record that in the report
as a check that did not run, never as a clean result.

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/memory-lint/scripts/check-frontmatter-health.py" "$MEMORY_PATH"
```

The scan reports two shapes, both repaired in Step 2a″:

- **Truncated** — an indexed field (`name`, `type`, `tags`, `summary`, `date`,
  `scope`, `log_files`) whose parsed value is shorter than what was written.
- **Misfiled** — an abstract under `description:` with no `summary:`. Only the
  indexed fields are searchable, so however good that abstract is, it is weighted
  at zero. This is the shape Claude Code's auto-memory schema emits (see
  `insights/2026-08-01-vault-frontmatter-schema-drift`); on 2026-08-28 it accounted
  for 145 documents and 28,829 characters of invisible text.

Exit 1 when either shape is present. A truncated value in a key that was already
unsearchable is reported but exits 0 — it costs nothing extra.

The scan compares **only string values**. Lists, dates, and numbers legitimately
differ from their source text — an early version of this check flagged all 814
`tags: [a, b]` lines in the vault before that was corrected.

### 1f. Non-link health — what link and frontmatter metrics cannot see

Two checks, each cheap, each catching a loss that is otherwise invisible:

- **Log-to-summary gap.** For each of the last five days under `sessions/`, count `*.log.md` against `*.summary.md`. Raw logs are pruned at 7 days, so a log with no summary is lost once it ages out. Name every dated folder that reaches the prune age before the next run, with its gap.
- **Curated files over 100 KB.** List every non-session file over 100 KB with its size. The MCP `read` cap is 256 KB, so a curated page that keeps growing becomes unreadable in one piece. Compare against the sizes the last report recorded. Escalate only when two intervals both show growth while its writer was active. A page that needs splitting is flagged with options, never truncated.

```bash
find "$MEMORY_PATH" -type f -name '*.md' ! -path "$MEMORY_PATH/sessions/*" -size +100k \
  -exec ls -l {} + | awk '{print $5, $NF}'
```

## Step 2 — Fix pass

**Hard cap: 50 file-fixes per run.** A fix is any file written or edited (frontmatter rescues, broken-link repairs, link additions). The cap bounds session cost — a 160-file backlog is three monthly runs, not one marathon. When you hit the cap, stop fixing and record the remainder in the report; the next run picks it up. **Sync-collision merges (2a′) are exempt from the cap** — they are filesystem repairs, not document edits, and leaving one half-done is worse than not starting.

Prioritize within the cap: sync-collision merges first (they poison everything downstream), then frontmatter rescues (they restore invisible memories to search), then broken links, then conservative linking, then index drift.

### 2a′. Sync-collision merge

For each conflict copy found in 1d. **Back up first** — `cp -Rp` the whole conflict path to the scratchpad before touching anything; the vault has no version control, so this backup is the only undo.

**Directory collisions** (`<dir> 2/` beside `<dir>/`):

1. Move every file whose name does **not** already exist in the canonical directory. This is the bulk of the work and is always safe.
2. For each name that exists in **both**, compare content — `shasum` first, then look at the files:
   - **Identical** → delete the conflict copy. It is a true duplicate.
   - **Different** → **keep both.** Move the copy in under a distinguishing name (`<stem>.part1.log.md`, `<stem>.conflict-<n>.md`) and flag the pair in the report. Never resolve by picking one.
3. `rmdir` the conflict directory only once it is empty. If it will not empty, something was missed — stop and report.

**File collisions** (`<name> 2.md` beside `<name>.md`): same content comparison — identical means delete the copy, different means rename it to `<name>.conflict-<n>.md`, keep both, and flag.

**Never resolve a collision on file metadata.** "Keep the larger" and "keep the newer" both sound reasonable and both destroy data: on 2026-08-19 the two colliding files had larger-but-older on one side, and the `.log.md` pair turned out to be complementary *segments* of one log (`start_line: 1` vs `start_line: 20`), not duplicates at all — either heuristic would have thrown away unique content. Size and mtime cannot distinguish a duplicate from a fragment. Only content can, so read it.

Reindex once after the merge, then re-run Step 1's link gathering — the resolution map from before the merge is stale.

### 2a. Frontmatter rescue

For each skipped file:

1. **Read it from the filesystem** with the `Read` tool (absolute path: `$MEMORY_PATH/<relative-path>`) — it's not in the index, so MCP `read` may not serve it.
2. **Infer `name`**: from the first `# ` heading, an existing partial-frontmatter title, or a humanized filename — in that order of preference.
3. **Infer `type`** from location and content:

   | Signal | `type` |
   |---|---|
   | `sessions/` or `Session-summaries/` path | `session` |
   | `decisions/` path | `decision` |
   | `insights/` path | `insight` |
   | `identity/` path | `identity` |
   | `projects/` path | `project` |
   | `infrastructure/` path | `infrastructure` |
   | `skills/*.learnings.md` | `skill-learnings` |
   | `feedback_*.md` filename | `feedback` |
   | `maintenance/` path | `maintenance` |
   | None of the above | infer from content; match the conventions visible in healthy sibling files |

4. **Infer `date`/`tags`/`summary` only where confidently derivable** — a `YYYY-MM-DD` in the filename or path, an explicit date line in the body, obvious topical tags. Don't fabricate; `name` and `type` are the only required fields.
5. **Write via the MCP `write` tool**: relative path, `content` = the existing body (minus any broken partial frontmatter you're replacing — the body itself must survive byte-for-byte), `frontmatter` = the inferred dict. Writing through the MCP updates the index immediately.
6. **Round-trip verify the first file before batch-processing the rest**: `search` for its name and confirm it now appears. If it doesn't, stop the rescue pass, diagnose, and report — don't batch-write on a broken assumption.

### 2a″. Frontmatter health repairs

For each **truncated** hit from Step 1e:

1. `read` the document through the MCP — it is indexed, so this works normally.
2. Re-emit the offending value as a **folded block scalar**, which makes `#`, `:`,
   and quotes all literal and needs no escaping:

   ```yaml
   summary: >-
     Mike corrected me on laravel-lsp PR #284. I enabled class rename but carved
     out three shapes as "deliberately fail-closed".
   ```

   A single-line value can instead be single-quoted (`name: 'zed-laravel PR #336'`),
   doubling any internal `'`.
3. **Recover the lost text from the file itself, never from memory.** The full value
   is still on disk in the raw frontmatter — the loss is at parse time, not write
   time. Copy it verbatim; do not paraphrase what you think it said.
4. Apply with MCP `edit`, not `write` — a targeted replacement of the one value.
   Re-typing a whole document to fix one line is how `README.md` was destroyed on
   2026-08-26.
5. Re-run the Step 1e scan and confirm the file no longer appears.

For each **misfiled** hit, rename the key:

1. `read` the document; take the `description:` value **from the raw file**, not
   from the parsed frontmatter — if it also contains ` #`, the parsed copy is
   already short.
2. Re-emit it as `summary: >-` with the full text. Where a `summary:` already
   exists, the `description:` is a leftover duplicate — drop it rather than merge,
   after confirming the `summary` is the richer of the two.
3. Never rewrite the body. This is a frontmatter-only edit.

Each repair counts against the 50-fix cap. A large backlog is several runs, not one
marathon — except where the human has explicitly asked for a single sweep.

### 2b. Broken links

Bucket the links first, and never walk them one at a time. Drop every link whose target is a skipped file (1c): the rescue fixes it. Then run the **resolution chain** on the rest, in this order, before calling any target absent:

1. **Folder-case drift.** The target matches an indexed path case-insensitively. macOS folds case on disk, and the index does not. Fix the case in the link.
2. **Bare stem.** `[[slug]]` matches exactly one indexed stem, with or without a date prefix.
3. **Folder-prefixed slug.** Strip a leading `<word>-`, then two words, and retry.
4. **Stale migration folder.** The target has a `-tmp-migrate/` or `-migrate/` segment. Confirm every slug exists at the destination, then substitute the folder.
5. **Name differs from path.** Build a `name → path` map from the persisted `list_documents` output (`.frontmatter.name` and `.path`). Check its row count against `stats.document_count` before trusting it: a short map turns every later lookup into a false absence.
6. **Word-reordered rename, or a date off by one.** Compare word sets. For dated targets, strip the date on both sides and match the stem.

Passes 5 and 6 are claims about meaning, so read the candidate's frontmatter before every repair. Record the near-misses you rejected, so the next run does not derive them again. Filter every resolution through `grep -v ' [0-9]/'`, so no link resolves into a sync-collision copy.

Then, for each link:

- **Confident unique match** → `read` the source document, then `edit` the link to point at the correct path.
- **Target genuinely gone** → `edit` to remove the link markup, keeping the plain text in place. Never delete the sentence, never delete the document.
- **Ambiguous** (multiple plausible targets) → leave it and flag it in the report.

**Never repair these.** Report each class on its own line, outside the fixable count:

- **A markdown link in the wrong frame.** A `[t](path.md)` href with no leading slash resolves against its source's folder, not the vault root. Dropping `.md` fixes nothing. The fix is the root-absolute form, `[t](/path.md)`, made by its writer, so flag it upstream.
- **A source-code path** (`.php`, `.rs`, `.ts`, `.json`, `.sh`, with or without `:line`). It never resolves. The upstream fix is a code span.
- **A write-ahead link** (`(if written)`, `once decided`, `(TODO)`). Run the full chain first, since the target may exist under another name. Repoint it if it resolves. Demote it to plain text only when nothing does.
- **A citation.** Under `maintenance/` or in `skills/*.learnings.md`, a link may be the subject of the sentence. Read the sentence, and leave the illustration as it is.

### 2c. Conservative linking

Do **not** mass-link orphans. Signal-to-noise is sacred — a vault where everything links to everything carries no information. Better to leave an orphan than force a connection.

Add a link only when a confident, meaningful relation exists — e.g. a session summary that explicitly names the topic of a decision file. Expect single digits per run, not dozens. Each addition is a `read`-then-`edit` on the source document and counts against the cap.

### 2d. Duplicates and contradictions — flag, never merge

Scan `list_documents` titles/names (and the orphan list) for near-duplicates — two decision files on the same topic, two `topics/` pages covering the same theme, a summary duplicated across folders — and for documents asserting contradictory facts. **Do not auto-merge, do not delete.** List each pair in the report with a one-line note on why it looks duplicated or contradictory. The human decides.

### 2e. Index drift

`README.md` at the vault root is the **orientation entry point** — the map an agent reads on demand *before* searching, not a manifest of everything in the vault (see `${CLAUDE_PLUGIN_ROOT}/references/linking-synthesis.md` Step E, which is the authoritative contract). Search is the exhaustive-lookup mechanism; the index exists to be read end-to-end by a human or an agent, so it must stay short enough to scan.

Check it in both directions:

1. **Missing entries** — every `topics/` page gets an index line, and so does every **promoted** decision (one a topic page or another decision actually references — not every file in `decisions/`). For each one missing, `edit` the index to add a line: root-absolute markdown link + one-line hook (derive the hook from the document's `summary` frontmatter).
2. **Stale entries** — no index line may point at a document that no longer exists. Remove stale lines via `edit`.

**Do not index every document under `decisions/`.** A line-per-document index is actively harmful: it grows without bound, stops being readable at exactly the moment it stops being scannable, duplicates what `search` already does better, and — because every line is a link — converts the entire curated layer into broken-link surface area for this same skill to police. If a run reports a triple-digit "missing entries" backlog, that is the signal this rule has drifted back toward manifest semantics, not that the vault has rotted.

If `README.md` doesn't exist at all, create it per the linking-synthesis contract, populated from the indexed `topics/` documents plus referenced decisions. Sessions are never indexed.

Each index `edit`/`write` counts against the per-run fix cap.

## Step 3 — Write the report

Write the audit report via MCP `write` to `maintenance/lint-YYYY-MM-DD.md` (today's date):

```markdown
---
name: "Memory lint — YYYY-MM-DD"
type: maintenance
date: YYYY-MM-DD
tags: [maintenance, lint]
summary: "N frontmatter rescues, N broken links repaired, N links added, N index entries fixed, N flagged, N skipped files remaining."
---

## Write pressure
- External writes during the run: N files (list any that carry a defect this run repairs)

## Before / after

| Metric | Before | Predicted | After |
|---|---|---|
| Documents | … | … | … |
| Orphans | … | … | … |
| Links | … | … | … |
| Broken links | … | … | … |
| Skipped files (disk − index) | … | … | … |

## Non-link health
- Log-to-summary gap, last five days: …
- Curated files over 100 KB: `path` (bytes, previous bytes)

## Fixes applied

### Sync collisions merged (N)
- `sessions/<date> 2/` → `sessions/<date>/`: N files moved, N identical duplicates removed, N kept under both names

### Frontmatter rescues (N)
- `path` — inferred type, name

### Broken links (N)
- `source` → `target`: repaired | removed

### Links added (N)
- `source` → `target`: rationale

### Index drift (N)
- `README.md` ± `path`: added missing entry | removed stale entry

## Flagged for human review
- duplicate/contradiction pairs, ambiguous broken links
- links the chain must never repair, by class (wrong frame, source-code path, write-ahead, citation)
- collision pairs kept under both names (content differed — a human decides which survives, or whether both should)

## Remainder
N skipped files remain (cap hit) — next run resumes there.
```

The report doubles as the audit trail across runs — before starting Step 2, it's worth reading the most recent `maintenance/lint-*.md` for the prior remainder and previously flagged items.

Then summarize the same numbers in chat, terse.

## Step 4 — Re-verify

1. **Predict, then measure.** Before calling `stats`, write down the after-numbers the fix log predicts. Then call `stats`. The report's "after" column comes **from this call, not from arithmetic**. When the two differ, name the cause in the report. Never round it away, and state any overage of the 50-fix cap.
2. **Re-run the sync-collision scan** from Step 1d. This skill's own rapid edits to one file have forked iCloud copies mid-run. Resolve any new copy per Step 2a′.
3. **Measure write pressure again**, and subtract the files you edited:

   ```bash
   find "$MEMORY_PATH" -type f -name '*.md' ! -name '*.log.md' -mmin -30 \
     | sed "s|^$MEMORY_PATH/||" | sort > "$SCRATCH/lint-pressure-end.txt"
   comm -23 "$SCRATCH/lint-pressure-end.txt" "$SCRATCH/lint-edited.txt"
   ```

   `lint-edited.txt` is the sorted list of vault paths this run wrote or edited. Name any external pressure in the report before the numbers, because it moves them. Check the new arrivals for the defect you were repairing: they often carry it.
4. Re-run the Step 1c comparison for the after-value of the skipped-file count.

## Scheduling

Intended cadence: **monthly — the 1st at 09:00** (`0 9 1 * *`). Vault rot accumulates slowly; monthly keeps each run comfortably under the 50-fix cap once the initial backlog is cleared.

The schedule is deployed via the scheduled-tasks MCP, mirroring the workbench house pattern:

1. Call `mcp__scheduled-tasks__list_scheduled_tasks` and look for `taskId` `workbench-core-memory-lint`.
2. If it exists, call `mcp__scheduled-tasks__update_scheduled_task`; otherwise `mcp__scheduled-tasks__create_scheduled_task` — with:

```jsonc
{
  taskId: "workbench-core-memory-lint",
  cronExpression: "0 9 1 * *",
  prompt: "/workbench-core:memory-lint",
  description: "Monthly memory-vault lint — frontmatter rescue, broken-link repair, audit report."
}
```

Running this skill does not register the schedule by itself — `/workbench-core:setup` Step 4 registers it by default (or deploy it manually with the payload above). Manual invocations between scheduled runs are always fine; the cap and the report remainder make runs resumable.

## Safety rails

- **Never touch `*.log.md`.** Raw transcripts are write-only archival, excluded from indexing by design. They are not lint targets — not for frontmatter, not for links, not for anything. The one exception is moving them during a sync-collision merge (2a′), where the file is relocated verbatim and never edited.
- **Never delete unique content.** Broken-link repair removes link markup at most, never content, never files. The single sanctioned deletion is a sync-collision copy whose content is **byte-identical** to the file it collides with — that is removing a duplicate, not a document. Anything that differs, however slightly, is kept under both names and flagged.
- **Cap of 50 file-fixes per run.** Bounded session cost beats heroics. Report the remainder. Sync-collision merges are exempt — see 2a′.
- **Flag, don't merge — for *documents*.** Two files on the same topic go in the report for the human; this skill never consolidates documents on its own. Sync-collision *folders* are the exception and are merged automatically: nothing is being consolidated there, the filesystem is simply being put back the way it already was before iCloud forked it.
- **Never resolve a collision on size or mtime.** Only content distinguishes a duplicate from a fragment. See 2a′.
- **All writes go through the MCP** (`write`/`edit`) so the index stays consistent with disk. The only filesystem reads are for skipped (unindexed) files; never write with the filesystem tools. Never call `reindex` after MCP writes — the index updates immediately.
- **Verify before batching.** The first frontmatter rescue must round-trip through `search` before the rest are processed.

## Notes

- A skipped file with *malformed* frontmatter (bad YAML) needs its broken header replaced, not a second header prepended — preserve any salvageable fields from it.
- If `stats` is unreachable, stop — there's no safe lint without a before-snapshot. Report the MCP failure instead.
- All MCP paths are vault-relative; absolute paths are only for the `find` comparison and filesystem `Read` of unindexed files.
