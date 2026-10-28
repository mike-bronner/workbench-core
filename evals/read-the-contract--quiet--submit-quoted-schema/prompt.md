---
description: read-the-contract stays quiet when the contract is quoted and every value sourced
tags: [trigger, read-the-contract, negative, boundary]
runs: 3
max_turns: 3
allowed_tools: [Skill, Read, Glob, Grep]
---

Here is the schema of the form tool's `send` call, quoted from its tool list: `name` (string, required, at most 80 characters) and `email` (string, required, an email address). No other keys are allowed. The user typed both values in this message: name "Dana Reyes", email "dana@example.com". Send the call with exactly those two fields.
