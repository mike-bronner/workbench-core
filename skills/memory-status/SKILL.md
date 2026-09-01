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

It prints: the resolved **vault/cache** paths and **server name**, whether the **launcher** (`hooks/mcp-memory.sh`) is present, whether the **server binary** is installed into the persistent venv under the cache, the **index** path/size, and the **last VACUUM** stamp.

## Interpreting the result

- **launcher present + server binary installed + index built** — memory is wired and should work in-session. If tools still fail, the MCP host may not have (re)spawned the server; restart Claude Code.
- **server binary not installed yet** — the launcher installs it on the first session (needs `uv`, or `pipx`, on PATH). Confirm one is installed, then restart.
- **index not built yet** — normal on a fresh install; it builds on the first session.
- **launcher MISSING** — the plugin tree is broken (`plugin.json`'s memory MCP points at `hooks/mcp-memory.sh`); reinstall the plugin.

Health comes from the **identity-checked probe** (`hooks/lib/memory-probe.sh`), not a bare TCP connect: the port could be held by a stale orphan or an unrelated process, and connecting blindly would attach the session to the wrong vault. The probe POSTs a real MCP `initialize` and asserts `serverInfo.name` matches the configured vault, so a squatter reports as `DOWN_FOREIGN` rather than being silently adopted.

## Notes

- **No start/stop.** The MCP host owns the per-session server's lifecycle — it spawns it in-process at session start and tears it down at session end. `memory-status.sh start|stop` just prints a note and the status; restart Claude Code to re-spawn.
- **The bearer token is the most common failure.** `plugin.json` interpolates `${WORKBENCH_MEMORY_TOKEN}` into the `Authorization` header. Without it Claude Code rejects the MCP config outright (`Missing environment variables`) and never starts a server — which presents as memory being broken rather than unconfigured. Fix: `/workbench-core:setup`, then **quit and relaunch** Claude Code; `settings.json` `.env` is read at launch, so a new session is not enough.
- **Index maintenance** (gated, once/day VACUUM) runs out-of-band from the launcher under a race-safe lock — see `last VACUUM` in the report.
- **Re-enabling the shared HTTP server** (its port/token/health reporting included) is documented in `README.md`, section "Memory server transport — re-enabling the shared HTTP server (optional)".
