// The request meter (hooks/register.ts, hooks/mods/request-meter.ts): turns
// since session start, and the latest API request's cost against the session's
// first API request's, on the status line.

import { describe, expect, test } from 'claude-code/testing'
import type { TurnUsage } from 'claude-code'

import { familyOf, priceOf, statusOf } from '../hooks/mods/request-meter'
import { request, start, turn, world } from './harness'

const usage = (model: string, counts: Partial<Omit<TurnUsage, 'model'>> = {}): TurnUsage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  model,
  ...counts,
})
const M = 1_000_000
// Prices multiply binary floats, so they are compared at nine decimals.
const dollars = (n: number | undefined): number | undefined => (n === undefined ? n : Math.round(n * 1e9) / 1e9)
// The meter reads only the reason, so the rest of the input is a stand-in.
const end = (reason: 'clear' | 'other') => ({ reason, sessionId: 's', resume: {} as never })
// $0.020 on Opus 5.5: 1,000 output tokens at $20 per million.
const OPUS_1K = usage('claude-opus-5-5', { output_tokens: 1000 })

describe('AC5: the status line carries turns and each request against the first', () => {
  test('each main request draws the line, and each turn counts T', async ($, on) => {
    const w = world(on, {})
    await $.session.start(start(true))
    // 1,000 input at $4 and 1,000 output at $20 per million: $0.024.
    await request($, w, usage('claude-opus-5-5', { input_tokens: 1000, output_tokens: 1000 }))
    // 1M cache reads at $0.20 and 100k 1-hour cache writes at $8: $1.00.
    await request($, w, usage('claude-opus-5-5', { cache_read_input_tokens: M, cache_creation_input_tokens: 100_000 }))
    await $.turn.complete(turn())
    expect(w.statuses).toEqual([
      'T0 · $0.024/req · 1.0× first',
      'T0 · $1.00/req · 41.7× first',
      'T1 · $1.00/req · 41.7× first',
    ])
  })

  test('cache reads and cache writes are priced separately', () => {
    expect(dollars(priceOf(usage('claude-opus-5-5', { cache_read_input_tokens: M })))).toBe(0.2)
    expect(dollars(priceOf(usage('claude-opus-5-5', { cache_creation_input_tokens: M })))).toBe(8)
    expect(dollars(priceOf(usage('claude-opus-5-5', { input_tokens: M })))).toBe(4)
    expect(dollars(priceOf(usage('claude-opus-5-5', { output_tokens: M })))).toBe(20)
  })

  test('each request is priced for the model that answered', () => {
    expect(dollars(priceOf(usage('claude-sonnet-4-6', { input_tokens: M, cache_read_input_tokens: M })))).toBe(3.3)
    expect(dollars(priceOf(usage('claude-haiku-4-5-20251001', { output_tokens: M })))).toBe(5)
    expect(dollars(priceOf(usage('claude-fable-5-1', { cache_read_input_tokens: M })))).toBe(0.25)
    expect(dollars(priceOf(usage('claude-fable-5', { cache_read_input_tokens: M })))).toBe(1)
  })

  test('model ids as the API reports them map to their family', () => {
    expect(familyOf('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5')
    expect(familyOf('claude-opus-5-5[1m]')).toBe('claude-opus-5-5')
    expect(familyOf('us.anthropic.claude-sonnet-4-6-v1:0')).toBe('claude-sonnet-4-6')
    expect(familyOf('claude-opus-4-5@20251101')).toBe('claude-opus-4-5')
    expect(familyOf('claude-sonnet-5')).toBe('claude-sonnet-5')
  })

  test('a latest request with no price shows no figure', async ($, on) => {
    const w = world(on, {})
    await $.session.start(start(true))
    await request($, w, OPUS_1K)
    await request($, w, usage('mystery-model', { output_tokens: M }))
    expect(priceOf(usage('mystery-model', { output_tokens: M }))).toBeUndefined()
    expect(w.statuses[1]).toBe('T0 · mystery-model unpriced')
  })

  test('an unpriced first request stays the baseline, and the line says so', async ($, on) => {
    const w = world(on, {})
    await $.session.start(start(true))
    await request($, w, usage('mystery-model', { output_tokens: M }))
    await request($, w, OPUS_1K)
    await request($, w, usage('claude-opus-5-5', { output_tokens: 2000 }))
    expect(w.statuses).toEqual([
      'T0 · mystery-model unpriced',
      'T0 · $0.020/req · first unpriced',
      'T0 · $0.040/req · first unpriced',
    ])
  })

  test('a first request that cost $0 stays the baseline, with no ratio', async ($, on) => {
    const w = world(on, {})
    await $.session.start(start(true))
    await request($, w, usage('claude-opus-5-5'))
    await request($, w, OPUS_1K)
    expect(w.statuses).toEqual(['T0 · $0.0000/req · first $0', 'T0 · $0.020/req · first $0'])
  })

  test('a step with no response is no request, and the line keeps the last', async ($, on) => {
    const w = world(on, {})
    await $.session.start(start(true))
    await request($, w, null)
    expect(w.statuses).toEqual([])
    await request($, w, OPUS_1K)
    await request($, w, null)
    await request($, w, usage('claude-opus-5-5', { output_tokens: 3000 }))
    expect(w.statuses).toEqual(['T0 · $0.020/req · 1.0× first', 'T0 · $0.060/req · 3.0× first'])
  })

  test("a sub-agent's requests and turns are not counted", async ($, on) => {
    const w = world(on, {})
    await $.session.start(start(true))
    await request($, w, usage('claude-opus-5-5', { output_tokens: M }), 'agent-1')
    await $.turn.complete(turn('agent-1'))
    expect(w.statuses).toEqual([])
    await request($, w, OPUS_1K)
    expect(w.statuses).toEqual(['T0 · $0.020/req · 1.0× first'])
  })

  test('a turn with no request still counts', async ($, on) => {
    const w = world(on, {})
    await $.session.start(start(true))
    await $.turn.complete(turn())
    expect(w.statuses).toEqual(['T1'])
  })

  test('a reload draws the line again from the kept figures', async ($, on) => {
    const w = world(on, {})
    await $.session.start(start(true))
    expect(w.statuses).toEqual([])
    await request($, w, OPUS_1K)
    await $.turn.complete(turn())
    await $.session.start(start(true))
    expect(w.statuses).toEqual(['T0 · $0.020/req · 1.0× first', 'T1 · $0.020/req · 1.0× first', 'T1 · $0.020/req · 1.0× first'])
  })

  test('a /clear starts the meter over, and another end leaves it', async ($, on) => {
    const w = world(on, {})
    await $.session.start(start(true))
    await request($, w, OPUS_1K)
    await $.session.end(end('other'))
    await request($, w, usage('claude-opus-5-5', { output_tokens: 2000 }))
    await $.session.end(end('clear'))
    await request($, w, usage('claude-opus-5-5', { output_tokens: 3000 }))
    expect(w.statuses).toEqual([
      'T0 · $0.020/req · 1.0× first',
      'T0 · $0.040/req · 2.0× first',
      undefined,
      'T0 · $0.060/req · 1.0× first',
    ])
  })

  test('small costs keep their digits', () => {
    const first = { model: 'm', usd: 0.0002 }
    expect(statusOf({ turns: 3, first, last: { model: 'm', usd: 0.0004 } })).toBe('T3 · $0.0004/req · 2.0× first')
    expect(statusOf({ turns: 0, first: null, last: null })).toBe('T0')
  })
})
