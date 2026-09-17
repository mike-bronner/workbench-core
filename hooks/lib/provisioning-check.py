#!/usr/bin/env python3
"""provisioning-check: decide whether a shell command provisions a git worktree
or a database.

Reads one shell command on stdin. Prints a single reason line to stdout and
exits 1 when the command creates a worktree or a database, or destroys a
worktree; exits 0 and prints nothing otherwise.

WHY THIS EXISTS:
The worktrees and the development databases on this machine are set up by hand.
A worktree comes from a Herdr keybinding or a typed `git worktree add`, and a
database comes from a typed `createdb`. Those are the environment an agent is
meant to work INSIDE. Agents kept provisioning their own instead — a stray
`git worktree add`, a `createdb`, a sub-agent dispatched with worktree
isolation. Each one leaves an orphan tree or an orphan database to find and
clean up later, and it puts the agent's work somewhere nobody was looking.

WORKTREE DELETION IS IN SCOPE TOO, AND IT IS THE HALF WITH THE BLAST RADIUS.
`git worktree remove` and `git worktree prune` destroy trees somebody set up
deliberately. Creating a tree leaves litter; deleting one destroys work.
Database deletion is NOT here. hooks/lib/destructive-db-check.py already owns
that half, for reasons an incident paid for, and nothing in this file touches
it.

WHY A HOOK AND NOT ONLY A DENY RULE:
A deny rule matches a command PREFIX. `cd /repo && git worktree add x` puts the
verb in the fourth slot, and `psql -c "CREATE DATABASE app"` hides it inside a
client's payload, where no prefix can look. So the command is tokenised, split
into statements and pipeline stages, unwrapped through its wrappers, and only
then matched — a worktree verb has to sit in git's subcommand slot, and SQL has
to sit in a SQL client's payload. `grep` is neither git nor a SQL client, so
code search is structurally unreachable by both rule classes. Two of the four
paths an agent has are not shell commands at all (the harness's EnterWorktree
tool, and an Agent dispatch carrying isolation: "worktree"), and a permission
rule cannot reach either one. Those are handled by the guard shell script.

TWO EXCLUSIONS, DECIDED DELIBERATELY. NEITHER IS TO BE WIDENED:

  SQLite file creation stays allowed. A Laravel migration creates
  database/database.sqlite implicitly, so blocking it breaks ordinary test runs
  while protecting nothing anybody cares about — a stray .sqlite file is deleted
  with rm, not hunted down with dropdb. The exclusion is structural rather than
  a special case: sqlite3 is absent from SQL_CLIENTS, so no sqlite payload is
  ever read, and no rule here matches CREATE TABLE at all.

  Container and project stack startup stays allowed. `docker compose up`,
  `sail up`, `ddev start`, and `lando start` provision a database volume on
  first run, and they are also exactly how an agent starts the environment it
  is supposed to be working in. Blocking them defeats the point of the guard.
  Only a creation verb reached THROUGH a container blocks, as in
  `docker compose exec db createdb app`, which is provisioning and not startup.

A BLOCK LIST, NOT AN ALLOW LIST, and the gap that leaves:
Only the enumerated verbs block. `git worktree list`, `lock`, `unlock`, `move`,
and `repair` pass, so does `psql -c "SELECT ..."`, so does `mysqladmin status`,
and so does every other read a block list never has to enumerate. THE STATED
LIMIT, as a known limit and not an oversight: a creation path nobody listed
walks through. `pg_restore --create` is one, and a CREATE DATABASE hidden in a
file handed to `psql -f` is another. Reading a referenced .sql file is what
destructive-db-check.py does for DROP, and it is deliberately not repeated
here: a missed CREATE costs one `dropdb` to undo, while the missed DROP that
guard exists for cost several hours of imported data.

FAIL OPEN, on the reasoning all three sibling guards give:
There is no adversary here. The threat is a confidently wrong agent, not a
crafted payload. A command that actually creates a worktree has to be valid
shell to run at all, so it tokenises. Anything unparseable is something bash
would likely reject too, and blocking it would break ordinary quoted one-liners
for nothing. As with the siblings, this guards Claude's own tool calls and is
not an OS boundary — `/sandbox` enforces in the kernel, for every subprocess.

THE TOKENISER IS SHARED; THE RULES AND unwrap() ARE NOT:
Tokenising, statement and pipeline splitting, heredoc lifting, no-op-prefix
stripping, and the option skip that finds git's subcommand slot all come from
hooks/lib/shell_parse.py. unwrap() stays per-guard, for the reason that file's
header gives: the guards disagree about `ssh`. This one FOLLOWS a command
through ssh, agreeing with destructive-db-check.py rather than with
vault-git-check.py. A worktree or a database created on another host is still
one nobody asked for, and no verdict here depends on a local path, so a remote
command cannot produce the false block the vault guard's rule protects against.

NO WORKING DIRECTORY IS PASSED IN, and none is needed. The sibling checkers
take one because their verdict turns on WHICH path the command resolves to.
This one never asks that question: a worktree created anywhere is a worktree
created, so a leading `cd` cannot change the answer and no file is ever read.
"""

import os
import re
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
    ASSIGNMENT,
    PREFIX_NOOP,
    base,
    extract_heredocs,
    skip_flags,
    split_statements,
    token_lines,
)

MAX_INPUT = 200_000
MAX_DEPTH = 4

# `git worktree` subcommands that make or unmake a tree. Every other subcommand
# — list, lock, unlock, move, repair — reports or adjusts metadata and passes.
WORKTREE_CREATE = {"add"}
WORKTREE_DESTROY = {"remove", "prune"}

# git's own options, before the subcommand. Listed so their VALUE is never
# mistaken for the verb: without this, `git -C /repo worktree add x` reads its
# subcommand as `/repo`. --exec-path is deliberately absent, because its bare
# form takes no value and consuming the next token would swallow `worktree`.
GIT_VALUE_FLAGS = {"-C", "-c", "--git-dir", "--work-tree", "--namespace",
                   "--config-env", "--attr-source"}

# The PostgreSQL creation binaries, mirroring the dropdb/dropuser pair that
# destructive-db-check.py blocks. A role is provisioning too: it outlives the
# session and somebody has to remember to remove it.
CREATE_COMMANDS = {"createdb", "createuser"}

# Clients whose command-line payload is SQL. This list is the reason `grep`
# cannot reach the SQL rule: a payload is only read from a stage that IS one of
# these, or from an echo/printf/heredoc feeding one through a pipe.
#
# sqlite3 is absent ON PURPOSE and must stay absent. That is the SQLite
# exclusion, expressed structurally rather than as a special case.
SQL_CLIENTS = {"psql", "mysql", "mariadb", "mysqlsh", "usql"}
SQL_INLINE_FLAGS = {"-c", "--command", "-e", "--execute", "--sql"}
SQL_INLINE_PREFIXES = ("--command=", "--execute=", "--sql=")
ECHOES = {"echo", "printf"}

# Wrappers stripped before the verb slot is read. Each one puts the real command
# further along the token list, which is exactly what a prefix permission rule
# cannot see. PREFIX_NOOP is imported from shell_parse so that strip_noop()
# there and unwrap() here agree on the set.
CONTAINER_SHIMS = {"sail", "lando", "ddev", "wp-env"}
DOCKER_BINARIES = {"docker", "docker-compose", "podman", "podman-compose"}
DOCKER_VALUE_FLAGS = {"-u", "--user", "-w", "--workdir", "-e", "--env", "--label"}
SSH_VALUE_FLAGS = {"-p", "-i", "-o", "-l", "-F", "-b", "-c", "-D", "-L", "-R"}
SHELLS = {"bash", "sh", "zsh", "dash", "ksh"}

# A single-quoted SQL literal is data, not a verb. Stripping literals before
# matching is what keeps `SELECT * FROM audit WHERE msg = 'create database'`
# running. Double-quoted and backticked text is left alone: those are
# identifiers, and `CREATE DATABASE "app"` must still match.
SQL_LITERAL = re.compile(r"'(?:[^']|'')*'")
# CREATE TABLE is deliberately not here. Every migration creates tables, and a
# table inside a database somebody already made is not provisioning.
SQL_CREATE = re.compile(r"\bCREATE\s+(DATABASE|SCHEMA)\b", re.I)


def unwrap(tokens):
    """Strip wrappers until the real command sits at index 0.

    Returns (tokens, nested) where nested holds command STRINGS that have to be
    parsed on their own. `ssh box "git worktree add x"` and `bash -c "..."` both
    arrive as a single quoted token, which no rule over the outer command can
    see into."""
    nested = []
    rest = list(tokens)
    for _ in range(8):
        if not rest:
            break
        head = base(rest[0])
        if ASSIGNMENT.match(rest[0]):
            rest = rest[1:]
            continue
        if head in PREFIX_NOOP:
            rest = rest[1:]
            if head == "env":
                while rest and ASSIGNMENT.match(rest[0]):
                    rest = rest[1:]
            continue
        if head in CONTAINER_SHIMS:
            rest = rest[1:]
            continue
        if head in DOCKER_BINARIES:
            inner = rest[1:]
            if inner and inner[0] == "compose":
                inner = inner[1:]
            if inner and inner[0] in {"exec", "run"}:
                inner = skip_flags(inner[1:], DOCKER_VALUE_FLAGS)
                rest = inner[1:] if inner else []  # the service or image name
                continue
            # Anything else on a docker binary is stack management, not a
            # command run inside the stack. `docker compose up` provisions a
            # volume on first run and is how the environment gets started, so
            # the walk stops here and no rule below can see it.
            break
        if head == "kubectl":
            if "--" in rest:
                rest = rest[rest.index("--") + 1:]
                continue
            break
        if head == "ssh":
            inner = skip_flags(rest[1:], SSH_VALUE_FLAGS)
            inner = inner[1:] if inner else []  # the host
            if len(inner) == 1:
                nested.append(inner[0])
                rest = []
            else:
                rest = inner
            continue
        if head in SHELLS and "-c" in rest:
            index = rest.index("-c")
            if index + 1 < len(rest):
                nested.append(rest[index + 1])
            rest = []
            break
        break
    return rest, nested


def check_git(tokens):
    """Is this a `git worktree` subcommand that makes or unmakes a tree?

    The subcommand is found by skipping git's own options rather than by reading
    tokens[1], because `git -C /repo worktree add x` puts `worktree` in the
    fourth slot — which is exactly what a prefix rule cannot reach."""
    if base(tokens[0]) != "git":
        return None
    rest = skip_flags(tokens[1:], GIT_VALUE_FLAGS)
    if not rest or rest[0] != "worktree":
        return None
    words = [token for token in rest[1:] if not token.startswith("-")]
    verb = words[0] if words else None
    if verb in WORKTREE_CREATE:
        return ("`git worktree add` creates a git worktree, and nothing "
                "afterwards cleans it up.")
    if verb == "remove":
        return ("`git worktree remove` deletes a worktree, and the worktrees "
                "on this machine were set up by hand.")
    if verb == "prune":
        return ("`git worktree prune` deletes the records of every worktree "
                "git believes is gone, which breaks a tree that is only "
                "unmounted.")
    return None


def check_create_command(tokens):
    """The creation binaries, mirroring the drop pair the database guard owns."""
    head = base(tokens[0])
    if head == "createdb":
        return "`createdb` creates a PostgreSQL database that nothing will clean up."
    if head == "createuser":
        return "`createuser` creates a PostgreSQL role that nothing will clean up."
    if head == "mysqladmin" and "create" in tokens[1:]:
        return "`mysqladmin create` creates a MySQL database that nothing will clean up."
    return None


def check_sql(payload):
    """Match a creation statement one statement at a time, so a CREATE in the
    second half of a payload is found as readily as one in the first."""
    for statement in SQL_LITERAL.sub("''", payload).split(";"):
        match = SQL_CREATE.search(statement)
        if match:
            return f"the SQL runs CREATE {match.group(1).upper()}."
    return None


def sql_payloads(tokens, bodies):
    """Every string this stage hands to a SQL client as SQL.

    No positional argument is read. sqlite3 is the client that takes its SQL
    positionally, and it is excluded, so reading positionals here would only
    ever turn a database NAME into a payload."""
    payloads = []
    index = 1
    while index < len(tokens):
        token = tokens[index]
        if token in SQL_INLINE_FLAGS and index + 1 < len(tokens):
            payloads.append(tokens[index + 1])
            index += 2
            continue
        if token in {"<<", "<<-"} and index + 1 < len(tokens):
            # The tab-stripping form hides the delimiter behind a dash that
            # extract_heredocs never stored, because it keys bodies by the bare
            # name. Two spellings, both valid bash and both measured:
            #
            #   psql <<-SQL    tokenises as ['<<', '-SQL']
            #   psql <<- SQL   tokenises as ['<<', '-', 'SQL']
            #
            # Measured, not assumed: without this, `psql <<-SQL` walked straight
            # through. A delimiter can never legitimately start with a dash,
            # since HEREDOC_START requires a letter or an underscore. The same
            # fix landed in hooks/lib/destructive-db-check.py, where the gap let
            # a DROP DATABASE past the guard built after a real data loss.
            delimiter, step = tokens[index + 1], 2
            if delimiter == "-" and index + 2 < len(tokens):
                delimiter, step = tokens[index + 2], 3
            payloads.extend(bodies.get(delimiter.lstrip("-"), []))
            index += step
            continue
        if token == "<<<" and index + 1 < len(tokens):
            payloads.append(tokens[index + 1])
            index += 2
            continue
        inline = next((p for p in SQL_INLINE_PREFIXES if token.startswith(p)), None)
        if inline:
            payloads.append(token[len(inline):])
        index += 1
    return payloads


def check_statement(stages, bodies, depth):
    """One statement, already split into pipeline stages."""
    findings = []
    nested = []
    unwrapped = []
    for stage in stages:
        tokens, inner = unwrap(stage)
        nested.extend(inner)
        if tokens:
            unwrapped.append(tokens)

    for tokens in unwrapped:
        for finding in (check_git(tokens), check_create_command(tokens)):
            if finding:
                findings.append(finding)

    # SQL is only read when a SQL client stands in this statement. That gate is
    # what keeps `grep -rn "create database"` and a bare
    # `echo "CREATE DATABASE app"` harmless: neither reaches a server on its own.
    clients = [t for t in unwrapped if base(t[0]) in SQL_CLIENTS]
    if clients:
        payloads = []
        for tokens in unwrapped:
            if base(tokens[0]) in ECHOES:
                # `echo "CREATE DATABASE app" | psql` — the SQL is upstream.
                payloads.extend(t for t in tokens[1:] if not t.startswith("-"))
            payloads.extend(sql_payloads(tokens, bodies))
        # A heredoc body is reached ONLY through the redirect token in the
        # stage that owns it, never by sweeping every body in the command.
        # destructive-db-check.py carries that sweep as a fallback for a
        # redirect "that did not survive tokenising". Measured across every
        # spelling — <<SQL, <<'SQL', <<"SQL", <<-SQL, after a cd, before a
        # pipe, behind sudo — the redirect survives in all of them, so the
        # sweep caught nothing. It did produce a false block: writing a
        # setup.sql heredoc anywhere in a command that also runs psql matched
        # the unrelated body. A guard that fails OPEN cannot carry a branch
        # whose only measured effect is a false block on ordinary work.
        for payload in payloads:
            finding = check_sql(payload)
            if finding:
                findings.append(
                    f"{finding} It is handed to `{base(clients[0][0])}`, "
                    "which runs it against a live database server."
                )
                break

    for inner in nested:
        findings.extend(scan(inner, bodies, depth + 1))
    return findings


def scan(command, bodies, depth=0):
    """No `cd` is tracked across the line, and none needs to be: this guard
    never resolves a path, so the directory a command runs in cannot change its
    verdict. A `cd` stage simply matches no rule and is skipped."""
    if depth > MAX_DEPTH:
        return []
    findings = []
    for tokens in token_lines(command):
        for stages in split_statements(tokens):
            findings.extend(check_statement(stages, bodies, depth))
    return findings


def main():
    command = sys.stdin.read(MAX_INPUT)
    if not command.strip():
        return 0
    # Heredoc bodies are prose to the tokeniser and would wreck it, so they come
    # out first. The SQL rule reads them back through the delimiter token.
    stripped, bodies = extract_heredocs(command)
    findings = scan(stripped, bodies)
    if findings:
        print(findings[0])
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
