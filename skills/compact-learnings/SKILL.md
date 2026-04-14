---
description: Review and compact accumulated skill learnings. For workbench plugin skills, optionally integrate proven learnings into the SKILL.md itself. Triggered when a learnings file exceeds 30 entries, or run manually any time.
---

This is an execution-aware skill — check `skills/compact-learnings.learnings.md` in the vault before proceeding. If it exists, apply accumulated learnings.

The user has invoked `/workbench:compact-learnings`, or the skills protocol flagged a learnings file above the 30-entry threshold.

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

Determine if this is a **workbench plugin skill** by searching for a matching SKILL.md in installed plugins whose directory name includes `claude-workbench`:

```bash
find ~/.claude/plugins/installed/*claude-workbench*/skills -name "SKILL.md" -path "*/{skill-name}/*" 2>/dev/null
```

- **Workbench plugin skill** → hybrid mode (compact + offer integration into installed SKILL.md, then sync to git repo)
- **Any other skill** → compact only (rewrite learnings, don't touch SKILL.md)

### Walk through each entry

Present each learning to the user with **three options** and your recommendation.

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

For each entry, state your recommendation and a one-line rationale. Wait for the user's choice before moving on.

## Step 3 — Apply changes

### Compact the learnings file

Rewrite with only kept/rewritten entries. Maintain chronological order. Write via `mcp__plugin_workbench-core_memory__write` (full overwrite).

If all entries were dropped or integrated, write a minimal file with just frontmatter and no entries.

### Integrate into SKILL.md (workbench plugin skills only)

For entries marked "Integrate":

1. Read the current SKILL.md from the installed plugin directory found in Step 2.
2. Determine where each learning fits — it may modify an existing step, add a caveat, or add a note.
3. Present the proposed changes to the user for approval before writing.
4. Write the updated SKILL.md to the installed copy.
5. Sync to the git source repo: read the `repository` field from the plugin's `plugin.json` to identify the GitHub repo. Derive the local clone path by finding a directory whose `git remote -v` origin matches the repository URL. Copy the updated SKILL.md to the corresponding path in the source repo.

Weave integrated learnings into the existing structure. Do NOT append a "learnings" section — the guidance should read as if it was always part of the skill.

If multiple learnings point to the same issue, consolidate into a single change.

## Step 4 — Report

```
compact-learnings: {skill-name}
  entries: {total} → integrated: {n}, kept: {n}, dropped: {n}
  SKILL.md: {updated|unchanged}
```

## Notes

- Skip files with zero entries silently.
- The 30-entry threshold is a guideline — the user can force a run at any count.
- **Multiple files due:** If scanning all learnings and more than one file is above threshold, present a summary table first (skill name, entry count, workbench or not) and let the user pick which to process this run. Don't force a 150-decision marathon.
- Preserve the SKILL.md's voice and structure when integrating.
