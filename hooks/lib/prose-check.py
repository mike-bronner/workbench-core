#!/usr/bin/env python3
"""prose-check: check outbound prose against the lexical rules of the Clear standard.

Reads markdown on stdin. Prints one finding per line to stdout and exits 1 when
the prose violates a rule; exits 0 and prints nothing when it is clean.

Only the mechanically checkable rules live here. Structure, answer-first ordering,
and whether a document is a debugging journal are judgement calls that no regex
settles, so they stay in the output style where a reader applies them.

The five rules, each traceable to a line in assets/personas/clear/output-style.md:
  em-dash      no em dash in prose            (hard rule 7)
  semicolon    no semicolon in prose          (hard rule 7)
  no-emoji     emoji structure every response (hard rule 6)
  long-para    paragraph under 6 sentences    ("One idea per bullet")
  long-sent    sentence at 20 words maximum   (hard rule 8)

What is deliberately NOT counted, because the author does not control it:
  - fenced and inline code, where a semicolon is the language's, not the writer's
  - HTML comments, and bot-authored regions such as CodeRabbit's release notes
  - `- [ ]` checklist lines, which come from a repository pull request template
  - URLs inside markdown links, which are addresses rather than prose
"""

import re
import sys
import unicodedata

BOT_REGION = re.compile(
    r"<!--[^>]*auto-generated comment.*?-->.*?<!--[^>]*end of auto-generated comment[^>]*-->",
    re.S | re.I,
)
FENCED = re.compile(r"^[ \t]*(```|~~~).*?^[ \t]*\1[ \t]*$", re.S | re.M)
HTML_COMMENT = re.compile(r"<!--.*?-->", re.S)
INLINE_CODE = re.compile(r"`[^`\n]*`")
MD_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
CHECKLIST = re.compile(r"^\s*[-*+]\s*\[[ xX]\]")
TABLE_ROW = re.compile(r"^\s*\|")
HEADING = re.compile(r"^\s*#{1,6}\s")
BLOCKQUOTE = re.compile(r"^\s*>")
LIST_ITEM = re.compile(r"^\s*([-*+]|\d+[.)])\s")
SENTENCE_SPLIT = re.compile(r"(?<=[.!?])[\s]+")


def strip_uncontrolled(text):
    text = BOT_REGION.sub("", text)
    text = FENCED.sub("", text)
    text = HTML_COMMENT.sub("", text)
    # A placeholder, not a deletion. Removing the span outright would silently
    # shorten the sentence it sits in, so a 21-word sentence carrying two code
    # references would score 19 and pass. It also leaves an excerpt reading
    # "survived only by luck: , , , and the primary key", which helps nobody.
    text = INLINE_CODE.sub("code", text)
    return MD_LINK.sub(r"\1", text)


def lexical_lines(text):
    return [ln for ln in text.split("\n") if not CHECKLIST.search(ln)]


def is_prose_line(line):
    return not (
        TABLE_ROW.search(line) or HEADING.search(line) or BLOCKQUOTE.search(line)
    )


def count_emoji(text):
    return sum(
        1 for c in text if ord(c) > 0x2190 and unicodedata.category(c) == "So"
    )


def sentences(block):
    return [s for s in SENTENCE_SPLIT.split(block.strip()) if s.strip()]


def word_count(text):
    return len(text.split())


def excerpt(text, width=90):
    flat = " ".join(text.split())
    return flat if len(flat) <= width else flat[: width - 1] + "…"


def find_char_violations(lines):
    findings = []
    for kind, char, rule, fix in (
        ("em-dash", "—", "hard rule 7", "Use a colon, a parenthesis, or a full stop."),
        ("semicolon", ";", "hard rule 7", "A semicolon means you have two sentences. Split it."),
    ):
        hits = [ln for ln in lines if char in ln]
        if hits:
            findings.append(
                "%s: %d line(s) contain %s (%s). %s\n    first: %s"
                % (kind, len(hits), char, rule, fix, excerpt(hits[0]))
            )
    return findings


def find_emoji_violation(lexical_text, prose_text):
    # The floor counts paragraph prose only, while the emoji may sit anywhere
    # including a heading. A repository pull request template supplies ~58 words
    # of headings and bold labels before the author types a character, so
    # counting those would flag a body whose authored part is two lines long.
    if word_count(prose_text) <= 40 or count_emoji(lexical_text):
        return []
    return [
        "no-emoji: %d words of prose with no emoji (hard rule 6). "
        "Emoji are structure: section cues, status markers, category labels."
        % word_count(prose_text)
    ]


def find_length_violations(prose_text):
    findings = []
    blocks = [b for b in re.split(r"\n\s*\n", prose_text) if b.strip()]
    for block in blocks:
        if LIST_ITEM.search(block.split("\n")[0]):
            continue
        count = len(sentences(block))
        if count > 6:
            findings.append(
                "long-para: a paragraph runs %d sentences (limit 6). Split it.\n    first: %s"
                % (count, excerpt(block))
            )
    for block in blocks:
        for sentence in sentences(block):
            words = word_count(sentence)
            if words > 20:
                findings.append(
                    "long-sent: %d words in one sentence (limit 20, hard rule 8). "
                    "Split it.\n    %s" % (words, excerpt(sentence))
                )
    return findings


def check(text):
    stripped = strip_uncontrolled(text)
    lines = lexical_lines(stripped)
    lexical_text = "\n".join(lines)
    prose_text = "\n".join(ln if is_prose_line(ln) else "" for ln in lines)

    findings = find_char_violations(lines)
    findings += find_emoji_violation(lexical_text, prose_text)
    findings += find_length_violations(prose_text)
    return findings


def main():
    findings = check(sys.stdin.read())
    if not findings:
        return 0
    for finding in findings:
        print(finding)
    return 1


if __name__ == "__main__":
    sys.exit(main())
