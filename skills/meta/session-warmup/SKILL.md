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
3. Scans `~/.claude-memory-cache/pending-wraps/` for per-session marker files. If any exist, previous sessions ended (or compacted) without a narrative summary and the raw logs are waiting to be turned into proper wraps. Also reads legacy `~/.claude-memory-cache/pending-wrap.json` (single-file format) if present — for backward compatibility with core ≤ 0.1.4.

## Your job when you see a pending-wrap notice

The notice means: a previous session's `session-wrap` hook dumped a raw JSONL segment to disk, but couldn't do the narrative half (hooks can't reach MCPs). If the notice lists multiple pending wraps, handle each in turn. That's your first task for this session, before any new work:

1. **Read the raw log** at the path named in the notice. For wraps from the current project/cwd, also check the same `sessions/YYYY-MM-DD/` directory for any earlier checkpoint logs from the same `session_id` — if there were mid-session compacts, the current segment may be the last of several. Summaries should cover all the logs they're based on. For wraps from other projects (e.g. cron runs from another repo), a thinner summary is fine — don't fabricate context you don't have.
2. **Write a sibling `.summary.md` file** in the same `sessions/YYYY-MM-DD/` directory. Frontmatter: `name`, `type: session`, `scope: chronological`, `date`, `tags: [session, summary]`, `log_files: [list of log paths this summary covers]`, `summary: |`. Body: a tight narrative — what happened, what got decided, what's still open. Include a "Logs" section at the bottom that lists each log path explicitly — the summary is the index, the log is the full context. Only summaries are indexed by the memory MCP (log files are excluded via `MARKDOWN_VAULT_MCP_EXCLUDE`), so anyone searching memory will land on a summary and follow the `log_files` pointer when they need the raw transcript.
3. **Append a short BuJo line to today's Apple Notes daily journal** (note title `YYYY-MM-DD — Weekday`) using `mcp__Read_and_Write_Apple_Notes__update_note_content`. BuJo signifiers in Menlo-Regular monospace per `~/.claude/CLAUDE.md`. Include a pointer to the log/summary path so Mike can open the detail. **Important — the Apple Notes MCP has no partial-edit mode.** Every invocation of `update_note_content` replaces the ENTIRE note body regardless of parameters. `mode: "append"`, `mode: "replace"`, AND `find_text` + `new_content` all do full-body replacement. The only safe pattern is: (1) call `get_note_content` to read the current body, (2) splice your new line in at the right position in-memory, (3) call `update_note_content` with the complete new body. Never optimize this loop — a forgotten read step destroys the note.
4. **Promote any decisions** — if the session contained a real architectural / tool / process decision with rationale, write it to `~/Documents/Claude/Memory/decisions/YYYY-MM-DD-slug.md` via the `hobbes-memory` MCP (`mcp__memory__create_entities` or the equivalent write tool on the `hobbes-memory` server).
5. **Update profile if shifted** — if Mike's preferences or working style changed, edit `~/Documents/Claude/Memory/identity/profile.md`.
6. **Delete the specific marker file** for the wrap you just handled — `rm ~/.claude-memory-cache/pending-wraps/<session_id>.json` (or for legacy backward-compat: `rm ~/.claude-memory-cache/pending-wrap.json`). Don't delete the whole `pending-wraps/` directory if there are still markers from other sessions. This clears the flag so the next warmup doesn't re-prompt you for this wrap.

Do this proactively at session start, without being asked. No new work begins until all pending wraps are recorded.

## Why this is split between shell and model

The shell script runs inside the `SessionStart` hook, which executes before any MCP tools are available to the model. So the script handles the mechanical parts (cat identity files, check for pending-wrap) and the model handles everything that needs MCP access (Apple Notes journal, `hobbes-memory` writes).

## Manual invocation

Not supported. Warmup is a lifecycle thing. If you want to force a fresh wrap of the current segment, use `/log-now` instead.
