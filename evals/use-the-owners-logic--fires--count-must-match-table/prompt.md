---
description: use-the-owners-logic fires
tags: [trigger, use-the-owners-logic, positive]
runs: 3
max_turns: 3
allowed_tools: [Skill, Read, Glob, Grep]
---

A support desk exported its data to us. The export ships this function, which its dashboard table uses:

```ts
export const causeOf = (t: { days: number; tag: string }) => (t.days <= 1 ? "parser" : t.tag)
```

and these tickets: `[{"days":1,"tag":"network"},{"days":4,"tag":"parser"},{"days":3,"tag":"network"}]`. Tell me how many tickets fall under each cause. The numbers must match the desk's own table.
