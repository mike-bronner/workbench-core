#!/usr/bin/env python3
"""shell_parse: the mechanical half of reading a shell command.

WARNING — EVERY SAFETY GUARD THAT IMPORTS THIS FILE FAILS SILENTLY.

hooks/lib/destructive-db-check.py is the enforcement behind
hooks/destructive-database-guard.sh, which exists because a real development
database was destroyed on 2026-09-04. hooks/lib/vault-git-check.py is the
enforcement behind hooks/vault-git-guard.sh. hooks/lib/provisioning-check.py is
the enforcement behind hooks/provisioning-guard.sh. Those three hooks fail OPEN
by design: a checker that cannot run exits 0, and exit 0 means allow. So a
change here that raises, renames a symbol, or merely re-splits a command
differently does not produce an error anybody sees. It produces a guard that
never blocks again.

hooks/lib/destructive-scope-check.py fails CLOSED instead, and it is the one
importer this warning has to be read backwards for. It is the only layer gating
`rm`, `rmdir`, and four destructive git verbs — the permission-rule entries that
used to sit under them are being retired — so a re-split that hides a verb slot
does not merely stop blocking, it silently PERMITS a delete. A change here that
makes it raise or mis-tokenise is the more visible half: the guard denies every
destructive command until somebody fixes it.

THE RULE, which outlives the list under it: after touching anything below, run
the suite of EVERY checker that imports this file. A count in this sentence
would go stale the next time a guard is added, and nothing would say so. As of
this writing the importers are:
    hooks/test-destructive-database-guard.sh
    hooks/test-vault-git-guard.sh
    hooks/test-provisioning-guard.sh
    hooks/test-destructive-scope-guard.sh

WHAT BELONGS HERE, AND WHAT DOES NOT:
Only mechanical parsing — tokenising, splitting a line into statements and
pipeline stages, lifting heredoc bodies out of the way, and dropping the no-op
prefixes that push the real command further along the token list. No rules. No
verb tables, no regexes over payloads, no blocking decisions. Those stay in the
guard that owns them, because the guards read the same command differently and a
shared rule would have to be wrong for one of them.

The sharpest instance is `ssh`, and it is why unwrap() is deliberately NOT here.
The database guard follows a command through ssh, because a database on another
host is still a database being destroyed. The vault guard stops dead at it,
because another machine's vault is not this vault and reading it could only ever
produce a false block. Same token, opposite meaning. Each guard keeps its own
unwrap(). The provisioning guard is a third opinion rather than a tiebreaker: it
follows through, for its own reason, which is that its verdict never depends on
a path and so a remote command cannot mislead it.

The tokenising story, which every importer depends on: a substring match cannot
decide any of this. `grep -rn "drop table" app/` and `git log --grep="git rm"`
both contain a destructive verb and neither touches anything. So text is split
into tokens with shlex, operators become tokens of their own, and a rule reads
the argument SLOT rather than the characters. That is the single property this
module exists to provide.

THE PERIMETER OF EVERY GUARD ABOVE IS THIS TOKENISER, NOT ITS VERB TABLE.
A shape a guard RECOGNISES and refuses is a documented limit. A shape that never
reaches the guard's dispatch loop at all is a bypass, and it looks like silence
rather than like a bug. The audit below was run on 2026-09-21, after a
parenthesis was found doing exactly that, and it is recorded here so the next
reader starts from the answers rather than the question:

  FIXED — `shlex(punctuation_chars=True)` accumulates a RUN of punctuation into
  one token, so `);` arrived as the single token `');'`. That is in no separator
  set, so every token after it was absorbed as an argument to the previous
  command and the real verb was never read. `(true); rm -rf /etc/x` produced one
  statement whose verb was `true`. split_operators() now cuts a punctuation run
  into the shell operators it is actually made of.

  FIXED — `;;`, `;&` and `|&` tokenise as single tokens and were in no set
  either, so `case x in a) rm ... ;; esac` swallowed the arm terminator. They
  are separators and a pipe now.

  FIXED — a heredoc BODY was tokenised as though it were commands. That is a
  false-positive direction rather than a bypass, and extract_heredocs() has
  always been here to prevent it; nothing called it. token_lines_ex() does.

  FIXED, AND THIS ONE WAS CAUSED BY THE LINE ABOVE — extract_heredocs() was not
  idempotent, and three checkers already called it in their own main() before
  passing the stripped text down. Running it twice was DESTRUCTIVE: the second
  pass met an opener whose delimiter line the first had consumed, scanned to the
  end for a terminator that was no longer there, and swallowed every remaining
  line as that opener's body. An ordinary `cat <<EOF` writing a file therefore
  deleted every command after it from three guards' view, silently. An
  unterminated opener now takes no body, which makes a second pass a no-op and
  also closes a defect older than the second caller: at HEAD a genuinely
  unterminated heredoc hid everything below it from all three guards.

  THE LESSON THAT OUTLIVES IT, because this is the kind of defect that comes
  back: 578 assertions across six suites were green while three guards were
  broken, and "rerun every importer's suite" was followed. Both missed it
  because the defect lived in the SEAM between this file and its callers, and
  every suite tests one layer. hooks/test-parser-differential.sh tests the
  composition — one corpus, every guard, live hooks, verdicts pinned — and it is
  the suite that catches a change here moving a verdict over there. Run it.

  FIXED, BY REPORTING RATHER THAN BY PARSING — the whole-text retry in
  token_lines() merges every line into ONE token list, because shlex treats a
  newline as plain whitespace. A statement boundary that was only a newline
  disappears, so `mkdir /x` and `rm -rf /y` on two lines become one statement
  whose verb is `mkdir`. The posix=False retry separately leaves quotes glued to
  their tokens. Neither can be fixed without losing the multi-line strings those
  retries exist for, so token_lines_ex() reports whether the split was EXACT and
  a fail-closed caller refuses what it could not read exactly.

  NOT FIXED HERE, AND THE REASON IS A BOUNDARY — strip_noop() drops a wrapper
  such as `env` or `nice` but not that wrapper's own options, so `env -i rm -rf
  /etc/x` leaves `-i` in the verb slot and `nice -n 10 rm` leaves `-n`. Closing
  it needs a per-wrapper table of which flags take a separate value, and a
  hand-maintained table that is one entry short is a silent bypass rather than a
  visible gap — the failure mode this module is meant not to have. So the rule
  stays with the caller: hooks/lib/destructive-scope-check.py treats a verb slot
  that is not a command name as unreadable and refuses it, which needs no table.
  THE OTHER THREE IMPORTERS DO NOT DO THIS, and for them `env -i psql -c "DROP
  DATABASE x"` reads as a command named `-i`. That is a live gap in those guards,
  reported rather than fixed here, because changing what strip_noop() returns
  changes three guards' verdicts at once.
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

STATEMENT_SEPARATORS = {";", ";;", ";&", "&&", "||", "&", "(", ")", "{", "}"}

# `|&` is bash's "pipe stdout AND stderr". It separates two commands exactly as
# `|` does, and left out of this set it glued them into one.
PIPE = "|"
PIPES = {"|", "|&"}

GROUP_OPEN = {"(", "{"}
GROUP_CLOSE = {")", "}"}

# The characters shlex is told to treat as punctuation. It accumulates a RUN of
# them into a single token, which is right for `&&` and wrong for `);`.
PUNCTUATION = set("();<>|&")

# Every operator a punctuation run can legitimately be made of, LONGEST FIRST so
# a greedy walk never cuts `&&` into two `&`. Redirections are here as well as
# separators: a caller that reads argument slots has to see `>` as an operator
# rather than as a path, and one that does not care simply ignores them.
SHELL_OPERATORS = ("<<<", "&>>", "&&", "||", ";;", ";&", "|&", "<<", ">>",
                   "<&", ">&", "<>", ">|", "&>", ";", "&", "|", "(", ")",
                   "<", ">")

ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
HEREDOC_START = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")


def base(token):
    """The bare program name, so /usr/local/bin/psql matches psql."""
    return os.path.basename(token)


def split_operators(token):
    """Cut one run of punctuation into the shell operators it is made of.

    shlex accumulates adjacent punctuation into a single token, which is what
    makes `&&` arrive whole — and what made `);` arrive whole too. `');'` is in
    no separator set, so a guard reading statement boundaries saw none, and
    every token after it was absorbed as an argument to the command before it.
    The verb never reached the dispatch loop.

    Greedy longest-first, so `&&` survives as one operator and `);` becomes two.
    An unrecognised character is emitted on its own rather than dropped: losing
    it would silently re-join the two statements it separates.
    """
    parts = []
    index = 0
    while index < len(token):
        for operator in SHELL_OPERATORS:
            if token.startswith(operator, index):
                parts.append(operator)
                index += len(operator)
                break
        else:
            parts.append(token[index])
            index += 1
    return parts


def _split_punctuation(tokens):
    """Apply split_operators to every token that is nothing but punctuation."""
    out = []
    for token in tokens:
        if len(token) > 1 and all(c in PUNCTUATION for c in token):
            out.extend(split_operators(token))
        else:
            out.append(token)
    return out


def tokenize(text):
    """Split shell text into tokens, with operators as tokens of their own."""
    lexer = shlex.shlex(text, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    return _split_punctuation(list(lexer))


def tokenize_loose(text):
    """The posix=False retry. Quotes stay attached, which the SQL regexes
    tolerate and the verb rules mostly do not need."""
    lexer = shlex.shlex(text, posix=False, punctuation_chars=True)
    lexer.whitespace_split = True
    return _split_punctuation(list(lexer))


def token_lines_ex(text):
    """(lines of tokens, exact, heredoc bodies).

    Tokenise line by line so a newline separates statements, since shlex treats
    it as plain whitespace and would otherwise merge them. A line that will not
    parse on its own is usually one arm of a multi-line quoted string, so the
    whole text is retried as a single unit before giving up.

    EXACT IS FALSE WHEN A RETRY LOST SOMETHING THE CALLER MAY BE RELYING ON, and
    saying so is the whole reason this variant exists. The whole-text retry
    merges every line into ONE token list, so a statement boundary that was only
    a newline is gone — `mkdir /x` then `rm -rf /y` becomes a single statement
    whose verb is `mkdir`, and a guard reading the verb slot sees nothing to
    refuse. The posix=False retry separately leaves quotes glued to their
    tokens, so an argument slot no longer holds the path it names. Neither can
    be repaired without giving up the multi-line and odd-quoting commands these
    retries exist to handle, so the loss is REPORTED and a fail-closed caller
    refuses what it could not read exactly.

    Heredoc bodies are lifted out before any of this and returned separately.
    A body is prose, not commands: tokenised in place, `cat <<EOF` carrying the
    text `rm -rf /` reads as a delete. A caller that needs to know whether a
    body is really a script — `bash <<EOF` — reads it from the mapping, keyed by
    delimiter.
    """
    stripped, bodies = extract_heredocs(text)
    lines = [line for line in stripped.split("\n") if line.strip()]
    for parser in (tokenize, tokenize_loose):
        exact = parser is tokenize
        try:
            return [parser(line) for line in lines], exact, bodies
        except ValueError:
            pass
        try:
            # The whole-text retry merges the lines, so it is never exact.
            return [parser(stripped)], False, bodies
        except ValueError:
            pass
    return [], False, bodies


def token_lines(text):
    """token_lines_ex's first element, for callers that fail open and so have
    no use for the exactness flag."""
    return token_lines_ex(text)[0]


def extract_heredocs(command):
    """Lift heredoc bodies out of the command text, keyed by delimiter.

    The body is prose to the tokeniser and would wreck it. Pulling it out first
    leaves `psql -d app <<SQL` on the line, which tokenises cleanly, and the
    delimiter token is what points back at the body.

    THIS FUNCTION IS IDEMPOTENT, AND THAT PROPERTY IS LOAD-BEARING RATHER THAN
    TIDY. Running it twice over the same text must leave the text alone the
    second time, because more than one layer calls it: three checkers call it in
    their own main() and pass the stripped text down to token_lines(), which
    calls it again. It was not idempotent, and the second pass was destructive —
    it met an opener whose delimiter line the FIRST pass had already consumed,
    scanned to the end of the text looking for a terminator that was no longer
    there, and swallowed every remaining line as that opener's body. An ordinary
    `cat <<EOF` used to write a file therefore deleted every command after it
    from the guards' view, silently and with no traceback. Reproduced end to end
    on 2026-09-21: `dropdb app` denied, and the same command behind a harmless
    heredoc returned nothing at all.

    An unterminated opener therefore takes NO body. That is the whole fix, and
    it is the correct reading on its own terms: a heredoc with no terminator has
    no body to lift, whether it lost one to an earlier pass or never had one.
    It also closes a defect that predates the second caller — at HEAD, a
    genuinely unterminated `cat <<EOF` hid every following line from all three
    guards, verified.
    """
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
            scan = i
            while scan < len(lines) and lines[scan].strip() != delimiter:
                body.append(lines[scan])
                scan += 1
            if scan >= len(lines):
                # No terminator anywhere below. Consume nothing and leave the
                # remaining lines to be read as the commands they are.
                continue
            i = scan + 1  # step over the delimiter line itself
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


def split_statements_grouped(tokens):
    """[(groups, stages), ...] — statements split on the sequencing operators,
    stages on the pipe, each tagged with the tuple of group openers enclosing
    it, outermost first.

    THE TUPLE HOLDS THE OPENER ITSELF, NOT JUST A DEPTH, BECAUSE THE TWO KINDS
    OF GROUP BEHAVE OPPOSITELY AND A CALLER TRACKING A WORKING DIRECTORY HAS TO
    TELL THEM APART. Measured on bash 3.2: a paren group runs in a SUBSHELL, so
    `(cd /elsewhere) ; pwd` prints where it started; a brace group runs in THIS
    shell, so `{ cd /elsewhere; } ; pwd` prints /elsewhere.

    Both directions are a bypass if a caller gets it wrong, which is why the
    distinction is reported rather than flattened. Believing a paren cd sends a
    guard looking in the wrong tree for a relative operand, so a delete aimed
    outside resolves as though it were inside. Discarding a brace cd is the
    same mistake mirrored: a `cd` OUT of the safe tree is forgotten, and the
    delete that follows reads as though it never left.
    """
    statements = []
    stages = [[]]
    groups = []

    def flush(enclosing):
        if any(stage for stage in stages):
            statements.append((tuple(enclosing), stages))

    for token in tokens:
        if token in GROUP_OPEN:
            flush(groups)
            stages = [[]]
            groups.append(token)
        elif token in GROUP_CLOSE:
            flush(groups)
            stages = [[]]
            # An unbalanced closer pops nothing rather than going negative, so a
            # malformed command cannot drive a caller's stack below its start.
            if groups:
                groups.pop()
        elif token in STATEMENT_SEPARATORS:
            flush(groups)
            stages = [[]]
        elif token in PIPES:
            stages.append([])
        else:
            stages[-1].append(token)
    flush(groups)
    return statements


def split_statements(tokens):
    """Statements split on the sequencing operators, stages on the pipe."""
    return [stages for _, stages in split_statements_grouped(tokens)]
