#!/usr/bin/env python3
"""prose-check: check outbound prose against the lexical rules of the Clear standard.

Reads markdown on stdin. Prints one finding per line to stdout and exits 1 when
the prose violates a rule; exits 0 and prints nothing when it is clean. An
optional first argument names the memory vault root, so a pointer at a note
under a configured vault is caught as well as one under the default root.

Only the mechanically checkable rules live here. Structure, answer-first ordering,
and whether a document is a debugging journal are judgement calls that no regex
settles, so they stay in the output style where a reader applies them.

The three rules, each traceable to assets/personas/clear/output-style.md:
  em-dash       no em dash in prose (rule 8)
  semicolon     no semicolon in prose (rule 8)
  file-pointer  no path to a plan, a scratchpad file, or a vault note, which
                the reader cannot open from a pull request or an issue (rule 11)

Emoji, sentence length, and paragraph length were checked here once, and are
not now. A deny on a judgement call breeds workarounds: the writer pads a body
with an emoji or chops a sentence to pass the count, and the text gets no
easier to read. Density is a rule in the output style, applied by the writer.

What is deliberately NOT counted by the em-dash and semicolon checks, because
the author does not control it:
  - fenced and inline code, where a semicolon is the language's, not the writer's
  - HTML comments, and bot-authored regions such as CodeRabbit's release notes
  - `- [ ]` checklist lines, which come from a repository pull request template
  - URLs inside markdown links, which are addresses rather than prose

The file-pointer check reads a different slice. A pointer is most often written
as inline code, and an author writes their own checklist lines, so both count.
An inline-code span that is a command creating or writing a scratch location
is skipped, such as `mktemp -d ~/Developer/scratchpad/x.XXXXXX`, because that
names a place the reader acts on. A command that only reads a scratch location,
such as `cat` or `tail`, is never exempt, because reading a file points at
content the reader cannot see. The exempt commands are a fixed list, never a
PATH lookup: mktemp, mkdir, touch, tee, cp, mv, ln, cd, and ls, a shell (bash,
sh, zsh) running a script that is not itself in a scratch location, and
`git -C`. A command not on the list is not exempt. Even an exempt command keeps
the span checked when it names a plan or a vault path, which a reader can never
act on, or a scratchpad path whose last part ends in .md or .markdown, which is
content and not a place. A bare path in inline code, such as
`~/.claude/plans/x.md`, is always checked. Fenced code is still skipped, because
a pasted log quotes a path rather than pointing at it. HTML comments and bot
regions are skipped, because no reader sees them. An http or https URL is
skipped, because the reader can open it.

The check targets path families, never paths in general. A repository path is
a location the reader acts on, such as a file the change edits, so it passes.
A file under a plan folder, a scratchpad, or the vault lives on one machine,
and naming it in a body can only stand in for content the reader never sees.
A root on its own, such as `~/Developer/scratchpad`, names a place and passes.
A vault note named in prose counts only when the path's first folder is a
top-level folder of the vault root, so "Vault: kv/prod" and "the vault notes in
tests/fixtures/" pass.
"""

import os
import re
import sys

BOT_REGION = re.compile(
    r"<!--[^>]*auto-generated comment.*?-->.*?<!--[^>]*end of auto-generated comment[^>]*-->",
    re.S | re.I,
)
FENCED = re.compile(r"^[ \t]*(```|~~~).*?^[ \t]*\1[ \t]*$", re.S | re.M)
HTML_COMMENT = re.compile(r"<!--.*?-->", re.S)
INLINE_CODE = re.compile(r"`[^`\n]*`")
MD_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
CHECKLIST = re.compile(r"^\s*[-*+]\s*\[[ xX]\]")


def strip_uncontrolled(text):
    text = BOT_REGION.sub("", text)
    text = FENCED.sub("", text)
    text = HTML_COMMENT.sub("", text)
    # A placeholder, not a deletion. Removing the span outright leaves an
    # excerpt reading "survived only by luck: , , , and the primary key",
    # which helps nobody.
    text = INLINE_CODE.sub("code", text)
    return MD_LINK.sub(r"\1", text)


# The first character of a path component after the root. Whitespace, the
# punctuation that closes a quote, a code span, or a link, and the punctuation
# that ends a sentence are not one, so "plans stay in ~/.claude/plans/." names
# the folder and passes.
_NEXT = r"[^\s/`'\")\]>.,;:!?]"
URL = re.compile(r"\bhttps?://\S+", re.I)
DEFAULT_VAULT = "Documents/Claude/Memory"
# A plan file, at ~/.claude/plans or any spelling of the home before it.
PLAN_FAMILY = r"\.claude/plans/" + _NEXT
SCRATCH_FAMILIES = [
    # The persistent scratchpad, under any home spelling, or as a bare
    # `scratchpad/...` the reader would have to resolve. A repository folder
    # that happens to be named scratchpad, such as src/scratchpad/, passes.
    r"(?:Developer/|(?<![\w./-]))scratchpad/" + _NEXT,
    # A session scratchpad, under /tmp/claude-<uid> or /private/tmp/claude-<uid>.
    r"/tmp/claude-[^\s/]*/" + _NEXT,
]
# The commands an inline-code span may start with and still be exempt: those
# that create or write the place they name. A fixed list, never a PATH lookup,
# so the guard gives the same verdict on every machine and in CI. A command not
# on this list is not exempt. That includes every command that only reads, such
# as cat, less, head, tail, grep, rg, jq, wc, sort, diff, awk, and sed, because
# `tail <scratch>/tasks/x.output` points at a log the reader cannot see.
WRITE_COMMANDS = frozenset("mktemp mkdir touch tee cp mv ln cd ls".split())
# A shell is exempt only when it runs a script that is not itself scratch.
SHELLS = frozenset("bash sh zsh".split())
MARKDOWN = (".md", ".markdown")
# A vault note named in prose: "vault note decisions/x.md", "vault:
# feedback/x.md", "vault notes under insights/y". A connector is required
# between the word and the path, so "the vault hooks/x.sh" is not one. The
# path's first folder is captured, and the line counts only when that folder is
# a top-level folder of the vault, so HashiCorp's "Vault at secret/data" passes.
VAULT_PROSE = re.compile(
    r"\bvault(?:[ -]notes?(?:\s+(?:at|in|under))?\s*:?|\s+(?:at|under)|\s*:)"
    r"\s*[`'\"(]*([\w.-]+)/" + _NEXT,
    re.I,
)
# The top-level folders the vault conventions use, for a root that cannot be
# listed. Listing the real root is preferred, because a vault grows folders.
KNOWN_VAULT_FOLDERS = {
    "decisions", "dev-team", "feedback", "identity", "insights", "learnings",
    "sessions", "topics",
}


def vault_families(vault=None):
    """The default vault root and the configured one, each as a path below home."""
    roots = {DEFAULT_VAULT}
    if vault:
        vault = os.path.normpath(vault)
        home = os.path.expanduser("~")
        if vault.startswith(home + os.sep):
            vault = vault[len(home) + 1:]
        if vault.strip("/"):
            roots.add(vault.strip("/"))
    return [re.escape(r) + "/" + _NEXT for r in sorted(roots)]


def compile_families(families):
    return re.compile("|".join("(?:%s)" % f for f in families), re.I)


def pointer_pattern(vault=None):
    """Every pointer family: plans, both scratchpads, and the vault roots."""
    return compile_families([PLAN_FAMILY] + SCRATCH_FAMILIES + vault_families(vault))


def command_span(code, vault=None):
    """True when an inline-code span is a command the reader can act on.

    The command must create or write the place it names: a WRITE_COMMANDS
    word with at least one argument, a shell running a script that is not in a
    scratch location, or `git -C`. A plan or vault path keeps the span checked,
    because a reader can never act on Mike's plan or vault files. So does a
    scratchpad path whose last part ends in .md or .markdown, because a
    markdown file is content, not a place.
    """
    words = code.split()
    scratch = compile_families(SCRATCH_FAMILIES)
    if len(words) < 2:
        return False
    if words[0] in SHELLS:
        script = next((w for w in words[1:] if not w.startswith("-")), None)
        if script is None or scratch.search(script):
            return False
    elif words[0] == "git":
        if words[1] != "-C":
            return False
    elif words[0] not in WRITE_COMMANDS:
        return False
    if compile_families([PLAN_FAMILY] + vault_families(vault)).search(code):
        return False
    return not any(
        scratch.search(word) and word.strip("\"'),;:.").lower().endswith(MARKDOWN)
        for word in words
    )


def vault_folders(vault=None):
    """The vault root's top-level folders, lower-cased, or the known set."""
    root = vault or os.path.join(os.path.expanduser("~"), DEFAULT_VAULT)
    try:
        names = {
            entry.name.lower() for entry in os.scandir(root)
            if entry.is_dir() and not entry.name.startswith(".")
        }
    except OSError:
        return KNOWN_VAULT_FOLDERS
    return names or KNOWN_VAULT_FOLDERS


def pointer_lines(text, vault=None):
    text = BOT_REGION.sub("", text)
    text = FENCED.sub("", text)
    text = HTML_COMMENT.sub("", text)
    text = INLINE_CODE.sub(
        lambda span: "code" if command_span(span.group(0)[1:-1], vault) else span.group(0),
        text,
    )
    return URL.sub("url", text).split("\n")


def find_file_pointers(lines, vault=None):
    pattern = pointer_pattern(vault)
    folders = vault_folders(vault)

    def points(line):
        if pattern.search(line):
            return True
        return any(m.group(1).lower() in folders for m in VAULT_PROSE.finditer(line))

    hits = [ln for ln in lines if points(ln)]
    if not hits:
        return []
    return [
        "file-pointer: %d line(s) point at a plan, scratchpad, or vault file the "
        "reader cannot open (rule 11). Restate the substance in the body itself. "
        "A path may stay only as a location the reader acts on, such as a file "
        "the change edits.\n    first: %s" % (len(hits), excerpt(hits[0]))
    ]


def lexical_lines(text):
    return [ln for ln in text.split("\n") if not CHECKLIST.search(ln)]


def excerpt(text, width=90):
    flat = " ".join(text.split())
    return flat if len(flat) <= width else flat[: width - 1] + "…"


def find_char_violations(lines):
    findings = []
    for kind, char, rule, fix in (
        ("em-dash", "—", "rule 8", "Use a colon, a parenthesis, or a full stop."),
        ("semicolon", ";", "rule 8", "A semicolon means you have two sentences. Split it."),
    ):
        hits = [ln for ln in lines if char in ln]
        if hits:
            findings.append(
                "%s: %d line(s) contain %s (%s). %s\n    first: %s"
                % (kind, len(hits), char, rule, fix, excerpt(hits[0]))
            )
    return findings


def check(text, vault=None):
    return find_char_violations(lexical_lines(strip_uncontrolled(text))) + find_file_pointers(
        pointer_lines(text, vault), vault
    )


def main():
    findings = check(sys.stdin.read(), sys.argv[1] if len(sys.argv) > 1 else None)
    if not findings:
        return 0
    for finding in findings:
        print(finding)
    return 1


if __name__ == "__main__":
    sys.exit(main())
