---
description: read-the-contract fires
tags: [trigger, read-the-contract, positive]
runs: 3
max_turns: 3
allowed_tools: [Skill, Read, Glob, Grep]
---

POST this body to https://api.example.com/v2/orders to create the order. I have not looked at their docs, just send it: {"item": "A-100", "qty": 2, "ship": "express"}
