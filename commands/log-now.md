---
description: Log the current session segment right now — dump the raw log and write the narrative summary + any decision promotions inline.
---

The user has invoked `/log-now`. Log the current session segment immediately and write the narrative pieces inline.

Unlike the hook-driven `PreCompact` / `SessionEnd` logs — which can only do the mechanical half because hooks can't reach MCPs — `/log-now` runs in an active model turn. That means you do both halves yourself: run the shell script to dump the raw log, then write the narrative pieces using the MCPs that are reachable right now.

## Step 1 — Dump the raw log

Run the `session-log` shell script in manual mode. You'll need the current session's transcript path and session ID; the hook infrastructure that populates `transcript_path` is not available here, so discover the current session from the filesystem instead.

```bash
WORKBENCH_LOG_MODE=manual bash "${CLAUDE_PLUGIN_ROOT}/skills/meta/session-log/run.sh" <<EOF
{
  "session_id": "$(ls -t ~/.claude/projects/*/$(ls -t ~/.claude/projects/ | head -1)/*.jsonl 2>/dev/null | head -1 | xargs -I{} basename {} .jsonl)",
  "transcript_path": "$(find ~/.claude/projects -name '*.jsonl' -print0 2>/dev/null | xargs -0 ls -t 2>/dev/null | head -1)",
  "hook_event_name": "ManualLogNow"
}
EOF
```

If that heuristic for finding the transcript is wrong in practice (the directory layout changes, the file isn't the newest for legitimate reasons, etc.), fall back to asking the user for the transcript path and running the script with that payload.

After the script runs, read `~/.claude-memory-cache/pending-summaries/<session_id>.json` to find the path of the log file that was just written.

## Step 2 — Write the narrative summary

Read the raw log file. Based on the log contents and your own memory of the current session, write a sibling `.summary.md` file in the same directory. Use `mcp__plugin_workbench_memory__write` so the vault index picks it up.

Frontmatter shape (required fields per the memory vault config: `name`, `type`):

```yaml
---
name: "Session summary — {short-description}"
type: session
scope: chronological
date: YYYY-MM-DD
tags: [session, summary, ...topic-tags]
session_id: <same as the log file>
mode: manual
log_files:
  - /absolute/path/to/session.log.md
summary: |
  One or two sentences that answer "what happened in this segment"
  without opening the body.
---
```

Body structure (tight, not exhaustive):

- **What happened** — 2–5 bullets, focused on outcomes not steps
- **What got decided** — explicit decisions with rationale (anything new since the last summary)
- **What's still open** — loose ends, next steps, deferred items
- **Logs** — explicit list of the raw `.log.md` files this summary covers

## Step 3 — Promote new decisions

If the segment contained a genuine architectural / tool / process decision — something you'd want to find again via search — write it to `~/Documents/Claude/Memory/decisions/YYYY-MM-DD-slug.md` via `mcp__plugin_workbench_memory__write`. Use the decision file shape (`type: decision`, `scope: topical`, rationale + ruled-out alternatives in the body).

Do NOT promote every small choice. The bar: would this surface as a useful answer to "what did we decide about X?" six months from now? If yes, promote. If no, the log and summary are enough.

## Step 4 — Update profile if preferences shifted

If the segment revealed a new preference or working-style change for Mike, edit `~/Documents/Claude/Memory/identity/profile.md` to reflect it. Small delta, don't rewrite the file.

## Step 5 — Confirm to Mike

Tell Mike what you wrote: the log path, the summary path, and any decisions you promoted. Keep it terse — one short block, not a recap.

## Notes

- If the script no-ops (nothing new since the last log), tell Mike that and skip the rest. Don't invent content.
- The pending-summary marker is only written in `manual` mode as a safety net — since you do the narrative half inline, you should delete it at the end: `rm ~/.claude-memory-cache/pending-summaries/<session_id>.json`. That prevents the next session's warmup from treating this summary as "pending". (The marker lives in a per-session file under `pending-summaries/` — don't delete the whole directory, only your own marker.)
