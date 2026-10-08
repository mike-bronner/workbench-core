// The cache meter and its churn view (hooks/register.ts,
// hooks/mods/cache-meter.ts): each main-loop request's cache read against its
// cache creation, and at a creation spike, the system-prompt section whose text
// changed.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, TurnUsage } from 'claude-code'

import {
  EMPTY_CACHE,
  KEPT,
  cacheFactsOf,
  cacheRequestOf,
  changedSections,
  countCache,
  hashOf,
  hashesOf,
  hitOf,
  isSpike,
  recordFileOf,
} from '../hooks/mods/cache-meter'
import type { CacheState } from '../types'
import { start } from './harness'

const HOME = '/Users/tester'
const SID = '0f3c2a1e-5b7d-4c9e-8a6f-1d2e3f4a5b6c'
const RECORD = `${HOME}/.claude-workbench/cache-meter/${SID}.json`
// The facts a test composes the prompt for, as the engine would for a request.
const COMPOSE = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal' as const], tools: [], outputStyle: null, traits: [] }

type Section = { id: string; text: string; scope: 'shared' | 'session' }

// The engine beneath the meter: the session, each model request, the system
// prompt, and what the meter shows and writes.
type Probe = {
  sections: Section[]
  composeFails: boolean
  composed: number
  toasts: string[]
  files: Map<string, string>
  // The workbench facts of each status line drawn: the part after ` │ `.
  facts: (string | undefined)[]
  stepUsage: TurnUsage | null
}

function probe(on: On): Probe {
  const p: Probe = {
    sections: [
      { id: 'intro', text: 'You are Claude Code.', scope: 'shared' },
      { id: 'tools', text: 'Use the tools.', scope: 'shared' },
      { id: 'env_info_simple', text: 'Working directory: /repo', scope: 'session' },
    ],
    composeFails: false,
    composed: 0,
    toasts: [],
    files: new Map(),
    facts: [],
    stepUsage: null,
  }
  mock.env(on, { HOME })
  mock.clock(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: SID }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.step', async function* ($, e) {
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: p.stepUsage }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: p.stepUsage }
  })
  on('prompt.compose', () => {
    p.composed += 1
    if (p.composeFails) throw new Error('compose failed')
    return { sections: p.sections.map(section => ({ ...section })) }
  })
  on('ui.status', ($, e) => {
    p.facts.push(e.text?.split(' │ ')[1])
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    p.toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.write', ($, e) => {
    p.files.set(e.path, e.text)
    return { value: undefined }
  })
  return p
}

// One model request answered with `usage`, read to its end as the engine would.
async function request($: Engine, p: Probe, usage: TurnUsage, agentId?: string): Promise<void> {
  p.stepUsage = usage
  const stream = $.turn.step({ turnId: 't', index: 0, model: usage.model, messageCount: 1, agentId })
  while (!(await stream.next()).done);
}

const usage = (read: number, creation: number, input = 10): TurnUsage => ({
  input_tokens: input,
  output_tokens: 100,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: creation,
  model: 'claude-opus-5-5',
})

// The first request creates the cache, and steady ones read it.
const FIRST = usage(0, 20_000)
const STEADY = usage(20_000, 600)
// A request that cached the whole prompt again.
const SPIKE = usage(3_000, 21_000)

const record = (p: Probe): { count: number; requests: { n: number; hit: number | null }[]; churn: CacheState['churn'] } =>
  JSON.parse(p.files.get(RECORD) ?? 'null')

// The facts of the last status line drawn.
const lastFacts = (p: Probe): string | undefined => p.facts[p.facts.length - 1]

describe('AC5: the cache meter records each request, and a spike names the section that changed', () => {
  test('each main request is recorded with its read against its creation, and its hit share', async ($, on) => {
    const p = probe(on)
    await $.session.start(start(true))
    await request($, p, FIRST)
    await request($, p, STEADY)
    expect(record(p).requests).toEqual([
      { n: 1, read: 0, creation: 20_000, input: 10, hit: 0 },
      { n: 2, read: 20_000, creation: 600, input: 10, hit: 97 },
    ])
    expect(lastFacts(p)).toBe('cache 97%')
    // The prompt is read for the baseline, and again for a request that
    // created cache, but not for one that only read it.
    expect(p.composed).toBe(2)
    await request($, p, usage(20_600, 0))
    expect(p.composed).toBe(2)
  })

  test("a sub-agent's request is not the session's, and is left out", async ($, on) => {
    const p = probe(on)
    await $.session.start(start(true))
    await request($, p, FIRST)
    await request($, p, SPIKE, 'agent-1')
    expect(record(p).count).toBe(1)
    expect(p.composed).toBe(1)
  })

  test('a spike after a section changed names that section, in a toast and the record', async ($, on) => {
    const p = probe(on)
    await $.session.start(start(true))
    await request($, p, FIRST)
    await request($, p, STEADY)
    p.sections[2] = { id: 'env_info_simple', text: 'Working directory: /repo/sub', scope: 'session' }
    await request($, p, SPIKE)
    expect(record(p).churn).toEqual([{ n: 3, read: 3_000, creation: 21_000, sections: ['env_info_simple'] }])
    expect(p.toasts).toEqual([
      'Prompt cache churn at request 3: system-prompt section env_info_simple changed, and 21,000 tokens were cached again.',
    ])
    expect(lastFacts(p)).toBe('cache 12% · churn 1')
  })

  test('the next spike compares with the reading at the last spike, not with the first', async ($, on) => {
    const p = probe(on)
    await $.session.start(start(true))
    await request($, p, FIRST)
    p.sections[0] = { id: 'intro', text: 'You are Claude Code, v2.', scope: 'shared' }
    await request($, p, SPIKE)
    p.sections.push({ id: 'workbench-core:rules', text: 'new rules', scope: 'session' })
    await request($, p, SPIKE)
    expect(record(p).churn.map(event => event.sections)).toEqual([['intro'], ['workbench-core:rules']])
  })

  test('a spike with no section changed is recorded, and not shown', async ($, on) => {
    const p = probe(on)
    await $.session.start(start(true))
    await request($, p, FIRST)
    // The cache expired: the whole prompt is created again, unchanged.
    await request($, p, usage(0, 22_000))
    expect(record(p).churn).toEqual([{ n: 2, read: 0, creation: 22_000, sections: [] }])
    expect(p.toasts).toEqual([])
    expect(lastFacts(p)).toBe('cache 0%')
  })

  test('a change that cost no spike is not blamed on a later spike', async ($, on) => {
    const p = probe(on)
    await $.session.start(start(true))
    await request($, p, FIRST)
    // A short section change: the tail it re-created stays under a spike.
    p.sections[2] = { id: 'env_info_simple', text: 'Working directory: /repo/sub', scope: 'session' }
    await request($, p, usage(20_000, 800))
    // Later the cache expires, and the whole prompt is created again.
    await request($, p, usage(0, 22_000))
    expect(record(p).churn).toEqual([{ n: 3, read: 0, creation: 22_000, sections: [] }])
    expect(p.toasts).toEqual([])
  })

  test('a prompt that cannot be read claims no section, and the next reading still compares', async ($, on) => {
    const p = probe(on)
    await $.session.start(start(true))
    await request($, p, FIRST)
    p.composeFails = true
    await request($, p, SPIKE)
    p.composeFails = false
    p.sections[1] = { id: 'tools', text: 'Use the tools well.', scope: 'shared' }
    await request($, p, SPIKE)
    expect(record(p).churn.map(event => event.sections)).toEqual([null, ['tools']])
    expect(p.toasts).toHaveLength(1)
  })

  test('nothing the meter does changes the system prompt', async ($, on) => {
    const p = probe(on)
    await $.session.start(start(true))
    // The module's own rule sections (tests/prompt-rules.test.ts) are left out:
    // what is pinned here is that the meter changes none of the engine's.
    const engines = (sections: readonly Section[]) => sections.filter(section => !section.id.startsWith('workbench-core:'))
    const before = engines((await $.prompt.compose(COMPOSE)).sections)
    await request($, p, FIRST)
    p.sections[2] = { id: 'env_info_simple', text: 'Working directory: /elsewhere', scope: 'session' }
    await request($, p, SPIKE)
    const after = engines((await $.prompt.compose(COMPOSE)).sections)
    expect(before).toEqual([
      { id: 'intro', text: 'You are Claude Code.', scope: 'shared' },
      { id: 'tools', text: 'Use the tools.', scope: 'shared' },
      { id: 'env_info_simple', text: 'Working directory: /repo', scope: 'session' },
    ])
    expect(after).toEqual(p.sections)
  })

  test('an unattended session keeps the record in memory, writes no file, and shows nothing', async ($, on) => {
    const p = probe(on)
    await $.session.start(start(false))
    await request($, p, FIRST)
    p.sections[0] = { id: 'intro', text: 'changed', scope: 'shared' }
    await request($, p, SPIKE)
    expect(p.files.size).toBe(0)
    expect(p.toasts).toEqual([])
    expect(p.composed).toBe(2)
  })

  test('a /clear starts the meter over, so its first request is a baseline again', async ($, on) => {
    const p = probe(on)
    await $.session.start(start(true))
    await request($, p, FIRST)
    await request($, p, STEADY)
    await $.session.end({ reason: 'clear', sessionId: 's', resume: {} as never })
    await request($, p, SPIKE)
    expect(record(p).requests.map(entry => entry.n)).toEqual([1])
    expect(record(p).churn).toEqual([])
  })
})

describe('AC5: the pure parts of the meter', () => {
  test('a hash is the same for the same text, and differs for a change of one character', () => {
    expect(hashOf('You are Claude Code.')).toBe(hashOf('You are Claude Code.'))
    expect(hashOf('You are Claude Code.')).not.toBe(hashOf('You are Claude Code!'))
    expect(hashOf('')).toMatch(/^[0-9a-f]{8}$/)
  })

  test('the changed sections are the new and changed ones in prompt order, then the gone ones', () => {
    const before = hashesOf([
      { id: 'a', text: '1' },
      { id: 'b', text: '2' },
      { id: 'c', text: '3' },
    ])
    const after = hashesOf([
      { id: 'c', text: '3!' },
      { id: 'a', text: '1' },
      { id: 'd', text: '4' },
    ])
    expect(changedSections(before, after)).toEqual(['c', 'd', 'b'])
    expect(changedSections(before, before)).toEqual([])
  })

  test('a spike is past the first request, at least 1,024 tokens created, and more created than read', () => {
    expect(isSpike(cacheRequestOf(1, usage(0, 50_000)))).toBe(false)
    expect(isSpike(cacheRequestOf(2, usage(0, 1024)))).toBe(true)
    expect(isSpike(cacheRequestOf(2, usage(0, 1023)))).toBe(false)
    expect(isSpike(cacheRequestOf(2, usage(5_000, 5_000)))).toBe(false)
    expect(isSpike(cacheRequestOf(2, usage(5_000, 5_001)))).toBe(true)
  })

  test('the hit share counts uncached input, and a request with no input has none', () => {
    expect(hitOf(cacheRequestOf(1, usage(90, 0, 10)))).toBe(90)
    expect(hitOf(cacheRequestOf(1, usage(0, 0, 0)))).toBeUndefined()
    expect(cacheFactsOf(countCache(EMPTY_CACHE, cacheRequestOf(1, usage(0, 0, 0))))).toEqual([])
    expect(cacheFactsOf(EMPTY_CACHE)).toEqual([])
  })

  test('the record keeps the latest requests only', () => {
    let state = EMPTY_CACHE
    for (let n = 1; n <= KEPT + 5; n++) state = countCache(state, cacheRequestOf(n, STEADY))
    expect(state.count).toBe(KEPT + 5)
    expect(state.requests).toHaveLength(KEPT)
    expect(state.requests[0]?.n).toBe(6)
  })

  test('the record file is named only from a plain session id under an absolute home', () => {
    expect(recordFileOf(HOME, SID)).toBe(RECORD)
    expect(recordFileOf(`${HOME}/`, SID)).toBe(RECORD)
    expect(recordFileOf(undefined, SID)).toBeUndefined()
    expect(recordFileOf('relative/home', SID)).toBeUndefined()
    expect(recordFileOf(HOME, '../../etc/passwd')).toBeUndefined()
    expect(recordFileOf(HOME, '')).toBeUndefined()
  })
})
