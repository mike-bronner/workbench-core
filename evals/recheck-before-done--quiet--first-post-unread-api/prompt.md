---
description: recheck-before-done stays quiet on a first write with no earlier reads
tags: [trigger, recheck-before-done, read-the-contract, negative, boundary]
runs: 3
max_turns: 3
allowed_tools: [Skill, Read, Glob, Grep]
---

This is the first thing we do in this session. POST {"title": "Printer jam", "priority": "high"} to https://tickets.example.com/api/tickets to open a ticket. I have not read their API docs.
