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

## Related

- [[sessions/YYYY-MM-DD/{session-id}.summary|Session summary]] — where this was decided
- [[topics/{topic}|{Topic title}]] — if a topic page covers this theme
```

## Cross-linking

A promoted decision is part of the vault's wiki layer, not loose sediment
(see `linking-synthesis.md` for syntax and the conservative-linking rules):

- The decision's `## Related` section wikilinks its session summary, and
  the topic page if one exists.
- The session summary's `## Related` section links the decision back.
- If a topic page for the theme is touched in the same ingest, it links
  the decision too, and the decision's `index.md` line is added or updated
  in the same pass.
