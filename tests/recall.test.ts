// Recall (hooks/register.ts, hooks/mods/recall.ts): vault hits for a prompt or
// a content search, through the memory MCP, filtered by a score threshold, the
// note types, a per-session dedupe set and a classifier relevance pass with a
// fallback, and injected as one block at the tail, beside the prompt or the
// tool result. hooks/test-scan-query.sh covers the query a search carries.

import { describe, expect, test } from 'claude-code/testing'

import {
  CLASSIFY_TIMEOUT_MS,
  PROGRESS_MIN_SCORE,
  PROGRESS_TIMEOUT_MS,
  PROMPT_MIN_SCORE,
  SCAN_MIN_SCORE,
  blockOf,
  candidatesOf,
  hitsOf,
  mayScan,
  noteOf,
  openProgressOf,
  promptQuery,
  relevantOf,
  scanQuery,
  vaultPathOf,
} from '../hooks/mods/recall'
import type { Row } from './memory-world'
import { HOME, memoryWorld, prompt, runsOf, start } from './memory-world'

const TASK = 'make the session log checkpoint on every turn'
const row = (path: string, score: number, type = 'insight', summary = `About ${path}.`): Row => ({
  path,
  title: path.replace(/^.*\/|\.md$/g, ''),
  score,
  frontmatter: { type, summary },
})
const HITS = [row('insights/a.md', 0.032), row('decisions/b.md', 0.028, 'decision'), row('insights/c.md', 0.025)]
const searches = (w: { mcp: { tool: string; args: Record<string, unknown> }[] }) => w.mcp.filter(call => call.tool === 'search')
const recallSearches = (w: { mcp: { tool: string; args: Record<string, unknown> }[] }) => searches(w).filter(call => call.args.filters === undefined)
const progressSearches = (w: { mcp: { tool: string; args: Record<string, unknown> }[] }) => searches(w).filter(call => call.args.filters !== undefined)
const blockIn = (context: readonly string[] | undefined) => context?.find(text => text.startsWith('🧠')) ?? ''
const progressIn = (context: readonly string[] | undefined) => context?.find(text => text.startsWith('📌')) ?? ''
const progress = (path: string, score: number, taskStatus: string, updated = '2026-10-27', type = 'progress'): Row => ({
  path,
  title: path.replace(/^.*\/|\.md$/g, ''),
  score,
  frontmatter: { type, task_status: taskStatus, updated, summary: `Where ${path} stands.` },
})

describe('AC5: recall runs in the module and injects only passing hits, at the tail', () => {
  test('a prompt searches the vault through the MCP and gets one block beside it', async ($, on) => {
    const w = memoryWorld(on)
    w.rows = HITS
    await $.session.start(start())
    await $.prompt.submit(prompt(TASK))
    expect(recallSearches(w)).toEqual([{ tool: 'search', args: { query: TASK, limit: 8 } }])
    const context = w.prompts[0]?.context
    expect(context).toHaveLength(1)
    expect(blockIn(context)).toContain('(insights/a.md)')
    expect(blockIn(context)).toContain('(decisions/b.md)')
    expect(blockIn(context)).not.toContain('insights/c.md')
    expect(w.prompts[0]?.text).toBe(TASK)
  })

  test('a hit below the threshold, or of a type not recalled, is dropped', async ($, on) => {
    const w = memoryWorld(on)
    w.rows = [row('insights/weak.md', PROMPT_MIN_SCORE - 0.0001), row('sessions/x.summary.md', 0.03, 'session'), row('insights/strong.md', PROMPT_MIN_SCORE)]
    await $.session.start(start())
    await $.prompt.submit(prompt(TASK))
    const block = blockIn(w.prompts[0]?.context)
    expect(block).toContain('insights/strong.md')
    expect(block).not.toContain('weak.md')
    expect(block).not.toContain('summary.md')
  })

  test('the classifier drops what it calls unrelated, and keeps what it cannot label', async ($, on) => {
    const w = memoryWorld(on)
    w.rows = HITS
    w.classify = text => (text.includes('insights/a') || text.includes('Note: a ') ? 'unrelated' : undefined)
    await $.session.start(start())
    await $.prompt.submit(prompt(TASK))
    expect(w.classified).toHaveLength(2)
    expect(w.classified[0]).toContain(`Task: ${TASK}`)
    const block = blockIn(w.prompts[0]?.context)
    expect(block).not.toContain('insights/a.md')
    expect(block).toContain('decisions/b.md')
  })

  test('every hit unrelated injects nothing', async ($, on) => {
    const w = memoryWorld(on)
    w.rows = HITS
    w.classify = () => 'unrelated'
    await $.session.start(start())
    await $.prompt.submit(prompt(TASK))
    expect(w.prompts[0]?.context).toBeUndefined()
  })

  test('a classifier that fails falls back to the unfiltered hits', async ($, on) => {
    const w = memoryWorld(on)
    w.rows = HITS
    w.classify = text => (text.includes('Note: a ') ? 'unrelated' : new Error('overloaded'))
    await $.session.start(start())
    await $.prompt.submit(prompt(TASK))
    const block = blockIn(w.prompts[0]?.context)
    expect(block).toContain('insights/a.md')
    expect(block).toContain('decisions/b.md')
    expect(w.logs.at(-1)).toContain('classifier fallback')
  })

  test('a classifier past its timeout falls back too, and the prompt waits no longer', async ($, on) => {
    const w = memoryWorld(on)
    w.rows = HITS
    w.classify = () => 'hang'
    await $.session.start(start())
    const submitted = $.prompt.submit(prompt(TASK))
    await w.clock.advance(CLASSIFY_TIMEOUT_MS - 1)
    expect(w.prompts).toEqual([])
    await w.clock.advance(1)
    await submitted
    expect(blockIn(w.prompts[0]?.context)).toContain('insights/a.md')
  })

  test('a note is shown once per session, and /clear starts the set over', async ($, on) => {
    const w = memoryWorld(on)
    w.rows = HITS
    await $.session.start(start())
    await $.prompt.submit(prompt(TASK))
    await $.prompt.submit(prompt(`${TASK}, again please`))
    expect(blockIn(w.prompts[1]?.context)).toContain('insights/c.md')
    expect(blockIn(w.prompts[1]?.context)).not.toContain('insights/a.md')
    expect(blockIn(w.prompts[1]?.context)).not.toContain('decisions/b.md')
    await $.prompt.submit(prompt(`${TASK}, and the reconciler`))
    expect(w.prompts[2]?.context).toBeUndefined()
    await $.session.end({ reason: 'clear', sessionId: w.sid, resume: { id: w.sid } })
    await $.prompt.submit(prompt(TASK))
    expect(blockIn(w.prompts[3]?.context)).toContain('insights/a.md')
  })

  test('the search attempt is stamped for the warmup liveness check', async ($, on) => {
    const w = memoryWorld(on)
    await $.session.start(start())
    await $.prompt.submit(prompt(TASK))
    expect(w.files.get(`${HOME}/.claude-workbench/memory-recall/last-attempt`)).toBe(`${Math.floor(w.clock.now() / 1000)}\n`)
  })

  for (const [name, text, origin, isInteractive, env] of [
    ['a slash command', '/memory-status please now', undefined, true, {}],
    ['an acknowledgement', 'yes', undefined, true, {}],
    ['a short prompt', 'fix it now', undefined, true, {}],
    ['a scheduled tick', '<scheduled-task name="x">make the log checkpoint each turn</scheduled-task>', undefined, true, {}],
    ['a peer message', TASK, { kind: 'peer' }, true, {}],
    ['an unattended session', TASK, undefined, false, {}],
    ['WORKBENCH_MEMORY_RECALL=0', TASK, undefined, true, { WORKBENCH_MEMORY_RECALL: '0' }],
  ] as const) {
    test(`${name} gets no search and no block`, async ($, on) => {
      const w = memoryWorld(on, env)
      w.rows = HITS
      await $.session.start(start(isInteractive))
      await $.prompt.submit(origin === undefined ? prompt(text) : prompt(text, origin as never))
      expect(searches(w)).toEqual([])
      expect(w.prompts[0]?.context).toBeUndefined()
    })
  }

  test('a search error or a server that does not connect leaves the prompt as it was', async ($, on) => {
    const w = memoryWorld(on)
    w.rows = 'error'
    await $.session.start(start())
    await $.prompt.submit(prompt(TASK))
    w.connects = false
    await $.prompt.submit(prompt(`${TASK} once more`))
    expect(w.prompts.map(p => p.context)).toEqual([undefined, undefined])
  })

  test('the figures go to the debug log, never to the model', async ($, on) => {
    const w = memoryWorld(on)
    w.rows = HITS
    await $.session.start(start())
    await $.prompt.submit(prompt(TASK))
    expect(w.logs).toHaveLength(1)
    expect(w.logs[0]).toMatch(/^workbench recall: 2 of 2 hits, about \d+ tokens, \d+ ms$/)
    expect(blockIn(w.prompts[0]?.context)).not.toContain('tokens')
  })
})

describe('the first prompt gets the open progress notes that match it, and their hubs', () => {
  const OPEN_SEARCH = { tool: 'search', args: { query: TASK, limit: 12, filters: { type: 'progress', task_status: 'open' } } }
  const ANY_SEARCH = { tool: 'search', args: { query: TASK, limit: 12, filters: { type: 'progress' } } }
  const reads = (w: { mcp: { tool: string; args: Record<string, unknown> }[] }) => w.mcp.filter(call => call.tool === 'read').map(call => call.args.path)
  const hub = (status = 'open', type = 'progress') => ({ title: 'course-hub', frontmatter: { type, task_status: status, updated: '2026-10-27', summary: 'Standing steps for every task in the series.' } })

  test('open progress notes ride the first prompt by name, summary and updated date, with a staleness caution', async ($, on) => {
    const w = memoryWorld(on)
    w.rows = [progress('progress/course-hub.md', 0.03, 'open', '2026-10-27'), progress('progress/side-task.md', PROGRESS_MIN_SCORE, 'open', '2026-11-09')]
    await $.session.start(start())
    await $.prompt.submit(prompt(TASK))
    expect(progressSearches(w)).toEqual([OPEN_SEARCH, ANY_SEARCH])
    const lines = progressIn(w.prompts[0]?.context).split('\n')
    expect(lines[0]).toContain('They reflect what was true when written, so verify them before acting.')
    expect(lines.slice(1)).toEqual([
      '• course-hub - Where progress/course-hub.md stands. (updated 2026-10-27) (progress/course-hub.md)',
      '• side-task - Where progress/side-task.md stands. (updated 2026-11-09) (progress/side-task.md)',
    ])
    expect(w.classified.filter(text => text.includes('[progress]'))).toHaveLength(2)
    expect(w.classified.every(text => text.includes(`Task: ${TASK}`))).toBe(true)
  })

  test('the live case: an ended child that ranks high brings its open hub that ranks low, and nothing else rides along', async ($, on) => {
    const w = memoryWorld(on)
    w.rows = [
      { ...progress('progress/child-task.md', 0.0325, 'ended'), frontmatter: { ...progress('progress/child-task.md', 0, 'ended').frontmatter, parent: 'progress/course-hub.md' } },
      progress('progress/old-ended.md', 0.031, 'ended'),
      progress('progress/unrelated-a.md', 0.0164, 'open'),
      progress('progress/unrelated-b.md', 0.0159, 'open'),
      progress('progress/course-hub.md', 0.01408, 'open'),
    ]
    w.notes = { 'progress/course-hub.md': hub() }
    await $.session.start(start())
    await $.prompt.submit(prompt(TASK))
    expect(reads(w)).toEqual(['progress/course-hub.md'])
    const lines = progressIn(w.prompts[0]?.context).split('\n')
    expect(lines.slice(1)).toEqual(['• course-hub - Standing steps for every task in the series. (updated 2026-10-27) (progress/course-hub.md)'])
  })

  const hubAndOpen = (w: ReturnType<typeof memoryWorld>) => {
    w.rows = [
      { ...progress('progress/child-task.md', 0.03, 'ended'), frontmatter: { ...progress('progress/child-task.md', 0, 'ended').frontmatter, parent: 'progress/course-hub.md' } },
      progress('progress/keyword-match.md', 0.032, 'open'),
      progress('progress/on-topic.md', 0.028, 'open'),
    ]
    w.notes = { 'progress/course-hub.md': hub() }
  }
  const shownPaths = (w: ReturnType<typeof memoryWorld>) =>
    progressIn(w.prompts[0]?.context)
      .split('\n')
      .slice(1)
      .map(line => line.replace(/^.*\(/, '').replace(/\)$/, ''))

  test('a direct open hit the relevance check rejects is never shown, one it accepts is, and the hub is never checked', async ($, on) => {
    const w = memoryWorld(on)
    hubAndOpen(w)
    w.classify = text => (text.includes('keyword-match') ? 'unrelated' : 'relevant')
    await $.session.start(start())
    await $.prompt.submit(prompt(TASK))
    expect(shownPaths(w)).toEqual(['progress/course-hub.md', 'progress/on-topic.md'])
    expect(w.classified.filter(text => text.includes('[progress]'))).toHaveLength(2)
    expect(w.classified.some(text => text.includes('course-hub'))).toBe(false)
  })

  for (const [name, classify] of [
    ['a check that fails', () => new Error('overloaded')],
    ['a check that gives no label', () => undefined],
  ] as const) {
    test(`${name} shows the hubs alone, and the prompt goes through`, async ($, on) => {
      const w = memoryWorld(on)
      hubAndOpen(w)
      w.classify = text => (text.includes('[progress]') ? classify() : 'relevant')
      await $.session.start(start())
      await $.prompt.submit(prompt(TASK))
      expect(shownPaths(w)).toEqual(['progress/course-hub.md'])
      expect(w.prompts[0]?.text).toBe(TASK)
      expect(w.prompts[0]?.context?.join('\n')).not.toMatch(/error|overloaded/i)
    })
  }

  test('one deadline covers the searches and the check: a late search leaves the check only what remains', async ($, on) => {
    const w = memoryWorld(on)
    hubAndOpen(w)
    w.searchDelayMs = args => (args.filters === undefined ? 0 : 1400)
    w.classify = text => (text.includes('[progress]') ? 'hang' : 'relevant')
    await $.session.start(start())
    const submitted = $.prompt.submit(prompt(TASK))
    await w.clock.advance(1400)
    await w.clock.advance(PROGRESS_TIMEOUT_MS - 1 - 1400)
    expect(w.prompts).toEqual([])
    await w.clock.advance(1)
    await submitted
    expect(shownPaths(w)).toEqual(['progress/course-hub.md'])
  })

  test('when the top open hits are rejected, a lower-ranked one the check accepts fills the slot', async ($, on) => {
    const w = memoryWorld(on)
    w.rows = [
      { ...progress('progress/child-task.md', 0.03, 'ended'), frontmatter: { ...progress('progress/child-task.md', 0, 'ended').frontmatter, parent: 'progress/course-hub.md' } },
      progress('progress/first.md', 0.04, 'open'),
      progress('progress/second.md', 0.035, 'open'),
      progress('progress/third.md', 0.03, 'open'),
      progress('progress/fourth.md', 0.025, 'open'),
      progress('progress/fifth.md', 0.022, 'open'),
    ]
    w.notes = { 'progress/course-hub.md': hub() }
    w.classify = text => (text.includes('[progress]') && !/fourth|fifth/.test(text) ? 'unrelated' : 'relevant')
    await $.session.start(start())
    await $.prompt.submit(prompt(TASK))
    expect(w.classified.filter(text => text.includes('[progress]'))).toHaveLength(5)
    expect(shownPaths(w)).toEqual(['progress/course-hub.md', 'progress/fourth.md', 'progress/fifth.md'])
  })

  test('an ended or unreadable parent does not take a slot from a valid one', async ($, on) => {
    const w = memoryWorld(on)
    const child = (path: string, score: number, parent: string): Row => ({ ...progress(path, score, 'ended'), frontmatter: { ...progress(path, 0, 'ended').frontmatter, parent } })
    w.rows = [
      child('progress/a.md', 0.04, 'progress/ended-hub.md'),
      child('progress/b.md', 0.035, 'progress/missing-hub.md'),
      child('progress/c.md', 0.03, 'progress/insight-hub.md'),
      child('progress/d.md', 0.025, 'progress/course-hub.md'),
    ]
    w.notes = { 'progress/ended-hub.md': hub('ended'), 'progress/insight-hub.md': hub('open', 'insight'), 'progress/course-hub.md': hub() }
    await $.session.start(start())
    await $.prompt.submit(prompt(TASK))
    expect(shownPaths(w)).toEqual(['progress/course-hub.md'])
  })

  test('hubs that fill every slot leave nothing to check', async ($, on) => {
    const w = memoryWorld(on)
    const child = (path: string, parent: string): Row => ({ ...progress(path, 0.03, 'ended'), frontmatter: { ...progress(path, 0, 'ended').frontmatter, parent } })
    w.rows = [child('progress/a.md', 'progress/hub-a.md'), child('progress/b.md', 'progress/hub-b.md'), child('progress/c.md', 'progress/hub-c.md'), progress('progress/open.md', 0.03, 'open')]
    w.notes = { 'progress/hub-a.md': hub(), 'progress/hub-b.md': hub(), 'progress/hub-c.md': hub() }
    await $.session.start(start())
    await $.prompt.submit(prompt(TASK))
    expect(shownPaths(w)).toEqual(['progress/hub-a.md', 'progress/hub-b.md', 'progress/hub-c.md'])
    expect(w.classified.filter(text => text.includes('[progress]'))).toEqual([])
  })

  test('a hub with no summary shows the start of its body', async ($, on) => {
    const w = memoryWorld(on)
    w.rows = [{ ...progress('progress/child-task.md', 0.03, 'ended'), frontmatter: { ...progress('progress/child-task.md', 0, 'ended').frontmatter, parent: 'progress/course-hub.md' } }]
    w.notes = { 'progress/course-hub.md': { title: 'course-hub', frontmatter: { type: 'progress', task_status: 'open', updated: '2026-10-27' }, content: '\n1. Start the next task.\n2. Read the watchlist first.\n' } }
    await $.session.start(start())
    await $.prompt.submit(prompt(TASK))
    expect(progressIn(w.prompts[0]?.context).split('\n')[1]).toBe('• course-hub - 1. Start the next task. 2. Read the watchlist first. (updated 2026-10-27) (progress/course-hub.md)')
  })

  test('a check past the budget shows the hubs alone, no later than the budget, and the search is not run again', async ($, on) => {
    const w = memoryWorld(on)
    hubAndOpen(w)
    w.classify = text => (text.includes('[progress]') ? 'hang' : 'relevant')
    await $.session.start(start())
    const submitted = $.prompt.submit(prompt(TASK))
    await w.clock.advance(PROGRESS_TIMEOUT_MS - 1)
    expect(w.prompts).toEqual([])
    await w.clock.advance(1)
    await submitted
    expect(shownPaths(w)).toEqual(['progress/course-hub.md'])
    await $.prompt.submit(prompt(`${TASK}, again please`))
    expect(progressSearches(w)).toHaveLength(2)
  })

  test('a hub is shown once, first, even when it matches on its own too', async ($, on) => {
    const w = memoryWorld(on)
    w.rows = [
      { ...progress('progress/child-task.md', 0.03, 'open'), frontmatter: { ...progress('progress/child-task.md', 0, 'open').frontmatter, parent: '/progress/course-hub.md' } },
      progress('progress/course-hub.md', 0.025, 'open'),
    ]
    w.notes = { 'progress/course-hub.md': hub() }
    await $.session.start(start())
    await $.prompt.submit(prompt(TASK))
    const paths = progressIn(w.prompts[0]?.context).split('\n').slice(1).map(line => line.replace(/^.*\(/, '').replace(/\)$/, ''))
    expect(paths).toEqual(['progress/course-hub.md', 'progress/child-task.md'])
  })

  for (const [name, note] of [
    ['an ended hub', hub('ended')],
    ['a hub of another type', hub('open', 'insight')],
    ['a hub that cannot be read', undefined],
  ] as const) {
    test(`${name} is not shown`, async ($, on) => {
      const w = memoryWorld(on)
      w.rows = [{ ...progress('progress/child-task.md', 0.03, 'ended'), frontmatter: { ...progress('progress/child-task.md', 0, 'ended').frontmatter, parent: 'progress/course-hub.md' } }]
      w.notes = note === undefined ? {} : { 'progress/course-hub.md': note }
      await $.session.start(start())
      await $.prompt.submit(prompt(TASK))
      expect(reads(w)).toEqual(['progress/course-hub.md'])
      expect(w.prompts[0]?.context).toBeUndefined()
    })
  }

  test('a weak child, or a parent that is not a vault note path, reads nothing', async ($, on) => {
    const w = memoryWorld(on)
    const child = (path: string, score: number, parent: string): Row => ({ ...progress(path, score, 'ended'), frontmatter: { ...progress(path, 0, 'ended').frontmatter, parent } })
    w.rows = [
      child('progress/weak.md', PROGRESS_MIN_SCORE - 0.0001, 'progress/hub-a.md'),
      child('progress/climbs.md', 0.03, '../outside/hub.md'),
      child('progress/not-a-note.md', 0.03, 'progress/hub.txt'),
      child('progress/self.md', 0.03, 'progress/self.md'),
    ]
    w.notes = { 'progress/hub-a.md': hub() }
    await $.session.start(start())
    await $.prompt.submit(prompt(TASK))
    expect(reads(w)).toEqual([])
    expect(w.prompts[0]?.context).toBeUndefined()
  })

  test('an ended note, a note of another type, a note with no status and a weak hit are never injected, whatever the server returns', async ($, on) => {
    const w = memoryWorld(on)
    w.ignoresFilters = true
    w.rows = [
      progress('progress/ended.md', 0.03, 'ended'),
      progress('insights/open-insight.md', 0.03, 'open', '2026-10-27', 'insight'),
      row('progress/no-status.md', 0.03, 'progress'),
      progress('progress/weak.md', PROGRESS_MIN_SCORE - 0.0001, 'open'),
      progress('progress/kept.md', PROGRESS_MIN_SCORE, 'open'),
    ]
    await $.session.start(start())
    await $.prompt.submit(prompt(TASK))
    const block = progressIn(w.prompts[0]?.context)
    expect(block).toContain('(progress/kept.md)')
    expect(block).not.toContain('ended.md')
    expect(block).not.toContain('open-insight.md')
    expect(block).not.toContain('no-status.md')
    expect(block).not.toContain('weak.md')
  })

  test('nothing open that matches injects no progress block', async ($, on) => {
    const w = memoryWorld(on)
    w.rows = [progress('progress/ended.md', 0.03, 'ended')]
    await $.session.start(start())
    await $.prompt.submit(prompt(TASK))
    expect(w.prompts[0]?.context).toBeUndefined()
  })

  test('at most three notes ride the prompt', async ($, on) => {
    const w = memoryWorld(on)
    w.rows = ['a', 'b', 'c', 'd'].map(name => progress(`progress/${name}.md`, 0.03, 'open'))
    await $.session.start(start())
    await $.prompt.submit(prompt(TASK))
    expect(progressIn(w.prompts[0]?.context).split('\n')).toHaveLength(4)
  })

  test('a search that returned is not run again, and ordinary recall goes on', async ($, on) => {
    const w = memoryWorld(on)
    w.rows = [progress('progress/course-hub.md', 0.03, 'open'), ...HITS]
    await $.session.start(start())
    await $.prompt.submit(prompt(TASK))
    await $.prompt.submit(prompt(`${TASK}, again please`))
    expect(progressSearches(w)).toHaveLength(2)
    expect(recallSearches(w)).toHaveLength(2)
    expect(progressIn(w.prompts[0]?.context)).toContain('course-hub')
    expect(progressIn(w.prompts[1]?.context)).toBe('')
    expect(blockIn(w.prompts[1]?.context)).toContain('insights/c.md')
  })

  test('a search that returned nothing is not run again either', async ($, on) => {
    const w = memoryWorld(on)
    await $.session.start(start())
    await $.prompt.submit(prompt(TASK))
    w.rows = [progress('progress/course-hub.md', 0.03, 'open')]
    await $.prompt.submit(prompt(`${TASK}, again please`))
    expect(progressSearches(w)).toHaveLength(2)
    expect(w.prompts[1]?.context).toBeUndefined()
  })

  test('a prompt with no query does not use up the first-prompt search', async ($, on) => {
    const w = memoryWorld(on)
    w.rows = [progress('progress/course-hub.md', 0.03, 'open')]
    await $.session.start(start())
    await $.prompt.submit(prompt('yes'))
    await $.prompt.submit(prompt(TASK))
    expect(progressIn(w.prompts[1]?.context)).toContain('course-hub')
  })

  test('/clear starts a new conversation, which gets the progress search again', async ($, on) => {
    const w = memoryWorld(on)
    w.rows = [progress('progress/course-hub.md', 0.03, 'open')]
    await $.session.start(start())
    await $.prompt.submit(prompt(TASK))
    await $.session.end({ reason: 'clear', sessionId: w.sid, resume: { id: w.sid } })
    await $.prompt.submit(prompt(TASK))
    expect(progressIn(w.prompts[1]?.context)).toContain('course-hub')
  })

  for (const fail of ['error', 'disconnected', 'throws'] as const) {
    test(`a search that ${fail === 'error' ? 'answers an error' : fail === 'throws' ? 'throws' : 'has no server'} leaves the prompt as it was, and runs again on the next prompt`, async ($, on) => {
      const w = memoryWorld(on)
      const rows = [progress('progress/course-hub.md', 0.03, 'open')]
      w.rows = fail === 'error' ? 'error' : rows
      w.connects = fail !== 'disconnected'
      w.searchFails = () => fail === 'throws'
      await $.session.start(start())
      await $.prompt.submit(prompt(TASK))
      expect(w.prompts).toEqual([{ text: TASK, context: undefined }])
      expect(w.logs).toEqual([])
      w.rows = rows
      w.connects = true
      w.searchFails = undefined
      await $.prompt.submit(prompt(`${TASK}, again please`))
      expect(progressIn(w.prompts[1]?.context)).toContain('course-hub')
    })
  }

  test('a progress search that fails leaves ordinary recall in place', async ($, on) => {
    const w = memoryWorld(on)
    w.rows = HITS
    w.searchFails = args => args.filters !== undefined
    await $.session.start(start())
    await $.prompt.submit(prompt(TASK))
    expect(progressIn(w.prompts[0]?.context)).toBe('')
    expect(blockIn(w.prompts[0]?.context)).toContain('insights/a.md')
  })

  test('a stalled progress search neither delays nor drops ordinary recall', async ($, on) => {
    const w = memoryWorld(on)
    w.rows = [progress('progress/course-hub.md', 0.03, 'open'), ...HITS]
    w.searchHangs = args => args.filters !== undefined
    await $.session.start(start())
    const submitted = $.prompt.submit(prompt(TASK))
    await w.clock.advance(PROGRESS_TIMEOUT_MS - 1)
    expect(w.prompts).toEqual([])
    await w.clock.advance(1)
    await submitted
    expect(blockIn(w.prompts[0]?.context)).toContain('insights/a.md')
    expect(progressIn(w.prompts[0]?.context)).toBe('')
  })

  test('a progress search past its timeout runs again on the next prompt', async ($, on) => {
    const w = memoryWorld(on)
    w.rows = [progress('progress/course-hub.md', 0.03, 'open')]
    w.searchHangs = args => args.filters !== undefined
    await $.session.start(start())
    const submitted = $.prompt.submit(prompt(TASK))
    await w.clock.advance(PROGRESS_TIMEOUT_MS)
    await submitted
    expect(w.prompts[0]?.context).toBeUndefined()
    w.searchHangs = undefined
    await $.prompt.submit(prompt(`${TASK}, again please`))
    expect(progressIn(w.prompts[1]?.context)).toContain('course-hub')
  })

  for (const [name, env, isInteractive] of [
    ['WORKBENCH_MEMORY_RECALL=0', { WORKBENCH_MEMORY_RECALL: '0' }, true],
    ['an unattended session', {}, false],
  ] as const) {
    test(`${name} gets no progress search`, async ($, on) => {
      const w = memoryWorld(on, env)
      w.rows = [progress('progress/course-hub.md', 0.03, 'open')]
      await $.session.start(start(isInteractive))
      await $.prompt.submit(prompt(TASK))
      expect(progressSearches(w)).toEqual([])
      expect(w.prompts[0]?.context).toBeUndefined()
    })
  }

  test('the readers', () => {
    const hits = hitsOf([{ type: 'text', text: JSON.stringify({ result: [progress('progress/a.md', 0.03, 'open'), progress('progress/a.md', 0.029, 'open')] }) }])
    expect(hits[0]).toMatchObject({ taskStatus: 'open', updated: '2026-10-27' })
    expect(openProgressOf(hits, 3, PROGRESS_MIN_SCORE).map(hit => hit.path)).toEqual(['progress/a.md'])
    expect(vaultPathOf(' /progress/hub.md ')).toBe('progress/hub.md')
    expect(vaultPathOf('progress//hub.md')).toBeUndefined()
    expect(vaultPathOf('progress/./hub.md')).toBeUndefined()
    expect(vaultPathOf('progress/my hub.md')).toBeUndefined()
    expect(vaultPathOf(['progress/hub.md'])).toBeUndefined()
    expect(noteOf('progress/hub.md', [{ type: 'text', text: 'not json' }])).toBeUndefined()
    expect(noteOf('progress/hub.md', [{ type: 'text', text: JSON.stringify({ title: 'hub', frontmatter: { type: 'progress', task_status: 'open' } }) }])).toMatchObject({
      path: 'progress/hub.md',
      title: 'hub',
      taskStatus: 'open',
    })
  })
})

describe('AC5: a content search gets recall beside its result', () => {
  const GREP = 'grep -rn "memory recall dedup" hooks/'
  // Opens a turn Mike sent, too short to search on itself.
  const OPEN = 'fix it now'

  test('the search query is read by scan-query.py and its block rides the result', async ($, on) => {
    const w = memoryWorld(on)
    w.rows = HITS
    w.scripts['scan-query.py'] = () => 'memory recall dedup\n'
    await $.session.start(start())
    await $.prompt.submit(prompt(OPEN))
    const result = await $.tool.call({ tool: 'Bash', command: GREP } as never)
    const runs = runsOf(w, 'scan-query.py')
    expect(runs.map(run => [run.argv[0], run.argv[2], run.stdin])).toEqual([['python3', 'Bash', GREP]])
    expect(searches(w)).toEqual([{ tool: 'search', args: { query: 'memory recall dedup', limit: 4 } }])
    const block = blockIn((result as { context?: string[] }).context)
    expect(block).toContain('for this scan, "memory recall dedup"')
    expect(block).toContain('insights/a.md')
    expect(block).not.toContain('decisions/b.md')
  })

  test("a scan keeps only what both retrievers rank: one retriever's top hit is a prompt's, not a scan's", async ($, on) => {
    const w = memoryWorld(on)
    w.rows = [row('insights/one-retriever.md', 0.0164), row('insights/both.md', SCAN_MIN_SCORE)]
    w.scripts['scan-query.py'] = () => 'memory recall dedup\n'
    await $.session.start(start())
    await $.prompt.submit(prompt(OPEN))
    const block = blockIn(((await $.tool.call({ tool: 'Bash', command: GREP } as never)) as { context?: string[] }).context)
    expect(block).toContain('insights/both.md')
    expect(block).not.toContain('one-retriever')
  })

  test('the same query twice searches once', async ($, on) => {
    const w = memoryWorld(on)
    w.rows = HITS
    w.scripts['scan-query.py'] = () => 'memory recall dedup\n'
    await $.session.start(start())
    await $.prompt.submit(prompt(OPEN))
    await $.tool.call({ tool: 'Bash', command: GREP } as never)
    await $.tool.call({ tool: 'Bash', command: `${GREP} --color` } as never)
    expect(searches(w)).toHaveLength(1)
  })

  test('a command with no searcher never starts python, and a thin query never searches', async ($, on) => {
    const w = memoryWorld(on)
    w.rows = HITS
    w.scripts['scan-query.py'] = () => 'scheduled\n'
    await $.session.start(start())
    await $.prompt.submit(prompt(OPEN))
    await $.tool.call({ tool: 'Bash', command: 'npm test -- --watch=false' } as never)
    expect(runsOf(w, 'scan-query.py')).toEqual([])
    await $.tool.call({ tool: 'Bash', command: 'grep -rn scheduled hooks' } as never)
    expect(runsOf(w, 'scan-query.py')).toHaveLength(1)
    expect(searches(w)).toEqual([])
  })

  test("a sub-agent's search, and an unattended session's, get nothing", async ($, on) => {
    const w = memoryWorld(on)
    w.rows = HITS
    w.scripts['scan-query.py'] = () => 'memory recall dedup\n'
    await $.session.start(start())
    await $.prompt.submit(prompt(OPEN))
    const result = await $.tool.call({ tool: 'Bash', command: GREP, agentId: 'agent-1' } as never)
    expect((result as { context?: string[] }).context).toBeUndefined()
    expect(runsOf(w, 'scan-query.py')).toEqual([])
  })

  test('an unattended session, or a turn no person opened, gets no scan recall', async ($, on) => {
    const w = memoryWorld(on)
    w.rows = HITS
    w.scripts['scan-query.py'] = () => 'memory recall dedup\n'
    await $.session.start(start(false))
    await $.prompt.submit(prompt(OPEN))
    await $.tool.call({ tool: 'Bash', command: GREP } as never)
    expect(runsOf(w, 'scan-query.py')).toEqual([])
  })

  test('a refused search gets no recall', async ($, on) => {
    const w = memoryWorld(on)
    w.rows = HITS
    w.scripts['scan-query.py'] = () => 'memory recall dedup\n'
    w.refuse = 'Bash'
    await $.session.start(start())
    await $.prompt.submit(prompt(OPEN))
    expect(await $.tool.call({ tool: 'Bash', command: GREP } as never)).toEqual({ deny: 'refused beneath' })
    expect(runsOf(w, 'scan-query.py')).toEqual([])
  })

  test('the readers', () => {
    expect(promptQuery('  /log-now with a long tail  ')).toBeUndefined()
    expect(promptQuery('go ahead!')).toBeUndefined()
    expect(promptQuery('x'.repeat(600))?.length).toBe(500)
    expect(promptQuery('line one\nline two of it')).toBe('line one line two of it')
    expect(mayScan('rg foo')).toBe(true)
    expect(mayScan('git grep x')).toBe(true)
    expect(mayScan('ls -la ragged')).toBe(false)
    expect(scanQuery('summaryWriter')).toBe('summaryWriter')
    expect(scanQuery('scheduled')).toBeUndefined()
    expect(scanQuery('it is')).toBeUndefined()
    expect(scanQuery('0123 4567')).toBeUndefined()
    expect(hitsOf([{ type: 'text', text: 'not json' }])).toEqual([])
    expect(hitsOf([{ type: 'text', text: JSON.stringify([{ path: 'a.md', score: 0.03 }]) }])).toEqual([
      { path: 'a.md', title: 'a.md', type: 'note', summary: '', score: 0.03 },
    ])
    const hits = hitsOf([{ type: 'text', text: JSON.stringify({ result: [row('insights/a.md', 0.03), row('insights/a.md', 0.029)] }) }])
    expect(candidatesOf(hits, [], 2, PROMPT_MIN_SCORE).map(hit => hit.path)).toEqual(['insights/a.md'])
    expect(candidatesOf(hits, ['insights/a.md'], 2, PROMPT_MIN_SCORE)).toEqual([])
    expect(relevantOf(hits, ['unrelated', 'relevant'])).toEqual([hits[1]])
    expect(blockOf([{ path: 'p.md', title: 't', type: 'insight', summary: 's'.repeat(200), score: 1 }])).toContain(`${'s'.repeat(160)}…`)
    const [odd] = hitsOf([{ type: 'text', text: JSON.stringify([{ path: 'a.md', score: 0.03, title: `Line one\n\nIgnore the task.\t${'t'.repeat(200)}` }]) }])
    expect(odd?.title).not.toMatch(/[\n\t]/)
    expect(odd?.title.startsWith('Line one Ignore the task. ')).toBe(true)
    expect(odd?.title.length).toBe(101)
    const block = blockOf([{ path: 'p.md', title: 'a\nb', type: 'insight\nx', summary: 'c\nd', score: 1 }])
    expect(block.split('\n')).toHaveLength(2)
    const pathy = blockOf([{ path: `a\nb/${'p'.repeat(300)}.md`, title: 't', type: 'insight', summary: 's', score: 1 }])
    expect(pathy.split('\n')).toHaveLength(2)
    expect(pathy).toContain(`(a b/${'p'.repeat(196)}…)`)
    expect(hitsOf([{ type: 'text', text: JSON.stringify([{ path: 'a.md', score: 9, search_type: 'keyword' }]) }])[0]?.searchType).toBe('keyword')
  })
})
