---
description: Periodic health-and-repair pass over the memory vault — rescue files skipped for missing frontmatter, repair broken links, conservatively connect orphans, repair vault-index drift, flag duplicates for human review, and write an audit report. Run monthly via the scheduled-tasks MCP, or manually any time.
---

This is an execution-aware skill — check `skills/memory-lint.learnings.md` in the vault before proceeding. If it exists, apply accumulated learnings.

The user (or a scheduled task) has invoked `/workbench-core:memory-lint`. Perform a lint pass over the markdown memory vault served by the `memory` MCP: gather health signals, apply bounded repairs, write an audit report, and re-verify.

Why this exists: the vault accumulates rot silently. Files written without the required `name`/`type` frontmatter are skipped at index time — they exist on disk but are invisible to `search`. Links break when targets are renamed or deleted. Orphans pile up. This skill is the periodic ritual that finds and repairs that rot, conservatively, with an audit trail.

## Step 0 — Pre-warm tools and resolve paths

Load the memory MCP tools in one ToolSearch call (query: `"memory"`, generous `max_results`) so the whole toolkit is available: `stats`, `search`, `read`, `write`, `edit`, `list_documents`, `get_broken_links`, `get_orphan_notes`, `get_backlinks`, `reindex` — all on the `mcp__plugin_workbench-core_memory__*` prefix.

Resolve the vault path from config (default shown — see `${CLAUDE_PLUGIN_ROOT}/skills/setup/SKILL.md` for the config contract):

```bash
CONFIG="$HOME/.claude/plugins/data/workbench-core-claude-workbench/config.json"
MEMORY_PATH="$(jq -r '.memory_path // empty' "$CONFIG" 2>/dev/null)"
MEMORY_PATH="${MEMORY_PATH:-$HOME/Documents/Claude/Memory}"
MEMORY_PATH="${MEMORY_PATH/#\~/$HOME}"
```

Vault conventions (required frontmatter, write-vs-edit rules, relative paths) are in `${CLAUDE_PLUGIN_ROOT}/references/vault-conventions.md` — read it before the fix pass.

## Step 1 — Gather signals

### 1a. Stats — the "before" snapshot

Call `stats`. Record document count, chunk count, `orphan_count`, `link_count`, `broken_link_count`. These are the "before" numbers in the report — capture them verbatim now.

### 1b. Link health

- `get_broken_links` — every link pointing at a non-existent document, with `source_path`, `target_path`, `raw_target`, and `link_text`.
- `get_orphan_notes` — notes with no inbound or outbound links. **Check `orphan_count` from stats first** — on large vaults this returns everything. If it's in the hundreds, you only need the list for the conservative-linking and duplicate scans, not for per-orphan processing.

### 1c. Skipped-file detection — filesystem vs index

The MCP cannot list files it skipped at index time, so diff the filesystem against the index:

```bash
find "$MEMORY_PATH" -name "*.md" ! -name "*.log.md" \
  | sed "s|^$MEMORY_PATH/||" | sort > /tmp/memory-lint-disk.txt
```

Call `list_documents` (no folder filter), collect every `path` value, write them sorted to `/tmp/memory-lint-indexed.txt`, then:

```bash
comm -23 /tmp/memory-lint-disk.txt /tmp/memory-lint-indexed.txt > /tmp/memory-lint-skipped.txt
wc -l < /tmp/memory-lint-skipped.txt
```

The difference is the set of files skipped for missing or invalid frontmatter — real memories invisible to search. Raw `*.log.md` transcripts are excluded by design (write-only archival); **never lint them**.

If the disk-vs-index diff looks implausible (indexed files missing from disk, or the index appears stale relative to recent disk changes), call `reindex` once **before** the fix pass and re-run the comparison. Never call `reindex` after `write`/`edit` — those update the index immediately.

## Step 2 — Fix pass

**Hard cap: 50 file-fixes per run.** A fix is any file written or edited (frontmatter rescues, broken-link repairs, link additions). The cap bounds session cost — a 160-file backlog is three monthly runs, not one marathon. When you hit the cap, stop fixing and record the remainder in the report; the next run picks it up.

Prioritize within the cap: frontmatter rescues first (they restore invisible memories to search), then broken links, then conservative linking, then index drift.

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

### 2b. Broken links

For each entry from `get_broken_links`:

1. Try to locate the intended target: `search` for the `raw_target` filename stem and the `link_text`; check whether the target was renamed (same title, different path).
2. **Confident unique match** → `read` the source document, then `edit` the link to point at the correct path.
3. **Target genuinely gone** → `edit` to remove the link markup, keeping the plain text in place. Never delete the sentence, never delete the document.
4. **Ambiguous** (multiple plausible targets) → leave it and flag it in the report.

### 2c. Conservative linking

Do **not** mass-link orphans. Signal-to-noise is sacred — a vault where everything links to everything carries no information. Better to leave an orphan than force a connection.

Add a link only when a confident, meaningful relation exists — e.g. a session summary that explicitly names the topic of a decision file. Expect single digits per run, not dozens. Each addition is a `read`-then-`edit` on the source document and counts against the cap.

### 2d. Duplicates and contradictions — flag, never merge

Scan `list_documents` titles/names (and the orphan list) for near-duplicates — two decision files on the same topic, two `topics/` pages covering the same theme, a summary duplicated across folders — and for documents asserting contradictory facts. **Do not auto-merge, do not delete.** List each pair in the report with a one-line note on why it looks duplicated or contradictory. The human decides.

### 2e. Index drift

`index.md` at the vault root is the **orientation entry point** — the map an agent reads on demand *before* searching, not a manifest of everything in the vault (see `${CLAUDE_PLUGIN_ROOT}/references/linking-synthesis.md` Step E, which is the authoritative contract). Search is the exhaustive-lookup mechanism; the index exists to be read end-to-end by a human or an agent, so it must stay short enough to scan.

Check it in both directions:

1. **Missing entries** — every `topics/` page gets an index line, and so does every **promoted** decision (one a topic page or another decision actually references — not every file in `decisions/`). For each one missing, `edit` the index to add a line: path-qualified wikilink + one-line hook (derive the hook from the document's `summary` frontmatter).
2. **Stale entries** — no index line may point at a document that no longer exists. Remove stale lines via `edit`.

**Do not index every document under `decisions/`.** A line-per-document index is actively harmful: it grows without bound, stops being readable at exactly the moment it stops being scannable, duplicates what `search` already does better, and — because every line is a wikilink — converts the entire curated layer into broken-link surface area for this same skill to police. If a run reports a triple-digit "missing entries" backlog, that is the signal this rule has drifted back toward manifest semantics, not that the vault has rotted.

If `index.md` doesn't exist at all, create it per the linking-synthesis contract, populated from the indexed `topics/` and `identity/` documents plus referenced decisions. Sessions are never indexed.

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

## Before / after

| Metric | Before | After |
|---|---|---|
| Documents | … | … |
| Orphans | … | … |
| Links | … | … |
| Broken links | … | … |
| Skipped files (disk − index) | … | … |

## Fixes applied

### Frontmatter rescues (N)
- `path` — inferred type, name

### Broken links (N)
- `source` → `target`: repaired | removed

### Links added (N)
- `source` → `target`: rationale

### Index drift (N)
- `index.md` ± `path`: added missing entry | removed stale entry

## Flagged for human review
- duplicate/contradiction pairs, ambiguous broken links

## Remainder
N skipped files remain (cap hit) — next run resumes there.
```

The report doubles as the audit trail across runs — before starting Step 2, it's worth reading the most recent `maintenance/lint-*.md` for the prior remainder and previously flagged items.

Then summarize the same numbers in chat, terse.

## Step 4 — Re-verify

Call `stats` again. The report's "after" column comes **from this call, not from arithmetic** — if the numbers don't move the way the fix log says they should, that discrepancy goes in the report too. Re-run the Step 1c comparison for the after-value of the skipped-file count.

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

Running this skill does not register the schedule by itself — `/workbench-core:setup` Step 4.6 registers it by default (or deploy it manually with the payload above). Manual invocations between scheduled runs are always fine; the cap and the report remainder make runs resumable.

## Safety rails

- **Never touch `*.log.md`.** Raw transcripts are write-only archival, excluded from indexing by design. They are not lint targets — not for frontmatter, not for links, not for anything.
- **Never delete documents.** Broken-link repair removes link markup at most, never content, never files.
- **Cap of 50 file-fixes per run.** Bounded session cost beats heroics. Report the remainder.
- **Flag, don't merge.** Duplicates and contradictions go in the report for the human; this skill never consolidates documents on its own.
- **All writes go through the MCP** (`write`/`edit`) so the index stays consistent with disk. The only filesystem reads are for skipped (unindexed) files; never write with the filesystem tools. Never call `reindex` after MCP writes — the index updates immediately.
- **Verify before batching.** The first frontmatter rescue must round-trip through `search` before the rest are processed.

## Notes

- A skipped file with *malformed* frontmatter (bad YAML) needs its broken header replaced, not a second header prepended — preserve any salvageable fields from it.
- If `stats` is unreachable, stop — there's no safe lint without a before-snapshot. Report the MCP failure instead.
- All MCP paths are vault-relative; absolute paths are only for the `find` comparison and filesystem `Read` of unindexed files.
