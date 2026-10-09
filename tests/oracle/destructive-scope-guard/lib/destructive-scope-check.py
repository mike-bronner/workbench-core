#!/usr/bin/env python3
"""destructive-scope-check: the parsing and scope half of
hooks/destructive-scope-guard.sh.

IT FAILS CLOSED. EVERY OTHER CHECKER IN THIS DIRECTORY FAILS OPEN, AND A READER
WHO KNOWS THEM WILL ASSUME THIS ONE DOES TOO.

hooks/lib/scratch-delete-check.py — the file this one replaces — said so in its
own docstring: a command reaching `rm` through `bash -c`, `ssh`, `xargs`, or
`find -delete` was not followed, and globs, `$variables`, command substitution,
and `~user` were refused as operands. Every one of those printed nothing, and
printing nothing meant allow. That was correct THERE, because the call then fell
through to `Bash(rm -rf:*)` in permissions.ask and a human read a prompt. Missing
a shape cost one prompt.

This guard is written for the policy that removes those ask entries, so nothing
sits underneath it. A shape missed here does not reach a prompt; it reaches the
auto-mode classifier alone. So every documented limit above had to change sign:
what used to print nothing and prompt now DENIES, and the guard's whole job is
to be honest about which commands it cannot read.

THE RULE, stated once: a destructive statement whose every target this file can
resolve, and which resolves inside scope, is permitted. Anything else about a
destructive statement — a target it cannot resolve, a target outside scope, a
wrapper it cannot follow, text it cannot parse — is a deny.

WHAT COUNTS AS DESTRUCTIVE, AND WHY THIS LIST:
`rm` and `rmdir` in any spelling, and four git verbs — `reset --hard`,
`clean`, `stash clear`, `stash drop`. Those were the entries in permissions.ask
that act on a filesystem path or on a repository, which is what makes "inside
the project" a meaningful question about them, and they have been removed from
assets/permissions/rails.json in favour of this file. The fifteen ask entries
that remain act on published artifacts, system state, or the Keychain, where the
question is undefined; they are out of scope here and stay rules.

The git forms that overwrite uncommitted working-tree changes are here too,
though no ask entry ever named them. The dev-team pipeline runs `claude -p` in
bypass mode, where only an ask rule raises a prompt its PermissionRequest hook
can judge, so without this file `git restore` ran against any tree at all.
Each form below discards uncommitted work, per git's own documentation:
  - `git restore` that restores the working tree. It does when the last of
    `--worktree`/`--no-worktree` turns it on, and when neither that pair nor
    `--staged`/`--no-staged` is named at all. `--staged` alone touches only
    the index, and a command that turns both off is refused by git.
  - `git checkout` with `-f`/`--force`, with `-p`/`--patch`, with `--` and a
    word after it, with `--pathspec-from-file`, with two operands
    (`<tree-ish> <path>`), or with one operand that does not name a commit or
    a single remote branch. A word after `--end-of-options` is an operand
    even when it starts with a dash, and a redirection is no operand. In
    every one of those, git overwrites local changes. A remote branch whose
    name is also a tracked path counts as a path, because git reads it as one
    when it does not guess a tracking branch.
  - `git switch` with `-f`/`--force` or `--discard-changes`.
  - `git rm` with `-f`/`--force`, which removes files whose changes are not
    committed. Plain `git rm` refuses to, and `-n`/`--dry-run` removes
    nothing.
  - `git mv` with `-f`/`--force`, which overwrites an existing destination.
  - `git checkout-index` with `-f`/`--force`, which overwrites working-tree
    files from the index.
  - `git read-tree` with both `-u` and `--reset`. `-m -u` refuses to
    overwrite local changes.
  - `git submodule deinit -f`, which drops a submodule's local changes, and
    `git submodule update -f`, which throws them away when it switches
    commits.
Every option here is read as git reads it: the last of a pair such as
`--force` and `--no-force` holds, a word after `--` or `--end-of-options` is a
path, and an option that takes a value takes the next word.
Two forms reach past the worktree they run in, so they are refused inside the
roots too: `git submodule foreach` with a destructive command, which it runs
through the shell as `bash -c` does, and `git checkout-index -f --prefix`,
which writes wherever the prefix points.
A redirection operator is read as one, except that a quoted `'>'` reaches this
file as the same token. So where a tracked path has the operator's name, any
of the git forms above that carries it counts as a discard.

A GIT ALIAS IS JUDGED BY WHAT IT EXPANDS TO. `git co -- file`, with `co =
checkout` in a config file or on the command line through `-c alias.co=...`,
matches no verb above until it is expanded, so git_operation() expands it the
way git does and judges the result. An alias this file cannot expand counts
as destructive: one that runs shell (`!...`), one whose value is not in the
text or in config git can be asked about, and one that loops. Outside every
root that is a deny. Inside one it is silence, never an allow, because an
allow would grant whatever the alias runs. Config this file does not read can
set an alias or core.worktree, so `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`,
`HOME`, `XDG_CONFIG_HOME`, and `include.path` through `-c` or `--config-env`
each read as a moved repository, as `--work-tree` does.
A plain branch switch is not here. `git checkout <branch>`, `git switch
<branch>`, and the `-b`/`-c` creation forms refuse to overwrite local changes.
Telling `git checkout <branch>` from `git checkout <file>` takes the
repository, so git_checkout_discards() asks git whether the operand names a
commit, and treats every answer it cannot get as a path.

`rm -r`, plain `rm`, `rm -f`, and `rmdir` match no permission rule at all and
never did. The retired scratch-delete guard covered them anyway, and dropping
that coverage while retiring it would be a silent regression, so they are here.

WHAT COUNTS AS IN SCOPE. Four roots, and not one of them is read from an
environment variable the CALLER can set:

  1. The project, from CLAUDE_PROJECT_DIR. That variable is set by Claude Code
     for hook commands and is absent from the Bash tool environment entirely, so
     a command cannot nominate its own project — `CLAUDE_PROJECT_DIR=/ rm -rf x`
     sets it for the command being judged, never for the judge.
  2. The login home's Developer/scratchpad, where the home comes from the
     password database through getpwuid(3) and never from $HOME. bin/
     scratch-rm.sh's header recorded a reproduced attack for this: point $HOME
     at a directory holding a Developer/scratchpad — real, or a symlink to
     somewhere else — and every other check passes while the wrong tree is
     deleted. The resolution worked; the root it resolved against was the
     caller's.
  3. This session's scratchpad, found by matching the session id under
     /private/tmp/claude-*/ and /tmp/claude-*/. Matching the id pins this to
     THIS session: a sibling session's scratchpad sits under the same prefix,
     and losing another session's work is the outcome that rule exists against.
  4. This account's per-user temporary directory on Darwin, from
     `getconf DARWIN_USER_TEMP_DIR`. That is where `mktemp -d` lands, so tearing
     down a sandbox is the delete an agent makes most. It is NOT read from
     $TMPDIR, which is the $HOME hole under a new name — confstr(3) answers from
     the account rather than the environment. Off Darwin nothing is approved for
     this, because `mktemp -d` falls back to the shared /tmp there and every
     account on the machine can reach it.

ONE MORE PLACE A DELETE MAY LAND, AND IT IS NOT A ROOT. Agents once made
scratch folders by hand directly in /tmp — /private/tmp/claude-scratch-2cceb0cd,
/private/tmp/claude-summary-scratch — and this guard refused to let them clean
those up, so a human deleted six of them with `!`. So a delete is also
permitted when its target IS, or sits inside, a folder that sits directly in
the shared temporary directory, is named in the `claude-*scratch*` family, is a
real directory rather than a symlink, and is owned by this account. See
leftover_scratch() for how each of those is read. Nothing else in /tmp and
nothing else under /private qualifies: a first attempt approved all of
/private/tmp behind a list of protected names, and it was rejected in review
because `rm -rf /tmp/Claude-503` matched no protected spelling on
case-insensitive APFS and still reached the live claude-<uid> tree, which
holds every session's scratchpad.

AND ONE MARKER FILE AT A TIME IN THE MEMORY CACHE. The summary-writer agent
and log-now each finish by deleting their session's marker
in <cache>/pending-summaries/, and this guard denied every one of those deletes
from the day it shipped, so the backlog only grew. So a delete is also
permitted when its target is a `*.json` name directly in that folder and is
either absent or a regular file this account owns. The folder is the one
hooks/session-log.sh writes markers into, passed in as the third argument by the
guard, which resolves it through hooks/lib/memory-env.sh from the hook's own
environment and config. The folder and the cache root above it must be real
directories this account owns. See marker_dir() and pending_marker().

A DELETE MUST LAND STRICTLY BENEATH A ROOT; A GIT VERB MAY ACT ON ONE. The
asymmetry is the blast radius, not an oversight. `rm` destroys the path it names,
and each root holds live state that is not the caller's to destroy — the
scratchpads are shared across sessions and the temporary root holds every
process's working files — so a root ITSELF is never a delete target. A
leftover scratch folder is the opposite case: it is one agent's abandoned
working files rather than shared live state, and removing the folder itself is
the delete it is approved for. A git verb
destroys uncommitted state inside a worktree without removing the worktree, so
the worktree being the project root is the ordinary case and is permitted.

THE COMPARISON IS PHYSICAL, NEVER A STRING PREFIX. A path that merely STARTS
with an approved prefix can still land outside it: `<root>/link/x` where `link`
points at a repository, or `<root>/../../etc`. Each target is anchored on its
deepest EXISTING ancestor, resolved with realpath, which collapses `..` and
follows every symlink in the chain; the components below that anchor do not
exist, and a component that does not exist cannot be a symlink. The final
component is deliberately NOT dereferenced, because `rm -rf` on a symlink
removes the link and never its target. See physical() for the whole argument.

Output contract, matching the retired provisioning-check.py plus one word:
  exit 1, stdout  line 1 = the action the human line names, the rest = detail
                  → the guard denies
  exit 0, stdout `allow`
                  → the whole command is destructive-and-in-scope, and the
                    guard may say so
  exit 0, no stdout
                  → nothing to say; the ordinary permission flow applies

The third verdict is not a weaker allow. It is what a command gets when its
destructive statements are all in scope but it ALSO does something else —
`rm -rf <in-scope> && mkdir x`. A hook "allow" bypasses the permission system
for the WHOLE call, so granting one to a command carrying an arbitrary second
statement would grant that statement too. Saying nothing is the only honest
answer there.
"""

import functools
import glob
import os
import pwd
import re
import shlex
import shutil
import stat
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from shell_parse import (  # noqa: E402
    base,
    shell_cd_args,
    split_statements_grouped,
    strip_noop,
    token_lines_ex,
)

MAX_INPUT = 200_000

DELETE_VERBS = {"rm", "rmdir"}

# Shell keywords that stand in front of a command rather than being one.
# `for f in *; do rm -rf "$f"; done` splits into a statement whose first token
# is `do`, and reading THAT as the verb hands the loop body a free pass — the
# fail-open hole this guard exists to close, in the shape it is most likely to
# arrive in.
#
# THIS SET IS COMPLETE, AND COMPLETE IS CHECKABLE RATHER THAN HOPEFUL. POSIX
# defines exactly fifteen reserved words: ! { } case do done elif else esac fi
# for if in then until while. Of those, the ones FOLLOWED BY A COMMAND are the
# eight below — `if`, `elif`, `while` and `until` each take a command list as
# their condition, and `then`, `else`, `do` and `!` each precede one directly.
# The remaining seven are followed by a word, a pattern, or nothing at all:
# `for x in ...` and `case x in ...` name a variable and a pattern, `fi`, `done`
# and `esac` terminate, and `{` `}` are group markers the splitter already
# handles. hooks/test-destructive-scope-guard.sh enumerates all fifteen and
# checks this partition, so a keyword added to the language fails a test rather
# than opening a hole.
#
# The four condition-position keywords were missing, and `if rm -rf <outside>;
# then true; fi` was silent while `if true; then rm -rf <outside>; fi` denied —
# only the condition was blind, and `if rm -rf "$dir"; then` is the ordinary
# delete-and-check idiom.
KEYWORD_PREFIX = {"do", "then", "else", "!", "if", "elif", "while", "until"}

# Every POSIX reserved word, split into the ones that precede a command and the
# ones that do not. Exported for the test that checks the partition above; the
# walk itself reads KEYWORD_PREFIX.
POSIX_RESERVED = {"!", "{", "}", "case", "do", "done", "elif", "else", "esac",
                  "fi", "for", "if", "in", "then", "until", "while"}

# Characters that mean the verb slot is not a literal program name. `$` and a
# backtick mean the command is computed at runtime, a glob means it is chosen by
# the filesystem, and a surviving quote means the loose tokeniser ran and the
# token is not what it appears to be.
OPAQUE_VERB_CHARS = set("$`*?\"'")

# Commands that run another command whose text this file will not follow. Each
# one is a documented limit of the retired checker, and each is now a deny when
# it carries a destructive verb: the paths live in a string, in stdin, or on
# another machine, so "every target resolved" cannot be true of them.
WRAPPERS = {"bash", "sh", "zsh", "ksh", "dash", "eval", "source", ".",
            "ssh", "xargs", "find", "parallel", "watch", "timeout", "su"}

FIND_EXEC = {"-exec", "-execdir", "-ok", "-okdir"}

# Characters that mean the token is not the path it looks like. A glob stands
# for a set the shell has not expanded, `$` and a backtick stand for text that
# is not here, and `~` needs a home directory this file must not choose —
# resolving it would hand the caller the root that root 2 above refuses them.
UNRESOLVABLE = set("*?[]{}$`~\"'")

# A quote surviving into a token means the posix tokeniser failed and the loose
# retry ran, so the token is no longer the path it names. Refusing it is why the
# two quote characters are in the set above.

# The git builtins that discard nothing, and that agents run all the time. A
# builtin always runs as itself, because git ignores an alias that shares a
# builtin's name, so none of these can be an alias for a discard. Every OTHER
# word in git's subcommand slot is either one of the verbs git_operation()
# judges by name or a word that may be an alias, and both reach the checker.
# hooks/destructive-scope-guard.sh keeps the same list as GIT_SAFE, so a git
# call made only of these starts no python. The suite checks that the two lists
# match, that every name is a builtin, and that none is a judged verb.
GIT_SAFE_VERBS = (
    "add", "am", "apply", "archive", "bisect", "blame", "branch", "bundle",
    "cat-file", "check-attr", "check-ignore", "cherry", "cherry-pick",
    "clone", "commit", "commit-tree", "config", "count-objects", "describe",
    "diff", "diff-files", "diff-index", "diff-tree", "fetch", "for-each-ref",
    "format-patch", "fsck", "gc", "grep", "hash-object", "help", "init",
    "log", "ls-files", "ls-remote", "ls-tree", "merge", "merge-base",
    "mktag", "mktree", "notes", "pull", "push", "range-diff", "rebase",
    "reflog", "remote", "repack", "rev-list", "rev-parse", "revert",
    "shortlog", "show", "show-branch", "show-ref", "status", "symbolic-ref",
    "tag", "update-index", "update-ref", "var", "verify-commit",
    "verify-tag", "version", "worktree", "write-tree")

# The git options that take their value as a SEPARATE word. The fallback below
# needs them, because `git -C dir status` read with `-C` as a bare flag puts
# `dir` in the subcommand slot.
_GIT_VALUE_OPTION = r"(?:-C|-c|--git-dir|--work-tree|--namespace|--exec-path" \
                    r"|--super-prefix|--config-env)"

# The last-resort test, used only when the text will not tokenise at all. A
# command that cannot be parsed is exactly the case where a verb slot cannot be
# read, so this reads words instead and denies on a match.
_DESTRUCTIVE_BASE = (
    r"(?:^|[^\w./-])(?:rm|rmdir)(?:$|[^\w./-])"
    r"|git\b[^\n;&|]*?(?:reset\b[^\n;&|]*?--hard|clean\b|stash\s+(?:clear|drop))"
)
# The discard verbs are common words in a commit message, so they count only
# in the subcommand slot: after git, its options, and their values. An option
# that takes a value takes the next word, and any other option takes none, so
# the slot is read one way only. `\S*` lets `${GIT} restore` through for the
# any-case read below.
_GIT_SLOT = (r"git\b\S*(?:[ \t]+(?:" + _GIT_VALUE_OPTION + r"[ \t]+\S+"
             r"|(?!" + _GIT_VALUE_OPTION + r"(?:[ \t]|$))-\S+))*[ \t]+")
# Any word in the slot but a safe builtin, because an alias can stand for any
# discard.
_GIT_ANY_SUBCOMMAND = (
    r"(?!(?:" + "|".join(re.escape(verb) for verb in sorted(
        GIT_SAFE_VERBS, key=len, reverse=True)) + r")(?![\w-]))[^\s-]")
_DESTRUCTIVE_PATTERN = (_DESTRUCTIVE_BASE + r"|(?<![\w.-])" + _GIT_SLOT
                        + _GIT_ANY_SUBCOMMAND)
DESTRUCTIVE_WORD = re.compile(_DESTRUCTIVE_PATTERN)

# The same test for text that tokenised only through a lossy retry. That text
# is often a real command with a multi-line quoted message, and a message line
# such as "hold git mv -f to the roots" must not count. So there the any-word
# form counts only at the start of a line, after optional whitespace and
# NAME=value prefixes, where a command stands. The named discard verbs still
# count anywhere in the subcommand slot, as they did before aliases were read.
DESTRUCTIVE_WORD_INEXACT = re.compile(
    _DESTRUCTIVE_BASE
    + r"|(?<![\w.-])" + _GIT_SLOT + r"(?:restore|checkout|switch)\b"
    + r"|^[ \t]*(?:\w+=\S*[ \t]+)*" + _GIT_SLOT + _GIT_ANY_SUBCOMMAND,
    re.MULTILINE)

# The same needle, case-insensitively, and used ONLY as evidence that an
# unreadable verb slot is a destructive one. A command whose verb lives in a
# variable spells that verb in the variable's NAME, and shell convention makes
# the name upper case: `${RM} -rf /etc/x` runs `rm` and contains no lower-case
# `rm` at all. Matching case-sensitively there found nothing and returned
# silence. It is deliberately not used for the ordinary verb-slot reads, where
# `RM` is not a program anyone runs and folding case would only widen them.
DESTRUCTIVE_WORD_ANY_CASE = re.compile(_DESTRUCTIVE_PATTERN, re.IGNORECASE)

# git's own options, before the subcommand. Only the ones that consume a
# SEPARATE argument matter: miss one and its value is read as the subcommand.
GIT_VALUE_OPTS = {"-C", "-c", "--git-dir", "--work-tree", "--namespace",
                  "--exec-path", "--super-prefix", "--config-env"}

# The two that move git's idea of the repository somewhere this file is not
# tracking. `-C` is followed and the rest are refused rather than guessed at.
GIT_OPAQUE_OPTS = {"--git-dir", "--work-tree"}

# The environment variables that do the same. GIT_DIR, GIT_COMMON_DIR and
# GIT_WORK_TREE move the repository and the worktree. The rest point git at
# config this file does not read, and config can set core.worktree or an
# alias: GIT_CONFIG_PARAMETERS and GIT_CONFIG_COUNT carry it inline,
# GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM name its files, and HOME and
# XDG_CONFIG_HOME are where git finds the global file. A command that assigns
# one anywhere, as a prefix, an export, or a statement of its own, has every
# git verb in it read as moved.
GIT_ENV_MOVES = {"GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE",
                 "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
                 "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "HOME",
                 "XDG_CONFIG_HOME"}

# The git verbs whose verdict a word lost behind a quoted operator can change,
# and the discard each is read as then.
DISCARD_BY_VERB = {"checkout": "git checkout -- <path>",
                   "restore": "git restore", "rm": "git rm --force",
                   "checkout-index": "git checkout-index --force",
                   "read-tree": "git read-tree -u --reset",
                   "mv": "git mv --force",
                   "submodule": "git submodule deinit --force"}

# What git_operation() returns for an alias it cannot expand: one that runs
# shell, one whose value is not in the text or in config git can be asked
# about, and one that expands into itself. It counts as destructive, so outside
# every root it is refused. Inside one the guard says nothing, because it
# cannot say what an allow would grant.
UNRESOLVED_ALIAS = "a git alias this guard cannot expand"

# Discards whose reach is not the worktree the command runs in, so no root
# check can clear them. `submodule foreach` runs its command through the shell
# in every submodule, the way `bash -c` does. `checkout-index --prefix` writes
# its files wherever the prefix points.
SUBMODULE_FOREACH = "git submodule foreach"
CHECKOUT_INDEX_PREFIX = "git checkout-index --force --prefix"
REFUSED_ANYWHERE = {SUBMODULE_FOREACH, CHECKOUT_INDEX_PREFIX}

# The redirection operators, as the tokeniser splits them off. Each takes the
# word after it as its target. `<<-` arrives as `<<` and `-`, so its delimiter
# is read as a word of the command, which fails closed.
REDIRECT_OPS = {"<", ">", ">>", "<<", "<<<", "<&", ">&", "&>", "&>>", "<>",
                ">|"}


class Deny(Exception):
    """A verdict, carrying the human line's action and the model's detail."""

    def __init__(self, action, detail):
        super().__init__(action)
        self.action = action
        self.detail = detail


# ── scope roots ──────────────────────────────────────────────────────────────

def _real_dir(path):
    """The physical path of an existing directory, or None."""
    if not path or not os.path.isabs(path):
        return None
    resolved = os.path.realpath(path)
    return resolved if os.path.isdir(resolved) else None


def _login_home():
    """This account's home directory, from the password database rather than
    from $HOME. getpwuid(3) answers from the account, so no variable and no
    PATH the caller sets can redirect it — the same source bash's `~name`
    expansion reads, and the reason root 2 is trustworthy at all."""
    try:
        return pwd.getpwuid(os.getuid()).pw_dir
    except (KeyError, OSError):
        return None


def _darwin_temp_dir():
    """This account's per-user temporary directory, from confstr(3) rather than
    from $TMPDIR. getconf is spelled by absolute path so PATH cannot redirect
    it. Off Darwin the variable is unknown, getconf fails, and no temporary
    root is approved."""
    try:
        out = subprocess.run(["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"],
                             capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None
    value = out.stdout.strip()
    return value if out.returncode == 0 and value.startswith("/") else None


def _session_scratchpads(session_id):
    """This session's scratchpad directories, matched by id and containing no
    symlink at any level.

    THE SYMLINK CHECK IS THE WHOLE SAFETY OF THIS ROOT, AND WITHOUT IT THIS
    FUNCTION HANDS THE CALLER A ROOT OF THEIR CHOOSING. Every other root here is
    read from a source the caller cannot redirect — getpwuid, getconf, the hook
    environment — and this one is found by matching a PATTERN, which is an
    entirely different thing: any directory shaped
    `/tmp/claude-*/*/<session-id>/scratchpad` matches. The session id is not a
    secret either; it sits in the ordinary Bash environment as
    CLAUDE_CODE_SESSION_ID. So `mkdir -p` plus `ln -s` builds a fully approved
    fifth root pointing anywhere at all, and neither of those commands is
    destructive, so neither is gated by this guard. Reproduced: a fabricated
    root symlinked at `/Users/<user>` made a delete under the home directory
    resolve as in-scope.

    That is the same class closed for $HOME by reading the password database,
    re-entering through the glob — and bin/scratch-rm.sh was rejected in review
    on 2026-09-16 for a symlinked scratch root, which is this defect in its
    first life.

    Requiring realpath to equal the candidate refuses a symlink at ANY level,
    not only the last: a link at `<sid>` redirects just as well as one at
    `scratchpad`. It costs nothing real — the genuine scratchpad under
    /private/tmp contains no links, verified — and the `/tmp/...` spelling drops
    out on Darwin, where /tmp is itself a link to /private/tmp, which is exactly
    why both prefixes are globbed.

    A directory the caller merely CREATES, with no link in it, stays approved.
    That is not a hole: it holds nothing but what the caller just put there.
    """
    if not session_id or not re.fullmatch(r"[A-Za-z0-9-]+", session_id):
        return []
    found = []
    for prefix in ("/private/tmp/claude-", "/tmp/claude-"):
        for candidate in glob.glob(prefix + "*/*/" + session_id + "/scratchpad"):
            if os.path.realpath(candidate) == candidate:
                found.append(candidate)
    return found


def scope_roots(session_id):
    """Every approved root, as a physical path, deduplicated and in a stable
    order. A root that names no directory drops out here, so the caller reads
    one list and the refusal prints the same one."""
    candidates = []

    project = os.environ.get("CLAUDE_PROJECT_DIR")
    if project:
        candidates.append(project)

    home = _login_home()
    if home:
        candidates.append(os.path.join(home, "Developer", "scratchpad"))

    candidates += _session_scratchpads(session_id)

    temp = _darwin_temp_dir()
    if temp:
        candidates.append(temp)

    roots = []
    for candidate in candidates:
        real = _real_dir(candidate)
        # "/" would make the containment test below match every absolute path
        # on the machine, which is the one root that can never be approved.
        if real and real != "/" and real not in roots:
            roots.append(real)
    return roots


def beneath(path, roots):
    """True when the path sits strictly inside one of the roots."""
    return any(path.startswith(root + os.sep) for root in roots)


def within(path, roots):
    """True when the path IS one of the roots, or sits inside one."""
    return any(path == root for root in roots) or beneath(path, roots)


# The folder family a leftover scratch folder is named in, read against the
# name the entry carries ON DISK. Lower case on purpose: that is how every
# leftover was spelled, and `claude-<uid>` can never match, because it carries
# no `scratch`.
SCRATCH_FAMILY = re.compile(r"claude-[^/]*scratch[^/]*")


def _on_disk_name(directory, entry):
    """The name the directory entry with this lstat identity carries on disk,
    or None when no entry has it or the directory cannot be listed."""
    try:
        with os.scandir(directory) as listing:
            for candidate in listing:
                if candidate.inode() != entry.st_ino:
                    continue
                try:
                    if os.path.samestat(candidate.stat(follow_symlinks=False),
                                        entry):
                        return candidate.name
                except OSError:
                    continue
    except OSError:
        return None
    return None


def leftover_scratch(path):
    """True when the physical path IS, or sits inside, a leftover agent-scratch
    folder directly in the shared temporary directory.

    THE NAME IS READ FROM THE DIRECTORY LISTING, NEVER FROM THE TEXT THE CALLER
    TYPED. On case-insensitive APFS `/tmp/Claude-503` and `/tmp/claude-503` are
    one entry, so a spelling test judges a name no file carries. This finds the
    entry the path lands on by lstat identity and reads the name that entry
    really has, so a case variant is judged exactly as the entry itself is.

    The rest is reused rather than rebuilt. `path` comes from physical(), which
    has already resolved every ancestor and collapsed any `..`, so the
    temporary directory is compared as its realpath and a symlink out of it
    never reaches here under a /tmp spelling. The top-level entry is lstat'ed,
    so a symlink named in the family is refused rather than followed, and so is
    a plain file. An entry another account owns is refused too, because on a
    shared /tmp anyone can create a folder with this name. Anything this cannot
    read — a missing entry, an unlistable directory — is False, which denies.
    """
    tmp = os.path.realpath("/tmp")
    if tmp == "/" or not path.startswith(tmp + os.sep):
        return False
    top = os.path.join(tmp, path[len(tmp) + 1:].split(os.sep, 1)[0])
    try:
        entry = os.lstat(top)
    except OSError:
        return False
    if not stat.S_ISDIR(entry.st_mode) or entry.st_uid != os.getuid():
        return False
    name = _on_disk_name(tmp, entry)
    return bool(name and SCRATCH_FAMILY.fullmatch(name))


# A session-summary marker's name: the session id, then `.json`. The leading
# character is a letter or digit so `.` and `..`-shaped names never match.
MARKER_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\.json")


def marker_dir(candidate):
    """The pending-summaries directory as a physical path, or None when it is
    not one this account owns as a real directory.

    The location arrives from the guard, which resolves it the way the writer
    of the markers does (hooks/lib/memory-env.sh), from the hook's own
    environment and config rather than from the command being judged. Ancestors
    above the cache root may be links, the way /tmp is on Darwin, and realpath
    resolves them. The cache root and pending-summaries itself may not be:
    lstat refuses a link there rather than following it, because a link is how
    a caller would aim this permit at a directory of its choosing.
    """
    if not candidate or not os.path.isabs(candidate):
        return None
    candidate = os.path.normpath(candidate)
    for level in (os.path.dirname(candidate), candidate):
        try:
            entry = os.lstat(level)
        except OSError:
            return None
        if not stat.S_ISDIR(entry.st_mode) or entry.st_uid != os.getuid():
            return None
    real = os.path.realpath(candidate)
    return real if real != "/" else None


def pending_marker(path, markers):
    """True when the physical path is a session-summary marker: a `*.json` name
    directly inside the pending-summaries directory, and either absent or a
    regular file this account owns.

    THIS IS AS NARROW AS THE LEFTOVER-SCRATCH PERMIT, AND ON PURPOSE. The
    summary-writer and log-now each end by deleting one
    marker file, and nothing else under the cache is theirs to delete. So the
    directory itself is refused, a subdirectory is refused, a name outside the
    marker shape is refused, and so is a link or a directory that happens to
    carry a marker's name. An absent marker is permitted, because `rm -f` of a
    missing file deletes nothing.
    """
    if not markers or os.path.dirname(path) != markers:
        return False
    if not MARKER_NAME.fullmatch(os.path.basename(path)):
        return False
    try:
        entry = os.lstat(path)
    except FileNotFoundError:
        return True
    except OSError:
        return False
    return stat.S_ISREG(entry.st_mode) and entry.st_uid == os.getuid()


def roots_note(roots):
    """What a refusal says about the scope it checked against. An empty list
    with no explanation is the one refusal nobody can act on."""
    family = (" A delete may also remove a leftover scratch folder of this "
              "account's own directly in /tmp, named claude-*scratch*, and "
              "a single session-summary marker file directly in the memory "
              "cache's pending-summaries folder.")
    if not roots:
        return ("No scope root resolved at all: CLAUDE_PROJECT_DIR names no "
                "directory, and neither does any scratch root." + family)
    return "In scope right now: " + ", ".join(roots) + "." + family


# ── path resolution ──────────────────────────────────────────────────────────

def physical(path):
    """The path, anchored on its deepest existing ancestor resolved physically,
    or a Deny when the text settles no single file.

    THE ANCHOR IS THE DEEPEST EXISTING ANCESTOR RATHER THAN THE IMMEDIATE
    PARENT, and the difference is ordinary work. `rm -rf build/out` where
    `build` does not exist yet is the idiom every idempotent cleanup script
    uses, and it deletes nothing at all — refusing it would be friction
    protecting against no outcome.

    It gives up no safety. realpath on the anchor collapses `..` against the
    real tree and follows every symlink in it, which is what keeps
    `<root>/link/x` and `<root>/../../etc` from passing a prefix test. The
    components BELOW the anchor do not exist, and a component that does not
    exist cannot be a symlink, so there is nothing there left to follow. `.`
    and `..` are refused among them rather than reasoned about, because a path
    naming a directory by position names no entry to delete.

    THE FINAL COMPONENT IS NOT DEREFERENCED — UNLESS THE OPERAND CARRIED A
    TRAILING SLASH, WHICH CHANGES WHAT `rm` DOES. `rm -rf link` removes the link
    and never its target, so deleting a symlink inside a root is safe and is
    ordinary cleanup. `rm -rf link/` is a different command: measured on BSD rm,
    `ln -s target link; rm -rf link/` empties `target` and leaves `link`
    dangling. Stripping the slash and then declining to dereference reads the
    second command as the first, and hands back an answer about a file the shell
    is not going to touch.

    That spelling is the routine one, not an exotic one: tab completion appends
    the slash, so `rm -rf node_modules/` on a workspace symlink is the ordinary
    case rather than the crafted one.
    """
    if path.endswith("/"):
        # The slash means "the directory this names", so resolve THROUGH the
        # final component. A target that resolves to no directory falls back to
        # the ordinary walk below, where it deletes nothing anyway.
        through = os.path.realpath(path)
        if os.path.isdir(through):
            return through
    trimmed = path.rstrip("/") or "/"
    if trimmed == "/":
        raise Deny("a destructive command aimed at the filesystem root",
                   'The target resolves to "/", which is no project and no '
                   "scratchpad.")

    trailing = []
    probe = trimmed
    while True:
        parent, name = os.path.split(probe)
        if not name:
            break
        if name in (".", ".."):
            raise Deny("a destructive command whose target this guard cannot "
                       "resolve",
                       'The target "%s" names a directory by position with '
                       '"%s" rather than naming an entry to delete. Pass the '
                       "path itself." % (path, name))
        trailing.append(name)
        anchor = os.path.realpath(parent or "/")
        if os.path.isdir(anchor):
            return os.path.join(anchor, *reversed(trailing))
        probe = parent

    raise Deny("a destructive command whose target this guard cannot resolve",
               'No ancestor of "%s" is an existing directory, so the target '
               "cannot be resolved physically and cannot be checked against "
               "the scope roots." % path)


def resolve_operand(token, here):
    """The physical path a delete operand names, or a Deny."""
    if not token:
        raise Deny("a destructive command whose target this guard cannot "
                   "resolve", "One delete operand is the empty string.")
    bad = sorted(set(token) & UNRESOLVABLE)
    if bad:
        raise Deny("a destructive command whose target this guard cannot "
                   "resolve",
                   'The operand "%s" carries %s, so the text does not say '
                   "which paths are meant: a glob stands for a set the shell "
                   "has not expanded, a variable or a substitution stands for "
                   "text that is not here, and a tilde needs a home directory "
                   "this guard must not choose for you. Spell the absolute "
                   "path out, or run the command yourself with the ! prefix."
                   % (token, " ".join(repr(c) for c in bad)))
    if os.path.isabs(token):
        return physical(token)
    if not here:
        raise Deny("a destructive command whose target this guard cannot "
                   "resolve",
                   'The operand "%s" is relative and this call carried no '
                   "working directory, so the same text names a different "
                   "file in every directory on the machine." % token)
    return physical(os.path.join(here, token))


def operands(tokens):
    """(the path arguments of one delete command, whether it redirects).

    Options are dropped by shape rather than by table. `rm` and `rmdir` take no
    option that consumes a SEPARATE argument on either macOS or GNU — the ones
    with values are `=`-joined — so a leading `-` is always an option and never
    a path, and everything after `--` is always a path and never an option.

    A redirection ends the operand list, because everything from the operator
    on belongs to the redirect rather than to the delete. Reading those tokens
    as paths is not a cosmetic error: `>` and the filename after it would each
    be resolved and scope-checked, and `rm -rf x 2> log` would hand `2` to the
    resolver as a relative path. The caller also refuses to grant an allow to a
    statement that redirects, since truncating a file is something besides
    deleting one.
    """
    paths = []
    literal = False
    redirect = False
    for token in tokens:
        if "<" in token or ">" in token:
            redirect = True
            # A bare file-descriptor number belongs to the operator that
            # follows it, never to rm.
            if paths and paths[-1].isdigit():
                paths.pop()
            break
        if not literal and token == "--":
            literal = True
            continue
        if not literal and token.startswith("-") and token != "-":
            continue
        paths.append(token)
    return paths, redirect


# ── git ──────────────────────────────────────────────────────────────────────

def strip_redirects(tokens):
    """(the tokens without their redirections, the bare numbers that stood in
    front of one, the operators taken out).

    Each operator and the word after it go, wherever they sit: git takes
    `git checkout >/dev/null -- file` as `git checkout -- file`, so stopping at
    the first one would lose the `--`. The tokeniser splits `2>` into `2` and
    `>`, the same as `2 >`, so a number in front of an operator may be a file
    descriptor or a word of the command. It also gives a quoted `'>'` as the
    same token as a bare `>`, so an operator may be a path, and the word after
    it an option. The caller decides both. The fourth value is where each
    kept token stood in `tokens`."""
    kept, numbers, operators, positions = [], [], [], []
    target = False
    for index, token in enumerate(tokens):
        if target:
            target = False
            continue
        if token in REDIRECT_OPS:
            target = True
            operators.append(token)
            if kept and kept[-1].isdigit():
                numbers.append(kept.pop())
                positions.pop()
            continue
        kept.append(token)
        positions.append(index)
    return kept, numbers, operators, positions


def _moves_config(key):
    """True when a config key set on the command line moves the worktree or
    pulls in a file of config this file does not read. core.worktree moves
    the worktree as --work-tree does, and an included file can set it, or an
    alias, from anywhere."""
    key = key.lower()
    return key in ("core.worktree", "include.path") or (
        key.startswith("includeif.") and key.endswith(".path"))


def git_parts(args):
    """(the -C values in order, whether an option moved the repository
    somewhere this file does not track, the subcommand tokens, the bare
    numbers that stood in front of a redirection, the redirection operators
    taken out, the aliases set on the command line, where the subcommand
    stands in `args`).

    The aliases map each lower-case name to its value, or to None when the
    text does not hold the value: `-c alias.x` with no `=`, and
    `--config-env`, whose value is in the environment. git reads an alias
    name in any case, and the last setting wins. git takes neither `--` nor
    `--end-of-options` before the subcommand, so neither ends the options
    here."""
    rest, numbers, operators, positions = strip_redirects(args)
    chdirs = []
    opaque = False
    aliases = {}
    while rest and rest[0].startswith("-"):
        option = rest.pop(0)
        name = option.split("=", 1)[0]
        joined = "=" in option
        if name in GIT_OPAQUE_OPTS:
            opaque = True
            if not joined and rest:
                rest.pop(0)
            continue
        if name == "-C":
            chdir = option.split("=", 1)[1] if joined else (
                rest.pop(0) if rest else None)
            if chdir is None:
                opaque = True
            else:
                chdirs.append(chdir)
            continue
        if name in GIT_VALUE_OPTS:
            value = option.split("=", 1)[1] if joined else (
                rest.pop(0) if rest else "")
            if name in ("-c", "--config-env"):
                key, has_value, setting = value.partition("=")
                if _moves_config(key):
                    opaque = True
                if key.lower().startswith("alias."):
                    aliases[key[len("alias."):].lower()] = (
                        setting if name == "-c" and has_value else None)
    verb_at = positions[len(positions) - len(rest)] if rest else len(args)
    return chdirs, opaque, rest, numbers, operators, aliases, verb_at


def git_directory(args, here):
    """(the directory git starts in, None) or (None, why it is unknown). Each
    relative -C resolves against the one before it, as git resolves it."""
    chdirs, opaque = git_parts(args)[:2]
    if opaque:
        return None, ("The command sets --git-dir, --work-tree, "
                      "core.worktree, or include.path, or one of the "
                      "GIT_DIR, GIT_WORK_TREE, GIT_CONFIG_*, HOME, and "
                      "XDG_CONFIG_HOME variables, which moves git's idea of "
                      "the repository, or its config, somewhere this guard "
                      "is not tracking.")
    directory = here
    for chdir in chdirs:
        if set(chdir) & UNRESOLVABLE:
            return None, ('The -C operand "%s" carries an unexpanded glob, '
                          "variable, substitution or tilde." % chdir)
        # An absolute -C replaces what came before, which join does itself.
        if directory or os.path.isabs(chdir):
            directory = os.path.join(directory or "", chdir)
    if not directory:
        return None, ("The call carried no working directory, so which "
                      "repository the command acts on is not settled by its "
                      "text.")
    return directory, None


def _git_at(args, here):
    """(git, the directory it starts in), or None when either is unknown."""
    directory, _ = git_directory(args, here)
    git = shutil.which("git")
    return (git, directory) if directory and git else None


def _tracked(where, name):
    """True unless git answers that no tracked path matches `name`. Exit 1 is
    that answer. Anything else, `where` unknown included, is an answer not
    had, and counts as a path."""
    if not where:
        return True
    try:
        found = subprocess.run(
            [where[0], "-C", where[1], "ls-files", "--error-unmatch", "--",
             name], capture_output=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return True
    return found.returncode != 1


def _long(token, name):
    """True when `token` spells the long option `name`, whole or abbreviated.
    git accepts any unambiguous prefix, so `--forc` is `--force`. An ambiguous
    prefix makes git refuse the command, so counting it is harmless."""
    spelled = token.split("=", 1)[0]
    return len(spelled) > 2 and name.startswith(spelled)


def _names_branch(where, name, guess):
    """True when git would read `name` as a branch to switch to rather than as
    a path: it resolves to a commit, or `guess` is on, exactly one remote
    carries a branch of that name, and no tracked path has it. `where` is what
    _git_at() returned. Every answer this cannot get is False, so an
    unreadable operand is treated as the path that discards work."""
    if name == "-":
        return True  # the previous branch, `@{-1}`
    # `$` and a backtick stand for text the shell substitutes. `*?[\` make git
    # read the operand as a pathspec, and make for-each-ref below glob. Quotes
    # are not here: an operand still carrying one reached this function only
    # through the exact tokeniser, so the quote is part of the name.
    if not where or set(name) & set("$`*?[\\"):
        return False
    git, directory = where
    try:
        commit = subprocess.run(
            [git, "-C", directory, "rev-parse", "--verify", "--quiet",
             "--end-of-options", name + "^{commit}"],
            capture_output=True, timeout=10)
        if commit.returncode == 0:
            return True
        if not guess:
            return False
        remote = subprocess.run(
            [git, "-C", directory, "for-each-ref", "--format=%(refname)",
             "refs/remotes/*/" + name],
            capture_output=True, text=True, timeout=10)
        # git creates a tracking branch only when exactly one remote matches.
        # With two, it falls back to reading the operand as a path.
        if len(remote.stdout.split()) != 1:
            return False
    except (OSError, subprocess.SubprocessError):
        return False
    # git skips the guess and restores the path instead when checkout.guess is
    # off or the ref's remote is no longer configured. This file reads
    # neither, so a tracked path of that name decides it.
    return not _tracked(where, name)


def git_checkout_discards(args, tail, here, numbers):
    """The name of the discarding form of `git checkout`, or None for a branch
    switch. `args` is the whole git argument list, for `-C`. `numbers` are the
    bare numbers that stood in front of a redirection."""
    operands = []
    guess = True
    options = True
    index = 0
    while index < len(tail):
        token = tail[index]
        index += 1
        if token == "--":
            # With nothing after it, `--` only closes the operands, and git
            # switches branches as it would without it.
            if index < len(tail):
                return "git checkout -- <path>"
            break
        if not options:
            operands.append(token)
            continue
        if token == "--end-of-options":
            options = False  # every word after it is an operand, dash or not
            continue
        if _long(token, "--pathspec-from-file"):
            return "git checkout -- <path>"
        if token.startswith("--"):
            if _long(token, "--force"):
                return "git checkout --force"
            if _long(token, "--patch"):
                return "git checkout --patch"
            if _long(token, "--no-guess"):
                guess = False
            # A new branch's name is not an operand. A start point after it
            # still is, and it names a commit.
            if "=" not in token and (_long(token, "--orphan")
                                     or _long(token, "--conflict")):
                index += 1
            continue
        if token.startswith("-") and token != "-":
            for position, flag in enumerate(token[1:], 1):
                if flag == "f":
                    return "git checkout --force"
                if flag == "p":
                    return "git checkout --patch"
                if flag in "bB":
                    # The rest of the cluster is the new branch's name, or the
                    # next token is when the cluster ends here.
                    if position == len(token) - 1:
                        index += 1
                    break
            continue
        operands.append(token)
    where = _git_at(args, here)
    # A number in front of a redirection is a file descriptor unless a space
    # stood between them, and the tokens cannot tell. git reads it as a path
    # only when a tracked path matches it.
    if any(_tracked(where, number) for number in numbers):
        return "git checkout -- <path>"
    if not operands:
        return None
    if len(operands) > 1 or not _names_branch(where, operands[0], guess):
        return "git checkout -- <path>"
    return None


def git_switch_discards(tail):
    """The name of the discarding form of `git switch`, or None."""
    # No `--` stop: what follows one is a branch name, and git refuses a
    # branch name that starts with a dash.
    for token in tail:
        if token.startswith("--"):
            if _long(token, "--force") or _long(token, "--discard-changes"):
                return "git switch --discard-changes"
            continue
        if token.startswith("-"):
            for flag in token[1:]:
                if flag == "f":
                    return "git switch --discard-changes"
                if flag in "cC":
                    break  # the rest of the cluster is a branch name
    return None


def git_restore_discards(tail):
    """`git restore` when it restores the working tree, or None. Each of the
    two switches is None until named, then the last value given."""
    staged = worktree = None
    index = 0
    while index < len(tail):
        token = tail[index]
        index += 1
        if token in ("--", "--end-of-options"):
            break  # every word after it is a path
        if token.startswith("--"):
            if _long(token, "--source"):
                if "=" not in token:
                    index += 1
            elif _long(token, "--staged"):
                staged = True
            elif _long(token, "--no-staged"):
                staged = False
            elif _long(token, "--worktree"):
                worktree = True
            elif _long(token, "--no-worktree"):
                worktree = False
            continue
        if token.startswith("-"):
            for position, flag in enumerate(token[1:], 1):
                if flag == "S":
                    staged = True
                elif flag == "W":
                    worktree = True
                elif flag == "s":
                    if position == len(token) - 1:
                        index += 1
                    break  # the rest of the cluster is the source
    # git turns the working tree on by itself only when neither switch was
    # named. `--no-staged` alone leaves both off, and git refuses it.
    if worktree or (worktree is None and staged is None):
        return "git restore"
    return None


def _options(tail, shorts, longs, valued=(), valued_short=""):
    """The last value each named option takes before `--` or
    `--end-of-options`, as a dict. `shorts` maps a short flag, alone or in a
    cluster, to (key, value). `longs` maps a long option, spelled whole or
    abbreviated as git allows, to (key, value). An option in `valued` or
    `valued_short` takes the next word as its value when none is joined to
    it. git reads an option anywhere among the operands, so an operand does
    not end the read, and the last setting of a pair such as `--force` and
    `--no-force` is the one that holds."""
    state = {}
    index = 0
    while index < len(tail):
        token = tail[index]
        index += 1
        if token in ("--", "--end-of-options"):
            break
        if token.startswith("--"):
            for name, setting in longs.items():
                if _long(token, name):
                    state[setting[0]] = setting[1]
                    break
            if "=" not in token and any(_long(token, name) for name in valued):
                index += 1
            continue
        if token.startswith("-") and token != "-":
            for position, flag in enumerate(token[1:], 1):
                if flag in shorts:
                    state[shorts[flag][0]] = shorts[flag][1]
                if flag in valued_short:
                    # The rest of the cluster is the value, or the next word
                    # is when the cluster ends here.
                    if position == len(token) - 1:
                        index += 1
                    break
    return state


# The two option pairs most verbs below read. A dry run discards nothing, and
# the last of each pair holds.
FORCE = {"--force": ("force", True), "--no-force": ("force", False)}
DRY_RUN = {"--dry-run": ("dry", True), "--no-dry-run": ("dry", False)}
SHORT_FORCE = {"f": ("force", True)}
SHORT_DRY = {"n": ("dry", True)}


def git_submodule_discards(tail):
    """The discarding form of `git submodule`, or None. `deinit -f` drops a
    submodule's local changes, and `update -f` throws them away when it
    switches commits. `foreach` runs its command through the shell in every
    submodule, so a destructive one is refused as `bash -c` is."""
    index = 0
    # `--quiet` and `--cached` may stand in front of the subcommand.
    while index < len(tail) and tail[index].startswith("-"):
        index += 1
    if index == len(tail):
        return None
    sub, rest = tail[index], tail[index + 1:]
    if sub == "foreach":
        return SUBMODULE_FOREACH if scan_text(" ".join(rest), 1) else None
    if sub == "deinit":
        force = _options(rest, SHORT_FORCE, FORCE).get("force")
        return "git submodule deinit --force" if force else None
    if sub == "update":
        force = _options(rest, SHORT_FORCE, FORCE,
                         ("--reference", "--depth", "--jobs", "--filter"),
                         "j").get("force")
        return "git submodule update --force" if force else None
    return None


def _judge_verb(verb, tail, args, here, numbers, operators):
    """The discard a builtin git verb performs, or None."""
    # A quoted `'>'` reads as a redirection, so the word after it, which may
    # be `-f` or `--worktree`, was taken out with it. When a tracked path has
    # the operator's name, the operator may have been that path, and what it
    # took out cannot be known.
    if verb in DISCARD_BY_VERB:
        where = _git_at(args, here)
        if any(_tracked(where, operator) for operator in operators):
            return DISCARD_BY_VERB[verb]
    if verb == "restore":
        return git_restore_discards(tail)
    if verb == "checkout":
        return git_checkout_discards(args, tail, here, numbers)
    if verb == "switch":
        return git_switch_discards(tail)
    if verb in ("rm", "mv"):
        # `rm -f` removes a file whose changes are not committed, which plain
        # `git rm` refuses to do. `mv -f` overwrites the destination, which
        # plain `git mv` refuses to do. `-n` does neither.
        state = _options(tail, dict(SHORT_FORCE, **SHORT_DRY),
                         dict(FORCE, **DRY_RUN), ("--pathspec-from-file",))
        if state.get("force") and not state.get("dry"):
            return "git %s --force" % verb
        return None
    if verb == "checkout-index":
        # `-f` overwrites working-tree files from the index. `-n` still
        # refreshes the files that exist, so it is no dry run.
        state = _options(tail, SHORT_FORCE,
                         dict(FORCE, **{"--prefix": ("prefix", True)}),
                         ("--prefix", "--stage"))
        if not state.get("force"):
            return None
        return CHECKOUT_INDEX_PREFIX if state.get("prefix") \
            else "git checkout-index --force"
    if verb == "read-tree":
        # `-u` writes the tree into the working tree, and `--reset` lets it
        # overwrite local changes. `-m -u` refuses to.
        state = _options(tail, dict({"u": ("update", True)}, **SHORT_DRY),
                         dict({"--reset": ("reset", True),
                               "--no-reset": ("reset", False)}, **DRY_RUN),
                         ("--prefix", "--exclude-per-directory",
                          "--index-output"))
        if state.get("update") and state.get("reset") \
                and not state.get("dry"):
            return "git read-tree -u --reset"
        return None
    if verb == "submodule":
        return git_submodule_discards(tail)
    if verb == "reset" and any(t == "--hard" for t in tail):
        return "git reset --hard"
    if verb == "clean":
        # A dry run prints and removes nothing. `git clean` with neither -f
        # nor -n refuses to run at all, and counting it as destructive is the
        # safe direction to be wrong in. `-e` takes a pattern, which may be
        # spelled `-n`.
        state = _options(tail, SHORT_DRY, DRY_RUN, ("--exclude",), "e")
        return None if state.get("dry") else "git clean"
    if verb == "stash" and tail and tail[0] in ("clear", "drop"):
        return "git stash " + tail[0]
    return None


# The verbs _judge_verb() reads by name. Each is a builtin, so git never runs
# an alias in its place.
GIT_JUDGED = {"restore", "checkout", "switch", "rm", "mv", "checkout-index",
              "read-tree", "submodule", "reset", "clean", "stash"}


@functools.lru_cache(maxsize=None)
def git_builtins():
    """The names git runs as builtins, or None when git cannot be asked. It
    needs no repository, so a wrapper's command, which has none, can use it
    too."""
    git = shutil.which("git")
    if not git:
        return None
    try:
        out = subprocess.run([git, "--list-cmds=builtins"],
                             capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    names = frozenset(out.stdout.split())
    return names if out.returncode == 0 and names else None


def git_alias(args, here, name, aliases):
    """The words the alias `name` expands to, None when git has no alias of
    that name, or UNRESOLVED_ALIAS.

    A setting on the command line wins, as it does in git. Otherwise git is
    asked, in the directory the command runs in, because the repository's own
    config can hold an alias. A command that moved the repository or its
    config leaves no directory to ask in, and exit status 1 is the only
    answer that means no alias. A value that starts with `!` runs shell, and
    one that will not split is one git will not run either."""
    if set(name) & UNRESOLVABLE:
        return UNRESOLVED_ALIAS  # the shell decides the word, not the text
    if name.lower() in aliases:
        value = aliases[name.lower()]
    else:
        where = _git_at(args, here)
        if not where:
            return UNRESOLVED_ALIAS
        try:
            found = subprocess.run(
                [where[0], "-C", where[1], "config", "--get",
                 "alias." + name], capture_output=True, text=True, timeout=10)
        except (OSError, subprocess.SubprocessError):
            return UNRESOLVED_ALIAS
        if found.returncode == 1:
            return None
        if found.returncode != 0:
            return UNRESOLVED_ALIAS
        value = found.stdout[:-1] if found.stdout.endswith("\n") \
            else found.stdout
    if value is None or value.startswith("!"):
        return UNRESOLVED_ALIAS
    try:
        return shlex.split(value)
    except ValueError:
        return UNRESOLVED_ALIAS


def git_operation(args, here=None, seen=()):
    """(the name of the destructive git operation this command performs, or
    None; the argument list git runs once every alias is expanded).

    Read from the subcommand slot, so `git log --grep="git clean"` is not
    one. `here` is the working directory, which `git checkout` needs to tell a
    branch from a path, and an alias needs to be looked up. Without it every
    one-operand checkout counts, and so does every alias.

    AN ALIAS IS JUDGED BY WHAT IT EXPANDS TO, THE WAY GIT RUNS IT. git runs a
    builtin as itself and ignores an alias of the same name, so a builtin is
    read first. Any other word is looked up as an alias, and the expansion
    takes its place in the argument list. The expansion can carry options of
    its own, `-c core.worktree` among them, so the whole list is read again
    from the start. An alias may name another alias, and one that comes back
    to a name already expanded is a loop."""
    parts = git_parts(args)
    rest, aliases, verb_at = parts[2], parts[5], parts[6]
    if not rest:
        return None, args
    verb = rest[0]
    if verb in GIT_JUDGED:
        return _judge_verb(verb, rest[1:], args, here, parts[3],
                           parts[4]), args
    builtins = git_builtins()
    if builtins is not None and verb in builtins:
        return None, args
    if verb.lower() in seen:
        return UNRESOLVED_ALIAS, args
    words = git_alias(args, here, verb, aliases)
    if words is None or words == []:
        return None, args  # no alias, or an empty one, which git refuses
    if words == UNRESOLVED_ALIAS:
        return UNRESOLVED_ALIAS, args
    expanded = args[:verb_at] + words + args[verb_at + 1:]
    return git_operation(expanded, here, seen + (verb.lower(),))


def git_destructive(args, here=None):
    """The name of the destructive git operation this command performs, or
    None. See git_operation()."""
    return git_operation(args, here)[0]


def git_worktree(args, here):
    """The physical root of the worktree a git command acts on, or a Deny."""
    directory, why = git_directory(args, here)
    if why:
        raise Deny("a destructive git command whose repository this guard "
                   "cannot resolve", why)
    git = shutil.which("git")
    if not git:
        raise Deny("a destructive git command whose repository this guard "
                   "cannot resolve",
                   "git is not on this guard's PATH, so the worktree root "
                   "cannot be read.")
    try:
        out = subprocess.run([git, "-C", directory, "rev-parse",
                              "--show-toplevel"],
                             capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError) as error:
        raise Deny("a destructive git command whose repository this guard "
                   "cannot resolve",
                   "Reading the worktree root failed: %s" % error)
    top = out.stdout.strip()
    if out.returncode != 0 or not top:
        raise Deny("a destructive git command whose repository this guard "
                   "cannot resolve",
                   '"%s" is not inside a git worktree, so what the command '
                   "would destroy is not settled." % directory)
    real = _real_dir(top)
    if not real:
        raise Deny("a destructive git command whose repository this guard "
                   "cannot resolve",
                   'The worktree root "%s" is not an existing directory.' % top)
    return real


# ── wrappers ─────────────────────────────────────────────────────────────────

FOLLOW_NOTE = ("`%s` runs another command whose text this guard does not "
               "follow — the paths live in a quoted string, in stdin, or on "
               "another machine, so no target can be resolved and checked. "
               "Spell the delete out as its own command, or run this one "
               "yourself with the ! prefix.")

DELETE_NOTE = ("`find -delete` removes every file its expression matches, and "
               "which files those are is decided by walking the tree rather "
               "than by the command text, so there is no target here to "
               "resolve. Spell the delete out as its own command, or run this "
               "one yourself with the ! prefix.")


def hides_destructive(stage, depth):
    """Why a wrapper's arguments cannot be cleared, or None when they can.

    Returns prose rather than a boolean so the refusal can name what it hit;
    `scan_text` reads it for truthiness alone. Denying on any of these is the
    point: the paths live in a quoted string, in stdin, or on another machine,
    so "every target resolved" cannot be true of them.
    """
    verb = base(stage[0])
    args = stage[1:]

    if verb == "find":
        if any(token == "-delete" for token in args):
            return DELETE_NOTE
        for index, token in enumerate(args):
            if token in FIND_EXEC:
                if scan_text(" ".join(args[index + 1:]), depth + 1):
                    return FOLLOW_NOTE % verb
                return None
        return None

    # The suffix form reads a wrapper that takes its command as plain adjacent
    # arguments. Every suffix is tried, not only the whole list, because the
    # command rarely starts at the first argument: `xargs -n1 rm -rf` puts an
    # option in front of it and `timeout 5 rm -rf x` puts a duration there, and
    # reading only the joined list finds the verb slot occupied by `-n1` or `5`
    # and clears both.
    #
    # The cost is over-reach, and it is taken deliberately. `xargs grep rm`
    # denies, because one suffix of it is the single token `rm`. A wrapper
    # argument that merely spells a delete verb is a far rarer command than a
    # wrapper that runs one, and this guard has nothing underneath it to catch
    # the miss.
    if any(scan_text(" ".join(args[index:]), depth + 1)
           for index in range(len(args))):
        return FOLLOW_NOTE % verb
    # The per-token form reads a wrapper that takes its command as ONE quoted
    # argument, such as `bash -c "rm -rf x"`. Only multi-word tokens are tried,
    # because a single word is an argument rather than a command to follow —
    # without that, `xargs grep rm` would deny on the bare token `rm`.
    if any(len(token.split()) > 1 and scan_text(token, depth + 1)
           for token in args):
        return FOLLOW_NOTE % verb
    return None


def scan_text(text, depth):
    """True when the text contains a destructive verb in a verb slot. Reads the
    slot rather than the characters, so `grep -rn "rm -rf" .` is not one."""
    if not text.strip():
        return False
    if depth > 3:
        # Deeper than this guard will follow, and a wrapper nested four deep
        # around a destructive verb is not a shape to wave through.
        return True
    lines, exact, bodies = token_lines_ex(text)
    if not lines or not exact:
        # Nothing read, or read only through a retry that merged the lines or
        # kept the quotes, so the verb slots are not trustworthy. Fall back to
        # matching words, which over-reports rather than under-reports.
        return bool(DESTRUCTIVE_WORD.search(text))
    for tokens in lines:
        for _, stages in split_statements_grouped(tokens):
            for stage in stages:
                stage = strip_prefixes(stage)
                if not stage:
                    continue
                verb = base(stage[0])
                if verb in DELETE_VERBS:
                    return True
                if verb == "git" and git_destructive(stage[1:]):
                    return True
                # An unreadable verb slot, as in `env -i rm`. The real verb is
                # later in the statement, so keep looking rather than reading
                # `-i` as an unknown command.
                if opaque_verb(verb):
                    if any(base(t) in DELETE_VERBS for t in stage[1:]):
                        return True
                    if any(t == "git" and git_destructive(stage[i + 2:])
                           for i, t in enumerate(stage[1:])):
                        return True
                    continue
                if verb in WRAPPERS and hides_destructive(stage, depth):
                    return True
                if verb in WRAPPERS and heredoc_body_destructive(stage, bodies):
                    return True
    return False


# ── the walk ─────────────────────────────────────────────────────────────────

# Marks a group whose working directory is NOT restored when it closes, so the
# restore stack can tell "put this back" from "leave it alone" without None
# doing double duty — None is already a legitimate `here`, meaning the working
# directory is unknown.
_KEEP = object()

# The operators that introduce a heredoc. `<<-` arrives as `<<` plus a token
# whose leading `-` is part of the delimiter spelling, and extract_heredocs keys
# its bodies on the bare word.
HEREDOC_OPS = {"<<", "<<-"}


def heredoc_body_destructive(stage, bodies):
    """True when a heredoc fed to this stage runs a destructive verb.

    Only ever asked of a WRAPPER. A heredoc handed to `bash` or `ssh` is a
    script and its body is the command that actually runs; handed to `cat`,
    `tee`, or a file-writing helper it is data, and reading it as commands is
    how `cat <<EOF` carrying the text `rm -rf /` produced a refusal about a
    delete that was never going to happen.
    """
    for index, token in enumerate(stage[:-1]):
        if token not in HEREDOC_OPS:
            continue
        delimiter = stage[index + 1].lstrip("-").strip("'\"")
        for body in bodies.get(delimiter, []):
            if scan_text(body, 1):
                return True
    return False


def opaque_verb(verb):
    """True when the verb slot does not name a program this file can read.

    Empty, option-shaped, a bare file descriptor, or carrying any character that
    means the name is computed rather than written down. Everything this returns
    True for is a command whose identity is unknown at read time, which is the
    one thing a verb-slot guard cannot work with.
    """
    return (not verb
            or verb.startswith("-")
            or verb.isdigit()
            or bool(set(verb) & OPAQUE_VERB_CHARS))


def strip_prefixes(stage):
    """Drop env assignments, no-op wrappers such as `sudo`, and the shell
    keywords that stand in front of a command."""
    rest = strip_noop(stage)
    while rest and rest[0] in KEYWORD_PREFIX:
        rest = strip_noop(rest[1:])
    return rest


def cd_target(stage, here):
    """Where a `cd` leaves the working directory, or None when its text does
    not say. A None is not a refusal by itself — it becomes one only if a later
    destructive statement needs a directory to resolve against."""
    if len(stage) < 2:
        return None
    destination = stage[1]
    if set(destination) & UNRESOLVABLE:
        return None
    if os.path.isabs(destination):
        return destination
    return os.path.join(here, destination) if here else None


def judge(command, cwd, roots, markers=None):
    """(destructive targets seen, whether the command does nothing else), or a
    Deny. `markers` is the physical pending-summaries directory, or None."""
    lines, exact, bodies = token_lines_ex(command)
    if not lines:
        if DESTRUCTIVE_WORD.search(command):
            raise Deny("a destructive command this guard cannot parse",
                       "The command names a destructive verb and does not "
                       "tokenise, usually an unbalanced quote, so no target "
                       "can be read out of it.")
        return 0, False
    if not exact and DESTRUCTIVE_WORD_INEXACT.search(command):
        # The tokeniser fell back to a retry that loses information: the
        # whole-text one merges the lines, so a statement boundary that was
        # only a newline is gone and `mkdir /x` on one line hides `rm -rf /y`
        # on the next inside a single statement; the loose one leaves quotes
        # glued to their tokens, so an operand is no longer the path it names.
        # Either way the text was not read reliably, and this guard has nothing
        # underneath it to catch what it misreads.
        raise Deny("a destructive command this guard cannot read exactly",
                   "The command names a destructive verb and only tokenises "
                   "through a fallback that merges its lines or keeps its "
                   "quotes attached, so which statement acts on which path is "
                   "not settled. Split it into separate commands, or run it "
                   "yourself with the ! prefix.")

    targets = 0
    only_destructive = True
    here = cwd
    # An assignment is stripped from the front of its statement before the
    # verb is read, and an export reaches every statement after it, so both
    # are read here, over the whole command, before any verb is.
    env_moved = any("=" in token and token.split("=", 1)[0] in GIT_ENV_MOVES
                    for tokens in lines for token in tokens)
    for tokens in lines:
        # `restore` shadows the group stack: one entry per open group, holding
        # the working directory to put back when that group closes, or None
        # when the group does not restore it. A paren group runs in a subshell
        # so its `cd` is undone; a brace group runs in THIS shell so its `cd`
        # persists. Measured on bash 3.2, and both directions are a bypass if
        # they are confused — believing a paren cd resolves an outside delete
        # as though it were inside, and discarding a brace cd forgets a `cd`
        # OUT of the safe tree.
        groups = ()
        restore = []
        for enclosing, stages in split_statements_grouped(tokens):
            while len(restore) > len(enclosing):
                previous = restore.pop()
                if previous is not _KEEP:
                    here = previous
            for opener in enclosing[len(restore):]:
                restore.append(here if opener == "(" else _KEEP)
            groups = enclosing

            # Every stage of a pipeline runs in its own subshell, so a `cd`
            # among them changes nothing for the statement after.
            piped = len(stages) > 1
            for stage in stages:
                # Read before strip_prefixes, which also drops `sudo` and `env`:
                # a `cd` behind either runs in a child and moves nothing.
                moves = shell_cd_args(stage, KEYWORD_PREFIX)
                stage = strip_prefixes(stage)
                if not stage:
                    continue
                verb = base(stage[0])

                if moves is not None:
                    if not piped:
                        here = cd_target(["cd"] + moves, here)
                    continue

                # THE GENERAL RULE, AND IT IS THE FIX FOR A WHOLE CLASS RATHER
                # THAN FOR THE THREE SHAPES THAT HAPPENED TO BE REPORTED.
                # `);`, `env -i rm`, and a bare `if` condition were three
                # separate findings across two reviews, and all three are one
                # thing: the verb slot did not hold the verb, the walk read
                # whatever was there as an unknown command, and the delete
                # behind it produced silence. So this does not enumerate the
                # ways that can happen. A verb slot that is not a plain program
                # name is unreadable, and unreadable is refused.
                #
                # It covers a wrapper's own option (`env -i rm`, `nice -n 10
                # rm`), a file descriptor (`2>&1` mis-split), and a command
                # computed at runtime — `$(echo rm) -rf x`, `` `echo rm` ``,
                # `$(which rm)`, `${RM} -rf x`. bash runs every one of those.
                if opaque_verb(verb):
                    # The needle is the LINE rather than this statement, because
                    # a substitution splits into statements of its own: the `$`
                    # lands in one, `echo rm` inside the parens in another, and
                    # the arguments in a third, so no single statement holds
                    # both the opaque verb and the evidence.
                    if DESTRUCTIVE_WORD_ANY_CASE.search(" ".join(tokens)) \
                            or scan_text(" ".join(stage), 0):
                        raise Deny(
                            "a destructive command whose verb slot this guard "
                            "cannot read",
                            "Which program runs is not settled by the text — a "
                            "wrapper's own option, or a name computed at "
                            "runtime, sits where the command name should be — "
                            "and a destructive verb appears on the same line. "
                            "Spell the command out, or run it yourself with "
                            "the ! prefix.")
                    only_destructive = False
                    continue

                # A heredoc feeding a shell is a script, and its body is the
                # command that actually runs. Fed to anything else it is data —
                # `cat <<EOF` carrying the text `rm -rf /` deletes nothing — so
                # only a wrapper's body is read.
                if verb in WRAPPERS and heredoc_body_destructive(stage, bodies):
                    raise Deny(
                        "a destructive command this guard cannot follow",
                        "`%s` is fed a heredoc whose body runs a destructive "
                        "verb, and this guard does not follow a script it is "
                        "handed. Spell the delete out as its own command, or "
                        "run this one yourself with the ! prefix." % verb)

                if verb in DELETE_VERBS:
                    paths, redirect = operands(stage[1:])
                    if redirect:
                        # Truncating a file is something besides deleting one,
                        # so this statement can never earn the blanket allow.
                        only_destructive = False
                        if not paths:
                            raise Deny(
                                "a destructive command whose target this "
                                "guard cannot resolve",
                                "The delete redirects before it names a path, "
                                "so which file it removes cannot be read out "
                                "of the command text.")
                    for token in paths:
                        path = resolve_operand(token, here)
                        if path in roots:
                            raise Deny(
                                "deleting a scope root itself",
                                'The target "%s" resolves to "%s", which is '
                                "an approved root rather than something "
                                "inside one. Every root holds live state that "
                                "is not this session's to destroy — the "
                                "project, a scratchpad shared across "
                                "sessions, or the working files of everything "
                                "this account is running. Delete what is "
                                "inside it instead." % (token, path))
                        if not beneath(path, roots) \
                                and not leftover_scratch(path) \
                                and not pending_marker(path, markers):
                            raise Deny(
                                "deleting a path outside this project and "
                                "every scratch root",
                                'The target "%s" resolves to "%s", which is '
                                "not inside any approved root. %s"
                                % (token, path, roots_note(roots)))
                        targets += 1
                    continue

                if verb == "git":
                    args = stage[1:]
                    if env_moved:
                        # Read exactly as the option spelling of the move.
                        args = ["--work-tree=(environment)"] + args
                    operation, args = git_operation(args, here)
                    if operation is None:
                        only_destructive = False
                        continue
                    if operation in REFUSED_ANYWHERE:
                        raise Deny(
                            "a destructive git command this guard cannot "
                            "follow",
                            "`%s` acts outside the worktree it runs in: "
                            "`submodule foreach` runs its command through "
                            "the shell, and `checkout-index --prefix` writes "
                            "wherever the prefix points. So no root check "
                            "can clear it. Spell the discard out as its own "
                            "command, or run this one yourself with the ! "
                            "prefix." % operation)
                    worktree = git_worktree(args, here)
                    if not within(worktree, roots):
                        raise Deny(
                            "a destructive git command outside this project "
                            "and every scratch root",
                            '`%s` would run against the worktree at "%s", '
                            "which is not inside any approved root. %s"
                            % (operation, worktree, roots_note(roots)))
                    if operation == UNRESOLVED_ALIAS:
                        # In scope, but what it runs is unknown, so an allow
                        # would grant that too.
                        only_destructive = False
                        continue
                    targets += 1
                    continue

                if verb in WRAPPERS:
                    hidden = hides_destructive(stage, 0)
                    if hidden:
                        raise Deny("a destructive command this guard cannot "
                                   "follow", hidden)

                only_destructive = False
    return targets, only_destructive


def main():
    # MAX_INPUT + 1, so an input that fills the buffer can be told from one that
    # overran it. Reading exactly MAX_INPUT and asking no further question is
    # how a destructive statement past the cutoff became a command nobody read:
    # the shell prefilter matches the WHOLE text, so the call arrives here, and
    # an unread tail returned the same silence as a harmless command.
    command = sys.stdin.read(MAX_INPUT + 1)
    if len(command) > MAX_INPUT:
        sys.stdout.write(
            "a destructive command too long for this guard to read\n"
            "The command is longer than %d bytes, so it could not be read in "
            "full and a destructive statement past that point would be "
            "invisible here. Split it into smaller commands, or run it "
            "yourself with the ! prefix.\n" % MAX_INPUT)
        return 1
    if not command.strip():
        return 0
    cwd = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else None
    session_id = sys.argv[2] if len(sys.argv) > 2 else ""
    markers = marker_dir(sys.argv[3] if len(sys.argv) > 3 else "")
    if cwd:
        cwd = os.path.expanduser(cwd)

    roots = scope_roots(session_id)
    try:
        targets, only_destructive = judge(command, cwd, roots, markers)
    except Deny as deny:
        sys.stdout.write(deny.action + "\n" + deny.detail + "\n")
        return 1
    if targets and only_destructive:
        sys.stdout.write("allow\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
