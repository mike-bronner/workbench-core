// Orchestrator mode (hooks/register.ts, hooks/mods/orchestrator.ts): /orchestrator
// keeps the mode in $.state and $.store, mirrors it into the legacy file the
// bash gates read, and runs only for a person.

import { describe, expect, test } from 'claude-code/testing'

import { KEEP_DAYS, REFUSAL, STORE_KEY, USAGE, legacyFileOf, offSessionsOf, reportOf, toggleOf, withMode } from '../hooks/mods/orchestrator'
import { DAY, HOME, LEGACY, SID, STATE_DIR, bench, lastLine, run, start } from './bench'

// The line is drawn from the mode in $.state, so `orch on` and `orch off` read
// the state. tests/workbench.test.ts reads it through orchestratorIsOn().
describe('AC4: the toggle lives in $.state and $.store, and the legacy file follows it', () => {
  test('a new session is on, with no file and nothing stored', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    expect(b.store.get(STORE_KEY)).toBeUndefined()
    expect(b.files.has(LEGACY)).toBe(false)
    expect(lastLine(b)).toBe('orch on')
  })

  test('/orchestrator off sets the state, stores the session, and writes the file the gates read', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    const result = await $.command.run(run('orchestrator', 'off'))
    expect(Object.keys(b.store.get(STORE_KEY) as object)).toEqual([SID])
    expect(b.files.has(LEGACY)).toBe(true)
    expect(lastLine(b)).toBe('orch off')
    expect(b.toasts).toEqual([reportOf(false)])
    expect(result).toEqual({})
  })

  test('/orchestrator on undoes all three', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    await $.command.run(run('orchestrator', 'off'))
    await $.command.run(run('orchestrator', 'on'))
    expect(b.store.get(STORE_KEY)).toEqual({})
    expect(b.files.has(LEGACY)).toBe(false)
    expect(b.runs).toContainEqual(['rm', '-rf', '--', LEGACY])
    expect(lastLine(b)).toBe('orch on')
  })

  test('the legacy directory follows WORKBENCH_ORCHESTRATOR_STATE_DIR, as the gates do', async ($, on) => {
    const b = bench(on, { env: { HOME, WORKBENCH_ORCHESTRATOR_STATE_DIR: '/state/' } })
    await $.session.start(start())
    await $.command.run(run('orchestrator', 'off'))
    expect([...b.files.keys()]).toEqual([`/state/${SID}`])
  })

  test('/orchestrator with no argument, or status, reports and changes nothing', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    await $.command.run(run('orchestrator'))
    await $.command.run(run('orchestrator', ' STATUS '))
    expect(b.toasts).toEqual([reportOf(true), reportOf(true)])
    expect(b.files.size).toBe(0)
  })

  test('an unknown argument shows the usage and changes nothing', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    await $.command.run(run('orchestrator', 'of'))
    expect(b.toasts).toEqual([USAGE])
    expect(b.files.size).toBe(0)
  })

  test('a session switched off is still off after a restart, from the store', async ($, on) => {
    const b = bench(on, { store: { [STORE_KEY]: { [SID]: 99 * DAY } } })
    await $.session.start(start())
    expect(lastLine(b)).toBe('orch off')
  })

  test('a legacy file already there at session start is honoured', async ($, on) => {
    const b = bench(on, { files: { [LEGACY]: '' } })
    await $.session.start(start())
    expect(lastLine(b)).toBe('orch off')
    expect(b.files.has(LEGACY)).toBe(true)
  })

  test('a stored mode older than the keep window is dropped', () => {
    const now = 100 * DAY
    expect(offSessionsOf({ a: now - DAY, b: now - KEEP_DAYS * DAY, c: 'x', '../d': now }, now)).toEqual({ a: now - DAY })
    expect(offSessionsOf(null, now)).toEqual({})
    expect(withMode({ a: 1 }, 'b', false, 5)).toEqual({ a: 1, b: 5 })
    expect(withMode({ a: 1, b: 2 }, 'b', true, 5)).toEqual({ a: 1 })
  })

  test('the legacy path is the gates\' path, and an id that could escape names none', () => {
    expect(legacyFileOf(SID, undefined, HOME)).toBe(LEGACY)
    expect(legacyFileOf(SID, '', HOME)).toBe(`${STATE_DIR}/${SID}`)
    expect(legacyFileOf('../x', undefined, HOME)).toBeUndefined()
    expect(legacyFileOf('..', undefined, HOME)).toBeUndefined()
    expect(legacyFileOf('.hidden', undefined, HOME)).toBeUndefined()
    expect(legacyFileOf('a.b_c-1', undefined, HOME)).toBe(`${STATE_DIR}/a.b_c-1`)
    expect(legacyFileOf('', undefined, HOME)).toBeUndefined()
    expect(legacyFileOf(SID, undefined, undefined)).toBeUndefined()
  })

  test('the argument is read case-blind, with status as the default', () => {
    expect(toggleOf('')).toBe('status')
    expect(toggleOf(' Off ')).toBe('off')
    expect(toggleOf('ON')).toBe('on')
    expect(toggleOf('disable')).toBeUndefined()
  })
})

describe('AC4: the model cannot switch it off', () => {
  for (const origin of [{ kind: 'plugin', name: 'x' }, { kind: 'sdk' }, { kind: 'peer' }, { kind: 'scheduled-trigger' }, { kind: 'task-notification' }] as const) {
    test(`a run from ${origin.kind} is refused and changes nothing`, async ($, on) => {
      const b = bench(on)
      await $.session.start(start())
      const result = await $.command.run(run('orchestrator', 'off', origin as never))
      expect(result.text).toBe(REFUSAL)
      expect(b.files.has(LEGACY)).toBe(false)
      expect(lastLine(b)).toBe('orch on')
    })
  }

  test('the Remote Control bridge is a person', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    await $.command.run(run('orchestrator', 'off', { kind: 'bridge' }))
    expect(b.files.has(LEGACY)).toBe(true)
  })

  for (const tool of ['Write', 'NotebookEdit', 'Agent'] as const) {
    test(`a legacy file the model wrote is gone before a main-loop ${tool} reaches the gates`, async ($, on) => {
      const b = bench(on)
      await $.session.start(start())
      b.files.set(LEGACY, '')
      await $.tool.call({ tool, file_path: '/x', content: '', notebook_path: '/x.ipynb', new_source: '', description: 'd', prompt: 'p' } as never)
      expect(b.calls).toEqual([{ tool, legacyExists: false }])
    })
  }

  test('a file Mike\'s off wrote and something removed is put back before the gates read it', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    await $.command.run(run('orchestrator', 'off'))
    b.files.delete(LEGACY)
    await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p' } as never)
    expect(b.calls).toEqual([{ tool: 'Agent', legacyExists: true }])
  })

  test('a mode that cannot be read is taken as on, and the hook still mirrors before the gates', async ($, on) => {
    const b = bench(on, { storeFails: true })
    await $.session.start(start())
    b.files.set(LEGACY, '')
    await $.tool.call({ tool: 'Write', file_path: '/x', content: '' } as never)
    expect(b.calls).toEqual([{ tool: 'Write', legacyExists: false }])
  })

  test('a symbolic link planted as the file is removed, and the write never follows it', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    b.links.add(LEGACY)
    await $.command.run(run('orchestrator', 'off'))
    expect(b.links.has(LEGACY)).toBe(false)
    expect(b.wroteThrough).toEqual([])
    expect(b.files.has(LEGACY)).toBe(true)
    expect(b.runs).toContainEqual(['rm', '-rf', '--', LEGACY])
  })

  test('a symbolic link there at session start is not honoured as off', async ($, on) => {
    const b = bench(on, { files: { [LEGACY]: '' } })
    b.links.add(LEGACY)
    await $.session.start(start())
    expect(lastLine(b)).toBe('orch on')
  })

  test('a directory planted at the path is not off, and is gone before the gates read', async ($, on) => {
    const b = bench(on)
    b.dirs.add(LEGACY)
    await $.session.start(start())
    expect(lastLine(b)).toBe('orch on')
    await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p' } as never)
    expect(b.dirs.has(LEGACY)).toBe(false)
    expect(b.runs).toContainEqual(['rm', '-rf', '--', LEGACY])
    expect(b.calls).toEqual([{ tool: 'Agent', legacyExists: false }])
  })

  test('/orchestrator off replaces a planted directory with the regular file the gates read', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    b.dirs.add(LEGACY)
    await $.command.run(run('orchestrator', 'off'))
    expect(b.dirs.has(LEGACY)).toBe(false)
    expect(b.files.has(LEGACY)).toBe(true)
  })

  test('a link planted between the removal and the write is never written through', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    b.dirs.add(LEGACY)
    b.afterRm = () => b.links.add(LEGACY)
    await $.command.run(run('orchestrator', 'off'))
    expect(b.files.has(LEGACY)).toBe(false)
    expect(b.wroteThrough).toEqual([])
    await $.tool.call({ tool: 'Write', file_path: '/x', content: '' } as never)
    expect(b.calls).toEqual([{ tool: 'Write', legacyExists: false }])
  })

  test('a sub-agent\'s call and an ungated tool leave the file alone', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    b.files.set(LEGACY, '')
    await $.tool.call({ tool: 'Write', file_path: '/x', content: '', agentId: 'a1' } as never)
    await $.tool.call({ tool: 'Bash', command: 'true' } as never)
    expect(b.calls).toEqual([
      { tool: 'Write', legacyExists: true },
      { tool: 'Bash', legacyExists: true },
    ])
  })
})
