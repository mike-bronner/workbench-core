---
name: session-log
description: Runs automatically on PreCompact and SessionEnd via the core plugin's hooks. Dumps the raw JSONL segment to a rolling per-session log file and spawns a background summary-writer.
---

# Session Log

This skill is a shell script (`run.sh`) invoked by the `core` plugin's `PreCompact` and `SessionEnd` hooks. It also runs — with `WORKBENCH_LOG_MODE=manual` — when the user invokes `/log-now`.

It does the **mechanical** half of logging only. The narrative summary and decision promotions are handled by the background summary-writer agent (or inline during `/log-now`).

## What the script does

1. Reads the hook payload from stdin (`session_id`, `transcript_path`, `hook_event_name`).
2. Determines the log mode:
   - `PreCompact` → `checkpoint`
   - `SessionEnd` → `final`
   - `/log-now` → `manual` (via `WORKBENCH_LOG_MODE` env var)
3. Finds the per-session checkpoint (`~/.claude-memory-cache/log-checkpoints/<session-id>.json`) to know which line in the transcript to start from. Each session has its own checkpoint file so concurrent sessions don't stomp each other.
4. Tails the transcript from that line to the current end of file.
5. Writes to a **single rolling log file** per session at `~/Documents/Claude/Memory/sessions/YYYY-MM-DD/{session-id}.log.md`. First invocation creates the file with frontmatter; subsequent invocations append new segments.
6. Updates the checkpoint with the next line to read.
7. Writes a pending-summary marker at `~/.claude-memory-cache/pending-summaries/{session-id}.json`.
8. Spawns a background summary-writer agent (model configurable via `summary_model` in config.json, default: haiku). Output is discarded (`/dev/null`).

## Why the work is split between shell and model

PreCompact and SessionEnd hooks are shell scripts. Shell scripts cannot call MCPs, so they can't:

- Call `mcp__plugin_workbench_memory__*` tools
- Do judgment work like "is this a decision?" or "what mattered in this segment?"

So the script captures the data losslessly and dispatches the semantic half to the background summary-writer agent — which has MCP access and can make those judgments.

The one exception is `/log-now`: the manual invocation happens in an active model turn, so the model runs the script, then does the narrative half immediately in the same turn.

## Environment variables

- `WORKBENCH_MEMORY_PATH` — override the memory store path.
- `WORKBENCH_MEMORY_CACHE` — override the cache path.
- `WORKBENCH_LOG_MODE` — explicit mode override (`checkpoint`, `final`, or `manual`).
- `WORKBENCH_SUMMARY_MODEL` — override the summary-writer model.
- `WORKBENCH_AUTO_SUMMARIZE` — set to `1` or `true` to enable background summarization.
- `WORKBENCH_SKIP_LOG` — set to `1` to skip logging (used by summary-writer to prevent recursion).

## Failure mode

If the script can't find the transcript, it exits 0 silently. Log failures must never break hook execution. Worst case: the session ends without a log entry. The pending-summary marker is not written, and the next warmup proceeds normally.

If the script finds a transcript but there's no new content since the last checkpoint, it also exits 0 without writing.
