---
name: read-first
description: Use before you send a body or a call to an outside API, form, CLI or MCP tool whose contract you have not read, before you shorten, summarize or rewrite text a person gave you, and before you name or rely on a fact that goes stale, such as the newest model, a version, a price or current docs.
---

# Read first

Three rules for moments when a quick answer looks right and is wrong. Each rule
has a check that a script runs, not your judgement, and a clear "done". When
the check cannot run, ask the user. Do not guess. A sub-agent cannot ask, so it
stops and puts the question in its report to the orchestrator.

The scripts need Node.js 18 or newer and nothing else. Each command below
names its script by its full path, so it runs as written in any Bash call.

- **Save working files in the session scratchpad**, never in the repository,
  because a commit takes every file in the tree. That covers the texts for
  rule 2 and a saved page. Below, `<scratchpad>` stands for the scratchpad's
  full path.
- **The scripts read only** the working folder and this session's
  scratchpad, and they write nothing.
- **`find-contract.mjs` sends GET requests only**, with no body, no cookies
  and no keys. It refuses a local, private or link-local address, whether
  directly, after a redirect, or through a name that resolves there, unless
  the page you gave is on that host.
- **`cut-diff.mjs` uses no network.**

## 1. Read the contract before you write to an outside system

**When:** you are about to write to a system you do not own, and you have not
read the shape it accepts. That covers an API body (POST, PUT, PATCH, a
webhook), a form submit, the flags of a CLI, a config or schema file in a
format another tool reads, and an MCP tool call.

**Check:** find what the system declares, with the script.

- **A web API or a form.** Run the script on the endpoint, or on the page that
  pointed you to it. It lists `<link>` and HTTP `Link` entries with
  `rel="service-desc"`, `rel="describedby"` or `rel="service-doc"`, every JSON
  or YAML `rel="alternate"`, and each `<form>` with its fields and limits. Add
  `--open` to print each contract it lists.

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/skills/read-first/scripts/find-contract.mjs" <url> --open
  ```

- **A page behind a sign-in.** The script reports `sign-in:`. Ask the user to save
  the signed-in page into the session scratchpad, then run:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/skills/read-first/scripts/find-contract.mjs" <scratchpad>/page.html --base <its URL>
  ```

- **A JSON Schema or an MCP tool.** Run the script on the JSON: a JSON Schema,
  a `tools/list` response, or one tool definition with `inputSchema`,
  `input_schema` or `parameters`. Give a URL, a file, or `-` for stdin. It
  lists every field with its type, whether it is required, its limits, and
  whether extra keys are allowed. An MCP tool in your own tool list shows its
  schema there. Load a deferred tool with `ToolSearch` before the call, and
  quote its schema.
- **An OpenAPI document.** For a JSON document, the script lists the request
  body schema of each POST, PUT, PATCH and DELETE operation, field by field.
  It does not list query, path or header parameters, and it does not parse
  YAML. Read those in the document yourself, and quote them.
- **A config file.** Find the schema the format declares, such as the
  `$schema` URL in the file or the tool's own docs, and run the script on it.
- **A CLI.** Pipe its help into the script. It prints the usage lines and
  every flag the help declares.

  ```bash
  gh pr create --help | node "${CLAUDE_PLUGIN_ROOT}/skills/read-first/scripts/find-contract.mjs" - --cli
  ```

Then quote the contract in your message before the write: where it came from,
the required fields or flags, their types and limits, and whether extra keys
are allowed. Build the write from that quote, not from what a write like it
usually holds.

**Done:** your message quotes the contract with its source, and every field or
flag you send appears in the quote.

**Ask the user** where the contract is when the script finds nothing declared, or
when it cannot reach the page. Never send a guess to learn from the error.

## 2. Show every cut when you change a person's text

**When:** a person gave you content (a message, notes, a document) and you are
about to shorten, summarize or rewrite it.

**Check:** count, keep and list the cuts, with the script.

1. Write the keep list first: each passage the person wants kept exactly,
   copied from the original, never retyped. Save the original, the new version
   and the keep list in `<scratchpad>/cut/`. In the keep list, a line with
   only `---` goes between passages.
2. Run the script, with `--max-chars <n>` or `--max-words <n>` for the
   person's limit:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/skills/read-first/scripts/cut-diff.mjs" <scratchpad>/cut/original.txt <scratchpad>/cut/new.txt --keep-file <scratchpad>/cut/keep.txt --max-chars <n>
   ```

3. Fix every `FAIL`. For a keep passage, the script shows the first character
   that differs and its code point, so a curly quote, a different dash or a
   line break is visible. Change only those characters and run it again.
4. Show the person the counts, the keep check and the cut list before you send
   or save the new version, unless they said to go ahead without it. A
   sentence counts as kept only when the new version has it whole, as a
   sentence of its own. If they want a cut back, put it back and run the
   script again.

**Done:** the script prints `result: ok`, and the person has seen every cut.

**Ask the user** which passages must stay word for word when that is not clear,
and which limit applies when the user named none.

## 3. Check a live source before you state a fact that goes stale

**When:** you are about to name or rely on a fact that changes over time: the
newest or latest model, a model ID, a version, a price, or what current docs
say. That includes writing one into code or a config.

**Check:** memory first, then a primary source, with the script.

1. Write your memory answer first, with how sure you are:
   `From memory: <answer>. How sure: low, medium or high.` Leave that line as
   it is, because it shows how far memory was off.
2. Open a primary source: the maker's own model list, release notes,
   changelog, price page or docs. Prefer it to news or a list someone else
   keeps.
3. Copy one sentence from the page that states the fact, and run the script.
   It confirms the sentence is on the live page word for word, and lists the
   dates the page carries. A page that answers with an error status counts as
   not found. For a page behind a sign-in, run it on the saved page.

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/skills/read-first/scripts/find-contract.mjs" <url> --quote "<sentence>"
   ```

4. Answer with the fact exactly as the source writes it, the URL, the date,
   and the quoted sentence. If the source and your memory differ, give both.
   An announced model is not a released one, and the newest is not always the
   best known.

**Done:** the answer cites a source the script confirmed in this session, or
says plainly that the fact is `unchecked`.

**Ask the user** for the source when you cannot open one. Until then, give the
memory answer marked `unchecked`.
