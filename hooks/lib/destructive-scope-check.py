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

Output contract, matching hooks/lib/provisioning-check.py plus one word:
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

import glob
import os
import pwd
import re
import shutil
import stat
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from shell_parse import (  # noqa: E402
    base,
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

# The last-resort test, used only when the text will not tokenise at all. A
# command that cannot be parsed is exactly the case where a verb slot cannot be
# read, so this reads words instead and denies on a match.
_DESTRUCTIVE_PATTERN = (
    r"(?:^|[^\w./-])(?:rm|rmdir)(?:$|[^\w./-])"
    r"|git\b[^\n;&|]*?(?:reset\b[^\n;&|]*?--hard|clean\b|stash\s+(?:clear|drop))"
)
DESTRUCTIVE_WORD = re.compile(_DESTRUCTIVE_PATTERN)

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


def roots_note(roots):
    """What a refusal says about the scope it checked against. An empty list
    with no explanation is the one refusal nobody can act on."""
    family = (" A delete may also remove a leftover scratch folder of this "
              "account's own directly in /tmp, named claude-*scratch*.")
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

def git_parts(args):
    """(-C value or None, whether an opaque option moved the repository, the
    subcommand tokens)."""
    rest = list(args)
    chdir = None
    opaque = False
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
            continue
        if name in GIT_VALUE_OPTS and not joined and rest:
            rest.pop(0)
    return chdir, opaque, rest


def git_destructive(args):
    """The name of the destructive git operation this command performs, or
    None. Read from the subcommand slot, so `git log --grep="git clean"` is not
    one."""
    _, _, rest = git_parts(args)
    if not rest:
        return None
    verb = rest[0]
    tail = rest[1:]
    if verb == "reset" and any(t == "--hard" for t in tail):
        return "git reset --hard"
    if verb == "clean":
        # A dry run prints and removes nothing. `-n` also arrives clustered, as
        # in `-nd`. `git clean` with neither -f nor -n refuses to run at all,
        # and counting it as destructive is the safe direction to be wrong in.
        for token in tail:
            if token == "--dry-run":
                return None
            if token.startswith("-") and not token.startswith("--") \
                    and "n" in token:
                return None
        return "git clean"
    if verb == "stash" and tail and tail[0] in ("clear", "drop"):
        return "git stash " + tail[0]
    return None


def git_worktree(args, here):
    """The physical root of the worktree a git command acts on, or a Deny."""
    chdir, opaque, _ = git_parts(args)
    if opaque:
        raise Deny("a destructive git command whose repository this guard "
                   "cannot resolve",
                   "The command sets --git-dir or --work-tree, which moves "
                   "git's idea of the repository somewhere this guard is not "
                   "tracking.")
    directory = here
    if chdir:
        if set(chdir) & UNRESOLVABLE:
            raise Deny("a destructive git command whose repository this guard "
                       "cannot resolve",
                       'The -C operand "%s" carries an unexpanded glob, '
                       "variable, substitution or tilde." % chdir)
        directory = chdir if os.path.isabs(chdir) else (
            os.path.join(here, chdir) if here else None)
    if not directory:
        raise Deny("a destructive git command whose repository this guard "
                   "cannot resolve",
                   "The call carried no working directory, so which repository "
                   "the command acts on is not settled by its text.")
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


def judge(command, cwd, roots):
    """(destructive targets seen, whether the command does nothing else), or a
    Deny."""
    lines, exact, bodies = token_lines_ex(command)
    if not lines:
        if DESTRUCTIVE_WORD.search(command):
            raise Deny("a destructive command this guard cannot parse",
                       "The command names a destructive verb and does not "
                       "tokenise, usually an unbalanced quote, so no target "
                       "can be read out of it.")
        return 0, False
    if not exact and DESTRUCTIVE_WORD.search(command):
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
                stage = strip_prefixes(stage)
                if not stage:
                    continue
                verb = base(stage[0])

                if verb == "cd":
                    if not piped:
                        here = cd_target(stage, here)
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
                                and not leftover_scratch(path):
                            raise Deny(
                                "deleting a path outside this project and "
                                "every scratch root",
                                'The target "%s" resolves to "%s", which is '
                                "not inside any approved root. %s"
                                % (token, path, roots_note(roots)))
                        targets += 1
                    continue

                if verb == "git":
                    operation = git_destructive(stage[1:])
                    if operation is None:
                        only_destructive = False
                        continue
                    worktree = git_worktree(stage[1:], here)
                    if not within(worktree, roots):
                        raise Deny(
                            "a destructive git command outside this project "
                            "and every scratch root",
                            '`%s` would run against the worktree at "%s", '
                            "which is not inside any approved root. %s"
                            % (operation, worktree, roots_note(roots)))
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
    if cwd:
        cwd = os.path.expanduser(cwd)

    roots = scope_roots(session_id)
    try:
        targets, only_destructive = judge(command, cwd, roots)
    except Deny as deny:
        sys.stdout.write(deny.action + "\n" + deny.detail + "\n")
        return 1
    if targets and only_destructive:
        sys.stdout.write("allow\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
