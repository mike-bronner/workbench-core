---
description: Log the current session segment right now — dump the raw log and write the narrative summary + any decision promotions inline. Use this when you want to snapshot mid-conversation, or when you want a richer summary than the auto-generated one.
---

The user has invoked `/log-now`. Log the current session segment immediately and write the narrative pieces inline.

Unlike the hook-driven logs — which can only do the mechanical half because hooks can't reach MCPs — `/log-now` runs in an active model turn. You do both halves: run the shell script, then write the narrative.

## Step 1 — Dump the raw log

Run the session-log shell script in manual mode, for THIS session. Claude Code exports the session's ID to Bash as `$CLAUDE_CODE_SESSION_ID`, and the transcript is the `.jsonl` file of that name. Never pick the newest transcript instead: with sessions running in parallel, the newest one is often another session's, and its log would be summarized under this one's name.

Run it as one Bash call, because shell variables do not survive between calls:

```bash
SESSION_ID="$CLAUDE_CODE_SESSION_ID"
TRANSCRIPT="$(find ~/.claude/projects -name "$SESSION_ID.jsonl" 2>/dev/null | head -1)"
if [ -z "$SESSION_ID" ] || [ -z "$TRANSCRIPT" ]; then
  echo "NO TRANSCRIPT for session '${SESSION_ID}'"
else
  WORKBENCH_LOG_MODE=manual bash "${CLAUDE_PLUGIN_ROOT}/hooks/session-log.sh" <<EOF
{
  "session_id": "$SESSION_ID",
  "transcript_path": "$TRANSCRIPT",
  "hook_event_name": "ManualLogNow"
}
EOF
fi
```

If it prints `NO TRANSCRIPT`, stop and ask the user for the transcript path. Do not guess.

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

## Step 5 — Clean up and confirm

Delete the pending-summary marker:

```bash
rm -f /Users/<you>/.claude-memory-cache/pending-summaries/<session_id>.json
```

Spell the absolute path out, home directory included. The destructive-scope guard refuses `~` and `$variables` as a delete target, because it cannot tell which file they name, and permits a literal marker path.

Tell the user what you wrote: log path, summary path, any decisions promoted, links added, topic page touched. Keep it terse.

## Notes

- If the script no-ops (nothing new since last log), tell the user and skip.
- Don't delete the whole `pending-summaries/` directory — only your marker.
