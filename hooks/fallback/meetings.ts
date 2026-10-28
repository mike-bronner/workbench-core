import { existsSync, statSync } from 'node:fs'

import { FV_SERVE, meetingsDirOf } from '../mods/meetings.ts'
import type { Env } from './gate.ts'

export function meetingsDir(env: Env): string | undefined {
  if (env.WORKBENCH_SKIP_WARMUP === '1' || !env.HOME || !existsSync(FV_SERVE)) return undefined
  const dir = meetingsDirOf(env.HOME)
  try {
    return statSync(dir).isDirectory() ? dir : undefined
  } catch {
    return undefined
  }
}
