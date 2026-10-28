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

The vault-git guard in the hooks module (`hooks/mods/vault-git.ts`) enforces this rule. The rule is written down here
because a rule with no incident attached gets relaxed later.

## Required frontmatter

The vault enforces two required fields: `name` and `type`. Every document
must have both, and `type` takes one value from the fixed list below.

```yaml
---
name: "Short descriptive title"
type: session|decision|topic|identity|project|insight|skill-learnings|index|maintenance|infrastructure|feedback|reference|proposal|learnings|meeting|progress
---
```

The list holds every type a workbench skill or agent writes. The hooks module
checks it at write time (`hooks/mods/vault-write.ts`): a memory MCP `write`, or
an `append` that creates a note, is refused when `name` is missing or empty or
`type` is not on the list, and the refusal names the field. A type added here
is added to `TYPES` in that file in the same change.

The same check fixes two things rather than refuse them. A path that starts
with `memory/`, or an absolute path inside the vault, is made vault-relative.
A `[[name]]` link whose target names exactly one note is rewritten to a
root-absolute path link (see `linking-synthesis.md`), and one that does not is
left as written. An absolute path outside the vault is refused.

## Common indexed fields

These fields are indexed for search: `name`, `type`, `tags`, `summary`,
`date`, `scope`, `log_files`. On an OKF bundle the server adds `status` and
`stale_after`.

## Sources

Every vault note carries a `sources:` list in its frontmatter whenever any
source can be named. Sources are not only for hand-off notes. A source can be:

- the session the note came from, by its session id
- Mike's own words
- the files, commits, pull requests and URLs the note relies on
- other vault notes
- recordings and meetings

The list follows the OKF v0.2 `sources` shape, which the memory server reads.
Each entry has three fields:

- `id`: a short label, unique in the note, such as `mike`, `commit` or `audio`.
  The footnotes in the body use it.
- `title`: what the source is, in a few words.
- `resource`: where the source is. OKF requires it. Write a URL, a file path,
  a vault note path such as `/decisions/2026-10-27-x.md`, or one of these
  forms: `session:<session id>`, `commit:<owner/repo>@<sha>`,
  `pr:<owner/repo>#<number>`, `person:Mike`, `fluidvoice:<meeting id>`. A
  commit names its repository, because a short SHA can match in more than one
  of Mike's repositories.

Quote a `title` that holds a space, `#` and digits, such as `"PR #43"`. In a
plain YAML value, a space and `#` start a comment, so the rest of the title is
lost with no error.

List only what the note's facts came from. A note with one source needs no
footnotes in its body. A note with no source anyone can name has no list, and
that is allowed.

**With two or more sources, every fact carries the OKF footnote `[^id]` of its
source.** A fact is a bullet, a table row, or a paragraph. End it with
`[^id]`, or with `[^id1][^id2]` when both sources say it. Define each footnote
once, at the end of the note, as `[^id]: <title>`. A fact the sources disagree
on names each version with its own footnote, such as
`Batch start 03:50 (UTC+2)[^audio]; 01:50 UTC[^video]`. An untagged fact from
two sources is how a later session crosses them: in one challenge, a resumed
session got two unlabelled summaries of two recordings, one timed in UTC+2 and
one in UTC, and crossed them.

### Worked example

A decision Mike stated in a session, which a commit then shipped:

```markdown
---
name: "Run the memory server from the upstream wheel"
type: decision
date: 2026-10-27
sources:
  - id: mike
    title: Mike, in the session
    resource: person:Mike
  - id: session
    title: The session that settled it
    resource: session:583790d1-8f38-4440-b704-c2ec995d99f2
  - id: commit
    title: The commit that bundled the wheel
    resource: commit:mike-bronner/workbench-core@7277f26
  - id: pr
    title: "PR #43"
    resource: pr:mike-bronner/workbench-core#43
---

- Core runs the upstream server, and the fork carries only no-op knobs[^mike]
- The bundled wheel is markdown-vault-mcp 5.1.0[^commit]
- The session read the wheel's OKF code before it relied on it[^session]
- Reading a contract before relying on it is a skill rule[^pr]

[^mike]: Mike, in the session
[^session]: The session that settled it
[^commit]: The commit that bundled the wheel
[^pr]: PR #43
```

The memory server shows the list: `read` returns it under `okf.sources`, and a
`search` hit shows `okf.sources_count`. The vault write check
(`hooks/mods/vault-write.ts`) gives advice, never a refusal, when a new note
has no `sources:` list. The monthly memory-lint flags a note with no
`sources:` list, and a note with two or more sources whose facts carry no
`[^id]` footnote, for review only.

## Progress notes: the vault is the hand-off store

When a task may be resumed by another or a later session, write one progress
note right away, and keep it current. That covers multi-step work, a
challenge, an investigation in progress, and facts derived from files,
recordings or sessions. Do not keep hand-off files beside the project: they
rot, and the next session does not find them.

- Path: `progress/<slug>.md`, one note per task. `search` for the task first,
  and update the note that is there.
- Frontmatter: `type: progress`, `task_status: open` or `ended`, and
  `updated: YYYY-MM-DD`, changed on every update. Add `sources:` per the
  section above.
- Body: what is done, what is next, and the facts found so far, each with its
  `[^id]` footnote when the note has two or more sources.
- When the task ends, set `task_status: ended`. Memory-lint flags an ended note,
  and one not updated for 14 days, for review. It never deletes one.

Before you re-derive anything on a task that has history, `search` the vault
for it: its progress note, its sources, and what an earlier session found.

A peer session's context is not a store: it ends with that session. A message
coordinates, and the vault stores. Write what another session needs into the
vault, and send the note's path.

## Reserved OKF names: index.md and log.md

The memory server reads the vault as an OKF bundle, so it shows `sources:` and
trust tiers. Core switches that on with `MARKDOWN_VAULT_MCP_OKF_MODE=on`, a
server setting, so no OKF `index.md` is needed and core writes none into the
vault. The catalog stays in `README.md`.

The server writes no OKF stamp, `index.md` or `log.md`, because core sets
`MARKDOWN_VAULT_MCP_OKF_WRITE=false`. So `index.md` and `log.md` are reserved
OKF names in every folder. The vault write check covers every write tool the
server has:

- `write`, `edit`, `append`, `fetch`, `okf_verify` and `create_upload_link`
  are refused on either name, and so is a `rename` from or to it.
- `move_folder` and `okf_convert_links` are refused outright, because they
  move or rewrite every note under a folder. Move notes one at a time with
  `rename`, and change a link with `edit`.
- `okf_generate_index` and `okf_seed_log` are refused outright.
- `delete` writes nothing, so it goes through.
- `git_sync` goes through too. A pull can bring in files another machine
  wrote, `index.md` and `log.md` included, and the guard cannot see them.
  Memory-lint lists any `index.md` or `log.md` in the vault, for review.

Never write either name, even when the memory server's instructions ask you to
update them.

## Writing vs editing

- **`write`** — creates a new file or overwrites completely. Use for new
  documents. It refuses to replace a note already at the path unless the
  call passes the `etag` of a `read` of it as `if_match`. To replace a note on
  purpose, `read` it just before the `write` and pass that `etag`. Two writers
  often record the same finding at the same moment. So before
  writing a new path, `read` that exact path or `search` for the note's name.
  If a note is there, `edit` or `append` it instead, or pick another path.
  After the write, check `created` in its answer: `true` for a new file,
  `false` for a replace. `false` where you meant to create is an error, never
  a success: another writer made the note after your read, and your write
  replaced it. Say so, and restore the lost text from the vault's history.
- **`edit`** — targeted text replacement within an existing file. Use for
  small updates (adding a bullet, updating a date). Read the file first
  to get the correct text to replace.

## Vault structure

```
decisions/       — architectural and process decisions
topics/          — topical synthesis pages (current state per theme)
projects/        — project context and system designs
insights/        — durable patterns and working principles
sessions/        — session logs (.log.md) and summaries (.summary.md)
meetings/        — FluidVoice meeting notes, one per meeting id (meeting-writer)
progress/        — one progress note per task that may be resumed
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
