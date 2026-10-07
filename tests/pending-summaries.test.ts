// /process-pending-summaries (hooks/register.ts, hooks/mods/pending-summaries.ts):
// the drain and the one-session run, answered with no model turn by
// scripts/process-pending-summaries.sh. hooks/test-process-pending-summaries.sh
// covers what the script dispatches.

import { describe, expect, test } from 'claude-code/testing'

import { REFUSAL, USAGE, outcomeOf, requestOf } from '../hooks/mods/pending-summaries'
import type { Bench } from './bench'
import { bench, run, start } from './bench'

const SCRIPT = 'process-pending-summaries.sh'
const SID = 'd640e864-4bed-4e3c-8b35-85d9e4c79588'

// The script's argument lists, in order, as the module ran them.
const scriptRuns = (b: Bench) => b.runs.filter(argv => argv[0] === 'bash' && argv[1]?.endsWith(`/scripts/${SCRIPT}`)).map(argv => argv.slice(2))

describe('AC7: pending summaries run from a command, with no model turn', () => {
  test('the drain reports dispatched, live remaining, dead and total, and gives the model nothing', async ($, on) => {
    const b = bench(on)
    b.scripts[SCRIPT] = () => 'DISPATCH sid=x\nresult=drained dispatched=10 live=322 dead=775 total=1107\n'
    await $.session.start(start())
    const result = await $.command.run(run('process-pending-summaries'))
    expect(result.text).toBeUndefined()
    expect(result.context).toBeUndefined()
    expect(scriptRuns(b)).toEqual([[]])
    expect(b.toasts).toEqual([
      'Dispatched 10 background summary-writers. 322 live markers remaining, 775 unprocessable (log and transcript both gone), 1107 total. Run /process-pending-summaries again to continue.',
    ])
  })

  test('a drain that empties the live backlog does not ask for another run', async ($, on) => {
    const b = bench(on)
    b.scripts[SCRIPT] = () => 'result=drained dispatched=3 live=0 dead=2 total=5\n'
    await $.session.start(start())
    await $.command.run(run('process-pending-summaries'))
    expect(b.toasts[0]).not.toContain('again')
  })

  test('nothing pending says so', async ($, on) => {
    const b = bench(on)
    b.scripts[SCRIPT] = () => 'result=none\n'
    await $.session.start(start())
    await $.command.run(run('process-pending-summaries'))
    expect(b.toasts).toEqual(['No pending session summaries.'])
  })

  test('one session by id dispatches one writer', async ($, on) => {
    const b = bench(on)
    b.scripts[SCRIPT] = () => 'result=dispatched\n'
    await $.session.start(start())
    await $.command.run(run('process-pending-summaries', ` ${SID} `))
    expect(scriptRuns(b)).toEqual([[SID]])
    expect(b.toasts).toEqual([`A summary-writer is running for session ${SID}.`])
  })

  test('a summary that exists is replaced only after Mike picks Overwrite', async ($, on) => {
    const b = bench(on)
    b.scripts[SCRIPT] = argv => (argv.includes('--overwrite') ? 'result=dispatched\n' : 'result=exists summary=/v/sessions/x.summary.md\n')
    b.pick = 'Overwrite'
    await $.session.start(start())
    await $.command.run(run('process-pending-summaries', SID))
    expect(scriptRuns(b)).toEqual([[SID], [SID, '--overwrite']])
    const dialog = b.inputs.find(input => input.tool === 'AskUserQuestion') as { questions: { question: string; options: { label: string }[] }[] }
    expect(dialog.questions[0]?.question).toBe(`A summary for session ${SID} already exists. Overwrite it?`)
    expect(dialog.questions[0]?.options.map(option => option.label)).toEqual(['Skip', 'Overwrite'])
    expect(b.toasts).toEqual([`A summary-writer is running for session ${SID}.`])
  })

  test('Skip, or a dismissed dialog, keeps the summary and dispatches nothing', async ($, on) => {
    const b = bench(on)
    b.scripts[SCRIPT] = () => 'result=exists summary=/v/sessions/x.summary.md\n'
    await $.session.start(start())
    for (const pick of ['Skip', undefined, 'overwrite please']) {
      b.pick = pick
      await $.command.run(run('process-pending-summaries', SID))
    }
    expect(scriptRuns(b)).toEqual([[SID], [SID], [SID]])
    expect(b.toasts).toEqual(Array(3).fill(`Kept the existing summary for session ${SID}.`))
  })

  test('--overwrite given up front asks nothing', async ($, on) => {
    const b = bench(on)
    b.scripts[SCRIPT] = () => 'result=dispatched\n'
    await $.session.start(start())
    await $.command.run(run('process-pending-summaries', `${SID} --overwrite`))
    expect(scriptRuns(b)).toEqual([[SID, '--overwrite']])
    expect(b.inputs.some(input => input.tool === 'AskUserQuestion')).toBe(false)
  })

  test('each outcome the script names is reported', async ($, on) => {
    const cases: [string, string][] = [
      ['result=invalid-id', 'A session id holds only letters, digits and -.'],
      ['result=unrecoverable', `Session ${SID} has no log and no transcript left, so it cannot be summarized.`],
      ['result=unavailable reason=claude', 'Summaries cannot be dispatched: claude is not available.'],
      ['result=failed', 'The summary dispatch failed. See summary-dispatch-errors.log in the memory cache.'],
      ['', 'The summary dispatch failed. See summary-dispatch-errors.log in the memory cache.'],
    ]
    const b = bench(on)
    let stdout = ''
    b.scripts[SCRIPT] = () => stdout
    await $.session.start(start())
    for (const [printed] of cases) {
      stdout = printed
      await $.command.run(run('process-pending-summaries', SID))
    }
    expect(b.toasts).toEqual(cases.map(([, toast]) => toast))
  })

  test('a script that cannot run is reported as a failed dispatch', async ($, on) => {
    const b = bench(on)
    b.scripts[SCRIPT] = () => {
      throw new Error('no bash')
    }
    await $.session.start(start())
    await $.command.run(run('process-pending-summaries'))
    expect(b.toasts[0]).toContain('failed')
  })

  test('arguments it does not take show the usage and run nothing', async ($, on) => {
    const b = bench(on)
    b.scripts[SCRIPT] = () => 'result=none\n'
    await $.session.start(start())
    for (const args of ['a b', '--overwrite']) await $.command.run(run('process-pending-summaries', args))
    expect(scriptRuns(b)).toEqual([])
    expect(b.toasts).toEqual([USAGE, USAGE])
  })

  test('only Mike runs it: a plugin, a schedule or an agent dispatches nothing', async ($, on) => {
    const b = bench(on)
    b.scripts[SCRIPT] = () => 'result=none\n'
    await $.session.start(start())
    for (const origin of [{ kind: 'plugin', name: 'x' }, { kind: 'scheduled-trigger' }, { kind: 'sdk' }, { kind: 'peer' }]) {
      const result = await $.command.run(run('process-pending-summaries', '', origin as never))
      expect(result.text).toBe(REFUSAL)
    }
    expect(scriptRuns(b)).toEqual([])
  })

  test('the readers', () => {
    expect(requestOf('')).toEqual({ sid: undefined, overwrite: false })
    expect(requestOf(`--overwrite ${SID}`)).toEqual({ sid: SID, overwrite: true })
    expect(requestOf('a b')).toBeUndefined()
    expect(outcomeOf('noise\nresult=exists summary=/a b.md\n')).toEqual({ result: 'exists', summary: '/a' })
  })
})
