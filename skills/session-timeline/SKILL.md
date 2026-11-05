---
name: session-timeline
description: Use before you rely on what earlier agent sessions said, decided or did when their logs are on disk, such as rebuilding work from past sessions or finding which draft came last. It reads Claude Code transcripts under ~/.claude/projects, each sub-agent's own file under <session>/subagents included, and Codex rollout logs under ~/.codex/sessions, and merges them into one timeline in UTC.
---

# Session timeline

Agent sessions leave their decisions in logs, and the logs are easy to read
wrong. A sub-agent writes its own file beside the main transcript, so a reader
that opens only the main file misses its work. A Codex rollout file name holds
local time, while the records inside it hold UTC, so a file name can make an
older log look newer. This skill reads every log first and puts every record
on one clock.

## 1. Read every log on one UTC clock before you use what it says

**When:** the work rests on what earlier sessions said, decided or did, and
their logs are on disk: Claude Code transcripts (`~/.claude/projects/<project>/<session>.jsonl`,
with sub-agent files in `<session>/subagents/agent-<id>.jsonl`), Codex rollouts
(`~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl`), or a copy of either
in another folder.

**Check:**

1. List every log under the folder, with the first and last UTC time of each:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/skills/session-timeline/scripts/timeline.mjs" ~/.claude/projects --files
   ```

   Give the folder that holds the logs in place of `~/.claude/projects`, and
   give more than one folder to merge them, such as `~/.codex/sessions` too.
   Each line names the log by its tool and session id, and a sub-agent log by
   its session and its agent type.

2. Print the merged timeline into the session scratchpad, and read it there:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/skills/session-timeline/scripts/timeline.mjs" ~/.claude/projects --since 2026-03-01 --width 2000 > "<scratchpad>/timeline.txt"
   ```

   Each line is `<UTC time> <log> <role>/<kind>: <text>`. `--since` and
   `--until` take a date, or a time with `Z` or an offset. `--width` sets how
   much of each text is kept.

3. Order what you find by the UTC time on its line only. Never order by a file
   name, by the time `ls` shows or by a time written in the text, because each
   of those can be local time.

4. Read the sub-agent lines as well as the main ones. A decision made inside a
   sub-agent counts like one in the main thread.

5. When the logs can grow while you work, run step 1 again before you report,
   and read any log that is new or that ends later than before.

**Done:** your answer names every log you read, sub-agent logs included, and
each fact you use carries the UTC time and the log of the line it came from.

**Ask the user** when a time is marked `?` (it had no zone, so it was read as
UTC and may be off by hours) and the order of two records depends on it, or
when a log the work needs is not on disk. Say which log and which records.

The script reads only the paths you give it, writes nothing and uses no
network. It needs Node.js 18 or newer. The logs can hold secrets, so quote only
the lines the task needs. `--self-test` checks it with no files.
