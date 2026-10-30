---
name: recheck-before-done
description: Use before you submit, claim, publish, release or close work, mark a pull request ready, or otherwise report work as done or send it out, when that work was built from a page, list, file, ticket or message read earlier in the session, minutes or hours ago. Above all, use it when its owner updates the source during the day, or the task says it keeps changing, is live or gets updated. Reread that source first, even when the schema is quoted and every value sourced.
---

# Recheck before done

A source read an hour ago can have changed since. Work built on the old copy
looks done and is sent back. This rule has a check that you can show, not your
judgement, and a clear "done". When the check cannot run, ask the user. Do not
guess. A sub-agent cannot ask, so it stops and puts the question in its report
to the orchestrator.

The outward-call check of the hooks module pairs with this rule. Before an
outward submit, such as an MCP tool whose name starts or ends with claim,
submit or publish, `gh pr ready`, `gh release create` or `gh issue close`, it
lists the files and URLs the session read, newest first, with the age of each
read. Use that list as the start of step 1.

## 1. Re-read every source before you call the work done

**When:** you are about to report work as done, or to send it out: a claim, a
submit, a publish, a release, a pull request marked ready, or a ticket closed.
The work rests on pages, files, downloads, tickets or messages you read
earlier in the session, or on a source the task says keeps changing, is live,
or gets updated. It applies even when the schema is quoted and every value has
a source, because a correct call can still carry work that no longer matches.

**Check:**

1. List each source the work depends on, with when you read it. Start from the
   freshness list when the hooks module added one.
2. Read each source again now: fetch the page, open the file, list the
   tickets, read the newest messages.
3. Compare the new read with the old one. Name each change: a new item, a
   changed value, a closed or reopened ticket, a new message.
4. When a change touches the work, update the work first and run its checks
   again. Then go back to step 2, because the source may have moved again.

**Done:** your message lists each source with the time of its last read in
this session, and states that nothing changed, or names each change and how
the work now covers it.

**Ask the user** whether to send the work as it is when a source cannot be
read again, or keeps changing while you work. Say which source and what you
last saw in it.
