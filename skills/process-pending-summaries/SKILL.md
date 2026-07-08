---
description: Process any pending session summaries by dispatching background agents. Use when the warmup notices unprocessed markers, or run manually to clear the backlog. Does NOT block the session — dispatches agents in the background and moves on.
---

This is an execution-aware skill — check `skills/process-pending-summaries.learnings.md` in the vault before proceeding. If it exists, apply accumulated learnings.

The user has invoked `/workbench-core:process-pending-summaries`, or the session warmup detected pending markers and asked you to handle them.

## Step 1 — Find pending markers

Scan `~/.claude-memory-cache/pending-summaries/` for `.json` marker files:

```bash
ls ~/.claude-memory-cache/pending-summaries/*.json 2>/dev/null
```

If none exist, tell the user there's nothing pending and exit.

## Step 2 — Dispatch background agents (batched, oldest first)

Sort the markers **oldest first** by their `marked_at` field (fallback: file mtime) — the oldest sessions are closest to the raw-log retention horizon, so they must be summarized first.

Take at most **10** markers from the front of the sorted list. For each, read it to get the `session_id`, `marker_path`, and `log_path`. Then spawn a background `summary-writer` agent:

```
Agent tool:
  subagent_type: workbench-core:summary-writer
  run_in_background: true
  prompt: |
    Process pending session summary.
    session_id: {session_id}
    marker_path: {marker_path}
    log_path: {log_path}
    Follow your agent definition. Write the summary, promote any decisions, delete the marker, and exit.
```

Dispatch the batch in a single turn — don't wait for one to finish before starting the next. Never dispatch more than 10 at once: each agent reads a full session log, so an uncapped dispatch over a large backlog is a token burst with no upside.

## Step 3 — Report and move on

Tell the user how many summaries were dispatched and how many markers remain (e.g. "Dispatched 10 background summary-writers, 42 markers remaining — re-run `/workbench-core:process-pending-summaries` to continue draining.").

Then proceed with whatever the user actually wanted to do this session. Do NOT wait for the agents to complete. If markers remain, the next warmup (or a manual re-run) picks up the next batch.
