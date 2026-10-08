// The memory capture checkpoint (hooks/register.ts, hooks/mods/capture.ts):
// on the 5th main-loop turn, then every 40th, a fork of the session lists what
// it learned, and the module writes each note through the memory MCP. No turn
// is shown, nothing is asked, and nothing is manufactured: hooks.json no
// longer registers the Stop hook that woke the model for it
// (hooks/test-memory-module-hooks.sh).

import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { DUPLICATE_SCORE, MAX_NOTES, RRF_CEILING, capturePrompt, isCaptureDue, isNotFound, notesOf, thresholdOf } from '../hooks/mods/capture'
import type { World } from './memory-world'
import { SERVER, memoryWorld, prompt, start, turn } from './memory-world'

const NOTE = {
  type: 'decision',
  slug: 'checkpoint-each-turn',
  name: 'Checkpoint the log each turn',
  summary: 'The mod checkpoints the raw log on turn.complete and session.end.',
  tags: ['session-log', 'mods'],
  body: 'Checkpoint on every turn, because SessionEnd misses reboots.',
}
const answered = (text: string) => ({ isAnswered: true as const, text, usage: {} as never })

async function turns($: Engine, w: World, n: number, reason: 'answer' | 'aborted' | 'error' = 'answer', agentId?: string): Promise<void> {
  for (let i = 0; i < n; i += 1) await $.turn.complete(turn(reason, agentId))
  await w.clock.settle()
}

const writes = (w: World) => w.mcp.filter(call => call.tool === 'write')

describe('AC3: durable memory is captured with no visible turn and no prompt', () => {
  test('the 5th turn asks a fork, and its note is written through the memory MCP', async ($, on) => {
    const w = memoryWorld(on)
    w.fork = answered(JSON.stringify([NOTE]))
    await $.session.start(start())
    await $.prompt.submit(prompt('fix the logging'))
    await turns($, w, 4)
    expect(w.forks).toEqual([])
    await turns($, w, 1)
    expect(w.forks).toHaveLength(1)
    expect(w.forks[0]).toContain('Memory capture checkpoint')
    expect(w.forks[0]).toContain('NONE')
    expect(writes(w)).toEqual([
      {
        tool: 'write',
        args: {
          path: 'decisions/2026-10-07-checkpoint-each-turn.md',
          content: NOTE.body,
          frontmatter: { name: NOTE.name, type: 'decision', date: '2026-10-07', summary: NOTE.summary, tags: NOTE.tags },
        },
      },
    ])
    expect(w.mcp.map(call => call.tool)).toEqual(['search', 'read', 'write'])
    expect(w.mcp[0]?.args).toEqual({ query: NOTE.name, limit: 3 })
    // No turn: the module submitted no prompt of its own, and asked nothing.
    expect(w.prompts.map(p => p.text)).toEqual(['fix the logging'])
    expect(w.toasts).toEqual(['Memory checkpoint saved a note to the vault: decisions/2026-10-07-checkpoint-each-turn.md.'])
  })

  test('NONE writes nothing and shows nothing', async ($, on) => {
    const w = memoryWorld(on)
    w.fork = answered('NONE')
    await $.session.start(start())
    await turns($, w, 5)
    expect(w.forks).toHaveLength(1)
    expect(w.mcp).toEqual([])
    expect(w.toasts).toEqual([])
  })

  test('a fork with nothing to fork, or an API error, writes nothing', async ($, on) => {
    const w = memoryWorld(on)
    await $.session.start(start())
    await turns($, w, 5)
    w.fork = { isAnswered: false, reason: 'api-error', status: 500, error: 'api_error' } as never
    await turns($, w, 40)
    expect(w.forks).toHaveLength(2)
    expect(w.mcp).toEqual([])
  })

  test('then every 40th turn, and the next prompt names the notes already written', async ($, on) => {
    const w = memoryWorld(on)
    w.fork = answered(JSON.stringify([NOTE]))
    await $.session.start(start())
    await turns($, w, 5)
    w.fork = answered('NONE')
    await turns($, w, 39)
    expect(w.forks).toHaveLength(1)
    await turns($, w, 1)
    expect(w.forks).toHaveLength(2)
    expect(w.forks[1]).toContain('- decisions/2026-10-07-checkpoint-each-turn.md')
  })

  test('the thresholds come from the old hook knobs', async ($, on) => {
    const w = memoryWorld(on, { WORKBENCH_CAPTURE_STOP_FIRST: '2', WORKBENCH_CAPTURE_STOP_INTERVAL: '3' })
    w.fork = answered('NONE')
    await $.session.start(start())
    await turns($, w, 2)
    expect(w.forks).toHaveLength(1)
    await turns($, w, 2)
    expect(w.forks).toHaveLength(1)
    await turns($, w, 1)
    expect(w.forks).toHaveLength(2)
  })

  test('an interrupted turn counts; a sub-agent, refused or failed turn does not', async ($, on) => {
    const w = memoryWorld(on)
    w.fork = answered('NONE')
    await $.session.start(start())
    await turns($, w, 4, 'aborted')
    await turns($, w, 3, 'error')
    await turns($, w, 3, 'answer', 'agent-1')
    expect(w.forks).toEqual([])
    await turns($, w, 1, 'aborted')
    expect(w.forks).toHaveLength(1)
  })

  test('a note whose path holds one already is left alone', async ($, on) => {
    const w = memoryWorld(on)
    w.fork = answered(JSON.stringify([NOTE]))
    w.existing.add('decisions/2026-10-07-checkpoint-each-turn.md')
    await $.session.start(start())
    await turns($, w, 5)
    expect(writes(w)).toEqual([])
    expect(w.toasts).toEqual([])
  })

  for (const readFails of ['error', 'reject'] as const) {
    test(`a read that ${readFails === 'error' ? 'answers another error' : 'rejects'} is no "not found": the note is skipped`, async ($, on) => {
      const w = memoryWorld(on)
      w.fork = answered(JSON.stringify([NOTE]))
      w.readFails = readFails
      await $.session.start(start())
      await turns($, w, 5)
      expect(writes(w)).toEqual([])
      expect(w.toasts).toEqual([])
    })
  }

  for (const [why, hit] of [
    ['the same name', { path: 'decisions/2026-09-01-other-file.md', title: NOTE.name, score: 0.016 }],
    ['the same slug', { path: 'insights/2026-08-02-checkpoint-each-turn.md', title: 'Different title', score: 0.016 }],
    ['both retrievers ranking it first', { path: 'insights/close-match.md', title: 'Close match', score: DUPLICATE_SCORE, search_type: 'semantic' }],
    ['a hybrid-labelled top score', { path: 'insights/close-match.md', title: 'Close match', score: 0.033, search_type: 'hybrid' }],
    ['a weighted fused score just under the ceiling', { path: 'insights/close-match.md', title: 'Close match', score: RRF_CEILING - 0.001, search_type: 'semantic' }],
    ['the same name in keyword mode', { path: 'decisions/other.md', title: NOTE.name, score: 9.7, search_type: 'keyword' }],
  ] as const) {
    test(`a note the vault already holds, by ${why}, is not saved again, and the skip is logged`, async ($, on) => {
      const w = memoryWorld(on)
      w.fork = answered(JSON.stringify([NOTE]))
      w.rows = [{ ...hit, frontmatter: { type: 'insight', summary: 's' } }]
      await $.session.start(start())
      await turns($, w, 5)
      expect(writes(w)).toEqual([])
      expect(w.logs.filter(line => line.startsWith('workbench capture: skipped'))).toEqual([
        expect.stringContaining(`skipped "${NOTE.name}" (`) as unknown as string,
      ])
      expect(w.logs.at(-1)).toContain(hit.path)
    })
  }

  // A vault with no embeddings answers a search with keyword hits, whose BM25
  // scores are far above any fusion score. They must not read as duplicates,
  // or every capture on a fresh install is dropped.
  for (const [why, hit] of [
    ['keyword-mode scores', { path: 'insights/unrelated.md', title: 'Unrelated', score: 12.4, search_type: 'keyword' }],
    ['a score with no label', { path: 'insights/unrelated.md', title: 'Unrelated', score: 0.05 }],
    // DEFAULT_SEARCH_MODE=semantic: a cosine similarity, labelled semantic too.
    ['cosine-scale semantic scores', { path: 'insights/unrelated.md', title: 'Unrelated', score: 0.71, search_type: 'semantic' }],
    ['a semantic score at the fusion ceiling', { path: 'insights/unrelated.md', title: 'Unrelated', score: RRF_CEILING, search_type: 'semantic' }],
  ] as const) {
    test(`${why} do not stop a save`, async ($, on) => {
      const w = memoryWorld(on)
      w.fork = answered(JSON.stringify([NOTE]))
      w.rows = [{ ...hit, frontmatter: { type: 'insight', summary: 's' } }]
      await $.session.start(start())
      await turns($, w, 5)
      expect(writes(w)).toHaveLength(1)
      expect(w.logs.some(line => line.startsWith('workbench capture: skipped'))).toBe(false)
    })
  }

  test('a 120-character name still matches its own note', async ($, on) => {
    const name = `Checkpoint ${'x'.repeat(109)}`
    const w = memoryWorld(on)
    w.fork = answered(JSON.stringify([{ ...NOTE, name }]))
    // The server's title, as recall cuts it for display.
    w.rows = [{ path: 'decisions/other.md', title: name, score: 0.01, search_type: 'semantic' }]
    await $.session.start(start())
    await turns($, w, 5)
    expect(name).toHaveLength(120)
    expect(writes(w)).toEqual([])
  })

  test('a related note below the duplicate score does not stop the save', async ($, on) => {
    const w = memoryWorld(on)
    w.fork = answered(JSON.stringify([NOTE]))
    w.rows = [{ path: 'insights/related.md', title: 'Related', score: DUPLICATE_SCORE - 0.001, search_type: 'semantic', frontmatter: { type: 'insight', summary: 's' } }]
    await $.session.start(start())
    await turns($, w, 5)
    expect(writes(w)).toHaveLength(1)
  })

  test('a search that fails skips the note', async ($, on) => {
    const w = memoryWorld(on)
    w.fork = answered(JSON.stringify([NOTE]))
    w.rows = 'error'
    await $.session.start(start())
    await turns($, w, 5)
    expect(writes(w)).toEqual([])
  })

  test('a [[link]] in the body is rewritten to a path link, as the vault write checks do', async ($, on) => {
    const w = memoryWorld(on)
    w.fork = answered(JSON.stringify([{ ...NOTE, body: 'See [[session-end-memory-loss]] for the loss paths.' }]))
    w.scripts['vault-resolve.sh'] = run => {
      expect(run.argv.slice(2)).toEqual(['session-end-memory-loss'])
      return 'root\t/Users/tester/Documents/Claude/Memory\nlink\tsession-end-memory-loss\t/insights/2026-10-05-session-end-memory-loss.md\n'
    }
    await $.session.start(start())
    await turns($, w, 5)
    expect(writes(w)[0]?.args.content).toBe('See [session-end-memory-loss](/insights/2026-10-05-session-end-memory-loss.md) for the loss paths.')
  })

  test('a server that does not connect writes nothing, and the turn goes on', async ($, on) => {
    const w = memoryWorld(on)
    w.fork = answered(JSON.stringify([NOTE]))
    w.connects = false
    await $.session.start(start())
    await turns($, w, 5)
    expect(w.mcp).toEqual([])
  })

  for (const [name, env, isInteractive] of [
    ['an unattended session', {}, false],
    ['WORKBENCH_CAPTURE_STOP=0', { WORKBENCH_CAPTURE_STOP: '0' }, true],
    ['WORKBENCH_MEMORY_NUDGE=0', { WORKBENCH_MEMORY_NUDGE: '0' }, true],
    ['a summary-writer', { WORKBENCH_SUMMARY_WRITER: '1' }, true],
    ['the dev-team pipeline', { WORKBENCH_DEV_TEAM_PIPELINE: '1' }, true],
  ] as const) {
    test(`${name} never captures`, async ($, on) => {
      const w = memoryWorld(on, env)
      w.fork = answered(JSON.stringify([NOTE]))
      await $.session.start(start(isInteractive))
      await turns($, w, 45)
      expect(w.forks).toEqual([])
    })
  }

  test('turns a schedule opened do not count', async ($, on) => {
    const w = memoryWorld(on)
    w.fork = answered('NONE')
    await $.session.start(start())
    await $.prompt.submit(prompt('tick', { kind: 'scheduled-trigger' }))
    await turns($, w, 5)
    expect(w.forks).toEqual([])
    await $.prompt.submit(prompt('<scheduled-task name="x">run</scheduled-task>'))
    await turns($, w, 5)
    expect(w.forks).toEqual([])
  })

  test('/clear starts the count over', async ($, on) => {
    const w = memoryWorld(on)
    w.fork = answered('NONE')
    await $.session.start(start())
    await turns($, w, 4)
    await $.session.end({ reason: 'clear', sessionId: w.sid, resume: { id: w.sid } })
    await turns($, w, 4)
    expect(w.forks).toEqual([])
    await turns($, w, 1)
    expect(w.forks).toHaveLength(1)
  })

  test('the reply is model output: only checked notes, at paths built here', () => {
    const date = '2026-10-07'
    const bad = [
      { ...NOTE, type: 'session' },
      { ...NOTE, slug: '../../escape' },
      { ...NOTE, slug: 'Has Spaces' },
      { ...NOTE, body: '' },
      { ...NOTE, name: 7 },
      { ...NOTE, summary: 'x'.repeat(401) },
      { ...NOTE, name: 'Two\nlines' },
      { ...NOTE, summary: 'One.\r\nname: injected' },
      { ...NOTE, type: 'constructor' },
      { ...NOTE, type: 'toString' },
      null,
      'text',
    ]
    expect(notesOf(JSON.stringify(bad), date)).toEqual([])
    const [note] = notesOf(JSON.stringify([{ ...NOTE, path: '/etc/passwd', tags: ['ok-tag', 'Bad Tag', 3] }]), date)
    expect(note?.path).toBe('decisions/2026-10-07-checkpoint-each-turn.md')
    expect(note?.frontmatter.tags).toEqual(['ok-tag'])
    expect(notesOf('```json\n' + JSON.stringify([NOTE]) + '\n```', date)).toHaveLength(1)
    expect(notesOf(JSON.stringify([NOTE, NOTE]), date)).toHaveLength(1)
    const many = ['a-1', 'a-2', 'a-3', 'a-4'].map(slug => ({ ...NOTE, slug }))
    expect(notesOf(JSON.stringify(many), date)).toHaveLength(MAX_NOTES)
    for (const reply of ['NONE', '', 'not json [', '{"type":"decision"}']) expect(notesOf(reply, date)).toEqual([])
    expect(notesOf(JSON.stringify([{ ...NOTE, type: 'feedback' }]), date)[0]?.path).toBe('feedback/2026-10-07-checkpoint-each-turn.md')
  })

  test('the policy readers', () => {
    expect(isCaptureDue(4, false, 5, 40)).toBe(false)
    expect(isCaptureDue(5, false, 5, 40)).toBe(true)
    expect(isCaptureDue(39, true, 5, 40)).toBe(false)
    expect(isCaptureDue(40, true, 5, 40)).toBe(true)
    expect(thresholdOf(undefined, 5)).toBe(5)
    expect(thresholdOf('0', 5)).toBe(5)
    expect(thresholdOf('abc', 5)).toBe(5)
    expect(thresholdOf('7', 5)).toBe(7)
    expect(capturePrompt([])).not.toContain('already written')
    expect(capturePrompt([])).toContain('[display text](/folder/file-stem.md), never as [[name]]')
    const notFound = (text: string, isError = true) => isNotFound({ isError, content: [{ type: 'text', text }] })
    expect(notFound("Document not found: 'a.md'.")).toBe(true)
    expect(notFound('Internal error')).toBe(false)
    expect(notFound("Attachment not found: 'a.png'.")).toBe(false)
    expect(notFound("Internal error. Document not found: 'a.md'.")).toBe(false)
    expect(notFound("document not found: 'a.md'.")).toBe(false)
    expect(notFound("  Document not found: 'a.md'.")).toBe(true)
    expect(notFound("Document not found: 'a.md'.", false)).toBe(false)
    expect(SERVER).toContain('memory')
  })
})
