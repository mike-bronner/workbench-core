---
description: read-the-contract and recheck-before-done both fire on an outward claim
tags: [trigger, read-the-contract, recheck-before-done, positive, shared]
runs: 3
max_turns: 3
allowed_tools: [Skill, Read, Glob, Grep]
---

An hour ago we read the task page and its list of open issues, and we built the fix from it. Now claim the task with the task server's claim tool. Its `receipts` field is described as "the receipts you were handed when the task started", and we have none, so send `{}`.
