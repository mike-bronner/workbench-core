# Session Summary Format

Reference document for any skill or agent that writes session summaries.

## File path

Replace `.log.md` with `.summary.md` in the log filename:

```
log:     sessions/2026-04-09/{session-id}.log.md
summary: sessions/2026-04-09/{session-id}.summary.md
```

Write via `mcp__plugin_workbench-core_memory__write` **only** — never with Bash (`>`, `>>`, `tee`, `cp`, `sed -i`, heredoc). Paths are **relative to the vault root**, e.g. `sessions/2026-04-09/{session-id}.summary.md`.

```
Good:  sessions/2026-04-09/{session-id}.summary.md
Bad:   memory/sessions/2026-04-09/{session-id}.summary.md   (a `memory/` prefix nests a copy inside the vault, or via Bash escapes into the source project)
Bad:   /Users/…/Documents/Claude/Memory/sessions/…          (absolute paths are rejected by the MCP)
```

## Required frontmatter

```yaml
---
name: "Session summary — {short description}"
type: session
scope: chronological
date: YYYY-MM-DD
tags: [session, summary, ...topic-tags]
session_id: <matches the log>
mode: auto|manual
log_files:
  - /absolute/path/to/session.log.md
sources:
  - id: session
    title: The session this summary covers
    resource: "session:<session_id>"
summary: |
  One or two sentences answering "what happened in this segment"
  without opening the body. This is the vault search snippet.
---
```

- `name` and `type` are required by the vault config.
- `mode: auto` for hook-dispatched summaries, `mode: manual` for `/log-now`.
- `sources` lists what the summary's facts came from, in the OKF
  `{id, title, resource}` shape of `vault-conventions.md` (Sources). Every summary carries it. The
  session itself is always one entry, and Mike's own words are another when a
  fact rests on what he said. Add an entry for each file, commit, pull request,
  URL, vault note, recording or meeting that the transcript shows the session
  read, when a fact in the summary came from that read: a `Read` of a file, a
  fetch of a URL, a transcription of a recording. List nothing the session did
  not read.

## Source tags

With two or more sources, end each fact in the body with the OKF footnote
`[^id]` of its source, and define each footnote once at the end of the
summary, as `vault-conventions.md` defines. Two recordings timed in different
time zones are the case this rule exists for:

```markdown
- Batch start 03:50 (UTC+2)[^audio]; 01:50 UTC[^video]

[^audio]: The audio recording
[^video]: The screen recording
```

A fact the session worked out itself, with no file behind it, takes the
`[^session]` footnote. A summary with only the session as a source needs no
footnotes.

## Body structure

```markdown
# {same as name in frontmatter}

## What happened

- 2 to 5 bullets. Focus on outcomes and artifacts, not keystrokes.
- Lead with the biggest thing that changed.
- Name files that were created or modified, by path.
- Name tools that were dispatched (agents, MCPs, commands).

## What got decided

Any explicit decision worth remembering. If none, write "No new decisions in this segment."

## What's still open

Loose ends, next steps, anything flagged as TODO or blocked. If none, write "Nothing open."

## Related

- Root-absolute markdown links to confidently-related vault documents, one per
  line with a short reason — see `linking-synthesis.md` for the search
  procedure, link syntax, and the conservative-linking rules. Omit this
  section entirely when nothing clears the confidence bar.

## Logs

- `/absolute/path/to/session.log.md`
```

## Reading raw JSONL

The log body is a fenced `jsonl` block. Each line is a JSON object representing one turn in the Claude Code transcript. Useful fields:

- `type: "user"` — user messages (prompts)
- `type: "assistant"` — look at `message.content[].text` for narration, `message.content[].input` for tool calls
- `type: "tool_use"` / tool calls nested in assistant messages — what tools were dispatched
- `type: "tool_result"` — results of tool calls

You don't need to parse every line. Skim for: user prompts (what was asked), file writes/edits (what changed), Bash commands (what was run), agent dispatches (subtasks spawned), and errors.

## Quality guidance

- **Thin summaries are fine.** A 3-line summary pointing at the log is better than a padded one that hallucinates motivation.
- **Never invent content.** If the log is a short cron run or unfamiliar project, say so.
- **Outcome-focused.** Lead with what changed, not what was attempted.
