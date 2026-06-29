---
description: Turn a decision-quality evaluation into concrete proposals — corrections to existing memories and new process recordings — then walk human sign-off and apply only what's approved. Gears 3+4 ("Propose" + "Sign-off") of the decision-quality learning loop; consumes /workbench-core:evaluate-decisions output. Run manually any time.
---

This is an execution-aware skill — check `skills/propose-upgrades.learnings.md` in the vault before proceeding. If it exists, apply accumulated learnings.

The user has invoked `/workbench-core:propose-upgrades`. Read the latest evaluation **learnings report** and turn each finding into a concrete **proposal** — a correction to an existing memory/rule, or a new process recording — written into a review digest. Then walk **sign-off**: in phase 1, **every proposal needs Mike's explicit approval** (no auto-accept). Apply only the approved ones; log the rejected ones so they never resurface.

Why this exists: evaluation produces findings, but a finding changes nothing on its own. This gear closes the loop — it proposes the *correction or missing process to record in memory* so that **future decisions are made correctly**, and it keeps Mike in control of every change to how the system thinks. The bar for each proposal is whether it improves one of three metrics: **accuracy, efficiency, speed**.

## Step 0 — Pre-warm tools and read the references

Load the memory MCP tools in one ToolSearch call (query: `"memory"`, generous `max_results`): `read`, `search`, `write`, `edit`, `list_documents`, `get_recent`, `get_backlinks` — on the `mcp__plugin_workbench-core_memory__*` prefix.

Read before drafting (a proposal must obey these):
- `${CLAUDE_PLUGIN_ROOT}/references/decision-promotion.md` — the bar for what's worth recording.
- `${CLAUDE_PLUGIN_ROOT}/references/vault-conventions.md` — frontmatter, types, write-vs-edit, relative paths.
- `${CLAUDE_PLUGIN_ROOT}/references/linking-synthesis.md` — wikilinks and cross-linking.

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
| **claude-md-rule** | Add/adjust a rule in a `CLAUDE.md` | repo-file flow (edit + commit-approval gate) |
| **skill-learning** | Bake a proven learning into a `SKILL.md` | hand to `/workbench-core:compact-learnings` |
| **new-skill** | A recurring task worth its own skill | repo-file flow, scaffolded separately |

For each proposal capture: the exact target path, the precise proposed write/edit (frontmatter + body, or the before→after edit), the **metric** it improves, severity, evidence links (carried from the finding), and a recommendation with one-line rationale. **Draft only — apply nothing in this step.**

## Step 3 — Write the proposal digest (the review queue)

Write via MCP `write` to `proposals/YYYY-MM-DD.md`. The digest **is** the sign-off review queue — each item carries an explicit decision box and status, so the file is the durable record of what was proposed and what Mike decided:

```markdown
---
name: "Upgrade proposals — YYYY-MM-DD"
type: proposal
date: YYYY-MM-DD
source: "[[learnings/YYYY-MM-DD-eval|evaluation]]"
status: pending          # pending → signed-off when every item is decided
tags: [proposal, upgrade, decision-quality]
summary: "N proposals — C corrections, P new-process, R promotions, … awaiting sign-off."
---

## P1 — <short title>
- **Type:** correction | new-process | promote | claude-md-rule | skill-learning | new-skill
- **Metric:** accuracy | efficiency | speed
- **Severity:** high | med | low
- **Target:** `decisions/…` | `feedback/…` (path the change lands on)
- **Evidence:** [[…|…]], [[…|…]]
- **Proposed change:** the exact write/edit (for a correction, the before → after).
- **Recommendation:** approve | reject — one-line why (and how it improves the metric).
- **Decision:** ☐ approve  ☐ reject        <!-- filled at sign-off -->
- **Status:** proposed                      <!-- proposed → applied | rejected -->

## P2 — …
```

## Step 4 — Sign-off (phase 1: every item needs Mike)

Walk the digest with Mike. **Phase 1 has no auto-accept — present every proposal**, in severity order, each with its proposed change and your recommendation, and **wait for his decision** before the next (this is the `develop` decision protocol applied to the learning layer). Offer three choices per item:

| Choice | Action |
|---|---|
| **Approve** | Apply it (Step 5), set `Status: applied`. |
| **Reject** | Don't apply; append a one-line entry to `proposals/rejected.md` (title + target + why) so it never resurfaces; set `Status: rejected`. |
| **Edit & approve** | Mike amends the proposed change; apply the amended version. |

Mike judges each against **accuracy / efficiency / speed** — the metrics named on the item. When every item is decided, set the digest `status: signed-off`.

## Step 5 — Apply approved proposals

- **Vault memory** (`correction`, `new-process`, `promote` staying in the vault): apply via MCP `edit` (corrections — never overwrite a doc to change one field) or `write` (new `feedback` doc with proper frontmatter per `vault-conventions.md`). Cross-link to the evidence and the source evaluation per `linking-synthesis.md`.
- **Repo files** (`claude-md-rule`, `new-skill`, a `promote` landing in `CLAUDE.md`): make the edit with the file tools, then commit it **through the normal commit-approval gate** — show the diff and the `/workbench-dev-team:git-commit`-formatted message and wait for Mike's explicit yes. This skill's sign-off governs *what gets learned*; it does **not** bypass the deployed-code commit gate.
- **`skill-learning`**: hand the entry to `/workbench-core:compact-learnings` for integration into the `SKILL.md` (don't reimplement that flow here).
- Update each applied item's `Status` in the digest as you go, so the digest stays an accurate ledger.

## Step 6 — Report

Terse: `N proposals — A applied, R rejected, E edited-then-applied.` Note any repo-file changes still pending their commit-approval. Point at the digest path.

## Safety rails

- **Never auto-apply.** Phase 1 = explicit sign-off on every item. No proposal is applied without Mike's yes for *that* item.
- **Corrections use `edit`, not overwrite.** Preserve the rest of the target document byte-for-byte.
- **The commit gate is sacrosanct.** Repo-file changes go through the normal show-diff/show-message/wait-for-yes flow. Never set `WORKBENCH_DEV_TEAM_PIPELINE=1` or create a lock to skip it.
- **Rejections are durable.** A rejected proposal is logged and never re-surfaced — respect the ledger on every run.
- **One proposal per fix.** Consolidate findings that point at the same change; don't flood the queue.
- **Stay within the bar.** A proposal must clear `decision-promotion.md` and name the metric it improves; if it does neither, drop it.

## Notes

- This is gears 3+4 of 4. Gear 1 (Record) = the existing session-log → summary → decision-promotion pipeline; gear 2 (Evaluate) = `/workbench-core:evaluate-decisions`, whose report is this skill's input.
- **Auto-accept and unattended scheduling are deferred to phase 2** — a future low-risk tier and a scheduled-tasks job that *generates* the digest but still never applies. Do not add either here without an explicit decision.
- If the evaluation report has no findings, say so and stop — nothing to propose.
