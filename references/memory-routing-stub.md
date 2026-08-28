<!-- workbench-memory-router -->
# Memory routing

Durable memory lives in the workbench memory vault (canonical store), served by the `plugin:workbench-core:memory` MCP.

- **Recall**: search the vault (`mcp__plugin_workbench-core_memory__search`) — not this directory. Omit `mode`: the `memory-search-mode` PreToolUse hook fills in `hybrid`, which finds conversational questions that keyword-only search misses. Pass `mode` explicitly only when you deliberately want a different one.
- **Save**: write memories to the vault via the memory MCP `write` tool with frontmatter (`name`, `type`: decision | insight | project | feedback | reference) — not here.

This directory is a router only. Do not create memory files here.
