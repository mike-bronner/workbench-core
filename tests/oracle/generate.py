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


def plant(root):
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
    for name in PROGRAMS:
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


# ─── the fixture ───────────────────────────────────────────────────────────


def main():
    cases_file, run_home = sys.argv[1], sys.argv[2]
    with_sandbox = "--sandbox" in sys.argv
    suite = []
    with open(cases_file) as f:
        for raw in f:
            record = json.loads(raw)
            suite.append((record["guard"], record["payload"], record["writer"], record["verdict"]))

    def to_fixture(text):
        return text.replace(run_home, HOME)

    denied = []
    counts = {}
    for guard, payload, writer, verdict in suite:
        counts.setdefault(guard, {"suite": 0, "random": 0, "denied": 0})["suite"] += 1
        if verdict == "deny":
            denied.append((guard, "suite", to_fixture(payload), writer))

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
            denied.append((guard, "random", json.dumps(payload), writer))
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
    out.append("export type OracleCase = { guard: string; source: 'suite' | 'random'; payload: string; writer: string }")
    out.append("")
    out.append(f"export const HOME = {json.dumps(HOME)}")
    out.append("")
    out.append("// How many cases each guard read, from its suite and at random, and how many it refused.")
    out.append(f"export const COUNTS: Record<string, {{ suite: number; random: number; denied: number }}> = {json.dumps(counts, sort_keys=True)}")
    out.append("")
    out.append("export const DENIED: readonly OracleCase[] = [")
    for guard, source, payload, writer in denied:
        out.append(f"  {{ guard: {json.dumps(guard)}, source: {json.dumps(source)}, payload: {json.dumps(payload)}, writer: {json.dumps(writer)} }},")
    out.append("]")
    out.append("")
    out.append("// SANDBOX: below this line, the sandboxed runs (generate.py --sandbox).")
    if with_sandbox:
        jobs = []
        for guard, _, payload, _ in denied:
            try:
                parsed = json.loads(payload)
            except json.JSONDecodeError:
                continue
            if not isinstance(parsed, dict) or parsed.get("tool_name") != "Bash":
                continue
            command = (parsed.get("tool_input") or {}).get("command")
            if isinstance(command, str) and guard != "peer-message-gate":
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
