---
description: read-the-contract stays quiet
tags: [trigger, read-the-contract, negative]
runs: 3
max_turns: 3
allowed_tools: [Skill, Read, Glob, Grep]
---

Rename the local variable `tmp` to `buffer` in this function, and show the result:

```js
function join(parts) {
  let tmp = ""
  for (const p of parts) tmp += p
  return tmp
}
```
