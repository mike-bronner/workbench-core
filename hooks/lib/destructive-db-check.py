#!/usr/bin/env python3
"""destructive-db-check: decide whether a shell command destroys a database.

Reads one shell command on stdin. Prints a single reason line to stdout and
exits 1 when the command is destructive; exits 0 and prints nothing otherwise.

The whole difficulty of this check is VERB POSITION. A substring match for
"drop table" blocks `grep -rn "drop table" app/` and reading a migration named
2026_09_04_drop_users_table.php, which would make ordinary code search
impossible. So the command is tokenised, split into statements and pipeline
stages, unwrapped through its wrappers, and only then matched — an Artisan verb
must sit in the argument slot after `artisan`, and SQL must sit inside a SQL
client's payload. `grep` is not a SQL client, so it is structurally unreachable.

Three rule classes, in the order they are checked per stage:

  artisan   db:wipe, migrate:fresh, migrate:reset, migrate:refresh
  shell     dropdb, dropuser, mysqladmin ... drop
  docker    the volume-deleting commands, and only those
  project   ddev delete, ddev stop --remove-data, lando destroy, wp-env destroy
  sql       DROP DATABASE/SCHEMA/TABLE, TRUNCATE, DELETE FROM with no WHERE

The Docker rules follow the same shape as the Artisan exemption. A containerised
database keeps its data in a named volume, so `docker compose down` on its own is
harmless and is how a stack gets stopped. The destructive half is --volumes,
which sits AFTER the subcommand, exactly where a prefix deny rule cannot read it.
So `down -v`, `rm -v`, `volume rm`, `volume prune`, and `system prune --volumes`
block, and plain `down`, `up`, `docker rm`, and image or builder pruning do not.
`sail down -v` blocks too, because sail proxies docker compose.

WHY ARTISAN CARRIES A TESTING EXEMPTION:
The 2026-09-04 incident was `php artisan db:wipe --database=pgsql --force`, run
in the belief that `pgsql` meant the testing database. It does not. phpunit.xml
only overrides DB_DATABASE inside a test run, so an Artisan command from the
shell resolves `pgsql` against .env — the development database. Every table went.
The mistake was the TARGET, not the verb: rebuilding the testing database is
ordinary work. So a reset verb is allowed only when the command scopes itself
explicitly, with --env=testing or --database=testing. A bare `migrate:fresh` is
blocked, because bare inherits .env, which is the development database.

The hole, stated plainly: --env=testing proves intent, not target. A project
whose .env.testing points at the development database still walks through. This
narrows the mistake, it does not close it. `/sandbox` is the real boundary.

FAIL OPEN, and for a different reason than credential-guard.sh gives:
There is no adversary here. The threat is a confidently wrong agent, not someone
crafting input to slip past a parser. A command that actually destroys data must
be syntactically valid to run at all, so it tokenises. Anything this checker
cannot parse is something bash would likely reject too, and blocking it would
break every awk one-liner with an odd quote while buying nothing. One hardening
step before giving up: a POSIX tokenise failure is retried with posix=False.

SQL FROM A FILE IS READ, NOT GUESSED AT:
`psql -f reset.sql` and `mysql app < dump.sql` hide the payload in a file, so the
file is opened and scanned with the same rules. The NAME settles nothing —
reset.sql is often a seed and setup.sql often drops the schema first — so only
the contents decide. Four properties keep that affordable and safe:

  1. Conditional. No file is opened unless the statement already holds a SQL
     client AND names a file, so grep, git, and npm pay nothing at all.
  2. Bounded. SQL_FILE_CAP stops the read at one megabyte. Worst case measured
     at about 75 ms over the hook's own startup, on a 22 MB dump.
  3. Regular files only. A fifo would hang the hook forever, so the mode is
     checked with os.stat before anything is opened.
  4. Never quoted. The finding names the path and the verb class. Not one line
     of the file reaches the message, because that would put its contents in the
     transcript.

A relative path resolves against the tool call's cwd, and a leading `cd` in the
same command moves that base. File reading stops at the ssh boundary: the remote
machine has its own filesystem, so a local file of the same name is the wrong
file, and reading it could only ever produce a false block.

Deliberately out of scope:
  php artisan tinker        an interactive REPL takes its input later
  a DROP past 1 MB          the cap. In pg_dump output the DROPs are at the top
"""

import os
import re
import shlex
import stat
import sys

MAX_INPUT = 200_000
MAX_DEPTH = 4
# A referenced .sql file is read this far and no further. Measured on an M-series
# Mac: the scan costs about 25 ms per megabyte, against the 50 ms this hook
# already spends starting jq and Python. The cost lands only on a command that
# feeds a file to a SQL client, so ordinary work pays nothing. The cap is the
# stated limit: a DROP past one megabyte is missed. In pg_dump output the DROP
# lines sit at the top, which is the case worth catching.
SQL_FILE_CAP = 1_000_000

# Artisan verbs that empty or rebuild whatever database they resolve to.
ARTISAN_VERBS = {"db:wipe", "migrate:fresh", "migrate:reset", "migrate:refresh"}
# The two flags that make an Artisan reset's target explicit.
SCOPE_FLAGS = ("--env", "--database")
TESTING = "testing"

DROP_COMMANDS = {"dropdb", "dropuser"}

# Clients whose command-line payload is SQL. This list is the reason `grep`
# cannot reach the SQL rules: a payload is only read from a stage that IS one of
# these, or from an echo/printf/heredoc feeding one through a pipe.
SQL_CLIENTS = {"psql", "mysql", "mariadb", "mysqlsh", "sqlite3", "sqlite", "usql"}
# Clients that take their SQL as a positional argument after the database file.
SQL_POSITIONAL_CLIENTS = {"sqlite3", "sqlite"}
SQL_INLINE_FLAGS = {"-c", "--command", "-e", "--execute", "--sql"}
# Clients that read -f as --file. mysql reads -f as --force, so treating it as a
# filename there would scan whatever positional happened to follow.
SQL_FILE_CLIENTS = {"psql", "usql"}
SQL_FILE_FLAGS = {"-f", "--file"}
# Programs whose arguments are files being piped into a client, as in
# `cat teardown.sql | psql`.
READERS = {"cat", "head", "tail"}

# ddev, lando, and wp-env each manage a project database and drop it with their
# own verb rather than a compose one, so the Docker rules never see them.
PROJECT_TOOL_VERBS = {
    "ddev": {"delete"},
    "lando": {"destroy"},
    "wp-env": {"destroy"},
}
# `ddev delete images` removes Docker images, not project data.
PROJECT_TOOL_EXEMPT = {("ddev", "delete"): {"images"}}

# Wrappers stripped before the verb slot is read. Each one puts the real command
# further along the token list, which is exactly what a prefix permission rule
# cannot see — `cd foo && php artisan db:wipe` is the shape the incident took.
PREFIX_NOOP = {"sudo", "doas", "env", "nice", "ionice", "time", "nohup",
               "command", "exec", "stdbuf"}
CONTAINER_SHIMS = {"sail", "lando", "ddev", "wp-env"}
DOCKER_VALUE_FLAGS = {"-u", "--user", "-w", "--workdir", "-e", "--env", "--label"}
SSH_VALUE_FLAGS = {"-p", "-i", "-o", "-l", "-F", "-b", "-c", "-D", "-L", "-R"}
SHELLS = {"bash", "sh", "zsh", "dash", "ksh"}
ECHOES = {"echo", "printf"}

# A containerised database keeps its data in a named volume, so the destructive
# Docker commands are the volume-touching ones. `docker compose down` on its own
# leaves named volumes alone and is how a stack is routinely stopped, so only the
# --volumes form blocks. Same reasoning for `docker system prune`: it removes
# volumes only when asked to.
DOCKER_BINARIES = {"docker", "podman"}
COMPOSE_BINARIES = {"docker-compose", "podman-compose"}
# sail proxies docker compose, so `sail down -v` IS `docker compose down -v`.
COMPOSE_SHIMS = {"sail"}
# Flags that carry a separate value, skipped so the subcommand is found. The
# compose file in `docker compose -f x.yml down -v` is a value, not a verb.
DOCKER_GLOBAL_VALUE_FLAGS = {
    "-f", "--file", "-p", "--project-name", "-H", "--host", "-c", "--context",
    "--project-directory", "--env-file", "--profile", "--log-level",
}
# `--volume`, `--volumes`, and any short cluster containing v, such as -fv.
VOLUME_FLAG = re.compile(r"^(--volumes?|-[A-Za-z]*v[A-Za-z]*)$")

STATEMENT_SEPARATORS = {";", "&&", "||", "&", "(", ")", "{", "}"}
PIPE = "|"

ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
HEREDOC_START = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")

# A single-quoted SQL literal is data, not a verb. Stripping literals before
# matching is what keeps `SELECT * FROM logs WHERE msg = 'drop table'` running.
# Double-quoted and backticked text is left alone: those are identifiers, and
# `DROP TABLE "users"` must still match.
SQL_LITERAL = re.compile(r"'(?:[^']|'')*'")
SQL_DROP = re.compile(r"\bDROP\s+(DATABASE|SCHEMA|TABLE)\b", re.I)
SQL_TRUNCATE = re.compile(r"\bTRUNCATE\s+(TABLE\s+)?[\"'`\[\w]", re.I)
SQL_DELETE = re.compile(r"\bDELETE\s+FROM\b", re.I)
SQL_WHERE = re.compile(r"\bWHERE\b", re.I)


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
    nothing else. The Docker rules have to read the docker binary and its
    subcommand, which unwrap() strips on its way to the inner command."""
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


def unwrap(tokens):
    """Strip wrappers until the real command sits at index 0.

    Returns (tokens, nested) where nested holds (command STRING, remote) pairs
    that have to be parsed on their own. `ssh box "php artisan db:wipe"` and
    `bash -c "..."` both arrive as one quoted token, which no regex over the
    outer command can see into. `remote` marks the ssh case, where the command's
    files live on another machine and must not be read here."""
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
        if head in {"docker", "docker-compose", "podman", "podman-compose"}:
            inner = rest[1:]
            if inner and inner[0] == "compose":
                inner = inner[1:]
            if inner and inner[0] in {"exec", "run"}:
                inner = skip_flags(inner[1:], DOCKER_VALUE_FLAGS)
                rest = inner[1:] if inner else []  # the service or image name
                continue
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
                nested.append((inner[0], True))
                rest = []
            else:
                rest = inner
            continue
        if head in SHELLS and "-c" in rest:
            index = rest.index("-c")
            if index + 1 < len(rest):
                nested.append((rest[index + 1], False))
            rest = []
            break
        break
    return rest, nested


def has_testing_scope(tokens):
    """True when the command names the testing database or environment."""
    for index, token in enumerate(tokens):
        for flag in SCOPE_FLAGS:
            if token == f"{flag}={TESTING}":
                return True
            if token == flag and index + 1 < len(tokens):
                if tokens[index + 1] == TESTING:
                    return True
    return False


def check_artisan(tokens):
    """The verb must sit in the argument slot after `artisan`, which is what
    separates the command from a grep whose pattern happens to contain it."""
    position = None
    for index, token in enumerate(tokens[:3]):
        if token == "artisan" or token.endswith("/artisan"):
            position = index
            break
    if position is None:
        return None
    verb = next((t for t in tokens[position + 1:] if not t.startswith("-")), None)
    if verb not in ARTISAN_VERBS:
        return None
    if has_testing_scope(tokens):
        return None
    return (
        f"`php artisan {verb}` empties or rebuilds the database it resolves to, "
        "and this command does not scope itself to the testing database. Without "
        "--env=testing or --database=testing it resolves against .env, which is "
        "the development database."
    )


def check_docker(tokens):
    """Block the Docker commands that delete a volume, and only those.

    `docker compose down` leaves named volumes alone and is how a stack is
    routinely stopped, so the plain form has to keep working. The destructive
    half is the --volumes flag, which sits AFTER the subcommand, and that is
    precisely what a prefix deny rule cannot read."""
    if not tokens:
        return None
    head = base(tokens[0])
    compose = False
    if head in DOCKER_BINARIES:
        rest = skip_flags(tokens[1:], DOCKER_GLOBAL_VALUE_FLAGS)
        if rest and rest[0] == "compose":
            compose = True
            rest = skip_flags(rest[1:], DOCKER_GLOBAL_VALUE_FLAGS)
    elif head in COMPOSE_BINARIES or head in COMPOSE_SHIMS:
        compose = True
        rest = skip_flags(tokens[1:], DOCKER_GLOBAL_VALUE_FLAGS)
    else:
        return None
    if not rest:
        return None

    verb, args = rest[0], rest[1:]
    volumes = any(VOLUME_FLAG.match(arg) for arg in args)
    label = f"{head} compose" if compose and head in DOCKER_BINARIES else head
    if verb == "down" and volumes:
        return (f"`{label} down` with --volumes deletes the named volumes, "
                "which is where a containerised database keeps its data.")
    if verb == "rm" and volumes:
        return (f"`{label} rm` with --volumes deletes the containers' volumes "
                "along with them.")
    if verb == "volume" and args and args[0] in {"rm", "prune"}:
        return (f"`{head} volume {args[0]}` deletes volumes outright, and a "
                "database container keeps its data in one.")
    if verb == "system" and args and args[0] == "prune" and volumes:
        return (f"`{head} system prune --volumes` deletes every unused volume, "
                "including a stopped database's.")
    return None


def check_project_tool(tokens):
    """ddev, lando, and wp-env drop a project database with their own verbs."""
    if not tokens:
        return None
    head = base(tokens[0])
    verbs = PROJECT_TOOL_VERBS.get(head)
    if verbs is None:
        return None
    words = [t for t in tokens[1:] if not t.startswith("-")]
    verb = words[0] if words else None
    if verb in verbs:
        exempt = PROJECT_TOOL_EXEMPT.get((head, verb), set())
        if len(words) > 1 and words[1] in exempt:
            return None
        return (f"`{head} {verb}` destroys the project, and the database it "
                "owns goes with it.")
    if head == "ddev" and verb == "stop" and "--remove-data" in tokens:
        return "`ddev stop --remove-data` deletes the project database."
    return None


def check_shell_drop(tokens):
    head = base(tokens[0])
    if head in DROP_COMMANDS:
        return f"`{head}` destroys a database or role outright, with no undo."
    if head == "mysqladmin" and "drop" in tokens[1:]:
        return "`mysqladmin drop` destroys a database outright, with no undo."
    return None


def check_sql(payload):
    """Match destructive SQL one statement at a time, so a WHERE clause in a
    later statement cannot excuse an unqualified DELETE in an earlier one."""
    for statement in SQL_LITERAL.sub("''", payload).split(";"):
        match = SQL_DROP.search(statement)
        if match:
            return f"the SQL runs DROP {match.group(1).upper()}."
        if SQL_TRUNCATE.search(statement):
            return "the SQL runs TRUNCATE, which empties a table with no undo."
        if SQL_DELETE.search(statement) and not SQL_WHERE.search(statement):
            return "the SQL runs DELETE FROM with no WHERE clause."
    return None


def sql_payloads(tokens, bodies):
    """Every string this stage hands to a SQL client as SQL."""
    payloads = []
    positionals = []
    index = 1
    while index < len(tokens):
        token = tokens[index]
        if token in SQL_INLINE_FLAGS and index + 1 < len(tokens):
            payloads.append(tokens[index + 1])
            index += 2
            continue
        if token in {"<<", "<<-"} and index + 1 < len(tokens):
            payloads.extend(bodies.get(tokens[index + 1], []))
            index += 2
            continue
        if token == "<<<" and index + 1 < len(tokens):
            payloads.append(tokens[index + 1])
            index += 2
            continue
        inline = next((p for p in ("--command=", "--execute=", "--sql=")
                       if token.startswith(p)), None)
        if inline:
            payloads.append(token[len(inline):])
        elif not token.startswith("-"):
            positionals.append(token)
        index += 1
    if base(tokens[0]) in SQL_POSITIONAL_CLIENTS:
        payloads.extend(positionals[1:])  # the first positional is the db file
    return payloads


def sql_file_paths(tokens):
    """Paths this stage feeds to a SQL client as a file of SQL.

    The filename settles nothing, which is why the contents get read: `drop.sql`
    is often a seed, and `setup.sql` often drops the schema first."""
    paths = []
    head = base(tokens[0])
    index = 1
    while index < len(tokens):
        token = tokens[index]
        if token == "<" and index + 1 < len(tokens):
            paths.append(tokens[index + 1])
            index += 2
            continue
        if head in SQL_FILE_CLIENTS:
            if token in SQL_FILE_FLAGS and index + 1 < len(tokens):
                paths.append(tokens[index + 1])
                index += 2
                continue
            if token.startswith("--file="):
                paths.append(token[len("--file="):])
        elif head in READERS and not token.startswith("-"):
            paths.append(token)
        index += 1
    return paths


def read_sql_file(path, base_dir):
    """Read a referenced file of SQL, bounded. None on anything unreadable.

    Regular files only. A fifo would hang the hook forever, and a directory or a
    device is not SQL. base_dir of None means the command runs somewhere else, as
    it does over ssh, where a local file of the same name is the wrong file."""
    if base_dir is None:
        return None
    try:
        resolved = os.path.join(base_dir, os.path.expanduser(path))
        if not stat.S_ISREG(os.stat(resolved).st_mode):
            return None
        with open(resolved, "r", errors="replace") as handle:
            return handle.read(SQL_FILE_CAP)
    except OSError:
        return None


def check_statement(stages, bodies, depth, cwd=None):
    """One statement, already split into pipeline stages and unwrapped."""
    findings = []
    nested = []
    unwrapped = []
    for stage in stages:
        # The Docker rules read the docker invocation itself, so they see the
        # stage before unwrap() strips it down to the inner command.
        lead = strip_noop(stage)
        for finding in (check_docker(lead), check_project_tool(lead)):
            if finding:
                findings.append(finding)
        tokens, inner = unwrap(stage)
        nested.extend(inner)
        if tokens:
            unwrapped.append(tokens)

    for tokens in unwrapped:
        for finding in (check_artisan(tokens), check_shell_drop(tokens)):
            if finding:
                findings.append(finding)

    # SQL is only read when a SQL client is present in the statement. That gate
    # is what keeps `grep -rn "drop table"` and `echo "DROP TABLE"` harmless:
    # neither reaches a database on its own.
    clients = [t for t in unwrapped if base(t[0]) in SQL_CLIENTS]
    if clients:
        payloads = []
        saw_heredoc = False
        for tokens in unwrapped:
            if "<<" in tokens or "<<-" in tokens:
                saw_heredoc = True
            if base(tokens[0]) in SQL_CLIENTS:
                payloads.extend(sql_payloads(tokens, bodies))
            elif base(tokens[0]) in ECHOES:
                # `echo "DROP DATABASE app" | psql` — the SQL is upstream.
                payloads.extend(t for t in tokens[1:] if not t.startswith("-"))
                payloads.extend(sql_payloads(tokens, bodies))
            else:
                payloads.extend(sql_payloads(tokens, bodies))
        if not saw_heredoc and bodies:
            # A heredoc whose redirect did not survive tokenising still feeds
            # the client that is standing right here.
            for body_list in bodies.values():
                payloads.extend(body_list)
        for payload in payloads:
            finding = check_sql(payload)
            if finding:
                findings.append(
                    f"{finding} It is handed to `{base(clients[0][0])}`, "
                    "which runs it against a live database."
                )
                break

        # SQL handed over as a FILE. Only the verdict is reported, never a line
        # of the file: the guard reads it to decide, not to quote it.
        for tokens in unwrapped:
            for path in sql_file_paths(tokens):
                content = read_sql_file(path, cwd)
                finding = check_sql(content) if content else None
                if finding:
                    findings.append(
                        f"{finding} It comes from `{path}`, which is fed to "
                        f"`{base(clients[0][0])}`."
                    )
                    break

    for inner, remote in nested:
        # A command that runs elsewhere resolves its files elsewhere, so file
        # reading stops at the ssh boundary.
        findings.extend(scan(inner, bodies, depth + 1, None if remote else cwd))
    return findings


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


def scan(command, bodies, depth=0, cwd=None):
    if depth > MAX_DEPTH:
        return []
    findings = []
    for tokens in token_lines(command):
        # `cd /repo && psql -f reset.sql` resolves that file against /repo, not
        # against the session's directory. Track the cd across the line.
        here = cwd
        for stages in split_statements(tokens):
            lead = strip_noop(stages[0]) if stages and stages[0] else []
            if lead and base(lead[0]) == "cd" and len(lead) > 1:
                if here is not None:
                    here = os.path.join(here, os.path.expanduser(lead[1]))
                continue
            findings.extend(check_statement(stages, bodies, depth, here))
    return findings


def main():
    command = sys.stdin.read(MAX_INPUT)
    if not command.strip():
        return 0
    # argv[1] is the tool call's working directory, which is what a relative
    # path in the command resolves against. Absent, no file is read.
    cwd = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else None
    stripped, bodies = extract_heredocs(command)
    findings = scan(stripped, bodies, cwd=cwd)
    if findings:
        print(findings[0])
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
