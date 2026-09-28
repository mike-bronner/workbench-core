#!/bin/bash
# Unit tests for the two bash-reading rules in hooks/lib/shell_parse.py that
# every Bash guard now depends on. Run directly: ./test-shell-parse.sh
#
# The guard suites prove these rules end to end, through a verdict. A verdict
# cannot see every branch, though: text inside single quotes is data to the
# outer command, so joining a backslash-newline there wrongly moves no guard's
# verdict today, and would still be a misreading waiting for a rule that reads
# data. So the function is pinned here directly, one bash behaviour per row.

set -u
LIB="$(cd "$(dirname "$0")" && pwd)/lib"

python3 - "$LIB" <<'PY'
import sys

sys.path.insert(0, sys.argv[1])
from shell_parse import base, extract_heredocs, join_continuations, shell_cd_args, token_lines_ex

passed = failed = 0


def check(desc, got, want):
    global passed, failed
    if got == want:
        passed += 1
        print("  ✅ " + desc)
    else:
        failed += 1
        print("  ❌ %s: got %r, want %r" % (desc, got, want))


BSNL = "\\\n"

print("join_continuations deletes a backslash-newline where bash does:")
check("bare word", join_continuations("r" + BSNL + "m -rf x"), "rm -rf x")
check("between words", join_continuations("cd /x && " + BSNL + "rm y"), "cd /x && rm y")
check("inside double quotes", join_continuations('echo "a' + BSNL + 'b"'), 'echo "ab"')

print("and keeps it where bash does:")
check("inside single quotes", join_continuations("echo 'a" + BSNL + "b'"), "echo 'a" + BSNL + "b'")
check("after an escaping backslash", join_continuations("echo \\\\\nrm"), "echo \\\\\nrm")
check("inside a comment", join_continuations("ls # note " + BSNL + "rm x"), "ls # note " + BSNL + "rm x")
check("a # inside a word is no comment", join_continuations("echo a#b" + BSNL + "c"), "echo a#bc")
check("a closed single quote ends the protection",
      join_continuations("echo 'a' r" + BSNL + "m"), "echo 'a' rm")

print("it is idempotent:")
for text in ("r" + BSNL + "m", "echo \\\\\nrm", "echo 'a" + BSNL + "b'", "a" + BSNL + BSNL + "b"):
    once = join_continuations(text)
    check("twice equals once for %r" % text, join_continuations(once), once)

print("a heredoc body joins only when its delimiter is unquoted:")
_, bodies = extract_heredocs("psql <<SQL\nDROP " + BSNL + "TABLE x;\nSQL")
check("unquoted delimiter", bodies.get("SQL"), ["DROP TABLE x;"])
_, bodies = extract_heredocs("psql <<'SQL'\nDROP " + BSNL + "TABLE x;\nSQL")
check("quoted delimiter", bodies.get("SQL"), ["DROP " + BSNL + "TABLE x;"])
_, bodies = extract_heredocs("cat <<EOF\nkeep \\\\\nline\nEOF")
check("an escaped backslash in a body stays", bodies.get("EOF"), ["keep \\\\\nline"])

print("token_lines_ex reads the joined word:")
lines, exact, _ = token_lines_ex("r" + BSNL + "m -rf /x")
check("one line, rm in the verb slot", (lines, exact), ([["rm", "-rf", "/x"]], True))

print("base folds case, because macOS resolves command names case-insensitively:")
check("upper case", base("DROPDB"), "dropdb")
check("absolute mixed case", base("/usr/local/bin/PSql"), "psql")

print("shell_cd_args moves the shell only for bash's own cd:")
check("cd", shell_cd_args(["cd", "/x"]), ["/x"])
check("an assignment and command stay in this shell", shell_cd_args(["A=1", "command", "cd", "/x"]), ["/x"])
check("a caller's keyword is stripped", shell_cd_args(["if", "cd", "/x"], {"if"}), ["/x"])
for fake in (["CD", "/x"], ["Cd", "/x"], ["/usr/bin/cd", "/x"], ["sudo", "cd", "/x"], ["env", "cd", "/x"]):
    check("%s moves nothing" % " ".join(fake[:-1]), shell_cd_args(fake), None)

print()
print("%d passed, %d failed" % (passed, failed))
sys.exit(1 if failed else 0)
PY
