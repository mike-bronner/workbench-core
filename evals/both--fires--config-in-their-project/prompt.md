---
description: read-the-contract and use-the-owners-logic both fire on a config file added to someone else's project
tags: [trigger, read-the-contract, use-the-owners-logic, positive, shared]
runs: 3
max_turns: 3
allowed_tools: [Skill, Read, Glob, Grep]
---

A client exported their web project to us. It builds with their own toolchain, and its package.json lists `"eslint": "9.4.0"`. Add an ESLint config file to their project that turns on strict rules, so their build lints with it.
