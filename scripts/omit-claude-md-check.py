#!/usr/bin/env python3
"""Fail when OMITS_CLAUDE_MD drifts from the agents that really omit CLAUDE.md.

hooks/mods/prompt-rules.ts names, in OMITS_CLAUDE_MD, every agent type defined
with `omitClaudeMd: true`, because no hooks-module API says which types set it.
A hand-kept list drifts: a past review found Explore and Plan missing. This
check rebuilds the list from its two sources and compares:

  - the CLI's built-in agents, read from the pinned CLI binary. Each built-in
    is a minified object literal, `{agentType:"Explore",...,source:"built-in",
    ...,omitClaudeMd:!0,getSystemPrompt:...}`.
  - this plugin's own agents/*.md with `omitClaudeMd: true` in the
    frontmatter, each under its bare name and its `<plugin>:` name.

It fails closed. A definition it cannot read (an agentType name that resolves
to no string, or to two), or a binary in which it finds no `general-purpose`
built-in, is an error: the CLI's layout changed and this reader must follow.

Usage: omit-claude-md-check.py <claude binary> [plugin root]
Exit 0 when the lists match, 1 on drift, 2 when a source cannot be read.
"""

import bisect
import json
import re
import sys
from pathlib import Path

# A built-in agent definition: from its agentType to the end of the object,
# which is its getSystemPrompt or the next definition, whichever comes first.
DEFINITION = re.compile(rb'agentType:("[^"\\]*"|[A-Za-z_$][\w$]*)')
END = re.compile(rb'getSystemPrompt|agentType:')
BUILT_IN = b'source:"built-in"'
OMITS = re.compile(rb'omitClaudeMd:(?:!0|true)\b')
ANCHOR = 'general-purpose'
CHUNK = b'// @bun'


class Unreadable(Exception):
    pass


IMPORT = re.compile(rb'import\{([^}]*)\}from"')
EXPORT = re.compile(rb'export\{([^}]*)\}')


def built_in_omitters(binary: bytes) -> set[str]:
    starts = [0] + [m.start() for m in re.finditer(re.escape(CHUNK), binary)] + [len(binary)]
    chunks = [binary[starts[i - 1]:starts[i]] for i in range(1, len(starts))]
    found: set[str] = set()
    seen_anchor = False
    for m in DEFINITION.finditer(binary):
        end = END.search(binary, m.end())
        body = binary[m.end():end.start() if end else len(binary)]
        if BUILT_IN not in body:
            continue
        seen_anchor = seen_anchor or m.group(1) == f'"{ANCHOR}"'.encode()
        if OMITS.search(body):
            found.add(resolve(chunks, bisect.bisect_right(starts, m.start()) - 1, m.group(1)))
    if not seen_anchor:
        raise Unreadable(f'no {ANCHOR!r} built-in agent found: the CLI binary layout is not one this check can read')
    return found


def bindings(clause: bytes) -> list[tuple[bytes, bytes]]:
    pairs = [part.strip().split(b' as ') for part in clause.split(b',') if part.strip()]
    return [(p[0].strip(), p[-1].strip()) for p in pairs]


def declared(chunk: bytes, name: bytes) -> set[str]:
    return {v.decode(errors='replace') for v in re.findall(rb'(?<![\w$.])' + re.escape(name) + rb'="([^"\\]*)"', chunk)}


def resolve(chunks: list[bytes], at: int, token: bytes) -> str:
    if token.startswith(b'"'):
        return token[1:-1].decode()
    values = declared(chunks[at], token)
    for clause in IMPORT.finditer(chunks[at]):
        for exported, local in bindings(clause.group(1)):
            if local != token:
                continue
            sources = [(chunk, inner) for chunk in chunks for e in EXPORT.finditer(chunk) for inner, outer in bindings(e.group(1)) if outer == exported]
            if len(sources) != 1:
                raise Unreadable(f'agentType {token.decode()} is imported as {exported.decode()}, which {len(sources)} chunks export')
            values |= declared(*sources[0])
    if len(values) != 1:
        raise Unreadable(f'agentType {token.decode()} resolves to {sorted(values) or "no string"}')
    return values.pop()


def plugin_omitters(root: Path) -> set[str]:
    plugin = json.loads((root / '.claude-plugin' / 'plugin.json').read_text())['name']
    found: set[str] = set()
    for f in sorted((root / 'agents').glob('*.md')):
        head = re.match(r'---\n(.*?)\n---\n', f.read_text(), re.S)
        if head is None:
            continue
        fields = dict(re.findall(r'^([\w-]+):[ \t]*(.*?)[ \t]*$', head.group(1), re.M))
        if fields.get('omitClaudeMd', '').strip('\'"').lower() == 'true':
            name = fields.get('name') or f.stem
            found |= {name, f'{plugin}:{name}'}
    return found


def listed(root: Path) -> set[str]:
    text = (root / 'hooks' / 'mods' / 'prompt-rules.ts').read_text()
    block = re.search(r'export const OMITS_CLAUDE_MD\b[^=]*=\s*new Set\(\[(.*?)\]\)', text, re.S)
    if block is None:
        raise Unreadable('OMITS_CLAUDE_MD not found in hooks/mods/prompt-rules.ts')
    return set(re.findall(r"'([^']*)'", block.group(1)))


def main(argv: list[str]) -> int:
    if len(argv) not in (2, 3):
        print(__doc__.strip().splitlines()[-2], file=sys.stderr)
        return 2
    root = Path(argv[2]) if len(argv) == 3 else Path(__file__).resolve().parent.parent
    try:
        expected = built_in_omitters(Path(argv[1]).read_bytes()) | plugin_omitters(root)
        actual = listed(root)
    except (OSError, Unreadable) as err:
        print(f'omit-claude-md-check: cannot read a source: {err}', file=sys.stderr)
        return 2
    missing, extra = sorted(expected - actual), sorted(actual - expected)
    if not missing and not extra:
        print(f'OMITS_CLAUDE_MD matches the agents that omit CLAUDE.md: {", ".join(sorted(actual))}')
        return 0
    if missing:
        print(f'OMITS_CLAUDE_MD is missing agents defined with omitClaudeMd: {", ".join(missing)}', file=sys.stderr)
    if extra:
        print(f'OMITS_CLAUDE_MD names agents not defined with omitClaudeMd: {", ".join(extra)}', file=sys.stderr)
    print('Update OMITS_CLAUDE_MD in hooks/mods/prompt-rules.ts and its pin in tests/prompt-rules.test.ts.', file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
