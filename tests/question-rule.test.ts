import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  ASKS_NOTHING,
  ASKS_USER,
  FORWARD_REFUSAL,
  LABEL_REFUSAL,
  REFUSAL_REASON,
  REPROMPT_REASON,
  hasContextBefore,
  proseOf,
  shownTextOf,
  unshownOf,
  unshownReason,
} from '../hooks/mods/question-rule'
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

const NOTIFICATION = { kind: 'task-notification' } as const
const NARRATION = { type: 'thinking', thinking: '', signature: 'narration' }
const AGENT = { tool: 'Agent' as const, description: 'research', prompt: 'look into it' }

describe('AC3: an AskUserQuestion that forwards a sub-agent question with no prose before it is refused', () => {
  askTest('a call with nothing visible before it, in a notification turn, is refused with the reason', async ($, on) => {
    const w = world(on, ATTENDED)
    w.blocksBefore = [{ type: 'thinking', thinking: '' }]
    await $.session.start(start(true))
    await $.prompt.submit(prompt('task done', NOTIFICATION))
    const result = await $.tool.call(ASK)
    expect(result.deny).toBe(REFUSAL_REASON)
    expect(REFUSAL_REASON).toContain('Ask that sub-agent through SendMessage for the context Mike needs')
    expect(REFUSAL_REASON).toContain('write that context in prose directly above the call, and call AskUserQuestion again')
    expect(w.asked).toBe(0)
  })

  askTest('a call after whitespace-only text is refused', async ($, on) => {
    const w = world(on, ATTENDED)
    w.blocksBefore = [{ type: 'text', text: '  \n ' }]
    await $.session.start(start(true))
    await $.prompt.submit(prompt('task done', NOTIFICATION))
    expect((await $.tool.call(ASK)).deny).toBe(REFUSAL_REASON)
  })

  askTest('a call whose prose sits before another tool call is refused', async ($, on) => {
    const w = world(on, ATTENDED)
    w.blocksBefore = [{ type: 'text', text: 'Reading the config first.' }, { type: 'tool_use', id: 'other', name: 'Read', input: {} }]
    await $.session.start(start(true))
    await $.prompt.submit(prompt('task done', NOTIFICATION))
    expect((await $.tool.call(ASK)).deny).toBe(REFUSAL_REASON)
  })

  askTest('a call with prose right before it runs, past a thinking block', async ($, on) => {
    const w = world(on, ATTENDED)
    w.blocksBefore = [{ type: 'text', text: 'Two ways forward.' }, { type: 'thinking', thinking: '' }]
    await $.session.start(start(true))
    await $.prompt.submit(prompt('task done', NOTIFICATION))
    expect((await $.tool.call(ASK)).deny).toBeUndefined()
    expect(w.asked).toBe(1)
  })

  askTest('a call no message holds runs, as from another plugin', async ($, on) => {
    const w = world(on, ATTENDED)
    w.blocksBefore = null
    await $.session.start(start(true))
    await $.prompt.submit(prompt('task done', NOTIFICATION))
    expect((await $.tool.call(ASK)).deny).toBeUndefined()
    expect(w.asked).toBe(1)
  })

  askTest('a notification folded into a running turn makes the turn forward', async ($, on) => {
    const w = world(on, ATTENDED)
    w.blocksBefore = []
    await $.session.start(start(true))
    await $.prompt.submit(prompt('go'))
    expect((await $.tool.call(ASK)).deny).toBeUndefined()
    await $.prompt.submit({ ...prompt('task done', NOTIFICATION), turnId: 't' })
    expect((await $.tool.call(ASK)).deny).toBe(REFUSAL_REASON)
  })

  askTest('a sub-agent that completes and hands back its report makes the turn forward, whatever the call asked for', async ($, on) => {
    on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'completed', content: [] } as never }))
    const w = world(on, { WORKBENCH_ORCHESTRATOR: '0' })
    w.blocksBefore = []
    await $.session.start(start(true))
    await $.prompt.submit(prompt('go'))
    expect((await $.tool.call(AGENT)).deny).toBeUndefined()
    expect((await $.tool.call(ASK)).deny).toBe(REFUSAL_REASON)
  })

  askTest('a background sub-agent launch hands nothing back, so the turn does not forward', async ($, on) => {
    on('tool.call', { tool: 'Agent' }, () => ({ result: { status: 'async_launched', agentId: 'a1' } as never }))
    const w = world(on, { WORKBENCH_ORCHESTRATOR: '0' })
    w.blocksBefore = []
    await $.session.start(start(true))
    await $.prompt.submit(prompt('go'))
    expect((await $.tool.call(AGENT)).deny).toBeUndefined()
    expect((await $.tool.call({ ...AGENT, run_in_background: true })).deny).toBeUndefined()
    expect((await $.tool.call(ASK)).deny).toBeUndefined()
  })
})

describe('an AskUserQuestion the main session raises on its own is never refused for context', () => {
  for (const [name, blocks] of [
    ['a narration thinking block', [NARRATION]],
    ['nothing', []],
    ['whitespace-only text', [{ type: 'text', text: ' ' }]],
  ] as const) {
    askTest(`a composer turn with ${name} before the call runs it`, async ($, on) => {
      const w = world(on, ATTENDED)
      w.blocksBefore = [...blocks]
      await $.session.start(start(true))
      await $.prompt.submit(prompt('pick one'))
      expect((await $.tool.call(ASK)).deny).toBeUndefined()
      expect(w.asked).toBe(1)
    })
  }

  askTest('the next prompt Mike sends ends the forwarding turn', async ($, on) => {
    const w = world(on, ATTENDED)
    w.blocksBefore = [NARRATION]
    await $.session.start(start(true))
    await $.prompt.submit(prompt('task done', NOTIFICATION))
    expect((await $.tool.call(ASK)).deny).toBe(REFUSAL_REASON)
    await $.prompt.submit(prompt('pick one'))
    expect((await $.tool.call(ASK)).deny).toBeUndefined()
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

const TABLE = [
  'Watson found three ways to fix the parser.',
  '',
  '| Option            | Pros        | Cons          | Grade             |',
  '|-------------------|-------------|---------------|-------------------|',
  '| A: Patch the lexer | Small diff | Keeps the bug class | All met     |',
  '| B: New tokenizer  | Clean       | Large diff    | AC2 partly met    |',
  '| C: Regex fallback | Fast        | Fragile       | AC1 not met       |',
  '',
  'I recommend A (all met), because it fixes the bug with the least change.',
].join('\n')

const decision = (options: { label: string; description: string }[], question = 'How should the parser be fixed?') => ({
  tool: 'AskUserQuestion' as const,
  questions: [{ question, header: 'Parser', options, multiSelect: false }],
})

const PLAIN = decision([
  { label: 'Patch the lexer', description: 'Small diff. All met.' },
  { label: 'New tokenizer', description: 'Clean, large diff. AC2 partly met.' },
  { label: 'Regex fallback', description: 'Fast, fragile. AC1 not met.' },
])

describe('AC2: a question that names options the reply does not show is refused', () => {
  for (const [name, call] of [
    ['a letter label', decision([{ label: 'B', description: 'the tokenizer' }, { label: 'Patch the lexer', description: 'small' }])],
    ['an "Option 2" label', decision([{ label: 'Option 2', description: 'the tokenizer' }, { label: 'Patch the lexer', description: 'small' }])],
    ['a letter label marked recommended', decision([{ label: 'A (Recommended)', description: 'all met' }, { label: 'Patch the lexer', description: 'small' }])],
  ] as const) {
    askTest(`${name} is refused even with the table shown, because the dialog can cover it`, async ($, on) => {
      const w = world(on, ATTENDED)
      w.blocksBefore = [{ type: 'text', text: TABLE }]
      await $.session.start(start(true))
      await $.prompt.submit(prompt('fix the parser'))
      expect((await $.tool.call(call)).deny).toBe(LABEL_REFUSAL)
      expect(LABEL_REFUSAL).toContain('Name what each option does in plain words')
      expect(w.asked).toBe(0)
    })
  }

  for (const [name, call, ref] of [
    ['a question that names an option', decision([{ label: 'Yes', description: 'go' }, { label: 'No', description: 'stop' }], "Go with Watson's option 2?"), "option 2, a sub-agent's graded options"],
    ['a label that combines letters', decision([{ label: 'B + A stopgap', description: 'both' }, { label: 'Patch the lexer', description: 'small' }]), 'option B, option A'],
    ['a description that names options', decision([{ label: 'Ship the fix', description: 'Same as options A and C' }, { label: 'Hold it', description: 'wait' }]), 'option A, option C'],
    ['a pointer at a table', decision([{ label: 'Ship the fix', description: 'The first row of the table above' }, { label: 'Hold it', description: 'wait' }]), 'a table'],
    ['a pointer at the grades', decision([{ label: 'Ship the fix', description: 'Best of the grades, as graded' }, { label: 'Hold it', description: 'wait' }]), "a sub-agent's graded options"],
    ["a pointer at a sub-agent's proposal", decision([{ label: 'Ship the fix', description: "Watson's proposal" }, { label: 'Hold it', description: 'wait' }]), "a sub-agent's graded options"],
  ] as const) {
    askTest(`${name}, in a turn Mike opened, is refused when the reply shows only a summary`, async ($, on) => {
      const w = world(on, ATTENDED)
      w.blocksBefore = [{ type: 'text', text: 'Watson finished. He found a parser fix.' }]
      await $.session.start(start(true))
      await $.prompt.submit(prompt('fix the parser'))
      const result = await $.tool.call(call)
      expect(result.deny).toBe(unshownReason([...ref.split(', ')]))
      expect(result.deny).toContain('Render it in prose above the call first: the options table')
      expect(w.asked).toBe(0)
    })
  }

  askTest('a forwarded decision with only a one-line summary above it is refused', async ($, on) => {
    const w = world(on, ATTENDED)
    w.blocksBefore = [{ type: 'text', text: 'Watson has three options for the parser. I recommend the first.' }]
    await $.session.start(start(true))
    await $.prompt.submit(prompt('task done', NOTIFICATION))
    expect((await $.tool.call(PLAIN)).deny).toBe(FORWARD_REFUSAL)
    expect(FORWARD_REFUSAL).toContain('one table with the columns Option, Pros, Cons, and Grade')
    expect(w.asked).toBe(0)
  })

  askTest('a forwarded decision whose table has fewer rows than options is refused', async ($, on) => {
    const w = world(on, ATTENDED)
    w.blocksBefore = [{ type: 'text', text: TABLE.split('\n').filter(line => !line.startsWith('| C')).join('\n') }]
    await $.session.start(start(true))
    await $.prompt.submit(prompt('task done', NOTIFICATION))
    expect((await $.tool.call(PLAIN)).deny).toBe(FORWARD_REFUSAL)
  })

  askTest('a forwarded decision with its table but no recommendation is refused', async ($, on) => {
    const w = world(on, ATTENDED)
    w.blocksBefore = [{ type: 'text', text: TABLE.split('\n').filter(line => !line.startsWith('I recommend')).join('\n') }]
    await $.session.start(start(true))
    await $.prompt.submit(prompt('task done', NOTIFICATION))
    expect((await $.tool.call(PLAIN)).deny).toBe(FORWARD_REFUSAL)
  })

  askTest('a forwarded two-option decision whose descriptions carry grades needs its table too', async ($, on) => {
    const w = world(on, ATTENDED)
    w.blocksBefore = [{ type: 'text', text: 'Two ways. I recommend the first.' }]
    await $.session.start(start(true))
    await $.prompt.submit(prompt('task done', NOTIFICATION))
    const call = decision([
      { label: 'Patch the lexer', description: 'All met.' },
      { label: 'New tokenizer', description: 'AC2 partly met.' },
    ])
    expect((await $.tool.call(call)).deny).toBe(FORWARD_REFUSAL)
  })

  askTest('a forwarded decision whose table has no Grade column is refused', async ($, on) => {
    const w = world(on, ATTENDED)
    w.blocksBefore = [{ type: 'text', text: TABLE.replace('| Grade             |', '| Notes             |') }]
    await $.session.start(start(true))
    await $.prompt.submit(prompt('task done', NOTIFICATION))
    expect((await $.tool.call(PLAIN)).deny).toBe(FORWARD_REFUSAL)
  })

  askTest('a forwarded three-option decision with no grades in it still needs its table', async ($, on) => {
    const w = world(on, ATTENDED)
    w.blocksBefore = [{ type: 'text', text: 'Watson found three fixes. I recommend the lexer patch.' }]
    await $.session.start(start(true))
    await $.prompt.submit(prompt('task done', NOTIFICATION))
    const call = decision([
      { label: 'Patch the lexer', description: 'Small diff' },
      { label: 'New tokenizer', description: 'Large diff' },
      { label: 'Regex fallback', description: 'Fragile' },
    ])
    expect((await $.tool.call(call)).deny).toBe(FORWARD_REFUSAL)
  })

  askTest('a table from an earlier reply does not count', async ($, on) => {
    const w = world(on, ATTENDED)
    w.blocksBefore = [{ type: 'text', text: 'Back to the parser.' }]
    await $.session.start(start(true))
    await $.prompt.submit(prompt('task done', NOTIFICATION))
    expect((await $.tool.call(PLAIN)).deny).toBe(FORWARD_REFUSAL)
  })
})

describe('AC3: a question whose options are shown, or that names none, runs', () => {
  askTest('a forwarded sub-agent decision with its table and recommendation rendered above it runs', async ($, on) => {
    const w = world(on, ATTENDED)
    w.blocksBefore = [{ type: 'text', text: TABLE }]
    await $.session.start(start(true))
    await $.prompt.submit(prompt('task done', NOTIFICATION))
    expect((await $.tool.call(PLAIN)).deny).toBeUndefined()
    expect(w.asked).toBe(1)
  })

  askTest('a question that names an option the table shows runs', async ($, on) => {
    const w = world(on, ATTENDED)
    w.blocksBefore = [{ type: 'text', text: TABLE }]
    await $.session.start(start(true))
    await $.prompt.submit(prompt('task done', NOTIFICATION))
    const call = decision(
      [
        { label: 'Patch the lexer', description: 'Option A. All met.' },
        { label: 'New tokenizer', description: 'Option B. AC2 partly met.' },
        { label: 'Regex fallback', description: 'Option C, per the table above. AC1 not met.' },
      ],
      "Go with Watson's option A?",
    )
    expect((await $.tool.call(call)).deny).toBeUndefined()
  })

  for (const [name, call] of [
    ['a plain yes/no', decision([{ label: 'Yes', description: 'Push the branch' }, { label: 'No', description: 'Hold it' }], 'Push the branch now?')],
    ['the commit question', decision([{ label: 'Not yet', description: 'Keep reviewing' }, { label: 'Commit it', description: 'Commit and push' }], 'Is your review done?')],
    ['an open question with no options', decision([], 'What should the new flag be called?')],
  ] as const) {
    askTest(`${name}, forwarded with a line of context, runs`, async ($, on) => {
      const w = world(on, ATTENDED)
      w.blocksBefore = [{ type: 'text', text: 'Watson finished the parser fix, and all tests pass.' }]
      await $.session.start(start(true))
      await $.prompt.submit(prompt('task done', NOTIFICATION))
      expect((await $.tool.call(call)).deny).toBeUndefined()
      expect(w.asked).toBe(1)
    })
  }

  askTest('a three-option question the main session raises on its own needs no table', async ($, on) => {
    const w = world(on, ATTENDED)
    w.blocksBefore = [{ type: 'text', text: 'Which repo next?' }]
    await $.session.start(start(true))
    await $.prompt.submit(prompt('what next'))
    const call = decision([
      { label: 'workbench-core', description: 'the hooks' },
      { label: 'workbench-dev-team', description: 'the agents' },
      { label: 'the vault', description: 'notes' },
    ])
    expect((await $.tool.call(call)).deny).toBeUndefined()
  })

  test('shownTextOf reads every assistant text since the last prompt, past tool results', () => {
    const call = { type: 'tool_use', id: 'q' }
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Table.' }, { type: 'tool_use', id: 'r' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'Hidden.' }, { type: 'text', text: 'Pick.' }, call] },
    ]
    expect(shownTextOf(messages, 'q')).toBe('Table.\nPick.')
    expect(shownTextOf([{ role: 'assistant', content: [{ type: 'text', text: 'Old.' }] }, ...messages], 'q')).toBe('Table.\nPick.')
    expect(shownTextOf([{ role: 'user', content: 'prompt' } as never, { role: 'assistant', content: [call] }], 'q')).toBe('')
    expect(shownTextOf(messages, 'other')).toBeUndefined()
    expect(shownTextOf(messages, undefined)).toBeUndefined()
  })

  test('unshownOf lets malformed input and article letters through', () => {
    expect(unshownOf(undefined, '', true)).toBeUndefined()
    expect(unshownOf([{ question: 'A good fix, or a fast one?', options: [{ label: 'A good fix', description: 'A slow, safe change' }] }], '', false)).toBeUndefined()
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
      expect((await $.tool.call(ASK)).deny).toBe(kind === 'task-notification' ? REFUSAL_REASON : undefined)
    })
  }

  askTest('the attended control case does both', async ($, on) => {
    const w = world(on, ATTENDED)
    w.label = ASKS_USER
    w.blocksBefore = []
    await $.session.start(start(true))
    await $.prompt.submit(prompt('go', NOTIFICATION))
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
