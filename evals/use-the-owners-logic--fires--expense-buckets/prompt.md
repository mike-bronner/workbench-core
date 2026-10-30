---
description: use-the-owners-logic fires on held-out wording
tags: [trigger, use-the-owners-logic, positive, held-out]
runs: 3
max_turns: 3
allowed_tools: [Skill, Read, Glob, Grep]
---

Our finance lead sent the expense list along with the Python helper her monthly summary is generated with:

```python
def bucket(e):
    return "travel" if e["merchant"].startswith("AIR") else e["category"]
```

Expenses: `[{"merchant":"AIRLINK","category":"meals","amount":420},{"merchant":"Cafe Uno","category":"meals","amount":38},{"merchant":"Hotel Ost","category":"travel","amount":210}]`. What did we spend in each bucket? I will put your totals next to hers, so they have to agree.
