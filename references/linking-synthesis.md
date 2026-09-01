# Linking & Topical Synthesis

Reference document for any skill or agent that ingests a session into the
vault (summary-writer, log-now, summarize-session). Defines the shared
linking habit: connect each new summary into the existing wiki layer,
maintain topical synthesis pages, and keep the vault index current.

Why this exists: a vault that only accretes chronological session summaries
becomes unlinked sediment — hundreds of documents, near-zero links, and a
link graph (backlinks, similar documents, connection paths) that sits idle.
Every ingest should leave behind a few high-confidence connections so the
curated layer (topics, decisions) grows as a navigable wiki.

## Wikilink syntax — what the indexer actually resolves

The vault is served by markdown-vault-mcp, which extracts `[[wikilinks]]` in
the form `[[target]]` or `[[target|display text]]`. Resolution is **by
path**, not by title:

- **Always write path-qualified wikilinks**: the target is the
  vault-relative path without the `.md` extension, e.g.
  `[[decisions/2026-06-11-prefer-x|Prefer X over Y]]`. The indexer appends
  `.md` and matches the document path exactly, so the link resolves the
  moment it is written.
- **Never write bare-stem wikilinks** like `[[prefer-x]]`. Bare stems are
  only resolved vault-wide during a full reindex — between reindexes they
  register as broken links.
- Use the `|display text` alias so prose stays readable; the part before
  `|` must be the path.

```
Good:  [[decisions/2026-06-11-prefer-x|the X-over-Y decision]]
Good:  [[topics/memory-architecture]]
Bad:   [[prefer-x]]                      (bare stem — broken until reindex)
Bad:   [[Prefer X over Y]]               (title — never resolves)
```

## Hard rules — conservative linking

- **Only link what you are confident is meaningfully related.** An orphan
  is better than a forced connection. Signal-to-noise is sacred: a vault
  where everything links to everything carries no information.
- **Cap: at most 8 links added per session ingest** across all documents
  (Related section, topic page, decision cross-links, index lines that add
  wikilinks all count).
- **At most one topic page touched per session** — the central theme only,
  never every tangent.
- **Never link a document you have not confirmed exists.** Only write a
  wikilink to a path that a `search` or `list_documents` call actually
  returned in this session. Do **not** construct a path from a naming
  convention and assume the file is there.
- **Never link a session summary you are not yourself writing.** In
  particular, never build `sessions/<date>/<session-id>.summary` from a
  session id you saw in a log, a scheduled-task record, or another page.
  Idle ticks are *deliberately* never summarised (see the idle-tick skip in
  `agents/summary-writer.md`), so a constructed link to one is broken from
  birth — and because topic pages are append-only narrative, nothing ever
  revisits that line to repair it. Refer to such a session by its id as
  **plain text**, not as a wikilink.

Why these two rules exist: the 2026-08-19 memory-lint found 61 session
summaries linked from vault pages that exist nowhere on disk, unrecoverable
(no logs, no transcripts). 33 of them were idle ticks that were never going to
have a summary. Every one of those links was written by an agent that inferred
a path instead of verifying one. A link is a claim about the vault's contents —
do not make the claim without checking.

## Step A — Search for related documents

After drafting the summary, before writing it: run 2–3 targeted `search`
calls (mode `hybrid` when available) built from the session's main themes —
look for prior decisions, topic pages, and earlier summaries on the same
subjects. Note the `path` of each confident hit; paths are what wikilinks
target.

## Step B — `## Related` section in the summary

Add a `## Related` section to the summary body (between "What's still open"
and "Logs") listing wikilinks to the confidently-related documents found in
Step A, one per line with a short reason:

```markdown
## Related

- [[decisions/2026-05-02-vault-mcp-fork|Vault MCP fork decision]] — this session built on that install path
- [[topics/memory-architecture]] — central theme of this session
```

If nothing clears the confidence bar, omit the section entirely. Do not pad.

## Step C — Topical synthesis pages (`topics/`)

Topic pages live in `topics/` and are **syntheses, not logs**: each states
the current understanding of one theme in a few sentences and links the
documents behind it.

Required frontmatter:

```yaml
---
name: "{topic title}"
type: topic
scope: topical
tags: [...]
date: YYYY-MM-DD   # last updated
summary: |
  One or two sentences: the current state of this topic.
---
```

Decide for the session's **central theme only** (one topic page per session
maximum):

- **A topic page for the theme already exists** → `edit` it (read first),
  **but only if the session changed what the page says**. See "What earns
  an entry" below. When it does: add a dated entry — 1–2 lines plus a
  wikilink to the new summary and/or decision — and **integrate**: update
  any statement on the page that the session made outdated, refresh `date`
  and `summary` if the state changed. Keep the page a synthesis; never let
  it degrade into a chronological dump.
- **No topic page exists AND the vault now holds ≥2 related documents on
  the theme** (from Step A) → create one: synthesize the current state in
  2–5 sentences from those documents and wikilink each of them.
- **Neither** → skip. Most sessions don't move a topic.

### What earns an entry

"Append a dated entry every session" and "never let it degrade into a
chronological dump" cannot both hold without a bound. Unbounded, the
append wins: `topics/dev-team-orchestration.md` reached **393 KB / 1,311
lines** under a single heading, one paragraph per 20-minute scheduled
tick, past the `read` cap and unreadable whole. The bound is what the
entry is *for*.

An entry earns its place when the session **changed what the page says**:

- a new failure mode, root cause, or constraint the page did not describe
- a policy or architecture decision that supersedes something on the page
- a correction — the page asserts something the session proved wrong
- a milestone that moves the theme's state (shipped, reverted, abandoned)

It does **not** earn a place when the session merely *exercised* the
theme. Routine runs, scheduled ticks, and repeat instances of a pattern
already described are already recorded in their session summary; a
pointer to each one on the topic page adds a line and no understanding.

The test: **would a reader who already knows this page be told something
new?** If not, the summary is the record. Skipping is the common case for
recurring machinery, exactly as skipping a decision promotion is.

When the theme's Nth instance *does* matter — a pattern recurring is
itself the finding — update the existing sentence to say so ("seen
four times, most recently 2026-08-27") rather than appending a fourth
near-identical paragraph.

## Step D — Decision cross-links

When a decision is promoted (see `decision-promotion.md`):

- The decision body gets a wikilink to its session summary, and to the
  topic page if one exists.
- The session summary's `## Related` section links the decision back.
- The topic page (if touched in Step C) links the decision too.

## Step E — Vault index (`index.md`)

`index.md` at the vault root is the catalog of the **curated layer** — the
orientation entry point an agent reads on demand before searching. It does
**not** list sessions (chronological sediment stays out).

Required shape:

```markdown
---
name: vault-index
type: index
summary: |
  Catalog of the vault's curated layer — topics, decisions, identity,
  reference docs. One line per document. Sessions are not indexed here.
---

# Vault index

## Topics

- [[topics/memory-architecture]] — how operational memory is stored, indexed, and linked

## Decisions

- [[decisions/2026-05-02-vault-mcp-fork|Vault MCP fork]] — superseded 2026-09-01: upstream merged the fixes, so the plugin installs from upstream

## Identity

- [[identity/profile|Profile]] — user facts and working preferences

## Reference / Other

- [[infrastructure/backup-strategy|Backup strategy]] — what gets backed up where
```

Maintenance contract:

- **When you create or update a topic page, or promote a decision**, update
  the corresponding index line in the same ingest pass — `edit` (read
  first), add or amend the one-liner. Entry format: wikilink + one-line
  hook describing why someone would open it.
- **If `index.md` does not exist** (first run), create it with the entries
  you know about — at minimum the documents you just wrote. It will be
  incomplete; the memory-lint ritual fills it out properly.
- Keep entries to one line each. The index is a map, not a summary.
