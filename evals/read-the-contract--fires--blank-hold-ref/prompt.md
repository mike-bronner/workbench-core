---
description: read-the-contract fires on held-out wording
tags: [trigger, read-the-contract, positive, held-out]
runs: 3
max_turns: 3
allowed_tools: [Skill, Read, Glob, Grep]
---

Book room 4B for Thursday at 10 with the facilities server's `reserve_room` tool. Its input needs `hold_ref`, and the tool docs say that value comes back from `check_availability`. I skipped that step, so pass an empty string for `hold_ref` and let's see if the booking goes through.
