---
description: Configure the workbench — agent name, memory paths, MCP server name, and identity file paths. Writes config to the plugin data directory; re-run after a plugin update to restore your settings.
---

The user has invoked `/workbench:customize`. Walk them through configuring all workbench settings interactively.

## Config location

The config file lives at:

```
~/.claude/plugins/data/workbench-claude-workbench/config.json
```

This is the plugin system's persistent data directory — it survives plugin version bumps.

## Fields

Present each field to the user one at a time. Show the current value (from existing config, or the hardcoded default if no config exists). Accept their input or let them press Enter to keep the current value.

### 1. `agent_name`
- **Prompt:** "Agent name — the persona name used in identity files, templates, and the MCP server name"
- **Default:** `Hobbes`
- **Note:** Changing this triggers re-templatization of identity files (Step 3 below).

### 2. `memory_path`
- **Prompt:** "Memory store path — where your operational memory vault lives on disk"
- **Default:** `~/Documents/Claude/Memory`
- **Validation:** Path must exist or the user must confirm creation.

### 3. `memory_cache`
- **Prompt:** "Memory cache path — index, embeddings, state, and checkpoint files"
- **Default:** `~/.claude-memory-cache`
- **Validation:** Path must exist or the user must confirm creation.

### 4. `memory_mcp_server_name`
- **Prompt:** "MCP server friendly name — the display name for the memory vault MCP server"
- **Default:** `{agent_name}-memory` (derived from field 1)
- **Note:** This is the `MARKDOWN_VAULT_MCP_SERVER_NAME` value.

### 5. `summary_model`
- **Prompt:** "Model for background summary-writer agent"
- **Default:** `haiku`
- **Note:** The model used when the detached summary-writer processes session logs. Haiku is fast and cheap; use a larger model if summaries need more nuance.

### 6. `auto_summarize`
- **Prompt:** "Auto-summarize sessions on end?"
- **Default:** `true`
- **Note:** When true, spawns a background summary-writer on every log write (PreCompact, SessionEnd, /log-now).

### 7. `identity_files`
- **Prompt:** "Identity file paths (relative to memory store)"
- **Sub-fields:**
  - `soul_hot` — default `identity/soul-hot.md`
  - `soul_core` — default `identity/soul-core.md`
  - `profile` — default `identity/profile.md`
- **Note:** These are loaded by the session-warmup hook at startup.

## Step 1 — Collect values

Read the existing config file if it exists:

```bash
CONFIG_DIR="$HOME/.claude/plugins/data/workbench-claude-workbench"
CONFIG_FILE="$CONFIG_DIR/config.json"
```

If it exists, parse current values with `jq` and use them as defaults. If not, use the hardcoded defaults listed above.

Present each field to the user using the AskUserQuestion tool. Show the current value and let them confirm or change it.

After all fields, show the assembled config JSON and ask "Save this configuration? (yes/no)".

## Step 2 — Write config and update plugin.json

1. **Write `config.json`** to the plugin data directory:

```json
{
  "agent_name": "Hobbes",
  "memory_path": "/Users/mike/Documents/Claude/Memory",
  "memory_cache": "/Users/mike/.claude-memory-cache",
  "memory_mcp_server_name": "hobbes-memory",
  "auto_summarize": true,
  "summary_model": "haiku",
  "identity_files": {
    "soul_hot": "identity/soul-hot.md",
    "soul_core": "identity/soul-core.md",
    "profile": "identity/profile.md"
  }
}
```

2. **Update `plugin.json`** MCP server env vars to match. The fields that feed into `plugin.json` are:

| Config field | plugin.json env var |
|---|---|
| `memory_path` | `MARKDOWN_VAULT_MCP_SOURCE_DIR` |
| `memory_cache` | `MARKDOWN_VAULT_MCP_INDEX_PATH` (+ `/vault-index.sqlite`) |
| `memory_cache` | `MARKDOWN_VAULT_MCP_EMBEDDINGS_PATH` (+ `/embeddings`) |
| `memory_cache` | `MARKDOWN_VAULT_MCP_STATE_PATH` (+ `/state.json`) |
| `memory_mcp_server_name` | `MARKDOWN_VAULT_MCP_SERVER_NAME` |

Read `plugin.json`, update the env values, write it back.

3. **Write `config.example.json`** alongside `config.json` with the same structure but placeholder values and inline comments explaining each field. This serves as documentation for anyone setting up the plugin manually.

## Step 3 — Re-templatize identity files (if `agent_name` changed)

If `agent_name` changed from its previous value (or this is a first-time setup):

1. Read the template files from `${CLAUDE_PLUGIN_ROOT}/assets/templates/`:
   - `soul-hot.md.template`
   - `soul-core.md.template`
   - `profile.md.template`

2. Replace all `{{agent_name}}` placeholders with the new agent name.

3. **If identity files already exist at the target paths:**
   - Read the existing files.
   - Show the user a diff of what would change (template defaults vs their customized content).
   - Ask: "Overwrite with re-templatized version, or keep your current files?"
   - If they choose to keep, skip the overwrite but update any `{{agent_name}}` references in the existing content (find-and-replace the OLD agent name with the NEW one, preserving all other customizations).

4. **If identity files don't exist:**
   - Write the templatized versions to `{memory_path}/{identity_files.soul_hot}`, etc.
   - Create parent directories as needed.

5. Update the `memory_mcp_server_name` to reflect the new agent name if the user chose the default derivation (`{agent_name}-memory`).

## Step 4 — Confirm

Tell the user:
- Config saved to `{CONFIG_FILE}`
- plugin.json updated (MCP env vars reflect new paths)
- Whether identity files were created/updated
- **Remind them:** "Restart Claude Code for the MCP server changes to take effect."

## Notes

- **Re-running after a plugin update:** When the plugin updates, `plugin.json` resets to the version from the marketplace. Re-running `/workbench:customize` reads the saved `config.json` and re-applies the values to the fresh `plugin.json`. The config file is the durable source of truth.
- **Env var overrides still work:** `WORKBENCH_MEMORY_PATH`, `WORKBENCH_MEMORY_CACHE`, and `WORKBENCH_LOG_MODE` override config.json values in the hook scripts. This is useful for testing (e.g., dry-run with temp paths).
- **First-time setup:** If this is the first run and no config exists, all fields start at their hardcoded defaults. The user confirms or changes each one.
