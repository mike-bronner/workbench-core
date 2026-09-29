# core

Core infrastructure plugin for Claude Code. Part of the [`claude-workbench`](https://github.com/mike-bronner/claude-workbench) marketplace.

## What this is

The infrastructure layer that turns Claude Code from a stateless coding assistant into a persistent collaborator. It provides:

- **One persona** — the shipped output style, installed by setup. It sits in the system prompt, so it survives context compression with no re-injection.
- **One rule source** — the behavioural rules load once, from the shipped output style. No hook restates them, so they cannot drift apart and they never reach a sub-agent.
- **Session logging** — every session is captured as a rolling JSONL log, then summarized by a background agent into a searchable narrative.
- **Operational memory** — a shared, lazy-started local MCP server (markdown-vault-mcp) fronts a searchable vault of decisions, projects, insights, and session history, optionally kept in sync across machines over git.
- **Execution-aware skills** — a `PreToolUse(Skill)` hook hands any skill its vault-backed learnings file, so each run starts from what past runs learned.
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

**You normally don't need to install this yourself** — the plugin self-installs the server on first run. All it needs is [`uv`](https://docs.astral.sh/uv/) or [`pipx`](https://pipx.pypa.io/) on your PATH (`uv` preferred). The plugin's `.claude-plugin/plugin.json` declares the `memory` MCP server (the shared **HTTP** server on a loopback port) and Claude Code auto-wires it on plugin install, so there's no `claude mcp add` step either.

The server is a **lazy-started, reference-counted shared HTTP server**: the first session that needs it starts it in the background, every Claude Code process registers a ref, and it is stopped a grace period after the last one leaves. One server means one embedding model resident instead of one per session, one writer serializing index updates, and one process able to own the git sync loop. It needs a port and a bearer token, both provisioned by `/workbench-core:setup` — so run setup and restart before memory works on a fresh install. See [Memory server transport](#memory-server-transport) and [Server lifetime](#server-lifetime) below.

The server comes from upstream [pvliesdonk/markdown-vault-mcp](https://github.com/pvliesdonk/markdown-vault-mcp). The primary path is the bundled wheel under `hooks/wheels/`; the git install below is the fallback for when no wheel ships or `uv` is missing.

This plugin used to install from a `mikebronner/markdown-vault-mcp` fork, because the index-state fixes it relies on (persistent-index adoption at boot, offline-change reconciliation, tracker skip-state, embedding convergence, raw-transcript exclusion support) were not in any PyPI release. That is no longer true. Those fixes merged upstream on 2026-06-11 ([#666](https://github.com/pvliesdonk/markdown-vault-mcp/pull/666), [#667](https://github.com/pvliesdonk/markdown-vault-mcp/pull/667), [#668](https://github.com/pvliesdonk/markdown-vault-mcp/pull/668), [#670](https://github.com/pvliesdonk/markdown-vault-mcp/pull/670)) and first shipped in PyPI 3.0.0 on 2026-06-17. The fork now carries **no** commits upstream lacks, so pointing at it only pins you to a stale tree.

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
uv tool install --from git+https://github.com/pvliesdonk/markdown-vault-mcp markdown-vault-mcp --with fastmcp --with fastembed

# Alternative — pipx (isolated, no auto-Python-management):
pipx install git+https://github.com/pvliesdonk/markdown-vault-mcp

# Last resort — pip (global install, conflicts with system Python on modern
# macOS/Linux via PEP 668):
pip install --user git+https://github.com/pvliesdonk/markdown-vault-mcp
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

### Where the behavioural rules load

The rules load from one place: the output style `/workbench-core:setup` installs from `assets/personas/clear/output-style.md`. An output style is system-prompt tier, so it outranks the base prompt's defaults (such as "no emojis unless asked") without any shell alias, and it survives compaction on its own. It also reaches the main session only, which is where the rules belong.

No hook restates them. Earlier versions loaded the same rules four times per main session: the output style, a `~/.claude/system-overrides.md` file passed by a shell alias, the managed `~/.claude/CLAUDE.md` block, and a guardrails payload on the warmup's stdout. The copies drifted and contradicted each other. The `CLAUDE.md` copy also reached every sub-agent, which put "present options" and `AskUserQuestion` into agents that have neither a human nor the tool. `hooks/test-rule-source.sh` pins the new shape: eleven rules and three habits of shape in the output style, its pointer to the intake skill, the style obeying its own register, and no rule text in anything the warmup writes or prints.

The task-intake routine is not a rule, so it does not live in the output style. It is a procedure, and its one copy is `skills/intake/SKILL.md`. The style carries a one-line pointer to it, and `hooks/test-intake.sh` fails if the style starts restating it. See [Task intake](#task-intake).

The managed `~/.claude/CLAUDE.md` block now carries facts only: the gates, what each protects, and the scratch roots. Sub-agents need those facts, and each gate's deny carries its own recovery text.

**Retiring the old alias.** If your shell profile has `alias claude='claude --append-system-prompt-file ~/.claude/system-overrides.md'`, the CLI refuses to start when that file is missing. So the warmup never deletes it. It rewrites an existing file to a one-line stub with no rules, never creates one, and posts a startup notice until the file is gone. Finish the retirement in this order:

1. Remove the alias from your shell profile.
2. Open a new shell, so no running shell still carries the alias.
3. Delete `~/.claude/system-overrides.md`.

### Configure (required on first install)

The memory MCP server ships unconfigured. Run `/workbench-core:setup` on first install to set your paths:

| Setting | Description | Default |
|---------|-------------|---------|
| `agent_name` | Your agent's name, if it has one (e.g. `Ada`) | `Claude` |
| `memory_path` | Where your operational memory lives on disk | `~/Documents/Claude/Memory` |
| `memory_cache` | Where indexes, server artifacts, and checkpoints are stored | `~/.claude-memory-cache` |
| `memory_mcp_server_name` | MCP server name for the vault (`serverInfo.name`) | `workbench-memory` |
| `memory_port` | Loopback port the shared HTTP memory server binds and the MCP client connects to | `8765` |
| `auto_summarize` | Spawn background summary-writer (PreCompact, `/log-now`, and the session-start drain) | `true` |
| `summary_model` | Model for the background summary-writer | `sonnet` |

Setup also installs **permission safety rails** into `~/.claude/settings.json` — a `permissions.defaultMode` you pick, plus `deny` and `ask` rules shipped at `assets/permissions/rails.json`. Claude Code evaluates those rules deny → ask → allow *before* the auto-mode classifier, in every mode including `bypassPermissions`, which makes them the durable counterpart to a boundary stated in conversation (that one is lost when context is compacted). The merge is additive: it adds a shipped entry when absent, and never removes or reorders one you wrote yourself. See [Permission safety rails](#permission-safety-rails).

Configuration is stored in `~/.claude/plugins/data/workbench-core-claude-workbench/config.json` and survives plugin updates. The hooks resolve env from this file at launch (via `hooks/lib/memory-env.sh`), so a plugin version bump never clobbers your settings. Per-session stdio needs no port or bearer token in `settings.json` — those are provisioned by `/workbench-core:setup` only if you re-enable the optional shared HTTP server (see [Memory server transport](#memory-server-transport)).

### Install the output style

The plugin ships one persona under `assets/personas/<name>/`: an output style. `/workbench-core:setup` offers to install it (Step 2f), and every later run of setup re-syncs it:

```
/workbench-core:setup
```

It copies the style to `~/.claude/output-styles/` and sets `outputStyle` in `~/.claude/settings.json`. The output style sits in the system prompt, which outranks context and survives compaction, so nothing has to re-inject it.

The warmup does not write the output style, so a plugin update can leave the live copy behind the shipped one. When it does, the warmup notices report `⚠ Output style out of date`, and a re-run of setup brings it current. The persona used to have its own `/workbench-core:install` command, and nothing prompted a re-run of it: the live style once ran 8 days stale.

The persona shipped today is `clear`. It defines a writing standard rather than a character. Soul and profile files, the `define-soul` and `define-profile` interviews, and their `guardrails.md` rubric were retired on 2026-09-27: the output style was the only persona in use, and a second copy of its rules kept drifting from it. `docs/setup-design-notes.md` records the retirement.

### Execution-aware skills

Any skill can carry a persistent learnings file at `{memory_path}/skills/{skill-name}.learnings.md`: corrections, failures and confirmed approaches from past runs. When the Skill tool is about to run, `hooks/skill-learnings.sh` looks for that file. If it exists, the hook hands its text to the model as `additionalContext`, with the rule for adding to it. If it does not, the hook stays silent and costs nothing.

It applies to **any** skill — workbench skills, third-party plugin skills, your own personal skills — keyed by the bare skill name, so `workbench-core:memory-lint` and `memory-lint` share one file. A file too large for one hook message is pointed at rather than truncated, and the model reads it whole through the memory MCP. Delete a specific learnings file to reset that skill's accumulated state.

This used to be prose: the warmup told every session to read `identity/skills-protocol.md`, and nine skills restated it in their first line. The one limit it stated, 30 entries, was checked by nobody, and one learnings file reached 86 entries and 68 KB.

#### Compaction

When a learnings file passes **30 entries**, the hook adds a warning that names the compaction skill. `/workbench-core:compact-learnings` recommends a verdict for every entry and asks about them in batches through `AskUserQuestion`. `scripts/find-workbench-skill.sh` decides which kind of skill it is, by reading `~/.claude/plugins/installed_plugins.json`:

- **Workbench plugin skills** — learnings can be integrated into the SKILL.md (improving the skill definition) or kept/dropped. Integration is handed to Dr. Watson as a brief against the plugin's source clone, so it goes through the development flow and the commit gate; the installed copy is never edited
- **All other skills** — learnings are compacted (kept, rewritten, or dropped) without touching the SKILL.md

### Shared references

The `references/` directory contains single-source-of-truth documents shared across skills and the summary-writer agent:

| File | Used by | Purpose |
|------|---------|---------|
| `summary-format.md` | summary-writer, log-now | Required frontmatter, body structure, JSONL parsing guidance |
| `decision-promotion.md` | summary-writer, log-now | Promotion criteria, when NOT to promote, decision file template |
| `vault-conventions.md` | summary-writer, log-now | Vault paths, required frontmatter, write vs edit rules |
| `linking-synthesis.md` | summary-writer, log-now, memory-lint | Link syntax, related-document linking, topic-page synthesis, vault index contract |

References are loaded at execution time via `${CLAUDE_PLUGIN_ROOT}/references/`. The one the warmup reads is `memory-routing-stub.md`, which it copies into the project's `MEMORY.md` router. No rule reference reaches a session: the behavioural rules load from the output style alone (see [Where the behavioural rules load](#where-the-behavioural-rules-load)).

## Plugin layout

```
core/
├── .claude-plugin/
│   └── plugin.json              — manifest + MCP server config
├── agents/
│   └── summary-writer.md       — background narrative agent definition
├── assets/
│   ├── personas/              — the shipped persona (an output style)
│   └── prompt-templates/      — scheduled-task prompt bodies (decision-quality nightly)
├── hooks/
│   ├── hooks.json              — hook → script bindings
│   ├── session-log.sh          — raw log capture + summary-writer dispatch (not at SessionEnd)
│   ├── session-warmup.sh       — memory and scratch rules + retention cleanup + summary drain
│   ├── skill-learnings.sh      — PreToolUse(Skill): hand a skill its vault learnings file, warn past 30 entries
│   ├── mcp-memory.sh           — stdio launcher, retained but unwired (see Memory server transport)
│   ├── memory-server-up.sh     — shared-HTTP SessionStart kicker (disabled; retained for re-enable)
│   ├── memory-server-spawn.sh  — shared-HTTP detached supervisor (disabled; retained)
│   ├── memory-server-down.sh   — shared-HTTP manual stop (disabled; retained)
│   ├── memory-capture-stop.sh  — Stop: make the live session write its findings before context is shed
│   ├── memory-recall.sh        — UserPromptSubmit: inject relevant memory READS (recall)
│   ├── memory-scan-recall.sh   — PostToolUse: recall mid-turn, using a repo scan's own query
│   ├── outbound-prose-guard.sh — PreToolUse: check gh + board-MCP prose against the output style
│   ├── credential-guard.sh     — PreToolUse: block reads of ~/.ssh, ~/.aws, ~/.gnupg, and .env files
│   ├── destructive-database-guard.sh — PreToolUse: block Artisan resets, dropdb, and destructive SQL
│   ├── vault-git-guard.sh      — PreToolUse: block git WRITE commands aimed at the memory vault
│   ├── destructive-scope-guard.sh — PreToolUse: permit a destructive command inside the project or a
│   │                             scratch root, deny it outside — and deny what it cannot resolve
│   ├── provisioning-guard.sh   — PreToolUse: block worktree and database creation, on all four surfaces
│   ├── delegation-gate.sh      — PreToolUse: deny main-agent Write/NotebookEdit, redirect to sub-agents
│   ├── agent-dispatch-gate.sh  — PreToolUse: deny a main-agent Agent dispatch that skips the six-slot brief
│   ├── intake-nudge.sh         — PreToolUse(Edit): remind the main agent once per task to show its intake block (never denies)
│   ├── peer-message-gate.sh    — PreToolUse: deny a sub-agent SendMessage to anything but main or its own children
│   ├── lib/brief-template.sh   — the ONE definition of the six-slot brief (gate + deny message read it)
│   ├── lib/                    — sourceable libs: memory-env / -probe / -vacuum / -install, summary-dispatch, prose-check,
│   │                             memory-recall-core (levers both recall hooks share), scan-query (a scan's own query),
│   │                             shell_parse (shared tokeniser), destructive-db-check, vault-git-check,
│   │                             provisioning-check, destructive-scope-check
│   └── fixtures/               — test fixtures (fake-server stub, no real server)
├── docs/
│   ├── session-warmup-contributions.md — how plugins contribute warmup text
│   ├── setup-design-notes.md   — why setup's steps are shaped as they are, and what was retired
│   └── mcp-output-capping.md   — per-server MCP output-limit standard
├── references/
│   ├── decision-promotion.md   — when and how to promote decisions
│   ├── linking-synthesis.md    — link syntax, topic pages, vault index contract
│   ├── summary-format.md       — summary frontmatter + body template
│   └── vault-conventions.md    — paths, frontmatter rules, write conventions, the vault-git rule
├── skills/
│   ├── compact-learnings/      — review, compact, and integrate skill learnings
│   ├── setup/                  — configure agent name, paths, MCP settings
│   ├── evaluate-decisions/     — grade recorded decisions/memories → learnings report (REPS gear 2)
│   ├── propose-upgrades/       — learnings → reviewed proposals → apply on sign-off (REPS gears 3+4)
│   ├── log-now/                — dump + narrate the current session inline
│   ├── memory-lint/            — monthly vault health-and-repair pass
│   ├── cross-session-messaging/ — the protocol for messaging another session, and for receiving one
│   ├── orchestrator/           — per-session on/off toggle for the delegation gate
│   └── process-pending-summaries/ — dispatch background agents for pending markers, or for one session by ID
├── scripts/
│   ├── install-chat-skills.sh  — package + install skills into Claude Chat
│   ├── install.sh              — install the shipped output style
│   ├── permissions.sh          — merge the shipped permission rails into settings.json
│   └── memory-status.sh        — report the shared memory server's facts
└── README.md
```

## How it works

### Session lifecycle

These hooks fire across the session lifecycle and on each turn:

| Hook | Script | Purpose |
|------|--------|---------|
| `SessionStart` | `hooks/session-warmup.sh` | Memory and scratch rules, retention cleanup, pending-summary drain, housekeeping notices (written to a file, not injected) |
| `PostToolUse` | `hooks/memory-scan-recall.sh` | Mid-turn recall — search the vault with a repo scan's own query and inject hits beside the scan's results (matcher `Grep\|Bash`), **once per session** per memory, sharing that bound with `memory-recall.sh` |
| `PreCompact` | `hooks/session-log.sh` | Dump raw log checkpoint, spawn summary-writer |
| `PostCompact` | `hooks/session-warmup.sh` | Re-inject the memory and scratch rules after context compression |
| `SessionEnd` | `hooks/session-log.sh` | Dump final log segment and write the pending-summary marker — **no writer is spawned here** (see [Why SessionEnd does not spawn](#why-sessionend-does-not-spawn)) |
| `Stop` | `hooks/memory-capture-stop.sh` | Early in a session, then rarely, block the stop and have the live session write its durable findings to the vault — see [Pre-shed capture](#pre-shed-capture) |
| `UserPromptSubmit` | `hooks/memory-recall.sh` | Proactive recall — search the vault with the prompt and inject relevant memories, **once per session** per memory (memory **reads**) |
| `PreToolUse` | `hooks/outbound-prose-guard.sh` | Check prose leaving the machine against the output style's mechanical rules — see [Outbound prose guard](#outbound-prose-guard) |
| `PreToolUse` | `hooks/delegation-gate.sh` | Deny `Write`/`NotebookEdit` from the main agent so whole-file work goes to sub-agents. `Edit` is allowed — see [Delegation gate](#delegation-gate) |
| `PreToolUse` | `hooks/agent-dispatch-gate.sh` | Deny an `Agent` dispatch from the main agent unless its prompt uses the six-slot brief — see [Agent dispatch gate](#agent-dispatch-gate) |
| `PreToolUse` | `hooks/intake-nudge.sh` | On the first `Edit` of a task with no intake block on screen, remind the main agent to run the intake routine. Never denies — see [Task intake](#task-intake) |
| `PreToolUse` | `hooks/peer-message-gate.sh` | Deny a `SendMessage` from a sub-agent to anything but its own orchestrator or its own children — see [Peer message gate](#peer-message-gate) |

### How a gate speaks

Every gate here refuses the same way, and says so in the same shape. Read this once and the other seven sections need only name what each one blocks.

**The mechanism is the JSON deny, everywhere.** A `PreToolUse` hook that returns `permissionDecision: "deny"` refuses the call outright: no prompt appears, no allow rule overrides it, and `bypassPermissions` does not get through. Four guards used to block by exiting 2 instead, and exit 2 is strictly worse at the same job. Measured on Claude Code 2.1.274, it prefixes the model's message with the hook script's own absolute filesystem path and silently discards stdout, so the author does not control the first line a reader hits. Of the three verdicts a hook can return, only `deny` binds at all: `ask` is classifier-approvable and gets auto-answered under `permissions.defaultMode "auto"`.

**The refusal is split across two channels, because they have different readers.** The same measurement established where each field lands:

| Field | Reaches the human | Reaches the model |
|---|---|---|
| `permissionDecisionReason` | ✅ it becomes the `tool_result` | ✅ in full |
| `additionalContext` | ❌ | ✅ in its own block, and it **survives a deny** |
| `systemMessage` | it is the pure human channel by construction | ❌ never |

So a refusal is written twice over:

```
permissionDecisionReason   🛑 Blocked: destroying a database. Run it yourself with the ! prefix if you meant it.
additionalContext          Destructive-database guard (workbench-core). `php artisan db:wipe` empties or
                           rebuilds the database it resolves to … Nothing an agent does should destroy a
                           database, and there is no flag to clear and no path around this …
```

**The human line names the action, and stops.** One line, under about 120 characters, opening with `🛑 Blocked:` and then what you were trying to do. It carries at most one more clause, and only when that clause is something the *human* acts on — the `!` prefix, or a different tool argument. It never replays the command, never carries a request id, and never explains policy. Those are all things only an agent acts on, and they are exactly what used to fill the screen.

**Everything an agent needs to recover is in `additionalContext`**, opening with the gate's own name so the model can report which gate fired. Nothing was deleted in this split; it stopped being in the way. A gate that refuses without telling the agent how to proceed turns one refusal into several.

**`systemMessage` is not used for the human line**, despite being the purer channel. None of the probe's sentinels reached this user's client, so a line written only there would land somewhere nobody reads. `permissionDecisionReason` is the text already on screen, so shortening that is what answers the complaint, whatever a given client does with the rest.

**No Markdown emphasis, anywhere.** Whether a client renders these fields as Markdown is unsettled, and the model receives the raw source either way, so `**commit**` risks showing up as `**commit**`. Emphasis is carried by position — the action leads the line — and by backticks, which read as a quoted command whether or not they render.

The record behind all of this is `insights/2026-09-17-hook-message-channels-measured.md` in the memory vault.

Two `PreToolUse` hooks still exit 2 and are not gates in this sense: `hooks/outbound-prose-guard.sh` and `hooks/summary-writer-guard.sh`. Both hand a revision brief to the model rather than a verdict to a person.

### Delegation gate

**The main agent orchestrates. It does not write whole files.** A written "delegate work to sub-agents by default" rule said so in prose for months, and prose drifts: the main conversation builds one file to "just get it done", and the context it was supposed to stay lean for is gone. `hooks/delegation-gate.sh` makes it structural. `Write` and `NotebookEdit` from the main agent return `permissionDecision: "deny"`. Per [How a gate speaks](#how-a-gate-speaks), the human reads `🛑 Blocked: writing a whole file from the main agent. New files go to a sub-agent.`, and the destination and the escape hatch go to the model in `additionalContext`. The deny is not overridable by permission mode: `bypassPermissions` does not get through it.

**`Edit` is allowed, since 2026-09-27.** The gates audit that day measured a delegated one-line edit at tens of thousands of tokens, against about 200 for the same `Edit` inline. The deny also pushed the model toward `sed -i` and heredocs through `Bash`, which reach the same file past every guard anyway. A whole-file `Write` is where main-session context actually grows, so that half of the gate stays. The matcher is `Write|NotebookEdit`, and branch (e) below lets an `Edit` through if anything else ever routes one here.

It is deliberately plugin-agnostic. Every install ships built-in sub-agents (general-purpose, Explore, Plan) reachable through the `Agent` tool, so the gate always has somewhere to send the work. When a dev-team plugin *is* installed, the `additionalContext` names it too, via a runtime directory probe of `~/.claude/plugins/cache/*/workbench-dev-team`. That is a runtime read, never a build-time dependency: core stays ignorant of any plugin, and a plugin opts into core's contract rather than the other way round.

**How it tells a main agent from a sub-agent.** The `PreToolUse` payload carries the signal, verified empirically on Claude Code 2.1.260 against a logging-only hook:

| Caller | `agent_id` | `agent_type` |
|---|---|---|
| Main agent (interactive or `claude -p`) | absent | absent |
| Sub-agent (Task tool) | present | present |
| Top-level `claude -p --agent <name>` | **absent** | present |

That third row is why `agent_type` alone has to allow: a scheduled `claude -p --agent <name>` run is top-level in its own session and carries no `agent_id`, so gating on `agent_id` alone would kill every scheduled run at its first file write. `CLAUDE_CODE_CHILD_SESSION` is **not** a usable signal, because it was `1` in all three cases, including a plain main session.

**Allow branches, in order.** Any one of these lets the call through: (a) `agent_id` is set, so the call is a sub-agent, which is the destination this gate redirects to; (b) `agent_type` is set, a top-level `--agent` dispatch; (c) `WORKBENCH_ORCHESTRATOR=0` in the environment, which is how an automated harness opts its own run out; (d) the session toggle is off; (e) the tool is not `Write` or `NotebookEdit`, which the matcher should already have handled; (f) the target is a file in a scratchpad: this session's, matched by session id with no symlink at any level, or the login home's `Developer/scratchpad`, with the home read from the password database rather than `$HOME`. The target is compared physically and may not itself be a symlink. The main session writes a `git commit -F` message or a PR body there, as the identity block and the commit gate tell it to, and every such write used to be denied; (g) anything went wrong.

**Turning it off for a session.** `/workbench-core:orchestrator off` writes an empty file named for the current session under `$WORKBENCH_ORCHESTRATOR_STATE_DIR` (default `~/.claude-workbench/orchestrator-mode/`). The gate stands down while that file exists. `on` removes it, and no argument reports the state. The gate is **ON by default**, so an absent file means enforcement: every new session starts gated and nothing leaks between sessions. The file is keyed by `$CLAUDE_CODE_SESSION_ID`, which equals the `.session_id` the hook reads from its payload (verified live), so the skill and the hook agree on the key without passing anything between them. Each invocation prunes state files older than 7 days, so the directory does not accumulate one file per session forever.

**The gate announces itself** in the identity block `hooks/session-warmup.sh` writes into `~/.claude/CLAUDE.md`. Core is excluded from `collect_session_warmup_contributions` by design (see [docs/session-warmup-contributions.md](docs/session-warmup-contributions.md)), so there is no root `session-warmup.md` to carry the notice, and an unannounced deny reads as a malfunction rather than as a rule.

**Fail-open, and what that costs you.** Every error path exits 0 and allows the call: a malformed payload, a missing `jq`, an unreadable state directory, or a session id the toggle cannot address. This matches `hooks/credential-guard.sh`, because a guard that errors must never brick a session. Be clear about the trade. **If this script breaks, enforcement stops silently and there is no layer behind it.** Nothing announces that the gate is down; the main agent simply starts writing whole files again. It is a discipline aid, not a security boundary, and should never be relied on as one.

**`Bash` is not gated, so the gate is trivially sidesteppable.** The matcher covers two tools, and `printf 'x' > file` writes a file without touching any of them. This is deliberate: gating `Bash` would break `git`, the test runners, and every read-only command the orchestrator still needs. It also means a main agent that treats the deny as an obstacle can route around it in one call. The rule the gate backs is prose, in the identity block the warmup writes into `~/.claude/CLAUDE.md`, and it says a deny is the system working rather than something to defeat. Enforcement that a determined agent cannot evade is not on offer here.

A session id holding anything outside `[A-Za-z0-9._-]` is refused rather than resolved, which keeps a `../` from walking out of the state directory. Refusal means fail-open here: a session that cannot address its own toggle has no honest escape hatch, so the gate stands down rather than trapping the user.

Tests: `hooks/test-delegation-gate.sh` (71 cases: every allow branch independently, the deny path, `Edit` allowed from the main agent, byte-exact deny JSON, the conditional dev-team enrichment, `hooks.json` wiring, and agreement with the toggle skill).

### Agent dispatch gate

**A handoff to a sub-agent states the outcome, and it uses the brief.** The delegation gate sends file work to a sub-agent. This gate governs what that handoff has to look like. `hooks/agent-dispatch-gate.sh` denies an `Agent` dispatch from the main session whose prompt is missing any of the six slots:

```
Workdir:     absolute path of the tree the agent works in, and the branch or worktree if one was settled
Goal:        concise, measurable, achievable. One or two sentences.
Context:     prose. Why the task exists, and what the agent cannot derive.
Constraints: bullet points. Hard limits, or "none".
Acceptance:  bullet points. The criteria the work is graded against, one per line.
Done when:   observable finish line.
```

**`Workdir:` names the tree, so it carries the branch too.** A branch or a worktree is part of naming which tree the agent works in. `workbench-dev-team` asks the human before it creates either one, and the settled answer rides in this slot rather than in a slot of its own or a `Constraints:` bullet. A bare absolute path stays fully valid: most dispatches settle nothing, and `process-pending-summaries` dispatches into the memory vault, where no branch applies. Nothing about enforcement changes here. The gate greps the headers and never reads slot content, so both shapes already pass.

**`Acceptance:` carries the criteria the intake routine derived.** [`/workbench-core:intake`](#task-intake) turns the goal and the context into acceptance criteria before any work starts, and grades its options against them. The slot hands the same list to the receiving agent, so it grades its own forks against the list and reports against it. Before the slot, a brief said what to do and when it was done, but not what "good" meant in between. The gate checks the header and never the criteria, exactly as it does for `Context:`. A brief written before this slot existed is refused, and the refusal names `Acceptance:` alone.

**Those six slots are defined once, in `hooks/lib/brief-template.sh`.** The gate's checks and the deny message's slot list are both generated from that file, so renaming a slot changes what is enforced and what is asked for in a single edit. Before it existed the template was restated in four places with no shared source, and renaming the first slot from `Repo:` to `Workdir:` is the drift that argued for it — core dispatches work that has no repo, since `summary-writer` operates on the memory vault. A test fails if any consumer restates a slot inline again, and another fails if a slot in the definition is not actually enforced.

**It checks slot presence and nothing else.** It does not decide whether the work is code work, it does not decide which sub-agent should receive it, and it does not judge whether `Goal:` states an outcome rather than a numbered script. Those are questions about substance, and they belong to the agent reading the brief.

That division is the whole design, and it was reached by measurement rather than taste. Three prompt-classifying heuristics were built and scored against 14 days of real dispatches — 97 main-agent dispatches to generic sub-agents, of which 19 genuinely wrote source:

| Heuristic | Fired | Right | Wrong | Missed | Precision | Recall |
|---|---|---|---|---|---|---|
| Narrow | 6 | 5 | 1 | 14 | 83% | 26% |
| Medium | 39 | 13 | 26 | 6 | 33% | 68% |
| Broad | 47 | 16 | 31 | 3 | 34% | 84% |

The wrong ones were not tunable away. They were prose tasks naming source files they never write ("read `gt7_optimize.py`, then fix only the Markdown") and read-only audits naming every file they inspect. Telling those apart needs the write-target-versus-read-target distinction, which is semantic, and a shell hook cannot make it. A structural check has no false-positive problem at all, which is why it replaced all three.

**Because the check is structural, it applies to every dispatch from the main session, research included.** That universality is load-bearing rather than incidental: requiring the brief everywhere is exactly what removes the need to guess which dispatches are code work.

**`Context:` presence is required and its value is never read.** Whether that slot may say `none` is owned by the plugin that ships the brief, not by this gate, and header presence is true under either answer.

**No length is enforced anywhere.** A prose `Context:` slot runs long by design — the measured median across 70 real briefs is 4,788 characters, and only one came in under 1,000. Any ceiling would deny essentially every well-formed brief.

**Allow branches, in order.** Any one of these lets the call through: (a) `agent_id` is set, so a sub-agent is dispatching its own helper, which is what keeps a review-lens fan-out working (422 such dispatches in the same 14 days); (b) `agent_type` is set, a top-level `--agent` dispatch, which covers every scheduled pipeline run; (c) `WORKBENCH_ORCHESTRATOR=0`; (d) the session toggle is off; (e) the tool is not `Agent`; (f) the prompt is absent, empty, or not a string; (g) the prompt is one of two fixed machine-built shapes.

**The two exempt shapes** are assembled by a script from an id or a slug, so there is no brief to write:

| Shape | Built by |
|---|---|
| `Item ID: <n>` | workbench-dev-team `bin/dispatch-agent.sh` |
| `Repo sweep: <owner/repo>` | workbench-dev-team `bin/dispatch-agent.sh` |

Both are anchored at each end and must be the entire prompt. Matching them as a prefix would let any brief walk past the gate by opening with `Item ID: 12` and continuing in free prose.

**There is no third shape, and that is deliberate.** Core's own `summary-writer` dispatch was briefly exempted by a `Process pending session summary.` sentinel, because `skills/process-pending-summaries` sent a fixed key/value prompt rather than a brief. A sentinel is a bypass string sitting in an enforcement path: it patches the caller's problem inside the enforcer, and any prompt that wears the string inherits the exemption. The caller now sends a real six-slot brief and passes on its own merits, so the sentinel is gone rather than merely unused. A test asserts both halves — that the skill emits no sentinel, and that the retired string earns no special treatment.

**The prescriptive-prompt hint never blocks.** Once the six slots are present, a brief carrying a fenced code block, a shell command on its own line, or three or more numbered steps gets a note attached as `additionalContext`. Over-specified method wastes the sub-agent's judgement, but it does not break anything the way a missing slot does, and the markers are far too common to sit behind a refusal: fenced blocks appear in 40% of real briefs and numbered steps in 51%. The shell-command marker is line-anchored on purpose, because matching a command anywhere in the text fires on 91% of briefs, including prose that merely mentions `git log`.

The hint emits `additionalContext` and **no `permissionDecision`**. That is deliberate and load-bearing: the harness only touches permission behaviour when that key is present (verified against the 2.1.263 binary), so the hint cannot silently grant a permission the call would otherwise have had to ask for.

**Escape hatches are the delegation gate's, unchanged**, so one mental model covers both and `/workbench-core:orchestrator off` stands both down together. See [Delegation gate](#delegation-gate) for the toggle's mechanics.

**Expect it to bite on day one.** Replaying all 196 real main-agent dispatches from the 14-day sample through the finished hook denies 194 and allows 2, and the 2 are the pipeline shapes. Ten of those denials are historical `summary-writer` prompts in the retired sentinel form. Replaying the same corpus with the brief the skill now sends gives 184 denied and 12 allowed, which is the number that describes current behaviour. That is not a tuning problem: no prompt written before the template carries the slots, so the gate refuses whatever the main agent writes out of habit until the prose retrains it. The session toggle is the pressure valve if that lands at a bad moment.

**It inspects a prompt body, not a command line, so it has to stay cheap.** It judges a 12,000-character brief in well under a second. Getting there mattered: the first implementation used `${PROMPT//[[:space:]]/}` and a two-step bash trim, both quadratic over a multi-kilobyte string. Measured on real briefs, 5.7 KB took 10 seconds, 6.9 KB took 18, and 8.0 KB took 29. Against a 4,788-character median that would have stalled every dispatch for tens of seconds. Both are `grep` now, and a timing case in the suite holds a 3-second budget on a 12 KB brief. The same trap waits in any hook that reads a prompt rather than a command: bash string expansion does not scale to prompt-sized input.

**Fail-open, and what that costs you.** Every error path exits 0 and allows the call: a malformed payload, a missing `jq`, an unreadable state directory, a session id the toggle cannot address, or a prompt that is not a string. Be clear about the trade. **If this script breaks, enforcement stops silently and there is no layer behind it.** Nothing announces that the gate is down; the main agent simply starts dispatching free-form prompts again. It is a discipline aid, not a security boundary.

Like the delegation gate, it is sidesteppable and deliberately so. Slot headers are cheap to bolt onto a 17,000-character prompt, and the gate will pass it. What survives that is the receiving agent's own check on substance, which is where the judgement belongs.

Tests: `hooks/test-agent-dispatch-gate.sh` (195 cases: every allow branch independently, each of the six slots pinned by its own omission fixture, `Acceptance:` held to a presence check with the pre-slot brief refused by name, a `Workdir:` carrying a branch and one carrying a worktree, the deny and hint paths, the hint's absence of a permission grant, each exempt shape plus its prefix-smuggling counter-case, a realistic read-only dispatch passing clean, `hooks.json` wiring, the shared-definition drift guards, and agreement with the toggle skill and the summary-writer skill).

### Task intake

**Before a task that produces work, the agent runs one routine, and shows its result before the work starts.** The routine is `skills/intake/SKILL.md` (`/workbench-core:intake`): state the goal, gather context from the prompt, the repo, and the vault, interview the user through `AskUserQuestion` only about gaps none of those can fill, derive acceptance criteria, and show them in an intake block. Then it drafts three options from genuinely different angles, checks in writing that they are not variants of one approach, grades each against every criterion, and recommends the best grade. The options go to the user only at a real fork. Otherwise the agent proceeds on the top grade and says so in one line.

**It exists because asking had become only a fallback.** No file in the workbench made intake a step, and several rules pushed against asking at all: research before asking, "blocking uncertainty only", options "only where they earn their place", and two vault notes against re-asking. The fix is a routine rather than a louder rule. What keeps the routine from slowing work down is its bar. A question is asked only when the answer is not in reach and a wrong guess wastes real work. What makes the silence safe is the intake block: the goal and the criteria are on screen before work starts, so every assumption can be corrected in one line.

**The skill decides when intake applies, and no hook does.** Trivial asks and pure questions skip it. Sub-agents take their brief as the intake, and the Index pipeline and scheduled ticks never interview. The [agent dispatch gate](#agent-dispatch-gate) carries the criteria across a handoff in its `Acceptance:` slot.

**`hooks/intake-nudge.sh` is a reminder, and it never denies.** On the first `Edit` of a task, it looks for a Markdown heading naming "Intake" in the assistant's text. If there is none, it attaches one line of `additionalContext` pointing at the skill, and the edit goes ahead untouched. A deny here would be a judgement-call deny, which is what f18a2f9 removed because it breeds workarounds.

- **A task is the latest human prompt.** Claude Code stamps those records `"origin":{"kind":"human"}`. Tool results, sub-agent hand-backs, and task notifications carry no such stamp, so none of them opens a new task. That field is undocumented Claude Code behaviour, checked against 400 recent transcripts on 2026-09-29. If a CLI release renames or drops it, the hook finds no prompt and goes silent, with no error anywhere. Re-check it after an upgrade if the nudge stops appearing.
- **Once per task.** The prompt's id is kept in `~/.claude-workbench/intake-nudge/<session_id>`, so later edits on the same prompt are silent. Files older than three days are swept, like the sibling state directories.
- **An approved intake counts.** A block that closed the turn before the prompt (the agent showed it, asked "proceed?", and got "yes") keeps the nudge quiet. A Stop hook that wakes the agent after that question, such as the memory capture checkpoint, does not reopen the turn: tool calls after it leave the closing text alone. A block from the start of an earlier task does not count.
- **Only assistant text counts.** An `Edit` whose new text contains an intake heading is not an intake block.
- **Lanes that never see it:** sub-agents and `claude -p --agent` runs (by `agent_id` and `agent_type`, as the delegation gate reads them), and scheduled ticks (the current prompt opens with the `<scheduled-task>` wrapper). Only the current prompt decides, so a typed task later in a session that began as a tick is nudged like any other.
- **Every failure is silence.** A missing `jq`, an unreadable transcript, or state that cannot be written all exit with no output. Unwritable state stays silent rather than nudging on every edit.

Tests: `hooks/test-intake.sh` (the skill's routine pinned step by step, including the gap test and the written distinctness check; the output style pointing at the skill without restating it; the skill's own block silencing the hook; and the nudge's once-per-task, approved-intake (including a Stop hook wake before the answer), lane, scope, retention, and failure cases, plus an assertion that no output of the suite carries a permission decision).

### Peer message gate

**Claude Code sessions can message each other, and the capability shipped ungoverned.** `ListAgents` from this repo listed five live peer sessions and `SendMessage` reached any of them, with no hook, no skill and no rule anywhere in this plugin. The behaviour is wanted — a hand-run cross-session peer review between two sessions caught a real shared-script bug — so it is bounded rather than removed. The protocol is prose, in `skills/cross-session-messaging/SKILL.md`. `hooks/peer-message-gate.sh` enforces the one part of it that is structural.

**Sends are model-initiated, so the receiving side is the only human checkpoint in the loop.** A session may reach out on its own when it notices shared surface. A session that *receives* a peer message surfaces it to its own human and stops: no edit, no commit, no dispatch on the strength of it. Without that rule two models drive each other end to end with nobody watching. The harness already states that a peer message carries no user authority; the skill turns that notice into the working protocol, and the consequence worth stating is that a useful message **informs** rather than **asks**. "Your build shim drops `$TERM` under a Herdr startup command" is the shape that works. "Please fix X for me" is the shape the receive rule refuses. None of that is enforceable, and none of it is in the hook.

**What the hook does enforce: a sub-agent sends up to its orchestrator and down to its own children, and nowhere else.** A sub-agent is unattended by definition, so a model-initiated peer send from one is a message nobody chose to send arriving where nobody was warned. It also does not work — per the tool's own contract a sub-agent's peer send goes out under the parent session's address and any reply lands in the parent's conversation — so the gate closes a channel that was already one-way and misattributed.

| Caller | Destination | Verdict |
|---|---|---|
| Top-level (a human's session, or `claude -p --agent`) | anything | allow, silently |
| Sub-agent | the literal `main` | allow, silently |
| Sub-agent | an agent-id-shaped destination | allow, **with an advisory** |
| Sub-agent | anything else | **deny** |

**`agent_id` alone decides the caller, and that differs from the sibling gates on purpose.** [The delegation gate](#delegation-gate) and [the agent dispatch gate](#agent-dispatch-gate) key on the same measured three rows, but they allow on `agent_type` as well so a scheduled `--agent` run gets through. Here that second branch would be wrong: `agent_type` is present for a real sub-agent too, so allowing on it would allow the only case this gate gates. Row three needs nothing extra, because a top-level `--agent` run carries no `agent_id` and is already on the allow side of the single test. That is what makes a pipeline agent top-level and free to send, which was a deliberate decision taken against a recommendation to treat it as a sub-agent. Nothing is exposed by it today: no dev-team agent carries `SendMessage` at all.

**The advisory branch exists because the down direction cannot be enforced, measured three ways.** Spawn records carry no spawner identity. `isSidechain` is `false` on all 722 transcript entries, so a `parentUuid` walk cannot even establish that a spawn came from a sub-agent. A sweep for agent-id-shaped values across the whole transcript found none that names a spawner. And sub-agents **share** the parent's transcript, so any "is this my child?" check would read children spawned by everyone and wave a sibling through. The harness enforces nothing here either: a sub-agent sending to a sibling it did not spawn was measured succeeding, and it *resumed* that sibling. So an id destination is allowed with a note naming the one question only the model can answer. [The agent dispatch gate](#agent-dispatch-gate) already pairs an advisory with a deny, so this is that file's pattern rather than a new one.

**What is measured, and what is inferred.** Measured live on Claude Code 2.1.274 with a logging-only probe, the same method the dispatch gate cites in its own header: `PreToolUse` fires for `SendMessage` at all; `to: "main"` passes through as the literal string `main`, unrewritten, and a sub-agent sending to it succeeds; a sub-agent sending to a sibling's id succeeds; and an agent id looks like `a5a2f4470341f9233`, lowercase hex, 17 characters.

One thing is **inferred, never measured**: that a peer session's destination does not look like an agent id. A peer appears in `ListAgents` as a name — `herdr-b5`, or `herdr-b5 [72839a]` — and neither form is lowercase hex. No peer send was ever captured, because messaging live sessions was forbidden and a probe message interrupts somebody's real conversation. **The fourth branch rests on that inference, which is exactly why the deny is the default rather than a narrow rule.** Every destination form nobody has measured falls into it and is refused. Wrong in this direction, a legitimate child send is denied and the sub-agent reports up instead, which costs one message. Wrong in the other, the gate would silently admit the thing it exists to stop.

**Both destination fields are read, and that is not belt-and-braces.** `tool_input` carries doubled fields. One measured send produced `to` and `recipient` holding the same id, plus `message` and `content` holding **different** strings: `message` was the 74-character text actually sent, and `content` was an unrelated 50-character string that hash-testing could not derive from the message, the summary, or any truncation of either. The pairs are not guaranteed to agree, so a gate reading only `to` would be checking a field the harness might not be the one to honour. Every destination value present is classified and the strictest verdict wins — one unrecognised form denies, whatever the other field says.

**The body is never read.** Not because of the doubling, but because judging whether a stated reason is a good reason is semantic, and this plugin has the measurement for what that costs: the dispatch gate's three prompt-classifying heuristics scored 83% precision at 26% recall against 34% at 84%, with the wrong answers not tunable away. The skill requires a declared reason; the gate does not check for one and does not pretend to.

**The id test is spelled out in codepoints rather than written as a regex.** jq's `test` uses Oniguruma, where `$` matches at the end of the string *or* before a trailing newline, exactly as in Perl. Measured on jq 1.7.1, `"a5a2f4470341f9233\n"` satisfies `test("^[0-9a-f]{16,}$")` and would have passed as an agent id. `explode` with an explicit 48-57 / 97-102 range closes that without depending on any anchor semantics, which is the same reasoning the sibling guards give for spelling their whitespace out in ASCII instead of trusting `[[:space:]]`. Uppercase hex is therefore **not** an id: it is a form nobody measured, and it lands in the deny with everything else unmeasured. The 16-character floor sits below the 17 that was measured and above anything a session name plausibly is; pinning it to exactly 17 would deny every legitimate child send the day the harness changes its id width.

**`ListAgents` is deliberately not gated,** though `PreToolUse` fires for it too. Listing peers is read-only, the send is where the harm would land, and the send is gated. Its `tool_input` also arrives **empty**, so any rule about it could only ever key on the caller. A deny there would buy a sub-agent an earlier refusal for the cost of a fork on every call, so the matcher names `SendMessage` alone.

**No escape hatch, and none is needed.** This gate never fires on a human, because a person types into a top-level session and that is the first allow branch. There is nothing for `/workbench-core:orchestrator` to stand down, and wiring that toggle in would let one unrelated request — "let me edit inline" — also open peer messaging from every sub-agent in the session.

**Fail-open, and what that costs you.** A malformed payload, a missing `jq`, a `tool_input` that is not an object, or a send carrying no destination at all each exit 0 and allow the call. The threat here is a confidently wrong agent, not a crafted payload. Be clear about the trade: **if this script breaks, enforcement stops silently and there is no layer behind it.** Nothing announces that the gate is down.

Tests: `hooks/test-peer-message-gate.sh` (92 cases), weighted on two axes. Every allow branch is covered independently, because a gate that refuses a legitimate send is a gate that gets removed. Every deny is covered by the *form* of the destination rather than by one example — uppercase hex, short hex, hex with a separator, a trailing newline, a non-string value — so "anything nobody measured is refused" is asserted rather than assumed. The suite also pins the two files to each other: the skill slug is read out of the gate's own deny message, and the skill is checked for claiming nothing the gate contradicts.

### Outbound prose guard

An output style governs *replies*. Claude Code reinforces it after every turn, and that reminder rides on the response, so it never reaches a document composed inside a tool call. A pull request body written to a file and piped through `gh pr edit --body-file` escapes the standard completely.

That is not hypothetical. `insight-llc/decisioncloud#21665` shipped a 1,855-word body with no emoji, twelve em dashes, and nineteen sentences past the twenty-word limit, in a session where the style was loaded and being followed in the terminal the whole time.

`hooks/outbound-prose-guard.sh` closes the gap for artifacts other people read: `gh pr create|edit|comment|review`, `gh issue create|edit|comment`, `gh release create|edit`, and the same prose posted through a project board MCP (`add_comment`, `submit_review`, `create_issue`, `set_acceptance_criteria`). It exits 2 on a violation, and stderr on a blocking `PreToolUse` hook reaches the model, so the findings become the revision brief.

`hooks/lib/prose-check.py` holds two checks, both from rule 8 of the shipped output style:

| Finding | Rule |
|---------|------|
| `em-dash` | Join ideas with a colon, a parenthesis, or a full stop |
| `semicolon` | Never a semicolon |

**What it does not check.** Whether a body leads with the answer, whether it is dense, how long its sentences and paragraphs run, and whether it carries emoji. Earlier versions denied on emoji, sentence length, and paragraph length. Those checks were removed because a deny on a judgement call breeds workarounds: the writer pads in an emoji or chops a sentence to pass the count, and the text gets no easier to read. Density is rule 11 of the output style, applied by the writer.

**What it exempts,** because the author does not control it: fenced and inline code (a semicolon there belongs to the language), HTML comments, bot-authored regions such as CodeRabbit's release notes, `- [ ]` checklist lines from a repository pull request template, and URLs inside markdown links. A bare `PULL_REQUEST_TEMPLATE.md` passes clean, which is the calibration that matters. A gate that blocks the template blocks every pull request.

**It fails open.** A heredoc, a command substitution such as `--body "$(cat notes.md)"`, or an unreadable path exits 0 rather than blocking. This is a style gate, not a security boundary, so a false block costs more than a missed check. `hooks/credential-guard.sh` makes the same trade for the same reason.

**It costs an ordinary Bash call no Python.** The matcher sends every `Bash` call here, and the parser only ever reads a command in which `gh` is a token and the subcommand is a `pr`, `issue`, or `release` verb. So a bash test runs first: with quotes and backslashes deleted, the command has to name `gh`, one of those three nouns, and one of `create`, `edit`, `comment`, or `review`, each as a whole word, or the guard exits before Python starts. Deleting the quotes matters because the parser's `shlex` joins `g""h` into `gh`. The board-MCP tools skip that test, because the matcher already limits them to the four prose-carrying tools.

**Terminal replies are out of scope,** and cannot usefully be brought in. A `Stop` hook fires after the reply has already been displayed, so blocking there appends a correction instead of preventing the text. Replies are governed by the behavioral overrides, which sit at system-prompt tier.

### Destructive database guard

On 2026-09-04, in an unrelated Laravel repo, Claude ran `php artisan db:wipe --database=pgsql --force`, believing `pgsql` named the testing database. It does not. `phpunit.xml` only overrides `DB_DATABASE=testing` inside a test run, so an Artisan command typed at the shell resolves `pgsql` against `.env` — the development database. Every table was dropped and several hours of imported data went with them. No permission rule matched, so nothing prompted: the rails guarded disks, git history, and `rm`, and said nothing at all about databases.

`hooks/destructive-database-guard.sh` is the enforcing layer. It is a `PreToolUse` hook on `Bash` that returns `permissionDecision: "deny"`, so no prompt appears and no allow rule reaches it. The human reads `🛑 Blocked: destroying a database. Run it yourself with the ! prefix if you meant it.`; which command, which target, and which flag go to the model in `additionalContext` (see [How a gate speaks](#how-a-gate-speaks)). Three rule classes:

| Class | Blocked |
|---|---|
| Artisan | `db:wipe`, `migrate:fresh`, `migrate:reset`, `migrate:refresh` |
| Shell | `dropdb`, `dropuser`, `mysqladmin ... drop` |
| Docker | `down -v`, `rm -v`, `volume rm`, `volume prune`, `system prune --volumes` |
| Project | `ddev delete`, `ddev stop --remove-data`, `lando destroy`, `wp-env destroy` |
| Raw SQL | `DROP DATABASE\|SCHEMA\|TABLE`, `TRUNCATE`, `DELETE FROM` with no `WHERE` |

**Verb position, not substring.** This is the whole difficulty. A substring match for `drop table` also blocks `grep -rn "drop table" app/` and reading `2026_09_04_drop_users_table.php`, which would make ordinary code search impossible. So `hooks/lib/destructive-db-check.py` tokenises the command with `shlex`, splits it into statements and pipeline stages, strips wrappers, and only then matches. That mechanical half now lives in `hooks/lib/shell_parse.py`, shared with the vault git guard; the verb tables and every blocking decision stay in the checker that owns them. An Artisan verb has to sit in the argument slot after `artisan`. SQL is read only from a SQL client's payload, so `grep` is structurally unreachable.

**A prefix rule cannot see any of these**, which is the argument for a hook rather than a deny rule alone. Each shape below hides the verb behind something, and the incident itself was the first one:

```
cd /repo && php artisan migrate:fresh          compound
sail artisan db:wipe                           shim
docker compose exec -u www-data app php artisan db:wipe
ssh box "php artisan migrate:reset"            one quoted token
bash -c "php artisan db:wipe --force"          one quoted token
kubectl exec pod/api -- php artisan db:wipe    after the -- separator
echo "DROP DATABASE app" | psql                SQL is upstream of the client
psql -d app <<'SQL' ... SQL                    heredoc body
```

**Artisan carries a testing exemption.** `--env=testing` or `--database=testing` allows the reset, because rebuilding the testing database is ordinary work and the incident was a wrong *target*, not a wrong verb. A bare `migrate:fresh` still blocks, since bare inherits `.env`. **The hole, stated plainly:** `--env=testing` proves intent, not target. A project whose `.env.testing` points at the development database still walks through. This narrows the mistake, it does not close it.

**Docker is scoped the same way, and for the same reason.** A containerised database keeps its data in a named volume. `docker compose down` leaves those alone and is how a stack gets stopped, so the plain form has to keep working. The destructive half is `--volumes`, and that flag sits *after* the subcommand, which is exactly where a prefix deny rule cannot look. So `down -v`, `rm -v`, `volume rm`, `volume prune`, and `system prune --volumes` block. Plain `down`, `up`, `docker rm`, and image or builder pruning do not. `sail down -v` blocks too, because sail proxies docker compose. `docker run -v /host:/app` is a bind mount and stays allowed, since the guard only reads the flag on verbs that delete.

**SQL that arrives in a file is read, not guessed at.** `psql -f reset.sql` and `mysql app < dump.sql` hide the payload on disk, so the guard opens the file and scans it with the same rules. The name settles nothing: `reset.sql` is often a seed, and `setup.sql` often drops the schema first. Four properties keep that affordable and safe:

| Property | What it means |
|---|---|
| Conditional | No file opens unless the statement already holds a SQL client **and** names a file. `grep`, `git`, and `npm` pay nothing. |
| Bounded | The read stops at 1 MB. Measured worst case is about 75 ms over the hook's own startup, on a 22 MB dump. |
| Regular files only | A fifo would hang the hook forever, so the mode is checked with `os.stat` before anything opens. Verified: a fifo returns in 0.08s. |
| Never quoted | The finding names the path and the verb class. No line of the file reaches the message, because that would put its contents in the transcript. |

A relative path resolves against the tool call's `cwd`, and a leading `cd` in the same command moves that base, so `cd db && psql -f reset.sql` finds the right file. File reading stops at the `ssh` boundary: the remote machine has its own filesystem, so a local file of the same name is the wrong file, and reading it could only produce a false block. **The stated limit:** a `DROP` past 1 MB is missed. In `pg_dump` output the `DROP` lines sit at the top, which is the case worth catching.

**It fails open, for a different reason than `credential-guard.sh` gives.** There is no adversary here. The threat is a confidently wrong agent, not someone crafting input to slip past a parser. A command that actually destroys data must be valid shell to run at all, so it tokenises — anything unparseable is something bash would likely reject too, and blocking it would break every `awk` one-liner with an odd quote while stopping nothing that could execute. One hardening step before giving up: a POSIX tokenise failure is retried with `posix=False`.

**Past the read ceiling it refuses instead, and that is not a contradiction.** Unparseable text is text the checker read and could not understand; a truncated command is text it never saw, and the `db:wipe` can be sitting in the part it never saw. The checker reads its 200,000-byte `MAX_INPUT` with one byte of headroom so the two states are distinguishable. Until 2026-09-21 they were not, and 200KB of padding ahead of `php artisan migrate:fresh` turned this deny into silence — measured through the shipped hook. The human line gets its own words there, `🛑 Blocked: a command too long for the database guard to read.`, because nothing read the command and nobody can say it destroys a database.

**Out of scope:** `php artisan tinker`, because an interactive REPL takes its input later. As with every guard here, this covers Claude's own tool calls and is not an OS boundary — `/sandbox` is.

**The tab-stripping heredoc walked straight through until 2026-09-17.** `psql -d app <<-SQL` with a `DROP DATABASE` in the body exited 0, while the identical `<<SQL` form exited 1. `<<-` hides the delimiter behind a dash that `extract_heredocs` never stored, because it keys bodies by the bare name, and the whole-command fallback did not rescue it either: `<<` *is* in the token list, so `saw_heredoc` was already true and the sweep was skipped. The dash binds two ways, and running them confirmed both are valid bash, so the lookup strips a leading dash **and** steps over a bare one:

```
psql <<-SQL      tokenises as ['<<', '-SQL']
psql <<- SQL     tokenises as ['<<', '-',  'SQL']
```

The second is the one a single `lstrip("-")` still misses. Each half of the fix has its own fixture, and dropping either one alone reddens the suite. The gap was found while building [the provisioning guard](#provisioning-guard), which shares the tokeniser and had inherited it.

**It pays almost nothing on an ordinary Bash call.** A finding can only come from a stage whose program is one the checker knows, or from SQL handed to one of its clients. So the guard first asks, in bash, whether the command names any of them: the Artisan reset verbs, `dropdb`, `dropuser`, `mysqladmin`, the SQL clients, `docker`, `podman`, `sail`, `lando`, `ddev`, or `wp-env`. A command that names none of them exits before Python starts. The match folds case and ignores quotes and backslashes, because the checker's tokeniser joins `drop''db` into `dropdb`. A command past the 200,000-byte read ceiling always goes to the checker, which refuses it. The suite reads the names back out of the checker's own constants, so a program added there and forgotten here turns a test red.

Tests: `hooks/test-destructive-database-guard.sh` (221 cases). The suite is weighted towards the *allow* side on purpose. A guard that blocks every destructive command and also blocks `grep -rn "drop table"` has made ordinary work impossible, which is a worse failure than the one it prevents.

### Vault git guard

On 2026-09-04 an agent deleted a memory note by running `git -C ~/Documents/Claude/Memory rm identity/profile.md`. That is a Bash call, so it staged a deletion in the vault's git index and stopped there. The vault's git does not belong to the agent: the memory MCP server owns it and runs a **deferred-commit queue** over it. On the server's next write it swept the staged deletion into commit `014f51b1`, whose message reads `write: insights/credential-guard-blocks-prose-about-dotenv.md`. A 71-line profile deletion is now filed in vault history under a message describing an unrelated note being written.

The correct tool was available the whole time. The MCP `delete` tool produces its own accurately-named commit. It went unused because nothing said the vault's git was off limits — `references/vault-conventions.md` ran to 76 lines and did not contain the word "git" once. `hooks/vault-git-guard.sh` is the enforcing half of that gap; the [git section now in `vault-conventions.md`](references/vault-conventions.md) is the explaining half, and it cites the incident commit by hash because a rule with no incident attached gets relaxed later.

It returns `permissionDecision: "deny"`. The human reads ``🛑 Blocked: `git rm` in the memory vault. Use the memory MCP instead.``; the vault's absolute path, the sweep story, and the list of MCP tools go to the model in `additionalContext` (see [How a gate speaks](#how-a-gate-speaks)).

**The verdict turns on which repository, not on which verb.** `Bash(git rm:*)` would block `git rm` in every repository on the machine, which is ordinary work, and would *still* miss the incident — `git -C <path> rm` puts the verb in the fourth slot. So the command is tokenised and the target directory resolved. Four shapes, all covered:

```
git -C <vault-or-subdir> <verb>        the incident's own shape
cd <vault-or-subdir> && git <verb>     the verb is not at the front
git <verb>                             with the payload cwd inside the vault
git --git-dir=<vault>/.git <verb>      also --work-tree
```

Every path is expanded for `~`, joined against the payload's `cwd` when relative, and passed through `realpath` before comparison. Comparison respects the separator, so a sibling named `Memory-old` beside `Memory` is a different repository and stays untouched. An absolute `cd` settles the target even when the payload carries no `cwd` at all.

**It is a block list, and that choice has a stated cost.** Only the enumerated write verbs block:

| Class | Blocked |
|---|---|
| Index and tree | `add`, `rm`, `mv`, `reset`, `checkout`, `switch`, `restore`, `clean`, `apply`, `am` |
| History | `commit`, `merge`, `rebase`, `cherry-pick`, `revert`, `init` |
| Remote | `push`, `pull`, `fetch` |
| Object store and refs | `update-ref`, `gc`, `repack`, `prune`, `worktree`, `notes`, `symbolic-ref` |
| Conditional | `stash` (except `list`/`show`), `tag` (except the listing forms), `branch` (only `-d`/`-D`/`--delete`) |

Everything unlisted passes. git ships over 150 subcommands and the read-only ones vastly outnumber the writes, so an allow list would have to be near-complete on day one or it would break `git grep`, `git shortlog`, `git for-each-ref`, `git ls-tree`, and `git count-objects` — several of which were used to investigate this very incident. **The stated limit, as a known limit and not an oversight:** a mutating subcommand git adds after this ships walks through until somebody adds it to `WRITE_VERBS`.

**Read-only git in the vault is the priority requirement.** `status`, `log`, `show`, `diff`, `ls-files`, `rev-parse`, `rev-list`, `cat-file`, `blame`, `describe`, `remote -v`, and `config --get` each have a named test asserting they still run. Three listed verbs have a read form that the arguments decide rather than the verb: bare `git tag` lists, `git stash list`/`show` report, and bare `git branch` lists.

**It stops at every remote and container boundary, by not unwrapping at all.** `ssh box "git -C /vault commit"` is allowed and must be — that machine has its own filesystem, so a local path of the same name is the wrong path. The mechanism is absence rather than a rule: a stage whose first word is not `git` is never judged, so `ssh`, `docker exec`, and `kubectl exec` are already out of reach. An earlier draft carried an explicit boundary list; it was deleted once a mutation test proved no input could reach it, because an unreachable branch in a guard is untested code pretending to be a safeguard. The one wrapper deliberately descended into is a shell `-c` payload, since `bash -c "cd <vault> && git rm x"` arrives as a single quoted token.

**This is the one place it disagrees with the database guard,** which unwraps `ssh`, `docker`, and `kubectl` to follow a command *through* them. A database on another host is still a database being destroyed; another machine's vault is not this vault. That disagreement is why `unwrap()` is not in the shared parser and each guard keeps its own.

**The server's own commits are structurally out of scope.** markdown-vault-mcp commits from a separate process as `markdown-vault-mcp <noreply@markdown-vault-mcp>`, where no `PreToolUse` hook and no permission rule can ever see it. Nothing is needed there, and nothing was built.

**It fails open,** for the reason the database guard gives rather than the one `credential-guard.sh` gives: there is no adversary, only a confidently wrong agent. A command that writes to the vault has to be valid shell to run, so it tokenises. A command whose target cannot be resolved — no `cwd` in the payload and no explicit path — also passes, because guessing at the target is how this guard would block somebody else's repository.

**Past the read ceiling it refuses,** on the same split the database guard makes: unparseable text was read and not understood, truncated text was never read, and the vault write can be in the part nobody saw. **Two early returns sit either side of that check, and both positions are the verdict.** The vault argument is read first, so a machine with no vault configured keeps its silence: there is nothing to fail closed for. The emptiness test comes after, because 200,001 characters of spaces or tabs `.strip()` to `""` — put it first and whitespace padding walks a real vault write straight through, which is how the first cut of this fix failed review. The human line reads `🛑 Blocked: a command too long for the vault-git guard to read.`

Tests: `hooks/test-vault-git-guard.sh` (200 cases), weighted towards the allow side on two axes. A guard that stops `git status` in the vault has broken the commands the incident was investigated with, and a guard that stops `git commit` in an unrelated repository has broken every repository on the machine. Both are worse than the failure it prevents, so every write verb it blocks is tested a second time in an unrelated repository, allowed.

### Provisioning guard

The worktrees and the development databases on this machine are set up by hand. A worktree comes from a Herdr keybinding or a typed `git worktree add`, and a database comes from a typed `createdb`. Those are the environment an agent is meant to work **inside**. Agents kept provisioning their own instead: a stray `git worktree add`, a `createdb`, a sub-agent dispatched with worktree isolation. Each one leaves an orphan tree or an orphan database to find and clean up later, and it puts the agent's work somewhere nobody was looking.

`hooks/provisioning-guard.sh` is the enforcing layer. It returns `permissionDecision: "deny"`, so no prompt appears and no allow rule reaches it. Each of the four surfaces names its own action in the human line — `creating a git worktree`, `deleting a git worktree`, `deleting this session's worktree`, `dispatching a sub-agent into its own worktree`, `creating a PostgreSQL database` — and the advice goes to the model in `additionalContext` (see [How a gate speaks](#how-a-gate-speaks)).

**Four surfaces, because between them they are every path an agent has.** Two of them are not shell commands at all, which is the half no permission rule could ever have reached:

| Surface | Blocked |
|---|---|
| `Bash` | the three rule classes in the next table |
| `Agent` | a dispatch carrying `isolation: "worktree"`, which makes the harness provision a worktree for the sub-agent |
| `EnterWorktree` | every call. The tool creates a worktree and moves the session into it |
| `ExitWorktree` | only `action: "remove"`, which deletes the session's worktree and its branch |

The `Bash` surface, by rule class:

| Class | Blocked |
|---|---|
| Worktree | `git worktree add`, `git worktree remove`, `git worktree prune` |
| Shell | `createdb`, `createuser`, `mysqladmin ... create` |
| Raw SQL | `CREATE DATABASE\|SCHEMA` inside a SQL client's payload |

**Worktree deletion is in scope, and it is the half with the blast radius.** `git worktree remove` and `git worktree prune` destroy trees somebody set up deliberately. Creating a tree leaves litter, deleting one destroys work. Database deletion is **not** here: [the destructive database guard](#destructive-database-guard) already owns that half, and nothing in this guard touches its rules.

**`ExitWorktree` is the one surface beyond the four that were specified.** It earns its place. With `EnterWorktree` blocked, the only worktree a session can be sitting in is one a human made, so `remove` can only ever destroy a hand-provisioned tree. `action` is a required enum on that tool with no default, so matching `remove` exactly leaves no silent hole, and `keep` stays available so the guard never traps an agent inside a tree it cannot leave.

**Verb position, not substring**, on the same reasoning [the destructive database guard](#destructive-database-guard) gives. A substring match for `createdb` blocks `grep -rn createdb .`, and one for `worktree add` blocks every search for the text of this very section. So `hooks/lib/provisioning-check.py` tokenises with the shared `hooks/lib/shell_parse.py`, splits into statements and pipeline stages, unwraps the wrappers, and only then matches. A worktree verb has to sit in git's subcommand slot, and SQL has to sit in a SQL client's payload. `grep` is neither git nor a SQL client, so code search is structurally unreachable by both rule classes.

**A prefix rule cannot see any of these**, which is the argument for a hook rather than a deny rule alone:

```
cd /repo && git worktree add x          the verb is not at the front
git -C /repo worktree add x             the verb is in the fourth slot
bash -c "git worktree add x"            one quoted token
ssh box "createdb app"                  one quoted token, another machine
sail createdb app                       behind a shim
docker compose exec db createdb app     through a container
mysqladmin -u root create app           the verb sits after the flags
psql -c "CREATE DATABASE app"           inside a client payload
echo "CREATE DATABASE app" | psql       upstream of the client
psql -d app <<'SQL' ... SQL             a heredoc body
```

**It follows a command through `ssh`,** agreeing with the database guard and not with [the vault git guard](#vault-git-guard). A worktree or a database created on another host is still one nobody asked for. That guard has to stop at `ssh` because its verdict depends on a local path, and this one's never does, so a remote command cannot produce the false block it protects against.

**Two exclusions, decided deliberately. Neither is to be widened.**

| Exclusion | Why |
|---|---|
| SQLite file creation | A Laravel migration creates `database/database.sqlite` implicitly. Blocking that breaks ordinary test runs while protecting nothing: a stray `.sqlite` file is deleted with `rm`, not hunted down. The exclusion is structural rather than a special case, because `sqlite3` is absent from the SQL client list, and no rule matches `CREATE TABLE` at all. |
| Container and stack startup | `docker compose up`, `sail up`, `ddev start`, and `lando start` provision a database volume on first run. They are also exactly how an agent starts the environment it is meant to work inside, so blocking them defeats the purpose of the whole guard. Only a creation verb reached *through* a container blocks, which is provisioning rather than startup. |

**Read-only inspection is the priority requirement.** `git worktree list`, `lock`, `unlock`, `move`, and `repair` each have a named test asserting they still run. So do `psql -c "SELECT ..."`, `mysqladmin status`, `mysqladmin ping`, `pg_dump`, and every `grep` or `rg` whose text merely contains a creation verb. `CREATE TABLE`, `CREATE INDEX`, and `CREATE EXTENSION` pass, because a table inside a database somebody already made is not provisioning.

**It is a block list, and the limit is stated rather than hidden.** A creation path nobody listed walks through. `pg_restore --create` is one, and a `CREATE DATABASE` hidden in a file handed to `psql -f` is another. Reading a referenced `.sql` file is what the destructive guard does for `DROP`, and it is deliberately not repeated here: a missed `CREATE` costs one `dropdb` to undo, while the missed `DROP` that guard exists for cost several hours of imported data.

**The block is absolute, and that is not a stylistic match with its siblings.** A root-cause investigation on 2026-09-11 measured that a `PreToolUse` hook returning `permissionDecision: "ask"` is silently auto-approved by the auto-mode classifier, because a hook cannot set `classifierApprovable`. Only a hard block is real. When a worktree or a database is genuinely wanted, the human runs the command with the `!` prefix, and every human line the guard prints says so.

**No deny rules ship in `rails.json` for this, deliberately.** `Bash(createdb:*)` and `Bash(git worktree add:*)` would both satisfy that file's own test, since the first words decide the outcome. They are still absent, because `scripts/permissions.sh` merges additively and never removes, so a rule added there is permanent in a user's `settings.json` and cannot be taken back out by editing this repo. The database *denies* earn that permanence by guarding against data loss. An orphan worktree costs one command to remove, the hook already blocks it absolutely, and leaving the rule out stays reversible in a way that adding it does not.

**It fails open,** on the reasoning the sibling guards give rather than the one `credential-guard.sh` gives. There is no adversary here, only a confidently wrong agent. A command that actually creates a worktree must be valid shell to run, so it tokenises. A malformed payload, a missing `jq`, a missing `python3`, or an absent checker all exit 0.

**Past the read ceiling it refuses,** on the same split the database guard makes: unparseable text was read and not understood, truncated text was never read, and the `git worktree add` can be in the part nobody saw. The human line reads `🛑 Blocked: a command too long for the provisioning guard to read.` — its own subject, not a sibling's, so the reader is not sent hunting for a database when a worktree was at stake.

**It pays almost nothing on an ordinary Bash call.** Every rule needs one of two substrings in the command text, `worktree` or `create`, so a command holding neither exits before Python starts. The case-insensitive match is a bash `case` with bracket classes rather than `tr` or `grep -i`, because macOS ships bash 3.2 with no `${var,,}` and either alternative costs the fork the check exists to avoid.

**A heredoc body belongs to the stage that redirects it, and to no other.** The database guard carries a fallback that sweeps every heredoc body in the command whenever a SQL client stands anywhere in it, for a redirect "that did not survive tokenising". This guard does not, because the fallback was measured rather than assumed. Across all eight spellings — `<<SQL`, `<<'SQL'`, `<<"SQL"`, `<< SQL` and each with `-` — plus after a `cd`, before a pipe, and behind `sudo`, the redirect token survives every time, so the sweep caught nothing it could not reach directly. It did produce a false block: writing a `setup.sql` heredoc in a command that also runs `psql` matched the unrelated body. A guard that fails open cannot carry a branch whose only measured effect is a false block on ordinary work.

**Measuring that is what turned up the `<<-` gap**, in this checker and in [the database guard](#destructive-database-guard), which had it first and where it let a `DROP DATABASE` past. Both are fixed in this change, the same way.

Tests: `hooks/test-provisioning-guard.sh` (210 cases), weighted towards the allow side on three axes. A guard that stops `git worktree list` has broken the only way to see the trees it protects. A guard that stops `grep -rn createdb` gets turned off, which is worse than not having one. And a guard that stops `docker compose up` or a migration writing `database.sqlite` has broken the environment an agent is supposed to work inside, which is the whole thing this guard exists to keep it in.

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
        — PreCompact and manual ONLY; mode=final stops at the marker

Next session start
    ↓
hooks/session-warmup.sh
    └── Drain: spawn a writer for the N oldest markers (default 3)
            ↓
        summary-writer agent
            ├── Read the rolling log
            ├── Write narrative .summary.md to vault
            ├── Promote decisions (if bar is met)
            └── Delete the marker
```

One rolling log file per session. Checkpoint and final segments are appended to the same file. Later writer runs overwrite earlier summaries with the most complete picture.

#### Why SessionEnd does not spawn

A child process started as the parent CLI exits is killed during teardown. `nohup` immunises against `SIGHUP` only — not a process-group `SIGTERM`, and not the OS reaping the job when the parent goes away. Between 2026-07-31 and 2026-08-14 this stranded 968 markers on one install: every one of them `event: SessionEnd`, and not a single `PreCompact`. That asymmetry is what identified the bug, since PreCompact fires mid-session with the parent alive and its writers always completed.

So `mode=final` writes the marker and stops. The next session start drains it, where the parent is alive by definition. Work triggered at process death cannot be made to outlive the process by backgrounding it harder.

The drain is bounded (`WORKBENCH_DRAIN_BATCH`, default 3) and rate-limited (`WORKBENCH_DRAIN_COOLDOWN_MIN`, default 5) so a large backlog clears over several sessions instead of forking a swarm at one session start. It takes the **oldest** markers first: the retention sweep refuses to delete any raw log that still has a marker, so draining newest-first would pin the oldest logs on disk indefinitely. Writer stdout and stderr go to `{memory_cache}/summary-dispatch-errors.log` — the original dispatch discarded both to `/dev/null`, which is why a two-week outage went unnoticed.

#### A marker has two sources, and either one is enough

Each marker names both the vault log (`log_path`) and the original Claude Code transcript (`transcript_path`). They are the same session with different lifetimes: the log is a 7-day cache the retention sweep prunes, the transcript lives about 30 days. So a missing log means **the cache expired**, never that the session is lost — the writer falls back to the transcript and stamps `source: transcript` in the summary's frontmatter (`agents/summary-writer.md`, step 2).

The drain therefore accepts a marker when **either** source is readable, and refuses only when both are gone. Gating on the log alone made the drain stricter than the agent it gates, so that documented fallback was unreachable: measured on 2026-09-18, 778 of 779 markers were refused, and 503 of them still had a readable transcript on disk. Transcript retention is the real deadline, and those 503 were aging out against it untouched.

A marker with both sources gone is logged as `undrainable` and left alone. **Purging one is a deliberate human call, not the drain's** — it is the only surviving record that the session went unsummarised.

### Pre-shed capture

The logging pipeline above always produces a narrative summary, and that summary is always a **reconstruction**. The summary-writer reads a raw JSONL transcript with no lived context, and its own definition forbids it from padding a thin reconstruction into a confident one. The curated output — a decision with the alternatives it rejected, a root cause, a correction to how the agent works — exists only inside the session that formed it, and until now nothing asked that session for it unless the human did.

`hooks/memory-capture-stop.sh` asks. When it fires, it exits 2 with the capture instruction on stderr, and Claude Code wakes the model with that instruction as a new turn, after the reply the user has already seen. The instruction explicitly permits writing nothing: a forced turn with no escape manufactures a memory to justify itself, which is worse than no memory at all.

The hook is registered with `asyncRewake`, and that is what keeps the checkpoint to one line for the user. A synchronous `decision: block` would show the user the whole reason as "Stop hook feedback", because a synchronous `Stop` hook has no field that only the model reads. With `asyncRewake`, the model gets `rewakeMessage` plus stderr, and the user sees only `rewakeSummary`: "💾 Memory capture checkpoint (automatic, not from the user)." These three fields are marked internal in the CLI's hook schema and are not documented. They were read from the 2.1.284 CLI and not measured live, so check the checkpoint still fires after a Claude Code upgrade.

The instruction itself is the header line plus one line. That line points at the warmup's Memory routing capture rule for the detail. On its own, it still gives the model permission to write nothing, a one-line reply, and "Do not ask first".

**It is the backstop behind the warmup's capture rule, not a periodic reminder**, and that is what sets its timing. A per-turn `UserPromptSubmit` capture nudge used to sit in front of it. That nudge was retired on 2026-09-27: it fired on sub-agent hand-backs and task notifications as well as typed prompts, and restated warmup text at a measured ~180k tokens in three days. A backstop has to fire at least once per session to be one at all, so the **first** fire matters far more than the repeat. It lands on turn 5 (`WORKBENCH_CAPTURE_STOP_FIRST`) and then settles onto a sparse 40 (`WORKBENCH_CAPTURE_STOP_INTERVAL`), which exists only to catch findings that crystallize late in a long session. Measured over 467 transcripts of this project:

| First fire | Sessions reached |
|---|---|
| turn 5 | 411 of 467 (88%) |
| turn 9 | 55% |
| turn 21 | 76 of 467 (16%) |

A flat interval of 20 would therefore have captured nothing in 84% of sessions. Both numbers are estimates from one project's history, so both are independently overridable.

**It is not tuned to beat compaction.** Exactly one of those 467 sessions ever compacted. The real context-loss events here are quit and `/clear`, and neither gives any warning a hook can read — the `Stop` payload carries no context-pressure field, so "fire when the shed is near" is unavailable at any price.

Six things switch it off, and each closes a real failure:

| Condition | Why |
|---|---|
| `stop_hook_active` is true | That flag means our own wake is already being served. Firing inside it is an infinite loop. Anything but a definite `false` counts as active. |
| It is the first turn end after a fire | That turn is the one our own wake caused. This guard holds at any interval, even if the CLI does not set `stop_hook_active` on the wake. |
| `agent_id` is present | A sub-agent's findings belong to the session that dispatched it, which gets its own turn ends. |
| `WORKBENCH_SUMMARY_WRITER=1` | The background writer's whole job is one summary from a log it was handed. |
| `WORKBENCH_DEV_TEAM_PIPELINE=1` | An unattended dev-team agent. In `claude -p` a fired checkpoint makes the capture reply the run's final output, which is what the dispatcher logs as the agent's report. |
| The session is a scheduled tick | A Stop payload carries no prompt, so the hook reads the transcript's first user record and looks for the `<scheduled-task …>` wrapper (`hooks/lib/scheduled-origin.sh`, shared with `memory-scan-recall.sh`). It reads it only on a turn that would fire. An unattended tick writing memories about its own routing is the noise the vault does not want. |

**Why `Stop`, and not `PreCompact`.** Only two events can make a live model act: `UserPromptSubmit` (via `additionalContext` on the next human turn) and `Stop` (via `decision: block`, or an `asyncRewake` wake). `PreCompact` is not one of them — measured against the shipped CLI (2.1.277), its executor reads each hook's stdout and its blocked/succeeded state and nothing else, and no model turn is open there to run a tool in. A PreCompact hook can block compaction or say nothing, and neither writes a memory. Stop is the right event anyway: compaction happens between turns, so the last Stop before one is the last moment the session still holds everything it is about to shed.

**A hard quit is not covered, and cannot be.** `SessionEnd` runs after the model can no longer act — the same reason it cannot dispatch a summary-writer. Those sessions still get the background summary; they just do not get the curated pass.

### What the warmup injects

The warmup injects the memory-routing and destructive-command rules on **every** source:

| Source | When | What happens |
|--------|------|--------------|
| `startup` | Fresh session | Full warmup: retention cleanup + rules + pending-summary drain + notices refresh |
| `resume` | Reconnecting | Rules + pending-summary drain + notices refresh |
| `clear` | After `/clear` | Rules + notices refresh |
| `compact` | After compression | Rules only (via PostCompact hook) |

It injects no persona file and no behavioural rule. The persona is the output style, which is system-prompt tier and survives compaction on its own.

### Housekeeping notices — pulled, not pushed

Warmup output has to be **byte-stable**. Anthropic prompt caching matches on an
exact request prefix, so a single byte that drifts between otherwise identical
sessions invalidates the cache for the whole prompt downstream of it — the rules,
plugin contributions, skill bodies, tool definitions. An unattended scheduled
task that fires every 20 minutes pays that penalty on every tick.

So no volatile state is injected into the warmup payload. Pending session
summaries, misrouted project summaries, recall-hook liveness, new
Chat-installable skills, a stale output style, and a retired `system-overrides.md` still on disk are all written to:

```
~/.claude-workbench/warmup-notices.md
```

rewritten from scratch at every session start (so a stale notice can never look
current), and surfaced by a single pointer line whose bytes never change.

That pointer instructs an **unconditional** read at session start. It replaced a
push banner that said "run `/workbench-core:process-pending-summaries`" outright,
and a pointer hedged as "read this if housekeeping seems relevant" would be
strictly weaker — judging relevance is precisely what requires reading the file.
Pull-not-push is a transport change, not a softer instruction.

There is deliberately **no** detection of which kind of session this is. No
signal for a scheduled or headless fire exists at `SessionStart` — the payload
carries only `source` (`startup`/`resume`/`clear`/`compact`/`fork`) plus
`agent_type` for `--agent` sub-agent dispatches, and no environment variable
distinguishes a cron fire from an interactive run. Making the payload
unconditionally stable sidesteps the need for one, and benefits every session
type at once.

### MCP output capping

Claude Code caps MCP tool output itself. A response past `MAX_MCP_OUTPUT_TOKENS` is persisted to a file, and the model gets a pointer to it instead of the text. `/workbench-core:setup` sets that variable to `15000` in the `env` block of `~/.claude/settings.json`, and leaves any value already there alone. The harness default is 25,000 tokens.

**This replaced a hook.** `hooks/mcp-output-cap.sh` used to truncate MCP responses in `PostToolUse`. The harness already persisted anything past its own limit before a `PostToolUse` hook ever saw the response, so the hook only governed the band between its 60 KB cap and that limit, roughly 60 to 100 KB. It also had to carry an exemption list, so it would not cut a memory note the server had chosen to return whole. Lowering the harness limit covers the same band with no hook, no copy on disk, and no exemption list. It was removed on 2026-09-27.

The setting is a **backstop, not a substitute** for servers capping their own output: it can only persist whatever was returned, where a server knows to return its 10 best results with snippets. See `docs/mcp-output-capping.md` for the per-server standard.

### Question delivery is prose, not a hook

The output style carries the question-delivery rules: a blocking question goes through `AskUserQuestion`, or into a `## ❓ Open questions` block placed last. `docs/rule-history.md` records why each of those rules was added.

**It is prose rather than a hook, deliberately.** Detecting an unanswered question in free text is a semantic judgement, and every enforcement gate in this plugin matches on something mechanical instead — a tool name, a command prefix, a file path, a slot header, a literal character. The one time semantic heuristics were built and measured here, for the [agent dispatch gate](#agent-dispatch-gate), the three variants traded 83% precision at 26% recall against 34% precision at 84% recall, and the wrong answers were not tunable away. A classifier on question delivery fails the same way in both directions: a false positive blocks a finished reply, and a false negative teaches the agent the rule is optional. The written rule is the enforcement that is actually available, and `hooks/test-rule-source.sh` guards that it is written once.

### Permission safety rails

The output style's rules are prose in the model's context. Permission rails are enforcement in the harness. They solve the same problem at different layers, and the second one holds when the first is gone.

**The problem:** From August 14, 2026, `auto` is the default permission mode on Pro, Max, and Team plans — a classifier reviews actions instead of prompting you. Anthropic's own documentation is blunt that this *does not guarantee safety*. Worse for an agent with a long-running session: a boundary you state in conversation ("don't force-push") is re-read from the transcript on every classifier check, so **context compaction can erase it**.

**The solution:** `assets/permissions/rails.json` ships a curated `deny` and `ask` list, merged into `~/.claude/settings.json` by `scripts/permissions.sh` during `/workbench-core:setup`. Permission rules are evaluated **deny → ask → allow, before the classifier**, in every mode including `bypassPermissions`. Nothing compacts them away.

- **deny** — hard wall. No prompt, no override, no classifier opinion. Reserved for the irreversible: `sudo`, disk formatting and partitioning, `shred`, `btrfs`, `git push --force`, history rewriting, bulk keychain dumps.
- **ask** — always prompts, even in `auto`, even when a narrower allow rule matches, and **even when a `PreToolUse` hook returned `"allow"`**. Used for destructive-but-legitimate work that acts on something *published or system-wide*, where "inside the project" is not a meaningful question: `gh pr merge`, `npm publish`, keychain and libsecret writes, `launchctl`/`systemctl`/`crontab` persistence, AUR helpers. The five entries that acted on a path or a repository have **left this list** — see below.
- **allow** — one entry, and deliberately one: `mcp__plugin_workbench-core_memory__*`. Never a shell *pattern*. No `Bash(...)` entry ships; the one that did, for a scratchpad-delete helper, was retired with that helper.
- **autoMode.allow** — a different layer: prose exceptions to the classifier's built-in *soft-deny* rules, read as natural language rather than tool patterns.

The merge is **additive**: entries are added when absent, and existing rules keep their position. `--dry-run` previews; `--list` prints every rule with its rationale.

**It also writes the scratchpad directories.** `permissions.additionalDirectories` gets the two scratchpad trees, computed for the account running setup: the harness's session tree, `claude-<uid>` under the physical `/tmp`, and `~/Developer/scratchpad`. A bare `/tmp` or `/private/tmp` entry is removed, the one removal this merge makes: it advertised all of `/tmp` as a working directory, and agents made scratch there by hand as a result. The session-tree entry is broader than the guard's scope: the guard approves only each session's own `…/claude-<uid>/<project>/<session>/scratchpad`, so a loose file elsewhere in the tree is stranded. Agents are told to make scratch nowhere under `/tmp` outside their session scratchpad. Other directories you listed keep their place, and a second run changes nothing.

**`permissions.allow` used to be untouched, and now is not.** For most of this file's life the rails shipped only `deny`, `ask`, and `autoMode.allow`, and both `permissions.sh` and this section said `permissions.allow` was never referenced. That promise has been replaced by a narrower and still-true one: **the entries you put in `permissions.allow` are never removed, never reordered, and never rewritten.** The shipped entries are appended after them, and only when they are missing, by the same additive `$new - $cur` the other lists use. `hooks/test-permissions.sh` pins both halves — that the shipped entry lands, and that a user's four-entry allow list comes back with all four in their original positions.

**Why an `autoMode.allow` entry ships.** The classifier's built-in soft-deny list includes *auto-mode bypass*, and the dev-team Dispatch task launches agents with `nohup claude -p --agent ... --dangerously-skip-permissions` — which reads exactly like Claude removing its own oversight, so the classifier blocks it. A soft deny clears on explicit user intent, but a scheduled task has no user message to clear it. `autoMode.allow` is the documented mechanism for that exception; `permissions.allow` is not *for that entry*, because auto mode deliberately suspends broad shell allow rules that grant arbitrary code execution, and dispatch is a shell command. That is a statement about shell *patterns*, not about the allow list as a whole — see below for the two entries that do ship there. (`workbench-dev-team` does allow its own `dispatch-agent.sh` wrapper by its fixed path, which is the same narrow shape; the soft-deny exception is still needed, because the wrapper performs the same spawn.) The literal `"$defaults"` must stay in the array — omitting it discards every built-in soft-deny rule — so `permissions.sh` prepends it whenever missing.

**Why one MCP server sits in `permissions.allow`.** `mcp__plugin_workbench-core_memory__*` is there because the vault is the canonical memory store, and a classifier hold on a memory write does not defer the memory — it *loses* it: the write was going to happen inside a turn that has already moved on, and nothing retries it, so the note is simply never recorded. `autoMode.allow` is the wrong lever here because the call is not a shell command tripping a soft-deny rule. An MCP server entry grants markdown reads and writes inside a configured vault, which is not what auto mode suspends when it suspends broad shell allow rules.

**Why the five scope-able `ask` entries are enforced by a hook as well.** `Bash(rm -rf:*)`, `Bash(git clean -fd:*)`, `Bash(git reset --hard:*)`, `Bash(git stash clear:*)` and `Bash(git stash drop:*)` are the only `ask` entries that act on a **filesystem path or on a repository**, which is what makes "inside the project" a meaningful question about them. The other seventeen act on published artifacts, system state, or the macOS Keychain, where the question is undefined; they stay rules for good. Those five encode a *verb-based* policy — they prompt wherever the verb acts — so an ordinary in-project delete costs the user a prompt. The policy wanted is *scope-based*: work inside the project and the scratch roots is permitted, and reaching outside them is the user's call.

**That exception cannot be layered on top of an ask entry, which is why the entries have to leave rather than be narrowed.** Rules are evaluated deny → ask → allow with **first match winning**, specificity does not reorder them, and Bash rules support no negation operator, so `Bash(rm -rf /tmp/:*)` in `allow` is dead text the ask rule beats every time. Nor does a hook rescue it: Anthropic's permissions documentation states that hook decisions do not bypass permission rules, and that a matching ask rule still prompts **even when a `PreToolUse` hook returned `"allow"`** — the sandboxing documentation says the same for sandboxed commands. A content-scoped ask entry is therefore overridden by nothing.

**`hooks/destructive-scope-guard.sh` is what answers in their place.** It permits a destructive command when **every path it acts on** resolves inside the project or a scratch root, and denies it otherwise. Four roots: the project from `CLAUDE_PROJECT_DIR`, the login home's `Developer/scratchpad`, this session's scratchpad matched by session id, and — on Darwin — this account's per-user temporary directory, which is where `mktemp -d` writes and so where an agent's sandbox teardown happens. Off Darwin that fourth root is not approved at all: `mktemp -d` falls back to `/tmp` there and every account on the machine shares it. One folder family in `/tmp` is approved as well, and it is not a root: a leftover agent-scratch folder directly in `/tmp`, named `claude-*scratch*` (such as `claude-scratch-<id>` or `claude-summary-scratch`), that is a real directory owned by this account. Agents once made those by hand, and the guard refused to let them clean up. A delete may remove the folder itself as well as anything in it. The name is read from the directory listing, never from the spelling the caller typed: on case-insensitive APFS `/tmp/Claude-503` is the live `claude-<uid>` session tree, so a spelling test would judge a name no file carries. No other `/tmp` name qualifies, and neither does anything reached through a symlink out of `/tmp`. One file shape is approved too: a single session-summary marker, a `*.json` name directly in `<cache>/pending-summaries/` that is absent or a regular file this account owns. The summary-writer and `log-now` each end by deleting one, and before this permit every one of those deletes was denied. The folder is resolved the way `hooks/session-log.sh` resolves it when it writes the marker, from the hook's own `WORKBENCH_MEMORY_CACHE` or `config.json`, never from the command. The folder and the cache root above it must be real directories rather than links. A delete must land **strictly beneath** a root, because each root holds live state that is not the session's to destroy; a git verb may act **on** one, because it destroys uncommitted state inside a worktree without removing it. It also reaches what no rule can: `rm -r` without `-f`, plain `rm`, and `rmdir` match no entry in `rails.json` at all, and a verb behind `cd x &&`, `sudo`, or a pipeline sits where a prefix rule cannot read it.

**No root is decided by an environment variable the caller can set.** A root the caller chooses is not a root: point `$HOME` at a directory holding a `Developer/scratchpad` symlink and every other defence still passes while the wrong tree is deleted, which was reproduced against the guard's predecessor. So the login home comes from the password database through `getpwuid(3)`, which no variable and no `PATH` can redirect; `$TMPDIR` is the same hole under a new name and gets the same answer, with the temporary root read from `getconf DARWIN_USER_TEMP_DIR`, which answers from the account rather than the environment; and `CLAUDE_PROJECT_DIR` is trustworthy for the opposite reason — Claude Code sets it for hook commands and it is absent from the Bash tool environment entirely, so `CLAUDE_PROJECT_DIR=/ rm -rf x` sets it for the command being judged and never for the judge. Every path is resolved **physically** before comparison, because a string prefix accepts `<root>/link/x` where `link` points at a repository, and `<root>/../../etc`.

**It fails CLOSED, and that inverts the convention every sibling guard here follows** — with one shape now shared by all five, the read ceiling, which every guard refuses since 2026-09-21. `vault-git-guard.sh`, `destructive-database-guard.sh` and `provisioning-guard.sh` fail open on text they read and could not parse (`credential-guard.sh` keeps its block there, since its second stage may only narrow one), and they are right to: an unparseable command fell through to `Bash(rm -rf:*)` and the user read a prompt, so the cost of a miss was one prompt. Once the five leave the ask list there is nothing underneath, and a fail-open verdict reaches the auto-mode classifier alone. So every shape the checker cannot read — a `$variable`, a glob, command substitution, `bash -c`, `ssh`, `xargs`, `find -delete`, a loop body, an unbalanced quote, a heredoc fed to a shell, a wrapper's own option sitting in the verb slot, a command longer than the read ceiling, and text that only tokenises through a lossy retry — is a **deny** rather than a pass, and `hooks/lib/destructive-scope-check.py` names each of them in its own docstring.

**The guard's real perimeter is its tokeniser, not its verb table**, and that distinction is where the first review of it found five bypasses at once. A shape the checker *recognises* and refuses is a documented limit. A shape that never reaches its dispatch loop produces silence, which looks like nothing happening rather than like a defect — `(true); rm -rf <outside>` emitted no verdict at all, because `shlex` merged `)` and `;` into one token that no separator set contained, and everything after it was absorbed as an argument to `true`. That is fixed in `hooks/lib/shell_parse.py`, the parser all four guards share, rather than worked around locally: the same merge was hiding `(true); dropdb production` from the database guard and `(true); createdb newthing` from the provisioning guard, both verified before and after. That file's header now carries the full audit, including the one gap left open there on purpose — `strip_noop` does not drop a wrapper's own options, so `env -i rm` leaves `-i` in the verb slot, and closing it inside the parser would need a hand-maintained flag table whose first missing entry is a silent bypass. The scope guard refuses an unreadable verb slot instead, which needs no table; the other three guards still have that gap, recorded in the audit. The denial is not a wall: of the three verdicts a hook can return only `deny` binds (a hook `"ask"` is silently auto-approved by the classifier, measured 2026-09-11), so the way through is the user running the command themselves with the `!` prefix, and every refusal says so. `hooks/test-destructive-scope-guard.sh` covers it, weighted at the failure that matters here — a **silent pass**, not the over-reach the fail-open suites guard against. `hooks/test-parser-differential.sh` covers what no single guard's suite can: it drives one corpus of commands through **every** guard's live hook and pins the verdict each reaches, so a change to the shared parser that moves a verdict in a guard the author was not thinking about shows up as a diff. That suite exists because a change making `token_lines()` strip heredocs ran that stripper twice for the three guards that already called it themselves — which silently blinded them to every command after an ordinary `cat <<EOF` — while 578 assertions across six suites stayed green. The defect lived in the seam between two layers, and each layer's own suite tests that layer.

**The fail-closed rule binds the verdict, not the deployment.** A command the guard reads and cannot resolve is denied. A guard that cannot *run* is a broken install rather than an undetermined command, and denying every Bash call because `jq` is missing takes the machine down instead of protecting it — so the payload-reading preconditions exit 0. Everything after the cheap prefilter does not: by then the command is known to name a destructive verb, so a missing `python3` or a missing checker is a destructive command nobody judged, and that denies.

**The instruction half, and why it ships on two channels.** A guard that denies what it cannot read only works well if agents write paths it can read, so `hooks/session-warmup.sh` carries the rule — *twice, because the two channels reach different readers.* A three-line instruction goes to the hook's SessionStart stdout. The managed block the same hook writes into `~/.claude/CLAUDE.md` carries a row naming the guard and a line naming the scratch roots, and leaves the shape rule to the guard's own deny text. Only the second reaches a *sub-agent*: a freshly spawned one starts with that file in its context and with the hook's stdout absent, which was measured by asking one to introspect before its first tool call — and a sub-agent is where a dev-team agent actually runs. Copying the rule into each agent definition instead was rejected: that misses `general-purpose`, `Explore`, `Plan`, and every agent added later, where one managed block reaches all of them at once. `hooks/test-session-warmup.sh` pins the two copies against each other on a string *derived* from one of them, and pins both against the guard's registration in `hooks.json` — retire the guard and the promise the machine makes every sub-agent at startup becomes a lie, which reddens.

**The five are gone from `rails.json`, and that is the whole point rather than a loose end.** Leaving them listed would not have been a safety net: the merge is one-way — `permissions.sh` only ever adds — so an entry kept here is an entry restored into `~/.claude/settings.json` at whatever moment somebody next runs setup, silently undoing a deliberate removal. An undo nobody schedules is a hazard, not a protection.

**Removing them here does not remove them from an existing `settings.json`.** Anyone who merged the rails before this change still has all five, where they keep prompting and keep overriding the guard's permit — a matching ask rule wins over a hook `"allow"`. Deleting them there is a manual edit, and `/workbench-core:setup` step 2c.4 detects the leftovers and says so. `hooks/test-permissions.sh` pins both halves of the new state: that none of the five reappears in `deny`, `ask`, or `allow`, **and** that the guard is still shipped and registered — because no rules and no guard is these verbs gated by nothing, and it would otherwise read as success.

**What this replaced.** `bin/scratch-rm.sh` was a command that deleted one path beneath a scratchpad root with no prompt, carried in `permissions.allow` by fixed path because the exception could not be written as a rule, and `hooks/scratch-delete-guard.sh` intercepted an `rm` under a scratch root and routed the agent to it. A hook `deny` binds absolutely, so leaving that guard registered would have blocked precisely the in-scratch deletes the new one permits — the two cannot coexist. The script, its allow entry, its test, both warmup instructions naming it, and every mention of it here were retired together; the reasoning about untrusted roots above is carried forward from that script's own header.

**The line an allow entry may not cross.** An entry names one plugin's MCP server, or one script at a fixed path under `~/.claude-workbench/bin/`. Neither grants a command *shape*, and that is the whole distinction: `Bash(rm -rf:*)`, or any `*` inside the command part of a Bash entry, grants arbitrary code execution, which is exactly what auto mode suspends and what `autoMode.allow` exists to handle instead. A fixed script path grants the logic in one file this plugin ships, installs, and covers with a test suite CI runs. `hooks/test-permissions.sh` asserts the shape rather than trusting that sentence — every entry is an `mcp__` pattern or a `~/.claude-workbench/bin/*.sh` path spelled exactly, no `Read(` pattern and no `rm` spelling may appear, no wildcard may sit inside a command part, any allowed script must exist in `bin/` **and** have a `hooks/test-<name>.sh` suite that runs it (CI's `hooks/test-*.sh` glob picks that suite up automatically) should such an entry ever return, and no rule may be denied and allowed at once, since deny wins and the allow would be dead text that reads like a grant. *Reviewed* is the one word no assertion holds: a human reads the file before it ships, and nothing here checks that.

**What the trailing `:*` is assumed to do.** Verified, and asserted: no wildcard sits inside the command part, so no entry grants a command shape. Assumed: that `:*` admits nothing but the named script's own arguments. Claude Code documents `deny` and `ask` rules as checked inside command substitution, and documents `allow` rules neither way — so an argument carrying `$(...)` is undocumented ground. A substitution holding `rm -rf` prompts regardless, because the ask rule matches it and ask is evaluated before allow, which leaves a non-`rm` payload as the residual. That residual is not introduced here: `workbench-dev-team` already ships allow entries of exactly this form for `approve-commit.sh` and `dispatch-agent.sh`.

**The constraint that shapes the ask list.** An `ask` rule always forces a prompt, and a `claude -p` run has nobody to prompt — so the call is *blocked*. `workbench-dev-team` dispatches Watson unattended via `nohup claude -p --agent`, and Watson pushes branches, commits, and opens PRs. `Bash(git push:*)`, `Bash(git commit:*)`, and `Bash(gh pr create:*)` are therefore deliberately absent from the ask list; adding them kills the pipeline silently. `hooks/test-permissions.sh` asserts their absence. The git-commit approval gate stays a `PreToolUse` hook because a hook can force a prompt *and* carry a pipeline exemption — an ask rule cannot.

**Why there is no `rm` rule of any kind.** `rm` is gated by `hooks/destructive-scope-guard.sh` and by nothing else. A deny on `rm -rf /` would match every absolute-path delete — `*` is always a wildcard, and a deny rule can't carry an allowlist exception, so no `/tmp` carve-out is expressible. An `ask` rule was what shipped for most of this file's life, and it prompted wherever the verb acted, which is the verb-based policy the guard replaced. Claude Code still gates the catastrophic case semantically underneath all of this: the classifier decides root and home removals in `auto`, including inside `$(...)` and `<(...)` substitution, and they still prompt under `bypassPermissions` as a circuit breaker.

**What the Linux rails cover, and what they deliberately don't.** The `sudo` deny does most of the work: every mutating `pacman`/`apt`/`dnf` operation needs root, so those managers are already walled and get no rule of their own — a blanket one would prompt on every harmless `-Q` query and buy nothing. The rails added for Linux close the paths that *don't* go through sudo: AUR helpers (`yay`, `paru`) run as your user and elevate internally, `systemctl --user` and `systemd-run --user` need no root, `udisksctl` mounts and powers off devices through polkit, and `secret-tool` is the libsecret keychain. Disk tools (`parted`, `fdisk`, `sfdisk`, `sgdisk`, `wipefs`, `blkdiscard`) are denied as defense in depth on the same footing as `dd` and `mkfs` — root-requiring, but the deny costs nothing and doesn't depend on the sudo rule staying put. `btrfs` is denied because `btrfs subvolume delete` destroys snapshots, which on a btrfs root are the undo rope for every other mistake — the same reasoning as the reflog rule. `shred` is denied rather than asked because, unlike `rm`, an agent has no routine reason to securely wipe a file.

Two matching behaviours worth knowing: `Bash(git push --force:*)` also blocks `--force-with-lease`, and `Bash(mkfs:*)` covers the per-filesystem variants (`mkfs.ext4`, `mkfs.btrfs`) by prefix.

**Why credential paths get a hook instead of a deny rule.** The rails used to ship `Read(~/.ssh/**)`, `Read(~/.aws/**)`, `Read(~/.gnupg/**)`, and `Read(**/.env)`. Both halves of what those rules promised turned out to be false. They were never *enforcement*: Anthropic's own documentation states that Read and Edit deny rules apply to the built-in file tools and to the file commands Claude Code recognises in Bash — `cat`, `head`, `tail`, `sed` — and "don't apply to arbitrary subprocesses that read or write files indirectly, like a Python or Node script that opens files itself." And they were expensive: `xce()` in the Claude Code binary is a plain boolean over the deny list, so the presence of *any* `Read()` rule makes the `deniedPathInsideDirectory` circuit breaker return `ask` for every `grep`/`rg`/`diff`/`git`/`cp`/`mv` carrying a relative path in a command that also contains `cd` — without ever consulting a rule. That breaker is registered `bypassImmune` and is not classifier-routed, so no allow rule and no permission mode overrides it, and narrowing the rules does nothing. Only removing all four disarms it.

`hooks/credential-guard.sh` replaces them: a `PreToolUse` hook on `Bash|Read|Edit|Write|NotebookEdit` that returns `permissionDecision: "deny"`, so no prompt appears and no allow rule can override it. The human reads `🛑 Blocked: reading a credential directory.` or `🛑 Blocked: reading a .env file.`, and the matched path goes to the model in `additionalContext` — which also keeps a credential path out of a scrolling terminal (see [How a gate speaks](#how-a-gate-speaks)). It covers strictly more than the rules did — `python3 -c "print(open('~/.ssh/id_rsa').read())"` is blocked here and never was there. For Bash it requires a file-reading program alongside the protected path, so `ls ~/.ssh`, `stat ~/.ssh/id_rsa`, and `find . -name ".env*"` stay allowed: they list names without exposing contents, and blocking them would make the guard its own source of prompt noise. It guards Claude's own tool calls, not the OS — for that, enable the sandbox. `hooks/test-permissions.sh` asserts no `Read()` rule creeps back in.

**Stage 2 fails closed, including past its read ceiling.** The dotenv refinement in `hooks/lib/credential-check.py` may only ever *narrow* a block stage 1 already raised, so every way it can fail to read its input — a missing `python3`, a crash, an unparseable segment, and a command longer than its 200,000-byte `MAX_INPUT` — leaves the block standing. The ceiling was the hole: until 2026-09-21 the checker read exactly `MAX_INPUT` and could not tell a truncated command from a complete one, so 200KB of padding ahead of `cat .env` cleared a block stage 1 had correctly raised. Measured through the shipped hook, and asserted now as a pair one byte apart — at 200,000 characters the prose rule still clears a sentence about a dotenv file, at 200,001 the same command blocks.

**Why databases get a hook and only seven deny rules.** `Bash(dropdb:*)`, `Bash(dropuser:*)`, `Bash(mysqladmin drop:*)`, `Bash(docker volume rm:*)`, `Bash(docker volume prune:*)`, `Bash(lando destroy:*)`, and `Bash(wp-env destroy:*)` ship as denies, because no agent has a legitimate use for them, and the first words of each decide the outcome. The four Artisan reset verbs deliberately **do not**, and adding one would be a silent regression. A deny rule matches a prefix, so it cannot read `--env=testing`, which means it cannot carry the exemption the guard relies on. The hook exiting 0 is *neutral*, not an allow, so a deny rule would block a correctly scoped testing reset anyway and the exemption would never fire. That mistake would also stick: `permissions.sh` merges additively and never removes, so deleting the rule from `rails.json` later does not take it out of a user's `settings.json`. `Bash(docker compose down:*)` is absent for the same reason and would be worse: the plain form keeps named volumes and is how a stack gets stopped, so a deny would block routine teardown while the destructive `--volumes` flag sits where a prefix cannot read it. `Bash(ddev delete:*)` is absent on the same grounds, because `ddev delete images` removes Docker images rather than project data. Three instances of one rule, so state it plainly: **a deny rule belongs here only when the first words of the command decide the outcome.** When the verdict depends on a flag or a later argument, the hook is the enforcement and a deny rule is a trap. `hooks/test-destructive-database-guard.sh` asserts that no `artisan`, `docker compose`, or `ddev` rule appears in either list. The enforcement lives in [Destructive database guard](#destructive-database-guard).

**Why worktree and database *creation* gets no deny rule at all.** `Bash(createdb:*)` and `Bash(git worktree add:*)` would both pass the test stated above, since the first words decide the outcome. They are still absent. A rule added here is permanent in a user's `settings.json`, because the merge never removes, and the harm it guards against is an orphan tree or database that one command cleans up. [The provisioning guard](#provisioning-guard) blocks all of it absolutely, and leaving the rule out keeps the decision reversible in a way that adding it would not.

**Why `systemctl` is blanket rather than scoped.** A rule like `Bash(systemctl enable:*)` reads tighter, but it would never match `systemctl --user enable foo` — the flag precedes the verb, and matching is by prefix. That rootless invocation is exactly the one most in need of the rail, since it needs no sudo to install persistence. `secret-tool` *is* scoped (`store`, `clear`) because it always takes its verb as the first argument, which leaves `lookup` unprompted, mirroring `security find-generic-password` on macOS. `hooks/test-permissions.sh` asserts both shapes.

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
├── decisions/         — architectural and process decisions
├── topics/            — topical synthesis pages (current state per theme)
├── projects/          — project context and system designs
├── insights/          — durable patterns and working principles
├── sessions/          — session logs (.log.md) and summaries (.summary.md)
│   └── YYYY-MM-DD/
├── skills/            — per-skill learnings files
├── infrastructure/    — systems and tools documentation
├── maintenance/       — memory-lint audit reports
├── README.md           — catalog of the curated layer (topics, decisions, reference)
└── CLAUDE.md          — vault map (metadata only)
```

#### Memory server transport

The vault is served by a **lazy-started, reference-counted shared HTTP** markdown-vault-mcp server on `127.0.0.1:8765`. `plugin.json` points the `memory` MCP at that URL with a bearer token; the first session that needs the server starts it, and it is stopped a grace period after the last session leaves.

- **Why shared HTTP.** Per-session stdio (v0.13.0–) existed for one reason: Cowork's remote sandbox cannot reach a loopback port on your Mac. With Cowork out of scope that constraint is gone, and the shared server is the better answer on every axis that remains — **one embedding model resident instead of N** (a few hundred MB each), one **single-owner `IndexWriter`** thread serializing every write instead of N indexers racing one SQLite WAL, and **one process for the git sync loop**, which matters because the server's write-quiescing locks are `threading` locks and are therefore only correct with a single writer.
- **Lifetime — up on demand, down when idle.** `memory-server-up.sh` (SessionStart) probes, and on a miss wins an atomic `mkdir` lock and reparents `memory-server-spawn.sh` out of the hook's process group via `perl-setsid`, so the slow work (venv install, embedding build) runs off the hook's critical path. On that miss it then **waits, up to 15s, for the port to start answering** — a probe hit returns instantly and waits for nothing, so only a cold session pays. The wait exists because the client's own retries do not cover a slow bind. Claude Code retries a refused connect at startup up to three times, under a 30s overall startup timeout, but the interval between those attempts is undocumented and evidently short: two sessions that started inside a 13s post-reboot bind window (2026-09-10) spent all three before the bind completed, then ran their whole lives with no memory tools and reported a healthy vault as down. Mid-session reconnection is a separate path (five attempts on exponential backoff) and does not rescue a session that failed to connect at startup. A kicker that backs off to a sibling's spawn waits the same way — it faces the same cold port — and past the ceiling session start proceeds regardless, with the warmup reporting the server. It also **registers a session ref**. `memory-server-release.sh` (SessionEnd) drops the ref and, when it was the last one, reparents `memory-server-idle-stop.sh`. See [Server lifetime](#server-lifetime) below.
- **Index maintenance.** A gated, once/day full VACUUM reclaims index space, run by the spawn supervisor (`hooks/memory-server-spawn.sh` → `hooks/lib/memory-vacuum.sh`) before the server binds. Under the shared transport the supervisor already owns the spawn lock, so it calls `memory_vacuum` directly rather than the `_locked` variant the stdio launcher needed. Spawns are rarer than sessions now, but the reaper restarts the server after any idle gap, so the once/day gate still fires.
- **Server install (concurrency).** The server venv is keyed by the SHA-256 of the bundled wheel (`{memory_cache}/server-venv-<hash>/`), and the install itself runs under a blocking `mkdir` lock (`hooks/lib/memory-install.sh`). Both are required: N sessions start whenever the user starts them, so concurrent `uv pip install --force-reinstall` runs into one directory produced torn venvs, and orphaned plugin roots kept launching an older wheel that fought the current one for the same directory (52 reinstalls in one day, 2026-08-28). Keying by wheel hash means two wheels never share an environment; the lock serializes the remaining same-wheel races. The per-prompt recall hook passes a 0s timeout so a prompt never waits on an install.
- **Port and token.** The shared server needs both. `/workbench-core:setup` provisions `WORKBENCH_MEMORY_PORT` and a minted `WORKBENCH_MEMORY_TOKEN` into `~/.claude/settings.json` `.env`; `plugin.json` interpolates them into the URL and the `Authorization` header. The probe is **identity-checked** rather than a bare TCP connect — it POSTs a real MCP `initialize` and asserts `serverInfo.name` matches the configured vault, so a stale orphan or an unrelated squatter on the port is reported as `DOWN_FOREIGN` instead of being silently adopted.

Cache layout under `{memory_cache}` (default `~/.claude-memory-cache`):

```
{memory_cache}/
├── vault-index.sqlite   — FTS index
├── embeddings/          — FastEmbed vectors
├── server-venv-<hash>/  — the installed server, keyed by bundled-wheel hash
│                          (survives plugin updates; idle ones reclaimed after 30d)
├── refs/                — one file per live session, holding its claude pid
├── server.lock/         — atomic mkdir spawn mutex (claimer.pid + generation nonce)
├── stop.lock/           — serializes idle reapers
└── .last-vacuum         — cooldown stamp for the gated index VACUUM
```

(`kv/`, `events/`, `server.log`, `server.pid`, `server.port`, and `server.token` appear only when the shared HTTP server is enabled — they back the HTTP transport, not stdio.)

##### Server lifetime

The shared server used to follow a "single never-stop model" — once up it stayed up until `memory-server-down.sh` was run by hand. That is wrong for a laptop: a server nobody is using holds the embedding model resident and runs a git pull loop for an empty room. It now has a real lifetime, built from a small ref registry (`hooks/lib/memory-refs.sh`).

- **A ref is one PROCESS, not one session.** `memory-server-up.sh` writes one ref file per live Claude Code process under `{memory_cache}/refs/`, keyed by the owning `claude` pid. Keying by session id was wrong in a way that only showed up in use: one process owns many session ids over its life (a resume, a `/clear`, a plugin reload each mint a new one), so a single running process accumulated a ref per session and the count read 7 when one process was live. Nothing broke — every ref pointed at the same pid, so they swept together — but the number meant nothing. The pid key also makes registration idempotent for free.
- **Liveness is a `kill -0`, not a promise.** A ref released only by SessionEnd would leak the first time a process was SIGKILLed or its terminal closed — and one leaked ref pins the server on forever, which is exactly the bug this exists to prevent. **The pid sweep is the only thing that reclaims a ref**, which is also why SessionEnd deliberately does *not* delete its own: at the moment that hook fires the process is still alive and may have other sessions using the server. The reaper's grace period is precisely the window in which a genuinely exiting process finishes exiting.
- **The owner pid is walked, not `$PPID`.** A hook's immediate parent is whatever shell the harness invoked it with, which dies the instant the hook returns. The registry walks up to the nearest `claude` ancestor instead, because that process lives exactly as long as Claude Code does.
- **Registration precedes the already-serving fast path.** A session joining a *running* server must still be counted, or the reaper would take the server down underneath it the moment the process that originally started it exited.
- **Reaping waits out a grace period** (`WORKBENCH_MEMORY_IDLE_GRACE`, default 120s). Three reasons: session churn should not bounce the server; an unattended `claude -p` dispatch whose SessionStart has not registered yet must not have the server pulled out from under it; and a server idle two minutes longer costs nothing, while one yanked from a live session breaks that session's memory for good.
- **The start/stop race is handled in three layers.** The ref count is checked twice, separated by a settle interval (`WORKBENCH_MEMORY_IDLE_SETTLE`, default 3s); a `stop.lock` admits only one reaper; and **after** the kill the count is checked once more, bringing the server straight back up if a session arrived during the stop. The residual exposure is a session connecting in the milliseconds around the kill itself — the same exposure as any server restart, reachable only after a full grace period of zero sessions.
- **Set `WORKBENCH_MEMORY_IDLE_GRACE=0` to disable auto-stop** and return to the never-stop model.

`hooks/test-memory-refs.sh` covers the registry and the reaper; `hooks/test-plugin-http-config.sh` asserts the transport shape and that the lifetime hooks stay wired in the right order.

##### Re-enabling the shared HTTP server (optional)

The shared-HTTP implementation is **retained, not deleted** — only its invocation is stopped. To switch back:

1. **`.claude-plugin/plugin.json`** — change the `memory` MCP from the stdio `command`/`args` form back to the http block: `{"type":"http","url":"http://127.0.0.1:${WORKBENCH_MEMORY_PORT:-8765}/mcp","headers":{"Authorization":"Bearer ${WORKBENCH_MEMORY_TOKEN}"}}`.
2. **`hooks/hooks.json`** — re-add the `memory-server-up.sh` hook to the `SessionStart` array (before `session-warmup.sh`).
3. **`hooks/session-warmup.sh`** — restore the "Memory server health check" block and the `hooks/lib/memory-probe.sh` source (both are in git history; the file carries a breadcrumb comment where the block used to live).
4. **`/workbench-core:setup`** — re-run to provision the bearer token + `WORKBENCH_MEMORY_PORT` into `~/.claude/settings.json` `.env`, then restart Claude Code.

The supervisor (`hooks/memory-server-spawn.sh`), the identity-checked health probe (`hooks/lib/memory-probe.sh`), the manual stop (`hooks/memory-server-down.sh`), the bearer-token minting, and the one-shot orphan sweep all remain in the tree and work as before once re-wired.

#### Cross-machine sync (optional)

Two machines can share one memory. The server does this itself — no file-sync tool involved — via a git remote: a fetch + fast-forward before the initial index build, then a pull loop whose `on_pull` callback is `reindex`, plus a deferred-commit queue for writes and write-quiescing around each merge.

**Why git and not Syncthing.** A synced *file* is not a searchable memory. A file-sync tool drops the other machine's notes into the vault, but nothing tells the index they arrived, so they stay unfindable until something forces a rescan. The pull loop reindexes on every pull by design. Git also merges markdown — a sync tool hands you a `.sync-conflict` copy and walks away — and gives every memory change a revertible history, which pairs well with the decision-quality loop.

**Only the markdown syncs.** The SQLite index, the embeddings and the venv stay machine-local under `{memory_cache}`. A WAL database copied by a file syncer with no transactional grouping is a corrupted database. Each machine rebuilds its own index incrementally, and because change detection is a content SHA-256 rather than an mtime, sync-induced timestamp churn triggers no reindexing at all. Vault paths are stored relative to the vault root, so `/Users/you` and `/home/you` index identically.

**It requires the shared HTTP transport.** The write-quiescing that makes a merge safe is built from `threading` locks — in-process only. N per-session stdio servers would be N independent locks committing into one `.git`, where git's own `index.lock` fails fast rather than waiting. This is safe *because* there is exactly one server process.

Configure via `config.json` (or the matching `WORKBENCH_*` override):

| `config.json` key | Override env | Default |
|---|---|---|
| `memory_git_repo_url` | `WORKBENCH_MEMORY_GIT_REPO_URL` | unset — **the whole feature is off until this is set** |
| `memory_git_token` | `WORKBENCH_MEMORY_GIT_TOKEN` | unset |
| `memory_git_username` | `WORKBENCH_MEMORY_GIT_USERNAME` | `x-access-token` |
| `memory_git_pull_interval_s` | `WORKBENCH_MEMORY_GIT_PULL_INTERVAL` | `120` |
| `memory_git_push_delay_s` | `WORKBENCH_MEMORY_GIT_PUSH_DELAY` | `30` (write-**idle** seconds, so a burst of captures coalesces into one push) |
| `memory_git_commit_name` / `_email` | `WORKBENCH_MEMORY_GIT_COMMIT_NAME` / `_EMAIL` | server default |
| `memory_git_lfs` | `WORKBENCH_MEMORY_GIT_LFS` | `false` |

Four things to get right:

1. **Use a private repository.** The vault holds personal and operational memory.
2. **Put the token in `~/.claude/settings.json` `.env`**, beside `WORKBENCH_MEMORY_TOKEN`. The env override is read first for exactly this reason; `config.json` is plain-text plugin data and the worse place for a credential.
3. **`.gitignore` the raw transcripts.** `sessions/**/*.log.md` are excluded from indexing and reaped at 7 days — committing them and then committing their deletion a week later is pure churn.
4. **The pull interval is 120s, not the server's own 600s default.** This is interactive shared memory between two machines the same person is using; ten minutes of staleness is long enough to re-derive a decision the other machine already recorded.

The default pull interval is deliberately tighter than upstream's, and `git_lfs` is deliberately inverted — it defaults on upstream and earns nothing on small markdown files while requiring the filter on both machines before a clone works.

#### Canonical store & routing

The vault is the **canonical durable memory store**. Claude Code's harness also injects per-project memory instructions every session (save to `~/.claude/projects/<encoded-cwd>/memory/` + a `MEMORY.md` index) — left alone, sessions scatter memory files there that the vault can't search. The session warmup neutralizes that channel into a router: it injects a `## Memory routing` rule at every session start (saves go to the vault via the memory MCP `write` tool with vault frontmatter; recall is vault `search`, not directory reads, with the mode left to the server, it runs *before* a repo scan rather than after, and its query is built from the task rather than from the prompt's wording), and on startup it writes a self-healing router stub to the current project's `MEMORY.md` (canonical template: `references/memory-routing-stub.md`). A `MEMORY.md` without the router marker is never overwritten — the warmup flags it for human migration instead. Keep the store singular: don't install competing memory MCP servers alongside the vault.

**Why the routing block states when recall happens and what to search for, not just where.** `memory-recall.sh` can only ever search the prompt, because that is the only text a `UserPromptSubmit` hook receives. It runs on every prompt that passes its substance gate, not only the opening one. The routing text claimed "only the opening prompt" until 2026-09-27, and that was never true. Two rules follow, and the routing block (plus its router-stub twin) is the floor for both:

- **When.** Search the vault *before* scanning the repo, and again whenever the task turns up something the prompt never named. `memory-scan-recall.sh` now covers part of that second case automatically (below), but only where a scan carries an extractable query — the rule remains the floor.
- **What.** Build the query from the *task* — the convention, format, procedure, tool, or error you are about to produce or decide — not from the prompt's wording. This is the half with the measurement behind it: replaying "go ahead and push and create a release" against the live vault left `skills/release.learnings.md` — the note carrying the release-title rule — outside the top 8, while "release title naming convention", the query the task implies, put it in the top 5 (5th when first measured, 3rd on re-measure 2026-09-14 — ranks drift as the vault grows, the gap between the two queries does not). The agent's advantage over auto-recall is asking the better question, and a rule that says only *when* leaves that on the table.

**No per-turn reminder restates them any more.** `memory-recall-nudge.sh` and `memory-capture-nudge.sh` used to, on `UserPromptSubmit`. Both were removed on 2026-09-27. They fired on sub-agent hand-backs and task notifications as well as typed prompts, restated warmup text at a measured ~180k tokens in three days, and repeated the false opening-prompt claim. The routing block is re-injected after every compaction, and `memory-capture-stop.sh` stays as the capture backstop.

**The routing block names no search mode.** The server's default is `auto`: hybrid when the vault has embeddings, keyword when it does not. `hooks/memory-search-mode.sh` used to force `hybrid` onto every agent search, on the premise that the server defaulted to keyword. That premise went stale, and forcing hybrid broke the keyword fallback on a vault with no embeddings, so the hook was removed on 2026-09-27.

#### Mid-turn recall, on a scan's own query

The routing block is prose, and prose asks the agent to remember. `hooks/memory-scan-recall.sh` is the mechanism: a `PostToolUse` hook that reads the query out of a content search the agent is **already running**, searches the vault with it, and injects any fresh hits beside that scan's results, in the same turn. A topic the opening prompt never named surfaces its memory at the moment the agent goes looking for it.

**It is not a classifier, and that is the whole safety argument.** It never judges whether a search is worthwhile — it piggybacks on a scan already happening and reuses that scan's own query, so there is no precision-and-recall figure to degrade. What the matcher and `lib/scan-query.py` decide is narrower and purely structural: does this tool call *carry* a query. No query means "there is none here", never "this one is not worth it". `memory-recall.sh` stays the unconditional floor on every prompt, so a scan this hook misses costs one missed extra and never removes the mechanism — the safe shape, not the gating one.

**Why the matcher is `Grep|Bash` and not `Grep|Glob`.** `Grep`'s `pattern` is the scan's query verbatim, which is the strongest extraction available. `Bash` is not a fallback: `Grep` and `Glob` are not granted to every agent, and in the session that commissioned this hook the agent had neither, so every repo scan it ran went through `Bash` and a `Grep`-only matcher would have fired zero times. Under `Bash`, only content searchers are read (`rg`, `grep`, `git grep`, `ag`, `ack`), by argument **slot** rather than substring via the shared `lib/shell_parse.py` tokeniser — so `git log --grep=` and `npm test` carry no query and nothing fires. `Glob` is deliberately **out**: its pattern is a path expression, so it names a filename shape rather than a topic (`**/*.test.ts` carries nothing; `src/**/*.ts` carries two words of noise). `find -name` and `fd` are out under `Bash` for the same reason.

**Cost is what shapes every lever.** Measured 2026-09-14: each `PostToolUse` fire persists **two** transcript records (`hook_success` + `hook_additional_context`), nothing evicts them, and a realistic vault-hit payload implies ~500–600 bytes persisted **per fire**. That is the same accumulation property `UserPromptSubmit` has, and a per-turn nudge was removed from this codebase once already for exactly it. A tool call is far more frequent than a turn, so four levers bound it, and three filters keep a fire from being noise: per-session dedup on the **memory path**, sharing one seen-file with `memory-recall.sh` so the bound is the number of distinct relevant memories *across both hooks*; per-session dedup on the **query**, so a repeated scan costs no subprocess; a top-K of **1**, against `memory-recall.sh`'s 2; and a scheduled-task guard, since an unattended tick has no human to serve and its fresh-per-tick `session_id` defeats both dedup levers. The filters were added on 2026-09-27, when most hits turned out to be noise at about 1.6 s a query. A search that reads **stdin** is skipped, because `git diff | grep -E "real|allow|deny"` filters output rather than researching a topic. A **single plain word** is skipped, because `grep -rn scheduled` names no topic; a camelCase identifier still counts. And a hit has to be **ranked by both retrievers** (`search_type` of `hybrid`): the CLI's `score` is a rank-fusion value that does not separate a good query from a junk one, and every hit for the junk queries measured that day was semantic-only. A `Bash` call that names no content searcher also exits before Python starts. The shared levers live in `lib/memory-recall-core.sh` — one copy, two callers, because each was tuned against an incident and a second implementation would drift from that tuning invisibly.

#### Wiki layer and vault index

Session summaries are chronological sediment; left alone they accumulate as unlinked orphans. Every ingest path (the summary-writer agent, and `/workbench-core:log-now`) therefore follows `references/linking-synthesis.md`: search the vault for related decisions, topics, and prior summaries; add a `## Related` section of root-absolute markdown links (`[display text](/folder/file-stem.md)` — the form markdown-vault-mcp resolves immediately); maintain at most one topical synthesis page in `topics/` per session; and cross-link promoted decisions to their summaries and topics. Linking is deliberately conservative — only high-confidence connections, capped per ingest, because an orphan beats a forced link.

`README.md` at the vault root is the catalog of the curated layer — one markdown link + one-line hook per topic, decision, and reference document (never sessions). It's the orientation entry point: agents read it **on demand** to get the lay of the vault before searching — it is **not** auto-loaded into context. The summary writers keep it current as they create topics and promote decisions; the lint ritual repairs drift.

#### Lint ritual

Vaults rot silently: files written without the required `name`/`type` frontmatter are skipped at index time (on disk but invisible to search), links break when targets move, orphans accumulate. `/workbench-core:memory-lint` is the periodic repair pass — it diffs the filesystem against the index to find skipped files and rescues their frontmatter, repairs or removes broken links, adds only high-confidence links (never mass-links orphans), repairs `README.md` drift in both directions (missing entries for `topics/` and `decisions/` documents, stale entries pointing at deleted ones), and flags duplicates/contradictions for the human instead of merging. Each run is capped at 50 file-fixes and writes an audit report to `maintenance/` with before/after stats. Intended cadence: monthly, deployed via the scheduled-tasks MCP. Raw `*.log.md` transcripts are never touched.

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
| Decisions, projects | Forever | Core operational memory |

## Skills

| Skill | Description |
|-------|-------------|
| `/workbench-core:setup` | Configure agent name, paths, summary model, permission rails, and the shipped output style; re-run after an update to re-sync the style |
| `/workbench-core:log-now` | Dump the current session log and write a narrative summary inline |
| `/workbench-core:process-pending-summaries` | Dispatch background agents to clear pending summary markers, or one agent for a session ID given as the argument |
| `/workbench-core:compact-learnings` | Review and compact accumulated skill learnings; integrate into SKILL.md for workbench skills |
| `/workbench-core:evaluate-decisions` | Grade recorded decisions & memories for decision quality (correctness, accuracy/efficiency/speed, consistency/recurrence, gaps) → learnings report. Decision-quality loop, gear 2 |
| `/workbench-core:propose-upgrades` | Turn an evaluation into concrete corrections & new process recordings, walk human sign-off, apply only what's approved. Decision-quality loop, gears 3+4 |
| `/workbench-core:memory-lint` | Monthly health-and-repair pass over the memory vault — frontmatter rescue, broken-link repair, conservative orphan linking, vault-index drift repair, duplicate flagging, audit report |
| `/workbench-core:memory-status` | Report the shared memory server's facts — vault/cache, server-binary presence, index & last-VACUUM |
| `/workbench-core:install-chat-skills` | Discover skills in `@claude-workbench` plugins and install them into the Claude Mac app's Chat surface via `.skill` packaging |
| `/workbench-core:intake` | The task-intake routine for an interactive session — goal, context, an interview limited to real gaps, acceptance criteria shown before work starts, and three options from different angles graded against every criterion. See [Task intake](#task-intake) |
| `/workbench-core:orchestrator` | Turn the [delegation gate](#delegation-gate) off or on for this session, or report its state. `off` allows whole-file writes, `on` restores the gate, no argument reports. `Edit` is never gated |
| `/workbench-core:cross-session-messaging` | The protocol for messaging another Claude Code session — when to reach out, what a message carries, the receive-side rule that keeps a human in the loop, and which sends a sub-agent may make. Paired with the [peer message gate](#peer-message-gate) |

Every skill is **execution-aware** without saying so: `hooks/skill-learnings.sh` hands it its `skills/{name}.learnings.md` file from the vault when it runs (see [Execution-aware skills](#execution-aware-skills)).

### Cross-surface skill installation

workbench-core auto-discovers installable skills in dependent `@claude-workbench` plugins and records a notice in `~/.claude-workbench/warmup-notices.md` (see [Housekeeping notices](#housekeeping-notices--pulled-not-pushed)) when new or updated skills are available:

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
| `WORKBENCH_MEMORY_PATH` | `memory_path` |
| `WORKBENCH_MEMORY_CACHE` | `memory_cache` |
| `WORKBENCH_MEMORY_PORT` | `memory_port` — the shared HTTP server's port; the MCP client connects here |
| `WORKBENCH_MEMORY_TOKEN` | the shared HTTP server's bearer token, minted by `/workbench-core:setup` |
| `WORKBENCH_SUMMARY_MODEL` | `summary_model` |
| `WORKBENCH_AUTO_SUMMARIZE` | `auto_summarize` |
| `WORKBENCH_LOG_MODE` | Force log mode (`checkpoint`, `final`, `manual`) |
| `WORKBENCH_SKIP_LOG` | Set to `1` to skip logging (used by summary-writer) |
| `WORKBENCH_SKIP_WARMUP` | Set to `1` to skip warmup (used by summary-writer) |
| `WORKBENCH_MCP_SERVER_NAME` | `memory_mcp_server_name` |
| `WORKBENCH_MEMORY_RECALL` | Set to `0` to disable proactive vault recall. Reaches **both** injecting hooks — `memory-recall.sh` and `memory-scan-recall.sh` |
| `WORKBENCH_MEMORY_RECALL_LIMIT` | Max memories the recall hook injects per turn (default `2`) |
| `WORKBENCH_MEMORY_RECALL_STATE` | Per-session seen-paths state dir (default `~/.claude-workbench/memory-recall`). Shared by both recall hooks on purpose: one seen-file is what bounds a memory to one injection per session across the pair |
| `WORKBENCH_MEMORY_SCAN_RECALL` | Set to `0` to disable mid-turn scan recall (`memory-scan-recall.sh`) while leaving prompt recall on |
| `WORKBENCH_MEMORY_SCAN_RECALL_LIMIT` | Max memories that hook injects per fire (default `1` — it fires per tool call, not per turn) |
| `WORKBENCH_MEMORY_SCAN_RECALL_MIN_CHARS` | Min length of an extracted query, spaces not counted, before the vault is searched (default `6`) |
| `WORKBENCH_MEMORY_SCAN_RECALL_TYPES` | Eligible frontmatter types for that hook (same default and same rule as `WORKBENCH_MEMORY_RECALL_TYPES`) |
| `WORKBENCH_MEMORY_RECALL_TYPES` | Comma-separated frontmatter types eligible for injection (default `decision,insight,topic,feedback,reference,project,skill-learnings,recurring-issue`; empty disables the filter). A type belongs when a note of that type asserts something still true that should change what the agent does next — which is why `session` summaries and the dated `learnings` evaluation snapshots are excluded |
| `WORKBENCH_CAPTURE_STOP` | Set to `0` to disable [pre-shed capture](#pre-shed-capture) (`memory-capture-stop.sh`). `WORKBENCH_MEMORY_NUDGE=0` also disables it — the older family kill switch, still honoured |
| `WORKBENCH_CAPTURE_STOP_FIRST` | Turn end of the **first** capture block (default `5`). The number that decides whether the backstop fires at all: at 5 it reaches 88% of this project's sessions, at 21 it reaches 16% |
| `WORKBENCH_CAPTURE_STOP_INTERVAL` | Turn ends between **later** capture blocks (default `40`). Sparse on purpose: a block buys a whole extra model turn. Independent of `_FIRST` so either can be retuned alone |
| `WORKBENCH_SETTINGS_FILE` | `~/.claude/settings.json` path (used by `install.sh` and `permissions.sh` for testing) |
| `WORKBENCH_OUTPUT_STYLES_DIR` | `~/.claude/output-styles` path (used by `install.sh` for testing) |
| `WORKBENCH_MEMORY_GIT_REPO_URL` | Vault git remote; unset disables cross-machine sync entirely |
| `WORKBENCH_MEMORY_GIT_TOKEN` | Credential for that remote (prefer this over `config.json`) |
| `WORKBENCH_MEMORY_GIT_PULL_INTERVAL` | Seconds between fetch + fast-forward pulls (default 120) |
| `WORKBENCH_MEMORY_GIT_PUSH_DELAY` | Seconds of write-idle before pushing (default 30) |
| `WORKBENCH_MEMORY_GIT_LFS` | Git LFS for the vault (default `false`) |
| `WORKBENCH_MEMORY_IDLE_GRACE` | Seconds after the last session leaves before the shared server is stopped (default 120; `0` disables auto-stop) |
| `WORKBENCH_MEMORY_IDLE_SETTLE` | Seconds between the reaper's two pre-kill ref checks (default 3) |
| `WORKBENCH_MEMORY_REFS_DIR` | Session ref registry location (default `{memory_cache}/refs`; used by tests) |
| `WORKBENCH_RAILS_FILE` | `assets/permissions/rails.json` path (used by `permissions.sh` for testing) |
| `WORKBENCH_ORCHESTRATOR` | Set to `0` to stand the [delegation gate](#delegation-gate) down for the whole process (for a headless harness that cannot answer a deny) |
| `WORKBENCH_ORCHESTRATOR_STATE_DIR` | Delegation-gate session-toggle directory (default `~/.claude-workbench/orchestrator-mode`; used by tests) |

## Known limitations

- **Restart after plugin update.** `CLAUDE_PLUGIN_ROOT` is resolved once at session startup. After updating, restart Claude Code to pick up changes.
- **Server lifetime is decoupled from session lifetime.** This is the tradeoff the shared server buys its efficiency with, and it runs the opposite way to stdio. A stdio server could not outlive or predecease its session; a shared one can. If the server dies mid-session — a crash, an OOM, a plugin update, or a laptop sleep/wake dropping the connection — that session's memory tools stay dead, because the SessionStart probe and the lazy-start supervisor only cover a *cold* start, not a mid-session death. The reaper's own exposure is bounded (see [Server lifetime](#server-lifetime)); an external restart is not.
- **Summary-writer race on rapid compactions.** If a session compacts multiple times in quick succession, multiple summary-writers may run concurrently. The last one wins (overwrites the summary), which is always the most complete — but intermediate writers do wasted work.

## Design philosophy

The plugin is **infrastructure first, persona optional**. The framework imposes no personality. It ships one output style under `assets/personas/<name>/` as an optional starting point: you opt in through `/workbench-core:setup`, which copies it to *your* editable location. It is never enforced, and nothing stops you from editing it into something else entirely once it is yours.

Memory files live **outside any git repo**, at a user-configured path. Memory is personal state; the plugin is code. They are intentionally separate.
