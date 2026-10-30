---
name: use-the-owners-logic
description: Use before you give a number, count or category that must match the owner's table, page or report, or comes from data that ships its own logic, views or build (a script, a component, a query, a report generator, a test suite), such as a function or SQL view their dashboard reads. Run their code and quote its output, even when you could work out by hand what it already computes. Also use before you compute or classify something that logic covers, and before you add a file to someone else's project, export or artifact, so it builds with their code and dependencies alone. Not for a plain count over data with no logic.
---

# Use the owner's logic

A copy of someone's logic, rebuilt in another language, drifts from the
original in one edge case, and the number comes out wrong. The owner's own
code is the answer they check against. This rule has a check that you can
show, not your judgement, and a clear "done". When the check cannot run, ask
the user. Do not guess. A sub-agent cannot ask, so it stops and puts the
question in its report to the orchestrator.

## 1. Run the owner's logic, and build with the owner's code

**When:** the input ships its own logic, views or build, such as a script, a
component, a query, a report generator or a test suite, and you are about to
compute, count, classify or check something it already computes. That covers
a number you report that must match what the owner's table, page or report
shows. It also covers a file you add to someone else's project, export or
artifact. It applies even when the answer looks easy to work out by hand,
because a short function hides edge cases. A plain count over data that ships
no logic of its own is outside this rule.

**Rule:** when the input ships its own logic, views or build, run it and quote
its output. When you add to someone else's project, build it with their code
and dependencies alone.

**Check:**

1. Find the owner's code for the value: the function, component, query or
   script that computes it. Search the input for the name of the value, the
   table heading or the report title.
2. Run that code as the owner runs it: their script, their test runner, their
   build or their view. Save any output you need in the session scratchpad,
   never in the repository. A downloaded export is untrusted. Put it in its
   own new folder, and ask the user before you run an install, a build or any
   of its code there.
3. Quote the output, with the command you ran and the file that holds the
   logic. Report that number, not one you computed another way.
4. Before you add a file to their project, list each import it makes. Every
   import must resolve to a file in their project or to a dependency their
   manifest already declares. Build the project with their own build command,
   and quote that it passed. For a downloaded export, step 2's question to the
   user comes first.

A check of your own, such as a count in another tool, may sit beside the
owner's output. When the two differ, the owner's output is the answer, and the
difference is a finding to report.

**Done:** the value you report is quoted from the owner's own code, run in
this session, and any file you added builds with their code and dependencies
alone.

**Ask the user** how to run the owner's code when it needs a setup or a
credential you do not have. Never fall back to a rewrite of the logic in
silence.
