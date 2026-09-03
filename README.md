# core

Core infrastructure plugin for Claude Code. Part of the [`claude-workbench`](https://github.com/mike-bronner/claude-workbench) marketplace.

## What this is

The infrastructure layer that turns Claude Code from a stateless coding assistant into a persistent, identity-aware collaborator. It provides:

- **Persistent identity** — persona files (`soul-hot.md`, `profile.md`) injected at session start and re-injected after context compression so the agent never drifts.
- **Guardrails** — absolute behavioral rules that ship with the plugin, load last (highest authority), and are enforced by the interview skills. Guardrails can't be overridden by persona or profile choices.
- **Session logging** — every session is captured as a rolling JSONL log, then summarized by a background agent into a searchable narrative.
- **Operational memory** — a shared, lazy-started local MCP server (markdown-vault-mcp) fronts a searchable vault of decisions, projects, insights, and session history, optionally kept in sync across machines over git.
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

### Optional: CLI system-prompt enforcement

**Background:** Claude Code's default system prompt includes rules like "no emojis unless asked" and specific tone/style directives. If your agent persona contradicts these (e.g., "use emojis liberally"), the system prompt wins — it's architecturally higher authority than `CLAUDE.md` or hook output, which are both delivered as user messages.

The plugin addresses this at three layers:

| Layer | File | Authority | Works in |
|-------|------|-----------|----------|
| 1 | `~/.claude/system-overrides.md` | System prompt (highest) | CLI only |
| 2 | `~/.claude/CLAUDE.md` managed block | User message | Everywhere |
| 3 | SessionStart hook output | Tool result | Everywhere |

Layers 2 and 3 are automatic — the plugin generates and maintains them on every startup. Layer 1 requires a one-line shell alias because `--append-system-prompt-file` is CLI-only (no settings.json equivalent exists).

Layers 1 and 2 carry the behavioral overrides **fully inlined** — never a pointer. Each file is read later, by the CLI and by the model, against a version-pinned plugin path that may no longer be live, so a "see `references/…`" line would break its authority tier. What the two layers share is their *source*: the warmup hook renders both from `references/behavioral-overrides.md` at session start, when `CLAUDE_PLUGIN_ROOT` is guaranteed current. Edit the rules there — the two destinations converge on the next startup. If that file is missing or empty, the hook fails closed and leaves both destinations untouched rather than writing a hollow identity block.

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
| `agent_name` | Your agent's name, if it has one (e.g. `Ada`) | `Claude` |
| `memory_path` | Where your operational memory lives on disk | `~/Documents/Claude/Memory` |
| `memory_cache` | Where indexes, server artifacts, and checkpoints are stored | `~/.claude-memory-cache` |
| `memory_mcp_server_name` | MCP server name for the vault (`serverInfo.name`) | `workbench-memory` |
| `memory_port` | Loopback port the shared HTTP memory server binds and the MCP client connects to | `8765` |
| `auto_summarize` | Spawn background summary-writer (PreCompact, `/log-now`, and the session-start drain) | `true` |
| `summary_model` | Model for the background summary-writer | `sonnet` |

Setup also installs **permission safety rails** into `~/.claude/settings.json` — a `permissions.defaultMode` you pick, plus `deny` and `ask` rules shipped at `assets/permissions/rails.json`. Claude Code evaluates those rules deny → ask → allow *before* the auto-mode classifier, in every mode including `bypassPermissions`, which makes them the durable counterpart to a boundary stated in conversation (that one is lost when context is compacted). The merge is additive and never touches `permissions.allow`. See [Permission safety rails](#permission-safety-rails).

Configuration is stored in `~/.claude/plugins/data/workbench-core-claude-workbench/config.json` and survives plugin updates. The hooks resolve env from this file at launch (via `hooks/lib/memory-env.sh`), so a plugin version bump never clobbers your settings. Per-session stdio needs no port or bearer token in `settings.json` — those are provisioned by `/workbench-core:setup` only if you re-enable the optional shared HTTP server (see [Memory server transport](#memory-server-transport)).

### Set up identity files

There are three ways to get identity files in place — pick one:

**Fastest — install the shipped persona.** The plugin ships one ready-made persona under `assets/personas/<name>/`. Install it with:

```
/workbench-core:install
```

It propagates whatever that persona directory contains — an output style to `~/.claude/output-styles/` plus the `outputStyle` setting, and soul files to your vault if it ships any. It is non-destructive: existing hand-edited files are diffed and confirmed before any overwrite. This is the quickest path to a durable voice, because the output style sits in the system prompt (which outranks context).

The persona shipped today is `clear`: an output style only, with no soul files. It defines a writing standard rather than a character, so nothing lands in `identity/`. A persona directory may ship `soul-hot.md` and `soul-core.md` as well — both are optional, and each installs only when present.

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
| `behavioral-overrides.md` | session-warmup | The persona's behavioral overrides — single source rendered, fully inlined, into both `~/.claude/system-overrides.md` (Layer 1) and the managed `~/.claude/CLAUDE.md` block (Layer 2) |
| `summary-format.md` | summary-writer, log-now, summarize-session | Required frontmatter, body structure, JSONL parsing guidance |
| `decision-promotion.md` | summary-writer, log-now, summarize-session | Promotion criteria, when NOT to promote, decision file template |
| `vault-conventions.md` | summary-writer, log-now, summarize-session | Vault paths, required frontmatter, write vs edit rules |
| `linking-synthesis.md` | summary-writer, log-now, summarize-session, memory-lint | Link syntax, related-document linking, topic-page synthesis, vault index contract |

Most references are loaded at execution time via `${CLAUDE_PLUGIN_ROOT}/references/`. The exceptions are the two the warmup hook reads at every session start: `guardrails.md`, injected into context, and `behavioral-overrides.md`, rendered onto disk into the Layer 1 and Layer 2 files above.

## Plugin layout

```
core/
├── .claude-plugin/
│   └── plugin.json              — manifest + MCP server config
├── agents/
│   └── summary-writer.md       — background narrative agent definition
├── assets/
│   ├── personas/              — the shipped persona (output style, plus soul files if any)
│   ├── prompt-templates/      — scheduled-task prompt bodies (decision-quality nightly)
│   └── templates/              — identity + protocol templates
├── hooks/
│   ├── hooks.json              — hook → script bindings
│   ├── session-log.sh          — raw log capture + summary-writer dispatch (not at SessionEnd)
│   ├── session-warmup.sh       — identity injection + retention cleanup + summary drain
│   ├── mcp-memory.sh           — stdio launcher, retained but unwired (see Memory server transport)
│   ├── memory-server-up.sh     — shared-HTTP SessionStart kicker (disabled; retained for re-enable)
│   ├── memory-server-spawn.sh  — shared-HTTP detached supervisor (disabled; retained)
│   ├── memory-server-down.sh   — shared-HTTP manual stop (disabled; retained)
│   ├── memory-capture-nudge.sh — UserPromptSubmit: nudge proactive memory WRITES
│   ├── memory-recall.sh        — UserPromptSubmit: inject relevant memory READS (recall)
│   ├── mcp-output-cap.sh       — PostToolUse: cap oversized MCP tool responses
│   ├── outbound-prose-guard.sh — PreToolUse: check gh + board-MCP prose against the output style
│   ├── lib/                    — sourceable libs: memory-env / -probe / -vacuum / -install, summary-dispatch, prose-check
│   └── fixtures/               — test fixtures (fake-server stub, no real server)
├── docs/
│   ├── session-warmup-contributions.md — how plugins contribute warmup text
│   └── mcp-output-capping.md   — per-server MCP output-limit standard
├── references/
│   ├── guardrails.md           — absolute behavioral rules (injected at session start)
│   ├── behavioral-overrides.md — persona overrides, rendered into layers 1 + 2 at startup
│   ├── decision-promotion.md   — when and how to promote decisions
│   ├── linking-synthesis.md    — link syntax, topic pages, vault index contract
│   ├── summary-format.md       — summary frontmatter + body template
│   └── vault-conventions.md    — paths, frontmatter rules, write conventions
├── skills/
│   ├── compact-learnings/      — review, compact, and integrate skill learnings
│   ├── setup/                  — configure agent name, paths, MCP settings
│   ├── evaluate-decisions/     — grade recorded decisions/memories → learnings report (REPS gear 2)
│   ├── propose-upgrades/       — learnings → reviewed proposals → apply on sign-off (REPS gears 3+4)
│   ├── define-profile/         — interactive user profile interview
│   ├── define-soul/            — interactive agent identity onboarding
│   ├── install/                — propagate the shipped persona to live locations
│   ├── log-now/                — dump + narrate the current session inline
│   ├── memory-lint/            — monthly vault health-and-repair pass
│   ├── process-pending-summaries/ — dispatch background agents for pending markers
│   └── summarize-session/      — manually summarize a specific session
├── scripts/
│   ├── install-chat-skills.sh  — package + install skills into Claude Chat
│   ├── install.sh              — propagate the shipped persona to live locations
│   ├── permissions.sh          — merge the shipped permission rails into settings.json
│   └── memory-status.sh        — report the shared memory server's facts
└── README.md
```

## How it works

### Session lifecycle

These hooks fire across the session lifecycle and on each turn:

| Hook | Script | Purpose |
|------|--------|---------|
| `SessionStart` | `hooks/session-warmup.sh` | Identity injection, retention cleanup, pending-summary drain, housekeeping notices (written to a file, not injected) |
| `PostToolUse` | `hooks/mcp-output-cap.sh` | Cap oversized MCP tool responses (matcher `^mcp__`) — see [MCP output capping](#mcp-output-capping) |
| `PreCompact` | `hooks/session-log.sh` | Dump raw log checkpoint, spawn summary-writer |
| `PostCompact` | `hooks/session-warmup.sh` | Re-inject identity after context compression |
| `SessionEnd` | `hooks/session-log.sh` | Dump final log segment and write the pending-summary marker — **no writer is spawned here** (see [Why SessionEnd does not spawn](#why-sessionend-does-not-spawn)) |
| `UserPromptSubmit` | `hooks/memory-capture-nudge.sh` | Sparse nudge to capture durable knowledge to the vault (memory **writes**) |
| `UserPromptSubmit` | `hooks/memory-recall.sh` | Proactive recall — search the vault with the prompt and inject relevant memories, **once per session** per memory (memory **reads**) |
| `PreToolUse` | `hooks/outbound-prose-guard.sh` | Check prose leaving the machine against the output style's mechanical rules — see [Outbound prose guard](#outbound-prose-guard) |

### Outbound prose guard

An output style governs *replies*. Claude Code reinforces it after every turn, and that reminder rides on the response, so it never reaches a document composed inside a tool call. A pull request body written to a file and piped through `gh pr edit --body-file` escapes the standard completely.

That is not hypothetical. `insight-llc/decisioncloud#21665` shipped a 1,855-word body with no emoji, twelve em dashes, and nineteen sentences past the twenty-word limit, in a session where the style was loaded and being followed in the terminal the whole time.

`hooks/outbound-prose-guard.sh` closes the gap for artifacts other people read: `gh pr create|edit|comment|review`, `gh issue create|edit|comment`, `gh release create|edit`, and the same prose posted through a project board MCP (`add_comment`, `submit_review`, `create_issue`, `set_acceptance_criteria`). It exits 2 on a violation, and stderr on a blocking `PreToolUse` hook reaches the model, so the findings become the revision brief.

`hooks/lib/prose-check.py` holds the five checks, each traceable to one line of the shipped output style:

| Finding | Rule |
|---------|------|
| `em-dash` | Join ideas with a colon, a parenthesis, or a full stop |
| `semicolon` | A semicolon means you have two sentences |
| `no-emoji` | Emoji are structure, at the same density everywhere |
| `long-para` | One idea per bullet, one topic per paragraph (limit 6 sentences) |
| `long-sent` | 20 words maximum, a single idea |

**What it does not check.** Whether a body leads with the answer, and whether it is a debugging journal rather than a review aid, are judgement calls no regex settles. Those stay in the output style where a reader applies them.

**What it exempts,** because the author does not control it: fenced and inline code (a semicolon there belongs to the language), HTML comments, bot-authored regions such as CodeRabbit's release notes, `- [ ]` checklist lines from a repository pull request template, and URLs inside markdown links. A bare `PULL_REQUEST_TEMPLATE.md` passes clean, which is the calibration that matters. A gate that blocks the template blocks every pull request.

**It fails open.** A heredoc, a command substitution such as `--body "$(cat notes.md)"`, or an unreadable path exits 0 rather than blocking. This is a style gate, not a security boundary, so a false block costs more than a missed check. `hooks/credential-guard.sh` makes the same trade for the same reason.

**Terminal replies are out of scope,** and cannot usefully be brought in. A `Stop` hook fires after the reply has already been displayed, so blocking there appends a correction instead of preventing the text. Replies are governed by the behavioral overrides, which sit at system-prompt tier.

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
            ├── Update profile.md (if preferences shifted)
            └── Delete the marker
```

One rolling log file per session. Checkpoint and final segments are appended to the same file. Later writer runs overwrite earlier summaries with the most complete picture.

#### Why SessionEnd does not spawn

A child process started as the parent CLI exits is killed during teardown. `nohup` immunises against `SIGHUP` only — not a process-group `SIGTERM`, and not the OS reaping the job when the parent goes away. Between 2026-07-31 and 2026-08-14 this stranded 968 markers on one install: every one of them `event: SessionEnd`, and not a single `PreCompact`. That asymmetry is what identified the bug, since PreCompact fires mid-session with the parent alive and its writers always completed.

So `mode=final` writes the marker and stops. The next session start drains it, where the parent is alive by definition. Work triggered at process death cannot be made to outlive the process by backgrounding it harder.

The drain is bounded (`WORKBENCH_DRAIN_BATCH`, default 3) and rate-limited (`WORKBENCH_DRAIN_COOLDOWN_MIN`, default 5) so a large backlog clears over several sessions instead of forking a swarm at one session start. It takes the **oldest** markers first: the retention sweep refuses to delete any raw log that still has a marker, so draining newest-first would pin the oldest logs on disk indefinitely. Writer stdout and stderr go to `{memory_cache}/summary-dispatch-errors.log` — the original dispatch discarded both to `/dev/null`, which is why a two-week outage went unnoticed.

### Identity injection

Identity files are injected on **every** warmup source:

| Source | When | What happens |
|--------|------|--------------|
| `startup` | Fresh session | Full warmup: retention cleanup + identity + pending-summary drain + notices refresh |
| `resume` | Reconnecting | Identity refresh + pending-summary drain + notices refresh |
| `clear` | After `/clear` | Identity refresh + notices refresh |
| `compact` | After compression | Identity refresh only (via PostCompact hook) |

This ensures the agent never loses its voice or behavioral constraints, even in long sessions with multiple context compressions.

### Housekeeping notices — pulled, not pushed

Warmup output has to be **byte-stable**. Anthropic prompt caching matches on an
exact request prefix, so a single byte that drifts between otherwise identical
sessions invalidates the cache for the whole prompt downstream of it — identity,
plugin contributions, skill bodies, tool definitions. An unattended scheduled
task that fires every 20 minutes pays that penalty on every tick.

So no volatile state is injected into the warmup payload. Pending session
summaries, misrouted project summaries, recall-hook liveness, and new
Chat-installable skills are all written to:

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

A `PostToolUse` hook (`hooks/mcp-output-cap.sh`, matcher `^mcp__`) is a
context-cost backstop for **every** MCP tool call in the session — including
vendored third-party servers whose code no workbench plugin controls. It uses
the harness's `updatedToolOutput` field ("Replaces the tool output before it is
sent to the model"), so the replacement happens in place with no re-execution.

Claude Code already enforces `MAX_MCP_OUTPUT_TOKENS`, persisting overflow to a
file and swapping in a pointer. Its real behavior (read out of the 2.1.219
binary) is worth knowing, because it sets the ceiling this hook works under:

| | |
|---|---|
| Limit | 25,000 tokens |
| Size estimate | `round(chars / 4)`, plus 1,600 tokens per image |
| Cheap fast-path | estimate ≤ 50% of limit → returned untouched |
| ⇒ never properly measured below | ~50,000 chars |
| ⇒ persistence effectively begins around | ~100,000 chars |

That handling happens *during the MCP tool call*, before `PostToolUse` hooks see
`tool_response` — so a genuinely huge result arrives here already replaced by the
harness's pointer. **The band this hook governs is roughly 0–100 KB.**

The 60,000-byte default lands at ~15,000 estimated tokens — above the 10,000-token
point where Claude Code itself starts warning *"Large MCP response (~N tokens),
this can fill up context quickly"*, and below its 25,000-token persistence limit.
It was chosen empirically: across 2,762 recorded MCP calls in the dev-team
pipeline the largest response was 40,986 bytes (median 53), so 60,000 clears all
observed real traffic with headroom while still cutting the unbounded dumps this
hook exists for.

At that size the two layers can begin to meet — 60,000 chars is past the harness's
50,000-char fast path, and dense JSON tokenizes nearer 2 chars/token than 4. If
the harness persists first, this hook sees the resulting pointer and passes it
through. Both layers do the same thing, so the overlap is harmless.

**Deliberate caps are exempt.** Some servers set a large ceiling *on purpose* and
raise rather than truncate — the correct design, and the one
`docs/mcp-output-capping.md` argues for. markdown-vault-mcp, behind this plugin's
own memory MCP, allows `.md` reads up to 262,144 bytes. Session logs and
synthesis notes routinely sit in the 60 KB–256 KB range, and byte-truncating one
would destroy a document the server deliberately chose to return whole. Tool
names matching `WORKBENCH_MCP_OUTPUT_EXEMPT` are therefore skipped outright.

This does not reintroduce per-plugin opt-in: the list lives in core, and an
unknown third-party server — the case this hook exists for — is still capped by
default without anyone doing anything.

Nothing is ever lost. The full response is written to
`~/.claude-workbench/mcp-output/<tool_use_id>.txt` **before** truncation, and the
replacement points at it. If that write fails or comes up short, the hook emits
nothing and the original passes through — truncating without a recoverable copy
would be data loss. Responses it doesn't recognise (a content array holding an
image or resource block, an unfamiliar object shape) also pass through untouched.

| Variable | Default | Effect |
|---|---|---|
| `WORKBENCH_MCP_OUTPUT_CAP` | unset | `0` disables the hook entirely |
| `WORKBENCH_MCP_OUTPUT_MAX_BYTES` | `60000` | Cap in bytes (~15k tokens). Values under 1024 are rejected as a footgun |
| `WORKBENCH_MCP_OUTPUT_EXEMPT` | `^mcp__plugin_workbench-core_memory__read$` | Regex of tool names never capped. Set empty to exempt nothing |
| `WORKBENCH_MCP_OUTPUT_DIR` | `~/.claude-workbench/mcp-output` | Where full responses are persisted (swept after 3 days) |

This hook is a **backstop, not a substitute** for servers capping their own
output: it can only truncate bytes, where a server knows to return its 10 best
results with snippets. See `docs/mcp-output-capping.md` for the per-server
standard.

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

### Permission safety rails

Guardrails are prose in the model's context. Permission rails are enforcement in the harness. They solve the same problem at different layers, and the second one holds when the first is gone.

**The problem:** From August 14, 2026, `auto` is the default permission mode on Pro, Max, and Team plans — a classifier reviews actions instead of prompting you. Anthropic's own documentation is blunt that this *does not guarantee safety*. Worse for an agent with a long-running session: a boundary you state in conversation ("don't force-push") is re-read from the transcript on every classifier check, so **context compaction can erase it**.

**The solution:** `assets/permissions/rails.json` ships a curated `deny` and `ask` list, merged into `~/.claude/settings.json` by `scripts/permissions.sh` during `/workbench-core:setup`. Permission rules are evaluated **deny → ask → allow, before the classifier**, in every mode including `bypassPermissions`. Nothing compacts them away.

- **deny** — hard wall. No prompt, no override, no classifier opinion. Reserved for the irreversible: `sudo`, disk formatting and partitioning, `shred`, `btrfs`, `git push --force`, history rewriting, bulk keychain dumps.
- **ask** — always prompts, even in `auto`, even when a narrower allow rule matches. Used for destructive-but-legitimate work: `rm -rf`, `git reset --hard`, `gh pr merge`, `npm publish`, keychain and libsecret writes, `launchctl`/`systemctl`/`crontab` persistence, AUR helpers.
- **autoMode.allow** — a different layer: prose exceptions to the classifier's built-in *soft-deny* rules, read as natural language rather than tool patterns.

The merge is **additive**: entries are added when absent, existing rules keep their position, and `permissions.allow` is never touched. `--dry-run` previews; `--list` prints every rule with its rationale.

**Why an `autoMode.allow` entry ships.** The classifier's built-in soft-deny list includes *auto-mode bypass*, and the dev-team Dispatch task launches agents with `nohup claude -p --agent ... --dangerously-skip-permissions` — which reads exactly like Claude removing its own oversight, so the classifier blocks it. A soft deny clears on explicit user intent, but a scheduled task has no user message to clear it. `autoMode.allow` is the documented mechanism for that exception; `permissions.allow` is not, because auto mode deliberately suspends broad shell allow rules that grant arbitrary code execution. The literal `"$defaults"` must stay in the array — omitting it discards every built-in soft-deny rule — so `permissions.sh` prepends it whenever missing.

**The constraint that shapes the ask list.** An `ask` rule always forces a prompt, and a `claude -p` run has nobody to prompt — so the call is *blocked*. `workbench-dev-team` dispatches Watson unattended via `nohup claude -p --agent`, and Watson pushes branches, commits, and opens PRs. `Bash(git push:*)`, `Bash(git commit:*)`, and `Bash(gh pr create:*)` are therefore deliberately absent from the ask list; adding them kills the pipeline silently. `hooks/test-permissions.sh` asserts their absence. The git-commit approval gate stays a `PreToolUse` hook because a hook can force a prompt *and* carry a pipeline exemption — an ask rule cannot.

**Why there is no `rm` deny rule.** `Bash(rm -rf:*)` sits in `ask` instead. A deny on `rm -rf /` would match every absolute-path delete — `*` is always a wildcard, and a deny rule can't carry an allowlist exception, so no `/tmp` carve-out is expressible. Claude Code already gates the catastrophic case semantically: the classifier decides root and home removals in `auto`, including inside `$(...)` and `<(...)` substitution, and they still prompt under `bypassPermissions` as a circuit breaker. A textual rule would add friction without adding coverage.

**What the Linux rails cover, and what they deliberately don't.** The `sudo` deny does most of the work: every mutating `pacman`/`apt`/`dnf` operation needs root, so those managers are already walled and get no rule of their own — a blanket one would prompt on every harmless `-Q` query and buy nothing. The rails added for Linux close the paths that *don't* go through sudo: AUR helpers (`yay`, `paru`) run as your user and elevate internally, `systemctl --user` and `systemd-run --user` need no root, `udisksctl` mounts and powers off devices through polkit, and `secret-tool` is the libsecret keychain. Disk tools (`parted`, `fdisk`, `sfdisk`, `sgdisk`, `wipefs`, `blkdiscard`) are denied as defense in depth on the same footing as `dd` and `mkfs` — root-requiring, but the deny costs nothing and doesn't depend on the sudo rule staying put. `btrfs` is denied because `btrfs subvolume delete` destroys snapshots, which on a btrfs root are the undo rope for every other mistake — the same reasoning as the reflog rule. `shred` is denied rather than asked because, unlike `rm`, an agent has no routine reason to securely wipe a file.

Two matching behaviours worth knowing: `Bash(git push --force:*)` also blocks `--force-with-lease`, and `Bash(mkfs:*)` covers the per-filesystem variants (`mkfs.ext4`, `mkfs.btrfs`) by prefix.

**Why credential paths get a hook instead of a deny rule.** The rails used to ship `Read(~/.ssh/**)`, `Read(~/.aws/**)`, `Read(~/.gnupg/**)`, and `Read(**/.env)`. Both halves of what those rules promised turned out to be false. They were never *enforcement*: Anthropic's own documentation states that Read and Edit deny rules apply to the built-in file tools and to the file commands Claude Code recognises in Bash — `cat`, `head`, `tail`, `sed` — and "don't apply to arbitrary subprocesses that read or write files indirectly, like a Python or Node script that opens files itself." And they were expensive: `xce()` in the Claude Code binary is a plain boolean over the deny list, so the presence of *any* `Read()` rule makes the `deniedPathInsideDirectory` circuit breaker return `ask` for every `grep`/`rg`/`diff`/`git`/`cp`/`mv` carrying a relative path in a command that also contains `cd` — without ever consulting a rule. That breaker is registered `bypassImmune` and is not classifier-routed, so no allow rule and no permission mode overrides it, and narrowing the rules does nothing. Only removing all four disarms it.

`hooks/credential-guard.sh` replaces them: a `PreToolUse` hook on `Bash|Read|Edit|Write|NotebookEdit` that exits 2 *before* permission rules are evaluated, so no prompt appears and no allow rule can override it. It covers strictly more than the rules did — `python3 -c "print(open('~/.ssh/id_rsa').read())"` is blocked here and never was there. For Bash it requires a file-reading program alongside the protected path, so `ls ~/.ssh`, `stat ~/.ssh/id_rsa`, and `find . -name ".env*"` stay allowed: they list names without exposing contents, and blocking them would make the guard its own source of prompt noise. It guards Claude's own tool calls, not the OS — for that, enable the sandbox. `hooks/test-permissions.sh` asserts no `Read()` rule creeps back in.

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
├── README.md           — catalog of the curated layer (topics, decisions, identity, reference)
└── CLAUDE.md          — vault map (metadata only)
```

#### Memory server transport

The vault is served by a **lazy-started, reference-counted shared HTTP** markdown-vault-mcp server on `127.0.0.1:8765`. `plugin.json` points the `memory` MCP at that URL with a bearer token; the first session that needs the server starts it, and it is stopped a grace period after the last session leaves.

- **Why shared HTTP.** Per-session stdio (v0.13.0–) existed for one reason: Cowork's remote sandbox cannot reach a loopback port on your Mac. With Cowork out of scope that constraint is gone, and the shared server is the better answer on every axis that remains — **one embedding model resident instead of N** (a few hundred MB each), one **single-owner `IndexWriter`** thread serializing every write instead of N indexers racing one SQLite WAL, and **one process for the git sync loop**, which matters because the server's write-quiescing locks are `threading` locks and are therefore only correct with a single writer.
- **Lifetime — up on demand, down when idle.** `memory-server-up.sh` (SessionStart) probes, and on a miss wins an atomic `mkdir` lock and reparents `memory-server-spawn.sh` out of the hook's process group via `perl-setsid`, so the slow work (venv install, embedding build) runs off the hook's critical path. It also **registers a session ref**. `memory-server-release.sh` (SessionEnd) drops the ref and, when it was the last one, reparents `memory-server-idle-stop.sh`. See [Server lifetime](#server-lifetime) below.
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

1. **Use a private repository.** The vault holds identity, profile, and operational memory.
2. **Put the token in `~/.claude/settings.json` `.env`**, beside `WORKBENCH_MEMORY_TOKEN`. The env override is read first for exactly this reason; `config.json` is plain-text plugin data and the worse place for a credential.
3. **`.gitignore` the raw transcripts.** `sessions/**/*.log.md` are excluded from indexing and reaped at 7 days — committing them and then committing their deletion a week later is pure churn.
4. **The pull interval is 120s, not the server's own 600s default.** This is interactive shared memory between two machines the same person is using; ten minutes of staleness is long enough to re-derive a decision the other machine already recorded.

The default pull interval is deliberately tighter than upstream's, and `git_lfs` is deliberately inverted — it defaults on upstream and earns nothing on small markdown files while requiring the filter on both machines before a clone works.

#### Canonical store & routing

The vault is the **canonical durable memory store**. Claude Code's harness also injects per-project memory instructions every session (save to `~/.claude/projects/<encoded-cwd>/memory/` + a `MEMORY.md` index) — left alone, sessions scatter memory files there that the vault can't search. The session warmup neutralizes that channel into a router: it injects a `## Memory routing` rule at every session start (saves go to the vault via the memory MCP `write` tool with vault frontmatter; recall is vault hybrid `search`, not directory reads), and on startup it writes a self-healing router stub to the current project's `MEMORY.md` (canonical template: `references/memory-routing-stub.md`). A `MEMORY.md` without the router marker is never overwritten — the warmup flags it for human migration instead. Keep the store singular: don't install competing memory MCP servers alongside the vault.

#### Wiki layer and vault index

Session summaries are chronological sediment; left alone they accumulate as unlinked orphans. Every ingest path (the summary-writer agent, `/workbench:log-now`, `/workbench:summarize-session`) therefore follows `references/linking-synthesis.md`: search the vault for related decisions, topics, and prior summaries; add a `## Related` section of root-absolute markdown links (`[display text](/folder/file-stem.md)` — the form markdown-vault-mcp resolves immediately); maintain at most one topical synthesis page in `topics/` per session; and cross-link promoted decisions to their summaries and topics. Linking is deliberately conservative — only high-confidence connections, capped per ingest, because an orphan beats a forced link.

`README.md` at the vault root is the catalog of the curated layer — one markdown link + one-line hook per topic, decision, identity, and reference document (never sessions). It's the orientation entry point: agents read it **on demand** to get the lay of the vault before searching — it is **not** auto-loaded into context. The summary writers keep it current as they create topics and promote decisions; the lint ritual repairs drift.

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
| Decisions, identity, projects | Forever | Core operational memory |

## Skills

| Skill | Description |
|-------|-------------|
| `/workbench:setup` | Configure agent name, paths, summary model, identity files |
| `/workbench:define-soul` | Interactive onboarding/refinement for agent identity (soul-hot, soul-core) |
| `/workbench-core:install` | Install the shipped persona — soul files + output style + `outputStyle` setting — into your live locations; non-destructive |
| `/workbench:define-profile` | Interactive interview to build/refine the user's profile.md (role, working style, stack, privacy, session quality) |
| `/workbench:log-now` | Dump the current session log and write a narrative summary inline |
| `/workbench:summarize-session` | Manually summarize a specific session (or pick from unsummarized) |
| `/workbench:process-pending-summaries` | Dispatch background agents to clear pending summary markers |
| `/workbench:compact-learnings` | Review and compact accumulated skill learnings; integrate into SKILL.md for workbench skills |
| `/workbench-core:evaluate-decisions` | Grade recorded decisions & memories for decision quality (correctness, accuracy/efficiency/speed, consistency/recurrence, gaps) → learnings report. Decision-quality loop, gear 2 |
| `/workbench-core:propose-upgrades` | Turn an evaluation into concrete corrections & new process recordings, walk human sign-off, apply only what's approved. Decision-quality loop, gears 3+4 |
| `/workbench-core:memory-lint` | Monthly health-and-repair pass over the memory vault — frontmatter rescue, broken-link repair, conservative orphan linking, vault-index drift repair, duplicate flagging, audit report |
| `/workbench-core:memory-status` | Report the shared memory server's facts — vault/cache, server-binary presence, index & last-VACUUM |
| `/workbench-core:install-chat-skills` | Discover skills in `@claude-workbench` plugins and install them into the Claude Mac app's Chat surface via `.skill` packaging |

All skills are **execution-aware** — they check for a `skills/{name}.learnings.md` file in the vault before running and apply any accumulated learnings from prior executions.

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
| `WORKBENCH_MEMORY_RECALL` | Set to `0` to disable proactive vault recall (`memory-recall.sh`) |
| `WORKBENCH_MEMORY_RECALL_LIMIT` | Max memories the recall hook injects per turn (default `2`) |
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

## Known limitations

- **Restart after plugin update.** `CLAUDE_PLUGIN_ROOT` is resolved once at session startup. After updating, restart Claude Code to pick up changes.
- **Server lifetime is decoupled from session lifetime.** This is the tradeoff the shared server buys its efficiency with, and it runs the opposite way to stdio. A stdio server could not outlive or predecease its session; a shared one can. If the server dies mid-session — a crash, an OOM, a plugin update, or a laptop sleep/wake dropping the connection — that session's memory tools stay dead, because the SessionStart probe and the lazy-start supervisor only cover a *cold* start, not a mid-session death. The reaper's own exposure is bounded (see [Server lifetime](#server-lifetime)); an external restart is not.
- **Summary-writer race on rapid compactions.** If a session compacts multiple times in quick succession, multiple summary-writers may run concurrently. The last one wins (overwrites the summary), which is always the most complete — but intermediate writers do wasted work.

## Design philosophy

The plugin is **infrastructure first, persona optional**. Your agent's personality comes from the identity files *you* customize — the framework imposes none. Templates in `assets/templates/` use `{{agent_name}}` placeholders if you'd rather start from blank ones. The plugin also ships one ready-made persona under `assets/personas/<name>/` (soul files + output style) as an optional starting point: you opt in via `/workbench-core:install`, which copies it to *your* editable locations — it's never enforced, and nothing stops you from editing it into something else entirely once it's yours. The one thing that isn't optional is `references/guardrails.md` — universal quality constraints (no sycophancy, no hedging, verify before asserting), not personality.

Memory files live **outside any git repo**, at a user-configured path. Memory is personal state; the plugin is code. They are intentionally separate.
