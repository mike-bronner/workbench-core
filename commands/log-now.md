---
description: Wrap the current session segment right now — dump the raw log and write the narrative summary + Apple Notes journal line + any decision promotions inline.
---

The user has invoked `/log-now`. Wrap the current session segment immediately.

Unlike the hook-driven `PreCompact` / `SessionEnd` wraps — which can only do the mechanical half because hooks can't reach MCPs — `/log-now` runs in an active model turn. That means you do both halves yourself: run the shell script to dump the raw log, then write the narrative pieces using the MCPs that are reachable right now.

## Step 1 — Dump the raw log

Run the `session-wrap` shell script in manual mode. You'll need the current session's transcript path and session ID; the hook infrastructure that populates `transcript_path` is not available here, so discover the current session from the filesystem instead.

```bash
HOBBES_WRAP_MODE=manual bash "${CLAUDE_PLUGIN_ROOT}/skills/meta/session-wrap/run.sh" <<EOF
{
  "session_id": "$(ls -t ~/.claude/projects/*/$(ls -t ~/.claude/projects/ | head -1)/*.jsonl 2>/dev/null | head -1 | xargs -I{} basename {} .jsonl)",
  "transcript_path": "$(find ~/.claude/projects -name '*.jsonl' -print0 2>/dev/null | xargs -0 ls -t 2>/dev/null | head -1)",
  "hook_event_name": "ManualLogNow"
}
EOF
```

If that heuristic for finding the transcript is wrong in practice (the directory layout changes, the file isn't the newest for legitimate reasons, etc.), fall back to asking the user for the transcript path and running the script with that payload.

After the script runs, read `~/.claude-memory-cache/pending-wraps/<session_id>.json` to find the path of the log file that was just written.

## Step 2 — Write the narrative summary

Read the raw log file (and any earlier checkpoint logs from the same `session_id` in the same `sessions/YYYY-MM-DD/` directory — a summary should cover all the logs it's based on). Based on the log contents and your own memory of the current session, write a sibling `.summary.md` file in the same directory. Use the `hobbes-memory` MCP to write it so the vault index picks it up.

**Only summaries are indexed.** Raw `.log.md` files are excluded from the vault search index via `MARKDOWN_VAULT_MCP_EXCLUDE=**/*.log.md`. That means when anyone searches memory for "what did we decide about X," they'll land on a summary and follow the `log_files` pointer (or the inline Logs section) to pull the full context from the raw log if needed.

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
  - /absolute/path/to/first.log.md
  - /absolute/path/to/second.log.md  # if multiple checkpoints fed this summary
summary: |
  One or two sentences that answer "what happened in this segment"
  without opening the body.
---
```

Body structure (tight, not exhaustive):

- **What happened** — 2–5 bullets, focused on outcomes not steps
- **What got decided** — explicit decisions with rationale (anything new since the last wrap)
- **What's still open** — loose ends, next steps, deferred items
- **Logs** — explicit list of the raw `.log.md` files this summary covers (same content as the `log_files` frontmatter, but inline for anyone reading the body)

## Step 3 — Append a BuJo line to today's Apple Notes daily journal

Find today's daily journal note (title format `YYYY-MM-DD — Weekday`, e.g. `2026-04-09 — Thursday`). Append a single BuJo line in Menlo-Regular monospace, per `~/.claude/CLAUDE.md`:

```html
<div><tt><font face="Menlo-Regular">— {short phrase}. See {log-path}</font></tt></div>
```

Use the right BuJo signifier:
- `—` note (default for wrap summaries)
- `×` task completed
- `*` priority / noteworthy
- `!` inspiration / insight

Include a relative pointer to the log file so Mike can open the full detail from the journal if he wants.

**Critical — the Apple Notes MCP has no partial-edit mode.** `mcp__Read_and_Write_Apple_Notes__update_note_content` replaces the ENTIRE note body on every invocation, regardless of parameters. `mode: "append"`, `mode: "replace"`, AND `find_text` + `new_content` all do full-body replacement. To safely add your BuJo line:

1. Call `get_note_content(note_name)` and save the full body in your context
2. Splice your new `<div>...</div>` line in at the end of the body in-memory
3. Call `update_note_content` with the **complete new body** as `new_content`

Never skip the read step. A forgotten read destroys the note and the loss is unrecoverable without a prior snapshot.

## Step 4 — Promote new decisions

If the segment contained a genuine architectural / tool / process decision — something you'd want to find again via search — write it to `~/Documents/Claude/Memory/decisions/YYYY-MM-DD-slug.md` via the `hobbes-memory` MCP. Use the decision file shape (`type: decision`, `scope: topical`, rationale + ruled-out alternatives in the body).

Do NOT promote every small choice. The bar: would this surface as a useful answer to "what did we decide about X?" six months from now? If yes, promote. If no, the log and summary are enough.

## Step 5 — Update profile if preferences shifted

If the segment revealed a new preference or working-style change for Mike, edit `~/Documents/Claude/Memory/identity/profile.md` to reflect it. Small delta, don't rewrite the file.

## Step 6 — Confirm to Mike

Tell Mike what you wrote: the log path, the summary path, the BuJo line you appended, and any decisions you promoted. Keep it terse — one short block, not a recap.

## Notes

- If the script no-ops (nothing new since the last wrap), tell Mike that and skip the rest. Don't invent content.
- The pending-wrap marker is only written in `manual` mode as a safety net — since you do the narrative half inline, you should delete it at the end: `rm ~/.claude-memory-cache/pending-wraps/<session_id>.json`. That prevents the next session's warmup from treating this wrap as "pending". (The marker lives in a per-session file under `pending-wraps/` — don't delete the whole directory, only your own marker.)
