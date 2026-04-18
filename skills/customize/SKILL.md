---
description: Configure the workbench — agent name, memory paths, MCP server name, and identity file paths. Config lives in the plugin data directory and is read at MCP start time, so plugin updates never clobber settings.
---

The user has invoked `/workbench:customize`. Walk them through configuring all workbench settings interactively.

## Config location

The config file lives at:

```
~/.claude/plugins/data/workbench-core-claude-workbench/config.json
```

This is the plugin system's persistent data directory — it survives plugin version bumps. The `mcp-memory.sh` wrapper reads it at launch time and exports the corresponding env vars, so `plugin.json` never needs to be edited.

**Legacy path:** if `~/.claude/plugins/data/workbench-claude-workbench/config.json` exists (from before the `workbench` → `workbench-core` rename), migrate it to the new path — see Step 0.

## Fields

Present each field to the user one at a time. Show the current value (from existing config, or the hardcoded default if no config exists). Accept their input or let them press Enter to keep the current value.

### 1. `agent_name`
- **Prompt:** "Agent name — the persona name used in identity files, templates, and the MCP server name"
- **Default:** `Claude`
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
- **Note:** These are loaded by the session-warmup hook at startup. Load order: soul-hot → profile → skills-protocol → guardrails. Guardrails ship with the plugin (not user-configurable) and load last as absolute rules that override all other identity files.

## Step 0 — Migrate legacy config (if present)

Before reading or writing anything, migrate the pre-rename data directory:

```bash
NEW_DIR="$HOME/.claude/plugins/data/workbench-core-claude-workbench"
OLD_DIR="$HOME/.claude/plugins/data/workbench-claude-workbench"

if [ -d "$OLD_DIR" ] && [ ! -d "$NEW_DIR" ]; then
  mv "$OLD_DIR" "$NEW_DIR"
elif [ -d "$OLD_DIR" ] && [ -d "$NEW_DIR" ]; then
  # Both exist — new wins. Archive the old dir so we don't look at it again.
  mv "$OLD_DIR" "${OLD_DIR}.legacy-$(date +%Y%m%d)"
fi
```

Tell the user if a migration happened.

## Step 1 — Collect values

Read the existing config file if it exists:

```bash
CONFIG_DIR="$HOME/.claude/plugins/data/workbench-core-claude-workbench"
CONFIG_FILE="$CONFIG_DIR/config.json"
```

If it exists, parse current values with `jq` and use them as defaults. If not, use the hardcoded defaults listed above.

Present each field to the user using the AskUserQuestion tool. Show the current value and let them confirm or change it.

After all fields, show the assembled config JSON and ask "Save this configuration? (yes/no)".

## Step 2 — Write config

Write `config.json` to the plugin data directory (create the directory if it doesn't exist):

```json
{
  "agent_name": "Claude",
  "memory_path": "/Users/yourname/Documents/Claude/Memory",
  "memory_cache": "/Users/yourname/.claude-memory-cache",
  "memory_mcp_server_name": "claude-memory",
  "auto_summarize": true,
  "summary_model": "haiku",
  "identity_files": {
    "soul_hot": "identity/soul-hot.md",
    "soul_core": "identity/soul-core.md",
    "profile": "identity/profile.md"
  }
}
```

**Do not edit `plugin.json`.** The `mcp-memory.sh` wrapper reads `config.json` at MCP launch time and exports the env vars the memory server needs. This mapping (for reference only):

| Config field | Exported env var |
|---|---|
| `memory_path` | `MARKDOWN_VAULT_MCP_SOURCE_DIR` |
| `memory_cache` | `MARKDOWN_VAULT_MCP_INDEX_PATH` (+ `/vault-index.sqlite`) |
| `memory_cache` | `MARKDOWN_VAULT_MCP_EMBEDDINGS_PATH` (+ `/embeddings`) |
| `memory_cache` | `MARKDOWN_VAULT_MCP_STATE_PATH` (+ `/state.json`) |
| `memory_mcp_server_name` | `MARKDOWN_VAULT_MCP_SERVER_NAME` |

Optionally write `config.example.json` alongside `config.json` with placeholder values and inline comments — useful for anyone setting up the plugin manually.

## Step 3 — Re-templatize identity files (if `agent_name` changed)

If `agent_name` changed from its previous value (or this is a first-time setup):

1. Read the template files from `${CLAUDE_PLUGIN_ROOT}/assets/templates/`:
   - `soul-hot.template.md`
   - `soul-core.template.md`
   - `profile.template.md`
   - `skills-protocol.template.md`

2. Replace all `{{agent_name}}` placeholders with the new agent name.

3. **If identity files already exist at the target paths:**
   - Read the existing files.
   - Show the user a diff of what would change (template defaults vs their customized content).
   - Ask: "Overwrite with re-templatized version, or keep your current files?"
   - If they choose to keep, skip the overwrite but update any `{{agent_name}}` references in the existing content (find-and-replace the OLD agent name with the NEW one, preserving all other customizations).

4. **If identity files don't exist:**
   - Write the templatized versions to `{memory_path}/{identity_files.soul_hot}`, etc.
   - Write `skills-protocol.template.md` to `{memory_path}/identity/skills-protocol.md` (no `{{agent_name}}` substitution needed — it's agent-agnostic). Replace `{{date}}` with today's date.
   - Create parent directories as needed.

5. Update the `memory_mcp_server_name` to reflect the new agent name if the user chose the default derivation (`{agent_name}-memory`).

## Step 4 — Confirm

Tell the user:
- Config saved to `{CONFIG_FILE}`
- MCP env vars will be re-read from config.json on next Claude Code restart
- Whether identity files were created/updated

## Step 5 — User profile interview

Check whether `profile.md` exists at the configured path and has real content (not just a template):

```bash
if [ -f "{memory_path}/identity/profile.md" ]; then
  grep -q '<!--' "{memory_path}/identity/profile.md" && echo "TEMPLATE" || echo "EXISTS"
else
  echo "MISSING"
fi
```

- **Missing or template:** Automatically invoke `/workbench:define-profile`. Tell the user: "No user profile found — let's set one up so the agent knows how you work."
- **Exists with real content:** Ask: "Your user profile already exists. Want to run `/workbench:define-profile` to review and refine it?" Respect a "no."

## Step 6 — Agent identity setup

Check whether `soul-hot.md` and `soul-core.md` exist at the configured paths and have real content:

```bash
for f in soul-hot.md soul-core.md; do
  if [ -f "{memory_path}/identity/$f" ]; then
    grep -q '<!--' "{memory_path}/identity/$f" && echo "TEMPLATE: $f" || echo "EXISTS: $f"
  else
    echo "MISSING: $f"
  fi
done
```

- **Any missing or template:** Automatically invoke `/workbench:define-soul`. Tell the user: "Agent identity files need to be set up — launching the soul definition walkthrough."
- **Both exist with real content:** Ask: "Agent identity files already exist. Want to run `/workbench:define-soul` to review and refine them?" Respect a "no."

The profile is completed first intentionally — define-soul benefits from knowing the user's working style, communication preferences, and expertise level when shaping the agent's voice and relationship dynamic.

## Step 7 — Restart reminder

After both interviews complete (or are skipped), remind the user: **"Restart Claude Code for the MCP server changes to take effect."**

## Notes

- **Plugin updates are a non-event.** `plugin.json` points at `mcp-memory.sh`, which resolves env vars from `config.json` at MCP launch. A version bump replaces the plugin dir but the wrapper still reads the same config. No re-customization needed.
- **Env var overrides still work:** `WORKBENCH_MEMORY_PATH`, `WORKBENCH_MEMORY_CACHE`, and `WORKBENCH_LOG_MODE` override config.json values in the hook scripts. This is useful for testing (e.g., dry-run with temp paths).
- **First-time setup:** If this is the first run and no config exists, all fields start at their hardcoded defaults. The user confirms or changes each one.
