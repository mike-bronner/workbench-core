---
name: intake
description: The task-intake routine for an interactive session. Run it before the first piece of work on any task that ends in a work product (a change, a file, a document, a plan to act on). It states the goal, gathers context, interviews the user through AskUserQuestion only about gaps the prompt, the repo, and the vault cannot fill, writes acceptance criteria, shows them in an intake block, then drafts three options from different angles, grades each against every criterion, and recommends one. Skip it for trivial asks and for pure questions that produce no work product. Sub-agents, the Index pipeline, and scheduled ticks never interview.
---

# Intake: goal, context, criteria, options

This routine runs before the work, not after the work goes wrong. It exists
because asking had become only a fallback for vague requests, and several rules
pushed against it. The fix is a step every task passes through, with a bar that
keeps the step cheap.

**The bar, in Mike's words:** "if the agent is able to provide the answer
without asking me, given that it has the required context and acceptance
criteria, it should do so. the agent should not be hamstrung and prevented from
doing work." So you ask only about real gaps, and you proceed on everything
else. What makes proceeding safe is the intake block (step 5): the goal and the
criteria you are working to are on screen before the work starts, so every
assumption is visible and Mike can correct it in one line.

## When to run it

**Run it** in an interactive main session, before the first piece of work on a
task that produces something: a code change, a file, a document, a message sent
on his behalf, or a plan he will act on. A new task later in the same
conversation gets its own intake. A reply that only approves or steers the
current intake ("yes", "go with B") is not a new task.

**Skip it** for two kinds of request, and say nothing about skipping:

- A trivial ask. It has one obvious result, no alternative worth grading, and
  it is cheap to redo: a typo fix, a rename you were given, a command to run.
- A pure question that produces no work product. Answer it.

You decide that threshold, not a hook. `hooks/intake-nudge.sh` reminds you once,
on the first inline `Edit` of a task with no intake block on screen. It never
blocks the edit. If the task was trivial, carry on.

**Other lanes never interview**, because no human is there to answer:

- **Sub-agent.** The brief is the intake. `Goal:`, `Context:`, and
  `Acceptance:` arrive filled in. Grade your forks against the `Acceptance:`
  list, and send a blocking gap back to the orchestrator rather than asking.
- **Index pipeline and scheduled ticks.** No interview and no nudge. The item's
  acceptance criteria, written at triage, are the criteria.

## The routine

### 1. Goal

State the outcome in one or two sentences, in terms of behaviour. Say what will
be true when the task is done, not the steps that get there.

### 2. Context

Gather it before you ask for any of it. Read the prompt closely. Read the repo:
its written conventions, the files next to the ones you will touch, and recent
history. Search the memory vault for the topic, and search `feedback/` for
corrections Mike has already made about this kind of work. Keep what shapes the
work, and note what you had to assume.

### 3. Interview: only the real gaps

A question passes the **gap test** only when all three hold:

1. The prompt, the repo, and the vault cannot answer it.
2. The answer changes what you would build, or how you would judge it.
3. A wrong guess wastes real work or is hard to undo.

A question that fails any of the three is not asked. Assume the most likely
answer and write the assumption into the intake block, where it can be
corrected.

Ask every question that passes through `AskUserQuestion`, together in one call.
Each question opens with the situation, says plainly whether anything is broken
or whether it is only a choice, and carries options with your recommendation
first. When no question passes the test, ask nothing and go on.

### 4. Acceptance criteria

Derive them from the goal and the context. Number them `AC1`, `AC2`, and so on.
Each criterion states one condition that someone other than you can check
without asking you. Together they cover the goal and every hard limit. A
criterion names a result, never a method.

### 5. Show the intake block

Show it before any work starts, every time, even when you asked nothing. It is
the one place Mike sees what you are about to optimise for.

```
## 🎯 Intake
**Goal:** <the outcome, one or two sentences>
**Context:** <what shapes the work. Mark each guess "Assumed:".>
**Acceptance:**
- AC1: <one observable condition>
- AC2: <...>
```

Keep the block to about 12 rows at 80 columns, so it leaves room on Mike's
screen for what follows it. Give each criterion one line. Put in the context
only the facts that shape the work and the guesses he may need to correct.

Keep the heading. `hooks/intake-nudge.sh` looks for a Markdown heading that
names "Intake" in your replies, and stays quiet when it finds one.

### 6. Three options, each from a different angle

Draft three options for how to meet the criteria. They must come at the problem
from different angles, not be three settings of one approach.

**Distinctness check.** Write it down before you grade:

1. Name each option's angle in a short phrase: where the change lives, what kind
   of mechanism it is (code, configuration, process, data, or removing
   something), and which part of the problem it attacks (the cause, the
   symptom, or the need for it at all).
2. For each pair, ask what would have to change to turn one into the other. If
   the answer is a parameter, a threshold, a name, the order of steps, or a
   swap for an equivalent library, the two are variants of one angle. Replace
   one of them.
3. If two phrases from step 1 name the same angle, replace one option.

If you can find only two real angles, say so. Honest is better than padded.

### 7. Grade every option against every criterion

Grade each option against each criterion as met, partly met, or not met, with a
short reason for anything short of met. Recommend the option with the best
grade. On a tie, the more correct option beats the faster one. The
recommendation cites its grade on every criterion, not only the ones it wins.
"All met" covers every criterion at once. Any other grade names each criterion
short of met by its number and a few words, such as "AC2 partly met: no UI
test". The intake block may have scrolled away by the time Mike reads the
grade, so the grade must make sense without it.

### 8. Fork, or proceed

**Put the options to Mike through `AskUserQuestion` only at a real fork.** It is
a real fork when:

- the top two options grade the same and differ in something Mike owns, such as
  a preference, a cost, a public interface, or a direction, or
- the best option still fails a criterion, or
- the pick is outward-facing or irreversible.

Put the recommended option first. Each option's description carries its grade
and any warning Mike needs, so the question stands on its own after the prose
above it has scrolled away. This holds for every decision Mike must make, not
only this one. Fall back to the output style's `## ❓ Open questions` block only
when the tool does not fit. The output style governs how options look when you
show them in a reply.

**Otherwise proceed on the top-graded option, and say so in one line** that
names the option and its grade on each criterion. For example: "Proceeding on
Option B (AC1 met, AC2 met, AC3 partly met: no test harness for the UI path)."

## During and after the work

- **A new fork mid-task** gets the same treatment: three options from different
  angles, graded against the same criteria.
- **The criteria do not move silently.** If one turns out wrong, say so, restate
  it, and continue.
- **A dispatch carries the criteria.** A brief to a sub-agent copies them into
  its `Acceptance:` slot, which `hooks/agent-dispatch-gate.sh` requires.
- **The report maps to the criteria.** Close by saying how each one was met, or
  why it was not.
