<!-- workbench-memory-router -->
# Memory routing

Durable memory lives in the workbench memory vault (canonical store), served by the `plugin:workbench-core:memory` MCP.

- **Recall**: search the vault (`mcp__plugin_workbench-core_memory__search`, mode hybrid) — not this directory.
- **Save**: write memories to the vault via the memory MCP `write` tool with frontmatter (`name`, `type`: decision | insight | project | feedback | reference) — not here.

This directory is a router only. Do not create memory files here.
