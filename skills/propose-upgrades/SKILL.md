---
description: Turn a decision-quality evaluation into concrete proposals — corrections to existing memories and new process recordings — then walk human sign-off and apply only what's approved. Gears 3+4 ("Propose" + "Sign-off") of the decision-quality learning loop; consumes /workbench-core:evaluate-decisions output. Run manually any time.
---

The user has invoked `/workbench-core:propose-upgrades`. Read the latest evaluation **learnings report** and turn each finding into a concrete **proposal** — a correction to an existing memory/rule, or a new process recording — written into a review digest. Then walk **sign-off**: in phase 1, **every proposal needs the user's explicit approval** (no auto-accept). Apply only the approved ones; log the rejected ones so they never resurface.

Why this exists: evaluation produces findings, but a finding changes nothing on its own. This gear closes the loop — it proposes the *correction or missing process to record in memory* so that **future decisions are made correctly**, and it keeps the user in control of every change to how the system thinks. The bar for each proposal is whether it improves one of three metrics: **accuracy, efficiency, speed**.

## Step 0 — Pre-warm tools and read the references

Load the memory MCP tools in one ToolSearch call (query: `"memory"`, generous `max_results`): `read`, `search`, `write`, `edit`, `list_documents`, `get_recent`, `get_backlinks` — on the `mcp__plugin_workbench-core_memory__*` prefix.

Read before drafting (a proposal must obey these):
- `${CLAUDE_PLUGIN_ROOT}/references/decision-promotion.md` — the bar for what's worth recording.
- `${CLAUDE_PLUGIN_ROOT}/references/vault-conventions.md` — frontmatter, types, write-vs-edit, relative paths.
- `${CLAUDE_PLUGIN_ROOT}/references/linking-synthesis.md` — link syntax and cross-linking.

## Step 1 — Load the evaluation and the rejection ledger

1. **Find the source report.** If the user passed a path, use it. Else read the most recent `learnings/YYYY-MM-DD-eval.md`. If none exists, stop and tell the user to run `/workbench-core:evaluate-decisions` first.
2. **Load the rejection ledger** `proposals/rejected.md` (create lazily if absent). It records previously-rejected proposals so the same one is never re-surfaced. Before drafting, note its entries.
3. If the latest report has `status: signed-off` already and the user didn't pass a new one, say so and stop — there is nothing new to propose.

## Step 2 — Draft proposals (Propose)

For each finding in the report, draft **at most one** proposal (consolidate findings that point at the same fix). Skip any finding whose fix matches a `proposals/rejected.md` entry — note the skip in chat, don't re-propose.

Each proposal has a **type**, which determines the concrete change:

| Type | What it does | Applied via |
|---|---|---|
| **correction** | Fix a wrong/contradictory existing memory or decision | MCP `edit` on the target |
| **new-process** | Record a missing rule/process as a `feedback` memory so future decisions follow it | MCP `write` (new `feedback` doc) |
| **promote** | Promote a recurring `feedback`/`insight` into an active rule | MCP `write`/`edit` + (if it lands in `CLAUDE.md`) the repo-file flow below |
| **claude-md-rule** | Add/adjust a rule in a `CLAUDE.md` | repo-file flow (Watson brief, user approves the commit through `AskUserQuestion`) |
| **skill-learning** | Bake a proven learning into a `SKILL.md` | hand to `/workbench-core:compact-learnings` |
| **new-skill** | A recurring task worth its own skill | repo-file flow, scaffolded separately |

For each proposal capture: the exact target path, the precise proposed write/edit (frontmatter + body, or the before→after edit), the **metric** it improves, severity, evidence links (carried from the finding), and a recommendation with one-line rationale. **Draft only — apply nothing in this step.**

## Step 3 — Write the proposal digest (the review queue)

Write via MCP `write` to `proposals/YYYY-MM-DD.md`. The digest **is** the sign-off review queue — each item carries an explicit decision box and status, so the file is the durable record of what was proposed and what the user decided:

```markdown
---
name: "Upgrade proposals — YYYY-MM-DD"
type: proposal
date: YYYY-MM-DD
source: "[evaluation](/learnings/YYYY-MM-DD-eval.md)"
status: pending          # pending → signed-off when every item is decided
tags: [proposal, upgrade, decision-quality]
summary: "N proposals — C corrections, P new-process, R promotions, … awaiting sign-off."
---

## P1 — <short title>
- **Type:** correction | new-process | promote | claude-md-rule | skill-learning | new-skill
- **Metric:** accuracy | efficiency | speed
- **Severity:** high | med | low
- **Target:** `decisions/…` | `feedback/…` (path the change lands on)
- **Evidence:** […](/…md), […](/…md)
- **Proposed change:** the exact write/edit (for a correction, the before → after).
- **Recommendation:** approve | reject — one-line why (and how it improves the metric).
- **Decision:** ☐ approve  ☐ reject        <!-- filled at sign-off -->
- **Status:** proposed                      <!-- proposed → applied | rejected -->

## P2 — …
```

## Step 4 — Sign-off (phase 1: every item needs the user)

Present the proposals for sign-off via **`AskUserQuestion`** — one question per proposal, in severity order, batched in groups of up to 4 per call (the tool's max). **This is what makes the scheduled run work:** when this skill runs unattended (the nightly `workbench-core-decision-quality` task), the `AskUserQuestion` call **pauses the session and waits** until the user picks up the triage — it never fabricates an answer or auto-applies. Run interactively, the same call just prompts them directly. The behavior is identical; only who answers (now vs. later) differs.

Each question states the proposed change + your recommendation + the metric it improves. Options per proposal:

| Option | Action |
|---|---|
| **Approve** | Apply it (Step 5); set `Status: applied`. |
| **Reject** | Don't apply; append a one-line entry to `proposals/rejected.md` (title + target + why) so it never resurfaces; set `Status: rejected`. |
| **Edit & approve** | The user amends via the question's free-text "Other"; apply the amended version. |

Phase 1 has **no auto-accept** — every proposal goes through a question. The user judges each against **accuracy / efficiency / speed** — the metrics named on the item. Apply each decision (Step 5) as it lands; when every item is decided, set the digest `status: signed-off`.

**Empty-triage guard:** if there are no proposals, do **not** call `AskUserQuestion` — finish silently. A scheduled run must never pause on an empty triage.

## Step 5 — Apply approved proposals

- **Vault memory** (`correction`, `new-process`, `promote` staying in the vault): apply via MCP `edit` (corrections — never overwrite a doc to change one field) or `write` (new `feedback` doc with proper frontmatter per `vault-conventions.md`). Cross-link to the evidence and the source evaluation per `linking-synthesis.md`.
- **Repo files** (`claude-md-rule`, `new-skill`, a `promote` landing in `CLAUDE.md`): do not edit them from this context. A repository change is development work, so it goes to Dr. Watson in Direct mode through `/workbench-dev-team:orchestrate`, with a six-slot brief. `Workdir:` is the repository. `Goal:` is the approved change in behaviour. `Context:` quotes the approved proposal and its evidence. `Acceptance:` lists the behaviour the approved proposal asks for, as criteria the change is graded against. `Done when:` is the change made and tested, with the tree left uncommitted. Watson hands back the diff and a proposed message. Once the user has reviewed the tree, the orchestrator asks them to approve the commit through `AskUserQuestion`, as one question on its own. Their answer is the approval. The permission prompt that follows is only a backstop. If `workbench-dev-team` is not installed, report each approved repo change with the file it belongs in, and leave it for the user. This skill's sign-off governs *what gets learned*. It never replaces review of the code change.
- **`skill-learning`**: hand the entry to `/workbench-core:compact-learnings` for integration into the `SKILL.md` (don't reimplement that flow here).
- Update each applied item's `Status` in the digest as you go, so the digest stays an accurate ledger.

## Step 6 — Report

Terse: `N proposals — A applied, R rejected, E edited-then-applied.` Name any repo change handed to Watson, which still waits for the user's commit approval through `AskUserQuestion`. Point at the digest path.

## Safety rails

- **Never auto-apply.** Phase 1 = explicit sign-off on every item. No proposal is applied without the user's yes for *that* item.
- **Corrections use `edit`, not overwrite.** Preserve the rest of the target document byte-for-byte.
- **Repo changes go through Watson and the user's commit approval.** Never edit a repository file from this context, never set `WORKBENCH_DEV_TEAM_PIPELINE=1`, and never commit before the user approves through `AskUserQuestion`. The permission prompt is a backstop, not the approval.
- **Rejections are durable.** A rejected proposal is logged and never re-surfaced — respect the ledger on every run.
- **One proposal per fix.** Consolidate findings that point at the same change; don't flood the queue.
- **Stay within the bar.** A proposal must clear `decision-promotion.md` and name the metric it improves; if it does neither, drop it.

## Notes

- This is gears 3+4 of 4. Gear 1 (Record) = the existing session-log → summary → decision-promotion pipeline; gear 2 (Evaluate) = `/workbench-core:evaluate-decisions`, whose report is this skill's input.
- **Unattended runs ship already.** `/workbench-core:setup` Step 3 can register the nightly `workbench-core-decision-quality` task, which runs evaluate and then this skill, and pauses at the sign-off triage. **Auto-accept is deferred to phase 2**, a future low-risk tier. Do not add it here without an explicit decision.
- If the evaluation report has no findings, say so and stop — nothing to propose.
