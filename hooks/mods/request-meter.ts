// The request meter: on the status line, the turns since session start and the
// latest API request's cost against the session's first API request's, as
// "T14 · $0.21/req · 3.4× first".
//
// A request is one main-loop API request: one `turn.step`, priced from the
// usage the API reported for that response alone. A turn of several tool calls
// makes several requests. A sub-agent's requests are its own, and are left
// out. T counts completed main-loop turns, from `turn.complete`.
//
// Each request is priced from its four token counts, for the model that
// answered. The figures are volatile, so they go to the status line and never
// into the system prompt, where a change would re-bill the cached prefix.
//
// Pure functions only: the engine follows `$` into no imported function, so the
// hooks that keep the figures and draw the line live in hooks/register.ts.

import type { TurnUsage } from 'claude-code'

import type { MeterState, RequestCost } from '../../types'

export const EMPTY: MeterState = { turns: 0, first: null, last: null }

// US dollars per million tokens: uncached input, output, and cache read, from
// the Anthropic list prices in the claude-api skill (cached 2026-09-25). A
// cache write is priced at 2 times input, the 1-hour TTL rate. The usage the
// engine reports does not split writes by TTL, but Claude Code's transcripts
// do. Across 400 of them, every main-loop write since 2026-09-01 was a 1-hour
// write, and priced that way a two-request probe matched the engine's own cost
// ledger to the cent. 0.5% of messages, from two desktop sessions in July and
// August, wrote 5-minute caches: there the write share reads up to 60% high.
const PRICES: Readonly<Record<string, readonly [input: number, output: number, cacheRead: number]>> = {
  'claude-fable-5-1': [10, 50, 0.25],
  'claude-mythos-5-1': [10, 50, 0.25],
  'claude-fable-5': [10, 50, 1],
  'claude-mythos-5': [10, 50, 1],
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-opus-5': [5, 25, 0.5],
  'claude-opus-4-8': [5, 25, 0.5],
  'claude-opus-4-7': [5, 25, 0.5],
  'claude-opus-4-6': [5, 25, 0.5],
  'claude-sonnet-5-5': [2, 10, 0.2],
  'claude-sonnet-5': [2, 10, 0.2],
  'claude-sonnet-4-6': [3, 15, 0.3],
  'claude-haiku-4-5': [1, 5, 0.1],
}
const CACHE_WRITE = 2

// The family id in a model id as the API reports it: no provider prefix
// ("anthropic.", "us."), no context tag ("[1m]"), no date or version suffix.
export const familyOf = (model: string): string =>
  model
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '')
    .replace(/^.*?(?=claude-)/, '')
    .replace(/-v\d+(:\d+)?$/, '')
    .replace(/[-@]\d{8}$/, '')

// The request's cost in US dollars, or undefined for a model with no price,
// so an unknown model never shows a made-up figure.
export function priceOf(usage: TurnUsage): number | undefined {
  const price = PRICES[familyOf(usage.model)]
  if (price === undefined) return undefined
  const [input, output, cacheRead] = price
  const dollars =
    usage.input_tokens * input +
    usage.output_tokens * output +
    usage.cache_read_input_tokens * cacheRead +
    usage.cache_creation_input_tokens * input * CACHE_WRITE
  return dollars / 1e6
}

// Two significant digits or more, so a cheap request never reads as $0.00.
const usd = (dollars: number): string => `$${dollars.toFixed(dollars >= 0.1 ? 2 : dollars >= 0.01 ? 3 : 4)}`

// How the latest request compares with the first. The baseline is the
// session's true first request and never moves, so when it carries no usable
// figure the line says why instead of comparing against a later request.
function againstFirst(first: RequestCost, last: number): string {
  if (first.usd === null) return 'first unpriced'
  if (first.usd === 0) return 'first $0'
  return `${(last / first.usd).toFixed(1)}× first`
}

export function statusOf(state: MeterState): string {
  const turns = `T${state.turns}`
  const { first, last } = state
  if (first === null || last === null) return turns
  if (last.usd === null) return `${turns} · ${last.model} unpriced`
  return `${turns} · ${usd(last.usd)}/req · ${againstFirst(first, last.usd)}`
}

export const countTurn = (state: MeterState): MeterState => ({ ...state, turns: state.turns + 1 })

// A request the API answered. The first one ever seen becomes the baseline,
// priced or not. A step with no usage got no response, so the API reported no
// cost and it never reaches here.
export function countRequest(state: MeterState, usage: TurnUsage): MeterState {
  const cost: RequestCost = { model: usage.model, usd: priceOf(usage) ?? null }
  return { ...state, first: state.first ?? cost, last: cost }
}
