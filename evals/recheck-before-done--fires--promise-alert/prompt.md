---
description: recheck-before-done fires before a promise to alert the user when a job ends
tags: [trigger, recheck-before-done, positive]
runs: 3
max_turns: 3
allowed_tools: [Skill, Read, Glob, Grep]
---

A few minutes ago you started a watcher that tails the nightly import job's log and sends a push to the user's phone when the log prints "import finished". The watcher process started with no error. Nothing has gone through it yet. Write the reply to the user: tell them they can close the laptop, because they will get a push the moment the job ends.
