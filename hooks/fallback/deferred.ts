import { spawn, spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'

import { FV_SERVE, SCRIPT as MEETING_SCRIPT, meetingsDirOf } from '../mods/meetings.ts'
import { readIfAny } from './seated.ts'

const [sessionId = '', source = '', startedAt = ''] = process.argv.slice(2)
const since = Number(startedAt)
const root = process.env.CLAUDE_PLUGIN_ROOT
const home = process.env.HOME
const STAMP_WAIT_MS = 30_000
const POLL_MS = 250
const STAMP_SLACK_MS = 5_000

const run = (argv: readonly string[], stdin?: string): void => {
  const child = spawn('bash', argv, { detached: true, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'] })
  child.stdin?.end(stdin ?? '')
  child.unref()
}

function cachePath(): string | undefined {
  const { stdout, status } = spawnSync('bash', ['-c', '. "$1" && memory_resolve_cache_path', 'memory-env', `${root}/hooks/lib/memory-env.sh`], { encoding: 'utf8', timeout: 10_000 })
  return status === 0 && stdout ? stdout.trim() : undefined
}

function isFreshStamp(path: string): boolean {
  try {
    return statSync(path).mtimeMs >= since - STAMP_SLACK_MS && readIfAny(path)?.split(/\s+/)[0] === sessionId
  } catch {
    return false
  }
}

async function deferStarted(cache: string): Promise<boolean> {
  for (let waited = 0; waited < STAMP_WAIT_MS; waited += POLL_MS) {
    if (isFreshStamp(`${cache}/warmup-deferred.started`)) return true
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
  return false
}

if (root && home && sessionId !== '' && Number.isFinite(since) && since > 0) {
  if (process.env.WORKBENCH_SKIP_WARMUP !== '1' && existsSync(FV_SERVE) && existsSync(meetingsDirOf(home))) run([`${root}/scripts/${MEETING_SCRIPT}`])
  const cache = cachePath()
  if (cache !== undefined && (await deferStarted(cache))) run([`${root}/hooks/session-warmup.sh`, '--deferred'], JSON.stringify({ source, session_id: sessionId }))
}
