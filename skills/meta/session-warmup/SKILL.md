---
name: session-warmup
description: Runs automatically at session start and after context compression via the core plugin's SessionStart and PostCompact hooks. Injects identity, skills protocol, and surfaces pending summaries for the process-pending-summaries skill to handle.
---

# Session Warmup

Shell script (`run.sh`) invoked by `SessionStart` and `PostCompact` hooks. The model doesn't invoke it directly — its output is injected into context before the first user message.

## What it does

1. On `startup`: retention cleanup (logs > 28 days, checkpoints > 7 days) + MCP health check + config validation.
2. **Identity injection on all sources** — `soul-hot.md`, `profile.md`, `skills-protocol.md`.
3. On all sources except `compact`: scans for pending-summary markers and tells the model to run `/workbench:process-pending-summaries`.

## Source behavior

| Source | When | Identity | Pending check | Cleanup |
|--------|------|----------|---------------|---------|
| `startup` | Fresh session | Yes | Yes | Yes |
| `resume` | Reconnecting | Yes | Yes | No |
| `clear` | After `/clear` | Yes | Yes | No |
| `compact` | After compression | Yes | No | No |

## Not user-invocable

Use `/workbench:log-now` for manual logging, `/workbench:process-pending-summaries` for clearing the backlog.
