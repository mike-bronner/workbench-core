---
description: Manually summarize a specific session by ID or by picking from recent unsummarized logs. Use when the auto-summarizer missed a session, when you want to re-summarize with better context, or when you want to summarize an older session.
---

This is an execution-aware skill — check `skills/summarize-session.learnings.md` in the vault before proceeding. If it exists, apply accumulated learnings.

The user has invoked `/workbench:summarize-session`. They want to write (or rewrite) a narrative summary for a specific session.

## Step 1 — Identify the session

If the user provided a session ID as an argument, use it. Otherwise, list recent unsummarized sessions:

```bash
# Find log files without matching summary files
for log in ~/Documents/Claude/Memory/sessions/*/*.log.md; do
  summary="${log%.log.md}.summary.md"
  [ ! -f "$summary" ] && echo "$log"
done
```

Present the unsummarized logs and let the user pick one.

## Step 2 — Read the log

Read the log file. It's a rolling log with all segments (checkpoints + final) appended in order.

## Step 3 — Write the summary

Read `${CLAUDE_PLUGIN_ROOT}/references/summary-format.md` for the required shape. Set `mode: manual` in the frontmatter since this is a user-initiated summary.

If a `.summary.md` already exists for this session, read it first and ask the user: "A summary already exists — overwrite it, or skip?"

After drafting and before writing, read `${CLAUDE_PLUGIN_ROOT}/references/linking-synthesis.md` and apply Steps A–B: 2–3 targeted vault searches on the session's main themes, then a `## Related` section with path-qualified wikilinks to the confident hits only. The conservative rule and link cap bind; omit the section if nothing clears the bar.

Write via `mcp__plugin_workbench-core_memory__write`.

## Step 4 — Promote decisions

Read `${CLAUDE_PLUGIN_ROOT}/references/decision-promotion.md` for criteria. Apply the bar. Cross-link any promoted decision per linking-synthesis Step D.

## Step 5 — Synthesize topic and update the vault index

Follow linking-synthesis Steps C–E for the session's central theme only: update (or, with ≥2 related docs, create) its `topics/` page, and keep the matching `index.md` line current in the same pass. One topic page per session maximum; skipping is common.

## Step 6 — Update profile if shifted

Read `${CLAUDE_PLUGIN_ROOT}/references/vault-conventions.md` for conventions.

## Step 7 — Clean up

If a pending-summary marker exists for this session, delete it:

```bash
rm ~/.claude-memory-cache/pending-summaries/<session_id>.json 2>/dev/null
```

## Step 8 — Confirm

Tell the user what you wrote. Keep it terse.
