---
description: check-a-live-source stays quiet when the task itself states the version
tags: [trigger, check-a-live-source, negative, boundary]
runs: 3
max_turns: 3
allowed_tools: [Skill, Read, Glob, Grep]
---

Here is an excerpt of our lockfile: `"zod": { "version": "3.22.4" }`. Which version of zod does this project pin? Answer only from the excerpt.
