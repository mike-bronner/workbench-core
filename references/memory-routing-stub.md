<!-- workbench-memory-router -->
# Memory routing

Durable memory lives in the workbench memory vault (canonical store), served by the `plugin:workbench-core:memory` MCP.

- **Recall**: search the vault (`mcp__plugin_workbench-core_memory__search`) — not this directory. Omit `mode`: the server picks hybrid when the vault has embeddings and keyword when it does not. Pass `mode` explicitly only when you deliberately want a different one, such as `keyword` for an exact term or a filename.
- **Recall first**: search the vault before scanning the repo for an answer, and again whenever a task turns up a topic no prompt named. Automatic recall searches only the main session's prompts and the patterns of file searches, so a topic that reaches you any other way gets no memory searched against it unless you search it yourself.
- **Query the task, not the prompt**: build the search from what you are about to produce or decide (the convention, the format, the procedure, the tool, the error), in the words a note about it would use. Automatic recall can only ever run wording that was already typed, so your advantage over it is asking the better question; a recorded rule filed under another phrase never arrives on its own.
- **Save**: write memories to the vault via the memory MCP `write` tool with frontmatter (`name`, `type`: decision | insight | project | feedback | reference) — not here.

This directory is a router only. Do not create memory files here.
