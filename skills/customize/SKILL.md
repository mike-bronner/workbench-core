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
- **Note:** This is the `MARKDOWN_VAULT_MCP_SERVER_NAME` value, and the identity the health probe checks against.

### 4b. `memory_port`
- **Prompt:** "Memory server port — the loopback port the shared HTTP memory server binds (and the host connects to)"
- **Default:** `8765`
- **Note:** The shared HTTP memory server binds `127.0.0.1:{memory_port}`. Only change it if `8765` collides with another local service. **Preflight the port** before accepting a non-default value:
  ```bash
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "WARNING: port $PORT is already in use — pick another or stop the squatter."
  fi
  ```
  The port reaches the MCP client only via `~/.claude/settings.json` `.env.WORKBENCH_MEMORY_PORT` (a SessionStart hook can't inject it into the host's config parse). Step 2b writes it there when it differs from the default.

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

## Step 2 — Write config (merge, never clobber)

`config.json` may already hold keys this skill doesn't manage (`persona`, `output_style`, future additions). **Read-modify-write with `jq`** so those survive — do NOT overwrite the file wholesale:

```bash
CONFIG_DIR="$HOME/.claude/plugins/data/workbench-core-claude-workbench"
CONFIG_FILE="$CONFIG_DIR/config.json"
mkdir -p "$CONFIG_DIR"
[ -f "$CONFIG_FILE" ] || echo '{}' > "$CONFIG_FILE"

# Merge the collected values onto the existing object (existing keys not listed
# here — e.g. persona/output_style — are preserved untouched). Only include
# memory_port when it differs from the 8765 default, to keep config minimal.
tmp="$(mktemp)"
jq \
  --arg agent_name        "$AGENT_NAME" \
  --arg memory_path       "$MEMORY_PATH" \
  --arg memory_cache      "$MEMORY_CACHE" \
  --arg mcp_name          "$MCP_NAME" \
  --arg summary_model     "$SUMMARY_MODEL" \
  --argjson auto_summarize "$AUTO_SUMMARIZE" \
  --argjson memory_port   "$MEMORY_PORT" \
  '
  .agent_name = $agent_name
  | .memory_path = $memory_path
  | .memory_cache = $memory_cache
  | .memory_mcp_server_name = $mcp_name
  | .summary_model = $summary_model
  | .auto_summarize = $auto_summarize
  | .identity_files = (.identity_files // {})
  | .identity_files.soul_hot  = (.identity_files.soul_hot  // "identity/soul-hot.md")
  | .identity_files.soul_core = (.identity_files.soul_core // "identity/soul-core.md")
  | .identity_files.profile   = (.identity_files.profile   // "identity/profile.md")
  | if $memory_port == 8765 then del(.memory_port) else .memory_port = $memory_port end
  ' "$CONFIG_FILE" > "$tmp" && mv "$tmp" "$CONFIG_FILE"
```

Running this twice with the same answers produces a byte-identical file (idempotent).

`persona` and `output_style` are written by `/workbench-core:install-persona` — they record which persona is active. Don't hand-edit them; the merge above never touches them. They're absent until a persona is installed.

**Do not edit `plugin.json`.** The hooks resolve env from `config.json` at launch time (precedence: `WORKBENCH_*` override env → `config.json` → default), via `hooks/lib/memory-env.sh`. Reference mapping:

| Config field | Exported env var |
|---|---|
| `memory_path` | `MARKDOWN_VAULT_MCP_SOURCE_DIR` |
| `memory_cache` | `MARKDOWN_VAULT_MCP_INDEX_PATH` (+ `/vault-index.sqlite`) |
| `memory_cache` | `MARKDOWN_VAULT_MCP_EMBEDDINGS_PATH` (+ `/embeddings`) |
| `memory_cache` | `MARKDOWN_VAULT_MCP_STATE_PATH` (+ `/state.json`) |
| `memory_cache` | `MARKDOWN_VAULT_MCP_KV_STORE_URL` (+ `/kv`), `…_EVENT_STORE_URL` (+ `/events`) |
| `memory_mcp_server_name` | `MARKDOWN_VAULT_MCP_SERVER_NAME` |
| `memory_port` | server `--port` (launcher fallback; settings.json env is what the host connects with) |

Optionally write `config.example.json` alongside `config.json` with placeholder values and inline comments — useful for anyone setting up the plugin manually.

## Step 2b — Provision the bearer token + settings.json env (fully automatic)

The shared HTTP memory server authenticates with a per-install **bearer token**, and the MCP client reads the port + token from `~/.claude/settings.json` `.env` (the only channel that reaches the host's config parse — a hook can't). Provision both with **zero user involvement**, idempotently:

```bash
CACHE_PATH="$MEMORY_CACHE"   # the resolved memory_cache from Step 1
TOKEN_FILE="$CACHE_PATH/server.token"
SETTINGS="${WORKBENCH_SETTINGS_FILE:-$HOME/.claude/settings.json}"

mkdir -p "$CACHE_PATH"
chmod 700 "$CACHE_PATH" 2>/dev/null || true

# Mint the token ONCE — reuse an existing one so re-running customize is a no-op
# and doesn't rotate a token the running server is already using.
if [ ! -s "$TOKEN_FILE" ]; then
  ( umask 077; openssl rand -hex 32 > "$TOKEN_FILE" )
fi
chmod 600 "$TOKEN_FILE"
TOKEN="$(cat "$TOKEN_FILE")"

# Merge WORKBENCH_MEMORY_TOKEN (and WORKBENCH_MEMORY_PORT when non-default) into
# settings.json .env, preserving every other setting. Handle the file being
# absent. Then lock the file down (it now holds a secret).
mkdir -p "$(dirname "$SETTINGS")"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
tmp="$(mktemp)"
jq \
  --arg token "$TOKEN" \
  --argjson port "$MEMORY_PORT" \
  '
  .env = (.env // {})
  | .env.WORKBENCH_MEMORY_TOKEN = $token
  | if $port == 8765 then (.env | del(.WORKBENCH_MEMORY_PORT)) as $e | .env = $e
    else .env.WORKBENCH_MEMORY_PORT = ($port|tostring) end
  ' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
chmod 600 "$SETTINGS"
```

Notes:
- **Idempotent:** the token is minted once and reused; the `jq` merge is a no-op when values already match. Running customize twice changes nothing.
- **Non-default port only:** `WORKBENCH_MEMORY_PORT` is written to settings.json only when it isn't `8765` (the baked-in default in `plugin.json`'s URL), keeping settings minimal.
- **Restart required:** settings.json `.env` is read at Claude Code launch, so the token/port reach the MCP client on the **next restart**, not just the next session. Mention this in the Step 7 restart reminder.
- **Self-heal:** if the token file is ever lost, the supervisor re-mints one at next start; re-running customize re-syncs settings.json to it.

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
- The memory server's bearer token was provisioned (and the port, if non-default) into `~/.claude/settings.json`
- Whether identity files were created/updated

## Step 4.5 — Deploy the nightly decision-quality task (opt-in)

The decision-quality learning loop (`/workbench-core:evaluate-decisions` → `/workbench-core:propose-upgrades`) can run on a nightly schedule: it grades the decisions and memories recorded that day, writes a learnings report, then holds a **triage of sign-off questions that pauses until you pick it up** — the same async pattern as the BuJo ritual. Auto-apply never happens; every proposal waits for your explicit approval.

Ask whether to enable it, via AskUserQuestion:
- **Question:** "Schedule the nightly decision-quality review? It evaluates recent decisions, then pauses on a proposal triage for your sign-off."
- **Options:** "Yes — run it nightly" · "Skip (I'll run it manually)"

If the user declines, skip this step (they can re-run customize anytime to enable it). If they accept:

1. **Pre-warm the scheduled-tasks MCP tools** in one ToolSearch call:
   `ToolSearch(query: "select:mcp__scheduled-tasks__list_scheduled_tasks,mcp__scheduled-tasks__create_scheduled_task,mcp__scheduled-tasks__update_scheduled_task")`

2. **Read the scheduled-task prompt body** from the plugin — use it verbatim as the `prompt` (it is plain prose, no frontmatter to strip):
   `${CLAUDE_PLUGIN_ROOT}/assets/prompt-templates/decision-quality.prompt.md`

3. **Idempotently register ONE task**, `workbench-core-decision-quality` (mirroring the house pattern in `skills/memory-lint/SKILL.md`). Call `list_scheduled_tasks`; if a task with that `taskId` already exists, call `update_scheduled_task`, otherwise `create_scheduled_task`, with:
   ```jsonc
   {
     "taskId": "workbench-core-decision-quality",
     "cronExpression": "0 3 * * *",   // nightly at 03:00 local — offer to adjust
     "prompt": "<the decision-quality.prompt.md body, verbatim>",
     "description": "Nightly decision-quality review — evaluate recorded decisions, then hold a proposal triage for sign-off."
   }
   ```

4. **Confirm:** "✅ Nightly decision-quality task registered (03:00). It writes a learnings report and pauses on the triage until you pick it up. Re-run customize to change the time or remove it."

**One chained task, not two.** The proposal triage must run only *after* the evaluation report exists, so a single task that runs evaluate then propose expresses that dependency directly — a second fixed-time cron could fire before the evaluation finished. The prompt's pause instruction is what makes the unattended run wait at the triage rather than fabricate answers.

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

After both interviews complete (or are skipped), remind the user: **"Restart Claude Code for the memory server changes to take effect."** Be specific about why a restart (not just a new session) is needed: the memory **port and bearer token** live in `~/.claude/settings.json` `.env`, which Claude Code reads only at launch — a SessionStart hook can't inject them into the host's MCP config parse. On a brand-new git install this means memory tools may be unavailable until the next restart picks up the token; that's expected and self-heals.

## Notes

- **Plugin updates are a non-event.** `plugin.json` points the memory MCP at the shared HTTP server; the hooks resolve env from `config.json` at launch via `hooks/lib/memory-env.sh`. A version bump replaces the plugin dir but the hooks still read the same config and settings.json env. No re-customization needed.
- **Env var overrides still work:** `WORKBENCH_MEMORY_PATH`, `WORKBENCH_MEMORY_CACHE`, `WORKBENCH_MEMORY_PORT`, `WORKBENCH_MCP_SERVER_NAME`, and `WORKBENCH_LOG_MODE` override config.json values in the hook scripts. Useful for testing (e.g., dry-run with temp paths/ports).
- **Token security:** `server.token` is `0600` under the cache, and `settings.json` is `chmod 600` after the merge (it now carries the token). Never commit either.
- **First-time setup:** If this is the first run and no config exists, all fields start at their hardcoded defaults. The user confirms or changes each one.
