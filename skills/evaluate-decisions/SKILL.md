---
description: Grade recorded decisions and memory entries for decision quality — correctness against outcomes, accuracy/efficiency/speed, consistency/recurrence, and missing process — and write a learnings report. Gear 2 ("Evaluate") of the decision-quality learning loop; feeds /workbench-core:propose-upgrades. Run manually any time.
---

This is an execution-aware skill — check `skills/evaluate-decisions.learnings.md` in the vault before proceeding. If it exists, apply accumulated learnings.

The user has invoked `/workbench-core:evaluate-decisions`. Read the recently recorded **decisions** and **memory entries** in the vault and grade their *decision quality*, then write a **learnings report** that the Propose gear turns into concrete corrections. This skill **only reads the corpus and writes one report** — it never edits a decision or memory, and it never proposes or applies a fix (that is `propose-upgrades`' job).

Why this exists: the vault records what was decided, but nothing ever asks *were those decisions any good?* Left alone, wrong calls, contradictions, and the same mistake recorded three times sit in memory and quietly steer future decisions the wrong way. This skill is the periodic graded read that turns the record into learnings — so the next decision is more **accurate**, more **efficient**, and **faster**. Those three are the metrics every finding is measured against.

## Step 0 — Pre-warm tools and resolve scope

Load the memory MCP tools in one ToolSearch call (query: `"memory"`, generous `max_results`) so the toolkit is available: `search`, `read`, `list_documents`, `get_recent`, `get_backlinks`, `get_outlinks`, `get_similar`, `write`, `stats` — all on the `mcp__plugin_workbench-core_memory__*` prefix.

Read these references before grading (they define what "good" looks like, so grade against them, not invented standards):
- `${CLAUDE_PLUGIN_ROOT}/references/decision-promotion.md` — the bar for what is worth recording.
- `${CLAUDE_PLUGIN_ROOT}/references/vault-conventions.md` — frontmatter/types/paths.
- `${CLAUDE_PLUGIN_ROOT}/references/linking-synthesis.md` — how decisions/summaries/topics link.

Resolve the vault path from config (for the rare filesystem read):

```bash
CONFIG="$HOME/.claude/plugins/data/workbench-core-claude-workbench/config.json"
MEMORY_PATH="$(jq -r '.memory_path // empty' "$CONFIG" 2>/dev/null)"
MEMORY_PATH="${MEMORY_PATH:-$HOME/Documents/Claude/Memory}"
MEMORY_PATH="${MEMORY_PATH/#\~/$HOME}"
```

**Scope of this run** (the corpus to grade):
- If the user passed a date/arg (e.g. a folder, a since-date, or a single decision path), honor it.
- Else, read the most recent prior report in `learnings/` (frontmatter `last_evaluated`) and grade everything recorded **since** then.
- Else (first run), grade the **last 30 days** of decisions + memories.
- **Hard cap: 40 corpus items per run.** Decisions first, then feedback/insight memories, then session summaries. Record any remainder in the report; the next run resumes there. The cap bounds session cost and keeps findings high-signal.

Gather the corpus with `get_recent` / `list_documents` (filter by `type`: `decision`, `feedback`, `insight`; and `sessions/**/*.summary.md`). Do **not** read raw `*.log.md` transcripts — they are write-only archival.

## Step 1 — Grade on the four axes

Grade the corpus on all four axes below. Do the **cheap, high-confidence axes first** (3 and 4 are mechanically detectable from the vault); axis 1 is best-effort LLM judgment and axis 2 is judgment against the metrics. Every finding records: the axis, the metric(s) it bears on (**accuracy / efficiency / speed**), a severity (high/med/low), the evidence (vault paths), and a one-line *direction* for a fix (not the fix itself).

### Axis 3 — Consistency + recurrence (do first; highest confidence)
The strongest signal that a correction is needed. Detect:
- **Contradictions** — two memories/decisions asserting incompatible facts or rules. Use `search` on each decision's topic + `get_similar` to surface near-neighbors, then read both and judge.
- **Duplicates** — the same decision/rule recorded more than once (often across folders).
- **Recurrence** — the *same* mistake, correction, or feedback recorded **≥2 times** across sessions. This is the loop's core signal: a thing gone wrong twice should become a rule. Cluster by topic via `search`/`get_similar`; count independent recordings.

### Axis 4 — Gaps / missing process (cheap)
A decision that had to be made with **no governing rule** to guide it. Detect:
- A `decision` whose context shows a judgment call with no link to, and no existing, `feedback`/process memory or `CLAUDE.md`/guardrail rule covering it (`get_outlinks` + a topic `search` for a governing rule that should exist but doesn't).
- A class of choice that **recurs** with no recorded process — the gap Propose fills by recording the missing process.

### Axis 1 — Correctness vs. outcomes (best-effort)
Did a recorded decision prove **right**, or was it later reversed/corrected? Detect supersession:
- For each decision, `search` its topic for a **newer** decision/memory that contradicts or explicitly supersedes it; check `get_backlinks` for a later summary that records a reversal ("we changed our mind about X", "that was wrong").
- Treat an explicit `supersedes:` frontmatter link or a later `feedback` correcting the decision as strong evidence.
- This is **best-effort** — flag a decision as "proved wrong / reversed" only with concrete later evidence; otherwise leave it ungraded on this axis. Do not speculate.

### Axis 2 — Accuracy / efficiency / speed (judgment)
For each decision/memory, judge against the three metrics:
- **Accuracy** — was it the correct call given what was known?
- **Efficiency** — was it the most efficient path, or did it carry avoidable cost/complexity?
- **Speed** — did it reach the answer quickly, or via avoidable churn the record reveals?
Flag only items that score **poorly** on a metric, with a concrete one-line rationale and the evidence. A clean item produces no finding.

## Step 2 — Write the learnings report

Write via MCP `write` to `learnings/YYYY-MM-DD-eval.md` (today's date). This report is the **input contract for `propose-upgrades`** — keep the per-finding structure exact so it can be consumed:

```markdown
---
name: "Decision-quality evaluation — YYYY-MM-DD"
type: learnings
date: YYYY-MM-DD
last_evaluated: YYYY-MM-DD   # high-water mark for the next run's scope
tags: [learnings, evaluate, decision-quality]
summary: "N findings — A recurrence, B contradiction/duplicate, C gaps, D reversed, E metric-flags. Corpus: M items graded."
---

## Findings

### F1 — <short title>
- **Axis:** recurrence | contradiction | duplicate | gap | reversed | accuracy | efficiency | speed
- **Metric(s):** accuracy | efficiency | speed
- **Severity:** high | med | low
- **Evidence:** […](/decisions/….md), […](/sessions/….md)   (root-absolute markdown links)
- **Observation:** what the record shows (one or two sentences).
- **Direction:** the *kind* of fix (correction to X / record missing process Y) — NOT the fix itself.

### F2 — …

## Corpus graded
- N decisions, N memories, N summaries (since `<scope>`).

## Remainder
- N items beyond the 40-cap remain — next run resumes there.

## Clean
- One line noting areas graded with no findings (so a clean axis is visible, not silent).
```

Link findings to their evidence with root-absolute markdown links (`[display](/folder/file-stem.md)`) per `linking-synthesis.md`, so Propose and the human can navigate straight to the source.

## Step 3 — Report in chat

Terse: the finding counts by axis, the corpus size, and the one line — `Run /workbench-core:propose-upgrades to turn these into proposals.` Do not propose or apply anything here.

## Safety rails

- **Read-only on the corpus.** This skill writes exactly one file — the learnings report. It never edits a decision, memory, rule, or skill. Fixes are Propose's job, behind sign-off.
- **Evidence or it didn't happen.** Every finding cites concrete vault paths. No finding without evidence; axis-1 "reversed" needs explicit later evidence, never a guess.
- **Flag, don't fix.** Even an obvious correction is recorded as a *direction*, not applied.
- **Bounded.** 40 corpus items per run; record the remainder. High-signal beats exhaustive.
- **Never touch `*.log.md`.** Raw transcripts are not graded.
- **Grade against the references**, not invented standards — `decision-promotion.md` is the bar.

## Notes

- If `stats`/`get_recent` is unreachable, stop and report the MCP failure — there is no safe evaluation without the corpus.
- A "clean" run (no findings) is a valid, useful result — write the report anyway with an empty Findings section and a populated Clean section, so the high-water mark advances.
- This is gear 2 of 4. Gear 1 (Record) is the existing session-log → summary → decision-promotion pipeline; gear 3 (Propose) and gear 4 (Sign-off) live in `propose-upgrades`.
