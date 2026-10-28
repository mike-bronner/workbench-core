import { existsSync, readFileSync } from 'node:fs'

import { sessionDirOf } from '../mods/fallback.ts'
import { isAttendedSession } from '../mods/lane.ts'

export type Env = Record<string, string | undefined>
export type HookInput = {
  session_id?: unknown
  transcript_path?: unknown
  source?: unknown
  agent_type?: unknown
  agent_id?: unknown
  cwd?: unknown
  stop_hook_active?: unknown
  last_assistant_message?: unknown
  tool_name?: unknown
  tool_input?: unknown
  file_path?: unknown
}

const UNATTENDED_ENTRYPOINTS: ReadonlySet<string> = new Set(['', 'claude-code-github-action'])

export const readIfAny = (path: string): string | undefined => {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined
  } catch {
    return undefined
  }
}

export function modRan(env: Env, sessionId: string): boolean {
  const dir = sessionDirOf(env.HOME, sessionId)
  return dir === undefined || existsSync(dir)
}

export async function hookInput(): Promise<HookInput> {
  process.stdin.setEncoding('utf8')
  let text = ''
  for await (const chunk of process.stdin) text += String(chunk)
  try {
    const parsed = JSON.parse(text) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as HookInput) : {}
  } catch {
    return {}
  }
}

export function activeSession(env: Env, input: HookInput): string | undefined {
  const sessionId = typeof input.session_id === 'string' ? input.session_id : ''
  if (sessionId === '' || modRan(env, sessionId)) return undefined
  return sessionId
}

export const isAttended = (env: Env): boolean => {
  const entry = env.CLAUDE_CODE_ENTRYPOINT ?? ''
  return isAttendedSession(!UNATTENDED_ENTRYPOINTS.has(entry) && !entry.startsWith('sdk'), env.CLAUDE_CODE_AGENT, env.WORKBENCH_DEV_TEAM_PIPELINE)
}
