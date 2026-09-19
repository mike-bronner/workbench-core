#!/usr/bin/env python3
"""scratch-delete-check: the parsing half of hooks/scratch-delete-guard.sh.

THIS FILE DECIDES NOTHING ABOUT SCRATCH ROOTS, AND THAT IS THE WHOLE DESIGN.

The guard refuses an `rm` aimed at a scratchpad path and sends the agent to
`bin/scratch-rm.sh` instead. For that to be a route rather than a dead end, the
two must agree about which paths that script accepts — a guard that refuses an
`rm` the helper then refuses as well leaves the agent with two closed doors.

So "is this path beneath an approved scratch root" is never asked here. It is
asked of the helper itself, through its `--check` mode, by the shell half. This
file answers the mechanical question only: WHICH ABSOLUTE PATHS is this command
about to delete, and is deleting them the only thing it does? Root logic lives
in exactly one place, and this is not that place.

WHAT COUNTS AS A CANDIDATE, AND WHY THE BAR IS THIS HIGH.
Paths are printed only when the whole command is delete-and-nothing-else: every
statement is `rm` or `rmdir` (a leading `cd` and the no-op prefixes in
shell_parse.PREFIX_NOOP aside), and every path operand of every one of them
resolves to an absolute path with no shell expansion left in it. Anything less
prints nothing.

That bar is high because a deny costs the whole command, not the part this
guard understands. `mkdir -p x && rm -rf y` replaced by a scratch-rm call
silently drops the mkdir; `rm -rf /scratch/a /etc/b` has no scratch-rm spelling
at all, since the helper takes one path and would refuse the second. When the
recovery cannot be stated exactly, the command is left alone and the ordinary
permission flow prompts, which is what happens today. Missing a shape costs a
prompt. Guessing at one costs work.

FAIL OPEN, like every guard in this repo, and by the vault-git-guard's reason:
there is no adversary. The threat is an agent reaching for `rm -rf` by reflex,
not a crafted payload. An unparseable command prints nothing and the call goes
through to the prompt it would have hit anyway.

KNOWN LIMITS, stated rather than hidden. A command reaching `rm` through
`bash -c`, `ssh`, `xargs`, or `find -delete` is not followed: each one prints
nothing and prompts as before. Globs, `$variables`, command substitution, and
`~user` are all refused as operands for the same reason — the text does not say
which paths are meant, and this file resolves nothing it cannot read.

Output: one absolute path per candidate operand, NUL-separated, in the order
the command names them. No candidates prints nothing. Exit status is always 0;
it carries no verdict, because this file makes none.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from shell_parse import (  # noqa: E402
    base,
    split_statements,
    strip_noop,
    token_lines,
)

MAX_INPUT = 200_000

DELETE_VERBS = {"rm", "rmdir"}

# A redirection makes the command do something besides delete, and its target
# is a token in the same stage that is not a path operand. Both reasons say the
# same thing: this is not a command a scratch-rm call replaces.
REDIRECTS = {"<", ">", ">>", "<<", "<<<", ">&", "<&"}

# Characters that mean the token is not the path it looks like. A glob stands
# for a set the shell has not expanded yet, `$` and a backtick stand for text
# that is not here, and `~` needs a home directory this file must not choose —
# bin/scratch-rm.sh refuses to take a root from the environment, and resolving
# `~` here would hand it one through the back door.
UNRESOLVABLE = set("*?[]{}$`~")


def operands(tokens):
    """The path arguments of one delete command, or None if it has none or
    carries an option this file cannot account for.

    Options are dropped by shape rather than by table. `rm` and `rmdir` take no
    option that consumes a SEPARATE argument on either macOS or GNU — the ones
    with values (`--preserve-root=`, `--interactive=`) are `=`-joined — so a
    leading `-` is always an option and never a path, and everything after `--`
    is always a path and never an option.
    """
    paths = []
    rest = list(tokens)
    literal = False
    while rest:
        token = rest.pop(0)
        if not literal and token == "--":
            literal = True
            continue
        if not literal and token.startswith("-") and token != "-":
            continue
        paths.append(token)
    return paths or None


def absolute(token, cwd):
    """The absolute path a delete operand names, or None when the text does not
    settle one. A relative path needs the call's own directory: without it the
    same token names a different file in every directory on the machine, so it
    settles nothing and is dropped."""
    if not token or any(character in UNRESOLVABLE for character in token):
        return None
    if os.path.isabs(token):
        return token
    if not cwd:
        return None
    return os.path.join(cwd, token)


def candidates(command, cwd):
    """Every path the command deletes, or [] unless deleting is all it does."""
    lines = token_lines(command)
    if not lines:
        return []

    found = []
    for tokens in lines:
        here = cwd
        for stages in split_statements(tokens):
            # A pipeline is not a delete. `rm` reads no stdin and writes
            # nothing a pipe would carry, so a staged command containing one is
            # a shape this file does not claim to understand.
            if len(stages) != 1:
                return []
            stage = strip_noop(stages[0])
            if not stage:
                continue
            if any(token in REDIRECTS for token in stage):
                return []
            verb = base(stage[0])

            # `cd <dir> && rm -rf x` is the shape a relative operand usually
            # arrives in, and the cd is tracked rather than refused because it
            # deletes nothing itself. An absolute cd settles the directory with
            # no cwd to resolve against, which is what keeps this working when
            # the payload carried none.
            if verb == "cd" and len(stage) > 1:
                destination = stage[1]
                if any(c in UNRESOLVABLE for c in destination):
                    return []
                if os.path.isabs(destination):
                    here = destination
                elif here:
                    here = os.path.join(here, destination)
                else:
                    return []
                continue

            if verb not in DELETE_VERBS:
                return []

            paths = operands(stage[1:])
            if paths is None:
                return []
            for path in paths:
                resolved = absolute(path, here)
                if resolved is None:
                    return []
                found.append(resolved)
    return found


def main():
    command = sys.stdin.read(MAX_INPUT)
    if not command.strip():
        return 0
    cwd = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else None
    if cwd:
        cwd = os.path.expanduser(cwd)
    for path in candidates(command, cwd):
        sys.stdout.write(path + "\0")
    return 0


if __name__ == "__main__":
    sys.exit(main())
