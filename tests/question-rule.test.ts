// The question rule (hooks/register.ts, hooks/mods/question-rule.ts): a prose
// question gets one re-prompt, and an AskUserQuestion with no prose before it
// is refused, in an attended main-session turn and nowhere else.

import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { ASKS_NOTHING, ASKS_USER, REFUSAL_REASON, REPROMPT_REASON, hasContextBefore, proseOf } from '../hooks/mods/question-rule'
import { ASK, COMPOSER, ID_RECORDER, prompt, start, stop, world } from './harness'

const ATTENDED = {}

describe('AC1: a prose question gets one correction turn', () => {
  test('a reply that asks in prose is re-prompted toward AskUserQuestion', async ($, on) => {
    const w = world(on, ATTENDED)
    w.label = ASKS_USER
    await $.session.start(start(true))
    await $.prompt.submit(prompt('fix the parser'))
    const result = await $.classic.Stop(stop('The parser is fixed. Should I also update the README?'))
    expect(result.block).toBe(REPROMPT_REASON)
    expect(REPROMPT_REASON).toContain('AskUserQuestion')
    expect(w.classified.length).toBe(1)
  })

  test('the re-prompt fires once per turn', async ($, on) => {
    const w = world(on, ATTENDED)
    w.label = ASKS_USER
    await $.session.start(start(true))
    await $.prompt.submit(prompt('fix the parser'))
    expect((await $.classic.Stop(stop('Should I push?'))).block).toBe(REPROMPT_REASON)
    expect((await $.classic.Stop(stop('Should I push?'))).block).toBeUndefined()
  })

  test('a stop the engine already continued is never re-prompted', async ($, on) => {
    const w = world(on, ATTENDED)
    w.label = ASKS_USER
    await $.session.start(start(true))
    await $.prompt.submit(prompt('fix the parser'))
    expect((await $.classic.Stop(stop('Should I push?', { stop_hook_active: true }))).block).toBeUndefined()
  })

  test('the next prompt arms the rule again', async ($, on) => {
    const w = world(on, ATTENDED)
    w.label = ASKS_USER
    await $.session.start(start(true))
    await $.prompt.submit(prompt('fix the parser'))
    await $.classic.Stop(stop('Should I push?'))
    await $.prompt.submit(prompt('no, wait'))
    expect((await $.classic.Stop(stop('Should I push now?'))).block).toBe(REPROMPT_REASON)
  })

  test('a prompt folded into a running turn does not re-arm it', async ($, on) => {
    const w = world(on, ATTENDED)
    w.label = ASKS_USER
    await $.session.start(start(true))
    await $.prompt.submit(prompt('fix the parser'))
    await $.classic.Stop(stop('Should I push?'))
    await $.prompt.submit({ ...prompt('also this'), turnId: 'running' })
    expect((await $.classic.Stop(stop('Should I push?'))).block).toBeUndefined()
  })

  // The memory checkpoint was an asyncRewake Stop hook until it became a fork
  // with no turn (tests/capture.test.ts). Any asyncRewake Stop hook, another
  // plugin's included, still behaves this way: it runs in the background after
  // the chain settles, so beneath this hook it answers nothing, and the
  // re-prompt still fires. Its wake comes later, queued with stop_hook_active
  // set. Here that wake opens a turn from a notification, the most attended
  // origin it could carry, and its stop is still left alone.
  test('the asyncRewake memory checkpoint and the re-prompt can share a turn, and its wake is never re-prompted', async ($, on) => {
    const w = world(on, ATTENDED)
    w.label = ASKS_USER
    w.stopBeneath = {}
    await $.session.start(start(true))
    await $.prompt.submit(prompt('fix the parser'))
    expect((await $.classic.Stop(stop('Should I push?'))).block).toBe(REPROMPT_REASON)
    await $.prompt.submit(prompt('Memory capture checkpoint', { kind: 'task-notification' }))
    expect((await $.classic.Stop(stop('Nothing to save. Should I push?', { stop_hook_active: true }))).block).toBeUndefined()
  })

  test('a synchronous block from another Stop hook stands alone', async ($, on) => {
    const w = world(on, ATTENDED)
    w.label = ASKS_USER
    w.stopBeneath = { block: 'another plugin' }
    await $.session.start(start(true))
    await $.prompt.submit(prompt('fix the parser'))
    expect((await $.classic.Stop(stop('Should I push?'))).block).toBe('another plugin')
    expect(w.classified.length).toBe(0)
  })

  test('a failed classifier falls back to a question on the last line', async ($, on) => {
    const w = world(on, ATTENDED)
    w.label = new Error('overloaded')
    await $.session.start(start(true))
    await $.prompt.submit(prompt('fix the parser'))
    expect((await $.classic.Stop(stop('Done.\n\nShould I push it?'))).block).toBe(REPROMPT_REASON)
    await $.prompt.submit(prompt('next'))
    expect((await $.classic.Stop(stop('Why did it fail? The fixture expired.\n\nFixed it.'))).block).toBeUndefined()
  })

  test('a classifier answer outside the labels falls back the same way', async ($, on) => {
    const w = world(on, ATTENDED)
    w.label = 'maybe'
    await $.session.start(start(true))
    await $.prompt.submit(prompt('fix the parser'))
    expect((await $.classic.Stop(stop('Should I push it?'))).block).toBe(REPROMPT_REASON)
  })
})

describe('AC2: rhetorical and quoted questions draw no re-prompt', () => {
  test('a rhetorical question is let stand', async ($, on) => {
    const w = world(on, ATTENDED)
    w.label = ASKS_NOTHING
    await $.session.start(start(true))
    await $.prompt.submit(prompt('why did it fail'))
    // It ends on its question mark, so the fallback alone would re-prompt.
    const result = await $.classic.Stop(stop('The fixture expired, and I renewed it. Who would have guessed a date?'))
    expect(result.block).toBeUndefined()
    expect(w.classified.length).toBe(1)
  })

  test('a question in code, inline code, a quote, or quote marks never reaches the classifier', async ($, on) => {
    const w = world(on, ATTENDED)
    w.label = ASKS_USER
    await $.session.start(start(true))
    await $.prompt.submit(prompt('show me'))
    const reply = [
      'The prompt now reads:',
      '```',
      'Do you want to continue? [y/N]',
      '```',
      'The flag is `--ask?` and the docs say:',
      '> Should the cache expire?',
      'The error says "is the file there?" and the fix is in.',
    ].join('\n')
    expect((await $.classic.Stop(stop(reply))).block).toBeUndefined()
    expect(w.classified.length).toBe(0)
  })

  test('a reply with no question never reaches the classifier', async ($, on) => {
    const w = world(on, ATTENDED)
    w.label = ASKS_USER
    await $.session.start(start(true))
    await $.prompt.submit(prompt('fix it'))
    expect((await $.classic.Stop(stop('Fixed. All 40 tests pass.'))).block).toBeUndefined()
    expect(w.classified.length).toBe(0)
  })

  test('a request with no question mark still reaches the classifier', async ($, on) => {
    const w = world(on, ATTENDED)
    w.label = ASKS_USER
    await $.session.start(start(true))
    await $.prompt.submit(prompt('fix it'))
    expect((await $.classic.Stop(stop('The build is green. Let me know if you want the migration run.'))).block).toBe(REPROMPT_REASON)
  })

  test('proseOf strips an unclosed fence to the end, and keeps the prose', () => {
    expect(proseOf('Ready.\n```sh\nrm -rf x?')).toBe('Ready.\n')
    expect(proseOf('Is it on? `x?` "y?" “z?”')).toBe('Is it on?   ')
  })
})


// Each AskUserQuestion test loads the recorder, so the messages beneath can
// hold the call the engine minted an id for.
const askTest = (name: string, body: ($: Engine, on: On) => Promise<void>): void =>
  test(name, { plugins: [ID_RECORDER] }, body)

describe('AC3: an AskUserQuestion with no prose before it is refused', () => {
  askTest('a call with nothing visible before it is refused with the reason', async ($, on) => {
    const w = world(on, ATTENDED)
    w.blocksBefore = [{ type: 'thinking', thinking: '' }]
    await $.session.start(start(true))
    await $.prompt.submit(prompt('pick one'))
    const result = await $.tool.call(ASK)
    expect(result.deny).toBe(REFUSAL_REASON)
    expect(REFUSAL_REASON).toContain('Write the context Mike needs to answer first')
    expect(w.asked).toBe(0)
  })

  askTest('a call after whitespace-only text is refused', async ($, on) => {
    const w = world(on, ATTENDED)
    w.blocksBefore = [{ type: 'text', text: '  \n ' }]
    await $.session.start(start(true))
    await $.prompt.submit(prompt('pick one'))
    expect((await $.tool.call(ASK)).deny).toBe(REFUSAL_REASON)
  })

  askTest('a call whose prose sits before another tool call is refused', async ($, on) => {
    const w = world(on, ATTENDED)
    w.blocksBefore = [{ type: 'text', text: 'Reading the config first.' }, { type: 'tool_use', id: 'other', name: 'Read', input: {} }]
    await $.session.start(start(true))
    await $.prompt.submit(prompt('pick one'))
    expect((await $.tool.call(ASK)).deny).toBe(REFUSAL_REASON)
  })

  askTest('a call with prose right before it runs, past a thinking block', async ($, on) => {
    const w = world(on, ATTENDED)
    w.blocksBefore = [{ type: 'text', text: 'Two ways forward.' }, { type: 'thinking', thinking: '' }]
    await $.session.start(start(true))
    await $.prompt.submit(prompt('pick one'))
    expect((await $.tool.call(ASK)).deny).toBeUndefined()
    expect(w.asked).toBe(1)
  })

  askTest('a call no message holds runs, as from another plugin', async ($, on) => {
    const w = world(on, ATTENDED)
    w.blocksBefore = null
    await $.session.start(start(true))
    await $.prompt.submit(prompt('pick one'))
    expect((await $.tool.call(ASK)).deny).toBeUndefined()
    expect(w.asked).toBe(1)
  })

  test('hasContextBefore reads the message that holds the call, and only it', () => {
    const call = { type: 'tool_use', id: 'q' }
    expect(hasContextBefore([{ role: 'assistant', content: [{ type: 'text', text: 'Context.' }, call] }], 'q')).toBe(true)
    expect(hasContextBefore([{ role: 'assistant', content: [{ type: 'redacted_thinking' }, call] }], 'q')).toBe(false)
    expect(hasContextBefore([{ role: 'assistant', content: [{ type: 'text', text: 'Earlier.' }] }, { role: 'assistant', content: [call] }], 'q')).toBe(false)
    expect(hasContextBefore([{ role: 'assistant', content: [call] }], 'other')).toBeUndefined()
    expect(hasContextBefore([{ role: 'assistant', content: [call] }], undefined)).toBeUndefined()
  })
})

describe('AC4: only a turn a person can answer is re-prompted or refused', () => {
  const ASKING = 'Should I push it?'

  // Each case would re-prompt and refuse in an attended turn: the classifier
  // says the reply asks, and the call has nothing before it.
  async function expectSilent($: Engine, on: On, env: Record<string, string>, isInteractive: boolean, text: string, origin = COMPOSER, extra = {}) {
    const w = world(on, env)
    w.label = ASKS_USER
    w.blocksBefore = []
    await $.session.start(start(isInteractive))
    await $.prompt.submit(prompt(text, origin))
    expect((await $.classic.Stop(stop(ASKING, extra))).block).toBeUndefined()
    expect((await $.tool.call(ASK)).deny).toBeUndefined()
    expect(w.classified.length).toBe(0)
  }

  // Each origin a person in an interactive session answers gets both halves.
  for (const kind of ['composer', 'bridge', 'auto-continuation', 'task-notification'] as const) {
    askTest(`a ${kind} turn in an interactive session gets both halves`, async ($, on) => {
      const w = world(on, ATTENDED)
      w.label = ASKS_USER
      w.blocksBefore = []
      await $.session.start(start(true))
      await $.prompt.submit(prompt('go', { kind }))
      expect((await $.classic.Stop(stop(ASKING))).block).toBe(REPROMPT_REASON)
      expect((await $.tool.call(ASK)).deny).toBe(REFUSAL_REASON)
    })
  }

  askTest('the attended control case does both', async ($, on) => {
    const w = world(on, ATTENDED)
    w.label = ASKS_USER
    w.blocksBefore = []
    await $.session.start(start(true))
    await $.prompt.submit(prompt('go'))
    expect((await $.classic.Stop(stop(ASKING))).block).toBe(REPROMPT_REASON)
    expect((await $.tool.call(ASK)).deny).toBe(REFUSAL_REASON)
  })

  askTest('a headless -p run', ($, on) => expectSilent($, on, ATTENDED, false, 'go', { kind: 'sdk' }))
  askTest('a non-interactive session, even on a typed prompt', ($, on) => expectSilent($, on, ATTENDED, false, 'go'))
  askTest('a top-level --agent run, as the Index pipeline', ($, on) =>
    expectSilent($, on, { CLAUDE_CODE_AGENT: 'workbench-dev-team:watson' }, true, 'go'))
  askTest('a dev-team pipeline process', ($, on) => expectSilent($, on, { WORKBENCH_DEV_TEAM_PIPELINE: '1' }, true, 'go'))
  askTest('a scheduled fire in a session that looks interactive', ($, on) =>
    expectSilent($, on, ATTENDED, true, '<scheduled-task name="dispatch" file="x.md">\nrun</scheduled-task>'))
  // A notification is an attended origin, so a scheduled tick that arrives as
  // one is kept out by its wrapper alone, and a non-interactive session by the
  // session check alone.
  askTest('a scheduled fire that arrives as a notification', ($, on) =>
    expectSilent($, on, ATTENDED, true, '<scheduled-task name="dispatch" file="x.md">\nrun</scheduled-task>', { kind: 'task-notification' }))
  askTest('a notification turn in a non-interactive session', ($, on) =>
    expectSilent($, on, ATTENDED, false, 'task done', { kind: 'task-notification' }))
  askTest('a scheduled trigger', ($, on) => expectSilent($, on, ATTENDED, true, 'tick', { kind: 'scheduled-trigger' }))
  askTest('a peer message', ($, on) => expectSilent($, on, ATTENDED, true, 'hi', { kind: 'peer' }))

  askTest('a sub-agent call', async ($, on) => {
    const w = world(on, ATTENDED)
    w.blocksBefore = []
    await $.session.start(start(true))
    await $.prompt.submit(prompt('go'))
    expect((await $.tool.call({ ...ASK, agentId: 'a1' } as never)).deny).toBeUndefined()
  })

  test('a sub-agent stop, and a top-level --agent stop', async ($, on) => {
    const w = world(on, ATTENDED)
    w.label = ASKS_USER
    await $.session.start(start(true))
    await $.prompt.submit(prompt('go'))
    expect((await $.classic.Stop(stop(ASKING, { agent_id: 'a1' }))).block).toBeUndefined()
    expect((await $.classic.Stop(stop(ASKING, { agent_type: 'watson' }))).block).toBeUndefined()
    expect(w.classified.length).toBe(0)
  })

  test('a session that never started reads as unattended', async ($, on) => {
    const w = world(on, ATTENDED)
    w.label = ASKS_USER
    await $.prompt.submit(prompt('go'))
    expect((await $.classic.Stop(stop(ASKING))).block).toBeUndefined()
  })
})
