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
  sql       DROP DATABASE/SCHEMA/TABLE, TRUNCATE, DELETE FROM with no WHERE

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

Deliberately out of scope, because the payload is not visible in the command:
  psql -f drop.sql          the SQL lives in a file this checker cannot read
  mysql app < dump.sql      same, through a redirect
  php artisan tinker        an interactive REPL takes its input later
"""

import os
import re
import shlex
import sys

MAX_INPUT = 200_000
MAX_DEPTH = 4

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


def unwrap(tokens):
    """Strip wrappers until the real command sits at index 0.

    Returns (tokens, nested) where nested holds command STRINGS that have to be
    parsed on their own — `ssh box "php artisan db:wipe"` and `bash -c "..."`
    both arrive as one quoted token, which no regex over the outer command can
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


def check_statement(stages, bodies, depth):
    """One statement, already split into pipeline stages and unwrapped."""
    findings = []
    nested = []
    unwrapped = []
    for stage in stages:
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

    for inner in nested:
        findings.extend(scan(inner, bodies, depth + 1))
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


def scan(command, bodies, depth=0):
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
    stripped, bodies = extract_heredocs(command)
    findings = scan(stripped, bodies)
    if findings:
        print(findings[0])
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
