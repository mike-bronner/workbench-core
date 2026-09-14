#!/usr/bin/env python3
"""scan-query: read a repo scan's own search query out of a tool call.

Used by hooks/memory-scan-recall.sh, which searches the memory vault with
whatever the agent is already searching the codebase for. This file answers one
question and nothing else: *does this tool call carry a content-search query,
and what is it?*

WHAT IT DOES NOT DO. It never judges whether a search is worth running, whether
the agent needs a memory, or whether the query looks promising. Producing no
query means "there is no query in this tool call", never "this one is not worth
it". That distinction is the whole safety argument for the hook — see the vault
insight 2026-09-14-conditional-that-adds-versus-gates.

WHY ONLY CONTENT SEARCHES. A content search matches a REGEX AGAINST FILE TEXT,
so its pattern is the topic the agent is chasing: `rg 'memory recall dedup'` is a
question about memory recall dedup, and the vault can answer it. A path search
matches a FILENAME SHAPE. `**/*.test.ts` and `find . -name '*.sh'` carry no
topic at all, and `src/**/*.ts` carries two words of noise. Firing on those
spends a permanently-persisted transcript record to inject a memory nobody
asked about, so path searches — the Glob tool, `find`, `fd`, `ls` — are left
out deliberately rather than by oversight.

USAGE:
    printf '%s' "$value" | python3 scan-query.py <tool-name>

<tool-name> is the hook payload's tool_name. The value on stdin is the Grep
tool's `pattern`, or the Bash tool's `command`. Prints the normalised query on
stdout, or nothing. Always exits 0 — the caller fails open.

TOKENS, NOT SUBSTRINGS. The Bash path reuses hooks/lib/shell_parse.py, which
exists so a rule can read an argument SLOT instead of characters. It matters
here for the same reason it matters to the guards that import it: in
`git log --grep="rg foo"` the word `rg` is data, not a command, and in
`cat notes | grep recall` the search is in the second pipeline stage.
"""

import os
import re
import sys

# shell_parse lives beside this file. Python puts the SCRIPT's directory at
# sys.path[0] when the script is run by path, so on an ordinary invocation this
# is redundant — it is here for the case where it is not.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from shell_parse import (  # noqa: E402
    base,
    extract_heredocs,
    split_statements,
    strip_noop,
    token_lines,
)

# Content searchers, split by flag dialect. The split is not cosmetic: `-r` takes
# a VALUE in ripgrep (--replace) and takes NONE in grep (--recursive), so one
# shared table would eat the pattern out of `grep -r pattern .`.
RIPGREP = {"rg", "ripgrep"}
GREP_FAMILY = {"grep", "egrep", "fgrep", "ag", "ack", "ack-grep", "ugrep"}

# Flags whose VALUE is the pattern, so the pattern is not the first positional.
PATTERN_LONG = {"--regexp"}
PATTERN_SHORT = {"-e"}

# Flags that move the patterns into a FILE. The invocation then has no inline
# pattern at all, and its first positional is a PATH — `grep -f patterns.txt
# src/` would otherwise hand back "src" and search the vault for a directory
# name. Treated as "no query" for every tool here, including the two where `-f`
# means something else (`ag -f` follows symlinks): a missed recall is the cheap
# error and a junk query is the expensive one.
PATTERN_FILE_FLAGS = {"-f", "--file"}

# Flags that consume the following token, so the token after them is a value and
# never the pattern. Missing one costs a junk query; inventing one costs a
# dropped pattern. Both degrade to a no-op the next scan repairs.
GREP_VALUE_FLAGS = {
    "-e", "--regexp", "-f", "--file", "-m", "--max-count",
    "-A", "--after-context", "-B", "--before-context", "-C", "--context",
    "-D", "--devices", "-d", "--directories", "--binary-files", "--label",
    "--include", "--exclude", "--exclude-dir", "--exclude-from",
    "--color", "--colour", "--group-separator",
    # ag / ack
    "-G", "--ignore", "--ignore-dir", "--pager", "--type-set",
}
RIPGREP_VALUE_FLAGS = {
    "-e", "--regexp", "-f", "--file", "-m", "--max-count",
    "-A", "--after-context", "-B", "--before-context", "-C", "--context",
    "-g", "--glob", "--iglob", "-t", "--type", "-T", "--type-not", "--type-add",
    "-M", "--max-columns", "-j", "--threads", "--sort", "--sortr",
    "-r", "--replace", "-E", "--encoding", "--engine",
    "--max-depth", "--max-filesize", "--context-separator", "--field-context-separator",
    "--field-match-separator", "--path-separator", "--ignore-file", "--pre",
    "--colors", "--color", "--hostname-bin", "--dfa-size-limit", "--regex-size-limit",
}

# Cap the query. A search pattern is short; anything longer is a pasted blob
# whose tail only skews ranking, and every byte injected persists.
MAX_QUERY_CHARS = 200


def extract_pattern(tokens, value_flags):
    """The pattern argument of one already-identified search invocation.

    <tokens> starts AFTER the program name. Returns the raw pattern string, or
    None when the invocation carries none (a `-f patterns.txt` run, a bare
    `rg --files`, a truncated command).
    """
    i = 0
    while i < len(tokens):
        token = tokens[i]

        # Everything after `--` is a positional, so the next one is the pattern.
        if token == "--":
            return tokens[i + 1] if i + 1 < len(tokens) else None

        if token.startswith("--"):
            name, sep, value = token.partition("=")
            if name in PATTERN_FILE_FLAGS:
                return None
            if name in PATTERN_LONG:
                if sep:
                    return value
                return tokens[i + 1] if i + 1 < len(tokens) else None
            # `--include=*.sh` carries its own value; `--include *.sh` eats the
            # next token.
            i += 1 if (sep or name not in value_flags) else 2
            continue

        if token.startswith("-") and len(token) > 1:
            # A short cluster: -rn, -e, -A3, -ie PATTERN. Walk it character by
            # character, because the pattern flag can sit anywhere inside.
            body = token[1:]
            consumed_next = False
            for j, char in enumerate(body):
                short = "-" + char
                rest = body[j + 1:]
                if short in PATTERN_FILE_FLAGS:
                    return None
                if short in PATTERN_SHORT:
                    if rest:
                        return rest
                    return tokens[i + 1] if i + 1 < len(tokens) else None
                if short in value_flags:
                    # An attached value ends the cluster; a detached one eats
                    # the following token.
                    consumed_next = not rest
                    break
            i += 2 if consumed_next else 1
            continue

        # First positional. For every tool here, that slot is the pattern.
        return token

    return None


def find_query(command):
    """Walk a shell command for the first content search that carries a pattern."""
    text, _bodies = extract_heredocs(command)
    for line in token_lines(text):
        for statement in split_statements(line):
            for stage in statement:
                tokens = strip_noop(stage)
                if not tokens:
                    continue
                head = base(tokens[0])
                if head == "git":
                    # `git grep PATTERN` searches file contents. `git log
                    # --grep=` searches commit messages, which is history rather
                    # than the tree, so it is not a repo scan.
                    if len(tokens) > 1 and tokens[1] == "grep":
                        found = extract_pattern(tokens[2:], GREP_VALUE_FLAGS)
                    else:
                        found = None
                elif head in RIPGREP:
                    found = extract_pattern(tokens[1:], RIPGREP_VALUE_FLAGS)
                elif head in GREP_FAMILY:
                    found = extract_pattern(tokens[1:], GREP_VALUE_FLAGS)
                else:
                    found = None
                if found:
                    return found
    return None


def normalise(pattern):
    """A regex is not a search query. Reduce it to the words inside it.

    `memory-recall|memory_recall` and `def\\s+recall\\(` are regexes whose
    metacharacters mean nothing to a vault search and skew a BM25 score. Every
    non-alphanumeric run becomes a space, which strips anchors, classes,
    quantifiers, quotes and path separators in one pass and leaves the words.

    Two passes then clear what that leaves behind. Single characters go, because
    they are almost always the tail of an escape — `\\s`, `\\d`, `\\b`, `\\(` all
    reduce to one letter — and a one-letter term carries no search signal
    anyway. Repeats go, because an alternation names the same word twice by
    construction (`memory-recall|memory_recall`) and the duplicate is regex
    syntax rather than emphasis. Both shrink a payload that persists forever.
    """
    words = re.sub(r"[^0-9A-Za-z]+", " ", pattern).split()
    seen = set()
    kept = []
    for word in words:
        if len(word) < 2:
            continue
        lowered = word.lower()
        if lowered in seen:
            continue
        seen.add(lowered)
        kept.append(word)
    return " ".join(kept)[:MAX_QUERY_CHARS].strip()


def main():
    tool = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        value = sys.stdin.read()
    except (OSError, UnicodeDecodeError):
        return 0
    if not value.strip():
        return 0

    if tool == "Grep":
        # The Grep tool's `pattern` IS the query, with no shell around it.
        pattern = value.strip()
    elif tool == "Bash":
        try:
            pattern = find_query(value)
        except Exception:  # noqa: BLE001 — a parse failure is a no-op, never an error
            return 0
    else:
        return 0

    if not pattern:
        return 0
    query = normalise(pattern)
    if query:
        sys.stdout.write(query)
    return 0


if __name__ == "__main__":
    sys.exit(main())
