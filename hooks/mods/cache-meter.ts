// The cache meter and its churn view.
//
// Every main-loop API request is recorded with its cache read against its
// cache creation, as the API reported them for that response. The status line
// shows the latest request's hit share ("cache 97%"). A request that creates
// more than it reads, past the first, is a creation spike: something before
// the cached tail changed, or the cache expired. The meter then hashes each
// section of the system prompt and names the sections whose hash changed since
// the last reading, which is the churn the mods plan's first design rule asks
// to find. A spike with no changed section was not the system prompt's doing:
// an expired cache, a compaction, or a large tool result. It is recorded, and
// only a spike that names a section is shown to Mike.
//
// Nothing here writes to the system prompt. The figures change every request,
// so they go to the status line, a toast and a file under ~/.claude-workbench,
// all of which the model never reads.
//
// Pure functions only: the engine follows `$` into no imported function, so the
// hooks that keep the records live in hooks/register.ts.

import type { TurnUsage } from 'claude-code'

import type { CacheRequest, CacheState, ChurnEvent } from '../../types'

// The section hashes of a reading, by section id.
export type SectionHashes = Readonly<Record<string, string>>

export const EMPTY_CACHE: CacheState = { count: 0, requests: [], churn: [], hashes: null }

// The record keeps the latest requests only, so a long session stays small.
// types/index.d.ts states the same figure.
export const KEPT = 500
// Below this, a request is too small to be a spike: the API caches no prefix
// shorter than about 1,024 tokens.
export const SPIKE_MIN = 1024

// FNV-1a over the UTF-16 code units, as eight hex digits. Two texts that differ
// almost always hash apart, and the same text always hashes the same.
export function hashOf(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export const hashesOf = (sections: readonly { id: string; text: string }[]): Record<string, string> =>
  Object.fromEntries(sections.map(section => [section.id, hashOf(section.text)]))

// The sections whose text changed, or that are new, in prompt order, then the
// sections that went away.
export function changedSections(before: SectionHashes, after: SectionHashes): string[] {
  const changed = Object.keys(after).filter(id => before[id] !== after[id])
  const gone = Object.keys(before).filter(id => !(id in after))
  return [...changed, ...gone]
}

export function cacheRequestOf(n: number, usage: TurnUsage): CacheRequest {
  return { n, read: usage.cache_read_input_tokens, creation: usage.cache_creation_input_tokens, input: usage.input_tokens }
}

export const countCache = (state: CacheState, request: CacheRequest): CacheState => ({
  ...state,
  count: request.n,
  requests: [...state.requests, request].slice(-KEPT),
})

// The share of the request's input read from the cache, in whole percent.
// Undefined for a request with no input.
export function hitOf(request: CacheRequest): number | undefined {
  const total = request.read + request.creation + request.input
  return total === 0 ? undefined : Math.round((100 * request.read) / total)
}

// Whether the request re-created more of the prompt than it read. The first
// request creates the cache by design, so it is never a spike.
export const isSpike = (request: CacheRequest): boolean =>
  request.n > 1 && request.creation >= SPIKE_MIN && request.creation > request.read

export const withChurn = (state: CacheState, event: ChurnEvent): CacheState => ({ ...state, churn: [...state.churn, event] })

// The spikes that named a changed section.
export const sectionChurn = (state: CacheState): readonly ChurnEvent[] =>
  state.churn.filter(event => event.sections !== null && event.sections.length > 0)

// The status line's facts: the latest hit share, and the number of spikes a
// section change caused, when there was one.
export function cacheFactsOf(state: CacheState): string[] {
  const last = state.requests[state.requests.length - 1]
  const hit = last === undefined ? undefined : hitOf(last)
  if (hit === undefined) return []
  const churned = sectionChurn(state).length
  return churned > 0 ? [`cache ${hit}%`, `churn ${churned}`] : [`cache ${hit}%`]
}

const tokens = (n: number): string => n.toLocaleString('en-US')

// The toast for a spike that named a section.
export function churnText(event: ChurnEvent): string {
  const names = (event.sections ?? []).join(', ')
  const noun = (event.sections ?? []).length === 1 ? 'section' : 'sections'
  return `Prompt cache churn at request ${event.n}: system-prompt ${noun} ${names} changed, and ${tokens(event.creation)} tokens were cached again.`
}

// What the record file holds: every kept request with its hit share, and every
// spike. Stable key order, so two writes of one state are byte-identical.
export function recordOf(state: CacheState): string {
  const requests = state.requests.map(request => ({ ...request, hit: hitOf(request) ?? null }))
  return `${JSON.stringify({ count: state.count, requests, churn: state.churn }, null, 1)}\n`
}

// The record file for a session, or undefined when the session id or home
// cannot name one safely.
export function recordFileOf(home: string | undefined, sessionId: string): string | undefined {
  if (!home || !home.startsWith('/') || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(sessionId)) return undefined
  return `${home.replace(/\/+$/, '')}/.claude-workbench/cache-meter/${sessionId}.json`
}
