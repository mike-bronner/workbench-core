---
description: recheck-before-done stays quiet when the task writes alerting code or explains a watcher
tags: [trigger, recheck-before-done, negative]
runs: 3
max_turns: 3
allowed_tools: [Skill, Read, Glob, Grep]
---

Write a short Python function, `notify_on_finish(log_path, send)`, that reads a log file line by line and calls `send("job finished")` when a line contains "job finished". Then explain in two or three sentences how a file watcher such as `tail -f` sees new lines as they are written. Show the code in your reply. Do not change any files.
