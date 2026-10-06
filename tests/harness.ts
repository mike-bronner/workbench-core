// The world beneath workbench-core's hooks module in `claude plugin test`: the
// test's hooks stand for the engine, so every event the module passes on is
// answered here, and what the module asked for is recorded.

import { expect, mock } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'
import type { On, PromptOrigin, TurnUsage } from 'claude-code'

type Block = { type: string; [field: string]: unknown }

export type World = {
  // Each status line the module drew, in order. Undefined is a clear.
  statuses: (string | undefined)[]
  // Each text the module sent to the classifier.
  classified: string[]
  // The classifier's answer. An Error makes the classify call reject.
  label: string | Error
  // What a hook beneath answers to classic.Stop.
  stopBeneath: { block?: string }
  // The blocks of the assistant message ahead of the AskUserQuestion call.
  // Null leaves the call out of every message.
  blocksBefore: Block[] | null
  // Whether the AskUserQuestion call reached the engine.
  asked: number
  // The usage the next model request answers with. Null is no response.
  stepUsage: TurnUsage | null
}

// The tool_use id the engine mints for each call, handed down by an inline
// plugin above the one under test, before that one's hook reads the messages.
// An inline plugin runs in an environment of its own, so it hands the id over
// through an awaited `$` call that the world answers.
export const ID_RECORDER: Plugin = {
  name: 'id-recorder',
  tier: 'prepend',
  register: on => {
    on('tool.call', async ($, e, next) => {
      await $.store.set('tool_use_id', e.tool_use_id)
      return next(e)
    })
  },
}

export function world(on: On, env: Record<string, string>): World {
  const ids: string[] = []
  const w: World = { statuses: [], classified: [], label: 'unset', stopBeneath: {}, blocksBefore: null, asked: 0, stepUsage: null }
  mock.env(on, env)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  // A response streams its text, then its stop, as the engine's does.
  on('turn.step', async function* ($, e) {
    const stopReason = w.stepUsage ? ('end_turn' as const) : null
    yield { kind: 'text' as const, index: 0, text: STREAMED }
    yield { kind: 'stop' as const, stopReason, usage: w.stepUsage }
    return { turnId: e.turnId, index: e.index, answer: STREAMED, toolUses: [], stopReason, usage: w.stepUsage }
  })
  on('classic.Stop', () => w.stopBeneath)
  on('ui.status', ($, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('model.classify', ($, e) => {
    w.classified.push(e.text)
    if (w.label instanceof Error) throw w.label
    return { value: w.label }
  })
  on('store.set', ($, e) => {
    if (e.key === 'tool_use_id' && typeof e.value === 'string') ids.push(e.value)
    return { value: undefined }
  })
  on('session.messages', () => {
    const id = ids[ids.length - 1]
    const call = { type: 'tool_use', id, name: 'AskUserQuestion', input: {} }
    const value = w.blocksBefore === null ? [] : [{ role: 'user', content: [{ type: 'text', text: 'go' }] }, { role: 'assistant', content: [...w.blocksBefore, call] }]
    return { value } as never
  })
  on('tool.call', { tool: 'AskUserQuestion' }, () => {
    w.asked += 1
    return { result: { questions: [], answers: {} } as never }
  })
  return w
}

export const COMPOSER: PromptOrigin = { kind: 'composer' }

export const start = (isInteractive: boolean) => ({ cwd: '/repo', surface: isInteractive ? ('terminal' as const) : null, isInteractive })

export const prompt = (text: string, origin: PromptOrigin = COMPOSER) => ({ text, wait: false, origin })

export const stop = (message: string, extra: { stop_hook_active?: boolean; agent_id?: string; agent_type?: string } = {}) => ({
  stop_hook_active: false,
  last_assistant_message: message,
  ...extra,
})

export const ASK = {
  tool: 'AskUserQuestion' as const,
  questions: [
    {
      question: 'Which approach?',
      header: 'Approach',
      options: [
        { label: 'A', description: 'first' },
        { label: 'B', description: 'second' },
      ],
      multiSelect: false,
    },
  ],
}

export function turn(agentId?: string) {
  return { answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' as const, agentId }
}

// The text every stubbed response streams.
const STREAMED = 'streamed text'

// One model request, answered with `usage`, read to its end as the engine
// would. The module's turn.step hook sits between the caller and the response,
// so every chunk must still reach the caller, in order and unchanged.
export async function request($: Engine, w: World, usage: TurnUsage | null, agentId?: string): Promise<void> {
  w.stepUsage = usage
  const stream = $.turn.step({ turnId: 't', index: 0, model: usage?.model ?? 'm', messageCount: 1, agentId })
  const chunks: unknown[] = []
  let read = await stream.next()
  while (!read.done) {
    chunks.push(read.value)
    read = await stream.next()
  }
  expect(chunks).toMatchObject([
    { kind: 'text', index: 0, text: STREAMED },
    { kind: 'stop', stopReason: usage ? 'end_turn' : null, usage },
  ])
  expect(chunks).toHaveLength(2)
  // The response comes back as the stream's final value. The kit's
  // stream.result settles undefined here, so it is not the value read.
  expect(read.value).toMatchObject({ answer: STREAMED, usage })
}
