---
description: Configure the workbench — agent name, memory paths, MCP server name, the permission safety rails (defaultMode plus deny/ask rules) written to ~/.claude/settings.json, and the shipped output style. Re-run after a plugin update to re-sync the output style. Config lives in the plugin data directory and is read at MCP start time, so plugin updates never clobber settings.
disable-model-invocation: true
---

The user has invoked `/workbench-core:setup`. Walk them through configuring all workbench settings interactively.

The reasons behind the steps, and their history, are in `${CLAUDE_PLUGIN_ROOT}/docs/setup-design-notes.md`. Read it before changing how a step works. Following the steps needs none of it.

## Config location

The config file lives at:

```
~/.claude/plugins/data/workbench-core-claude-workbench/config.json
```

This is the plugin system's persistent data directory — it survives plugin version bumps. The `mcp-memory.sh` wrapper reads it at launch time and exports the corresponding env vars, so `plugin.json` never needs to be edited.

**Legacy path:** if `~/.claude/plugins/data/workbench-claude-workbench/config.json` exists (from before the `workbench` → `workbench-core` rename), migrate it to the new path — see Step 0.

## Fields

Show the current value of each field (from the existing config, or the hardcoded default if no config exists), and let the user keep it or change it.

### 1. `agent_name`
- **Prompt:** "Agent name — shown in the session warmup header, and the base of the default MCP server name"
- **Default:** `Claude`

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
- **Default:** `{agent_name}-memory` (derived from field 1). If the user keeps the derived default and changes `agent_name`, derive it again.
- **Note:** This is the `MARKDOWN_VAULT_MCP_SERVER_NAME` value (`serverInfo.name`).

### 5. `memory_port`
- **Prompt:** "Memory server port — the loopback port the shared memory server binds and the MCP client connects to"
- **Default:** `8765`
- **Note:** The shared server binds `127.0.0.1:{memory_port}` and `plugin.json` interpolates the same value into the MCP URL, so the two must agree — a mismatch is what the probe reports as `PORT_DRIFT`. If you set a non-default value, **preflight the port** first (`lsof` on macOS, `ss` on a stock Linux box):
  ```bash
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "WARNING: port $PORT is already in use — pick another or stop the squatter."
  fi
  ```
  The port reaches the MCP client via `~/.claude/settings.json` `.env.WORKBENCH_MEMORY_PORT`, which Step 2b writes when it differs from the default.

### 6. `summary_model`
- **Prompt:** "Model for background summary-writer agent"
- **Default:** `sonnet`
- **Note:** The model used when the detached summary-writer processes session logs. Sonnet is the default because summary quality and reliable tool-use matter more here than raw speed; drop to `haiku` if you want faster, cheaper summaries and can accept more variance.

### 7. `auto_summarize`
- **Prompt:** "Auto-summarize sessions on end?"
- **Default:** `true`
- **Note:** When true, spawns a background summary-writer on PreCompact and `/log-now`, and drains pending
  markers at session start. SessionEnd deliberately does NOT spawn — a child started as the parent exits is
  killed during teardown; the marker it writes is drained by the next session's warmup instead.

## Step 0 — Migrate legacy config (if present)

Before reading or writing anything, migrate the pre-rename data directory:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup-config.sh" migrate
```

It moves `~/.claude/plugins/data/workbench-claude-workbench` to the new path. When both directories exist, the new one wins and the old one is archived with a `.legacy-<date>` suffix. It prints a line only when it moved something. Tell the user if it did.

## Step 1 — Collect values

Read the existing config file if it exists:

```bash
CONFIG_DIR="$HOME/.claude/plugins/data/workbench-core-claude-workbench"
CONFIG_FILE="$CONFIG_DIR/config.json"
```

If it exists, parse current values with `jq` and use them as defaults. If not, use the hardcoded defaults listed above.

Ask with `AskUserQuestion`, up to four fields per call, which is the tool's maximum: fields 1–4 in the first call and fields 5–7 in the second. Each question shows the current value as its first option, marked `(current)`, and the free-text "Other" takes a new value. One question per call spends the user's attention on round trips.

After all fields, show the assembled config JSON and ask "Save this configuration? (yes/no)".

## Step 2 — Write config (merge, never clobber)

`config.json` may already hold keys this skill doesn't manage (`persona`, `output_style`, future additions). The script merges the collected values onto the existing object, so those survive. It writes `memory_port` only when it differs from the 8765 default, and it deletes `identity_files`, which configured the retired soul and profile files:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup-config.sh" write-config \
  --agent-name "$AGENT_NAME" --memory-path "$MEMORY_PATH" --memory-cache "$MEMORY_CACHE" \
  --mcp-name "$MCP_NAME" --summary-model "$SUMMARY_MODEL" \
  --auto-summarize "$AUTO_SUMMARIZE" --memory-port "$MEMORY_PORT"
```

`--auto-summarize` takes `true` or `false`. The script refuses a value a field cannot take, and a `config.json` that is not a JSON object, and writes nothing then. Relay its message and ask again.

Running it twice with the same answers produces a byte-identical file (idempotent).

`persona` and `output_style` are written by Step 2f — they record which persona is active. Don't hand-edit them; the merge above never touches them. They're absent until a persona is installed.

**Do not edit `plugin.json`.** The hooks resolve env from `config.json` at launch time (precedence: `WORKBENCH_*` override env → `config.json` → default), via `hooks/lib/memory-env.sh`. Reference mapping:

| Config field | Exported env var |
|---|---|
| `memory_path` | `MARKDOWN_VAULT_MCP_SOURCE_DIR` |
| `memory_cache` | `MARKDOWN_VAULT_MCP_INDEX_PATH` (+ `/vault-index.sqlite`) |
| `memory_cache` | `MARKDOWN_VAULT_MCP_EMBEDDINGS_PATH` (+ `/embeddings`) |
| `memory_cache` | `MARKDOWN_VAULT_MCP_STATE_PATH` (+ `/state.json`) |
| `memory_cache` | `MARKDOWN_VAULT_MCP_KV_STORE_URL` (+ `/kv`), `…_EVENT_STORE_URL` (+ `/events`) |
| `memory_mcp_server_name` | `MARKDOWN_VAULT_MCP_SERVER_NAME` |
| `memory_port` | the shared HTTP server's `--port`, and the port in `plugin.json`'s MCP URL |

## Step 2b — Provision the bearer token + settings.json env

> **Required — do not skip.** `plugin.json` interpolates `${WORKBENCH_MEMORY_TOKEN}` into the `Authorization` header, so **without this step Claude Code rejects the memory MCP outright** with `Invalid MCP server config for "memory": Missing environment variables: WORKBENCH_MEMORY_TOKEN`, and no server is ever started. That presents as memory being broken rather than unconfigured.

The shared HTTP server authenticates with a per-install **bearer token**, and the MCP client reads the port + token from `~/.claude/settings.json` `.env` (the only channel that reaches the host's config parse — a hook can't). Provision both with **zero user involvement**, idempotently. Pass the `memory_cache` and `memory_port` from Step 1:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup-config.sh" provision-token \
  --memory-cache "$MEMORY_CACHE" --memory-port "$MEMORY_PORT"
```

It mints `{memory_cache}/server.token` (`0600`, in a `0700` directory) when there is none, merges `WORKBENCH_MEMORY_TOKEN` (and `WORKBENCH_MEMORY_PORT` when non-default) into `settings.json` `.env`, keeps every other setting, and locks `settings.json` to `0600`, because it now holds a secret. A `settings.json` that is not a JSON object is refused and left alone.

Notes:
- **Idempotent:** the token is minted once and reused, and the merge is a no-op when the values already match.
- **Non-default port only:** `WORKBENCH_MEMORY_PORT` is written only when it isn't `8765`, the default baked into `plugin.json`'s URL.
- **Restart required:** settings.json `.env` is read at Claude Code launch, so the token/port reach the MCP client on the **next restart**, not the next session. Step 6 says so.
- **Self-heal:** if the token file is ever lost, the supervisor re-mints one at next start; re-running setup re-syncs settings.json to it.

## Step 2c — Permission safety rails (default-on)

The rules ship as data at `${CLAUDE_PLUGIN_ROOT}/assets/permissions/rails.json`, and `scripts/permissions.sh` merges them into `~/.claude/settings.json`. The merge is **additive**: an entry is added when absent, left alone when present, and existing entries keep their position. The same run writes the two scratchpad trees into `permissions.additionalDirectories` and removes a bare `/tmp` entry.

### 2c.1 — Pick the posture (`defaultMode`)

Since **August 14, 2026**, `auto` is the default permission mode for new sessions on Pro, Max, and Team plans — but *a default the user set themselves stays in place*. Setting it explicitly is how the user keeps the choice.

Show the current value first:

```bash
jq -r '.permissions.defaultMode // "unset (Claude Code default)"' ~/.claude/settings.json 2>/dev/null
```

Then ask with AskUserQuestion:

- **Question:** "Which permission mode should sessions start in?"
- **Options:**
  - `auto` — "A classifier reviews each action and blocks anything destructive or out-of-scope. Fewest prompts. Anthropic's own caveat: it *does not guarantee safety*." *(Recommended)*
  - `acceptEdits` — "File edits and common filesystem commands run without asking; everything else prompts."
  - `plan` — "Read-only until you approve a plan."
  - `default` — "Manual. Prompts for everything but reads."
- The auto-provided **Other** covers `dontAsk` and `bypassPermissions`, which are deliberately not offered as one-click options.

If the user would rather leave the current value alone, skip `--mode` in 2c.3 — the script then merges the rails and leaves `defaultMode` untouched.

⚠️ **`auto` is only honoured from user settings.** Claude Code ignores `defaultMode: "auto"` in `.claude/settings.json` and `.claude/settings.local.json` so a cloned repo can't promote itself. This script writes to `~/.claude/settings.json`, which is correct.

### 2c.2 — Show the rules before applying them

Never install security rules the user hasn't read. Print them:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/permissions.sh" --list
```

Output is `kind<TAB>rule<TAB>why`. Render it as two short tables — 🔴 deny and 🟡 ask — and say plainly what each kind does:

- **deny** — hard wall. Blocks before the classifier, in every mode, with no prompt and no override.
- **ask** — always prompts, even in `auto`, even when a narrower allow rule matches.
- **autoMode.allow** — a third kind, on a different layer: prose exceptions to the auto-mode classifier's built-in *soft-deny* rules. The shipped entry lets the `workbench-dev-team` Dispatch task launch its agents.

Three behaviours worth calling out by name:

- `Bash(git push --force:*)` also blocks `--force-with-lease`, since that string starts with `--force`.
- **There is no `Read()` deny rule.** Credential paths are guarded by the credential guard in the hooks module, a refusal no allow rule or mode overrides.
- **There is no `rm` rule at all.** `rm` and the destructive git verbs are gated by `hooks/destructive-scope-guard.sh`, which permits them only inside the project or a scratch root.

Then offer a dry run — it prints exactly what would change and writes nothing:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/permissions.sh" --dry-run --mode <chosen-mode>
```

### 2c.3 — Apply

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/permissions.sh" --mode <chosen-mode>
```

Idempotent — re-running with the same answers reports `all shipped rails already present` and writes nothing.

If the user wants to edit the lists, point them at `~/.claude/settings.json` `permissions.deny` / `permissions.ask`. Entries they remove by hand **will be re-added** the next time setup runs, since the merge only knows how to add. Removing a rule permanently means editing `assets/permissions/rails.json` in the plugin.

Then check for five ask entries an older setup installed and this one no longer ships. While they sit in `settings.json` they keep prompting and override the scope guard's permit, and the merge cannot remove them:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup-config.sh" leftover-asks
```

Relay its report. When it finds any, the user deletes them by hand from `permissions.ask`.

Finally, confirm the effective classifier rules with `claude auto-mode config`, which prints the four lists with `"$defaults"` expanded in place. The literal `"$defaults"` must stay in `autoMode.allow`: without it the whole built-in soft-deny list is replaced. `permissions.sh` restores it when it is missing, so never hand-edit it out.

Do not add `Bash(git push:*)`, `Bash(git commit:*)`, or `Bash(gh pr create:*)` to the ask list. A headless `claude -p` run cannot answer a prompt, so those rules would silently kill the `workbench-dev-team` pipeline. `hooks/test-permissions.sh` asserts their absence.

## Step 2d — Deploy the stale-bundle guard (default-on)

The Claude desktop app can serve plugin bundles that are frozen weeks behind the CLI's install, and a stale skill body can overwrite state a newer version deployed. This guard reports that drift at SessionStart, on a typed `/workbench-*` command, and on any Skill call. It is silent when the served bundles match the installed versions. It must live in user settings rather than `hooks/hooks.json`, because a frozen plugin never activates its own hooks.

Run it:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/settings-hooks.sh"
```

Preview first with `--dry-run`, or list what would be deployed with `--list`.

The merge is **additive and idempotent**: an entry is added when its command is absent and left alone when present, and a user's own hooks for the same events are kept alongside. No other settings key is touched. A malformed `settings.json` is refused rather than clobbered. Re-running setup also **refreshes the deployed script** at `~/.claude/hooks/`.

## Step 2e — Git sync for the vault (opt-in)

The server can keep the vault in sync with a git remote itself — fetch and fast-forward before
the initial index build, a pull loop whose `on_pull` callback is `reindex`, and a deferred-commit
queue for writes. `hooks/lib/memory-env.sh` already exports every `MARKDOWN_VAULT_MCP_GIT_*`
variable this needs, gated entirely on one key: `memory_git_repo_url`. Absent that key, nothing
in this step has ever run and behaviour is byte-identical to a vault with no sync.

🛑 **Two hard preconditions. Check both before asking anything.**

1. **Shared HTTP transport only.** The strategy's write-quiescing uses in-process `threading`
   locks, which hold only when one server owns the vault. Verify:
   ```bash
   jq -r '.mcpServers.memory.type // "stdio"' "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json"
   ```
   Anything but `http` → skip this step and say why.
2. **Single writer.** One machine at a time may write. Two machines syncing the same remote is
   the supported case (that is the point); two servers on *one* machine is not.

### 2e.1 — Ask whether to enable it

Show what it costs and what it buys, then ask with AskUserQuestion:

- **Question:** "Sync the memory vault to a git remote? Cross-machine shared memory, with every
  memory change revertible."
- **Options:** "Yes — set it up now" · "Skip (I'll run setup again later)"

If they decline, skip the rest of this step. Nothing is written.

### 2e.2 to 2e.6 — Size, ignore, remote, config, first push

Read `${CLAUDE_PLUGIN_ROOT}/skills/setup/references/git-sync.md` and follow its steps in order. It measures the vault before anything is created, writes the `.gitignore` before `git init`, sets up the remote and its authentication, writes `memory_git_repo_url`, and leaves the first upload to the user. Three of its rules hold whatever else happens:

- **Ignore the raw transcripts first.** `sessions/**/*.log.md` goes in `{memory_path}/.gitignore` before the first `git add`. `MARKDOWN_VAULT_MCP_EXCLUDE` keeps them out of the search index only, and on a mature vault they are most of its bytes.
- 🛑 **Never ask the user to paste a token into the chat, and never read one out of a file into your context.** The user places an HTTPS token in `settings.json` `.env` themselves.
- **The remote must already exist and must be private.** This skill creates no repository, and stops when the remote is not `PRIVATE`.

## Step 2f — Install the shipped output style

Setup is the one entry point for the persona. There is no separate install command, so a re-run
of setup after a plugin update is also what re-syncs the output style. The warmup does not write
the style. It only reports `⚠ Output style out of date` in the warmup notices when the live copy
differs from the shipped one, and that notice points here.

The plugin ships one persona under `${CLAUDE_PLUGIN_ROOT}/assets/personas/<name>/`: an output
style. `scripts/install.sh` copies it to `~/.claude/output-styles/<name>.md` and writes its
`name:` to `~/.claude/settings.json` `.outputStyle`, a single-key merge that preserves every
other setting.

### 2f.1 — Opt in, or re-sync

Read `.persona` from `config.json`. The persona is opt-in:

- **Unset** → ask through `AskUserQuestion` whether to install it. Respect a "no", and skip to
  Step 2g.
- **Set** → the user already chose it. Re-sync it without asking again, through 2f.2 and 2f.3.

### 2f.2 — Preview (always dry-run first)

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/install.sh" --dry-run
```

Relay the output verbatim. It reports whether the style would be written or already matches, and
prints a diff for a live copy that would change. If everything already matches, say so and skip
to Step 2g.

### 2f.3 — Apply and record

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/install.sh"
```

Then record the active persona in `config.json` so tooling knows which one is live. The persona
is the directory name, and the style name is the `name:` the script echoed:

```bash
tmp="$(mktemp)"
jq --arg p "<name>" --arg s "<StyleName>" '.persona = $p | .output_style = $s' "$CONFIG_FILE" > "$tmp" && mv "$tmp" "$CONFIG_FILE"
```

The output style takes effect on the next session. Step 6's restart covers it.

## Step 2g — Cap MCP tool output (default-on)

Claude Code persists an MCP response larger than `MAX_MCP_OUTPUT_TOKENS` to a file and hands
the model a pointer to it instead of the text. Its default is 25,000 tokens. Setup lowers that to
**15,000**, so a response past about 60 KB stays out of the context.

Set it only when the key is absent. A value already there is the user's own choice, so a re-run
leaves it alone:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup-config.sh" cap-mcp-output
```

It prints the value in force. When `settings.json` is not a JSON object, it changes nothing and
says to set `env.MAX_MCP_OUTPUT_TOKENS` by hand. Relay that.

- **Idempotent:** the merge is a no-op when the key exists, whatever its value.
- **Restart required:** `settings.json` `.env` is read at launch, like the token in Step 2b.
- **The memory vault is covered too.** Its `read` tool returns notes up to 262,144 bytes whole, on
  purpose. A read past the limit reaches the model as a pointer to the persisted response, which
  it reads from there. Nothing is truncated, so no exemption is needed.

## Step 2h — Take the old workbench block out of CLAUDE.md (default-on)

Up to 0.44, the warmup rewrote `~/.claude/CLAUDE.md` on every session start: a marked block with
the gates and scratch roots, and one with each sibling plugin's `session-warmup.md`. The hooks
module now sends those as system-prompt sections, and the warmup no longer writes the file. Take
the old blocks out, so the user's file holds only the user's own text:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup-config.sh" unsplice-claude-md
```

It removes each marked block, marker lines included, and leaves every other line as it was, byte
for byte. Relay what it prints. When the markers are not one start line then one end line (a
marker the user quoted, a second end, a start with no end), it changes nothing and says to take
the block out by hand. Relay that.

- **Idempotent:** a second run finds no block and changes nothing.
- **Nothing is lost in the meantime.** Until this runs, the hooks module leaves the old block out
  of what the model reads, so the rules are not sent twice.

## Step 3 — Deploy the nightly decision-quality task (opt-in)

The decision-quality learning loop (`/workbench-core:evaluate-decisions` → `/workbench-core:propose-upgrades`) can run on a nightly schedule: it grades the decisions and memories recorded that day, writes a learnings report, then holds a **triage of sign-off questions that pauses until you pick it up**. Auto-apply never happens; every proposal waits for your explicit approval.

Ask whether to enable it, via AskUserQuestion:
- **Question:** "Schedule the nightly decision-quality review? It evaluates recent decisions, then pauses on a proposal triage for your sign-off."
- **Options:** "Yes — run it nightly" · "Skip (I'll run it manually)"

If the user declines, skip this step (they can re-run setup anytime to enable it). If they accept:

1. **Pre-warm the scheduled-tasks MCP tools** in one ToolSearch call:
   `ToolSearch(query: "select:mcp__scheduled-tasks__list_scheduled_tasks,mcp__scheduled-tasks__create_scheduled_task,mcp__scheduled-tasks__update_scheduled_task")`

2. **Read the scheduled-task prompt body** from the plugin — use it verbatim as the `prompt` (it is plain prose, no frontmatter to strip):
   `${CLAUDE_PLUGIN_ROOT}/assets/prompt-templates/decision-quality.prompt.md`

3. **Idempotently register ONE task**, `workbench-core-decision-quality`. Call `list_scheduled_tasks`; if a task with that `taskId` already exists, call `update_scheduled_task`, otherwise `create_scheduled_task`, with:
   ```jsonc
   {
     "taskId": "workbench-core-decision-quality",
     "cronExpression": "0 3 * * *",   // nightly at 03:00 local — offer to adjust
     "prompt": "<the decision-quality.prompt.md body, verbatim>",
     "description": "Nightly decision-quality review — evaluate recorded decisions, then hold a proposal triage for sign-off."
   }
   ```

4. **Confirm:** "✅ Nightly decision-quality task registered (03:00). It writes a learnings report and pauses on the triage until you pick it up. Re-run setup to change the time or remove it."

It is **one chained task, not two**: the triage must run only after the evaluation report exists, and a second fixed-time task could fire before the evaluation finished.

## Step 4 — Deploy the monthly memory-lint task (default-on)

The memory-lint ritual is the vault's only self-healing pass: it rescues files skipped for broken frontmatter, repairs broken links, and writes an audit report. Register it **without asking** — the 2026-07-08 audit found that an unregistered lint schedule let 31 documents rot invisibly for a month. Mention it in the confirmation so the user can remove it if they truly want to.

Idempotently register ONE task (same list → update-else-create pattern as Step 3; pre-warm the tools the same way if Step 3 was skipped):

```jsonc
{
  "taskId": "workbench-core-memory-lint",
  "cronExpression": "0 9 1 * *",   // monthly, 1st at 09:00 local
  "prompt": "/workbench-core:memory-lint",
  "description": "Monthly memory-vault lint — frontmatter rescue, broken-link repair, audit report."
}
```

## Step 5 — Confirm

Tell the user:
- Config saved to `{CONFIG_FILE}`
- MCP env vars will be re-read from config.json on next Claude Code restart
- The memory server's bearer token was provisioned (and the port, if non-default) into `~/.claude/settings.json`
- Whether `MAX_MCP_OUTPUT_TOKENS` was set to 15,000, or an existing value was kept (Step 2g)
- Whether the old workbench block was taken out of `~/.claude/CLAUDE.md`, or there was none (Step 2h)
- The permission mode that is now set, and how many deny/ask rails were added (the script reports both)
- Whether git sync was enabled, and if so the remote and the measured synced size (Step 2e)
- Whether the output style was installed, re-synced, already current, or declined (Step 2f)
- Whether the nightly decision-quality task was registered (Step 3)
- "✅ Monthly memory-lint task registered (1st of the month, 09:00). It keeps every vault file searchable; remove it from the Scheduled sidebar if you'd rather run `/workbench-core:memory-lint` manually." (Step 4)

## Step 6 — Restart reminder

Remind the user to **fully restart Claude Code — quit and relaunch, not just `/clear` or a new session.** Permission rules and `defaultMode` from Step 2c would be satisfied by a new session, but the bearer token from Step 2b and the MCP output limit from Step 2g reach Claude Code only through `settings.json` `.env`, which it reads **at launch**. A new session in the same process re-reads neither, and the memory MCP fails identically. Say this plainly: a new session is not enough.

## Notes

- **Plugin updates are a non-event.** `plugin.json` points the memory MCP at `127.0.0.1:{memory_port}/mcp`; the hooks resolve env from `config.json` at launch via `hooks/lib/memory-env.sh`. A version bump replaces the plugin dir but the hooks still read the same config, and the token in `settings.json` is untouched. No re-customization needed.
- **Env var overrides still work:** `WORKBENCH_MEMORY_PATH`, `WORKBENCH_MEMORY_CACHE`, `WORKBENCH_MEMORY_PORT`, `WORKBENCH_MCP_SERVER_NAME`, and `WORKBENCH_LOG_MODE` override config.json values in the hook scripts. Useful for testing (e.g., dry-run with temp paths/ports). The Step 2e git-sync keys override the same way — `WORKBENCH_MEMORY_GIT_REPO_URL`, `WORKBENCH_MEMORY_GIT_TOKEN`, `WORKBENCH_MEMORY_GIT_USERNAME`, `WORKBENCH_MEMORY_GIT_PULL_INTERVAL`, `WORKBENCH_MEMORY_GIT_PUSH_DELAY`, `WORKBENCH_MEMORY_GIT_COMMIT_NAME`, `WORKBENCH_MEMORY_GIT_COMMIT_EMAIL`, `WORKBENCH_MEMORY_GIT_LFS`.
- **Git sync is off until a repo URL exists.** Setting `memory_git_repo_url` is the entire switch; `memory-env.sh` exports no `MARKDOWN_VAULT_MCP_GIT_*` variable without it. Remove the key to turn sync back off — the vault's `.git` and its remote are left alone, so nothing is lost.
- **Token security:** `server.token` is `0600` under the cache and `settings.json` is `chmod 600` after the merge (it now carries a secret). Never commit either.
- **First-time setup:** If this is the first run and no config exists, all fields start at their hardcoded defaults. The user confirms or changes each one.
