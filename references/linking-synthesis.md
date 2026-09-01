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

## Link syntax — what the indexer actually resolves

The vault is served by markdown-vault-mcp, which indexes **root-absolute
markdown links** in the form `[display text](/path/to/note.md)`. Resolution
is **by path**, not by title.

The vault was converted from `[[wikilinks]]` to this form on 2026-09-01 (7,620
links, graph preserved exactly). The server still resolves wikilinks, so old
ones are not broken — but **write markdown links from now on**. They render as
real links on GitHub, which wikilinks do not, and the vault is synced to a git
remote where that matters.

- **Always write a leading slash.** The path is resolved from the vault root.
  Without it the link resolves relative to the *source note's own folder*, so
  `[x](topics/y.md)` written inside `decisions/` looks for
  `decisions/topics/y.md` and silently breaks. This exact mistake produced six
  "repaired" links on 2026-08-19 that still did not resolve.
- **Always include the `.md` extension.** Unlike a wikilink, nothing is
  appended for you.
- **Never write a bare stem or a title.** The target is a real path or it is a
  broken link.
- **Never put a link inside a code span.** ``[label](/path.md)`` in backticks
  renders as literal text, not a link, and reads worse than the plain path
  would. If you want the path shown as code, write the path alone in backticks
  and put the link elsewhere in the sentence.

```
Good:  [the X-over-Y decision](/decisions/2026-06-11-prefer-x.md)
Good:  [Memory architecture](/topics/memory-architecture.md)
Bad:   [x](topics/memory-architecture.md)   (no leading slash — resolves from
                                             the source note's own folder)
Bad:   [x](/topics/memory-architecture)     (missing .md)
Bad:   `[x](/topics/memory-architecture.md)` (inside a code span — never a link)
```

## Hard rules — conservative linking

- **Only link what you are confident is meaningfully related.** An orphan
  is better than a forced connection. Signal-to-noise is sacred: a vault
  where everything links to everything carries no information.
- **Cap: at most 8 links added per session ingest** across all documents
  (Related section, topic page, decision cross-links, index lines that add
  links all count).
- **At most one topic page touched per session** — the central theme only,
  never every tangent.
- **Never link a document you have not confirmed exists.** Only write a
  link to a path that a `search` or `list_documents` call actually
  returned in this session. Do **not** construct a path from a naming
  convention and assume the file is there.
- **Never link a session summary you are not yourself writing.** In
  particular, never build `sessions/<date>/<session-id>.summary` from a
  session id you saw in a log, a scheduled-task record, or another page.
  Idle ticks are *deliberately* never summarised (see the idle-tick skip in
  `agents/summary-writer.md`), so a constructed link to one is broken from
  birth — and because topic pages are append-only narrative, nothing ever
  revisits that line to repair it. Refer to such a session by its id as
  **plain text**, not as a link.

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
subjects. Note the `path` of each confident hit; paths are what links
target.

## Step B — `## Related` section in the summary

Add a `## Related` section to the summary body (between "What's still open"
and "Logs") listing markdown links to the confidently-related documents found in
Step A, one per line with a short reason:

```markdown
## Related

- [Vault MCP fork decision](/decisions/2026-05-02-vault-mcp-fork.md) — this session built on that install path
- [Memory architecture](/topics/memory-architecture.md) — central theme of this session
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
  link to the new summary and/or decision — and **integrate**: update
  any statement on the page that the session made outdated, refresh `date`
  and `summary` if the state changed. Keep the page a synthesis; never let
  it degrade into a chronological dump.
- **No topic page exists AND the vault now holds ≥2 related documents on
  the theme** (from Step A) → create one: synthesize the current state in
  2–5 sentences from those documents and link each of them.
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

- The decision body gets a link to its session summary, and to the
  topic page if one exists.
- The session summary's `## Related` section links the decision back.
- The topic page (if touched in Step C) links the decision too.

## Step E — Vault index (`README.md`)

`README.md` at the vault root is the catalog of the **curated layer** — the
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

- [Memory architecture](/topics/memory-architecture.md) — how operational memory is stored, indexed, and linked

## Decisions

- [Vault MCP fork](/decisions/2026-05-02-vault-mcp-fork.md) — superseded 2026-09-01: upstream merged the fixes, so the plugin installs from upstream

## Identity

- [Profile](/identity/profile.md) — user facts and working preferences

## Reference / Other

- [Backup strategy](/infrastructure/backup-strategy.md) — what gets backed up where
```

Maintenance contract:

- **When you create or update a topic page, or promote a decision**, update
  the corresponding index line in the same ingest pass — `edit` (read
  first), add or amend the one-liner. Entry format: markdown link + one-line
  hook describing why someone would open it.
- **If `README.md` does not exist** (first run), create it with the entries
  you know about — at minimum the documents you just wrote. It will be
  incomplete; the memory-lint ritual fills it out properly.
- Keep entries to one line each. The index is a map, not a summary.
