---
name: check-a-live-source
description: Use before you name or rely on a fact about the world that goes stale and that you know from training, not from a source read in this task, such as the newest or latest model, a model ID, a library or tool version, a price, a limit or quota, a launch or release date, or what a product's current docs say. This includes writing such a value into code, a config, a commit or a reply.
---

# Check a live source

Memory answers a question about the newest model or a price at once, and is
often out of date. This rule has a check that a script runs, not your
judgement, and a clear "done". When the check cannot run, ask the user. Do not
guess. A sub-agent cannot ask, so it stops and puts the question in its report
to the orchestrator.

The script is the one `read-the-contract` ships. It needs Node.js 18 or newer
and nothing else. The command below names it by its full path, so it runs as
written in any Bash call.

- **The script reads only** the working folder and this session's scratchpad,
  and it writes nothing.
- **It sends GET requests only**, with no body, no cookies and no keys. It
  refuses a local, private or link-local address, whether directly, after a
  redirect, or through a name that resolves there, unless the page you gave is
  on that host.

## 1. Check a live source before you state a fact that goes stale

**When:** you are about to name or rely on a fact that changes over time: the
newest or latest model, a model ID, a library or tool version, a price, a
limit or quota, a launch or release date, or what current docs say. That
includes writing one into code, a config, a commit or a reply.

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
   not found. For a page behind a sign-in, run it on a page the user saved
   into the session scratchpad, with `--base <its URL>`.

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/skills/read-the-contract/scripts/find-contract.mjs" <url> --quote "<sentence>"
   ```

4. Answer with the fact exactly as the source writes it, the URL, the date,
   and the quoted sentence. If the source and your memory differ, give both.
   An announced model is not a released one, and the newest is not always the
   best known.

**Done:** the answer cites a source the script confirmed in this session, or
says plainly that the fact is `unchecked`.

**Ask the user** for the source when you cannot open one. Until then, give the
memory answer marked `unchecked`.
