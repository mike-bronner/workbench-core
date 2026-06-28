---
description: Report the shared memory server's health — is it up, what port, is the bearer token provisioned — and start or stop it. Use when memory search/write is failing, after a port or token change, or to confirm the lazy-started server is serving.
---

The user has invoked `/workbench-core:memory-status`. Report the shared HTTP memory server's health and, if asked, start or stop it.

## What this checks

The memory vault is served by a single shared HTTP server (markdown-vault-mcp), lazy-started on the first session by the `memory-server-up` SessionStart hook and kept running across sessions. This skill runs the same identity-checked probe the warmup uses and surfaces the artifacts that explain the result.

## How to run it

Run the status script (read-only):

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/memory-status.sh"
```

It prints: the resolved vault/cache/port, the health word (UP / BUILDING / DOWN_NONE / DOWN_FAILED / DOWN_FOREIGN / PORT_DRIFT), the recorded `server.pid`/`server.port`, whether the bearer token is provisioned, any `.server-failed` / `.port-conflict` breadcrumbs, and a short `server.log` tail.

To start (kick a lazy start) or stop (the only stop path — the server otherwise never stops):

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/memory-status.sh" start
bash "${CLAUDE_PLUGIN_ROOT}/scripts/memory-status.sh" stop
```

## Interpreting the result

- **UP / BUILDING** — serving. BUILDING means the port is bound and search works (keyword-only) while the embedding index finishes building. No action needed.
- **DOWN_NONE** — nothing is listening. Run `... start`, then re-check. (The next session start would also kick it.)
- **DOWN_FAILED** — the last start failed. Read the `server.log` tail and the `.server-failed` marker; common causes are a missing/broken venv or an unwritable cache. After fixing, run `... start`.
- **DOWN_FOREIGN** — a different process holds the port. One transport per port: free the port or set a different `WORKBENCH_MEMORY_PORT` in `~/.claude/settings.json`, then restart Claude Code.
- **PORT_DRIFT** — the running server's recorded port differs from the configured one (settings.json env vs config.json disagree). Reconcile them, then restart.
- **bearer token MISSING** — run `/workbench-core:customize` to auto-provision the token (it mints one and writes it to `~/.claude/settings.json`). A token change needs a Claude Code restart to reach the MCP client.

## Notes

- Port and token reach the MCP client only via `~/.claude/settings.json` env (`WORKBENCH_MEMORY_PORT`, `WORKBENCH_MEMORY_TOKEN`) — a SessionStart hook can't inject them into the host's config parse. So changes to either require a Claude Code restart, not just a new session.
- The server is shared across all sessions and never idle-stops. `... stop` is the deliberate way to take it down (e.g. to change ports).
