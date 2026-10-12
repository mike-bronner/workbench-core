// The agent dispatch gate: a main-agent Agent call whose prompt lacks a slot
// of the six-slot brief is refused, and a complete brief that dictates method
// draws an advisory hint. Judged in hooks/register.ts's tool.call hook. It
// replaced the bash gate hooks/agent-dispatch-gate.sh.
//
// WHAT IT CHECKS. One structural question: are the six slot headers present
// ($.workbench.briefCheck, hooks/mods/brief.ts). Whether the work is code work,
// and whether Goal: states an outcome, are questions about substance, and they
// belong to the agent that receives the brief. Measured against 14 days of real
// dispatches, every prompt-classifying heuristic misfired on prose tasks that
// name source files and on read-only audits, so the check applies to every
// main-session dispatch, research included. No length is enforced.
//
// WHO IS GATED. The main loop only, from $.workbench.callerLane: a sub-agent's
// helper dispatch and a top-level `claude -p --agent` run (which carries the
// review-lens fan-out and the scheduled pipeline) are not. WORKBENCH_ORCHESTRATOR=0
// and /orchestrator off stand the gate down. The gate reads the mode from
// $.state and $.store through orchestratorOn in hooks/register.ts, and never
// through $.workbench.orchestratorIsOn(), which answers off when no legacy
// file can be named.
// A blank prompt, and the two machine-built shapes `Item ID: <n>` and
// `Repo sweep: <owner/repo>`, pass: briefCheck names them by their shape.
//
// IT FAILS CLOSED. The bash gate failed open on every error. This port fails
// closed like every guard in hooks/mods/guards.ts: the slot check and the hint
// are pure, so the only failures are the lane, mode and HOME reads around them,
// and one that rejects throws to the tool.call hook's .catch, which refuses
// Agent because Agent is in GUARDED. /orchestrator off is the way past a gate
// that keeps failing.
//
// THE HINT NEVER BLOCKS. Over-specified method wastes the sub-agent's
// judgement but breaks nothing, so the hint is context on a call that went
// through.
//
// ONE CHANNEL. The bash gate split its deny into a one-line reason for a person
// and context for the model. A tool.call deny carries one string, so the reason
// leads it and the recovery instructions follow. No Markdown emphasis: the
// model receives the raw source.
//
// The gate table in hooks/mods/prompt-rules.ts names this module as the Agent
// dispatch gate (workbench-core), and hooks/test-session-warmup.sh finds it here
// by that name.
//
// Pure functions only: the engine follows `$` into no imported function.

import type { WorkbenchBriefSlot } from '../../types'

export const DEV_TEAM_LINE = 'The dev-team specialists and the brief they expect are in /workbench-dev-team:orchestrate.'

export const HINT_LEAD = '📐 Dispatch hint (advisory, nothing was blocked)'

// The refusal for a brief that lacks `missing`. The slot list is read from the
// same records the check uses, so the two cannot disagree.
export function denyOf(missing: readonly string[], slots: readonly WorkbenchBriefSlot[], hasDevTeam: boolean): string {
  const summary = slots.map(slot => `${slot.header} (${slot.description})`).join(', ')
  return [
    `🛑 Blocked: an Agent dispatch without a complete brief. Missing: ${missing.join(', ')}.`,
    `Agent dispatch gate (workbench-core). Every Agent dispatch from the main session uses the six-slot brief, research included. Slots: ${summary}. Add the missing slots and dispatch again.`,
    ...(hasDevTeam ? [DEV_TEAM_LINE] : []),
    'To dispatch without the brief in this session, the human can run /orchestrator off.',
  ].join(' ')
}

const WS = ' \\t\\r\\v\\f'
const FENCE = new RegExp(`^[${WS}]*\`\`\``)
// The list omits go, make, sh and touch: each opens ordinary brief sentences
// ("make sure the suite is green"), and a hint that fires on those is ignored.
const SHELL_LINE = new RegExp(
  `^[${WS}]*(\\$[${WS}]+)?(git|gh|npm|npx|yarn|pnpm|composer|php|python3?|pytest|cargo|rustc|bash|zsh|sed|awk|grep|rg|jq|cp|mv|rm|mkdir|chmod|ln|curl|docker)[${WS}]+[^${WS}]`,
)
const STEP = new RegExp(`^[${WS}]{0,3}[0-9]+[.)][${WS}]+[^${WS}]`)

// The hint for a complete brief, or undefined when it dictates no method. Each
// marker is line-anchored, a line at a time as grep reads: a command matched
// anywhere fired on 91% of briefs, prose that only mentions `git log` included.
export function hintOf(prompt: string): string | undefined {
  const lines = prompt.split('\n')
  const steps = lines.filter(line => STEP.test(line)).length
  const markers = [
    ...(lines.some(line => FENCE.test(line)) ? ['a fenced code block'] : []),
    ...(lines.some(line => SHELL_LINE.test(line)) ? ['a shell command on its own line'] : []),
    ...(steps >= 3 ? [`${steps} numbered steps`] : []),
  ]
  if (markers.length === 0) return undefined
  return `${HINT_LEAD}: this brief carries ${markers.join(', ')}. A brief states the outcome and lets the sub-agent pick the method. The sub-agent has the repo in front of it and you do not. Prefer moving that detail into Done when: as an observable result, or into Constraints: as a hard limit. Send it as-is if the detail is genuinely a constraint rather than a recipe.`
}
