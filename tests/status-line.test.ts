// The status line beside the request meter, and the commands that answer with
// no model turn (hooks/register.ts, hooks/mods/status-line.ts).

import { describe, expect, test } from 'claude-code/testing'

import { REPROMPT_REASON } from '../hooks/mods/question-rule'
import { COMPACT_AT, ROW_BUDGET, factsOf, learningsAfter, lineOf, noticesOf, rowsOf, skillNameOf } from '../hooks/mods/status-line'
import { DAY, NOTICES, START, bench, lastLine, paneShows, run, start, turn } from './bench'

const NOTICE_FILE = '# Warmup notices\n\n_Written by session-warmup.sh at startup session start._\n\n## ⚠ Pending session summaries (3)\n\ntext\n\n## ⚠ Output style out of date\n\nmore\n'
const SETTLE = 3000

describe('AC5: memory-status and the toggle run as commands, with no model turn', () => {
  test('the three commands are registered at session start', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    expect(b.registered).toEqual(['orchestrator', 'memory-status', 'notices'])
  })

  test('/memory-status runs the script and shows its output in a pane, and returns nothing for the model', async ($, on) => {
    const b = bench(on)
    b.scripts['memory-status.sh'] = () => 'health           : UP (serving, index built)\n'
    await $.session.start(start())
    const result = await $.command.run(run('memory-status'))
    expect(result.text).toBeUndefined()
    expect(result.context).toBeUndefined()
    expect(b.runs.some(argv => argv[0] === 'bash' && argv[1]?.endsWith('/scripts/memory-status.sh'))).toBe(true)
    expect(b.opened).toEqual([{ id: 'workbench-core', title: 'Memory status' }])
    for (const surface of ['terminal', 'desktop'] as const) {
      expect(await paneShows($, surface, 'health           : UP')).toBe(true)
    }
  })

  test('/orchestrator off returns nothing for the model', async ($, on) => {
    bench(on)
    await $.session.start(start())
    const result = await $.command.run(run('orchestrator', 'off'))
    expect(result.text).toBeUndefined()
    expect(result.context).toBeUndefined()
  })

  test('a command of another plugin passes through untouched', async ($, on) => {
    bench(on)
    on('command.run', { command: 'other' }, () => ({ text: 'theirs' }))
    await $.session.start(start())
    expect((await $.command.run(run('other'))).text).toBe('theirs')
  })
})

describe('AC6: the status line carries the workbench facts beside the meter', () => {
  test('memory health appears once the first probe answers, and follows each probe', async ($, on) => {
    const b = bench(on)
    let health = 'UP'
    b.scripts['memory-health.sh'] = () => `${health}\n`
    await $.session.start(start())
    expect(lastLine(b)).toBe('orch on')
    await b.clock.advance(SETTLE)
    expect(lastLine(b)).toBe('mem UP · orch on')
    health = 'DOWN_NONE'
    await b.clock.advance(60_000)
    expect(lastLine(b)).toBe('mem DOWN_NONE · orch on')
  })

  test('a probe that prints no status word leaves the entry out', async ($, on) => {
    const b = bench(on)
    b.scripts['memory-health.sh'] = () => 'bash: something broke\n'
    await $.session.start(start())
    await b.clock.advance(SETTLE)
    expect(lastLine(b)).toBe('orch on')
  })

  test('an unattended session probes nothing and shows no notices', async ($, on) => {
    const b = bench(on, { files: { [NOTICES]: NOTICE_FILE } })
    b.scripts['memory-health.sh'] = () => 'UP\n'
    await $.session.start(start(false))
    await b.clock.advance(SETTLE + 60_000)
    expect(b.runs).toEqual([])
    expect(b.toasts).toEqual([])
  })

  test('the reply rows follow each main-loop answer, against the budget', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    await $.turn.complete(turn(Array.from({ length: 45 }, () => 'a line').join('\n')))
    expect(lastLine(b)).toBe(`T1 │ orch on · rows 45/${ROW_BUDGET}`)
    await $.turn.complete(turn('short', 'sub-agent'))
    expect(lastLine(b)).toBe(`T1 │ orch on · rows 45/${ROW_BUDGET}`)
  })

  test('the row meter never re-prompts: a long reply with no question stops', async ($, on) => {
    bench(on)
    on('classic.Stop', () => ({}))
    on('model.classify', () => ({ value: 'asks-the-user-nothing-or-only-rhetorically' }))
    await $.session.start(start())
    await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })
    const long = Array.from({ length: 90 }, () => 'a line of the reply').join('\n')
    await $.turn.complete(turn(long))
    const result = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: long })
    expect(result.block).not.toBe(REPROMPT_REASON)
    expect(result.block).toBeUndefined()
  })

  test('a /clear resets the rows with the meter', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    await $.turn.complete(turn('one'))
    await $.session.end({ reason: 'clear', sessionId: 's', resume: {} as never })
    expect(lastLine(b)).toBe('orch on')
  })

  test('a skill whose learnings are past the limit goes on the line, and comes off once compacted', async ($, on) => {
    const b = bench(on)
    let count = '34'
    b.scripts['learnings-count.sh'] = () => `${count}\n`
    await $.session.start(start())
    await $.tool.call({ tool: 'Skill', skill: 'workbench-core:memory-lint' })
    expect(lastLine(b)).toBe('orch on · learnings memory-lint 34')
    expect(b.runs).toContainEqual(['bash', expect.stringMatching(/\/scripts\/learnings-count\.sh$/) as never, 'memory-lint'])
    count = '12'
    await $.tool.call({ tool: 'Skill', skill: 'memory-lint' })
    expect(lastLine(b)).toBe('orch on')
  })

  test('a skill at the limit, or with no learnings file, stays off the line', async ($, on) => {
    const b = bench(on)
    let count = String(COMPACT_AT)
    b.scripts['learnings-count.sh'] = () => count
    await $.session.start(start())
    await $.tool.call({ tool: 'Skill', skill: 'a' })
    count = ''
    await $.tool.call({ tool: 'Skill', skill: 'b' })
    expect(lastLine(b)).toBe('orch on')
  })

  test('a skill name that could leave the skills folder runs no count', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    await $.tool.call({ tool: 'Skill', skill: '../secret' })
    await $.tool.call({ tool: 'Skill', skill: 'x:.hidden' })
    expect(b.runs).toEqual([])
  })

  test('the facts read in a fixed order, and nothing unknown shows', () => {
    expect(factsOf({})).toEqual([])
    expect(factsOf({ memoryHealth: 'UP', orchestratorOn: false, replyRows: 3, learnings: { b: 40, a: 31 }, notices: ['x'] })).toEqual([
      'mem UP',
      'orch off',
      `rows 3/${ROW_BUDGET}`,
      'learnings a 31, b 40',
      '1 notice',
    ])
    expect(lineOf(undefined, [])).toBeUndefined()
    expect(lineOf('T1', [])).toBe('T1')
    expect(lineOf('T1', ['orch on'])).toBe('T1 │ orch on')
  })

  test('rows count wrapped lines at 80 columns', () => {
    expect(rowsOf('')).toBe(0)
    expect(rowsOf('a')).toBe(1)
    expect(rowsOf('a\n\nb')).toBe(3)
    expect(rowsOf('x'.repeat(80))).toBe(1)
    expect(rowsOf('x'.repeat(81))).toBe(2)
  })

  test('the learnings set keeps other skills, and drops one at or under the limit', () => {
    expect(learningsAfter({ a: 40 }, 'b', 31)).toEqual({ a: 40, b: 31 })
    expect(learningsAfter({ a: 40, b: 31 }, 'b', 30)).toEqual({ a: 40 })
    expect(learningsAfter({ a: 40 }, 'a', undefined)).toEqual({})
    expect(skillNameOf('workbench-core:memory-lint')).toBe('memory-lint')
    expect(skillNameOf('.x')).toBeUndefined()
    expect(skillNameOf('a/b')).toBeUndefined()
  })
})

describe('AC7: the warmup notices reach Mike without the model', () => {
  test('each notice is named in a toast and counted on the line, once the warmup has written them', async ($, on) => {
    const b = bench(on, { files: { [NOTICES]: NOTICE_FILE } })
    b.scripts['memory-health.sh'] = () => 'UP\n'
    await $.session.start(start())
    expect(b.toasts).toEqual([])
    await b.clock.advance(SETTLE)
    expect(b.toasts).toEqual(['Warmup notices: ⚠ Pending session summaries (3); ⚠ Output style out of date. Run /notices to read them.'])
    expect(lastLine(b)).toBe('mem UP · orch on · 2 notices')
  })

  test('a file older than the session is the last session\'s: it waits for the rewrite, which the 20 s read shows', async ($, on) => {
    const b = bench(on, { files: { [NOTICES]: '# Warmup notices\n\n## Old notice\n' }, mtime: START - DAY })
    b.scripts['memory-health.sh'] = () => 'UP\n'
    await $.session.start(start())
    await b.clock.advance(SETTLE)
    expect(b.toasts).toEqual([])
    expect(lastLine(b)).toBe('mem UP · orch on')
    b.files.set(NOTICES, '# Warmup notices\n\n## ⚠ Memory server failed to start\n')
    b.mtimes.set(NOTICES, b.clock.now())
    await b.clock.advance(20_000 - SETTLE)
    expect(b.toasts).toEqual(['Warmup notices: ⚠ Memory server failed to start. Run /notices to read them.'])
    expect(lastLine(b)).toBe('mem UP · orch on · 1 notice')
  })

  test('a file rewritten later is read again on the next probe, and an unchanged one is not', async ($, on) => {
    const b = bench(on, { files: { [NOTICES]: NOTICE_FILE } })
    b.scripts['memory-health.sh'] = () => 'UP\n'
    await $.session.start(start())
    await b.clock.advance(60_000)
    expect(b.toasts.length).toBe(1)
    b.files.set(NOTICES, '# Warmup notices\n\nNo outstanding notices.\n')
    b.mtimes.set(NOTICES, b.clock.now())
    await b.clock.advance(60_000)
    expect(b.toasts.length).toBe(1)
    expect(lastLine(b)).toBe('mem UP · orch on')
    await b.clock.advance(60_000)
    expect(b.toasts.length).toBe(1)
  })

  test('a rewrite long after this session started is another session\'s, and raises nothing here', async ($, on) => {
    const b = bench(on, { files: { [NOTICES]: NOTICE_FILE } })
    b.scripts['memory-health.sh'] = () => 'UP\n'
    await $.session.start(start())
    await b.clock.advance(SETTLE)
    expect(b.toasts.length).toBe(1)
    await b.clock.advance(5 * 60_000)
    b.files.set(NOTICES, '# Warmup notices\n\n## Another session\'s notice\n')
    b.mtimes.set(NOTICES, b.clock.now())
    await b.clock.advance(60_000)
    expect(b.toasts.length).toBe(1)
    expect(lastLine(b)).toBe('mem UP · orch on · 2 notices')
  })

  test('no notices, no toast and no count', async ($, on) => {
    const b = bench(on, { files: { [NOTICES]: '# Warmup notices\n\nNo outstanding notices.\n' } })
    b.scripts['memory-health.sh'] = () => 'UP\n'
    await $.session.start(start())
    await b.clock.advance(SETTLE)
    expect(b.toasts).toEqual([])
    expect(lastLine(b)).toBe('mem UP · orch on')
  })

  test('/notices shows the whole file in the pane', async ($, on) => {
    const b = bench(on, { files: { [NOTICES]: NOTICE_FILE } })
    await $.session.start(start())
    const result = await $.command.run(run('notices'))
    expect(result.text).toBeUndefined()
    expect(b.opened).toEqual([{ id: 'workbench-core', title: 'Warmup notices' }])
    for (const surface of ['terminal', 'desktop'] as const) {
      expect(await paneShows($, surface, 'Output style out of date')).toBe(true)
    }
  })

  test('/notices with no file says so', async ($, on) => {
    bench(on)
    await $.session.start(start())
    await $.command.run(run('notices'))
    expect(await paneShows($, 'terminal', 'No warmup notices file yet.')).toBe(true)
    expect(await paneShows($, 'terminal', 'Pending session summaries')).toBe(false)
  })

  test('a notice is a level-two heading', () => {
    expect(noticesOf(NOTICE_FILE)).toEqual(['⚠ Pending session summaries (3)', '⚠ Output style out of date'])
    expect(noticesOf('# Warmup notices\n\n### not one\n##not one\n')).toEqual([])
  })
})
