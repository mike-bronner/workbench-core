#!/usr/bin/env python3
"""credential-check: decide whether a `.env` in a command is a path or prose.

Reads one shell command on stdin — argv would mangle the quoting, and the
quoting is the entire question. Prints `allow` and exits 1 when every dotenv
mention in the command is prose or a committed template. Prints nothing and
exits 0 otherwise, which leaves in place the block that hooks/credential-guard.sh
has already decided on.

THE EXIT CODES LOOK BACKWARDS AND ARE NOT:
This is a REFINEMENT pass, not a guard. It runs only after the guard's stage-1
regex has already matched, so its output can only ever narrow that block, never
create one. So the failure direction is the reverse of the other two checkers:
0 — the value a crashed interpreter, a missing file, and an absent python3 all
produce one way or another — must mean KEEP BLOCKING. Allowing has to be the
value nothing produces by accident.

That is also why `allow` is printed. A Python traceback exits 1, the same code
this file returns for allow, so the exit code alone would read a crash as
permission to proceed. A crash writes its traceback to stderr and leaves stdout
empty, so the guard requires both halves and a crash fails closed.

WHAT STAGE 1 CANNOT ASK:
The guard tests `\\.env(?![A-Za-z0-9_-])` against the raw command TEXT. A
command that merely DISCUSSES a dotenv file carries exactly the same characters
as one that reads it, so on 2026-09-04 that test blocked a `gh pr merge` body
about dotenv handling, the plugin's own setup snippet, and a python3 heredoc
whose prose named two dotenv files. None of them opened a file.

The question that separates them is the one hooks/lib/shell_parse.py exists to
answer: does the `.env` sit in an argument SLOT, or inside a string? A path is
one token with no whitespace in it. A sentence is one token FULL of whitespace,
because the shell already collapsed the quotes around it. That single property
does all the work here.

DIR_RE IS DELIBERATELY NOT ROUTED THROUGH THIS FILE, and the whitespace rule is
why. `python3 -c "x = open('$HOME/.ssh/id_rsa')"` tokenises to one token with
spaces in it, so this rule would ALLOW it — the exact call the removed
Read(~/.ssh/**) deny rule missed and the guard exists to catch. The dotenv rule
can afford the rule because a dotenv path is short, relative, and ordinary;
a credential-directory path is none of those.

HEREDOC BODIES ARE SCANNED, NOT DISCARDED:
`python3 <<PY` … `open(".env")` … `PY` is a real read hiding in a body, so the
bodies come out via extract_heredocs and are judged by the same rule. A body is
not shell, so it will sometimes not tokenise — a bare apostrophe outside a
string is enough. THE STATED LIMIT, deliberate rather than an oversight: a
segment that does not parse keeps the block. Refusing to relax a block on text
this file could not read is the only safe direction, and the shapes prose
actually takes are fine — shlex reads an apostrophe inside a quoted string as
an ordinary character, and drops a `#` comment before it reads it at all.
"""

import os
import re
import sys

# The shared parser sits beside this file. Resolve it from __file__ and never
# from the working directory: a PreToolUse hook is invoked with whatever cwd the
# tool call had, which is arbitrary and usually not this directory. CPython
# already puts a script's own directory on sys.path when the script is run by
# path; this is the explicit belt for `python3 -P` and PYTHONSAFEPATH=1, since
# the hook runs whatever python3 the environment provides. Unlike the other two
# guards, a missed import here fails CLOSED — noisily, not silently.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from shell_parse import extract_heredocs, token_lines  # noqa: E402

MAX_INPUT = 200_000

# The guard's own stage-1 rule, repeated so a token is judged by the same test
# the command text was. `.env` and `.env.production`, never `.envrc`: a prefix
# test is not a name test, and the lookahead is the difference.
DOTENV_RE = re.compile(r"\.env(?![A-Za-z0-9_-])")

# A committed template holds placeholder values by convention, not secrets, so
# reading one exposes nothing. Anchored at the end of the path component, so
# `.env.example.bak` stays a hit — an unanchored suffix test would admit any
# token that merely contains the word. hooks/credential-guard.sh carries the
# same list for the file tools' single-path branch; the two must stay in step.
TEMPLATE_RE = re.compile(
    r"\.env[^/]*\.(example|sample|template|dist|defaults?)$", re.IGNORECASE)

# Named rather than literal, because 0 and 1 read backwards here on purpose.
BLOCK = 0
ALLOW = 1
ALLOW_SENTINEL = "allow"


def reads_dotenv(token):
    """Is this token a path to a real dotenv file, rather than a mention of one?

    Whitespace is the discriminator. `cat .env` puts `.env` in a token of its
    own, and `python3 -c "print(open('.env').read())"` puts it in a token with
    no spaces either, because the code carries none. A sentence about a dotenv
    file is one token full of spaces — the shell removed the quotes that held
    it together, and nothing else in a command looks like that."""
    if not DOTENV_RE.search(token):
        return False
    if any(character.isspace() for character in token):
        return False
    return not TEMPLATE_RE.search(token)


def segments(command):
    """The command text, then each heredoc body, as separately-parsable units.

    A body is prose to the tokeniser and would wreck the line it hangs off, so
    it is lifted out first and judged on its own."""
    stripped, bodies = extract_heredocs(command)
    yield stripped
    for group in bodies.values():
        for body in group:
            yield body


def main():
    command = sys.stdin.read(MAX_INPUT)
    if not command.strip():
        return BLOCK
    for segment in segments(command):
        if not segment.strip():
            continue
        lines = token_lines(segment)
        if not lines:
            # Unparseable. Say nothing about text that could not be read: this
            # pass only ever relaxes, so silence has to mean the block stands.
            return BLOCK
        for tokens in lines:
            for token in tokens:
                if reads_dotenv(token):
                    return BLOCK
    print(ALLOW_SENTINEL)
    return ALLOW


if __name__ == "__main__":
    sys.exit(main())
