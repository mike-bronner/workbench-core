// Who is at the other end of a turn. The question rule enforces only where Mike
// is there to answer AskUserQuestion. Everywhere else a re-prompt or a refusal
// would loop, because nobody can answer the dialog.
//
// Three levels, each with its own signal:
//
//   session   isInteractive is false for `claude -p` and the SDK. A top-level
//             `claude -p --agent` run (the Index pipeline) also sets
//             CLAUDE_CODE_AGENT. bin/dispatch-agent.sh exports
//             WORKBENCH_DEV_TEAM_PIPELINE=1, which is read as a backstop.
//   turn      The prompt that opened the turn: its origin, and the
//             `<scheduled-task ` wrapper a scheduled fire carries, since a
//             desktop scheduled task can run in a session that looks
//             interactive.
//             A task notification counts as attended: in an interactive
//             session it is where a commit question or a relayed result is
//             asked, and stop_hook_active already caps its re-prompt at one.
//   loop      A sub-agent's tool.call carries agentId, and its Stop is a
//             SubagentStop. A Stop from a top-level --agent run carries
//             agent_type.
//
// Every unknown reads as unattended, so the rule never fires on a guess.
//
// $.workbench.isUnattended() and callerLane() answer from these same functions,
// so the question rule and every dependent plugin read one lane definition.
//
// Pure functions only: the engine follows `$` into no imported function, so the
// hooks that read the signals live in hooks/register.ts.

import type { PromptOrigin } from 'claude-code'

import type { WorkbenchCallerLane } from '../../types'

// The prompt origins that open a turn a person in an interactive session
// answers: what they typed or clicked, and a background task's notification. A
// peer, a channel, an SDK host, or a scheduled trigger opens a turn nobody may
// be watching, so it is left out.
const ATTENDED_ORIGINS: ReadonlySet<PromptOrigin['kind']> = new Set([
  'composer',
  'bridge',
  'auto-continuation',
  'task-notification',
])

export const isScheduledFire = (text: string): boolean => text.trimStart().startsWith('<scheduled-task ')

export const isAttendedPrompt = (origin: PromptOrigin, text: string): boolean =>
  ATTENDED_ORIGINS.has(origin.kind) && !isScheduledFire(text)

export const isAttendedSession = (isInteractive: boolean, agent: string | undefined, pipeline: string | undefined): boolean =>
  isInteractive && !agent && pipeline !== '1'

// Who makes a call, from the agentId the call's event carries and the session's
// CLAUDE_CODE_AGENT. A sub-agent's events carry agentId. A top-level
// `claude -p --agent` run carries none, and is told apart by CLAUDE_CODE_AGENT.
export const laneOf = (agentId: string | undefined, agent: string | undefined): WorkbenchCallerLane =>
  agentId ? 'sub-agent' : agent ? 'top-level-agent' : 'main'
