# core

Core infrastructure plugin for Claude Code. Part of the [`claude-workbench`](https://github.com/mike-bronner/claude-workbench) marketplace.

## What this is

The infrastructure layer that turns Claude Code from a stateless coding assistant into a persistent, identity-aware collaborator. It provides:

- **Persistent identity** — persona files (`soul-hot.md`, `profile.md`) injected at session start and re-injected after context compression so the agent never drifts.
- **Session logging** — every session is captured as a rolling JSONL log, then summarized by a background agent into a searchable narrative.
- **Operational memory** — a local MCP server (markdown-vault-mcp) fronts a searchable vault of decisions, projects, insights, and session history.
- **Execution-aware skills** — a behavioral protocol that gives any skill persistent memory via vault-backed learnings files.
- **Retention management** — automatic cleanup of raw logs (28 days) and checkpoints (7 days); summaries and decisions persist indefinitely.

## Installation

### Prerequisites

- [Claude Code](https://claude.ai/code) CLI installed
- [markdown-vault-mcp](https://github.com/nicobailey/markdown-vault-mcp) installed and available on PATH
- [jq](https://jqlang.github.io/jq/) installed (used by hook scripts)

### Install the plugin

```bash
/plugin marketplace add mike-bronner/claude-workbench
/plugin install core@claude-workbench
```

### Configure (required on first install)

The memory MCP server ships unconfigured. Run `/workbench:customize` on first install to set your paths:

| Setting | Description | Default |
|---------|-------------|---------|
| `agent_name` | Your agent's name (e.g. `Hobbes`) | `Claude` |
| `memory_path` | Where your operational memory lives on disk | `~/Documents/Claude/Memory` |
| `memory_cache` | Where indexes and checkpoints are stored | `~/.claude-memory-cache` |
| `memory_mcp_server_name` | MCP server name for the vault | `workbench-memory` |
| `auto_summarize` | Spawn background summary-writer on session end | `true` |
| `summary_model` | Model for the background summary-writer | `haiku` |

Configuration is stored in `~/.claude/plugins/data/workbench-claude-workbench/config.json` and survives plugin updates.

### Set up identity files

The plugin expects identity files in your memory directory:

```
{memory_path}/identity/
├── soul-hot.md            — hard rules, voice constraints, drift test (loaded every session)
├── soul-core.md           — deep character, values, tensions (loaded on request)
├── profile.md             — user profile, preferences, working style (loaded every session)
└── skills-protocol.md     — execution-aware skills protocol (loaded every session)
```

Templates are provided in `assets/templates/`. Copy them to your memory directory and customize:

```bash
cp assets/templates/soul-hot.template.md ~/Documents/Claude/Memory/identity/soul-hot.md
cp assets/templates/soul-core.template.md ~/Documents/Claude/Memory/identity/soul-core.md
cp assets/templates/profile.template.md ~/Documents/Claude/Memory/identity/profile.md
cp assets/templates/skills-protocol.template.md ~/Documents/Claude/Memory/identity/skills-protocol.md
```

Replace `{{agent_name}}` placeholders with your agent's name, then edit to taste.

Alternatively, use the interactive skills to build these files through a guided interview:

- `/workbench:define-soul` — walks through agent identity, voice, hard rules, and failure modes
- `/workbench:define-profile` — walks through user role, working style, technical stack, privacy preferences, and session quality

These are the recommended approach — `/workbench:customize` will offer to launch them automatically on first install.

### Optional: execution-aware skills

The plugin includes a skills protocol (`identity/skills-protocol.md`) that gives any skill persistent memory. When a skill execution results in a correction, failure, or confirmed pattern, a learning is written to `skills/{skill-name}.learnings.md` in the vault. Future runs of that skill read the learnings first.

The protocol applies to **any** skill — not just workbench skills. Skills opt in implicitly by including the execution-aware preamble in their `SKILL.md`.

When a learnings file exceeds **30 entries**, the protocol flags it for compaction. `/workbench:compact-learnings` walks through each entry interactively:

- **Workbench plugin skills** — learnings can be integrated directly into the SKILL.md (improving the skill definition) or kept/dropped
- **All other skills** — learnings are compacted (kept, rewritten, or dropped) without touching the SKILL.md

This is automatic — no per-skill configuration needed. Create the directory:

```bash
mkdir -p ~/Documents/Claude/Memory/skills
```

### Shared references

The `references/` directory contains single-source-of-truth documents shared across skills and the summary-writer agent:

| File | Used by | Purpose |
|------|---------|---------|
| `summary-format.md` | summary-writer, log-now, summarize-session | Required frontmatter, body structure, JSONL parsing guidance |
| `decision-promotion.md` | summary-writer, log-now, summarize-session | Promotion criteria, when NOT to promote, decision file template |
| `vault-conventions.md` | summary-writer, log-now, summarize-session | Vault paths, required frontmatter, write vs edit rules |

These are loaded at execution time via `${CLAUDE_PLUGIN_ROOT}/references/` — not injected at session start.

## Plugin layout

```
core/
├── .claude-plugin/
│   └── plugin.json              — manifest + MCP server config
├── agents/
│   └── summary-writer.md       — background narrative agent definition
├── assets/
│   └── templates/              — identity + protocol templates
├── hooks/
│   ├── hooks.json              — hook → script bindings
│   ├── session-log.sh          — raw log capture + summary-writer dispatch
│   └── session-warmup.sh       — identity injection + cleanup + health check
├── references/
│   ├── decision-promotion.md   — when and how to promote decisions
│   ├── summary-format.md       — summary frontmatter + body template
│   └── vault-conventions.md    — paths, frontmatter rules, write conventions
├── skills/
│   ├── compact-learnings/      — review, compact, and integrate skill learnings
│   ├── customize/              — configure agent name, paths, MCP settings
│   ├── define-profile/         — interactive user profile interview
│   ├── define-soul/            — interactive agent identity onboarding
│   ├── log-now/                — dump + narrate the current session inline
│   ├── process-pending-summaries/ — dispatch background agents for pending markers
│   └── summarize-session/      — manually summarize a specific session
└── README.md
```

## How it works

### Session lifecycle

Four hooks manage the session lifecycle:

| Hook | Script | Purpose |
|------|--------|---------|
| `SessionStart` | `hooks/session-warmup.sh` | Identity injection, retention cleanup, MCP health check, pending-summary dispatch |
| `PreCompact` | `hooks/session-log.sh` | Dump raw log checkpoint, spawn summary-writer |
| `PostCompact` | `hooks/session-warmup.sh` | Re-inject identity after context compression |
| `SessionEnd` | `hooks/session-log.sh` | Dump final log segment, spawn summary-writer |

### Logging pipeline

```
Session event (PreCompact / SessionEnd / manual)
    ↓
hooks/session-log.sh
    ├── Load per-session checkpoint (where did I leave off?)
    ├── Extract new JSONL segment from transcript
    ├── Append to rolling log: sessions/YYYY-MM-DD/{session-id}.log.md
    ├── Update checkpoint
    ├── Write pending-summary marker
    └── Spawn background summary-writer (haiku, detached)
            ↓
        summary-writer agent
            ├── Read the rolling log
            ├── Write narrative .summary.md to vault
            ├── Promote decisions (if bar is met)
            ├── Update profile.md (if preferences shifted)
            └── Delete the marker
```

One rolling log file per session. Checkpoint and final segments are appended to the same file. The summary-writer spawns on every log write — later runs overwrite earlier summaries with the most complete picture.

### Identity injection

Identity files are injected on **every** warmup source:

| Source | When | What happens |
|--------|------|--------------|
| `startup` | Fresh session | Full warmup: cleanup + health check + identity + pending summaries |
| `resume` | Reconnecting | Identity refresh + pending summaries |
| `clear` | After `/clear` | Identity refresh + pending summaries |
| `compact` | After compression | Identity refresh only (via PostCompact hook) |

This ensures the agent never loses its voice or behavioral constraints, even in long sessions with multiple context compressions.

### Memory vault

The vault at `{memory_path}` is served by markdown-vault-mcp with:

- **FTS5 full-text search** + **FastEmbed local embeddings** for hybrid search
- **Frontmatter indexing** on: `name`, `type`, `tags`, `summary`, `date`, `scope`, `log_files`
- **Link graph** — backlinks, outlinks, similar documents, connection paths
- **Incremental indexing** — only reprocesses changed files

Vault structure:

```
{memory_path}/
├── identity/          — soul-hot, soul-core, profile, skills-protocol
├── decisions/         — architectural and process decisions
├── projects/          — project context and system designs
├── insights/          — durable patterns and working principles
├── sessions/          — session logs (.log.md) and summaries (.summary.md)
│   └── YYYY-MM-DD/
├── skills/            — per-skill learnings files
├── infrastructure/    — systems and tools documentation
└── CLAUDE.md          — vault map (metadata only)
```

### Retention

Runs on every `startup` warmup:

| Artifact | Retention | Rationale |
|----------|-----------|-----------|
| Raw `.log.md` files | 28 days | Summaries are the durable record |
| Checkpoint files | 7 days | Sessions don't resume after that |
| Legacy summary-writer logs | Immediate cleanup | No longer generated; remnants deleted on startup |
| Summary `.summary.md` files | Forever | Searchable session history |
| Decisions, identity, projects | Forever | Core operational memory |

## Skills

| Skill | Description |
|-------|-------------|
| `/workbench:customize` | Configure agent name, paths, summary model, identity files |
| `/workbench:define-soul` | Interactive onboarding/refinement for agent identity (soul-hot, soul-core) |
| `/workbench:define-profile` | Interactive interview to build/refine the user's profile.md (role, working style, stack, privacy, session quality) |
| `/workbench:log-now` | Dump the current session log and write a narrative summary inline |
| `/workbench:summarize-session` | Manually summarize a specific session (or pick from unsummarized) |
| `/workbench:process-pending-summaries` | Dispatch background agents to clear pending summary markers |
| `/workbench:compact-learnings` | Review and compact accumulated skill learnings; integrate into SKILL.md for workbench skills |

All skills are **execution-aware** — they check for a `skills/{name}.learnings.md` file in the vault before running and apply any accumulated learnings from prior executions.

## Environment variable overrides

All config values can be overridden via environment variables for testing:

| Variable | Overrides |
|----------|-----------|
| `WORKBENCH_AGENT_NAME` | `agent_name` |
| `WORKBENCH_MEMORY_PATH` | `memory_path` |
| `WORKBENCH_MEMORY_CACHE` | `memory_cache` |
| `WORKBENCH_SUMMARY_MODEL` | `summary_model` |
| `WORKBENCH_AUTO_SUMMARIZE` | `auto_summarize` |
| `WORKBENCH_LOG_MODE` | Force log mode (`checkpoint`, `final`, `manual`) |
| `WORKBENCH_SKIP_LOG` | Set to `1` to skip logging (used by summary-writer) |
| `WORKBENCH_SKIP_WARMUP` | Set to `1` to skip warmup (used by summary-writer) |
| `WORKBENCH_MCP_SERVER_NAME` | `memory_mcp_server_name` |

## Known limitations

- **Restart after plugin update.** `CLAUDE_PLUGIN_ROOT` is resolved once at session startup. After updating, restart Claude Code to pick up changes.
- **Summary-writer race on rapid compactions.** If a session compacts multiple times in quick succession, multiple summary-writers may run concurrently. The last one wins (overwrites the summary), which is always the most complete — but intermediate writers do wasted work.

## Design philosophy

The plugin is **infrastructure, not persona**. Your agent's personality comes from the identity files you customize — the plugin itself contains no persona-specific content. Templates in `assets/templates/` use `{{agent_name}}` placeholders.

Memory files live **outside any git repo**, at a user-configured path. Memory is personal state; the plugin is code. They are intentionally separate.
