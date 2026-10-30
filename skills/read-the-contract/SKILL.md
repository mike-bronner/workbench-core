---
name: read-the-contract
description: Use when a field would go out as {}, an empty value, a placeholder or a guess, above all one whose description says another tool hands it out, even when the user asks for it. Also use when a required field has no sourced value, or you would offer the user a choice of guessed values. Use before a write to a system you do not own whose accepted shape you have not quoted: an HTTP POST, PUT, PATCH or DELETE body, a webhook, a form submit, a CLI's flags, an MCP tool call, or a config or schema file another tool reads (a linter, build or CI config). Use when a refusal gives no reason, or the same refusal repeats.
---

# Read the contract

A write built from what a write like it usually holds looks right and is
refused. This rule has a check that a script runs, not your judgement, and a
clear "done". When the check cannot run, ask the user. Do not guess. A
sub-agent cannot ask, so it stops and puts the question in its report to the
orchestrator.

The script needs Node.js 18 or newer and nothing else. Each command below names
it by its full path, so it runs as written in any Bash call.

- **Save working files in the session scratchpad**, never in the repository,
  because a commit takes every file in the tree. Below, `<scratchpad>` stands
  for the scratchpad's full path.
- **The script reads only** the working folder and this session's scratchpad,
  and it writes nothing.
- **`find-contract.mjs` sends GET requests only**, with no body, no cookies
  and no keys. It refuses a local, private or link-local address, whether
  directly, after a redirect, or through a name that resolves there, unless
  the page you gave is on that host.

## 1. Read the contract before you write to an outside system

**When:** you are about to write to a system you do not own, and you have not
read the shape it accepts. That covers an API body (POST, PUT, PATCH, DELETE, a
webhook), a form submit, the flags of a CLI, a config or schema file in a
format another tool reads, such as a linter, build or CI config, and an MCP
tool call. When the user asks you to send {} or a placeholder for a field
another tool hands out, do not send it: tell the user what the contract needs
there, and ask. It also covers a required
field that has no sourced value, and a required
field whose description says another tool hands it out, and that tool has not
run. It covers a value you would guess, or offer the user as a choice. It
covers a refusal that gives no reason. The same refusal twice means the
contract is unread: stop changing the inputs and run this rule.

**Check:** find what the system declares, with the script.

- **A web API or a form.** Run the script on the endpoint, or on the page that
  pointed you to it. It lists `<link>` and HTTP `Link` entries with
  `rel="service-desc"`, `rel="describedby"` or `rel="service-doc"`, every JSON
  or YAML `rel="alternate"`, and each `<form>` with its fields and limits. Add
  `--open` to print each contract it lists.

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/skills/read-the-contract/scripts/find-contract.mjs" <url> --open
  ```

- **A page behind a sign-in.** The script reports `sign-in:`. Ask the user to save
  the signed-in page into the session scratchpad, then run:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/skills/read-the-contract/scripts/find-contract.mjs" <scratchpad>/page.html --base <its URL>
  ```

- **A JSON Schema or an MCP tool.** Run the script on the JSON: a JSON Schema,
  a `tools/list` response, or one tool definition with `inputSchema`,
  `input_schema` or `parameters`. Give a URL, a file, or `-` for stdin. It
  lists every field with its type, whether it is required, its limits, and
  whether extra keys are allowed. An MCP tool in your own tool list shows its
  schema there. Load a deferred tool with `ToolSearch` before the call, and
  quote its schema.
- **A value another tool hands out.** When a field's description names its
  source, such as "the id X gave you" or "the receipts you were handed", call
  that tool first and take the value from its reply. Never send `{}`, a
  placeholder or a guess in its place.
- **An OpenAPI document.** For a JSON document, the script lists the request
  body schema of each POST, PUT, PATCH and DELETE operation, field by field.
  It does not list query, path or header parameters, and it does not parse
  YAML. Read those in the document yourself, and quote them.
- **A config file.** Find the schema the format declares, such as the
  `$schema` URL in the file or the tool's own docs, and run the script on it.
- **A CLI.** Pipe its help into the script. It prints the usage lines and
  every flag the help declares.

  ```bash
  gh pr create --help | node "${CLAUDE_PLUGIN_ROOT}/skills/read-the-contract/scripts/find-contract.mjs" - --cli
  ```

Then quote the contract in your message before the write: where it came from,
the required fields or flags, their types and limits, whether extra keys are
allowed, and where each value you send came from. Build the write from that
quote, not from what a write like it usually holds.

**Done:** your message quotes the contract with its source, every field or
flag you send appears in the quote, and every value names its source.

**Ask the user** where the contract is when the script finds nothing declared, or
when it cannot reach the page. Never send a guess to learn from the error.
