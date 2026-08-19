---
description: Process any pending session summaries by dispatching background agents. Use when the warmup notices unprocessed markers, or run manually to clear the backlog. Does NOT block the session — dispatches agents in the background and moves on.
---

This is an execution-aware skill — check `skills/process-pending-summaries.learnings.md` in the vault before proceeding. If it exists, apply accumulated learnings.

The user has invoked `/workbench-core:process-pending-summaries`, or pending markers were reported in `~/.claude-workbench/warmup-notices.md` (the session warmup writes housekeeping state there rather than injecting it, to keep the warmup payload byte-stable and cacheable).

## Step 1 — Find pending markers

Scan `~/.claude-memory-cache/pending-summaries/` for `.json` marker files:

```bash
ls ~/.claude-memory-cache/pending-summaries/*.json 2>/dev/null
```

If none exist, tell the user there's nothing pending and exit.

## Step 2 — Partition markers by whether their log still exists

**Do this before sorting or dispatching anything.** Raw logs are pruned on a 7-day retention window; a marker whose `log_path` no longer exists is **unprocessable by definition** — `summary-writer` will print `log-missing`, leave the marker in place, and exit. Dispatching an agent at one accomplishes nothing and costs a full agent.

```bash
M=~/.claude-memory-cache/pending-summaries
live=(); dead=()
for f in "$M"/*.json; do
  lp=$(jq -r '.log_path // empty' "$f" 2>/dev/null)
  if [ -n "$lp" ] && [ -f "$lp" ]; then live+=("$f"); else dead+=("$f"); fi
done
echo "live=${#live[@]} dead=${#dead[@]}"
```

- **Live markers** (log present) are the only dispatch candidates.
- **Dead markers** (log gone) are never dispatched. Count them, report them, and leave them alone — purging them is a deliberate, separately-approved sweep, because a marker is the only surviving record that a session went unsummarised.

If there are no live markers, say so plainly — *"N markers pending, 0 processable (logs past retention)"* — and exit without dispatching. That is a real, reportable state, not a no-op.

## Step 3 — Dispatch background agents (batched, **newest** live marker first)

Sort the **live** markers **newest first** by `marked_at` (fallback: file mtime).

Newest-first is deliberate and load-bearing. Under a retention TTL the newest markers are the ones whose logs still exist and whose summaries are still recoverable; the oldest are the ones about to expire or already expired. Oldest-first ordering combined with never-evicting dead markers deadlocks the queue permanently — every run selects the 10 markers most likely to have lost their logs, does zero work, and leaves the backlog untouched while live markers age out behind the wall. That is exactly what happened between 2026-07-18 and 2026-08-19: 775 of 1,107 markers unprocessable, all 10 next-dispatch candidates dead, queue never advanced. See `insights/2026-08-19-pending-summary-drain-is-deadlocked` in the vault.

Take at most **10** markers from the front of the sorted live list. For each, read it to get the `session_id`, `marker_path`, and `log_path`. Then spawn a background `summary-writer` agent:

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

## Step 4 — Report throughput and move on

Report all four numbers, not just the dispatch count: **dispatched / live remaining / dead (unprocessable) / total**. For example:

> Dispatched 10 background summary-writers. 322 live markers remaining, 775 unprocessable (logs past retention), 1,107 total — re-run `/workbench-core:process-pending-summaries` to continue draining.

Reporting only "dispatched N" is what let the deadlock above hide for a month: a run that clears ten markers and a run that clears zero produced identical output. The dead count is the health signal — if it grows run over run, live markers are aging out faster than they are being drained, and the drain cadence (or batch size) is too low.

Then proceed with whatever the user actually wanted to do this session. Do NOT wait for the agents to complete. If markers remain, the next warmup (or a manual re-run) picks up the next batch.
