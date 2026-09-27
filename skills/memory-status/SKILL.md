---
description: Report the shared memory server's facts — vault/cache paths, probe health, bearer token, live session refs, server binary, and index/maintenance state. Use when memory search/write is failing or to confirm the server is wired.
---

The user has invoked `/workbench-core:memory-status`. Report the shared memory server's facts.

## What this checks

Since 0.19.0 the vault is served by a **lazy-started, reference-counted shared HTTP server** on `127.0.0.1:{memory_port}`. `memory-server-up.sh` starts it at SessionStart on a probe miss; `memory-server-release.sh` drops the session ref and, when it was the last, schedules the reaper. So there IS an out-of-band server, and this skill reports whether it is up, whether it is *ours*, and what is holding it up.

## How to run it

Run the status script (read-only):

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/memory-status.sh"
```

It prints the resolved **transport**, **vault** and **cache** paths, and **server name**. Then it prints the **health** from the probe, whether the **bearer token** is present, how many **live processes** hold the server up, and the **git sync** state. Last come whether the **server binary** is installed into the persistent venv under the cache, the **index** path and size, and the **last VACUUM** stamp. It ends with the likely causes, in order, when memory tools are unavailable.

## Interpreting the result

- **health UP or BUILDING, token present** — memory is wired. If the tools still fail, open `/mcp` and reconnect the server. Restart Claude Code only as a fallback.
- **bearer token MISSING** — the most common failure. `plugin.json` interpolates `${WORKBENCH_MEMORY_TOKEN}` into the `Authorization` header. Without it Claude Code rejects the MCP config outright (`Missing environment variables`) and never starts a server, which presents as memory being broken rather than unconfigured. Fix: `/workbench-core:setup`, then **quit and relaunch** Claude Code. `settings.json` `.env` is read at launch, so a new session is not enough.
- **health DOWN** — nothing is listening. The server starts at the next SessionStart. Check `server.log` under the cache.
- **health DOWN_FOREIGN** — another process holds the port. Free it, or set a different `memory_port`.
- **health DOWN_FAILED** — the last spawn failed. Read `server.log` under the cache.
- **server binary not installed yet** — the first start installs it (needs `uv`, or `pipx`, on PATH). Confirm one is installed, then restart.
- **index not built yet** — normal on a fresh install. It builds on the first start.

Health comes from the **identity-checked probe** (`hooks/lib/memory-probe.sh`), not a bare TCP connect: the port could be held by a stale orphan or an unrelated process, and connecting blindly would attach the session to the wrong vault. The probe POSTs a real MCP `initialize` and asserts `serverInfo.name` matches the configured vault, so a squatter reports as `DOWN_FOREIGN` rather than being silently adopted.

## Notes

- **Start and stop.** The server starts itself: `hooks/memory-server-up.sh` runs at SessionStart and spawns it on a probe miss. It stops itself a grace period after the last session exits (`WORKBENCH_MEMORY_IDLE_GRACE`, default 120s). To force either now, run `hooks/memory-server-up.sh` or `hooks/memory-server-down.sh`. `memory-status.sh start|stop` prints the same pointers, then the status.
- **Index maintenance** (gated, once/day VACUUM) runs out-of-band from the launcher under a race-safe lock. See `last VACUUM` in the report.
