# Session Summary Format

Reference document for any skill or agent that writes session summaries.

## File path

Replace `.log.md` with `.summary.md` in the log filename:

```
log:     sessions/2026-04-09/{session-id}.log.md
summary: sessions/2026-04-09/{session-id}.summary.md
```

Write via `mcp__plugin_workbench_memory__write`. Paths are **relative to the vault root**, e.g. `sessions/2026-04-09/{session-id}.summary.md`.

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
summary: |
  One or two sentences answering "what happened in this segment"
  without opening the body. This is the vault search snippet.
---
```

- `name` and `type` are required by the vault config.
- `mode: auto` for hook-dispatched summaries, `mode: manual` for `/log-now`.

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
