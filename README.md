# core

Core infrastructure plugin for Claude Code. Part of the [`claude-workbench`](https://github.com/mike-bronner/claude-workbench) marketplace.

## What this is

The infrastructure layer that turns Claude Code from a stateless coding assistant into a persistent, identity-aware collaborator. It provides:

- **Session lifecycle hooks** — `SessionStart`, `PreCompact`, `SessionEnd` — that wrap every conversation with identity loading at the start and memory capture at the end.
- **Meta skills** — `session-warmup`, `session-log`, `log-now` — the procedures the hooks invoke. `session-log` always runs (mechanical raw-log dump, no MCP needed). The narrative summary half is opt-in via `WORKBENCH_AUTO_SUMMARIZE=1`, which dispatches a headless `summary-writer` agent to do the read-rebuild-write work that requires MCP access.
- **Memory MCP** — a local MCP server that serves the user's operational memory store (identity, decisions, sessions, projects) to every Claude surface.
- **Persona templates** — generic `{{agent_name}}` templates under `assets/templates/` that get instantiated into the user's memory directory on first install.

## Status

🚧 **Pre-release (v0.1.0)** — scaffold only. Hooks, skills, and MCP server are being built in subsequent phases. Install today to establish the plugin; functionality lights up as the phases complete.

## Installation

```
/plugin marketplace add mike-bronner/claude-workbench
/plugin install core@claude-workbench
```

On install, the plugin will prompt for:
- **`agent_name`** — the name of your primary agent (e.g. `Hobbes`, `Jarvis`). Default: `Claude`.
- **`memory_path`** — where your operational memory lives on disk. Default: `~/.claude-memory`.
- _(optional)_ custom paths for `soul-hot.md`, `soul-core.md`, `profile.md` if you don't want them in the default location.

## Known limitations

- **Restart after plugin update.** `CLAUDE_PLUGIN_ROOT` is resolved once at session startup and doesn't refresh mid-session. If you run `claude plugin update` while sessions are active, those sessions' hooks will continue using the old plugin version until restarted. Always restart Claude Code after updating this plugin.

## Design philosophy

The plugin is **infrastructure, not persona**. `Hobbes` is one user's configuration of this plugin — the plugin itself contains no Hobbes-specific content. The `assets/templates/` directory holds generic templates with `{{agent_name}}` placeholders; the user's memory directory holds the actual soul content they've customized.

Memory files live **outside any git repo**, at a user-configured path. Memory is personal state; the plugin is code. They are intentionally separate.
