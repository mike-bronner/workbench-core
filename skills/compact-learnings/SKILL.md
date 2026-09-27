---
description: Review and compact accumulated skill learnings. For workbench plugin skills, optionally integrate proven learnings into the SKILL.md itself. Triggered when a learnings file exceeds 30 entries, or run manually any time.
---

This is an execution-aware skill — check `skills/compact-learnings.learnings.md` in the vault before proceeding. If it exists, apply accumulated learnings.

The user has invoked `/workbench-core:compact-learnings`, or the skills protocol flagged a learnings file above the 30-entry threshold.

## Step 1 — Identify targets

If the user provided a skill name as an argument, target only `skills/{name}.learnings.md`.

Otherwise, scan all learnings files (default path shown — resolve via config):

```bash
find ~/Documents/Claude/Memory/skills -name "*.learnings.md" 2>/dev/null
```

For threshold-triggered runs, process only the file that triggered it.

## Step 2 — For each learnings file

Read the file. Count entries (`## ` headings = entries).

If under 30 entries and this is an unprompted manual run (no specific skill), ask: "Only {N} entries — compact anyway?"

### Classify the skill

Determine whether this is a **workbench plugin skill** — one shipped by an installed `@claude-workbench` plugin. The script reads the plugin registry, `~/.claude/plugins/installed_plugins.json`, and checks each workbench plugin's `installPath` for the skill:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/find-workbench-skill.sh" {skill-name}
```

- **Exit 0** → a **workbench plugin skill**. Each output line is `plugin`, `repository`, and the installed `SKILL.md` path, tab-separated. Use hybrid mode: compact, plus offer integration into the plugin's source.
- **Exit 1** → **any other skill**. Compact only: rewrite the learnings, and do not touch any SKILL.md.
- **Exit 2** → the registry could not be read. Stop and report the script's message. Never fall back to "other": a classifier that silently answers "other" is what kept every workbench skill out of the integrate path.

### Walk through the entries

Decide a recommendation for every entry first, with a one-line reason. Then ask the user through **`AskUserQuestion`**, one question per entry, batched up to 4 per call (the tool's maximum). Put the recommended option first and mark it `(Recommended)`. Never walk the entries one message at a time: each round trip spends the user's attention, which is the scarce resource here.

**For workbench plugin skills:**

| Option | Meaning |
|--------|---------|
| **Integrate** | Bake into SKILL.md — improves the skill definition permanently |
| **Keep** | Retain in compacted learnings — relevant but too environment-specific for the definition |
| **Drop** | Stale, contradicted, or no longer relevant — remove |

**For all other skills:**

| Option | Meaning |
|--------|---------|
| **Keep** | Retain in compacted learnings |
| **Rewrite** | Valid learning but poorly worded — rewrite concisely |
| **Drop** | Remove |

## Step 3 — Apply changes

### Compact the learnings file

Rewrite with only kept/rewritten entries. Maintain chronological order. Write via `mcp__plugin_workbench-core_memory__write` (full overwrite).

If all entries were dropped or integrated, write a minimal file with just frontmatter and no entries.

**Integrated entries leave the learnings file only once the integration is handed off.** If the hand-off below does not happen, keep them in the file, so no learning is lost between the two.

### Integrate into SKILL.md (workbench plugin skills only)

**Never write the installed copy under `~/.claude/plugins/cache`, and never copy a file into the source repository yourself.** A plugin update overwrites the installed copy. A change copied into the repository skips the development flow, its tests, and the commit gate. Integration is development work on the plugin, so it goes to Dr. Watson.

For entries marked "Integrate":

1. Read the installed SKILL.md that Step 2 found, to see the skill's current structure.
2. Decide where each learning fits: an existing step, a caveat, or a note. If several learnings point at the same issue, consolidate them into one change.
3. Find the local clone of the plugin's source repository, the `repository` column from Step 2. If the session cannot tell where it is, ask the user through `AskUserQuestion`. Never guess a path.
4. Dispatch Dr. Watson in Direct mode through `/workbench-dev-team:orchestrate`, with a five-slot brief. `Workdir:` is the clone. `Goal:` is the skill behaving as the learnings describe. `Context:` quotes each integrated learning verbatim and says why it earned integration. `Done when:` is the SKILL.md carrying the guidance, woven into its existing structure, with the tree left uncommitted for the user to review.
5. If `workbench-dev-team` is not installed, do not integrate. Report each proposed change, with the file it belongs in, and keep those entries in the learnings file.

The guidance has to read as if it was always part of the skill. Say so in the brief: no appended "learnings" section.

## Step 4 — Report

```
compact-learnings: {skill-name}
  entries: {total} → integrated: {n}, kept: {n}, dropped: {n}
  SKILL.md: {handed to Watson|unchanged}
```

## Notes

- Skip files with zero entries silently.
- The 30-entry threshold is a guideline — the user can force a run at any count.
- **Multiple files due:** If scanning all learnings and more than one file is above threshold, present a summary table first (skill name, entry count, workbench or not) and let the user pick which to process this run. Don't force a 150-decision marathon.
- Preserve the SKILL.md's voice and structure when integrating.
