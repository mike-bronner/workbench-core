#!/usr/bin/env python3
"""shell_parse: the mechanical half of reading a shell command.

WARNING — TWO SAFETY GUARDS IMPORT THIS FILE, AND BOTH FAIL SILENTLY.

hooks/lib/destructive-db-check.py is the enforcement behind
hooks/destructive-database-guard.sh, which exists because a real development
database was destroyed on 2026-09-04. hooks/lib/vault-git-check.py is the
enforcement behind hooks/vault-git-guard.sh. Both hooks fail OPEN by design: a
checker that cannot run exits 0, and exit 0 means allow. So a change here that
raises, renames a symbol, or merely re-splits a command differently does not
produce an error anybody sees. It produces a guard that never blocks again.

Run BOTH suites after touching anything below:
    hooks/test-destructive-database-guard.sh
    hooks/test-vault-git-guard.sh

WHAT BELONGS HERE, AND WHAT DOES NOT:
Only mechanical parsing — tokenising, splitting a line into statements and
pipeline stages, lifting heredoc bodies out of the way, and dropping the no-op
prefixes that push the real command further along the token list. No rules. No
verb tables, no regexes over payloads, no blocking decisions. Those stay in the
guard that owns them, because the two guards read the same command differently
and a shared rule would have to be wrong for one of them.

The sharpest instance is `ssh`, and it is why unwrap() is deliberately NOT here.
The database guard follows a command through ssh, because a database on another
host is still a database being destroyed. The vault guard stops dead at it,
because another machine's vault is not this vault and reading it could only ever
produce a false block. Same token, opposite meaning. Each guard keeps its own
unwrap().

The tokenising story, which both guards depend on: a substring match cannot
decide any of this. `grep -rn "drop table" app/` and `git log --grep="git rm"`
both contain a destructive verb and neither touches anything. So text is split
into tokens with shlex, operators become tokens of their own, and a rule reads
the argument SLOT rather than the characters. That is the single property this
module exists to provide.
"""

import os
import re
import shlex

# Wrappers stripped before the verb slot is read. Each one puts the real command
# further along the token list, which is exactly what a prefix permission rule
# cannot see — `cd foo && php artisan db:wipe` is the shape the database
# incident took, and `cd vault && git rm note.md` is the shape of the vault one.
PREFIX_NOOP = {"sudo", "doas", "env", "nice", "ionice", "time", "nohup",
               "command", "exec", "stdbuf"}

STATEMENT_SEPARATORS = {";", "&&", "||", "&", "(", ")", "{", "}"}
PIPE = "|"

ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
HEREDOC_START = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")


def base(token):
    """The bare program name, so /usr/local/bin/psql matches psql."""
    return os.path.basename(token)


def tokenize(text):
    """Split shell text into tokens, with operators as tokens of their own."""
    lexer = shlex.shlex(text, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    return list(lexer)


def tokenize_loose(text):
    """The posix=False retry. Quotes stay attached, which the SQL regexes
    tolerate and the verb rules mostly do not need."""
    lexer = shlex.shlex(text, posix=False, punctuation_chars=True)
    lexer.whitespace_split = True
    return list(lexer)


def token_lines(text):
    """Tokenise line by line so a newline separates statements, since shlex
    treats it as plain whitespace and would otherwise merge them. A line that
    will not parse on its own is usually one arm of a multi-line quoted string,
    so the whole text is retried as a single unit before giving up."""
    lines = [line for line in text.split("\n") if line.strip()]
    for parser in (tokenize, tokenize_loose):
        try:
            return [parser(line) for line in lines]
        except ValueError:
            pass
        try:
            return [parser(text)]
        except ValueError:
            pass
    return []


def extract_heredocs(command):
    """Lift heredoc bodies out of the command text, keyed by delimiter.

    The body is prose to the tokeniser and would wreck it. Pulling it out first
    leaves `psql -d app <<SQL` on the line, which tokenises cleanly, and the
    delimiter token is what points back at the body."""
    bodies = {}
    kept = []
    lines = command.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i]
        kept.append(line)
        delimiters = [m.group(2) for m in HEREDOC_START.finditer(line)]
        i += 1
        for delimiter in delimiters:
            body = []
            while i < len(lines) and lines[i].strip() != delimiter:
                body.append(lines[i])
                i += 1
            i += 1  # the delimiter line itself
            bodies.setdefault(delimiter, []).append("\n".join(body))
    return "\n".join(kept), bodies


def skip_flags(tokens, value_flags):
    """Drop leading option tokens, taking a separate value with the flags that
    need one, so the next token returned is a real argument."""
    rest = list(tokens)
    while rest and rest[0].startswith("-") and rest[0] != "--":
        flag = rest[0]
        rest = rest[1:]
        if flag in value_flags and "=" not in flag and rest:
            rest = rest[1:]
    return rest


def strip_noop(tokens):
    """Drop env assignments and no-op prefixes such as `sudo` and `nice`, and
    nothing else. A caller that needs to read the wrapper itself — the Docker
    rules read the docker binary and its subcommand — must call this rather than
    its own unwrap(), which strips on through to the inner command."""
    rest = list(tokens)
    while rest:
        if ASSIGNMENT.match(rest[0]):
            rest = rest[1:]
            continue
        head = base(rest[0])
        if head not in PREFIX_NOOP:
            break
        rest = rest[1:]
        if head == "env":
            while rest and ASSIGNMENT.match(rest[0]):
                rest = rest[1:]
    return rest


def split_statements(tokens):
    """Statements split on the sequencing operators, stages on the pipe."""
    statements = []
    stages = [[]]
    for token in tokens:
        if token in STATEMENT_SEPARATORS:
            statements.append(stages)
            stages = [[]]
        elif token == PIPE:
            stages.append([])
        else:
            stages[-1].append(token)
    statements.append(stages)
    return [s for s in statements if any(stage for stage in s)]
