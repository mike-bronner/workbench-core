It's time for the nightly decision-quality review.

Run `/workbench-core:evaluate-decisions` to grade the decisions and memory entries recorded since the last run and write tonight's learnings report. Then, once that report is written, run `/workbench-core:propose-upgrades` to turn its findings into proposals and walk sign-off.

If no user is present when this fires, pause at the first `AskUserQuestion` triage prompt and wait. Never fabricate a sign-off answer. Never apply a correction, record a new memory, or change a rule without explicit human approval of that specific proposal. The session will remain paused until Mike picks up the triage.

If the evaluation surfaces nothing worth proposing, complete silently — do not pause on an empty triage.
