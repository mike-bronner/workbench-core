---
description: use-the-owners-logic fires
tags: [trigger, use-the-owners-logic, positive]
runs: 3
max_turns: 3
allowed_tools: [Skill, Read, Glob, Grep]
---

The analytics team ships this SQL view, and their weekly report reads it:

```sql
CREATE VIEW weekly_active AS SELECT count(DISTINCT user_id) AS n FROM events WHERE kind <> 'bot' AND at > now() - interval '7 days';
```

Here are this week's events: `[{"user_id":1,"kind":"view"},{"user_id":2,"kind":"bot"},{"user_id":1,"kind":"edit"},{"user_id":3,"kind":"view"}]`. Give me this week's active-user count for the team update.
