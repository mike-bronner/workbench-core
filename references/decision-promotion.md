# Decision Promotion

Reference document for any skill or agent that evaluates whether a session
produced a decision worth promoting to the vault.

## When to promote

Promote a decision when:

- A new tool, library, or framework was chosen over an alternative
- An architectural pattern was committed to
- A working-style convention was established
- An empirical discovery about system behavior was made

The bar: would this surface as a useful answer to "what did we decide about X?" six months from now? If yes, promote. If no, the log and summary are enough.

## When NOT to promote

- Routine implementation choices ("used a for loop")
- Bug fixes (the fix is in the commit)
- Iterations on an existing approach
- Anything the user didn't explicitly frame as a decision

Most sessions produce zero decisions. Skipping this step is the common case.

## Decision file template

Write to `decisions/YYYY-MM-DD-slug.md` via `mcp__plugin_workbench-core_memory__write`.

```yaml
---
name: "{decision title}"
type: decision
scope: topical
date: YYYY-MM-DD
tags: [...]
summary: |
  One sentence.
---

## Context

Why this came up.

## Decision

What was chosen, plainly stated.

## Alternatives ruled out

Options considered and why they lost.

## Consequences

What this means for future work.
```
