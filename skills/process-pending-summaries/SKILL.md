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

**Do this before sorting or dispatching anything.** A marker carries **two** pointers with different lifetimes: `log_path` (vault cache, pruned at 7 days) and `transcript_path` (the original Claude Code JSONL, ~30 days). `summary-writer` reads the log when present and falls back to the transcript when it is not, so a marker is processable if **either** exists. Only when both are gone is it genuinely unrecoverable.

```bash
M=~/.claude-memory-cache/pending-summaries
live=(); dead=()
for f in "$M"/*.json; do
  lp=$(jq -r '.log_path // empty' "$f" 2>/dev/null)
  tp=$(jq -r '.transcript_path // empty' "$f" 2>/dev/null)
  if { [ -n "$lp" ] && [ -f "$lp" ]; } || { [ -n "$tp" ] && [ -f "$tp" ]; }; then
    live+=("$f")
  else
    dead+=("$f")
  fi
done
echo "live=${#live[@]} dead=${#dead[@]}"
```

- **Live markers** (log **or** transcript present) are the dispatch candidates.
- **Dead markers** (both gone) are never dispatched — retrying one can only fail. Count them, report them, and leave them alone: purging is a deliberate, separately-approved sweep, because a marker is the only surviving record that a session went unsummarised.

**Do not partition on `log_path` alone.** Doing so classified 739 recoverable sessions as dead on 2026-08-19 and nearly justified deleting them. The log expiring is a cache miss; the transcript is the source.

If there are no live markers, say so plainly — *"N markers pending, 0 processable (log and transcript both past retention)"* — and exit without dispatching. That is a real, reportable state, not a no-op.

## Step 3 — Dispatch background agents (batched, **oldest live** marker first)

Sort the **live** markers **oldest first** by `marked_at` (fallback: file mtime).

Oldest-**live**-first is earliest-deadline-first scheduling, and it is what maximises the number of sessions actually recovered. The binding deadline is **transcript retention (~30 days)**, not log retention (7 days): a pruned log costs only a cache miss, but once the transcript is gone the session is unrecoverable for good. The oldest live markers are the ones nearest that cliff; the newest have weeks of slack and will still be there next run. Processing newest-first would let the near-expiry markers fall off the cliff while spending the batch on ones in no danger.

**The word `live` is the entire fix — the ordering was never the bug.** The deadlock of 2026-07-18 → 2026-08-19 came from sorting oldest-first across *all* markers without filtering: every run selected the 10 markers most likely to have lost their source, did zero work, and left the backlog untouched — 775 of 1,107 unprocessable, all 10 next-dispatch candidates dead, queue never advanced. Filter first (step 2), then oldest-first is correct. See `insights/2026-08-19-pending-summary-drain-is-deadlocked` in the vault.

Take at most **10** markers from the front of the sorted live list. For each, read it to get the `session_id`, `marker_path`, `log_path`, and `transcript_path`.

First resolve the vault root once — it is the `Workdir:` slot for every brief in the batch, and `hooks/lib/memory-env.sh` is the repo's single source of truth for it:

```bash
. "${CLAUDE_PLUGIN_ROOT}/hooks/lib/memory-env.sh" && memory_load_env && echo "$MEMORY_PATH"
```

Then spawn a background `summary-writer` agent per marker. **The prompt is a five-slot brief**, the same shape `hooks/agent-dispatch-gate.sh` requires of every dispatch from the main session. It carries no exemption and no sentinel — it passes the gate on its own merits, exactly like any other handoff:

```
Agent tool:
  subagent_type: workbench-core:summary-writer
  run_in_background: true
  prompt: |
    Workdir: {MEMORY_PATH}
    Goal: Write the narrative summary for session {session_id} into the memory vault, promote any decisions it earns, and clear its pending marker.
    Context: A Claude Code session ended and its raw log was dumped to disk, but no summary exists yet. You cannot derive these values, so they are given:
    session_id: {session_id}
    marker_path: {marker_path}
    log_path: {log_path}
    transcript_path: {transcript_path}
    The log is a 7-day cache inside the vault. The transcript is the original Claude Code JSONL and lives about 30 days. A missing log therefore means the cache expired, never that the session is lost.
    Constraints:
    - Summarize from transcript_path whenever log_path no longer exists. Never report a pruned log as an unrecoverable session.
    - Follow your agent definition for the summary format and for the bar a decision must clear before promotion.
    - You receive no follow-up messages. Work from this brief alone and stop when the marker is gone.
    Done when: The summary note exists in the vault, any promoted decisions are written, and {marker_path} no longer exists.
```

Substitute every `{placeholder}` with the real value before dispatching. A brief still carrying literal braces is a bug, not a template.

Dispatch the batch in a single turn — don't wait for one to finish before starting the next. Never dispatch more than 10 at once: each agent reads a full session log, so an uncapped dispatch over a large backlog is a token burst with no upside.

## Step 4 — Report throughput and move on

Report all four numbers, not just the dispatch count: **dispatched / live remaining / dead (unprocessable) / total**. For example:

> Dispatched 10 background summary-writers. 322 live markers remaining, 775 unprocessable (logs past retention), 1,107 total — re-run `/workbench-core:process-pending-summaries` to continue draining.

Reporting only "dispatched N" is what let the deadlock above hide for a month: a run that clears ten markers and a run that clears zero produced identical output. The dead count is the health signal — if it grows run over run, live markers are aging out faster than they are being drained, and the drain cadence (or batch size) is too low.

Then proceed with whatever the user actually wanted to do this session. Do NOT wait for the agents to complete. If markers remain, the next warmup (or a manual re-run) picks up the next batch.
