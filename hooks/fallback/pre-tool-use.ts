import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'

import { GUARD_FAILED } from '../mods/guard-failed.ts'
import { activeSession, hookInput, isAttended } from './gate.ts'

const TIMEOUT_MS = 10_000
const DEADLINE_MS = 20_000
const deadline = Date.now() + DEADLINE_MS

const run = async ([command = '', ...args]: readonly string[]): Promise<{ exitCode: number; stdout: string }> => {
  const left = deadline - Date.now()
  if (left <= 0) throw new Error('fallback deadline passed')
  const { status, stdout } = spawnSync(command, args, { encoding: 'utf8', timeout: Math.min(TIMEOUT_MS, left), stdio: ['ignore', 'pipe', 'ignore'] })
  if (Date.now() >= deadline) throw new Error('fallback deadline passed')
  return { exitCode: status ?? -1, stdout: stdout ?? '' }
}

const answer = (permissionDecision: 'ask' | 'deny', permissionDecisionReason: string): void => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason } }))
}

const input = await hookInput()
const sessionId = activeSession(process.env, input)
const command = (input.tool_input as { command?: unknown } | null | undefined)?.command
const root = process.env.CLAUDE_PLUGIN_ROOT
if (sessionId !== undefined && input.tool_name === 'Bash' && typeof command === 'string') {
  try {
    const { hiddenCommandRefusal } = await import('../mods/guards.ts')
    const { NO_ONE_TO_ASK } = await import('../mods/destructive-scope.ts')
    const { scopeOf } = await import('../mods/scope-facts.ts')
    const { parseShell } = await import('../mods/shell.ts')
    const cwd = typeof input.cwd === 'string' && input.cwd.startsWith('/') ? input.cwd : undefined
    if (!root || cwd === undefined) throw new Error('no plugin root or cwd')
    const host = { run, isFile: async (path: string) => statSync(path).isFile(), root }
    const parse = parseShell(command)
    const project = process.env.CLAUDE_PROJECT_DIR || cwd
    const scope = hiddenCommandRefusal(parse) === undefined ? await scopeOf(host, command, parse, process.env.HOME, { cwd: async () => cwd, ids: async () => ({ sessionId, project }) }) : undefined
    if (scope?.kind === 'deny') answer('deny', scope.reason)
    if (scope?.kind === 'ask') isAttended(process.env) ? answer('ask', scope.reason) : answer('deny', `${scope.reason} ${NO_ONE_TO_ASK}`)
  } catch {
    answer('deny', GUARD_FAILED)
  }
}
