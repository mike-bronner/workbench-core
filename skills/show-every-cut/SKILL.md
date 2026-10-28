---
name: show-every-cut
description: Use before you shorten, summarize, condense, trim, paraphrase or rewrite text a person gave you (a message, notes, a document, a post, a quote), before you fit their text to a character or word limit, and when some of their passages must stay word for word.
---

# Show every cut

A shorter version that reads well can still drop the one sentence the person
needed. This rule has a check that a script runs, not your judgement, and a
clear "done". When the check cannot run, ask the user. Do not guess. A
sub-agent cannot ask, so it stops and puts the question in its report to the
orchestrator.

The script needs Node.js 18 or newer and nothing else. The command below names
it by its full path, so it runs as written in any Bash call.

- **Save working files in the session scratchpad**, never in the repository,
  because a commit takes every file in the tree. Below, `<scratchpad>` stands
  for the scratchpad's full path.
- **The script reads only** the working folder and this session's scratchpad,
  and it writes nothing.
- **`cut-diff.mjs` uses no network.**

## 1. Show every cut when you change a person's text

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
   node "${CLAUDE_PLUGIN_ROOT}/skills/show-every-cut/scripts/cut-diff.mjs" <scratchpad>/cut/original.txt <scratchpad>/cut/new.txt --keep-file <scratchpad>/cut/keep.txt --max-chars <n>
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
