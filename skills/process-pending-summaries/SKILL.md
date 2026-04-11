---
description: Process any pending session summaries by dispatching background agents. Use when the warmup notices unprocessed markers, or run manually to clear the backlog. Does NOT block the session — dispatches agents in the background and moves on.
---

This is an execution-aware skill — check `skills/process-pending-summaries.learnings.md` in the vault before proceeding. If it exists, apply accumulated learnings.

The user has invoked `/workbench:process-pending-summaries`, or the session warmup detected pending markers and asked you to handle them.

## Step 1 — Find pending markers

Scan `~/.claude-memory-cache/pending-summaries/` for `.json` marker files:

```bash
ls ~/.claude-memory-cache/pending-summaries/*.json 2>/dev/null
```

If none exist, tell the user there's nothing pending and exit.

## Step 2 — Dispatch background agents

For each marker, read it to get the `session_id`, `marker_path`, and `log_path`. Then spawn a background `summary-writer` agent:

```
Agent tool:
  subagent_type: workbench:summary-writer
  run_in_background: true
  prompt: |
    Process pending session summary.
    session_id: {session_id}
    marker_path: {marker_path}
    log_path: {log_path}
    Follow your agent definition. Write the summary, promote any decisions, delete the marker, and exit.
```

Dispatch all agents in a single turn — don't wait for one to finish before starting the next.

## Step 3 — Report and move on

Tell the user how many summaries were dispatched (e.g. "Dispatched 3 background summary-writers. They'll process in the background — you can work normally.").

Then proceed with whatever the user actually wanted to do this session. Do NOT wait for the agents to complete.
