---
name: session-wrap
description: Runs automatically on PreCompact and SessionEnd via the core plugin's hooks. Dumps the raw JSONL segment to disk and marks a pending-wrap for the next session to turn into a narrative.
---

# Session Wrap

This skill is a shell script (`run.sh`) invoked by the `core` plugin's `PreCompact` and `SessionEnd` hooks. It also runs — with `HOBBES_WRAP_MODE=manual` — when the user invokes `/log-now`.

It does the **mechanical** half of wrapping only. The narrative summary, journal line, and decision promotions happen on the next session start (or inline during `/log-now`, where the model still has MCP access).

## What the script does

1. Reads the hook payload from stdin (`session_id`, `transcript_path`, `hook_event_name`).
2. Determines the wrap mode:
   - `PreCompact` → `checkpoint`
   - `SessionEnd` → `final`
   - `/log-now` → `manual` (via `HOBBES_WRAP_MODE` env var)
3. Finds the last wrap checkpoint (`~/.claude-memory-cache/wrap-checkpoint.json`) to know which line in the transcript to start from. Same-session checkpoints are respected; new sessions start fresh.
4. Tails the transcript from that line to the current end of file.
5. Writes a raw log file to `~/Documents/Claude/Memory/sessions/YYYY-MM-DD/{session-id}-{timestamp}-{mode}.log.md`. Frontmatter: `name`, `type: session`, `scope: chronological`, `date`, `tags`, `session_id`, `mode`, `event`, `transcript`, `start_line`, `end_line`, `summary: |`.
6. Updates the checkpoint with the next line to read.
7. On `final` or `manual` wrap, writes `~/.claude-memory-cache/pending-wraps/{session-id}.json` pointing at the new log file. The next `session-warmup` scans this directory and surfaces all pending markers. Each session's marker lives in its own file so multiple concurrent sessions can all leave markers without clobbering each other (fix for the 2026-04-09 multi-session race).

## Why the work is split between shell and model

PreCompact and SessionEnd hooks are shell scripts. Shell scripts cannot call MCPs, so they can't:

- Write to Apple Notes (Apple Notes MCP lives behind the model)
- Call `hobbes-memory` tools (also an MCP)
- Do judgment work like "is this a decision?" or "what mattered in this segment?"

So the script captures the data losslessly and punts the semantic half to the next session's warmup — which *can* reach MCPs and *can* make those judgments.

The one exception is `/log-now`: the manual invocation happens in an active model turn, so the model runs the script, then does the narrative half immediately in the same turn.

## Environment variables

- `HOBBES_MEMORY_PATH` — override the memory store path. Default `/Users/mike/Documents/Claude/Memory`.
- `HOBBES_MEMORY_CACHE` — override the cache path. Default `$HOME/.claude-memory-cache`.
- `HOBBES_WRAP_MODE` — explicit mode override (`checkpoint`, `final`, or `manual`). Normally inferred from `hook_event_name`. `/log-now` sets this to `manual`.

## Failure mode

If the script can't find the transcript, it exits 0 silently. Wrap failures must never break hook execution. Worst case: the session ends without a log entry. The next `session-warmup` finds no pending-wrap and proceeds as if everything was fine.

If the script finds a transcript but there's no new content since the last checkpoint, it also exits 0 without writing. This avoids empty log files on rapid `/log-now` invocations.
