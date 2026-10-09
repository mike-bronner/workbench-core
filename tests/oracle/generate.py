#!/usr/bin/env python3
"""TEST ORACLE PLUMBING. NOT PART OF THE PLUGIN.

Builds tests/oracle/guard-cases.ts, the fixture tests/guard-differential.test.ts
reads. hooks/test-guard-oracles.sh runs it; read that file for the flow.

    generate.py <cases.jsonl> <run-home> [--sandbox]

<cases.jsonl> holds the cases the frozen guards' own suites fed them, recorded
by tests/oracle/record.sh. This script adds seeded random cases, runs each
through its frozen guard, and prints the fixture to stdout: every case a guard
refused, with how many it read.

With --sandbox it also runs each refused Bash command in a sandbox, under
/bin/bash and /bin/zsh, and records whether the run did harm. That half needs
zsh and is run only to write the fixture, never to check it.

THE SANDBOX. A temporary folder holds a home, a working directory, and a shim
folder that is the whole PATH. Every program a command could run is a shim that
records its name, its directory, its arguments and its standard input, and runs
nothing. The home and the working directory hold planted credential files, each
holding a canary string. Builtins run for real: a redirect writes inside the
sandbox, and `$(<file)` reads. A run did harm when:

  - credential guard: the canary reached any output, shim or new file; or a
    shim received a credential path or a dotenv file as an argument; or a
    program that runs code received one in its code (its arguments, its
    standard input, or a script file it was given); or a `security` shim was
    asked for a secret
  - provisioning guard: a shim was asked to create a worktree or a database,
    or to delete a worktree, or a runner or shell shim received such a command
  - summary-writer guard: a markdown file was written or changed, or a shim
    that writes files received a .md argument, or a shell, interpreter or
    wrapper shim received one

The judge is meant to over-count harm: a run it calls harmless did nothing the
guard exists to stop. A port may let through only what the oracle refused and
both shells ran harmlessly.
"""

import concurrent.futures
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ORACLE = os.path.dirname(os.path.abspath(__file__))
HOME = "/Users/tester"
CANARY = "CANARY-7f3a9c"

# ─── seeded random lines ───────────────────────────────────────────────────


def mulberry32(seed):
    state = seed & 0xFFFFFFFF

    def next_float():
        nonlocal state
        state = (state + 0x6D2B79F5) & 0xFFFFFFFF
        t = state
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    return next_float


def lines(seed, count, tokens, separators=(" ", " ", " ", "", "\n", ";")):
    random = mulberry32(seed)

    def pick(xs):
        return xs[int(random() * len(xs))]

    out = []
    for _ in range(count):
        length = 2 + int(random() * 8)
        line = ""
        for k in range(length):
            line += (pick(separators) if k else "") + pick(tokens)
        out.append(line)
    return out


SHARED = ["|", "&&", "||", ";", "\n", "#", '"', "'", "$(", ")", "`", "x=1", "sudo", "env -i", "bash -c", "eval", "echo", "(", "{", "}"]

CREDENTIAL = SHARED + [
    "cat", "head -c 10", "ls", "printf %s", "grep x", "ln -s", "cp", "python3 -c", "node -e", "security",
    "find-generic-password -w", "dump-keychain", "-s 'Claude Code-credentials'",
    "~/.ssh/id_rsa", "~/.ssh", "$HOME/.aws/credentials", "${HOME}/.gnupg/pubring.kbx", f"{HOME}/.ssh/id_rsa",
    "~/Library/Keychains", "~/Library/Keychains/login.keychain-db", "~/.claude/.credentials.json",
    ".env", ".env.local", ".env.example", ".envrc", "app.env", "$.env.get", "process.env.HOME",
    "'open(\".env\")'", '"a note about .env files"', '"$HOME"/.ssh/id_rsa', "x/.ssh/id_rsa", "Developer/.aws",
    ">", ">>", "<", "out.txt",
    "<<'EOF'\nconst h = await $.env.get('HOME')\nEOF\n", "<<PY\nopen('.env').read()\nPY\n", "<<EOF\ncat ~/.ssh/id_rsa\nEOF\n",
]

PROVISIONING = SHARED + [
    "git", "worktree", "add", "remove", "prune", "list", "../feat", "-b x", "git -C /repo worktree add x",
    "createdb", "createuser", "app", "mysqladmin", "create", "status", "psql", "-c", '"CREATE DATABASE app"',
    "'SELECT 1'", "\"SELECT 'create database'\"", "mysql", "-e", "grep", "-rn", "docker compose exec db",
    "ssh box", "sail", "sqlite3", '"CREATE TABLE t (a)"', "CREATEDB", "create\\\ndb", "env -S",
    "<<SQL\nCREATE DATABASE app;\nSQL\n", "<<EOF\ngit worktree add x\nEOF\n",
]

SUMMARY = SHARED + [
    "echo hi", "cat", "tee", "cp", "mv", "install", "rsync", "sed", "-i", "-n", '"s/a/b/"', "notes.md",
    "x.summary.md", "sessions/a.md", "README.mdx", "a.txt", ">", ">>", "2>", "&>", "<", "/dev/null",
    "grep foo", "x.md.bak", "printf %s", "xargs", "touch", "<<EOF\nhello\nEOF\n",
]

PEER_VALUES = [
    "main", "Main", " main", "main\n", "a5a2f4470341f9233", "A5A2F4470341F9233", "a5a2f447", "a5a2f447-0341-f923",
    "g5a2f4470341f9233", "herdr-b5", "herdr-b5 [72839a]", "a5a2f4470341f92330ff", "a5a2f4470341f9233\n", 42, {}, [],
    None, "", "watson",
]

FILE_PREFIXES = ["~", "$HOME", HOME, "/repo", "", "x", "/Users/other"]
FILE_MIDDLES = ["/.ssh", "/.aws", "/.gnupg", "/Library/Keychains", "/.claude", "/sub", ""]
FILE_TAILS = ["/id_rsa", "/.env", "/.env.example", "/.envrc", "/credentials", "/.credentials.json", "", "/a.env",
              "/.env.production", "/.env.local.example.bak", "/login.keychain-db"]


def random_cases():
    cases = []
    for line in lines(11, 600, CREDENTIAL):
        cases.append(("credential-guard", {"tool_name": "Bash", "tool_input": {"command": line}}, ""))
    random = mulberry32(12)
    for _ in range(200):
        tool = ["Read", "Edit", "Write", "NotebookEdit"][int(random() * 4)]
        path = "".join(xs[int(random() * len(xs))] for xs in (FILE_PREFIXES, FILE_MIDDLES, FILE_TAILS))
        key = "notebook_path" if tool == "NotebookEdit" else "file_path"
        cases.append(("credential-guard", {"tool_name": tool, "tool_input": {key: path}}, ""))
    for line in lines(21, 600, PROVISIONING):
        cases.append(("provisioning-guard", {"tool_name": "Bash", "tool_input": {"command": line}}, ""))
    for line in lines(31, 400, SUMMARY):
        cases.append(("summary-writer-guard", {"tool_name": "Bash", "tool_input": {"command": line}}, "1"))
    random = mulberry32(41)
    for _ in range(300):
        tool_input = {}
        for field in ("to", "recipient"):
            if random() < 0.7:
                tool_input[field] = PEER_VALUES[int(random() * len(PEER_VALUES))]
        payload = {"tool_name": "SendMessage", "tool_input": tool_input}
        if random() < 0.8:
            payload["agent_id"] = "a5a2f4470341f9233"
        cases.append(("peer-message-gate", payload, ""))
    return cases


# ─── the frozen guards ─────────────────────────────────────────────────────

# Where the outbound prose guard's sandbox is written in the fixture.
PROSE_SANDBOX = "/sandbox"


def oracle_verdict(guard, payload_text, writer, run_home):
    env = dict(os.environ, HOME=run_home, WORKBENCH_SUMMARY_WRITER=writer)
    path = os.path.join(ORACLE, guard, guard + ".sh")
    run = subprocess.run(["bash", path], input=payload_text.encode(), capture_output=True, env=env)
    if run.returncode == 2:
        return "deny"
    try:
        out = json.loads(run.stdout or b"{}")
    except json.JSONDecodeError:
        return "allow"
    return "deny" if out.get("hookSpecificOutput", {}).get("permissionDecision") == "deny" else "allow"


# ─── the sandbox ───────────────────────────────────────────────────────────

PROGRAMS = """cat head tail less more strings xxd hexdump od base64 nl tac rev grep egrep fgrep rg ag ack awk gawk
sed gsed jq yq cut paste sort uniq diff cp mv scp rsync tar zip gzip curl wget nc ncat openssl gpg dd tee
python python3 node bun deno php ruby perl sqlite3 plutil security ssh-keygen ssh-add vim nvim nano emacs code
open ln link ditto install cpio ls stat find touch rm mkdir chmod xargs sudo env nice timeout bash sh zsh dash
ksh git createdb createuser mysqladmin psql mysql mariadb mysqlsh usql docker docker-compose podman kubectl ssh
sail lando ddev wp-env osascript true false test""".split()
RUNS_INPUT = {"python", "python3", "node", "bun", "deno", "php", "ruby", "perl", "sqlite3", "osascript", "awk",
              "gawk", "jq", "bash", "sh", "zsh", "dash", "ksh", "psql", "mysql", "mariadb", "mysqlsh", "usql",
              "ssh", "docker", "kubectl", "sudo", "env", "xargs", "nice", "timeout"}
WRAPPING = RUNS_INPUT | {"docker-compose", "podman", "sail", "lando", "ddev", "wp-env"}

SHIM = """#!/bin/bash
{{
  printf 'CALL\\037%s\\037%s\\037' "${{0##*/}}" "$PWD"
  for a in "$@"; do printf '%s\\036' "$a"; done
  printf '\\037'
  if [ ! -t 0 ]; then IFS= read -r -d '' input; printf '%s' "$input"; fi
  printf '\\035'
}} > '{log}'/"$$.$RANDOM"
exit 0
"""

CRED_PATH = re.compile(r"/\.ssh(/|$)|/\.aws(/|$)|/\.gnupg(/|$)|Library/Keychains|\.credentials\.json")
# In code a program runs, any `.env` but `$.env` (the hooks module's own
# `$.env.get`), which is no file.
DOTENV_CODE = re.compile(r"(?<!\$)\.env(?![A-Za-z0-9_-])")
TEMPLATE = re.compile(r"\.env[^/]*\.(example|sample|template|dist|defaults?)$", re.I)
PROVISION = re.compile(r"createdb|createuser|create\s+(database|schema)|worktree\s+(\S+\s+)*?(add|remove|prune)\b", re.I)
SECRET_READS = {"find-generic-password", "find-internet-password", "dump-keychain", "export", "export-item"}
WRITERS = {"tee", "cp", "mv", "install", "rsync", "ln", "dd", "ditto", "sed", "gsed", "perl", "touch"}


def plant(root, programs=None):
    programs = PROGRAMS if programs is None else programs
    home, work, shims = (os.path.join(root, d) for d in ("home", "work", "shims"))
    for d in (home, work, shims, os.path.join(root, "tmp")):
        os.makedirs(d)
    planted = [
        "home/.ssh/id_rsa", "home/.aws/credentials", "home/.gnupg/pubring.kbx", "home/Library/Keychains/login.keychain-db",
        "home/.claude/.credentials.json", "work/.env", "work/.env.local", "work/.env.production",
    ]
    for rel in planted:
        path = os.path.join(root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write(f"{CANARY}\n")
    with open(os.path.join(work, ".env.example"), "w") as f:
        f.write("KEY=placeholder\n")
    # Each shim writes its own record file: two shims in a pipeline run at
    # once, and their writes to one file would interleave.
    log = os.path.join(root, "calls")
    os.makedirs(log)
    for name in programs:
        path = os.path.join(shims, name)
        with open(path, "w") as f:
            f.write(SHIM.format(log=log))
        os.chmod(path, 0o755)
    return home, work, shims, log


def snapshot(root):
    seen = {}
    for base, _, files in os.walk(root):
        for name in files:
            path = os.path.join(base, name)
            try:
                with open(path, "rb") as f:
                    seen[path] = f.read()
            except OSError:
                seen[path] = None
    return seen


def calls_of(log):
    raw = ""
    for name in sorted(os.listdir(log)):
        with open(os.path.join(log, name), "rb") as f:
            raw += f.read().decode("utf-8", "replace")
    calls = []
    for record in raw.split("\x1d"):
        if not record.startswith("CALL\x1f"):
            continue
        parts = record.split("\x1f")
        if len(parts) < 5:
            continue
        name, cwd, argv, stdin = parts[1], parts[2], [a for a in parts[3].split("\x1e") if a != ""], "\x1f".join(parts[4:])
        calls.append((name, cwd, argv, stdin))
    return calls


def harmful(guard, root, before, after, out, calls):
    if guard == "summary-writer-guard":
        for path, data in after.items():
            if ".md" in os.path.basename(path) and before.get(path, b"\0missing") != data:
                return True
        for name, _, argv, stdin in calls:
            text = " ".join(argv)
            if name in WRITERS and ".md" in text:
                return True
            if name in WRAPPING and (".md" in text or ".md" in stdin):
                return True
        return False
    if guard == "provisioning-guard":
        for name, _, argv, stdin in calls:
            text = " ".join(argv)
            if name in {"createdb", "createuser"}:
                return True
            if name == "git" and PROVISION.search(text):
                return True
            if name == "mysqladmin" and "create" in argv:
                return True
            if name in WRAPPING and (PROVISION.search(text) or PROVISION.search(stdin)):
                return True
        return False
    # credential guard
    if CANARY in out:
        return True
    for path, data in after.items():
        if os.path.basename(os.path.dirname(path)) == "calls":
            continue
        if data is not None and CANARY.encode() in data and before.get(path) != data:
            return True
    for name, cwd, argv, stdin in calls:
        if CANARY in stdin or any(CANARY in a for a in argv):
            return True
        if name == "security" and any(a in SECRET_READS for a in argv):
            return True
        if protected(cwd, os.path.join(root, "home")):
            return True
        for a in argv:
            for value in [a] + ([a.split("=", 1)[1]] if "=" in a else []):
                if protected(os.path.normpath(os.path.join(cwd, value)), os.path.join(root, "home")) or reads_dotenv_path(value):
                    return True
        if name in RUNS_INPUT:
            code = argv + stdin.split()
            for a in argv:
                path = os.path.join(cwd, a)
                if os.path.isfile(path):
                    with open(path, errors="replace") as f:
                        code += f.read().split()
            if any(CRED_PATH.search(unit) or (DOTENV_CODE.search(unit) and not TEMPLATE.search(unit)) for unit in code):
                return True
    return False


def protected(path, home):
    """Whether a resolved path is in a credential folder of the sandbox home,
    in any Library/Keychains folder, or is a .credentials.json file."""
    for folder in (".ssh", ".aws", ".gnupg"):
        base = os.path.join(home, folder)
        if path == base or path.startswith(base + "/"):
            return True
    return "/Library/Keychains" in path + "/" or os.path.basename(path) == ".credentials.json"


def reads_dotenv_path(arg):
    """Whether an argument names a dotenv file: a path part that is `.env` or
    `.env.<name>`, and no committed template."""
    return any(re.fullmatch(r"\.env(\..*)?", part) for part in arg.split("/")) and not TEMPLATE.search(arg)


def sandbox_run(guard, command, shell, scratch):
    root = tempfile.mkdtemp(prefix="sbx.", dir=scratch)
    try:
        home, work, shims, log = plant(root)
        line = command.replace(HOME, home).replace("/tmp/", os.path.join(root, "tmp") + "/")
        argv = ["/bin/bash", "--norc", "--noprofile", "-c", line] if shell == "bash" else ["/bin/zsh", "-f", "-c", line]
        before = snapshot(root)
        env = {"PATH": shims, "HOME": home, "WORKBENCH_SUMMARY_WRITER": "1"}
        proc = subprocess.Popen(argv, cwd=work, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, start_new_session=True)
        try:
            out, err = proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, 9)
            out, err = proc.communicate()
        after = snapshot(root)
        text = (out + err).decode("utf-8", "replace")
        return not harmful(guard, root, before, after, text, calls_of(log))
    finally:
        shutil.rmtree(root, ignore_errors=True)


# ─── the guards that read the disk ─────────────────────────────────────────
#
# The destructive-scope, destructive-database and vault-git guards judge a
# command by where its paths land and what git says, so their cases carry the
# sandbox they ran in. They go in tests/oracle/world-cases.ts, written only by
# --write (--world <path>), because their paths come from a live sandbox and
# differ on every run and every machine: CI runs their frozen suites, and the
# differential test replays the fixture.
#
# Each refused case holds the payload and what the port made of it, with the
# facts the port asked about, recorded by tests/oracle/port-facts.js in the
# guard's own environment (tests/oracle/record.sh for the suites, world_case
# below for the random lines). A case the port does not refuse runs in the
# sandbox above, with shims for the programs these guards judge.

WORLD_GUARDS = {"destructive-scope-guard", "destructive-database-guard", "vault-git-guard"}
WORLD_PROGRAMS = PROGRAMS + ["rmdir", "unlink", "shred", "dropdb", "dropuser", "php", "artisan", "ddev", "lando", "wp-env", "parallel", "watch"]
RUNNER_SHIMS = {"xargs", "parallel", "watch", "timeout", "bash", "sh", "zsh", "dash", "ksh", "ssh", "env", "sudo", "nice", "docker",
                "kubectl", "find", "sail", "lando", "ddev"}


def _checker(guard, filename):
    import importlib.util
    path = os.path.join(ORACLE, guard, "lib", filename)
    spec = importlib.util.spec_from_file_location(filename.replace("-", "_").replace(".py", ""), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def world_harmful(guard, calls):
    """Whether the shims were asked to destroy what the guard protects. Meant
    to over-count: any delete at all, any git discard as the frozen checker
    reads it with no repository, any database word, any vault write."""
    if guard == "destructive-scope-guard":
        scope = _checker(guard, "destructive-scope-check.py")
        for name, cwd, argv, stdin in calls:
            text = " ".join(argv) + " " + stdin
            if name in {"rm", "rmdir", "unlink", "shred"} and argv:
                return True
            # Read in the folder the shim ran in, which holds no repository, so
            # git answers for an alias from no config at all (world_sandbox_run).
            if name == "git" and scope.git_destructive(argv, cwd):
                return True
            if name == "find" and any(a in {"-delete", "-exec", "-execdir", "-ok", "-okdir"} for a in argv):
                return True
            if name in RUNNER_SHIMS and re.search(r"(^|[^\w.-])(rm|rmdir|unlink|git|delete)([^\w.-]|$)", text, re.I):
                return True
        return False
    if guard == "destructive-database-guard":
        db = _checker(guard, "destructive-db-check.py")
        for name, _, argv, stdin in calls:
            tokens = [name] + argv
            if name in {"dropdb", "dropuser"} or (name == "mysqladmin" and any(a.lower() == "drop" for a in argv)):
                return True
            if name in db.SQL_CLIENTS and (db.check_sql(" ".join(argv)) or db.check_sql(stdin)):
                return True
            if db.check_artisan(tokens) or db.check_docker(tokens) or db.check_project_tool(tokens):
                return True
            if name in RUNNER_SHIMS and re.search(r"dropdb|dropuser|db:|migrate:|DROP|TRUNCATE|DELETE|volume|destroy|--remove-data", " ".join(argv) + " " + stdin, re.I):
                return True
        return False
    vault = _checker(guard, "vault-git-check.py")
    for name, _, argv, stdin in calls:
        if name == "git":
            parsed = vault.parse_git(["git"] + argv)
            if parsed and parsed[3] and vault.verb_is_write(parsed[3], parsed[4]):
                return True
        if name in RUNNER_SHIMS and re.search(r"(^|[^\w.-])git([^\w.-]|$)", " ".join(argv) + " " + stdin):
            return True
    return False


# A line that names a program by a path, or changes PATH, would reach a real
# program past the shims. It is never run, and so never proven harmless.
UNSAFE_TO_RUN = re.compile(r"/(rm|rmdir|unlink|shred|git|find|dropdb|dropuser|psql|mysql|mysqladmin|php|docker|sh|bash|zsh|xargs)\b|PATH|command\s+-p", re.I)


def world_sandbox_run(guard, command, shell, scratch):
    if UNSAFE_TO_RUN.search(command):
        return False
    root = tempfile.mkdtemp(prefix="sbx.", dir=scratch)
    try:
        home, work, shims, log = plant(root, WORLD_PROGRAMS)
        line = re.sub(r"(/private)?/tmp/", lambda _: os.path.join(root, "tmp") + "/", command.replace(HOME, home))
        argv = ["/bin/bash", "--norc", "--noprofile", "-c", line] if shell == "bash" else ["/bin/zsh", "-f", "-c", line]
        env = {"PATH": shims, "HOME": home}
        proc = subprocess.Popen(argv, cwd=work, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, start_new_session=True)
        try:
            proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, 9)
            proc.communicate()
        # The judge asks the real git about an alias, with no config of the
        # user's or the system's in reach.
        saved = {k: os.environ.get(k) for k in ("GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "HOME")}
        os.environ.update(GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1", HOME=home)
        try:
            return not world_harmful(guard, calls_of(log))
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
    finally:
        shutil.rmtree(root, ignore_errors=True)


# The sandbox the random lines run in, and the words they are made of. `@W` is
# the sandbox folder. It sits in /tmp, under no scope root: on Darwin $TMPDIR
# is the mktemp root, where every delete is in scope.
SCOPE_WORDS = SHARED + [
    "rm", "rm -rf", "rm -f", "rmdir", "git", "reset --hard", "clean -fd", "clean -n", "stash drop", "stash list", "checkout", "checkout --",
    "checkout feature", "restore", "switch -f", "-C @W/victim-repo", "-C @W/project", "co", "-c alias.x='reset --hard' x", "cd @W/victim",
    "cd @W/project", "cd sub", "cd ..", "file.txt", "build", "@W/victim/keep.txt", "@W/project/build", "../victim", "@W/project/../victim",
    "@W/PROJECT/build", "@W//project/./build", "find . -delete", "find . -exec rm {} +", "xargs", "parallel", "timeout 5", "$X", "*",
    "~/x", "/", ">", "/dev/null", "2>&1",
]
DB_WORDS = SHARED + [
    "php artisan", "db:wipe", "migrate:fresh", "--env=testing", "--database=pgsql", "dropdb", "dropuser", "app", "mysqladmin", "drop", "psql",
    "-c", '"DROP TABLE t"', '"SELECT 1"', '"DELETE FROM t"', '"DELETE FROM t WHERE id=1"', "-f", "@W/sql/reset.sql", "@W/sql/seed.sql", "<",
    "docker compose down", "-v", "docker volume prune", "ddev delete", "images", "sail", "find . -exec", "xargs", "cd @W/sql", "reset.sql",
    "<<SQL\nTRUNCATE t;\nSQL\n", "mysql", "-e", "grep -rn",
]
VAULT_WORDS = SHARED + [
    "git", "-C @W/vault", "-C @W/project", "rm", "add", "commit -m x", "status", "log", "stash", "stash list", "tag", "tag -l", "branch",
    "branch -D x", "cd @W/vault", "cd @W/project", "insights/a.md", "--git-dir=@W/vault/.git", "-c alias.x=rm x",
    "find @W/vault -execdir git rm {} \\;", "push", "fetch", "diff",
    # Whole vault writes. Built only from the single words above, a line almost
    # never lines up `git`, a vault target and a write verb in a row, so the
    # frozen guard refused none of 400 lines and the port was never compared on
    # a random refusal.
    "git -C @W/vault rm insights/a.md", "git -C @W/vault add insights/a.md", "cd @W/vault && git stash",
    "git --git-dir=@W/vault/.git reset --hard", "git -C @W/vault tag x",
]
WORLD_RANDOM = (("destructive-scope-guard", 51, 500, SCOPE_WORDS), ("destructive-database-guard", 61, 400, DB_WORDS),
                ("vault-git-guard", 71, 400, VAULT_WORDS))


def build_world(w, run_home):
    """The sandbox: a project repo, a repo and a folder outside every root, a
    vault, SQL files, a memory cache, and the environment each guard reads."""
    git = ["git", "-c", "user.name=oracle", "-c", "user.email=oracle@example.invalid", "-c", "commit.gpgsign=false"]
    for d in ("project/sub", "project/build", "victim", "victim-repo", "vault/insights", "sql", "cache/pending-summaries"):
        os.makedirs(os.path.join(w, d), exist_ok=True)
    files = {"project/file.txt": "x\n", "victim/keep.txt": "keep\n", "victim-repo/file.txt": "x\n", "vault/insights/a.md": "# a\n",
             "sql/reset.sql": "DROP TABLE users;\n", "sql/seed.sql": "INSERT INTO t VALUES ('drop table');\n",
             "cache/pending-summaries/sid.json": "{}\n", "gitconfig": "", "config.json": json.dumps({"memory_path": f"{w}/vault"})}
    for rel, text in files.items():
        with open(os.path.join(w, rel), "w") as f:
            f.write(text)
    env = dict(os.environ, HOME=run_home, CLAUDE_PROJECT_DIR=f"{w}/project", WORKBENCH_CONFIG_FILE=f"{w}/config.json",
               WORKBENCH_MEMORY_PATH=f"{w}/vault", WORKBENCH_MEMORY_CACHE=f"{w}/cache", GIT_CONFIG_GLOBAL=f"{w}/gitconfig",
               GIT_CONFIG_NOSYSTEM="1")
    env.pop("CLAUDE_CODE_SESSION_ID", None)
    for repo, tracked in (("project", "file.txt"), ("victim-repo", "file.txt"), ("vault", "insights/a.md")):
        where = os.path.join(w, repo)
        subprocess.run(["git", "-C", where, "init", "-q", "."], env=env, check=True)
        subprocess.run(["git", "-C", where, "add", tracked], env=env, check=True)
        subprocess.run(git + ["-C", where, "commit", "-q", "-m", "fixture"], env=env, check=True)
        subprocess.run(["git", "-C", where, "branch", "feature"], env=env, check=True)
    subprocess.run(["git", "-C", f"{w}/project", "config", "alias.co", "checkout"], env=env, check=True)
    return env


def world_oracle(guard, payload_text, env):
    path = os.path.join(ORACLE, guard, guard + ".sh")
    run = subprocess.run(["bash", path], input=payload_text.encode(), capture_output=True, env=env)
    try:
        out = json.loads(run.stdout or b"{}")
    except json.JSONDecodeError:
        return "allow"
    return "deny" if run.returncode == 2 or out.get("hookSpecificOutput", {}).get("permissionDecision") == "deny" else "allow"


def port_facts(payload_text, env):
    run = subprocess.run(["deno", "run", "-A", "--quiet", "--unstable-sloppy-imports", os.path.join(ORACLE, "port-facts.js")],
                         input=payload_text.encode(), capture_output=True, env=env)
    try:
        return json.loads(run.stdout)
    except json.JSONDecodeError:
        return {"verdict": "error"}


def world_main(world_suite, run_home, out_path):
    import pwd
    login_home = pwd.getpwuid(os.getuid()).pw_dir
    w = f"/tmp/wb-oracle-{os.getpid()}"
    w_real = os.path.realpath("/tmp") + w[len("/tmp"):]

    def norm(text):
        for real, fixed in ((w_real, "/private/tmp/wb-oracle"), (w, "/tmp/wb-oracle"), (os.path.realpath(run_home), HOME), (run_home, HOME), (login_home, HOME)):
            text = text.replace(real, fixed)
        # A name fact keys the folder and the name apart, so the sandbox's
        # own name is swapped on its own as well.
        return text.replace(os.path.basename(w), "wb-oracle")

    cases = []
    counts = {guard: {"suite": 0, "random": 0, "denied": 0} for guard in WORLD_GUARDS}
    for record in world_suite:
        counts[record["guard"]]["suite"] += 1
        if record["verdict"] == "deny":
            cases.append((record["guard"], "suite", record["payload"], record.get("port") or {"verdict": "error"}))
    os.makedirs(w)
    try:
        env = build_world(w, run_home)
        for guard, seed, count, words in WORLD_RANDOM:
            for line in lines(seed, count, [word.replace("@W", w) for word in words]):
                payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": line}, "cwd": f"{w}/project", "session_id": "wb-oracle-sid"})
                counts[guard]["random"] += 1
                if world_oracle(guard, payload, env) == "deny":
                    cases.append((guard, "random", payload, port_facts(payload, env)))
    finally:
        shutil.rmtree(w, ignore_errors=True)
    for guard, *_ in cases:
        counts[guard]["denied"] += 1

    # Facts shared by the cases of one guard and source are written once.
    facts = {}
    rows = []
    for guard, source, payload, port in cases:
        group = facts.setdefault(f"{guard}\u0000{source}", {})
        world = json.loads(norm(json.dumps(port.get("world") or {})))
        own = {}
        for key, value in (world.get("facts") or {}).items():
            if key in group and group[key] != value:
                own[key] = value
            else:
                group[key] = value
        rows.append({"guard": guard, "source": source, "payload": norm(payload), "port": port.get("verdict", "error"),
                     "cwd": world.get("cwd", "/"), "project": world.get("project", "/nonexistent-project"),
                     "roots": world.get("roots", ""), "vault": world.get("vault"), "facts": own})

    jobs = []
    for row in rows:
        if row["port"] in ("none", "allow"):
            command = (json.loads(row["payload"]).get("tool_input") or {}).get("command")
            if isinstance(command, str):
                jobs.append((row["guard"], command))
    jobs = sorted(set(jobs))
    scratch = os.environ.get("TMPDIR") or tempfile.gettempdir()
    results = [{"bash": world_sandbox_run(g, c, "bash", scratch), "zsh": world_sandbox_run(g, c, "zsh", scratch)} for g, c in jobs]

    out = [
        "// GENERATED by hooks/test-guard-oracles.sh --write. Do not edit by hand.",
        "//",
        "// Every case the frozen destructive-scope, destructive-database and vault-git",
        "// guards refused, from their own suites and from seeded random lines run in a",
        "// built sandbox (tests/oracle/generate.py). Each carries what the port made of",
        "// it and the facts the port asked about there (tests/oracle/port-facts.js),",
        "// which tests/guard-differential.test.ts replays through the module. Facts",
        "// shared by the cases of one guard and source are in WORLD_FACTS, keyed by",
        "// guard and source. Paths are written under the home " + HOME + ".",
        "",
        "export type WorldCase = { guard: string; source: 'suite' | 'random'; payload: string; port: string; cwd: string; project: string; "
        "roots: string; vault: string | null; facts: Record<string, string | null> }",
        "",
        f"export const WORLD_COUNTS: Record<string, {{ suite: number; random: number; denied: number }}> = {json.dumps(counts, sort_keys=True)}",
        "",
        "export const WORLD_FACTS: Record<string, Record<string, string | null>> = {",
    ]
    for group in sorted(facts):
        out.append(f"  {json.dumps(group)}: {json.dumps(facts[group], sort_keys=True)},")
    out.append("}")
    out.append("")
    out.append("export const WORLD_DENIED: readonly WorldCase[] = [")
    for row in rows:
        out.append(f"  {json.dumps(row)},")
    out.append("]")
    out.append("")
    out.append("// Whether each command the port let through ran harmlessly in the sandbox, keyed by guard and command.")
    out.append("export const WORLD_SANDBOX: Record<string, { bash: boolean; zsh: boolean }> = {")
    for (guard, command), result in zip(jobs, results):
        out.append(f"  {json.dumps(guard + chr(0) + norm(command))}: {{ bash: {str(result['bash']).lower()}, zsh: {str(result['zsh']).lower()} }},")
    out.append("}")
    with open(out_path, "w") as f:
        f.write("\n".join(out) + "\n")


# ─── the fixture ───────────────────────────────────────────────────────────


def main():
    cases_file, run_home = sys.argv[1], sys.argv[2]
    with_sandbox = "--sandbox" in sys.argv
    suite = []
    world_suite = []
    with open(cases_file) as f:
        for raw in f:
            record = json.loads(raw)
            # The guards that read the disk go in their own fixture.
            if record["guard"] in WORLD_GUARDS:
                world_suite.append(record)
                continue
            suite.append((record["guard"], record["payload"], record["writer"], record["verdict"], record.get("world")))
    if "--world" in sys.argv:
        world_main(world_suite, run_home, sys.argv[sys.argv.index("--world") + 1])

    def to_fixture(text):
        return text.replace(run_home, HOME)

    # The outbound prose guard's refused cases carry the sandbox its suite ran
    # in (tests/oracle/record.sh). Its path differs on every run, so it is
    # written as PROSE_SANDBOX, in the payload and in the files.
    def prose_world(payload, world):
        cwd = world.get("cwd") or ""
        swap = (lambda text: text.replace(cwd, PROSE_SANDBOX)) if cwd.startswith("/") else (lambda text: text)
        fixed = {
            "vault": swap(world.get("vault") or ""),
            "files": {swap(k): v for k, v in sorted((world.get("files") or {}).items())},
            "dirs": sorted(swap(d) for d in world.get("dirs") or []),
        }
        return swap(payload), fixed

    denied = []
    counts = {}
    for guard, payload, writer, verdict, world in suite:
        counts.setdefault(guard, {"suite": 0, "random": 0, "denied": 0})["suite"] += 1
        if verdict == "deny":
            if guard == "outbound-prose-guard" and isinstance(world, dict):
                payload, world = prose_world(payload, world)
                denied.append((guard, "suite", to_fixture(payload), writer, to_fixture(json.dumps(world, sort_keys=True))))
            else:
                denied.append((guard, "suite", to_fixture(payload), writer, None))

    randoms = random_cases()

    def judge(case):
        guard, payload, writer = case
        text = json.dumps(payload).replace(HOME, run_home)
        return oracle_verdict(guard, text, writer, run_home)

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        verdicts = list(pool.map(judge, randoms))
    for (guard, payload, writer), verdict in zip(randoms, verdicts):
        counts.setdefault(guard, {"suite": 0, "random": 0, "denied": 0})["random"] += 1
        if verdict == "deny":
            denied.append((guard, "random", json.dumps(payload), writer, None))
    for guard, *_ in denied:
        counts[guard]["denied"] += 1

    out = []
    out.append("// GENERATED by hooks/test-guard-oracles.sh --write. Do not edit by hand.")
    out.append("//")
    out.append("// Every case a frozen guard under tests/oracle/ refused: the cases its own")
    out.append("// suite fed it, and seeded random ones (tests/oracle/generate.py). Paths are")
    out.append(f"// written under the home {HOME}. tests/guard-differential.test.ts holds")
    out.append("// each port to refusing every one of them, unless SANDBOX shows the command")
    out.append("// did no harm under both bash and zsh.")
    out.append("")
    out.append("// `world` is the outbound prose guard's: the files, folders and vault root of")
    out.append("// the sandbox its case ran in, as JSON, with the sandbox written as PROSE_SANDBOX.")
    out.append("export type OracleCase = { guard: string; source: 'suite' | 'random'; payload: string; writer: string; world?: string }")
    out.append("")
    out.append(f"export const HOME = {json.dumps(HOME)}")
    out.append(f"export const PROSE_SANDBOX = {json.dumps(PROSE_SANDBOX)}")
    out.append("")
    out.append("// How many cases each guard read, from its suite and at random, and how many it refused.")
    out.append(f"export const COUNTS: Record<string, {{ suite: number; random: number; denied: number }}> = {json.dumps(counts, sort_keys=True)}")
    out.append("")
    out.append("export const DENIED: readonly OracleCase[] = [")
    for guard, source, payload, writer, world in denied:
        extra = "" if world is None else f", world: {json.dumps(world)}"
        out.append(f"  {{ guard: {json.dumps(guard)}, source: {json.dumps(source)}, payload: {json.dumps(payload)}, writer: {json.dumps(writer)}{extra} }},")
    out.append("]")
    out.append("")
    out.append("// SANDBOX: below this line, the sandboxed runs (generate.py --sandbox).")
    if with_sandbox:
        jobs = []
        for guard, _, payload, _, _ in denied:
            try:
                parsed = json.loads(payload)
            except json.JSONDecodeError:
                continue
            if not isinstance(parsed, dict) or parsed.get("tool_name") != "Bash":
                continue
            command = (parsed.get("tool_input") or {}).get("command")
            # Neither guard judges a command that can do harm: one reads a
            # message, the other a body posted with gh.
            if isinstance(command, str) and guard not in ("peer-message-gate", "outbound-prose-guard"):
                jobs.append((guard, command))
        jobs = sorted(set(jobs))
        scratch = os.environ.get("TMPDIR") or tempfile.gettempdir()

        def both(job):
            guard, command = job
            return {"bash": sandbox_run(guard, command, "bash", scratch), "zsh": sandbox_run(guard, command, "zsh", scratch)}

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(both, jobs))
        out.append("// Whether each refused command ran harmlessly, keyed by guard and command.")
        out.append("export const SANDBOX: Record<string, { bash: boolean; zsh: boolean }> = {")
        for (guard, command), result in zip(jobs, results):
            key = json.dumps(guard + "\u0000" + command)
            out.append(f"  {key}: {{ bash: {str(result['bash']).lower()}, zsh: {str(result['zsh']).lower()} }},")
        out.append("}")
    print("\n".join(out))


if __name__ == "__main__":
    main()
