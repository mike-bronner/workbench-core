---
name: session-log
description: Runs automatically on PreCompact and SessionEnd via hooks. Dumps the raw JSONL segment to a rolling per-session log file and spawns a background summary-writer agent.
---

# Session Log

Shell script (`run.sh`) invoked by `PreCompact` and `SessionEnd` hooks, and by `/workbench:log-now` (with `WORKBENCH_LOG_MODE=manual`).

## What it does

1. Reads hook payload (`session_id`, `transcript_path`, `hook_event_name`).
2. Determines mode: `checkpoint` (PreCompact), `final` (SessionEnd), `manual` (/log-now).
3. Loads per-session checkpoint to find where it left off.
4. Appends the new JSONL segment to a **single rolling log** at `sessions/YYYY-MM-DD/{session-id}.log.md`.
5. Updates the checkpoint.
6. Writes a pending-summary marker.
7. Spawns a background summary-writer agent (model configurable via `summary_model`, default: haiku).

## Shell-only constraints

Hooks can't reach MCPs, so this script only does the mechanical half. Narrative summaries, decision promotion, and profile updates are handled by the summary-writer agent (or inline by `/workbench:log-now`). See `references/` for the shared formats.

## Not user-invocable

Use `/workbench:log-now` for manual logging.
