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
# request, issue, and release prose, the same prose sent through `gh api`, and
# the same text posted through a project board MCP. It checks only the em dash and the semicolon (hooks/lib/prose-check.py).
# Density, sentence length, and whether a body is a debugging journal are
# judgement calls the output style states, and a deny on them breeds workarounds.
#
# Scope: outbound artifacts only. Terminal replies are NOT checked, and cannot
# usefully be. A Stop hook fires after the reply has already been displayed, so
# blocking there appends a correction rather than preventing the text.
#
# A body read from standard input (`--body-file -`, `--notes-file -`, `-F -`,
# `gh api --input -` or `-F body=@-`) is checked when the gh stage itself takes
# a heredoc or a here-string. The heredoc is the form the dev-team git-commit
# skill recommends, so leaving it unchecked let nearly every agent-written body
# through. Standard input from a pipe or a file redirect is not in the command
# text, so a body read from it is not checked.
#
# Fail-open by design. Anything unparseable (a command substitution such as
# --body "$(cat notes.md)", an unreadable path) exits 0 rather than blocking.
# This is a style gate, not a security boundary: a false block costs more than
# a missed check, and credential-guard.sh makes the same trade.
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

# ──────────── Prefilter: only gh prose commands start python ────────────
# The matcher sends every Bash call here, and nearly none of them post prose.
# The parser below reads a `gh` stage only when its subcommand is `api`, or a
# pr, issue, or release verb: create, edit, comment, or review. So a Bash command
# whose text does not name `gh` and either `api` or one of those nouns and verbs
# cannot produce anything to check.
# The text is read the way the parser's tokeniser reads it: backslash-newlines
# are deleted, then quotes and backslashes, because the parser joins
# `g\<newline>h`, `g""h` and `g\h` into `gh`, as bash does. Case is folded,
# because macOS runs `GH` as gh. The board-MCP tools skip this test: the matcher
# already limits them to the four prose-carrying tools.
#
# Fail toward running the check: with no jq to read the tool name, the payload
# goes to the parser as before.
if command -v jq >/dev/null 2>&1; then
  TOOL=$(printf '%s' "$PAYLOAD" | jq -r '.tool_name // empty' 2>/dev/null)
  if [ "$TOOL" = "Bash" ]; then
    BSNL=$'\\\n'  # a backslash-newline, quoted below so bash 3.2 reads it literally
    RAW=$(printf '%s' "$PAYLOAD" | jq -r '(.tool_input // {}).command // empty | tostring' 2>/dev/null)
    WORDS=$(printf '%s' "${RAW//"$BSNL"/}" | tr -d "\"'\\\\")
    shopt -s nocasematch
    [[ $WORDS =~ (^|[^[:alnum:]_-])gh([^[:alnum:]_-]|$) ]] || exit 0
    if ! [[ $WORDS =~ (^|[^[:alnum:]_-])api([^[:alnum:]_-]|$) ]]; then
      [[ $WORDS =~ (^|[^[:alnum:]_-])(pr|issue|release)([^[:alnum:]_-]|$) ]] || exit 0
      [[ $WORDS =~ (^|[^[:alnum:]_-])(create|edit|comment|review)([^[:alnum:]_-]|$) ]] || exit 0
    fi
    shopt -u nocasematch
  fi
fi

LIB_DIR="$(cd "$(dirname "$0")" && pwd)/lib"
CHECKER="$LIB_DIR/prose-check.py"
[ -f "$CHECKER" ] || exit 0

PROSE=$(printf '%s' "$PAYLOAD" | python3 -c '
import json, os, re, sys

# The parser shared with the other Bash guards, so a `gh` call is found the way
# bash finds it: after `&&` with no space, inside `( … )`, by absolute path, in
# another case, and across a backslash-newline. A plain shlex.split kept each of
# those glued to its neighbour, and the call was never read.
sys.path.insert(0, sys.argv[1])
from shell_parse import base, split_statements, strip_noop, token_lines_ex

# Subcommands whose payload is prose a person reads. `gh pr view`, `gh pr diff`,
# and friends carry no body and never reach the checker.
PROSE_COMMANDS = {
    ("pr", "create"), ("pr", "edit"), ("pr", "comment"), ("pr", "review"),
    ("issue", "create"), ("issue", "edit"), ("issue", "comment"),
    ("release", "create"), ("release", "edit"),
}
INLINE_FLAGS = {"--body", "-b", "--notes", "-n", "--message", "-m"}
FILE_FLAGS = {"--body-file", "-F", "--notes-file"}
# `gh api` posts the same prose as a named field. A field is prose when the last
# name in its key is one of these, so `body` and `comments[][body]` both count.
# A GraphQL mutation carries its prose inside the query, so a `query` field that
# is a mutation counts too. A GET sends nothing, so it is never read.
API_FIELD_FLAGS = {"-f", "--raw-field", "-F", "--field"}
API_PROSE_KEYS = {"body", "title"}
# Identifiers, not prose. Everything else in an MCP payload is checked.
SKIP_KEYS = {
    "id", "item_id", "issue_id", "pr_id", "node_id", "url", "html_url",
    "owner", "repo", "repository", "number", "sha", "ref", "branch",
    "state", "status", "slug", "event", "login", "assignee",
}

class Unreadable(Exception):
    """A named file could not be read, so the whole call is let through."""

def read_file(value, cwd):
    path = value if os.path.isabs(value) else os.path.join(cwd, value)
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read()
    except OSError:
        raise Unreadable()

def prose_strings(node):
    """Every string under a prose key, at any depth of a JSON body."""
    if isinstance(node, dict):
        for key, value in node.items():
            if key in API_PROSE_KEYS and isinstance(value, str):
                yield value
            else:
                yield from prose_strings(value)
    elif isinstance(node, list):
        for value in node:
            yield from prose_strings(value)

def from_api(args, cwd, stdin):
    parts = []
    method = ""
    index = 0
    while index < len(args):
        token = args[index]
        following = args[index + 1] if index + 1 < len(args) else None
        if token.startswith("--"):
            name, eq, inline = token.partition("=")
            value, step = (inline, 1) if eq else (following, 2)
        elif token[:2] in ("-f", "-F", "-X") and len(token) > 2:
            name, value, step = token[:2], token[2:], 1  # a glued value, -fbody=x
        else:
            name, value, step = token, following, 2
        if name in ("-X", "--method"):
            method = (value or "").upper()
        elif name in API_FIELD_FLAGS and value is not None:
            key, _, field = value.partition("=")
            words = re.findall(r"[A-Za-z_]+", key)
            leaf = words[-1] if words else ""
            if name in ("-F", "--field") and field == "@-":
                field = stdin or ""
            elif name in ("-F", "--field") and field.startswith("@"):
                field = read_file(field[1:], cwd)
            if leaf in API_PROSE_KEYS:
                parts.append(field)
            elif leaf == "query" and field.lstrip().startswith("mutation"):
                parts.append(field)
        elif name == "--input" and value is not None and (value != "-" or stdin is not None):
            text = stdin if value == "-" else read_file(value, cwd)
            try:
                parts.extend(prose_strings(json.loads(text)))
            except ValueError:
                raise Unreadable()
        else:
            step = 1
        index += step
    return [] if method == "GET" else parts

def from_gh(args, cwd, stdin):
    verbs = [t for t in args if not t.startswith("-")][:2]
    if verbs[:1] == ["api"]:
        return from_api(args[args.index("api") + 1:], cwd, stdin)
    if len(verbs) < 2 or (verbs[0], verbs[1]) not in PROSE_COMMANDS:
        return []
    parts = []
    for i, token in enumerate(args):
        value = args[i + 1] if i + 1 < len(args) else ""
        if token in INLINE_FLAGS and value:
            parts.append(value)
        elif token in FILE_FLAGS and value == "-":
            # Standard input from a pipe or a file redirect is not in the
            # command text, so it contributes nothing, as before.
            if stdin is not None:
                parts.append(stdin)
        elif token in FILE_FLAGS and value:
            parts.append(read_file(value, cwd))
    return parts

def stage_stdin(stage, bodies):
    """The heredoc body or here-string a stage reads as standard input, or None.

    The parser lifts heredoc bodies out of the text in order, keyed by
    delimiter, and leaves `<<` and the delimiter on the stage. So every `<<` in
    the command takes the next body under its delimiter, whether or not its
    stage runs gh, and the queues stay in step. `<<-EOF` tokenises as `<<` then
    `-EOF`, and `<<- EOF` as `<<`, `-`, `EOF`. The last redirect wins, as in
    bash."""
    stdin = None
    for i, token in enumerate(stage):
        following = stage[i + 1:i + 3]
        if token == "<<<" and following:
            stdin = following[0]
        elif token == "<<" and following:
            word = following[1] if following[0] == "-" and len(following) > 1 else following[0]
            delimiter = word.lstrip("-").strip("\x27\"")  # \x27: this code sits in single quotes
            queue = bodies.get(delimiter) or []
            stdin = queue.pop(0) if queue else None
    return stdin

def from_bash(command, cwd):
    lines, _exact, bodies = token_lines_ex(command)
    parts = []
    try:
        for tokens in lines:
            for stages in split_statements(tokens):
                for stage in stages:
                    stage = strip_noop(stage)
                    stdin = stage_stdin(stage, bodies)
                    # Anywhere in the stage, not only at its head: a retry that
                    # merged two lines puts a `gh` call after the first line.
                    at = next((i for i, t in enumerate(stage) if base(t) == "gh"), None)
                    if at is not None:
                        parts.extend(from_gh(stage[at + 1:], cwd, stdin))
    except Unreadable:
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
' "$LIB_DIR" 2>/dev/null) || exit 0

# Glob, not "${PROSE//[[:space:]]/}". Pattern-substitution with a character class
# re-measures the string at every position, which makes it quadratic in payload
# length. Measured end to end through this guard on whitespace-heavy prose:
# 8 KB took 32.8s and 12 KB took 101.8s. A slow PreToolUse hook does not
# degrade: it freezes the tool call it guards. One instance was caught pinned at
# a full core for over three minutes. The glob answers the same question, forks
# nothing, and short-circuits on the first non-whitespace character. It stays
# linear even on pure whitespace, its worst case: 0.009s at 64 KB.
#
# The six ASCII whitespace characters are listed rather than matched with
# [[:space:]], because that class is a property of the C library and not only of
# the locale. glibc excludes U+00A0, U+202F and U+2007 in every locale, Darwin
# includes them, and neither agrees with itself between a UTF-8 locale and
# LC_ALL=POSIX on U+2028, U+3000 and U+205F. A payload of nothing but NBSPs was
# therefore skipped on macOS and checked on Linux. Listing the set makes that
# decision the same everywhere, and errs toward RUNNING the check: a payload
# with no ASCII text in it is now content, so the checker judges it rather than
# the hook waving it through. Verified identical on Darwin (bash 3.2) and glibc
# 2.39 (bash 5.2) under LC_ALL=POSIX, C.UTF-8 and en_US.UTF-8.
PROSE_WS=$' \t\n\r\v\f'
[[ $PROSE == *[!$PROSE_WS]* ]] || exit 0

FINDINGS=$(printf '%s' "$PROSE" | python3 "$CHECKER" 2>/dev/null)
[ -n "$FINDINGS" ] || exit 0

{
  echo "🛑 Blocked: this text breaks the Clear standard, and other people read it."
  echo
  echo "$FINDINGS"
  echo
  echo "Rewrite the body, then send it again. The rules are in your output style:"
  echo "verdict first, reasons next, short plain paragraphs a tired reader follows."
  echo "Re-read the WHOLE document after editing. Length is a property of the"
  echo "finished text, not of the paragraph you just appended."
} >&2
exit 2
