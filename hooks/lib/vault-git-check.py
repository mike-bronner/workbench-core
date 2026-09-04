#!/usr/bin/env python3
"""vault-git-check: decide whether a shell command runs a git WRITE in the vault.

Reads one shell command on stdin. argv[1] is the tool call's working directory,
argv[2] is the memory vault's path. Prints a single reason line to stdout and
exits 1 when the command writes to the vault's git; exits 0 and prints nothing
otherwise.

THE INCIDENT THIS EXISTS FOR:
On 2026-09-04 an agent deleted a memory note by running
`git -C ~/Documents/Claude/Memory rm identity/profile.md`. That is a Bash call,
so it staged a deletion in the vault's git index and stopped there. The vault's
git does not belong to the agent: the memory MCP server owns it and runs its own
deferred-commit queue. On the server's next write it swept the staged deletion
into commit 014f51b1, whose message reads
`write: insights/credential-guard-blocks-prose-about-dotenv.md`. A profile
deletion is now filed in vault history under a message describing an unrelated
note being written. Nothing about that commit says a profile was destroyed.

The agent had a correct tool available the whole time. The MCP `delete` tool
would have produced its own accurately-named commit. It was not used because
nothing said the vault's git was off limits — references/vault-conventions.md
was 76 lines and did not contain the word "git" even once. This guard is the
enforcing half of that gap; the reference document is the explaining half.

WHY A HOOK AND NOT A DENY RULE:
A deny rule matches a command PREFIX. `Bash(git rm:*)` would block `git rm` in
every repository on the machine, which is ordinary work, and would still miss
the incident command — `git -C <path> rm` puts the verb in the fourth slot. The
decision here depends on WHICH REPOSITORY the command resolves to, and no prefix
can express that. So the command is tokenised, the target directory is resolved
against the payload's cwd, and only a target inside the vault blocks.

WHAT COUNTS AS "THE REPOSITORY IS THE VAULT" — four shapes, all covered:
    git -C <vault-or-subdir> <verb>       the incident's own shape
    cd <vault-or-subdir> && git <verb>    the verb is not at the front
    git <verb>                            with the payload cwd inside the vault
    git --git-dir=<vault>/.git <verb>     also --work-tree

Every path is expanded for `~`, joined against the cwd when relative, and passed
through realpath before comparison. Comparison is by path PREFIX on a
realpathed pair, which is what stops a sibling directory whose name merely
begins the same — `.../Memory-old` next to `.../Memory` — from matching. A
leading `cd` moves the base for everything after it on the line, because that is
half of the shapes above.

A BLOCK LIST, NOT AN ALLOW LIST — and the gap that leaves:
Only the enumerated write verbs block. Anything unlisted passes. git ships over
150 subcommands and the read-only ones vastly outnumber the writes, so an allow
list would have to be near-complete on day one or it would block `git grep`,
`git shortlog`, `git for-each-ref`, `git ls-tree`, and `git count-objects` —
every one of which is legitimate verification, and several of which were used
correctly while investigating this very incident. THE STATED LIMIT, as a known
limit and not an oversight: a mutating subcommand that git adds after this ships
walks through until somebody adds it to WRITE_VERBS. That is the price of the
block list, accepted deliberately, because a guard that breaks ordinary git
inspection is a worse failure than the one it prevents.

THREE LISTED VERBS HAVE A READ-ONLY FORM, and it is honoured:
`git tag` bare lists tags, `git stash list` and `git stash show` report, and
`git branch` bare lists branches. Each is a read that an agent does routinely,
so the verb alone cannot decide — the arguments do. `branch` is narrower still:
only the deletion flags block, because creating a branch writes a ref that the
server's commit queue never sweeps, while `git branch -d` is a destructive
operation on a repository that is not the agent's.

IT STOPS AT EVERY REMOTE AND CONTAINER BOUNDARY, BY NOT UNWRAPPING AT ALL:
`ssh box "git -C /vault commit"` is allowed, and must be. That machine has its
own filesystem, so a local path of the same name is the wrong path, and blocking
on it could only ever produce a false block on somebody else's repository. Same
for docker, podman, kubectl, and the project shims.

The mechanism is absence rather than a rule: a stage whose first word is not
`git` is simply not judged, so `ssh …`, `docker exec …`, and `kubectl exec …`
are already outside this checker's reach and need no boundary list to keep them
there. An earlier draft carried one. It was deleted once a mutation test proved
no input could reach it — an unreachable branch in a guard is untested code
pretending to be a safeguard. The ONE wrapper deliberately descended into is a
shell `-c` payload, because `bash -c "cd <vault> && git rm x"` arrives as a
single quoted token that no rule over the outer command can see into.

This is the one place this checker deliberately disagrees with
hooks/lib/destructive-db-check.py, which unwraps ssh, docker, and kubectl to
follow a command THROUGH them — a database on another host is still a database
being destroyed, while another machine's vault is not this vault. That
disagreement is why unwrap() is not in the shared parser.

FAIL OPEN, on the same reasoning the other two guards give:
There is no adversary here. The threat is a confidently wrong agent, not a
crafted payload. A command that actually writes to the vault has to be valid
shell to run at all, so it tokenises. Anything unparseable is something bash
would likely reject too, and blocking it would break ordinary quoted one-liners
for nothing. A command with no resolvable target — no cwd in the payload and no
explicit path — also passes, because guessing at the target is how a guard
produces a false block on an unrelated repository. As with the other guards,
this covers Claude's own tool calls and is not an OS boundary; `/sandbox`
enforces in the kernel, for every subprocess.

The tokeniser, statement splitting, and no-op-prefix stripping come from
hooks/lib/shell_parse.py, shared with the database guard. Only that mechanical
half is shared: the verb tables and every decision below stay here.
"""

import os
import sys

# The shared parser sits beside this file. Resolve it from __file__ and never
# from the working directory: a PreToolUse hook is invoked with whatever cwd the
# tool call had, which is arbitrary and usually not this directory.
#
# Honest about what this line buys, so nobody deletes it for the wrong reason
# and nobody trusts it for the wrong one: CPython already puts a script's own
# directory at sys.path[0] when the script is run by path, so on an ordinary
# interpreter the import would resolve without this. It is the explicit belt for
# the case where that does not happen — `python3 -P`, or PYTHONSAFEPATH=1, both
# 3.11+ — since the hook runs whatever `python3` the environment provides and
# inherits its environment. A missed import here fails OPEN and in silence.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from shell_parse import (  # noqa: E402
    base,
    extract_heredocs,
    split_statements,
    strip_noop,
    token_lines,
)

MAX_INPUT = 200_000
MAX_DEPTH = 4

# Subcommands that write: to the index, the working tree, the object store, or a
# ref. Every one of them either feeds the server's deferred-commit queue (the
# incident's mechanism) or mutates a repository whose history the server owns.
#
# The last seven are additions beyond the obvious set, on one shared reason:
# each reaches the object store or the ref namespace directly, which is the same
# blast radius as a commit even though none of them looks like one.
WRITE_VERBS = {
    "commit", "add", "rm", "mv", "push", "pull", "fetch", "reset", "checkout",
    "switch", "restore", "stash", "merge", "rebase", "cherry-pick", "revert",
    "clean", "apply", "am", "tag", "branch", "init",
    "update-ref", "gc", "repack", "prune", "worktree", "notes", "symbolic-ref",
}

# `git branch` alone lists branches, and `git branch <name>` creates a ref the
# server's queue never sweeps. Only deletion blocks. Three spellings, one flag.
BRANCH_WRITE_FLAGS = {"-d", "-D", "--delete"}

# `git stash list` and `git stash show` report and change nothing. Bare
# `git stash` is NOT a read — it pushes the working tree onto the stack.
STASH_READ_SUBVERBS = {"list", "show"}

# The flags that make `git tag` a query rather than a mutation. `-n`, `-n1`,
# `-n5` all show annotation lines, so the prefix is what is matched.
TAG_READ_FLAGS = {"-l", "--list", "-i", "--ignore-case", "--column",
                  "--no-column", "--contains", "--no-contains", "--merged",
                  "--no-merged", "--points-at", "--omit-empty"}
TAG_READ_PREFIXES = ("-n", "--sort=", "--format=", "--contains=",
                     "--points-at=", "--merged=", "--no-merged=")

# git's own options, before the subcommand. These four are the ones that decide
# WHICH repository the command acts on, which is the whole question here.
# `-c` and the rest are listed only so their value is not mistaken for the verb.
GIT_VALUE_FLAGS = {"-C", "-c", "--git-dir", "--work-tree", "--namespace",
                   "--config-env", "--attr-source"}

# `bash -c "cd vault && git rm x"` arrives as one quoted token, which no rule
# over the outer command can see into, so the payload is scanned on its own.
# This is the ONLY wrapper descended into. Everything else — ssh, docker,
# kubectl, the project shims — is left alone precisely because it runs somewhere
# with its own filesystem, and a stage that does not start with `git` is never
# judged anyway. There is deliberately no boundary list here; see the header.
SHELLS = {"bash", "sh", "zsh", "dash", "ksh"}


def parse_git(tokens):
    """Read a `git …` invocation into (chdir, git_dir, work_tree, verb, args).

    Returns None when the stage is not git. The point of walking git's own
    options rather than reading tokens[1] is that `git -C <path> rm` puts the
    verb in the fourth slot — which is exactly the shape the incident took, and
    exactly what a prefix rule cannot reach."""
    if not tokens or base(tokens[0]) != "git":
        return None
    chdir = None
    git_dir = None
    work_tree = None
    index = 1
    while index < len(tokens):
        token = tokens[index]
        if not token.startswith("-"):
            break
        if token == "--":
            index += 1
            break
        name, sep, inline = token.partition("=")
        if sep:
            value, step = inline, 1
        elif name in GIT_VALUE_FLAGS and index + 1 < len(tokens):
            value, step = tokens[index + 1], 2
        else:
            index += 1
            continue
        if name == "-C":
            # Repeated -C compose, each relative to the one before it.
            chdir = value if chdir is None else os.path.join(chdir, value)
        elif name == "--git-dir":
            git_dir = value
        elif name == "--work-tree":
            work_tree = value
        index += step
    verb = tokens[index] if index < len(tokens) else None
    return chdir, git_dir, work_tree, verb, tokens[index + 1:]


def resolve(path, cwd):
    """Absolute, symlink-free form of a path the command named.

    None when a relative path has no base to resolve against, because a guess
    at the base is how this guard would block an unrelated repository."""
    if path is None:
        return None
    expanded = os.path.expanduser(path)
    if not os.path.isabs(expanded):
        if cwd is None:
            return None
        expanded = os.path.join(cwd, expanded)
    return os.path.realpath(expanded)


def target_dirs(chdir, git_dir, work_tree, cwd):
    """Every directory this invocation could be acting on.

    `-C` replaces the cwd for the whole command, so it is resolved first and
    becomes the base for anything else. An explicit --git-dir or --work-tree
    then overrides where the repository actually is."""
    here = resolve(chdir, cwd) if chdir is not None else (
        os.path.realpath(cwd) if cwd else None)
    found = []
    for explicit in (git_dir, work_tree):
        got = resolve(explicit, here if here is not None else cwd)
        if got is None:
            continue
        found.append(got)
        # `--git-dir=<vault>/.git` names the repository's internals, whose work
        # tree is the parent. Check both, so either spelling matches the vault.
        if os.path.basename(got) == ".git":
            found.append(os.path.dirname(got))
    if not found and here is not None:
        found.append(here)
    return found


def inside(path, vault):
    """True when path IS the vault or sits under it.

    The separator is why this is not a bare startswith: `<...>/Memory-old`
    starts with `<...>/Memory` and is a different repository entirely."""
    return path == vault or path.startswith(vault + os.sep)


def verb_is_write(verb, args):
    """Does this subcommand mutate the repository it resolves to?

    Three listed verbs have a read-only form that an agent uses routinely, so
    for those the arguments decide rather than the verb alone."""
    if verb not in WRITE_VERBS:
        return False
    if verb == "branch":
        return any(arg in BRANCH_WRITE_FLAGS for arg in args)
    if verb == "stash":
        words = [arg for arg in args if not arg.startswith("-")]
        return not (words and words[0] in STASH_READ_SUBVERBS)
    if verb == "tag":
        for arg in args:
            if arg in TAG_READ_FLAGS or arg.startswith(TAG_READ_PREFIXES):
                return False
        # Listing takes no tag name; creating and deleting both need one.
        return any(not arg.startswith("-") for arg in args)
    return True


def check_stage(stage, cwd, vault, depth):
    """One pipeline stage: is this a git write inside the vault?"""
    tokens = strip_noop(stage)
    if not tokens:
        return []
    head = base(tokens[0])
    if head in SHELLS and "-c" in tokens:
        index = tokens.index("-c")
        if index + 1 < len(tokens):
            return scan(tokens[index + 1], cwd, vault, depth + 1)
        return []
    parsed = parse_git(tokens)
    if parsed is None:
        return []
    chdir, git_dir, work_tree, verb, args = parsed
    if verb is None or not verb_is_write(verb, args):
        return []
    for target in target_dirs(chdir, git_dir, work_tree, cwd):
        if inside(target, vault):
            return [(verb, target)]
    return []


def scan(command, cwd, vault, depth=0):
    if depth > MAX_DEPTH:
        return []
    findings = []
    for tokens in token_lines(command):
        # `cd <vault> && git rm note.md` resolves that repository against the
        # vault, not against the session's directory. Track the cd across the
        # line — it is half of the shapes this guard has to cover.
        here = cwd
        for stages in split_statements(tokens):
            lead = strip_noop(stages[0]) if stages and stages[0] else []
            if lead and base(lead[0]) == "cd" and len(lead) > 1:
                destination = os.path.expanduser(lead[1])
                if os.path.isabs(destination):
                    # An absolute cd needs no base, so it settles the target
                    # even when the payload carried no cwd at all. Without this
                    # the incident's second shape — `cd <vault> && git rm x` —
                    # walks through whenever cwd is absent.
                    here = destination
                elif here is not None:
                    here = os.path.join(here, destination)
                continue
            for stage in stages:
                findings.extend(check_stage(stage, here, vault, depth))
    return findings


def main():
    command = sys.stdin.read(MAX_INPUT)
    if not command.strip():
        return 0
    cwd = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else None
    vault = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None
    if not vault:
        return 0
    vault = os.path.realpath(os.path.expanduser(vault))
    if cwd:
        cwd = os.path.realpath(os.path.expanduser(cwd))
    # Heredoc bodies are prose to the tokeniser and would wreck it, so they come
    # out first. Nothing here reads them: a heredoc body is never a git command.
    stripped, _bodies = extract_heredocs(command)
    findings = scan(stripped, cwd, vault, depth=0)
    if findings:
        verb, target = findings[0]
        print(f"`git {verb}` writes to the memory vault's git, at {target}.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
