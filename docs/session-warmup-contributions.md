# Contributing to the session warmup

**Audience:** authors of `workbench-*` plugins.

**Rule:** if your plugin needs something in the agent's context at session start,
ship a `session-warmup.md` at your plugin root. Do **not** register your own
`SessionStart` or `PostCompact` hook.

The aggregation mechanism already exists: workbench-core's hooks module
(`hooks/register.ts`, `hooks/mods/prompt-rules.ts`) concatenates a
`session-warmup.md` from every installed `workbench-*` plugin automatically, and
sends it as a system-prompt section. This document makes it the sanctioned
convention.

---

## Why not your own hook

A plugin that registers its own `SessionStart` hook gets three problems, all of
which have already happened at least once:

1. **It misses shared fixes.** Core's warmup grew a skip guard for `--agent`
   sub-agent dispatches (`CLAUDE_CODE_AGENT`) in commit `0570c33`. A plugin with
   its own hand-rolled hook never received it, and kept injecting its routing
   block into every Watson / Holmes / Lestrade dispatch. Core now also decides
   which lanes get the contributions, and gives a sub-agent its copy.
2. **It breaks cache-prefix stability.** See [Ordering](#ordering-the-append-only-invariant).
   Core can only guarantee the invariant for text it controls.
3. **Ordering is undefined.** Independent hooks on the same event have no
   guaranteed order relative to core's rules, so your block may land before
   them.

One aggregated hook fixes all three at once, for every plugin.

---

## How it works

```
~/.claude/plugins/installed_plugins.json
    │  (every entry keyed *@claude-workbench, excluding workbench-core itself)
    ▼
<installPath>/session-warmup.md          ← your file, plugin root
    │
    ▼
contributionPathsOf / contributionsOf    ← concatenated, blank-line separated
    │
    ├─▶ the `workbench-core:plugins` system-prompt section (shared scope)
    └─▶ a sub-agent's context, at SubagentStart
```

Mechanics worth knowing:

- **Discovery** is from `installed_plugins.json`, so the file is read from the
  *active cached version* of your plugin — not a checkout. Test by installing.
- **Placement** is after core's own rules and memory routing, and before every
  per-session section of the system prompt.
- **Lanes.** The main loop, `claude -p` and a top-level `--agent` run get it. A
  summary-writer does not. A sub-agent gets its parent's copy at its start.
- **It is read once per load.** Every render in a session gets the same bytes. A
  plugin update reaches the next session, or the next reload.
- **Uninstall is self-healing.** Removing your plugin removes your
  contribution from the next session on.
- **Missing or unreadable file = skipped**, silently. There is no error path,
  and no need for a guard.
- **Up to 0.44, core spliced the contributions into `~/.claude/CLAUDE.md`**,
  inside `<!-- workbench-warmup:start -->` … `:end -->`. It no longer writes
  that file. `/workbench-core:setup` takes the old region out, and until then
  the hooks module leaves it out of what the model reads.

---

## Ordering: the append-only invariant

This is the part that bites.

Anthropic prompt caching matches on an **exact request prefix**. One byte that
differs between two otherwise identical sessions invalidates the cache for
everything after it — core's rules, every other plugin's contribution,
the skill body, the tool definitions. A scheduled task firing every 20 minutes
pays that penalty on every tick. This was the confirmed root cause of a
dev-team Dispatch orchestrator whose ~36k-token context tail never cached.

**Your contribution must be byte-identical across runs.** Same install, same
config → same bytes. That means it is effectively a static document.

Concretely, **never** put any of these in `session-warmup.md`:

| Don't | Why |
|---|---|
| Counts of anything live (`3 items pending`) | Changes as the directory changes |
| Timestamps, dates, "last run 4h ago" | Changes every run |
| Wall-clock-triggered flags ("stale — over 48h") | Flips mid-day, unpredictably |
| Directory listings, file enumerations | Changes as files come and go |
| Version-drift banners, update-available notices | Flips on every upgrade |
| Anything derived from session state | Different per session by definition |

If you have volatile state that genuinely needs surfacing, keep it out of the
payload entirely. Core writes its own to `~/.claude-workbench/warmup-notices.md`,
and its hooks module shows each notice to the user in a toast, a status-line
count and the `/notices` pane (see the "Housekeeping notices" README section).
Nothing in the payload points at the file. A constant pointer line telling the
model to read it was tried first, and it cost a `Read` turn in every session for
notices that were the user's to act on, not the model's.

---

## Byte budget

Warmup output is not free, and it is charged on **every** session, on every
plugin, forever.

Reference points:

| | Size |
|---|---|
| Core's gates and scratch-roots section (`workbench-core:rules`) | ~2.5 KB |
| Core's memory-routing section (`workbench-core:memory`) | ~2.0 KB |
| Core's warmup output | 0 |
| A real observed Dispatch tick's total SessionStart hook output | ~20.9 KB |
| The 2026-07-08 bloat incident | **57 KB** |

The first two are measured, not estimated: 2,525 and 1,970 characters on
2026-10-08. Re-measure rather than re-estimate: `RULES.length` and
`MEMORY.length` in `hooks/mods/prompt-rules.ts`, and `wc -c` of the warmup's
stdout in a sandbox `HOME`, which is empty.

That 57 KB came from one block enumerating every pending-summary marker instead
of a capped summary. It overflowed the harness's inline preview window and
**buried the identity payload** — the guardrails stopped reliably reaching the
model. The fix was to cap the listing at a count plus the three oldest entries.

**Budget: keep your contribution under 2 KB.** If you need more, you are
probably shipping reference material, not warmup material — put it in a file and
contribute a one-line pointer to it instead. The warmup's job is to make the
agent *aware*; skills and references carry the detail.

---

## What belongs in `session-warmup.md`

**Good** — stable, short, orienting:

- Routing rules: "BuJo entries go to the vault under `journal/`, never the project."
- A pointer to your plugin's conventions doc.
- A standing behavioral rule specific to your domain.
- Which of your skills to reach for, and when.

**Bad** — belongs elsewhere:

- Full skill instructions → the `SKILL.md`; skills load on demand.
- Anything volatile → out of the payload, onto a surface the user reads (a file plus a status line, toast or pane), never a pointer the model must follow.
- Anything over ~2 KB → a reference file plus a pointer.
- Setup or troubleshooting prose → your README.

---

## Format

Plain markdown, no frontmatter. Start at heading level 2 — level 1 is the
warmup's own title. End with a single trailing newline; the collector inserts a
blank line between contributions.

```markdown
## BuJo routing

- Daily log entries belong in the memory vault under `journal/YYYY-MM-DD.md`.
- Never write journal entries into the current project directory.
- Run `/workbench-bujo:bujo` for the full ritual; see the skill for detail.
```

---

## Checklist

- [ ] File is at your plugin **root**, named exactly `session-warmup.md`.
- [ ] Under 2 KB.
- [ ] Byte-identical on every run — no counts, dates, flags, or listings.
- [ ] Starts at `##`, no frontmatter.
- [ ] No independent `SessionStart` / `PostCompact` hook in your `hooks.json`.
- [ ] Verified by installing the plugin and checking the
      `workbench-core:plugins` section: run `/context`, or ask a session to
      quote a line of your contribution.
