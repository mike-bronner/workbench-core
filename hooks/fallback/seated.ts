import { rulesContextOf } from '../mods/prompt-rules.ts'
import type { Env } from './gate.ts'
import { readIfAny } from './gate.ts'

export type { Env, HookInput } from './gate.ts'
export { activeSession, hookInput, isAttended, modRan, readIfAny } from './gate.ts'

export const rulesContext = (env: Env): string | undefined => rulesContextOf(env, readIfAny)

export function emit(hookEventName: string, additionalContext: string | undefined, watchPaths: readonly string[] = []): void {
  if (additionalContext === undefined && watchPaths.length === 0) return
  const output = { hookEventName, ...(additionalContext === undefined ? {} : { additionalContext }), ...(watchPaths.length === 0 ? {} : { watchPaths }) }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: output }))
}
