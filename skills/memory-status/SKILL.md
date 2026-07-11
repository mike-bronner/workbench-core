---
description: Report the memory server's facts — vault/cache paths, whether the launcher and server binary are installed, and index/maintenance state. Use when memory search/write is failing or to confirm the per-session stdio server is wired.
---

The user has invoked `/workbench-core:memory-status`. Report the per-session stdio memory server's facts.

## What this checks

Since v0.13.0 the memory vault is served by a **per-session stdio server** that the MCP host (Claude Code / Cowork) spawns **in-process** via `hooks/mcp-memory.sh` — one per session, no shared listener, no port, no bearer token. This is what makes memory work inside Claude Cowork's remote sandbox, where nothing can reach a loopback port on your Mac. Because the server is in-process and per-session, there is **no out-of-band server to probe, start, or stop** — so this skill reports the things that actually determine whether memory works.

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

The stdio server has no health probe: the real signal for a broken launcher is the **MCP host's own connection error** at startup, and whether the `mcp__…memory__*` tools are available in-session.

## Notes

- **No start/stop.** The MCP host owns the per-session server's lifecycle — it spawns it in-process at session start and tears it down at session end. `memory-status.sh start|stop` just prints a note and the status; restart Claude Code to re-spawn.
- **No port or token.** Per-session stdio needs neither. `WORKBENCH_MEMORY_PORT` / `WORKBENCH_MEMORY_TOKEN` in `~/.claude/settings.json` are inert unless you re-enable the shared HTTP server.
- **Index maintenance** (gated, once/day VACUUM) runs out-of-band from the launcher under a race-safe lock — see `last VACUUM` in the report.
- **Re-enabling the shared HTTP server** (its port/token/health reporting included) is documented in `README.md`, section "Memory server transport — re-enabling the shared HTTP server (optional)".
