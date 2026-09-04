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

## The vault is a git repo, and it is not yours

The vault is a git repository, and the **memory server owns it**. The server
commits and pushes on its own **deferred queue**: writes are batched, committed
under a message naming the note that was written, and pushed after a period of
write-idle. That queue is why cross-machine memory works at all.

**Never run a git write command in the vault.** Not `commit`, `add`, `rm`, `mv`,
`reset`, `checkout`, `restore`, `stash`, `merge`, `rebase`, `revert`, `clean`,
`apply`, `push`, `pull`, `fetch`, or `init`. A staged change does not sit and
wait for you — the server sweeps whatever it finds in the index into its next
commit, under that commit's unrelated message.

**Use the MCP tools instead.** To delete a note, use `delete`. To change one,
use `edit`, `write`, or `append`. To move one, use `rename`. To force a sync
right now, use `git_sync`. Each produces its own accurately-named commit.

**Reading with git is fine and encouraged** — `status`, `log`, `show`, `diff`,
`ls-files`, `rev-parse`, `blame`, `git grep`. Those are how you inspect vault
history, and nothing about them touches the server's queue.

### Why this rule exists — the 2026-09-04 incident

An agent deleted a profile note with a shell command:

```
git -C ~/Documents/Claude/Memory rm identity/profile.md
```

That staged the deletion and stopped. The server's next write swept it into
commit **`014f51b1`**, whose message reads
`write: insights/credential-guard-blocks-prose-about-dotenv.md`. So vault
history now records a 71-line profile deletion under a message about an
unrelated note being written. Nothing in that commit says a profile was lost.
The `delete` tool was available the whole time and would have produced a commit
that said so.

`hooks/vault-git-guard.sh` enforces this rule. The rule is written down here
because a rule with no incident attached gets relaxed later.

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
README.md         — catalog of the curated layer (see linking-synthesis.md)
```

## Linking

Documents connect via root-absolute markdown links —
`[display text](/folder/file-stem.md)`, resolved from the vault root.
See `linking-synthesis.md` for the full syntax rules, the topic-page
contract, the `README.md` maintenance contract, and the conservative-linking
rules that bind every ingest.
