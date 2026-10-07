// The warmup's deferred half (hooks/register.ts, hooks/session-warmup.sh):
// the SessionStart hook runs `session-warmup.sh --defer`, which leaves out the
// pending-summary drain and the Chat-skill scan, and the module runs
// `session-warmup.sh --deferred` for those two once SessionStart is done.
// hooks/test-session-warmup-deferred.sh covers what each part of the script
// does.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { start } from './harness'

const HOME = '/Users/tester'
const SID = '0f3c2a1e-5b7d-4c9e-8a6f-1d2e3f4a5b6c'
const NOTICES = `${HOME}/.claude-workbench/warmup-notices.md`
const START = 1_000_000
const CHAT_NOTICE = '# Warmup notices\n\n## 📦 New Chat-installable skills\n\ntext\n'

type Run = { argv: readonly string[]; stdin?: string }

type Engine = {
  // What happened, in order: `settings` when the SessionStart settings hooks
  // beneath ran, and the script name of each process the module ran.
  order: string[]
  runs: Run[]
  toasts: string[]
  files: Map<string, string>
  // Makes the deferred run fail, as a script that cannot start.
  deferredFails: boolean
  clock: MockClock
}

function engine(on: On): Engine {
  const g: Engine = { order: [], runs: [], toasts: [], files: new Map(), deferredFails: false, clock: mock.clock(on, { now: START }) }
  mock.env(on, { HOME })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SID }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', ($, e) => ({ value: g.files.has(e.path) }))
  on('fs.read', ($, e) => ({ value: g.files.get(e.path) ?? '' }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 0, mtimeMs: g.clock.now(), isLink: false } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    g.toasts.push(e.text)
    return { value: undefined }
  })
  on('classic.SessionStart', () => {
    g.order.push('settings')
    return { additionalContext: ['the rules'] }
  })
  on('process.run', ($, e) => {
    const name = (e.argv[1] ?? '').split('/').pop() ?? ''
    g.order.push(name)
    g.runs.push({ argv: e.argv, stdin: e.init?.stdin })
    if (e.argv.includes('--deferred')) {
      if (g.deferredFails) throw new Error('spawn failed')
      // The deferred run adds the Chat-skill notice to the notices file.
      g.files.set(NOTICES, CHAT_NOTICE)
    }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return g
}

const sessionStart = (source: 'startup' | 'resume' | 'clear' | 'compact') => ({
  hook_event_name: 'SessionStart' as const,
  source,
  session_id: SID,
  transcript_path: '/t.jsonl',
  cwd: '/repo',
})

const deferredRuns = (g: Engine): Run[] => g.runs.filter(run => run.argv.includes('--deferred'))

describe('AC6: the drain and the Chat-skill scan run after session start, not in it', () => {
  test('the deferred run starts once the SessionStart hooks are done, not while they run', async ($, on) => {
    const g = engine(on)
    await $.session.start(start(true))
    const result = await $.classic.SessionStart(sessionStart('startup'))
    // The start is not held up: the hooks answered, and nothing ran yet.
    expect(result.additionalContext).toEqual(['the rules'])
    expect(deferredRuns(g)).toEqual([])
    await g.clock.advance(0)
    expect(deferredRuns(g)).toHaveLength(1)
    expect(g.order.slice(0, 2)).toEqual(['settings', 'session-warmup.sh'])
  })

  test('it runs the warmup script with --deferred, and hands it the source and the session', async ($, on) => {
    const g = engine(on)
    await $.session.start(start(true))
    await $.classic.SessionStart(sessionStart('startup'))
    await g.clock.advance(0)
    const [run] = deferredRuns(g)
    expect(run?.argv[0]).toBe('bash')
    expect(run?.argv[1]).toMatch(/\/hooks\/session-warmup\.sh$/)
    expect(run?.argv.slice(2)).toEqual(['--deferred'])
    expect(JSON.parse(run?.stdin ?? 'null')).toEqual({ source: 'startup', session_id: SID })
  })

  test('a resumed session drains too', async ($, on) => {
    const g = engine(on)
    await $.session.start(start(true))
    await $.classic.SessionStart(sessionStart('resume'))
    await g.clock.advance(0)
    expect(JSON.parse(deferredRuns(g)[0]?.stdin ?? 'null')).toEqual({ source: 'resume', session_id: SID })
  })

  test('a clear or a compaction starts no deferred run, as the warmup never drained there', async ($, on) => {
    const g = engine(on)
    await $.session.start(start(true))
    await $.classic.SessionStart(sessionStart('clear'))
    await $.classic.SessionStart(sessionStart('compact'))
    await g.clock.advance(10_000)
    expect(deferredRuns(g)).toEqual([])
  })

  test('an unattended session drains as well, and nobody is shown a notice', async ($, on) => {
    const g = engine(on)
    await $.session.start(start(false))
    await $.classic.SessionStart(sessionStart('startup'))
    await g.clock.advance(0)
    expect(deferredRuns(g)).toHaveLength(1)
    expect(g.toasts).toEqual([])
  })

  test("a person's session reads the notices again once the deferred run is done", async ($, on) => {
    const g = engine(on)
    await $.session.start(start(true))
    await $.classic.SessionStart(sessionStart('startup'))
    // Before the first probe, which comes 3 s after the start.
    await g.clock.advance(0)
    expect(g.toasts).toEqual(['Warmup notices: 📦 New Chat-installable skills. Run /notices to read them.'])
  })

  test('a deferred run that fails changes nothing the session start returned, and shows nothing', async ($, on) => {
    const g = engine(on)
    g.deferredFails = true
    await $.session.start(start(true))
    const result = await $.classic.SessionStart(sessionStart('startup'))
    await g.clock.advance(0)
    expect(result.additionalContext).toEqual(['the rules'])
    expect(deferredRuns(g)).toHaveLength(1)
    expect(g.toasts).toEqual([])
  })
})
