import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'

import { doorbellFileOf } from '../mods/fallback.ts'
import { DOORBELL_MS, RUN_TIMEOUT_MS, SCRIPT as MEETING_SCRIPT, isInside } from '../mods/meetings.ts'
import { meetingsDir } from './meetings.ts'
import { activeSession, hookInput } from './gate.ts'

const root = process.env.CLAUDE_PLUGIN_ROOT
const bell = doorbellFileOf(process.env.HOME)

const isRinging = (file: string): boolean => {
  try {
    return Date.now() - statSync(file).mtimeMs < DOORBELL_MS + RUN_TIMEOUT_MS
  } catch {
    return false
  }
}

if (process.argv[2] === '--ring') {
  await new Promise(resolve => setTimeout(resolve, DOORBELL_MS))
  if (bell !== undefined) rmSync(bell, { force: true })
  spawnSync('bash', [`${root}/scripts/${MEETING_SCRIPT}`], { encoding: 'utf8', timeout: RUN_TIMEOUT_MS, stdio: ['ignore', 'ignore', 'ignore'] })
} else {
  const input = await hookInput()
  const meetings = activeSession(process.env, input) === undefined ? undefined : meetingsDir(process.env)
  if (root && bell !== undefined && meetings !== undefined && typeof input.file_path === 'string' && isInside(input.file_path, meetings) && !isRinging(bell)) {
    mkdirSync(bell.slice(0, bell.lastIndexOf('/')), { recursive: true })
    writeFileSync(bell, String(Date.now()))
    spawn(process.execPath, [`${root}/hooks/fallback/file-changed.ts`, '--ring'], { detached: true, stdio: 'ignore' }).unref()
  }
}
