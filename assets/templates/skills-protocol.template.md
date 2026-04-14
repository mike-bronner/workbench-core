---
name: "Execution-Aware Skills Protocol"
type: identity
scope: durable
date: {{date}} # set to today's date when copying
tags: [identity, skills, protocol, execution-aware]
summary: |
  Behavioral protocol for execution-aware skills. Any skill invocation gets
  automatic history awareness via vault-backed learnings files. Loaded at
  session start alongside soul-hot and profile.
---

# Execution-Aware Skills Protocol

This protocol applies to **any skill invocation** — plugin skills, built-in
skills, third-party skills. If a skill has accumulated learnings, they should
inform the next run.

## Before executing a skill

1. Check if `skills/{skill-name}.learnings.md` exists in the vault via
   `mcp__plugin_workbench-core_memory__read`.
2. If it exists, read it. Apply the accumulated learnings to this execution —
   these are corrections, preferences, and patterns from past runs.
3. If it doesn't exist, proceed normally. No overhead for skills with no history.

## After executing a skill

Only write a learning if something noteworthy happened:

- The user **corrected** your approach ("no, not like that", "stop doing X")
- Something **failed** unexpectedly and you learned why
- The user **confirmed** a non-obvious approach ("yes, exactly like that")
- A new **pattern** was established that future runs should follow

Write the learning via `mcp__plugin_workbench-core_memory__edit` (append to the
existing file) or `mcp__plugin_workbench-core_memory__write` (create if first
learning). Use this format:

```markdown
## YYYY-MM-DD — Short description
What happened and what to do differently (or the same) next time.
```

**Do NOT write learnings for:**
- Routine successful executions with no corrections
- One-off situations that won't recur
- Information already captured in decisions/ or profile.md

## Learnings file shape

```yaml
---
name: "Learnings — {skill-name}"
type: skill-learnings
scope: durable
tags: [skill, learnings, {skill-name}]
summary: |
  Accumulated execution learnings for {skill-name}.
---
```

Body: chronological entries, newest at bottom.

## Compaction threshold

When reading a learnings file before execution, count the entries (`## `
headings). If the file has **30 or more entries**, it's due for compaction.
After completing the current skill, tell the user:

> "{skill-name} has {N} learnings — above the 30-entry compaction threshold.
> Run `/workbench:compact-learnings {skill-name}` to review and compact."

Do not run compaction automatically — it requires interactive review.

## Guiding principle

Most skill runs produce zero learnings. The file grows slowly — a handful
of entries over weeks, not one per execution. If you're writing a learning
every run, the bar is too low.
