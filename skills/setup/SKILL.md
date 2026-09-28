---
description: Configure the workbench — agent name, memory paths, MCP server name, the permission safety rails (defaultMode plus deny/ask rules) written to ~/.claude/settings.json, and the shipped output style. Re-run after a plugin update to re-sync the output style. Config lives in the plugin data directory and is read at MCP start time, so plugin updates never clobber settings.
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

Ask with `AskUserQuestion`, up to four fields per call, which is the tool's maximum: fields 1–4 in the first call and fields 5–7 in the second. Each question shows the current value as its first option, marked `(current)`, and the free-text "Other" takes a new value. One question per call spends the user's attention on round trips.

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
# identity_files is deleted: it configured the retired soul and profile files,
# and nothing reads it any more.
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
  | del(.identity_files)
  | if $memory_port == 8765 then del(.memory_port) else .memory_port = $memory_port end
  ' "$CONFIG_FILE" > "$tmp" && mv "$tmp" "$CONFIG_FILE"
```

Running this twice with the same answers produces a byte-identical file (idempotent).

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

The shared HTTP server authenticates with a per-install **bearer token**, and the MCP client reads the port + token from `~/.claude/settings.json` `.env` (the only channel that reaches the host's config parse — a hook can't). Provision both with **zero user involvement**, idempotently:

```bash
CACHE_PATH="$MEMORY_CACHE"   # the resolved memory_cache from Step 1
TOKEN_FILE="$CACHE_PATH/server.token"
SETTINGS="${WORKBENCH_SETTINGS_FILE:-$HOME/.claude/settings.json}"

mkdir -p "$CACHE_PATH"
chmod 700 "$CACHE_PATH" 2>/dev/null || true

# Mint the token ONCE — reuse an existing one so re-running setup is a no-op
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
- **Idempotent:** the token is minted once and reused; the `jq` merge is a no-op when values already match.
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
- **There is no `Read()` deny rule.** Credential paths are guarded by `hooks/credential-guard.sh`, a hook deny no allow rule or mode overrides.
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
SETTINGS="${WORKBENCH_SETTINGS_FILE:-$HOME/.claude/settings.json}"
SCOPED=$(jq -r '[.permissions.ask[]? | select(
  . == "Bash(rm -rf:*)" or . == "Bash(git clean -fd:*)" or
  . == "Bash(git reset --hard:*)" or . == "Bash(git stash clear:*)" or
  . == "Bash(git stash drop:*)")] | length' "$SETTINGS" 2>/dev/null || echo 0)
if [ "$SCOPED" = "0" ]; then
  echo "✅ No leftover scope-able entries in permissions.ask."
  echo "   hooks/destructive-scope-guard.sh is the only layer gating those verbs — it permits what resolves inside the project or a scratch root, and denies everything else, including what it cannot resolve."
else
  echo "⚠  $SCOPED leftover scope-able entr(ies) in permissions.ask, from a setup run before they were dropped."
  echo "   They prompt regardless of where the command acts, and a matching ask rule still prompts even when a PreToolUse hook returned \"allow\" — so the guard's permit cannot show through while they are there."
  echo "   This merge cannot remove them: it only ever adds. Delete them BY HAND from permissions.ask in:"
  echo "     $SETTINGS"
fi
```

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

### 2e.2 — Size the payload BEFORE creating anything

⚠️ **The footgun.** `memory-env.sh` sets `MARKDOWN_VAULT_MCP_EXCLUDE="sessions/**/*.log.md"`,
which keeps raw transcripts out of the **search index**. It does nothing about **git**. On a
mature vault the transcripts are the overwhelming majority of the bytes — measured 2026-09-01 on
a real vault: **425 MB total, 15.2 MB once `sessions/` is excluded**, with an 11 MB single
`.log.md`. Enable sync without a `.gitignore` and the first push sends all of it to the remote,
permanently, in history.

Measure the actual vault before proposing a remote — never quote the numbers above as if they
were this user's:

```bash
M="$MEMORY_PATH"
tot() { find "$M" -type f "$@" -exec stat -f%z {} + 2>/dev/null | awk '{s+=$1} END {printf "%.1f MB", s/1048576}'; }
echo "everything:      $(tot)"
echo "without sessions: $(tot ! -path "$M/sessions/*")"
```

Report both numbers to the user. If the excluded figure is still above ~100 MB, stop and show
`du -sh "$M"/* | sort -rh | head` so they can decide what else to exclude before anything is
committed.

### 2e.3 — Write the `.gitignore` first, before `git init`

Order matters: the ignore file must exist before the first `git add`, or the transcripts land in
history and only a rewrite removes them.

A **denylist**, deliberately — it mirrors `MARKDOWN_VAULT_MCP_EXCLUDE` so index and git share one
mental model, and a memory folder the user creates later syncs by default. An allowlist would
silently fail to sync new content, and a memory that never reaches the other machine gives no
signal that it is missing.

Write `{memory_path}/.gitignore`, preserving any lines already there:

```gitignore
# Raw session transcripts — excluded from the search index by
# MARKDOWN_VAULT_MCP_EXCLUDE, and far too large to sync. Keep them machine-local.
sessions/**/*.log.md

# Bulk session exports.
archive/**/*.zip

# macOS / editor junk.
.DS_Store
*.swp
```

Then confirm the ignore actually bites, *before* committing:

```bash
git -C "$MEMORY_PATH" init -q
git -C "$MEMORY_PATH" add -A
git -C "$MEMORY_PATH" diff --cached --name-only | wc -l          # files that WOULD be committed
git -C "$MEMORY_PATH" diff --cached --name-only | grep -c '\.log\.md$'   # MUST be 0
```

If that last count is not `0`, the ignore is wrong — fix it and re-stage. Do not commit.

### 2e.4 — Remote and authentication

Ask which auth the user wants, with AskUserQuestion, and branch:

- **SSH** — remote of the form `git@github.com:<user>/<repo>.git`. Uses the existing SSH agent.
  **No credential is prompted for, stored, or written by this skill.** Prefer it when the user
  already pushes to GitHub over SSH.
- **HTTPS + token** — remote of the form `https://github.com/<user>/<repo>.git`, plus a personal
  access token with `repo` scope.

🛑 **Never ask the user to paste a token into the chat, and never read one out of a file into
your context.** Have them place it themselves, then verify only that it is non-empty:

```bash
# The user runs this; you do not.
#   tmp=$(mktemp) && jq '.env.WORKBENCH_MEMORY_GIT_TOKEN = "<paste-token>"' ~/.claude/settings.json > "$tmp" && mv "$tmp" ~/.claude/settings.json && chmod 600 ~/.claude/settings.json
jq -e '(.env.WORKBENCH_MEMORY_GIT_TOKEN // "") | length > 0' ~/.claude/settings.json >/dev/null \
  && echo "token present" || echo "token NOT set"
```

The token belongs in `settings.json` `.env`, not `config.json` — `config.json` is plain-text
plugin data, and `memory-env.sh` reads the environment first for exactly this reason. It falls
back to `.memory_git_token` in `config.json`; treat that fallback as legacy and do not write it.

**The remote must already exist and must be private.** This skill does not create repositories —
a vault holds personal and possibly entrusted material, and repo creation with a visibility flag
is not a decision to make on someone's behalf. Have the user create an empty private repo and
give you the URL. Verify it is reachable and private before writing any config:

```bash
gh repo view <owner>/<repo> --json visibility,isEmpty 2>&1
```

If `visibility` is not `PRIVATE`, stop and say so plainly. Do not proceed.

### 2e.5 — Write the config

Merge onto `config.json` with the same read-modify-write discipline as Step 2 — never clobber:

```bash
tmp="$(mktemp)"
jq --arg url "$GIT_REPO_URL" '.memory_git_repo_url = $url' "$CONFIG_FILE" > "$tmp" && mv "$tmp" "$CONFIG_FILE"
```

Optionally also set `memory_git_commit_name` / `memory_git_commit_email` if the user wants
vault commits attributed differently from their global git identity. Leave
`memory_git_pull_interval_s` (120) and `memory_git_push_delay_s` (30) alone unless asked —
`memory-env.sh` already tightens both from the server's defaults for interactive use, and
`memory_git_lfs` is deliberately `false` for a vault of small markdown files.

### 2e.6 — First push is the user's call

Present the staged file count and the measured size, then let them run it. Pushing a personal
vault to a remote is outward-facing and effectively irreversible once history exists:

```bash
git -C "$MEMORY_PATH" commit -qm "chore: 🎉 Seed memory vault." && \
git -C "$MEMORY_PATH" remote add origin "$GIT_REPO_URL" && \
git -C "$MEMORY_PATH" push -u origin main
```

Confirm afterwards that the server picked it up — the sync loop only starts on the next server
launch, which means the **relaunch in Step 6**, not merely a new session.

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
SETTINGS="${WORKBENCH_SETTINGS_FILE:-$HOME/.claude/settings.json}"
mkdir -p "$(dirname "$SETTINGS")"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
if jq -e 'type == "object"' "$SETTINGS" >/dev/null 2>&1; then
  tmp="$(mktemp)"
  jq '.env = (.env // {}) | .env.MAX_MCP_OUTPUT_TOKENS = (.env.MAX_MCP_OUTPUT_TOKENS // "15000")' \
    "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
  chmod 600 "$SETTINGS"
else
  echo "settings.json is not a JSON object; left it alone. Set env.MAX_MCP_OUTPUT_TOKENS by hand."
fi
```

- **Idempotent:** the merge is a no-op when the key exists, whatever its value.
- **Restart required:** `settings.json` `.env` is read at launch, like the token in Step 2b.
- **The memory vault is covered too.** Its `read` tool returns notes up to 262,144 bytes whole, on
  purpose. A read past the limit reaches the model as a pointer to the persisted response, which
  it reads from there. Nothing is truncated, so no exemption is needed.

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
