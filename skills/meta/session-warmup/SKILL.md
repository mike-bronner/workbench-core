---
name: session-warmup
description: Runs automatically at session start and after context compression via the core plugin's SessionStart and PostCompact hooks. Injects identity, skills protocol, and dispatches background agents for any pending summaries.
---

# Session Warmup

This skill is a shell script (`run.sh`) invoked by the `core` plugin's `SessionStart` and `PostCompact` hooks. The model does not invoke it directly — by the time you (the assistant) see its output, it's already in your context as part of session initialization.

## What the script does

1. Reads the hook payload from stdin — specifically the `source` field (`startup`, `resume`, `clear`, or `compact`).
2. On `startup`: runs retention cleanup (raw logs > 28 days, checkpoints > 7 days, legacy summary-writer logs) and an MCP health check (verifies vault index exists).
3. **Injects identity on all sources** — `soul-hot.md`, `profile.md`, and `skills-protocol.md` are always loaded. After context compression, the identity may have been shed; on resume, it may have drifted. Re-injection is essential for consistent voice and behavior.
4. On all sources except `compact`: scans `~/.claude-memory-cache/pending-summaries/` for unprocessed summary markers and emits a notice telling the model to dispatch background agents.

## Your job when you see a pending-summary notice

The notice means: previous sessions wrote raw logs but the background summary-writer didn't complete. **Dispatch a background agent for each marker** — do NOT block the session.

For each pending marker, spawn a `workbench:summary-writer` agent in the background with the `session_id`, `marker_path`, and `log_path`. Then proceed with the user's request normally.

If the Agent tool is unavailable, note the pending summaries and move on. They will be picked up by the next session or manual `/log-now`.

## Why identity is injected on every source

| Source | When | Identity? | Pending check? | Cleanup? |
|--------|------|-----------|----------------|----------|
| `startup` | Fresh session | Yes | Yes | Yes |
| `resume` | Reconnecting | Yes | Yes | No |
| `clear` | After `/clear` | Yes | Yes | No |
| `compact` | After compression | Yes | No | No |

Identity files are ~7KB total — small relative to the context window, and the cost of re-injection is negligible compared to the cost of identity drift.

## Environment variables

- `WORKBENCH_MEMORY_PATH` — override the memory store path.
- `WORKBENCH_MEMORY_CACHE` — override the cache path.
- `WORKBENCH_MCP_SERVER_NAME` — override the MCP server name for health check messages.
- `WORKBENCH_SKIP_WARMUP` — set to `1` to skip warmup entirely (used by the summary-writer agent).

## Manual invocation

Not supported. Warmup is a lifecycle thing. If you want to force a fresh log of the current segment, use `/log-now` instead.
