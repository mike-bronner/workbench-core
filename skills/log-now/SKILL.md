---
description: Log the current session segment right now — dump the raw log and write the narrative summary + any decision promotions inline. Use this when you want to snapshot mid-conversation, or when you want a richer summary than the auto-generated one.
---

This is an execution-aware skill — check `skills/log-now.learnings.md` in the vault before proceeding. If it exists, apply accumulated learnings.

The user has invoked `/log-now`. Log the current session segment immediately and write the narrative pieces inline.

Unlike the hook-driven logs — which can only do the mechanical half because hooks can't reach MCPs — `/log-now` runs in an active model turn. You do both halves: run the shell script, then write the narrative.

## Step 1 — Dump the raw log

Run the session-log shell script in manual mode:

```bash
TRANSCRIPT="$(find ~/.claude/projects -name '*.jsonl' -print0 2>/dev/null | xargs -0 ls -t 2>/dev/null | head -1)"
SESSION_ID="$(basename "$TRANSCRIPT" .jsonl)"
WORKBENCH_LOG_MODE=manual bash "${CLAUDE_PLUGIN_ROOT}/hooks/session-log.sh" <<EOF
{
  "session_id": "$SESSION_ID",
  "transcript_path": "$TRANSCRIPT",
  "hook_event_name": "ManualLogNow"
}
EOF
```

If the heuristic fails, ask the user for the transcript path.

After the script runs, read `~/.claude-memory-cache/pending-summaries/<session_id>.json` to find the log path.

## Step 2 — Write the narrative summary

Read the raw log. Based on the log contents AND your own lived memory of this session, write the summary.

Read `${CLAUDE_PLUGIN_ROOT}/references/summary-format.md` for the required shape. Set `mode: manual`. Write via `mcp__plugin_workbench-core_memory__write`.

Because you're in-session, your summary should be richer than what the auto summary-writer produces — you have context the raw JSONL doesn't capture.

After drafting and before writing, read `${CLAUDE_PLUGIN_ROOT}/references/linking-synthesis.md` and apply Steps A–B: 2–3 targeted vault searches on the session's main themes, then a `## Related` section with root-absolute markdown links to the confident hits only. Your lived context makes you better at judging relatedness than the headless writer — but the conservative rule and link cap still bind. Omit the section if nothing clears the bar.

## Step 3 — Promote decisions

Read `${CLAUDE_PLUGIN_ROOT}/references/decision-promotion.md` for criteria. Cross-link any promoted decision per linking-synthesis Step D.

## Step 4 — Synthesize topic and update the vault index

Follow linking-synthesis Steps C–E for the session's central theme only: update (or, with ≥2 related docs, create) its `topics/` page, and keep the matching `README.md` line current in the same pass. One topic page per session maximum; skipping is common.

## Step 5 — Update profile if shifted

Read `${CLAUDE_PLUGIN_ROOT}/references/vault-conventions.md` for conventions.

## Step 6 — Clean up and confirm

Delete the pending-summary marker:

```bash
rm ~/.claude-memory-cache/pending-summaries/<session_id>.json
```

Tell the user what you wrote: log path, summary path, any decisions promoted, links added, topic page touched. Keep it terse.

## Notes

- If the script no-ops (nothing new since last log), tell the user and skip.
- Don't delete the whole `pending-summaries/` directory — only your marker.
