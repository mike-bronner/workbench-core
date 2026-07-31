# MCP tool output capping — the per-server standard

**Audience:** authors of MCP servers used by `workbench-*` plugins.

**Rule:** every tool returns a bounded response by default, and says so in its
docstring. The size of what a tool returns is part of its API.

Reference implementation:
[`markdown-vault-mcp`](https://github.com/mike-bronner/markdown-vault-mcp)
(`src/markdown_vault_mcp/_server_tools/reader.py`). Where this doc gives a
number, that server is where it came from.

---

## Two layers, and why you still need this one

| Layer | Covers | Can it shape the result? |
|---|---|---|
| `hooks/mcp-output-cap.sh` (workbench-core, `PostToolUse`) | **Every** MCP tool in the session, including vendored third-party servers | ❌ No — byte truncation only |
| **This standard** (per server) | Only servers whose authors opt in | ✅ Yes — the server knows what matters |

The hook is a **backstop**. It can cut a 200 KB JSON blob down, but it cannot
know that a search response should keep the ten best hits with snippets rather
than the first N bytes. Only your server knows that. Do not treat the hook's
existence as permission to return unbounded output.

Claude Code itself is a third layer, above both. Its real numbers, read out of
the 2.1.219 binary:

| | |
|---|---|
| `MAX_MCP_OUTPUT_TOKENS` | 25,000 tokens |
| Size estimate | `round(chars / 4)`, plus 1,600 tokens per image |
| Cheap fast-path | estimate ≤ 50% of limit → returned untouched |
| ⇒ persistence effectively begins around | ~100,000 chars |

Three layers, then — but the outer two are damage control, and both truncate
blindly. This one is design.

### If your cap is deliberate, say so

A server that sets a large ceiling **on purpose** and raises rather than
truncates is doing the right thing, and core's hook must not undo it.
markdown-vault-mcp allows `.md` reads up to 262,144 bytes for exactly this
reason. Tool names matching `WORKBENCH_MCP_OUTPUT_EXEMPT` are skipped by the
hook; its default exempts the memory vault's `read`.

If your server has a comparably deliberate ceiling, add its tool to that regex
rather than lowering your own limit to dodge the backstop. The discriminator has
to be the tool name — the harness's own "server declared its result size" signal
lives on the tool definition and is not visible in the `PostToolUse` payload.

---

## The standard

### 1. Search-style tools — capped result count + snippet windowing

Anything ranked: search, similarity, recommendations.

- **`limit`** parameter, default **10**. Never unbounded.
- **`chunks_per_file` (or equivalent)**, default **2** — cap how much of any one
  result can dominate.
- **Return snippets, not full content.** Say so in the docstring, and name the
  call that recovers the full text.
- **Order deterministically.** Ties broken by a stable key (path, id) so the same
  query returns the same bytes — unstable ordering defeats prompt caching for
  everything downstream.

```python
async def search(
    query: str,
    limit: int = 10,                      # capped by default
    chunks_per_file: int | None = None,   # default 2
    snippet_words: int | None = None,     # windowed, 0 = full chunk
) -> list[dict]:
    """...
    The 'content' field in each result is a snippet by default, not the
    full document. Use read(path, section=heading) to retrieve the full
    text of a specific section.
    """
```

### 2. Read-style tools — a hard size cap with a clear error

Anything returning one thing in full: read a document, fetch an attachment.

- **Cap the bytes**, configurable by env var. Reference values:
  `MARKDOWN_VAULT_MCP_MAX_NOTE_READ_BYTES` = **262144** (256 KB) for text;
  `MARKDOWN_VAULT_MCP_MAX_ATTACHMENT_SIZE_MB` = **1.0** for binaries.
- **Raise, don't silently truncate.** A truncated document that looks complete is
  worse than an error — the model will reason from it and be wrong. Fail closed.
- **The error must be actionable**: actual size, the limit, the env var to raise,
  and the narrower call that would have worked.

```python
raise ValueError(
    f"Attachment {path!r} is {size} bytes ({size / 1024 / 1024:.1f} MB), "
    f"exceeds MARKDOWN_VAULT_MCP_MAX_ATTACHMENT_SIZE_MB ({cap_mb} MB). "
    f"Increase MARKDOWN_VAULT_MCP_MAX_ATTACHMENT_SIZE_MB if you need the "
    f"bytes in context."
)
```

- **Offer a partial-read path** so the cap is never a dead end — a `section=`
  parameter, an offset/limit pair, a range.

### 3. Listing tools — a max-count cap plus a `truncated` flag

Anything enumerating: list documents, list tags, table of contents, recents.

- **Max-count cap.** Reference: `get_toc(max_notes=200)`, `get_recent(limit=20)`.
- **Return `truncated: bool`** alongside the results. Without it the model cannot
  distinguish "that's everything" from "that's the first 200" — and will
  confidently assert the former.
- **Order deterministically** (by path, by date) so the truncation is stable and
  meaningful rather than arbitrary.

```python
# folder mode returns {path, notes, truncated}
# "When more notes match, the first max_notes (by path) are returned
#  and 'truncated' is True."
```

### 4. Document the cost in the docstring

The docstring is the only part of your tool the model reads before calling it.
State the limit there, in the terms the caller controls:

```
**Context cost:** every byte returned counts against the LLM's context
budget. Reads above ``MARKDOWN_VAULT_MCP_MAX_NOTE_READ_BYTES`` (default
256 KB for ``.md``) raise ``ValueError``. For partial markdown reads, pass
``section=heading``.
```

### 5. Make every limit configurable, with a safe default

Prefix env vars with your server's name, parse them defensively, and validate at
startup rather than at call time (`env_int(prefix, "MAX_NOTE_READ_BYTES",
262144)`). A malformed value should be a startup error, not a surprise mid-session.

---

## Defaults at a glance

| Tool shape | Parameter | Default | On exceed |
|---|---|---|---|
| Search / similarity | `limit` | 10 | Return the top N |
| Search / similarity | `chunks_per_file` | 2 | Return the best N per file |
| Read (text) | `MAX_NOTE_READ_BYTES` | 262144 | **Raise** with an actionable message |
| Read (binary) | `MAX_ATTACHMENT_SIZE_MB` | 1.0 | **Raise** with an actionable message |
| Listing / TOC | `max_notes` | 200 | Return N + `truncated: true` |
| Recents | `limit` | 20 | Return N |

Treat these as starting points, not gospel — but change them deliberately, and
document why.

---

## Anti-patterns

- **Unbounded by default, bounded on request.** The model will not pass `limit`
  unless something makes it. The default is the only limit that reliably applies.
- **Silent truncation on a read.** Produces confident wrong answers. Raise.
- **Truncation with no `truncated` flag.** Same failure, quieter.
- **Non-deterministic ordering.** Breaks caching for everything downstream, and
  makes truncation arbitrary.
- **"The core hook will catch it."** It caps bytes; it cannot preserve meaning.

---

## Checklist

- [ ] Every search-style tool has a default `limit` and returns snippets.
- [ ] Every read-style tool has a byte cap and **raises** with size, limit, env
      var, and the narrower call to use instead.
- [ ] Every listing tool has a max count and returns `truncated`.
- [ ] Every limit is env-configurable, validated at startup.
- [ ] Every ordering is deterministic, with a stable tiebreak.
- [ ] Every docstring states the cost and the limits.
