---
name: install-chat-skills
description: Install the skills of installed workbench-* plugins into the Claude Mac app. Use when the warmup notices say new Chat-installable skills exist, or to re-sync after installing or updating a workbench plugin.
disable-model-invocation: true
allowed-tools: Bash(bash ${CLAUDE_PLUGIN_ROOT}/scripts/install-chat-skills.sh) Bash(echo "install-chat-skills.sh exit status $?")
---

# Install Chat Skills

The install script already ran when this skill loaded, so do not run it again. This is what it printed:

!`bash ${CLAUDE_PLUGIN_ROOT}/scripts/install-chat-skills.sh || echo "install-chat-skills.sh exit status $?"`

What the script does:

1. Scans `~/.claude/plugins/installed_plugins.json` for `@claude-workbench` plugins (excluding workbench-core itself).
2. For each plugin, finds skills under `skills/<name>/SKILL.md` that have `name:` in their frontmatter (the skill-creator validator requires it).
3. Packages each skill as a `.skill` file in `/tmp/workbench-chat-skills/` via `python3 -m scripts.package_skill` from the skill-creator plugin.
4. Opens each `.skill` with `open -a Claude`. The Mac app handles the file extension and shows an install dialog.
5. Records what was installed (with versions) in `~/.claude-workbench/chat-skills-state.json`, so the warmup notice clears.

Tell the user, in a few lines, what the output above shows:

- **Skills opened for install:** name each one. The user confirms each install dialog in the Mac app, then checks in Claude Chat that the skills appear and trigger.
- **Nothing to install:** say so.
- **An exit status line:** the script stopped at a pre-flight check. Relay its message. If it says `skill-creator` is missing, give the user its one-line install command, and tell them to run `/workbench-core:install-chat-skills` again afterwards.
