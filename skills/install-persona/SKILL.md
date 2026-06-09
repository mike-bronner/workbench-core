---
description: Install a shipped persona (identity + output style) from this plugin into your live Claude Code locations — soul files to the memory vault, the output style to ~/.claude/output-styles, and the outputStyle setting in ~/.claude/settings.json. Non-destructive — hand-edited soul files are diffed and confirmed before any overwrite. Use when setting up an agent persona, switching personas, or re-syncing after a plugin update.
---

The user invoked `/workbench-core:install-persona`. This installs a persona that ships *with the plugin* into the live locations Claude Code loads identity from. The plugin is the source of truth; this propagates it. Identity files are precious — never clobber a hand-edited soul file without explicit confirmation.

## Step 1 — List available personas

Personas ship under `${CLAUDE_PLUGIN_ROOT}/assets/personas/<name>/`:

```bash
ls -1 "${CLAUDE_PLUGIN_ROOT}/assets/personas" 2>/dev/null
```

- **One persona:** use it.
- **Several:** present them with `AskUserQuestion` and let the user pick.
- **None:** tell the user there are no shipped personas and stop.

## Step 2 — Preview (always dry-run first)

Show exactly what would change before writing anything:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/install-persona.sh" <name> --dry-run
```

Relay the output verbatim. It reports, per artifact, whether it would be written, already matches, or (for soul files) differs from a hand-edited version.

## Step 3 — Resolve soul conflicts

If the dry run says a soul file **"differs and was left unchanged,"** the user has customized it. Do **not** overwrite blindly:

1. Show the diff the dry run printed.
2. Ask the user — per file — whether to overwrite with the shipped version or keep their edits.
3. Only pass `--force` if they explicitly approve overwriting.

## Step 4 — Apply

```bash
# Safe: installs soul files only where absent or identical; never clobbers a differing one.
bash "${CLAUDE_PLUGIN_ROOT}/scripts/install-persona.sh" <name>

# Only if the user approved overwriting differing soul files in Step 3:
bash "${CLAUDE_PLUGIN_ROOT}/scripts/install-persona.sh" <name> --force
```

The script also installs the output style to `~/.claude/output-styles/<name>.md` and sets `~/.claude/settings.json` `.outputStyle` (a safe single-key merge that preserves every other setting).

## Step 5 — Record the active persona

Record the choice in config so tooling knows which persona is live. Read the style name from the persona's `output-style.md` `name:` frontmatter (the script already echoed it):

```bash
CONFIG_DIR="$HOME/.claude/plugins/data/workbench-core-claude-workbench"
CONFIG_FILE="$CONFIG_DIR/config.json"
mkdir -p "$CONFIG_DIR"
tmp="$(mktemp)"
if [ -f "$CONFIG_FILE" ]; then
  jq --arg p "<name>" --arg s "<StyleName>" '.persona = $p | .output_style = $s' "$CONFIG_FILE" > "$tmp" && mv "$tmp" "$CONFIG_FILE"
else
  jq -n --arg p "<name>" --arg s "<StyleName>" '{ persona: $p, output_style: $s }' > "$CONFIG_FILE"
fi
```

## Step 6 — Remind

Tell the user: **the output style takes effect on the next session — run `/clear` or restart Claude Code.** The soul files load on the next session-warmup.

## Notes

- The plugin only *ships* the persona. Your editable copy lives in the memory vault (`identity/soul-hot.md`, `soul-core.md`) and `~/.claude/output-styles/<name>.md`. Re-running this re-seeds from the plugin, diffing before it touches anything you changed.
- To *refine* a persona's voice, use `/workbench-core:define-soul` — it edits your live copy and re-applies the output style.
- Guardrails are not part of a persona — they ship with the plugin and apply across all personas.
