import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

import { transcriptFileOf } from '../mods/fallback.ts'
import { meetingsDir } from './meetings.ts'
import { activeSession, emit, hookInput, rulesContext } from './seated.ts'

const startedAt = Date.now()
const input = await hookInput()
const sessionId = activeSession(process.env, input)
const root = process.env.CLAUDE_PLUGIN_ROOT
if (sessionId !== undefined) {
  const file = transcriptFileOf(process.env.HOME, sessionId)
  if (file !== undefined && typeof input.transcript_path === 'string' && input.transcript_path !== '') {
    mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true })
    writeFileSync(file, input.transcript_path)
  }
  if (root && (input.source === 'startup' || input.source === 'resume')) {
    spawn(process.execPath, [`${root}/hooks/fallback/deferred.ts`, sessionId, input.source, String(startedAt)], { detached: true, stdio: 'ignore' }).unref()
  }
  const meetings = meetingsDir(process.env)
  emit('SessionStart', rulesContext(process.env), meetings === undefined ? [] : [meetings])
}
