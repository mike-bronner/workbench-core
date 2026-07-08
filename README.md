# core

Core infrastructure plugin for Claude Code. Part of the [`claude-workbench`](https://github.com/mike-bronner/claude-workbench) marketplace.

## What this is

The infrastructure layer that turns Claude Code from a stateless coding assistant into a persistent, identity-aware collaborator. It provides:

- **Persistent identity** — persona files (`soul-hot.md`, `profile.md`) injected at session start and re-injected after context compression so the agent never drifts.
- **Guardrails** — absolute behavioral rules that ship with the plugin, load last (highest authority), and are enforced by the interview skills. Guardrails can't be overridden by persona or profile choices.
- **Session logging** — every session is captured as a rolling JSONL log, then summarized by a background agent into a searchable narrative.
- **Operational memory** — a local MCP server (markdown-vault-mcp) fronts a searchable vault of decisions, projects, insights, and session history.
- **Execution-aware skills** — a behavioral protocol that gives any skill persistent memory via vault-backed learnings files.
- **Retention management** — automatic cleanup of raw logs (28 days) and checkpoints (7 days); summaries and decisions persist indefinitely.

## Installation

### Prerequisites

Three things must be on your system before installing the plugin.

#### 1. Claude Code CLI

Install from [claude.ai/code](https://claude.ai/code).

#### 2. `jq` — JSON parser used by the hook scripts

```bash
# macOS
brew install jq

# Debian / Ubuntu
sudo apt install jq

# Fedora / RHEL
sudo dnf install jq
```

#### 3. `markdown-vault-mcp` — the MCP server backing the memory vault

**You normally don't need to install this yourself** — the plugin self-installs the server from the fork on first run. All it needs is [`uv`](https://docs.astral.sh/uv/) or [`pipx`](https://pipx.pypa.io/) on your PATH (`uv` preferred). The plugin's `.claude-plugin/plugin.json` declares the `memory` MCP server (an HTTP transport at `127.0.0.1:8765`) and Claude Code auto-wires it on plugin install, so there's no `claude mcp add` step either.

Since v0.10.0 the server is a **single shared HTTP server**, lazy-started on the first session and shared by every session after (see [Shared memory server](#shared-memory-server) below). On a brand-new git install the very first session may have no memory until the next restart — the SessionStart hook kicks the server (binding in ~2s), but the bearer **token** it authenticates with reaches the MCP client only via `~/.claude/settings.json`, which Claude Code reads at launch. Run `/workbench-core:setup` to provision the token, then restart once; thereafter memory is available from the first session.

The launcher installs from the [mikebronner/markdown-vault-mcp](https://github.com/mikebronner/markdown-vault-mcp) fork — the canonical source for this plugin. The fork carries index-state fixes the plugin relies on (persistent-index adoption at boot, offline-change reconciliation, tracker skip-state, embedding convergence, raw-transcript exclusion support) that are not yet in any PyPI release. They have been contributed upstream ([pvliesdonk/markdown-vault-mcp#665](https://github.com/pvliesdonk/markdown-vault-mcp/issues/665)); once an upstream release carries them, plain PyPI installs will work again — until then, installing from PyPI gets you a server that can exceed Claude Code's 30s MCP startup timeout on first boot.

If neither `uv` nor `pipx` is available, install one:

```bash
# uv — macOS:
brew install uv
# uv — Linux / other (via official installer):
curl -LsSf https://astral.sh/uv/install.sh | sh

# pipx — macOS:
brew install pipx
# pipx — Debian / Ubuntu:
sudo apt install pipx
```

**Manual install / troubleshooting** — if the bootstrap fails (the launcher logs `mcp-memory:`-prefixed errors to stderr), install the server yourself:

```bash
# Recommended — uv (fast, isolated, auto-manages Python version):
uv tool install --from git+https://github.com/mikebronner/markdown-vault-mcp markdown-vault-mcp --with fastmcp --with fastembed

# Alternative — pipx (isolated, no auto-Python-management):
pipx install git+https://github.com/mikebronner/markdown-vault-mcp

# Last resort — pip (global install, conflicts with system Python on modern
# macOS/Linux via PEP 668):
pip install --user git+https://github.com/mikebronner/markdown-vault-mcp
```

Verify:

```bash
markdown-vault-mcp --version
```

### Install the plugin

```bash
/plugin marketplace add mike-bronner/claude-workbench
/plugin install workbench-core@claude-workbench
```

### Optional: CLI system-prompt enforcement

**Background:** Claude Code's default system prompt includes rules like "no emojis unless asked" and specific tone/style directives. If your agent persona contradicts these (e.g., "use emojis liberally"), the system prompt wins — it's architecturally higher authority than `CLAUDE.md` or hook output, which are both delivered as user messages.

The plugin addresses this at three layers:

| Layer | File | Authority | Works in |
|-------|------|-----------|----------|
| 1 | `~/.claude/system-overrides.md` | System prompt (highest) | CLI only |
| 2 | `~/.claude/CLAUDE.md` managed block | User message | Everywhere |
| 3 | SessionStart hook output | Tool result | Everywhere |

Layers 2 and 3 are automatic — the plugin generates and maintains them on every startup. Layer 1 requires a one-line shell alias because `--append-system-prompt-file` is CLI-only (no settings.json equivalent exists).

To activate Layer 1, add this to your shell profile (`~/.zshrc`, `~/.bashrc`, etc.):

```bash
alias claude='claude --append-system-prompt-file ~/.claude/system-overrides.md'
```

**Who needs this:** Anyone using the Claude Code CLI whose agent persona overrides default system prompt behaviors (emoji usage, tone, sycophancy rules). If your persona doesn't contradict the defaults, Layers 2 and 3 are sufficient.

**Who doesn't need this:** Desktop app, web app (claude.ai/code), and IDE extension users — these don't go through the shell. For those environments, the plugin relies on Layers 2 and 3 as reinforcement. These work everywhere but can't architecturally override the system prompt.

### Configure (required on first install)

The memory MCP server ships unconfigured. Run `/workbench:setup` on first install to set your paths:

| Setting | Description | Default |
|---------|-------------|---------|
| `agent_name` | Your agent's name (e.g. `Holmes`) | `Claude` |
| `memory_path` | Where your operational memory lives on disk | `~/Documents/Claude/Memory` |
| `memory_cache` | Where indexes, server artifacts, and checkpoints are stored | `~/.claude-memory-cache` |
| `memory_mcp_server_name` | MCP server name for the vault (also the health-probe identity) | `workbench-memory` |
| `memory_port` | Loopback port the shared HTTP memory server binds | `8765` |
| `auto_summarize` | Spawn background summary-writer on session end | `true` |
| `summary_model` | Model for the background summary-writer | `sonnet` |

Configuration is stored in `~/.claude/plugins/data/workbench-core-claude-workbench/config.json` and survives plugin updates. The hooks resolve env from this file at launch (via `hooks/lib/memory-env.sh`), so a plugin version bump never clobbers your settings. `/workbench-core:setup` also provisions the memory server's **bearer token** (and the port, when non-default) into `~/.claude/settings.json` `.env` — the only channel that reaches the MCP client's config parse. Those changes take effect on the next Claude Code **restart**, not just a new session.

### Set up identity files

There are three ways to get identity files in place — pick one:

**Fastest — install a shipped persona.** The plugin can ship ready-made personas under `assets/personas/<name>/`. Install one with:

```
/workbench-core:install-persona
```

It propagates the soul files to your vault, the output style to `~/.claude/output-styles/`, and the `outputStyle` setting — and it's non-destructive: existing hand-edited soul files are diffed and confirmed before any overwrite. This is the quickest path to a durable voice, because the output style sits in the system prompt (which outranks context).

**Guided — build from scratch via interview.** Use `/workbench-core:define-soul` (below).

**Manual — copy templates.** The plugin expects identity files in your memory directory:

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

These are the recommended approach — `/workbench:setup` will offer to launch them automatically on first install.

### Execution-aware skills

Any skill execution reads a persistent learnings file before running. If the run produces a correction, an unexpected failure, or a confirmed non-obvious pattern, an entry is appended for next time. Files live at `{memory_path}/skills/{skill-name}.learnings.md`.

The protocol applies to **any** skill — workbench skills, third-party plugin skills, your own personal skills. No per-skill configuration needed.

The protocol is driven by `{memory_path}/identity/skills-protocol.md`, installed by `/workbench:setup` and loaded every session by the SessionStart hook (load order: soul-hot → profile → skills-protocol → guardrails). Remove the file if you want to disable the behavior; delete a specific `skills/{skill-name}.learnings.md` to reset one skill's accumulated state without touching the rest.

#### Compaction

When a learnings file exceeds **30 entries**, the protocol flags it for compaction. `/workbench:compact-learnings` walks through each entry interactively:

- **Workbench plugin skills** — learnings can be integrated directly into the SKILL.md (improving the skill definition) or kept/dropped
- **All other skills** — learnings are compacted (kept, rewritten, or dropped) without touching the SKILL.md

### Shared references

The `references/` directory contains single-source-of-truth documents shared across skills and the summary-writer agent:

| File | Used by | Purpose |
|------|---------|---------|
| `guardrails.md` | session-warmup, define-soul, define-profile | Absolute behavioral rules — injected last at session start, enforced during interviews |
| `summary-format.md` | summary-writer, log-now, summarize-session | Required frontmatter, body structure, JSONL parsing guidance |
| `decision-promotion.md` | summary-writer, log-now, summarize-session | Promotion criteria, when NOT to promote, decision file template |
| `vault-conventions.md` | summary-writer, log-now, summarize-session | Vault paths, required frontmatter, write vs edit rules |
| `linking-synthesis.md` | summary-writer, log-now, summarize-session, memory-lint | Wikilink syntax, related-document linking, topic-page synthesis, vault index contract |

Most references are loaded at execution time via `${CLAUDE_PLUGIN_ROOT}/references/`. The exception is `guardrails.md`, which is injected at every session start by the warmup hook.

## Plugin layout

```
core/
├── .claude-plugin/
│   └── plugin.json              — manifest + MCP server config
├── agents/
│   └── summary-writer.md       — background narrative agent definition
├── assets/
│   ├── personas/              — optional ready-made personas (soul + output style)
│   ├── prompt-templates/      — scheduled-task prompt bodies (decision-quality nightly)
│   └── templates/              — identity + protocol templates
├── hooks/
│   ├── hooks.json              — hook → script bindings
│   ├── session-log.sh          — raw log capture + summary-writer dispatch
│   ├── session-warmup.sh       — identity injection + cleanup + health check
│   ├── mcp-memory.sh           — stdio launcher (escape hatch / in-flight sessions)
│   ├── memory-server-up.sh     — SessionStart kicker: lazy-start the shared server
│   ├── memory-server-spawn.sh  — detached supervisor: install + launch + readiness
│   ├── memory-server-down.sh   — manual stop for the shared server
│   ├── memory-capture-nudge.sh — UserPromptSubmit: nudge proactive memory WRITES
│   ├── memory-recall.sh        — UserPromptSubmit: inject relevant memory READS (recall)
│   ├── lib/                    — sourceable libs: memory-env / -probe / -vacuum / -install
│   └── fixtures/               — test fixtures (fake-server stub, no real server)
├── references/
│   ├── guardrails.md           — absolute behavioral rules (injected at session start)
│   ├── decision-promotion.md   — when and how to promote decisions
│   ├── linking-synthesis.md    — wikilinks, topic pages, vault index contract
│   ├── summary-format.md       — summary frontmatter + body template
│   └── vault-conventions.md    — paths, frontmatter rules, write conventions
├── skills/
│   ├── compact-learnings/      — review, compact, and integrate skill learnings
│   ├── setup/                  — configure agent name, paths, MCP settings
│   ├── evaluate-decisions/     — grade recorded decisions/memories → learnings report (REPS gear 2)
│   ├── propose-upgrades/       — learnings → reviewed proposals → apply on sign-off (REPS gears 3+4)
│   ├── define-profile/         — interactive user profile interview
│   ├── define-soul/            — interactive agent identity onboarding
│   ├── install-persona/        — propagate a shipped persona to live locations
│   ├── log-now/                — dump + narrate the current session inline
│   ├── memory-lint/            — monthly vault health-and-repair pass
│   ├── process-pending-summaries/ — dispatch background agents for pending markers
│   └── summarize-session/      — manually summarize a specific session
├── scripts/
│   ├── install-chat-skills.sh  — package + install skills into Claude Chat
│   ├── install-persona.sh      — propagate a shipped persona to live locations
│   └── memory-status.sh        — report / start / stop the shared memory server
└── README.md
```

## How it works

### Session lifecycle

These hooks fire across the session lifecycle and on each turn:

| Hook | Script | Purpose |
|------|--------|---------|
| `SessionStart` | `hooks/memory-server-up.sh` | Lazy-start the shared memory server (runs first, before warmup) |
| `SessionStart` | `hooks/session-warmup.sh` | Identity injection, retention cleanup, memory-server health check, pending-summary dispatch |
| `PreCompact` | `hooks/session-log.sh` | Dump raw log checkpoint, spawn summary-writer |
| `PostCompact` | `hooks/session-warmup.sh` | Re-inject identity after context compression |
| `SessionEnd` | `hooks/session-log.sh` | Dump final log segment, spawn summary-writer |
| `UserPromptSubmit` | `hooks/memory-capture-nudge.sh` | Sparse nudge to capture durable knowledge to the vault (memory **writes**) |
| `UserPromptSubmit` | `hooks/memory-recall.sh` | Proactive recall — search the vault with the prompt and inject relevant memories, **once per session** per memory (memory **reads**) |

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
    └── Spawn background summary-writer (sonnet, detached)
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

### Guardrails

Identity files are customizable — users define their agent's persona via `/workbench:define-soul` and their own profile via `/workbench:define-profile`. But some rules should hold regardless of what persona is configured. That's the problem guardrails solve.

**The problem:** Without guardrails, the interview skills can produce identity files that encode bad habits — sycophantic openers, hedged opinions, unverified assertions. These are anti-patterns that degrade output quality no matter what character the agent plays. A user might accidentally request them ("soften critiques with a compliment first") without realizing they're undermining the agent's usefulness.

**The solution:** `references/guardrails.md` ships with the plugin as a set of absolute behavioral rules. They:

1. **Load last** in the identity chain (after soul-hot, profile, skills-protocol) — giving them highest authority in context.
2. **Are enforced during interviews** — both `/workbench:define-soul` and `/workbench:define-profile` check every answer against the guardrails. If an answer contradicts a guardrail, the skill stops, names the conflict, and recommends an alternative. It never suggests modifying the guardrails.
3. **Ship with the plugin, not the vault** — guardrails are not user-configurable paths. They're plugin infrastructure, like the hook scripts.

The authority hierarchy for behavioral rules:

```
guardrails.md (absolute — ships with plugin)
    ↓ overrides
soul-hot.md (character-specific — user-defined)
    ↓ informs
profile.md (user context — user-defined)
```

### Memory vault

The vault at `{memory_path}` is served by markdown-vault-mcp with:

- **FTS5 full-text search** + **FastEmbed local embeddings** for hybrid search
- **Frontmatter indexing** on: `name`, `type`, `tags`, `summary`, `date`, `scope`, `log_files`
- **Link graph** — backlinks, outlinks, similar documents, connection paths
- **Incremental indexing** — only reprocesses changed files
- **Transcript exclusion** — raw `sessions/**/*.log.md` transcripts are excluded from indexing (write-only archival); they stay readable by path, and the indexed summaries carry `log_files` pointers to them

Vault structure:

```
{memory_path}/
├── identity/          — soul-hot, soul-core, profile, skills-protocol
├── decisions/         — architectural and process decisions
├── topics/            — topical synthesis pages (current state per theme)
├── projects/          — project context and system designs
├── insights/          — durable patterns and working principles
├── sessions/          — session logs (.log.md) and summaries (.summary.md)
│   └── YYYY-MM-DD/
├── skills/            — per-skill learnings files
├── infrastructure/    — systems and tools documentation
├── maintenance/       — memory-lint audit reports
├── index.md           — catalog of the curated layer (topics, decisions, identity, reference)
└── CLAUDE.md          — vault map (metadata only)
```

#### Shared memory server

Through v0.9, `plugin.json` launched a **stdio** markdown-vault-mcp server **per Claude session**. Every session pointed at the same cache, so N sessions meant N processes each building embeddings over the whole vault — CPU saturation — plus a cross-process SQLite write-race on one WAL. v0.10 replaces that with **one shared local HTTP server** that all sessions connect to.

How it works:

- **Lazy start.** A SessionStart hook (`hooks/memory-server-up.sh`) runs first, before the warmup. It probes the configured port (`127.0.0.1:8765` by default); if the vault is already serving, it does nothing. Otherwise it wins a mutex and hands a **detached supervisor** (`hooks/memory-server-spawn.sh`) the slow work — venv install, the gated index VACUUM, and launching the server — then returns immediately. The supervisor is reparented out of the hook's process group (via `perl` + `POSIX::setsid`), so the server outlives the session that started it. The HTTP transport binds in ~2s; Claude Code retries the MCP connection until it's up.
- **Never stops.** Once up, the server stays up across sessions — it is shared infrastructure, not per-session. The only stop path is manual: `/workbench-core:memory-status stop` (or `hooks/memory-server-down.sh`), e.g. to change ports.
- **Identity-checked health.** The warmup and `/workbench-core:memory-status` probe the server with a real MCP `initialize` and assert the handshake's `serverInfo.name` matches your configured server name — so a session never silently attaches to a *different* vault squatting the port. A foreign listener is reported as a conflict, never adopted.
- **Bearer token auth.** The server authenticates with a per-install bearer token, **fully auto-provisioned** by `/workbench-core:setup`: it mints a random token (`openssl rand -hex 32`), writes it `0600` to `{memory_cache}/server.token`, and merges `WORKBENCH_MEMORY_TOKEN` into `~/.claude/settings.json` `.env` (which `plugin.json`'s `Authorization: Bearer ${WORKBENCH_MEMORY_TOKEN}` header reads). If the token file is ever lost, the supervisor re-mints one at next start. Because settings.json env is read at launch, a brand-new install's first session may lack memory until the next restart — expected, and self-healing.
- **One-shot orphan sweep.** On the first shared start, the supervisor reaps any leaked **orphan** stdio servers from the old per-session model (UID-scoped, matched on the server binary path, and only those whose parent is dead — a live-parented session's server is never touched).

Cache layout under `{memory_cache}` (default `~/.claude-memory-cache`):

```
{memory_cache}/
├── vault-index.sqlite   — FTS index
├── embeddings/          — FastEmbed vectors
├── kv/                  — HTTP-transport key-value store (session persistence)
├── events/              — HTTP-transport event store
├── server-venv/         — the installed server (survives plugin updates)
├── server.log           — server stdout/stderr (size-rotated, 5MB × 2)
├── server.pid           — running server's PID
├── server.port          — running server's bound port
├── server.token         — bearer token (0600)
└── .last-vacuum         — cooldown stamp for the gated index VACUUM
```

The `kv/` and `events/` stores are required by the HTTP transport (its default `file:///data/state` is unwritable on macOS); they back HTTP session persistence. A retention sweep for them is deferred to a future release — they grow slowly and are safe to delete when the server is stopped.

To change the port, set `memory_port` via `/workbench-core:setup` (which preflights it with `lsof` and writes `WORKBENCH_MEMORY_PORT` to settings.json), then restart Claude Code. Check health any time with `/workbench-core:memory-status`.

#### Canonical store & routing

The vault is the **canonical durable memory store**. Claude Code's harness also injects per-project memory instructions every session (save to `~/.claude/projects/<encoded-cwd>/memory/` + a `MEMORY.md` index) — left alone, sessions scatter memory files there that the vault can't search. The session warmup neutralizes that channel into a router: it injects a `## Memory routing` rule at every session start (saves go to the vault via the memory MCP `write` tool with vault frontmatter; recall is vault hybrid `search`, not directory reads), and on startup it writes a self-healing router stub to the current project's `MEMORY.md` (canonical template: `references/memory-routing-stub.md`). A `MEMORY.md` without the router marker is never overwritten — the warmup flags it for human migration instead. Keep the store singular: don't install competing memory MCP servers alongside the vault.

#### Wiki layer and vault index

Session summaries are chronological sediment; left alone they accumulate as unlinked orphans. Every ingest path (the summary-writer agent, `/workbench:log-now`, `/workbench:summarize-session`) therefore follows `references/linking-synthesis.md`: search the vault for related decisions, topics, and prior summaries; add a `## Related` section of path-qualified wikilinks (`[[folder/file-stem|display text]]` — the form markdown-vault-mcp resolves immediately); maintain at most one topical synthesis page in `topics/` per session; and cross-link promoted decisions to their summaries and topics. Linking is deliberately conservative — only high-confidence connections, capped per ingest, because an orphan beats a forced link.

`index.md` at the vault root is the catalog of the curated layer — one wikilink + one-line hook per topic, decision, identity, and reference document (never sessions). It's the orientation entry point: agents read it **on demand** to get the lay of the vault before searching — it is **not** auto-loaded into context. The summary writers keep it current as they create topics and promote decisions; the lint ritual repairs drift.

#### Lint ritual

Vaults rot silently: files written without the required `name`/`type` frontmatter are skipped at index time (on disk but invisible to search), links break when targets move, orphans accumulate. `/workbench-core:memory-lint` is the periodic repair pass — it diffs the filesystem against the index to find skipped files and rescues their frontmatter, repairs or removes broken links, adds only high-confidence links (never mass-links orphans), repairs `index.md` drift in both directions (missing entries for `topics/` and `decisions/` documents, stale entries pointing at deleted ones), and flags duplicates/contradictions for the human instead of merging. Each run is capped at 50 file-fixes and writes an audit report to `maintenance/` with before/after stats. Intended cadence: monthly, deployed via the scheduled-tasks MCP. Raw `*.log.md` transcripts are never touched.

#### Decision-quality loop

The memory pipeline above *records* what was decided; this loop asks whether those decisions were any good and turns the answer into better future decisions. It runs on the **learning layer** (decisions and memories), never on deployed code, and keeps the human in control of every change. Two skills, run as a pair:

1. **`/workbench-core:evaluate-decisions`** reads recently recorded decisions and memory entries and grades them on four axes — correctness vs. later outcomes, accuracy/efficiency/speed, consistency/recurrence (the same mistake recorded twice), and gaps (a decision made with no governing rule). It writes a **learnings report** to `learnings/` and changes nothing else.
2. **`/workbench-core:propose-upgrades`** turns that report into concrete **proposals** — corrections to existing memories and new process recordings — in a review digest under `proposals/`. It then walks **sign-off**: in phase 1 every proposal needs explicit human approval, judged on whether it improves accuracy, efficiency, or speed. Approved memory changes are applied via the memory MCP; approved repo-file changes (`CLAUDE.md`, a `SKILL.md`) still pass through the normal commit-approval gate. Rejections are logged so they never resurface.

**Nightly scheduling (opt-in).** `/workbench-core:setup` offers to deploy one scheduled task (`workbench-core-decision-quality`) via the scheduled-tasks MCP. It runs the two phases chained — evaluate writes the report, then propose builds the digest and **pauses on the sign-off triage** (`AskUserQuestion`) until you pick it up next session. This is the same "generate overnight, present when you arrive" pattern as the BuJo ritual; the scheduled prompt instructs the run to wait rather than fabricate answers, and nothing is ever applied without your approval. A quiet night with no findings completes silently. **Auto-accepting** low-risk proposals remains deferred until the manual loop has earned trust.

### Retention

Runs on every `startup` warmup:

| Artifact | Retention | Rationale |
|----------|-----------|-----------|
| Raw `.log.md` files | 7 days | Summaries are the durable record |
| Checkpoint files | 7 days | Sessions don't resume after that |
| Legacy summary-writer logs | Immediate cleanup | No longer generated; remnants deleted on startup |
| Summary `.summary.md` files | Forever | Searchable session history |
| Decisions, identity, projects | Forever | Core operational memory |

## Skills

| Skill | Description |
|-------|-------------|
| `/workbench:setup` | Configure agent name, paths, summary model, identity files |
| `/workbench:define-soul` | Interactive onboarding/refinement for agent identity (soul-hot, soul-core) |
| `/workbench-core:install-persona` | Install a shipped persona — soul files + output style + `outputStyle` setting — into your live locations; non-destructive |
| `/workbench:define-profile` | Interactive interview to build/refine the user's profile.md (role, working style, stack, privacy, session quality) |
| `/workbench:log-now` | Dump the current session log and write a narrative summary inline |
| `/workbench:summarize-session` | Manually summarize a specific session (or pick from unsummarized) |
| `/workbench:process-pending-summaries` | Dispatch background agents to clear pending summary markers |
| `/workbench:compact-learnings` | Review and compact accumulated skill learnings; integrate into SKILL.md for workbench skills |
| `/workbench-core:evaluate-decisions` | Grade recorded decisions & memories for decision quality (correctness, accuracy/efficiency/speed, consistency/recurrence, gaps) → learnings report. Decision-quality loop, gear 2 |
| `/workbench-core:propose-upgrades` | Turn an evaluation into concrete corrections & new process recordings, walk human sign-off, apply only what's approved. Decision-quality loop, gears 3+4 |
| `/workbench-core:memory-lint` | Monthly health-and-repair pass over the memory vault — frontmatter rescue, broken-link repair, conservative orphan linking, vault-index drift repair, duplicate flagging, audit report |
| `/workbench-core:memory-status` | Report the shared memory server's health (up/building/down/conflict), port, and token; start or stop it |
| `/workbench-core:install-chat-skills` | Discover skills in `@claude-workbench` plugins and install them into the Claude Mac app's Chat surface via `.skill` packaging |

All skills are **execution-aware** — they check for a `skills/{name}.learnings.md` file in the vault before running and apply any accumulated learnings from prior executions.

### Cross-surface skill installation

workbench-core auto-discovers installable skills in dependent `@claude-workbench` plugins and surfaces a notice in the SessionStart warmup output when new or updated skills are available:

```
## 📦 New Chat-installable skills

The following skills can be installed into Claude Chat (Mac app):
- `develop` (from `workbench-dev-team`)
- `git-commit` (from `workbench-dev-team`)

Click to install: `/workbench-core:install-chat-skills`
```

The detection runs once per session start (`source: startup` only) and uses a state-file mtime fast-path — when nothing has changed since the last run, the check is a single stat. The cold path triggers only after `claude plugin install/update` actually changes `installed_plugins.json`.

The slash command (`/workbench-core:install-chat-skills`) packages each eligible skill via `skill-creator`'s `package_skill.py`, opens the resulting `.skill` files with the Mac app, and updates `~/.claude-workbench/chat-skills-state.json` so the notice clears. Requires the `skill-creator@claude-plugins-official` plugin (the script will tell you to install it if missing).

The notice persists until the user installs — if you ignore it once, it'll appear again on the next session start. Skipping a skill in the install dialog has the same effect.

## Environment variable overrides

All config values can be overridden via environment variables for testing:

| Variable | Overrides |
|----------|-----------|
| `WORKBENCH_AGENT_NAME` | `agent_name` |
| `WORKBENCH_MEMORY_PATH` | `memory_path` |
| `WORKBENCH_MEMORY_CACHE` | `memory_cache` |
| `WORKBENCH_MEMORY_PORT` | `memory_port` (also read by the MCP client from `settings.json` `.env`) |
| `WORKBENCH_MEMORY_TOKEN` | memory server bearer token (set in `settings.json` `.env` by setup) |
| `WORKBENCH_SUMMARY_MODEL` | `summary_model` |
| `WORKBENCH_AUTO_SUMMARIZE` | `auto_summarize` |
| `WORKBENCH_LOG_MODE` | Force log mode (`checkpoint`, `final`, `manual`) |
| `WORKBENCH_SKIP_LOG` | Set to `1` to skip logging (used by summary-writer) |
| `WORKBENCH_SKIP_WARMUP` | Set to `1` to skip warmup (used by summary-writer) |
| `WORKBENCH_MCP_SERVER_NAME` | `memory_mcp_server_name` |
| `WORKBENCH_MEMORY_RECALL` | Set to `0` to disable proactive vault recall (`memory-recall.sh`) |
| `WORKBENCH_MEMORY_RECALL_LIMIT` | Max memories the recall hook injects per turn (default `2`) |
| `WORKBENCH_SETTINGS_FILE` | `~/.claude/settings.json` path (used by `install-persona` tests) |
| `WORKBENCH_OUTPUT_STYLES_DIR` | `~/.claude/output-styles` path (used by `install-persona` tests) |

## Known limitations

- **Restart after plugin update.** `CLAUDE_PLUGIN_ROOT` is resolved once at session startup. After updating, restart Claude Code to pick up changes.
- **First session after a git install may lack memory.** The memory server's port and bearer token reach the MCP client via `~/.claude/settings.json` `.env`, which Claude Code reads at launch — a SessionStart hook can't inject them. Run `/workbench-core:setup` to provision them, then restart once; memory is available from the first session thereafter. Check status any time with `/workbench-core:memory-status`.
- **Summary-writer race on rapid compactions.** If a session compacts multiple times in quick succession, multiple summary-writers may run concurrently. The last one wins (overwrites the summary), which is always the most complete — but intermediate writers do wasted work.

## Design philosophy

The plugin is **infrastructure first, persona optional**. Your agent's personality comes from the identity files *you* customize — the framework imposes none. Templates in `assets/templates/` use `{{agent_name}}` placeholders. The plugin *may* also ship ready-made personas under `assets/personas/<name>/` (soul files + output style) as optional starting points: you opt in via `/workbench-core:install-persona`, which copies them to *your* editable locations — they are never enforced, and the framework stays generic for anyone who wants to start from blank templates. The one thing that isn't optional is `references/guardrails.md` — universal quality constraints (no sycophancy, no hedging, verify before asserting), not personality.

Memory files live **outside any git repo**, at a user-configured path. Memory is personal state; the plugin is code. They are intentionally separate.
