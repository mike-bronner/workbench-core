# Contributing to the session warmup

**Audience:** authors of `workbench-*` plugins.

**Rule:** if your plugin needs something in the agent's context at session start,
ship a `session-warmup.md` at your plugin root. Do **not** register your own
`SessionStart` or `PostCompact` hook.

The aggregation mechanism already exists —
`workbench-core/hooks/session-warmup.sh:collect_session_warmup_contributions()`
concatenates a `session-warmup.md` from every installed `workbench-*` plugin
automatically. This document makes it the sanctioned convention.

---

## Why not your own hook

A plugin that registers its own `SessionStart` hook gets three problems, all of
which have already happened at least once:

1. **It misses shared fixes.** Core's warmup grew a skip guard for `--agent`
   sub-agent dispatches (`CLAUDE_CODE_AGENT`) in commit `0570c33`. A plugin with
   its own hand-rolled hook never received it, and kept injecting its routing
   block into every Watson / Holmes / Lestrade dispatch.
2. **It breaks cache-prefix stability.** See [Ordering](#ordering-the-append-only-invariant).
   Core can only guarantee the invariant for text it controls.
3. **Ordering is undefined.** Independent hooks on the same event have no
   guaranteed order relative to core's identity payload, so your block may land
   before core's payload.

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
collect_session_warmup_contributions()   ← concatenated, blank-line separated
    │
    ▼
~/.claude/CLAUDE.md, inside <!-- workbench-warmup:start --> … :end -->
```

Mechanics worth knowing:

- **Discovery** is from `installed_plugins.json`, so the file is read from the
  *active cached version* of your plugin — not a checkout. Test by installing.
- **Placement** is after core's identity block and before any user content in
  `~/.claude/CLAUDE.md`.
- **Uninstall is self-healing.** The whole marked region is rebuilt every
  startup, so removing your plugin removes your contribution. Never edit the
  region by hand.
- **Missing or unreadable file = skipped**, silently. There is no error path,
  and no need for a guard.
- **`jq` is required.** Without it the whole collection step no-ops.

---

## Ordering: the append-only invariant

This is the part that bites.

Anthropic prompt caching matches on an **exact request prefix**. One byte that
differs between two otherwise identical sessions invalidates the cache for
everything after it — the identity payload, every other plugin's contribution,
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
| Core's managed `~/.claude/CLAUDE.md` block (gates and scratch roots) | ~1.6 KB |
| Core's full startup payload (routing + pointers, no soul or profile) | ~3.8 KB |
| A real observed Dispatch tick's total SessionStart hook output | ~20.9 KB |
| The 2026-07-08 bloat incident | **57 KB** |

The first two are measured, not estimated: 1,625 and 3,804 bytes on
2026-09-27, the day core stopped injecting a guardrails payload (4,776 bytes on
its own). Re-measure rather than re-estimate: run `hooks/session-warmup.sh`
against a sandbox `HOME` with no soul file, no profile, and a healthy memory
probe, then `wc -c` its stdout and the managed block it writes.

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
      `<!-- workbench-warmup:start -->` region of `~/.claude/CLAUDE.md`.
