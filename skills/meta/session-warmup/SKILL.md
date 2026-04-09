---
name: session-warmup
description: Runs automatically at session start via the core plugin's SessionStart hook. Injects identity, profile, and any pending-wrap notice from the previous session.
---

# Session Warmup

This skill is a shell script (`run.sh`) invoked by the `core` plugin's `SessionStart` hook. The model does not invoke it directly — by the time you (the assistant) see its output, it's already in your context as part of session initialization.

## What the script does

1. Reads the `SessionStart` hook payload from stdin — specifically the `source` field (`startup`, `resume`, `clear`, or `compact`).
2. Branches on `source`:
   - **`startup`** — full warmup: loads `identity/soul-hot.md` + `identity/profile.md`, plus the pending-wrap check.
   - **`resume`** — minimal: identity is already in the carried-over context, so just the pending-wrap check.
   - **`clear`** — identity only: a `/clear` follows a `SessionEnd` that already wrapped, so skip the pending-wrap check.
   - **`compact`** — no-op: the context was just compressed; don't pile more in right now.
3. Checks for `~/.claude-memory-cache/pending-wrap.json`. If it exists, the previous session (or compact) ended without a narrative summary, and the raw log is waiting to be turned into a proper wrap.

## Your job when you see a pending-wrap notice

The notice means: the last session's `session-wrap` hook dumped a raw JSONL segment to disk, but couldn't do the narrative half (hooks can't reach MCPs). That's your first task for this session, before any new work:

1. **Read the raw log** at the path named in the notice.
2. **Write a sibling `.summary.md` file** in the same `sessions/YYYY-MM-DD/` directory. Frontmatter: `name`, `type: session`, `scope: chronological`, `date`, `tags: [session, summary]`, `summary: |`. Body: a tight narrative — what happened, what got decided, what's still open.
3. **Append a short BuJo line to today's Apple Notes daily journal** (note title `YYYY-MM-DD — Weekday`) using `mcp__Read_and_Write_Apple_Notes__update_note_content`. BuJo signifiers in Menlo-Regular monospace per `~/.claude/CLAUDE.md`. Include a pointer to the log/summary path so Mike can open the detail.
4. **Promote any decisions** — if the session contained a real architectural / tool / process decision with rationale, write it to `~/Documents/Claude/Memory/decisions/YYYY-MM-DD-slug.md` via the `hobbes-memory` MCP (`mcp__memory__create_entities` or the equivalent write tool on the `hobbes-memory` server).
5. **Update profile if shifted** — if Mike's preferences or working style changed, edit `~/Documents/Claude/Memory/identity/profile.md`.
6. **Delete the pending-wrap marker** — `rm ~/.claude-memory-cache/pending-wrap.json`. This clears the flag so the next warmup doesn't re-prompt you.

Do this proactively at session start, without being asked. No new work begins until the last session's wrap is recorded.

## Why this is split between shell and model

The shell script runs inside the `SessionStart` hook, which executes before any MCP tools are available to the model. So the script handles the mechanical parts (cat identity files, check for pending-wrap) and the model handles everything that needs MCP access (Apple Notes journal, `hobbes-memory` writes).

## Manual invocation

Not supported. Warmup is a lifecycle thing. If you want to force a fresh wrap of the current segment, use `/log-now` instead.
