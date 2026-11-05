---
description: recheck-before-done fires before a claim that a rebuilt service runs
tags: [trigger, recheck-before-done, positive]
runs: 3
max_turns: 3
allowed_tools: [Skill, Read, Glob, Grep]
---

The rebuilt queue service compiled cleanly a few minutes ago, and its start script printed "listening on 7400". Nothing has called it yet. Write the status line for the hand-off note: say that the service is up and works.
