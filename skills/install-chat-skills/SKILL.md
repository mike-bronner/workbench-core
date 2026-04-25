---
name: install-chat-skills
description: Install workbench-* plugin skills into Claude Chat (Mac app) via .skill packaging. Discovers all eligible skills in installed @claude-workbench plugins (excluding workbench-core itself), packages them with skill-creator's package_skill.py, and opens each .skill file with the Mac app to trigger the install dialog. Use this skill whenever the SessionStart warmup output mentions new Chat-installable skills, or to manually re-sync Chat skills after installing or updating a workbench plugin.
---

# Install Chat Skills

Run the install-chat-skills script. It handles the full discover → package → open flow and updates the state file so the SessionStart notice clears.

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/install-chat-skills.sh"
```

What it does:

1. Scans `~/.claude/plugins/installed_plugins.json` for `@claude-workbench` plugins (excluding workbench-core itself).
2. For each plugin, finds skills under `skills/<name>/SKILL.md` that have `name:` in their frontmatter (the skill-creator validator requires it).
3. Packages each skill as a `.skill` file in `/tmp/workbench-chat-skills/` via `python3 -m scripts.package_skill` from the skill-creator plugin.
4. Opens each `.skill` with `open -a Claude` — the Mac app handles the file extension and shows an install dialog.
5. Records what was installed (with versions) in `~/.claude-workbench/chat-skills-state.json` so the SessionStart notice clears.

The user confirms each install dialog as it appears. After the script finishes, verify in Claude Chat that the skills appear and trigger correctly.

If `skill-creator` isn't installed, the script will print a one-line install command — run that first, then re-invoke this skill.
