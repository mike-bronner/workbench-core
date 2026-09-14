<!-- workbench-memory-router -->
# Memory routing

Durable memory lives in the workbench memory vault (canonical store), served by the `plugin:workbench-core:memory` MCP.

- **Recall**: search the vault (`mcp__plugin_workbench-core_memory__search`) — not this directory. Omit `mode`: the `memory-search-mode` PreToolUse hook fills in `hybrid`, which finds conversational questions that keyword-only search misses. Pass `mode` explicitly only when you deliberately want a different one.
- **Recall first**: search the vault before scanning the repo for an answer, and again whenever a task turns up a topic the opening prompt never named. Automatic recall only ever sees that opening prompt, so a mid-task topic gets no memory searched against it unless you search it yourself.
- **Save**: write memories to the vault via the memory MCP `write` tool with frontmatter (`name`, `type`: decision | insight | project | feedback | reference) — not here.

This directory is a router only. Do not create memory files here.
