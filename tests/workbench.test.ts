// The $.workbench noun (hooks/register.ts, hooks/mods/brief.ts): what
// workbench-dev-team builds on. Each test calls it from a second plugin, the
// way a dependent does, so a noun that only works from inside core fails here.

import { describe, expect, test } from 'claude-code/testing'
import type { On, PromptOrigin } from 'claude-code'

import { BRIEF_SLOTS, checkBrief } from '../hooks/mods/brief'
import { GATE_CASES, GATE_SLOTS } from './brief-cases'
import { HOME, LEGACY, SID, bench, caller, run, start } from './bench'

// The stand-in dependent asks the question the prompt names, and writes the
// answer to /answers/<question>, where the test reads it.
const DEPENDENT = caller((on: On) => {
  on('prompt.submit', async ($, e, next) => {
    const question = e.text
    // A rejection is written as { rejected: <message> }.
    const settle = (p: Promise<unknown>) => p.catch((error: unknown) => ({ rejected: String(error).replace(/^\w*Error: /, '') }))
    if (question.endsWith('unattended')) {
      await $.fs.write('/answers/unattended', JSON.stringify(await settle($.workbench.isUnattended())))
    } else if (question.startsWith('lane:')) {
      const agentId = question.slice('lane:'.length)
      const args = agentId === '#number' ? ({ agentId: 7 } as never) : agentId ? { agentId } : {}
      await $.fs.write('/answers/lane', JSON.stringify(await settle($.workbench.callerLane(args))))
    } else {
      const answer =
        question === 'slots'
          ? await $.workbench.briefSlots()
          : question === 'roots'
            ? await $.workbench.scratchRoots()
            : question === 'isOn'
              ? await $.workbench.orchestratorIsOn()
              : await $.workbench.briefCheck(question)
      await $.fs.write(`/answers/${question === 'slots' || question === 'roots' || question === 'isOn' ? question : 'check'}`, JSON.stringify(answer))
    }
    return next(e)
  })
})

const ask = (text: string, origin: PromptOrigin = { kind: 'composer' }) => ({ text, wait: false, origin })
const answer = (files: Map<string, string>, question: string): unknown => JSON.parse(files.get(`/answers/${question}`) ?? 'null')

describe('AC2: $.workbench is registered and answers a dependent plugin', () => {
  test('briefSlots answers the six slots in template order', { plugins: [DEPENDENT] }, async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    await $.prompt.submit(ask('slots'))
    expect(answer(b.files, 'slots')).toEqual(GATE_SLOTS)
    expect((answer(b.files, 'slots') as { header: string }[]).map(slot => slot.header)).toEqual([
      'Workdir:',
      'Goal:',
      'Context:',
      'Constraints:',
      'Acceptance:',
      'Done when:',
    ])
  })

  test('briefCheck answers the verdict and the missing slots', { plugins: [DEPENDENT] }, async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    await $.prompt.submit(ask('Workdir: /x\nGoal: g\nContext: c\nConstraints: none\nAcceptance: a'))
    expect(answer(b.files, 'check')).toEqual({ isComplete: false, missing: ['Done when:'], shape: 'brief' })
    await $.prompt.submit(ask('Item ID: 12'))
    expect(answer(b.files, 'check')).toEqual({ isComplete: true, missing: [], shape: 'item-id' })
  })

  test('scratchRoots answers the resolver\'s absolute lines for this session', { plugins: [DEPENDENT] }, async ($, on) => {
    const b = bench(on)
    b.scripts['scratch-roots.sh'] = argv => (argv[2] === SID ? `/private/tmp/claude-1/p/${SID}/scratchpad\n${HOME}/Developer/scratchpad\nnoise\n` : '')
    await $.session.start(start())
    await $.prompt.submit(ask('roots'))
    expect(answer(b.files, 'roots')).toEqual([`/private/tmp/claude-1/p/${SID}/scratchpad`, `${HOME}/Developer/scratchpad`])
    expect(b.runs.some(argv => argv[1]?.endsWith('/hooks/lib/scratch-roots.sh') && argv[2] === SID)).toBe(true)
  })

  test('scratchRoots answers no root when the resolver cannot run', { plugins: [DEPENDENT] }, async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    await $.prompt.submit(ask('roots'))
    expect(answer(b.files, 'roots')).toEqual([])
  })

  test('orchestratorIsOn is true by default, and false once Mike runs /orchestrator off', { plugins: [DEPENDENT] }, async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    await $.prompt.submit(ask('isOn'))
    expect(answer(b.files, 'isOn')).toBe(true)
    await $.command.run(run('orchestrator', 'off'))
    await $.prompt.submit(ask('isOn'))
    expect(answer(b.files, 'isOn')).toBe(false)
  })

  test('orchestratorIsOn is false under WORKBENCH_ORCHESTRATOR=0, as the gates stand down', { plugins: [DEPENDENT] }, async ($, on) => {
    const b = bench(on, { env: { HOME, WORKBENCH_ORCHESTRATOR: '0' } })
    await $.session.start(start())
    await $.prompt.submit(ask('isOn'))
    expect(answer(b.files, 'isOn')).toBe(false)
  })

  test('orchestratorIsOn is false when the session id cannot name the toggle file', { plugins: [DEPENDENT] }, async ($, on) => {
    const b = bench(on, { sessionId: '../escape' })
    await $.session.start(start())
    await $.prompt.submit(ask('isOn'))
    expect(answer(b.files, 'isOn')).toBe(false)
  })

  test('orchestratorIsOn honours a legacy file left at session start', { plugins: [DEPENDENT] }, async ($, on) => {
    const b = bench(on, { files: { [LEGACY]: '' } })
    await $.session.start(start())
    await $.prompt.submit(ask('isOn'))
    expect(answer(b.files, 'isOn')).toBe(false)
  })
})

describe('AC9: isUnattended and callerLane read the one lane definition', () => {
  test('an interactive session a person types into is attended', { plugins: [DEPENDENT] }, async ($, on) => {
    const b = bench(on)
    await $.session.start(start(true))
    await $.prompt.submit(ask('unattended'))
    expect(answer(b.files, 'unattended')).toBe(false)
  })

  test('a claude -p or SDK session is unattended', { plugins: [DEPENDENT] }, async ($, on) => {
    const b = bench(on)
    await $.session.start(start(false))
    await $.prompt.submit(ask('unattended', { kind: 'sdk' }))
    expect(answer(b.files, 'unattended')).toBe(true)
  })

  test('a top-level --agent run is unattended, even where it looks interactive', { plugins: [DEPENDENT] }, async ($, on) => {
    const b = bench(on, { env: { HOME, CLAUDE_CODE_AGENT: 'workbench-dev-team:watson' } })
    await $.session.start(start(true))
    await $.prompt.submit(ask('unattended'))
    expect(answer(b.files, 'unattended')).toBe(true)
  })

  test('a process the dev-team dispatcher started is unattended', { plugins: [DEPENDENT] }, async ($, on) => {
    const b = bench(on, { env: { HOME, WORKBENCH_DEV_TEAM_PIPELINE: '1' } })
    await $.session.start(start(true))
    await $.prompt.submit(ask('unattended'))
    expect(answer(b.files, 'unattended')).toBe(true)
  })

  test('a turn a schedule opened is unattended, by origin or by wrapper, and the next typed turn is not', { plugins: [DEPENDENT] }, async ($, on) => {
    const b = bench(on)
    await $.session.start(start(true))
    await $.prompt.submit(ask('unattended', { kind: 'scheduled-trigger' }))
    expect(answer(b.files, 'unattended')).toBe(true)
    await $.prompt.submit(ask('<scheduled-task name="nightly">unattended'))
    expect(answer(b.files, 'unattended')).toBe(true)
    await $.prompt.submit(ask('unattended'))
    expect(answer(b.files, 'unattended')).toBe(false)
  })

  for (const origin of [{ kind: 'peer' }, { kind: 'peer-send-message' }, { kind: 'sdk' }, { kind: 'channel', server: 'slack' }] as const) {
    test(`a turn a ${origin.kind} opened in an interactive session is unattended, as the question rule reads it`, { plugins: [DEPENDENT] }, async ($, on) => {
      const b = bench(on)
      await $.session.start(start(true))
      await $.prompt.submit(ask('unattended', origin))
      expect(answer(b.files, 'unattended')).toBe(true)
    })
  }

  test('before session start the lane is unknown, and both methods reject', { plugins: [DEPENDENT] }, async ($, on) => {
    const b = bench(on)
    await $.prompt.submit(ask('unattended'))
    await $.prompt.submit(ask('lane:'))
    expect(answer(b.files, 'unattended')).toEqual({ rejected: 'workbench: the lane is unknown' })
    expect(answer(b.files, 'lane')).toEqual({ rejected: 'workbench: the lane is unknown' })
  })

  test('an agentId that is not a string makes callerLane reject', { plugins: [DEPENDENT] }, async ($, on) => {
    const b = bench(on)
    await $.session.start(start(true))
    await $.prompt.submit(ask('lane:#number'))
    expect(answer(b.files, 'lane')).toEqual({ rejected: 'workbench: the lane is unknown' })
  })

  test('a prompt folded into a scheduled turn leaves the turn scheduled', { plugins: [DEPENDENT] }, async ($, on) => {
    const b = bench(on)
    await $.session.start(start(true))
    await $.prompt.submit(ask('<scheduled-task name="nightly">go', { kind: 'scheduled-trigger' }))
    await $.prompt.submit({ ...ask('unattended'), turnId: 'running' })
    expect(answer(b.files, 'unattended')).toBe(true)
  })

  test('callerLane: an event with agentId is a sub-agent\'s, one without is the main loop\'s', { plugins: [DEPENDENT] }, async ($, on) => {
    const b = bench(on)
    await $.session.start(start(true))
    await $.prompt.submit(ask('lane:a79d47fc'))
    expect(answer(b.files, 'lane')).toBe('sub-agent')
    await $.prompt.submit(ask('lane:'))
    expect(answer(b.files, 'lane')).toBe('main')
  })

  test('callerLane: the main loop of a top-level --agent run is that lane, and its sub-agents are sub-agents', { plugins: [DEPENDENT] }, async ($, on) => {
    const b = bench(on, { env: { HOME, CLAUDE_CODE_AGENT: 'workbench-dev-team:holmes' } })
    await $.session.start(start(false))
    await $.prompt.submit(ask('lane:'))
    expect(answer(b.files, 'lane')).toBe('top-level-agent')
    await $.prompt.submit(ask('lane:a1'))
    expect(answer(b.files, 'lane')).toBe('sub-agent')
  })
})

describe('AC3: briefCheck gives the bash gate\'s verdict on every case of its suite', () => {
  // tests/brief-cases.ts is generated from hooks/test-agent-dispatch-gate.sh
  // by hooks/test-brief-parity.sh, which fails while it is stale.
  test('the fixture carries the gate suite\'s cases', () => {
    expect(GATE_CASES.length).toBeGreaterThanOrEqual(40)
  })

  for (const c of GATE_CASES) {
    test(`${c.isComplete ? 'passes' : 'refuses'}: ${c.name}`, () => {
      const verdict = checkBrief(c.prompt)
      expect({ isComplete: verdict.isComplete, missing: verdict.missing }).toEqual({ isComplete: c.isComplete, missing: c.missing })
    })
  }

  test('the slots are the template\'s, header and description', () => {
    expect(BRIEF_SLOTS).toEqual(GATE_SLOTS)
  })

  // The gate reads a line at a time. JavaScript's multiline anchors also stop
  // at \r and U+2028, so a slot glued behind one is a divergence to refuse.
  test('a header after a carriage return or a line separator is not at a line start', () => {
    expect(checkBrief('Workdir: /x\nGoal: g\nContext: c\nConstraints: n\nAcceptance: a\nnote\rDone when: d').missing).toEqual(['Done when:'])
    expect(checkBrief('Workdir: /x\nGoal: g\nContext: c\nConstraints: n\nAcceptance: a\nnote\u2028Done when: d').missing).toEqual(['Done when:'])
  })

  test('the shape names which allowance let a prompt through', () => {
    expect(checkBrief('  \t\n ').shape).toBe('blank')
    expect(checkBrief('Repo sweep: a/b').shape).toBe('repo-sweep')
    expect(checkBrief('Item ID: 3').shape).toBe('item-id')
    expect(checkBrief('Item ID: 3\nmore').shape).toBe('brief')
  })
})
