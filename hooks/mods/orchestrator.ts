// Orchestrator mode: whether the delegation reminder and the agent dispatch
// gate are active for this session. ON by default.
//
// WHERE THE MODE LIVES. hooks/register.ts keeps it in $.state for the session,
// and in $.store keyed by session id, so a resumed session in a new process
// keeps it. The delegation reminder (hooks/mods/delegation.ts) reads it there,
// through $.workbench.orchestratorIsOn(). The bash gate
// hooks/agent-dispatch-gate.sh still reads the legacy file:
//
//   ${WORKBENCH_ORCHESTRATOR_STATE_DIR:-$HOME/.claude-workbench/orchestrator-mode}/<session_id>
//
// An existing file means off. So the module mirrors the mode into that file, and
// the gate honours /orchestrator exactly as it honoured the old skill.
//
// ONLY MIKE SWITCHES IT. /orchestrator is a command, and its command.run hook
// acts only on a run a person started: Enter at the prompt (`composer`) or the
// Remote Control bridge. The model has no command to call, and the skill that
// let it run the toggle is gone. The file is the one door left: a model that
// creates it through Bash would stand the gates down. So before every main-loop
// Write, NotebookEdit and Agent call, which are the calls the gates judge, the
// module puts the file back in line with the mode Mike chose. Plugin tool.call
// hooks run before the settings hooks, so the gates read the corrected file.
//
// The legacy file is honoured at session start: a session whose file already
// exists, and whose mode was never set through /orchestrator, starts off. That
// keeps a session switched off by an older build switched off.
//
// Pure functions only: the engine follows `$` into no imported function.

import type { PromptOrigin } from 'claude-code'

// Days a stored mode is kept, as the old skill pruned its files.
export const KEEP_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

// A session id that can name a file: anything else could walk out of the
// state directory, and the gates stand down on it. A leading dot is refused
// too: `.` and `..` name directories, and a dotfile is not a session's.
export const isSessionId = (id: string | undefined): id is string => id !== undefined && /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(id)

// The legacy file for `sessionId`, or undefined when no directory resolves or
// the id cannot name a file.
export function legacyFileOf(sessionId: string | undefined, stateDir: string | undefined, home: string | undefined): string | undefined {
  if (!isSessionId(sessionId)) return undefined
  const dir = stateDir || (home ? `${home}/.claude-workbench/orchestrator-mode` : undefined)
  return dir ? `${dir.replace(/\/+$/, '')}/${sessionId}` : undefined
}

// A run a person started: what they typed or sent from a phone. A plugin's
// $.command.run, the SDK, a schedule and every agent are not a person.
export const isPersonOrigin = (origin: PromptOrigin): boolean => origin.kind === 'composer' || origin.kind === 'bridge'

export type Toggle = 'on' | 'off' | 'status'

export function toggleOf(args: string): Toggle | undefined {
  const word = args.trim().toLowerCase()
  if (word === '' || word === 'status') return 'status'
  return word === 'on' || word === 'off' ? word : undefined
}

// The stored modes, as $.store keeps them: when each session was switched
// off. A session switched back on has no entry. Entries older than KEEP_DAYS
// are dropped, so the store does not grow by one key per session forever.
export type OffSessions = Record<string, number>

export function offSessionsOf(value: unknown, now: number): OffSessions {
  if (typeof value !== 'object' || value === null) return {}
  return Object.fromEntries(
    Object.entries(value).filter(([id, at]) => isSessionId(id) && typeof at === 'number' && now - at < KEEP_DAYS * DAY_MS),
  )
}

export function withMode(sessions: OffSessions, sessionId: string, isOn: boolean, now: number): OffSessions {
  const { [sessionId]: _, ...rest } = sessions
  return isOn ? rest : { ...rest, [sessionId]: now }
}

export const STORE_KEY = 'orchestrator-off'

export const REFUSAL =
  '/orchestrator runs only when Mike types it. A run from a plugin, a schedule or an agent changes nothing.'
export const USAGE = 'Usage: /orchestrator [on | off | status]'

export const reportOf = (isOn: boolean): string =>
  isOn
    ? 'Orchestrator mode is ON for this session: the first whole-file write draws a reminder, and Agent dispatches need the brief.'
    : 'Orchestrator mode is OFF for this session: no delegation reminder, and no dispatch gate.'
