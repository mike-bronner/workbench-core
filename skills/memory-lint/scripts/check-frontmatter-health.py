"""Report frontmatter whose content never reaches the search index.

The disk-vs-index diff (SKILL.md Step 1c) finds documents the indexer *rejected*.
It cannot find documents the indexer *accepted* while discarding part of them, and
those are the more expensive half — the file looks healthy and simply never matches
the search it should. Two shapes cause it:

1. **Truncation.** In a plain (unquoted) YAML scalar, ` #` begins a comment, so a
   value mentioning an issue or PR number ends there. `summary: … PR #284. I
   enabled…` indexes as `… PR`.

2. **Wrong key.** Only the fields in ``INDEXED`` are searchable. An abstract
   written under ``description:`` — the shape Claude Code's auto-memory schema
   emits — is weighted at zero no matter how good it is.

Exit 1 when either shape is losing content from an indexed field; 0 otherwise.
Findings that cost nothing extra (a truncated value in a key that was already
unsearchable) are reported but do not fail.
"""

import os, re, sys, fnmatch

try:
    import yaml
except ImportError:
    print("SKIP: PyYAML unavailable — cannot run the frontmatter scan", file=sys.stderr)
    raise SystemExit(0)

VAULT = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/Documents/Claude/Memory")
INDEXED = {"name", "type", "tags", "summary", "date", "scope", "log_files"}
# Keys that carry an abstract but are not indexed. `description` is what Claude
# Code's auto-memory schema writes; the vault convention is `summary`.
ABSTRACT_ALIASES = ("description",)
KEY = re.compile(r"^([A-Za-z_][\w-]*):[ ]+(?![>|'\"])(\S.*?)\s*$")
norm = lambda s: " ".join(str(s).split())

truncated, misfiled, harmless = [], [], []

for root, dirs, files in os.walk(VAULT):
    dirs[:] = [d for d in dirs if not d.startswith(".") and d != "cache"]
    for fn in files:
        if not fn.endswith(".md"):
            continue
        rel = os.path.relpath(os.path.join(root, fn), VAULT)
        if fnmatch.fnmatch(rel, "sessions/**/*.log.md"):
            continue
        text = open(os.path.join(root, fn), encoding="utf-8", errors="replace").read()
        m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
        if not m:
            continue
        raw = m.group(1)
        try:
            doc = yaml.safe_load(raw)
        except Exception:
            continue          # unparseable → already caught by the skipped-file diff
        if not isinstance(doc, dict):
            continue

        # -- shape 2: an abstract under a key nothing searches ------------------
        for alias in ABSTRACT_ALIASES:
            if doc.get(alias) and not doc.get("summary"):
                misfiled.append((rel, alias, len(str(doc[alias]))))

        # -- shape 1: a value the parser cut short ------------------------------
        lines = raw.split("\n")
        for i, line in enumerate(lines):
            km = KEY.match(line)
            if not km:
                continue
            key, first = km.group(1), km.group(2)
            parsed = doc.get(key)
            if not isinstance(parsed, str):
                continue      # lists / dates / numbers legitimately differ from source
            parts = [first]
            for nxt in lines[i + 1:]:
                if not nxt.strip() or not nxt[:1].isspace() or KEY.match(nxt.strip()):
                    break
                parts.append(nxt.strip())
            written, got = norm(" ".join(parts)), norm(parsed)
            # A plain scalar is literal, so the only way the parsed string differs
            # from its source is that YAML dropped part of it. No length test is
            # needed on top: verified against the live vault, `got != written`
            # alone reports exactly the same set.
            if got != written:
                (truncated if key in INDEXED else harmless).append(
                    (rel, key, len(written) - len(got), written, got))

truncated.sort(key=lambda f: -f[2])
misfiled.sort(key=lambda f: -f[2])

print(f"truncated indexed values:            {len(truncated)}")
print(f"abstracts under an unindexed key:    {len(misfiled)}")
print(f"truncated unindexed values (benign): {len(harmless)}")

for rel, key, lost, written, got in truncated:
    print(f"\n  TRUNCATED  {rel}")
    print(f"    {key}: lost {lost} chars")
    print(f"      written: {written[:100]}")
    print(f"      indexed: {got[:100]}")

if misfiled:
    total = sum(n for _, _, n in misfiled)
    print(f"\n  MISFILED — {total:,} chars of abstract invisible to search:")
    for rel, alias, n in misfiled[:40]:
        print(f"    {alias}: {n:>5} chars  {rel}")
    if len(misfiled) > 40:
        print(f"    … and {len(misfiled) - 40} more")

for rel, key, lost, _, _ in harmless[:10]:
    print(f"\n  benign     {rel}  ({key}: -{lost} chars, key not indexed anyway)")

raise SystemExit(1 if (truncated or misfiled) else 0)
