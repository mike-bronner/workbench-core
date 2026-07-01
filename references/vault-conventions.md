# Vault Conventions

Reference document for any skill or agent that reads or writes to the
operational memory vault.

## Paths

All paths passed to `mcp__plugin_workbench-core_memory__*` tools are **relative
to the vault root** (configured in `memory_path`, typically
`~/Documents/Claude/Memory/`). Never pass absolute paths to the MCP.

Write vault files **only through the memory MCP** — never with Bash/shell
redirection (`>`, `tee`, `cp`, heredoc). A shell write resolves against the
current directory, which is not guaranteed to be the vault, so it can silently
escape into whatever project you happen to be in.

```
Good:  sessions/2026-04-09/abc123.summary.md
Bad:   $HOME/Documents/Claude/Memory/sessions/2026-04-09/abc123.summary.md
Bad:   memory/sessions/2026-04-09/abc123.summary.md   (a `memory/` prefix escapes the vault root)
```

## Required frontmatter

The vault enforces two required fields: `name` and `type`. Every document
must have both.

```yaml
---
name: "Short descriptive title"
type: session|decision|topic|identity|project|insight|skill-learnings|index|maintenance
---
```

## Common indexed fields

These fields are indexed for search: `name`, `type`, `tags`, `summary`,
`date`, `scope`, `log_files`.

## Writing vs editing

- **`write`** — creates a new file or overwrites completely. Use for new
  documents.
- **`edit`** — targeted text replacement within an existing file. Use for
  small updates (adding a bullet, updating a date). Read the file first
  to get the correct text to replace.

## Profile updates

`identity/profile.md` tracks user preferences and working style. Only
update when the session revealed a genuine, repeated preference shift —
not a one-off mood. Small delta: add or replace a bullet, don't rewrite
the file. Use `edit`, not `write`.

## Vault structure

```
identity/        — soul-hot, soul-core, profile, skills-protocol
decisions/       — architectural and process decisions
topics/          — topical synthesis pages (current state per theme)
projects/        — project context and system designs
insights/        — durable patterns and working principles
sessions/        — session logs (.log.md) and summaries (.summary.md)
skills/          — per-skill learnings files
infrastructure/  — systems and tools documentation
maintenance/     — memory-lint audit reports
index.md         — catalog of the curated layer (see linking-synthesis.md)
```

## Linking

Documents connect via path-qualified wikilinks —
`[[folder/file-stem|display text]]`, vault-relative, no `.md` extension.
See `linking-synthesis.md` for the full syntax rules, the topic-page
contract, the `index.md` maintenance contract, and the conservative-linking
rules that bind every ingest.
