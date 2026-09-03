#!/usr/bin/env bash
#
# outbound-prose-guard: PreToolUse guard on prose that leaves this machine.
#
# The Clear output style governs replies, and Claude Code reinforces it after
# every turn. That reminder is attached to the response, so it never reaches a
# document composed inside a tool call. A pull request body written to a file and
# piped through `gh pr edit --body-file` escapes the standard entirely. That is
# exactly how insight-llc/decisioncloud#21665 shipped 1,855 words with no emoji,
# twelve em dashes, and nineteen sentences past the twenty-word limit.
#
# This guard closes that gap for the artifacts other people read: `gh` pull
# request, issue, and release prose, plus the same text posted through a project
# board MCP. It checks only the mechanical rules (hooks/lib/prose-check.py).
# Whether a body is a debugging journal stays a human judgement.
#
# Scope: outbound artifacts only. Terminal replies are NOT checked, and cannot
# usefully be. A Stop hook fires after the reply has already been displayed, so
# blocking there appends a correction rather than preventing the text.
#
# Fail-open by design. Anything unparseable (a heredoc, a command substitution
# such as --body "$(cat notes.md)", an unreadable path) exits 0 rather than
# blocking. This is a style gate, not a security boundary: a false block costs
# more than a missed check, and credential-guard.sh makes the same trade.
#
# Exit codes: 0 = allow (default). 2 = block. Stderr is surfaced to the model
# on a blocking PreToolUse hook, so the findings become the revision brief.

set -u

PAYLOAD=""
if [ ! -t 0 ]; then
  PAYLOAD=$(cat)
fi
[ -n "$PAYLOAD" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

LIB_DIR="$(cd "$(dirname "$0")" && pwd)/lib"
CHECKER="$LIB_DIR/prose-check.py"
[ -f "$CHECKER" ] || exit 0

PROSE=$(printf '%s' "$PAYLOAD" | python3 -c '
import json, os, shlex, sys

# Subcommands whose payload is prose a person reads. `gh pr view`, `gh pr merge`,
# and friends carry no body and never reach the checker.
PROSE_COMMANDS = {
    ("pr", "create"), ("pr", "edit"), ("pr", "comment"), ("pr", "review"),
    ("issue", "create"), ("issue", "edit"), ("issue", "comment"),
    ("release", "create"), ("release", "edit"),
}
INLINE_FLAGS = {"--body", "-b", "--notes", "-n", "--message", "-m"}
FILE_FLAGS = {"--body-file", "-F", "--notes-file"}
# Identifiers, not prose. Everything else in an MCP payload is checked.
SKIP_KEYS = {
    "id", "item_id", "issue_id", "pr_id", "node_id", "url", "html_url",
    "owner", "repo", "repository", "number", "sha", "ref", "branch",
    "state", "status", "slug", "event", "login", "assignee",
}

def from_bash(command, cwd):
    try:
        tokens = shlex.split(command)
    except ValueError:
        return ""
    if "gh" not in tokens:
        return ""
    tokens = tokens[tokens.index("gh") + 1:]
    verbs = [t for t in tokens if not t.startswith("-")][:2]
    if len(verbs) < 2 or (verbs[0], verbs[1]) not in PROSE_COMMANDS:
        return ""
    parts = []
    for i, token in enumerate(tokens):
        value = tokens[i + 1] if i + 1 < len(tokens) else ""
        if token in INLINE_FLAGS and value:
            parts.append(value)
        elif token in FILE_FLAGS and value and value != "-":
            path = value if os.path.isabs(value) else os.path.join(cwd, value)
            try:
                with open(path, encoding="utf-8") as handle:
                    parts.append(handle.read())
            except OSError:
                return ""
    return "\n\n".join(parts)

def from_mcp(tool_input):
    parts = [
        value for key, value in tool_input.items()
        if isinstance(value, str) and key.lower() not in SKIP_KEYS and value.strip()
    ]
    return "\n\n".join(parts)

try:
    payload = json.load(sys.stdin)
except (ValueError, TypeError):
    sys.exit(0)

tool = payload.get("tool_name") or ""
tool_input = payload.get("tool_input") or {}
if not isinstance(tool_input, dict):
    sys.exit(0)

if tool == "Bash":
    sys.stdout.write(from_bash(tool_input.get("command") or "", payload.get("cwd") or "."))
elif tool.startswith("mcp__"):
    sys.stdout.write(from_mcp(tool_input))
' 2>/dev/null) || exit 0

[ -n "${PROSE//[[:space:]]/}" ] || exit 0

FINDINGS=$(printf '%s' "$PROSE" | python3 "$CHECKER" 2>/dev/null)
[ -n "$FINDINGS" ] || exit 0

{
  echo "🛑 Blocked: this text breaks the Clear standard, and other people read it."
  echo
  echo "$FINDINGS"
  echo
  echo "Rewrite the body, then send it again. The rules are in your output style:"
  echo "verdict first, reasons next, emoji as structure, one idea per sentence."
  echo "Re-read the WHOLE document after editing. Length is a property of the"
  echo "finished text, not of the paragraph you just appended."
} >&2
exit 2
