#!/usr/bin/env python3
"""prose-check: check outbound prose against the lexical rules of the Clear standard.

Reads markdown on stdin. Prints one finding per line to stdout and exits 1 when
the prose violates a rule; exits 0 and prints nothing when it is clean.

Only the mechanically checkable rules live here. Structure, answer-first ordering,
and whether a document is a debugging journal are judgement calls that no regex
settles, so they stay in the output style where a reader applies them.

The two rules, each traceable to rule 8 of assets/personas/clear/output-style.md:
  em-dash      no em dash in prose
  semicolon    no semicolon in prose

Emoji, sentence length, and paragraph length were checked here once, and are
not now. A deny on a judgement call breeds workarounds: the writer pads a body
with an emoji or chops a sentence to pass the count, and the text gets no
easier to read. Density is a rule in the output style, applied by the writer.

What is deliberately NOT counted, because the author does not control it:
  - fenced and inline code, where a semicolon is the language's, not the writer's
  - HTML comments, and bot-authored regions such as CodeRabbit's release notes
  - `- [ ]` checklist lines, which come from a repository pull request template
  - URLs inside markdown links, which are addresses rather than prose
"""

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


def check(text):
    return find_char_violations(lexical_lines(strip_uncontrolled(text)))


def main():
    findings = check(sys.stdin.read())
    if not findings:
        return 0
    for finding in findings:
        print(finding)
    return 1


if __name__ == "__main__":
    sys.exit(main())
