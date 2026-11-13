// The agent dispatch gate (hooks/mods/dispatch.ts, judged in
// hooks/register.ts's tool.call hook), driven through the engine. It holds the
// port to every branch of the retired bash gate hooks/agent-dispatch-gate.sh:
// the deny naming the missing slots, a complete brief passing, the callers
// that are not gated, the off switch, the blank and machine-built shapes, the
// dispatch hint on each method marker and its absence on an outcome brief, and
// a refusal when the gate cannot finish. The hint is a pure function, so it has
// no failure path of its own to test. The slot
// check itself is held case for case by tests/workbench.test.ts.

import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { checkBrief } from '../hooks/mods/brief'
import { DEV_TEAM_LINE, HINT_LEAD, hintOf, unitHintOf } from '../hooks/mods/dispatch'
import { HAND_BACK_REMINDER } from '../hooks/mods/question-rule'
import type { Bench, BenchOptions } from './bench'
import { HOME, bench, run, start } from './bench'

const BRIEF = [
  'Workdir: /repo',
  'Goal: the parser accepts empty input.',
  'Context: a user hit a crash on an empty file.',
  'Constraints: none',
  'Acceptance:',
  '- an empty file parses to an empty list',
  'Done when: the suite passes.',
].join('\n')

const STEPS = `${BRIEF}\n1. Open the parser.\n2. Add the guard.\n3) Run the tests.`

async function session($: Engine, on: On, options: BenchOptions & { isInteractive?: boolean } = {}): Promise<Bench> {
  const b = bench(on, { ...options, env: { HOME, ...options.env } })
  await $.session.start(start(options.isInteractive ?? true))
  return b
}

const agent = (prompt: unknown, agentId?: string) => ({ tool: 'Agent', description: 'd', prompt, ...(agentId ? { agentId } : {}) })

// The call's answer, and whether it reached the engine.
async function dispatch($: Engine, b: Bench, call: Record<string, unknown>) {
  const before = b.inputs.length
  const result = await $.tool.call(call as never)
  const hints = (result.context ?? []).filter(text => typeof text === 'string' && text.startsWith(HINT_LEAD))
  return { deny: result.deny, isReached: b.inputs.length === before + 1, hints }
}

describe('the deny', () => {
  test('a main-agent prompt with no brief is refused, naming all six slots', async ($, on) => {
    const b = await session($, on)
    const { deny, isReached } = await dispatch($, b, agent('Fix the parser.'))
    expect(isReached).toBe(false)
    expect(deny).toContain('🛑 Blocked: an Agent dispatch without a complete brief. Missing: Workdir:, Goal:, Context:, Constraints:, Acceptance:, Done when:.')
    expect(deny).toContain('Agent dispatch gate (workbench-core)')
    expect(deny).toContain('Slots: Workdir: (absolute path')
    expect(deny).toContain('/orchestrator off')
  })

  for (const slot of ['Workdir:', 'Goal:', 'Context:', 'Constraints:', 'Acceptance:', 'Done when:']) {
    test(`a brief without ${slot} is refused, naming only that slot`, async ($, on) => {
      const b = await session($, on)
      const prompt = BRIEF.split('\n')
        .filter(line => !line.startsWith(slot))
        .join('\n')
      const { deny, isReached } = await dispatch($, b, agent(prompt))
      expect(isReached).toBe(false)
      expect(deny).toContain(`Missing: ${slot}.`)
    })
  }

  test('the dev-team line is in the refusal only when the plugin is installed', async ($, on) => {
    const b = await session($, on)
    expect((await dispatch($, b, agent('x'))).deny).not.toContain(DEV_TEAM_LINE)
    const cache = `${HOME}/.claude/plugins/cache`
    b.dirs.add(`${cache}/market`)
    b.dirs.add(`${cache}/market/workbench-dev-team`)
    b.kinds.set(`${cache}/market/workbench-dev-team`, 'dir')
    expect((await dispatch($, b, agent('x'))).deny).toContain(DEV_TEAM_LINE)
  })
})

describe('what passes', () => {
  test('a complete brief reaches the engine', async ($, on) => {
    const b = await session($, on)
    expect(await dispatch($, b, agent(BRIEF))).toEqual({ deny: undefined, isReached: true, hints: [] })
  })

  test('a blank prompt and the two machine-built shapes pass', async ($, on) => {
    const b = await session($, on)
    for (const prompt of ['', ' \t\n ', 'Item ID: 12', 'Repo sweep: owner/repo']) {
      expect(await dispatch($, b, agent(prompt))).toEqual({ deny: undefined, isReached: true, hints: [] })
    }
  })

  test('a machine-built shape followed by prose is a brief, and is refused', async ($, on) => {
    const b = await session($, on)
    expect((await dispatch($, b, agent('Item ID: 12\nAnd also fix the parser.'))).isReached).toBe(false)
  })

  test("a sub-agent's dispatch is not gated", async ($, on) => {
    const b = await session($, on)
    expect(await dispatch($, b, agent('Run lens 2.', 'a5a2f4470341f9233'))).toEqual({ deny: undefined, isReached: true, hints: [] })
  })

  test('a top-level --agent run is not gated', async ($, on) => {
    const b = await session($, on, { env: { CLAUDE_CODE_AGENT: 'workbench-dev-team:holmes' }, isInteractive: false })
    expect(await dispatch($, b, agent('Run lens 2.'))).toEqual({ deny: undefined, isReached: true, hints: [] })
  })

  test('/orchestrator off stands the gate and the hint down, and on brings both back', async ($, on) => {
    const b = await session($, on)
    await $.command.run(run('orchestrator', 'off'))
    expect(await dispatch($, b, agent('Fix it.'))).toEqual({ deny: undefined, isReached: true, hints: [] })
    expect((await dispatch($, b, agent(STEPS))).hints).toEqual([])
    await $.command.run(run('orchestrator', 'on'))
    expect((await dispatch($, b, agent('Fix it.'))).isReached).toBe(false)
  })

  test('WORKBENCH_ORCHESTRATOR=0 stands the gate down', async ($, on) => {
    const b = await session($, on, { env: { WORKBENCH_ORCHESTRATOR: '0' } })
    expect((await dispatch($, b, agent('Fix it.'))).isReached).toBe(true)
  })
})

// The mode is read from the session state and the store. A legacy file that
// cannot be named, with HOME unset or a session id that cannot name a file,
// never stands the gate down.
describe('no legacy file to name', () => {
  const SETUPS: [string, BenchOptions][] = [
    ['HOME unset and no state dir', { env: {} }],
    ['a session id that cannot name a file', { env: { HOME }, sessionId: '../escape' }],
  ]
  for (const [name, options] of SETUPS) {
    test(`${name}: an incomplete brief is refused, and /orchestrator off stands the gate down`, async ($, on) => {
      const b = bench(on, options)
      await $.session.start(start())
      const refused = await dispatch($, b, agent('Fix the parser.'))
      expect(refused.isReached).toBe(false)
      expect(refused.deny).toContain('Missing: Workdir:')
      await $.command.run(run('orchestrator', 'off'))
      expect((await dispatch($, b, agent('Fix the parser.'))).isReached).toBe(true)
    })
  }
})

describe('a prompt that is not a string', () => {
  test('passes as blank, as the bash gate did', async ($, on) => {
    const b = await session($, on)
    expect(await dispatch($, b, agent(42))).toEqual({ deny: undefined, isReached: true, hints: [] })
  })
})

describe('the dispatch hint', () => {
  test('a brief with three numbered steps draws the hint and still goes through', async ($, on) => {
    const b = await session($, on)
    const { deny, isReached, hints } = await dispatch($, b, agent(STEPS))
    expect(deny).toBeUndefined()
    expect(isReached).toBe(true)
    expect(hints).toHaveLength(1)
    expect(hints[0]).toContain('this brief carries 3 numbered steps.')
  })

  test('an outcome brief, and one with two steps, draw no hint', async ($, on) => {
    const b = await session($, on)
    expect((await dispatch($, b, agent(BRIEF))).hints).toEqual([])
    expect((await dispatch($, b, agent(`${BRIEF}\n1. One.\n2. Two.`))).hints).toEqual([])
  })

  test("a completed foreground sub-agent's result carries both the hint and the hand-back reminder", async ($, on) => {
    on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'completed', content: [{ type: 'text', text: 'The parser is fixed.' }] } as never }))
    await session($, on)
    const result = await $.tool.call(agent(STEPS) as never)
    expect(result.deny).toBeUndefined()
    expect((result.context ?? []).filter(text => text.startsWith(HINT_LEAD))).toHaveLength(1)
    expect(result.context ?? []).toContain(HAND_BACK_REMINDER)
  })

  test('an Agent call denied beneath carries no hint and no reminder', async ($, on) => {
    const b = await session($, on)
    b.denyBeneath = tool => (tool === 'Agent' ? 'refused beneath' : undefined)
    const result = await $.tool.call(agent(STEPS) as never)
    expect(result.deny).toBe('refused beneath')
    expect(result.context).toBeUndefined()
  })

  test("a sub-agent's method-heavy brief draws no hint", async ($, on) => {
    const b = await session($, on)
    expect((await dispatch($, b, agent(STEPS, 'a1'))).hints).toEqual([])
  })

  test('each marker is named, line-anchored, in the gate\'s order', () => {
    expect(hintOf('```\nx\n```\ngit log -1\n1. a\n2. b\n3. c')).toContain('carries a fenced code block, a shell command on its own line, 3 numbered steps.')
    expect(hintOf('  $ npm test')).toContain('a shell command on its own line')
    expect(hintOf('Read the output of git log first.')).toBeUndefined()
    expect(hintOf('make sure the suite is green\ntouch only these files')).toBeUndefined()
    expect(hintOf('    1. indented four is a code line\n2. b\n3. c')).toBeUndefined()
  })
})

const briefWith = (count: number, unit = '') =>
  BRIEF.replace('- an empty file parses to an empty list', Array.from({ length: count }, (_, i) => `- AC${i + 1}: criterion ${i + 1}`).join('\n')) + unit

describe('the unit hint', () => {
  test('a brief with seven criteria and no unit draws the hint and still goes through', async ($, on) => {
    const b = await session($, on)
    const { deny, isReached, hints } = await dispatch($, b, { ...agent(briefWith(7)), subagent_type: 'workbench-dev-team:watson' })
    expect(deny).toBeUndefined()
    expect(isReached).toBe(true)
    expect(hints).toHaveLength(1)
    expect(hints[0]).toContain('this brief carries 7 acceptance criteria and names no unit.')
    expect(hints[0]).toContain('add a Unit: line')
  })

  test('six criteria, a named unit, a Holmes dispatch and a token prompt draw no unit hint', async ($, on) => {
    const b = await session($, on)
    expect((await dispatch($, b, agent(briefWith(6)))).hints).toEqual([])
    expect((await dispatch($, b, agent(briefWith(7, '\nUnit: 1 of 3, the parser. Meets AC1, AC2.')))).hints).toEqual([])
    for (const type of ['workbench-dev-team:holmes', 'workbench-dev-team:holmes-local', 'workbench-dev-team:holmes-lens']) {
      expect((await dispatch($, b, { ...agent(briefWith(7)), subagent_type: type })).hints).toEqual([])
    }
    for (const prompt of ['Item ID: 12', 'Repo sweep: owner/repo', '']) {
      expect((await dispatch($, b, agent(prompt))).hints).toEqual([])
    }
  })

  test('an empty Unit: line straight after the Acceptance: header still counts all seven criteria', async ($, on) => {
    const b = await session($, on)
    for (const label of ['Unit:', '**Unit:**', '# Unit:']) {
      const { deny, hints } = await dispatch($, b, agent(briefWith(7).replace('Acceptance:\n', `Acceptance:\n${label}\n`)))
      expect(deny).toBeUndefined()
      expect(hints).toHaveLength(1)
      expect(hints[0]).toContain('this brief carries 7 acceptance criteria and names no unit.')
    }
  })

  test('a method-heavy brief with seven criteria draws both hints', async ($, on) => {
    const b = await session($, on)
    const { hints } = await dispatch($, b, agent(`${briefWith(7)}\n1. a\n2. b\n3. c`))
    expect(hints).toHaveLength(2)
    expect(hints[0]).toContain('3 numbered steps')
    expect(hints[1]).toContain('7 acceptance criteria')
  })

  test("a sub-agent's seven-criteria brief draws no hint", async ($, on) => {
    const b = await session($, on)
    expect((await dispatch($, b, agent(briefWith(7), 'a1'))).hints).toEqual([])
  })

  test('the hint keys on the count, the unit, the shape and the Holmes type', () => {
    expect(unitHintOf(checkBrief(briefWith(7)), undefined)).toContain(HINT_LEAD)
    expect(unitHintOf(checkBrief(briefWith(7)), 'workbench-dev-team:watson')).toContain(HINT_LEAD)
    expect(unitHintOf(checkBrief(briefWith(7)), 'holmes-local')).toContain(HINT_LEAD)
    expect(unitHintOf(checkBrief(briefWith(7)), 'workbench-dev-team:holmesian')).toContain(HINT_LEAD)
    expect(unitHintOf(checkBrief(briefWith(7, '\nUnit: ')), undefined)).toContain(HINT_LEAD)
    for (const unit of ['**Unit:** x', '# Unit: x', 'Unit : x', 'unit: x']) {
      expect(unitHintOf(checkBrief(briefWith(7, `\n${unit}`)), undefined)).toBeUndefined()
    }
    for (const mention of ['Units are small.', 'The Unit: line']) {
      expect(unitHintOf(checkBrief(briefWith(7, `\n${mention}`)), undefined)).toContain(HINT_LEAD)
    }
    expect(unitHintOf(checkBrief(briefWith(6)), undefined)).toBeUndefined()
    expect(unitHintOf(checkBrief(briefWith(7)), 'workbench-dev-team:holmes')).toBeUndefined()
    expect(unitHintOf({ isComplete: true, missing: [], shape: 'item-id', criteria: 9 }, undefined)).toBeUndefined()
    expect(unitHintOf({ isComplete: true, missing: [], shape: 'brief' }, undefined)).toBeUndefined()
  })
})

describe('failure', () => {
  // The slot check and the hint are pure. A read around them that rejects, here
  // the caller's lane before session start, throws to the tool.call hook's
  // .catch, which refuses Agent: it is in GUARDED.
  test('a gate that cannot read the lane refuses even a complete brief', async ($, on) => {
    const b = bench(on, { env: { HOME } })
    const { deny, isReached } = await dispatch($, b, agent(BRIEF))
    expect(isReached).toBe(false)
    expect(deny).toContain('could not finish')
  })
})
