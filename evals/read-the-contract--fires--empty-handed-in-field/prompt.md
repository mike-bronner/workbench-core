---
description: read-the-contract fires
tags: [trigger, read-the-contract, positive]
runs: 3
max_turns: 3
allowed_tools: [Skill, Read, Glob, Grep]
---

Submit my finished task with the task server's claim tool. Its schema marks `receipts` as required, described as "the receipts you were handed when the task started". We never got any, so send `receipts: {}` with the task id and see what it says.
