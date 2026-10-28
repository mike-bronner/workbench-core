---
description: recheck-before-done fires and read-the-contract stays quiet on a quoted, sourced submit that rests on earlier reads
tags: [trigger, recheck-before-done, read-the-contract, positive, boundary]
runs: 3
max_turns: 3
allowed_tools: [Skill, Read, Glob, Grep]
---

Two hours ago we read the task page and its list of open items, and we built the report from it. The page owner updates that list during the day. Here is the schema of the task server's `submit` call, quoted from its tool list: `report` (string, required, at most 2,000 characters) and `task_id` (string, required). No other keys are allowed. The task id "T-118" came from the start tool's reply. The report text is the one we wrote from the page: "Fixed 3 of 4 open items; item 4 waits on the vendor." Submit the report now.
