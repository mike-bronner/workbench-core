# Setup Steps 2e.2 to 2e.6: git sync for the vault

`/workbench-core:setup` reads this file once the user has said yes to git sync in Step 2e.1.
The two preconditions of Step 2e hold here too: the shared HTTP transport only, and a single
writer. `$MEMORY_PATH` is the `memory_path` from Step 1, and `$CONFIG_FILE` is the config file
Step 2 wrote (`~/.claude/plugins/data/workbench-core-claude-workbench/config.json`).

## 2e.2 — Size the payload BEFORE creating anything

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

## 2e.3 — Write the `.gitignore` first, before `git init`

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

## 2e.4 — Remote and authentication

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

## 2e.5 — Write the config

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

## 2e.6 — First push is the user's call

Present the staged file count and the measured size, then let them run it. Pushing a personal
vault to a remote is outward-facing and effectively irreversible once history exists:

```bash
git -C "$MEMORY_PATH" commit -qm "chore: 🎉 Seed memory vault." && \
git -C "$MEMORY_PATH" remote add origin "$GIT_REPO_URL" && \
git -C "$MEMORY_PATH" push -u origin main
```

Confirm afterwards that the server picked it up — the sync loop only starts on the next server
launch, which means the **relaunch in setup Step 6**, not merely a new session.
