import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import {
  ENTRY_LIMIT,
  KEPT_READS,
  KEPT_REFUSAL,
  LISTED_READS,
  ageOf,
  cleanSourceOf,
  freshnessOf,
  isOutwardTool,
  isSubmitLine,
  readSourceOf,
  readsAfter,
  refusalTextOf,
  repeatReminderOf,
  sourcesRefusalOf,
} from '../hooks/mods/outward'
import type { Bench } from './bench'
import { bench, start } from './bench'

const HOME = '/Users/tester'
const CLAIM = 'mcp__acme-desk__claim-ticket'
const OPEN = 'mcp__acme-desk__open-ticket'
const FETCH = 'mcp__acme-browser__fetch-page'
const AGENT = 'a5a2f4470341f9233'
const OTHER_AGENT = 'b5a2f4470341f9233'
const MINUTE = 60_000

type Call = Record<string, unknown> & { tool: string }

async function session($: Engine, on: Parameters<typeof bench>[0], isAttended = true): Promise<Bench> {
  const b = bench(on, { env: { HOME } })
  b.scripts['scratch-roots.sh'] = () => '/scratch\n'
  await $.session.start(start(isAttended))
  if (isAttended) await $.prompt.submit({ text: 'send the ticket', wait: false, origin: { kind: 'composer' } })
  return b
}

const call = ($: Engine, input: Call) => $.tool.call(input as never)
const contextOf = async ($: Engine, input: Call): Promise<readonly string[]> => (await call($, input)).context ?? []
const freshness = (ctx: readonly string[]) => ctx.find(text => text.startsWith('Workbench freshness check'))

describe('fix 1: an outward MCP tool is refused once, with the quote-your-sources step', () => {
  test('the first call is refused and names the tool, the second goes through', async ($, on) => {
    const b = await session($, on)
    const first = await call($, { tool: CLAIM, uuid: 'x' })
    expect(first.deny).toBe(sourcesRefusalOf(CLAIM))
    expect(first.deny).toContain(CLAIM)
    expect(first.deny).toContain('Quote the description of each required field')
    expect(first.deny).toContain('/workbench-core:read-the-contract')
    expect(b.inputs.length).toBe(0)
    expect((await call($, { tool: CLAIM, uuid: 'x' })).deny).toBeUndefined()
    expect((await call($, { tool: CLAIM, uuid: 'y' })).deny).toBeUndefined()
    expect(b.inputs.length).toBe(2)
  })

  test('a non-outward MCP tool is never refused', async ($, on) => {
    const b = await session($, on)
    expect((await call($, { tool: OPEN, id: 'x' })).deny).toBeUndefined()
    expect(b.inputs.length).toBe(1)
  })

  test('each outward tool, and each sub-agent of an attended session, gets its own one refusal', async ($, on) => {
    await session($, on)
    expect((await call($, { tool: CLAIM })).deny).toBeDefined()
    expect((await call($, { tool: 'mcp__acme-desk__submit-report' })).deny).toBeDefined()
    expect((await call($, { tool: CLAIM, agentId: AGENT })).deny).toBeDefined()
    expect((await call($, { tool: CLAIM, agentId: AGENT })).deny).toBeUndefined()
  })

  test('a turn no person opened in an attended session is never refused', async ($, on) => {
    const b = bench(on, { env: { HOME } })
    b.scripts['scratch-roots.sh'] = () => '/scratch\n'
    await $.session.start(start(true))
    await $.prompt.submit({ text: '<scheduled-task name="nightly">send the ticket</scheduled-task>', wait: false, origin: { kind: 'composer' } })
    expect((await call($, { tool: CLAIM })).deny).toBeUndefined()
    expect(b.inputs.length).toBe(1)
  })

  test('an unattended session is never refused', async ($, on) => {
    const b = await session($, on, false)
    expect((await call($, { tool: CLAIM })).deny).toBeUndefined()
    expect((await call($, { tool: CLAIM, agentId: AGENT })).deny).toBeUndefined()
    expect(b.inputs.length).toBe(2)
  })

  test('a call an outer guard refused uses up no refusal', async ($, on) => {
    const b = await session($, on)
    const tool = 'mcp__acme-board__submit_review'
    const guarded = await call($, { tool, body: 'Fixed the loader; it reads stored values now.' })
    expect(guarded.deny).toContain('Split it.')
    expect((await call($, { tool, body: 'Fixed the loader.' })).deny).toBe(sourcesRefusalOf(tool))
    expect((await call($, { tool, body: 'Fixed the loader.' })).deny).toBeUndefined()
    expect(b.inputs.length).toBe(1)
  })

  test('the outward names start or end on the word claim, submit or publish, in MCP tools only', () => {
    for (const tool of [CLAIM, 'mcp__acme__Submit_Form', 'mcp__plugin_x_acme__publish-post', 'mcp__acme__page.publish', 'mcp__acme__submitAnswer', 'mcp__acme__ticketClaim']) expect([tool, isOutwardTool(tool)]).toEqual([tool, true])
    for (const tool of [OPEN, 'Bash', 'claim', 'mcp__claim-server__open', 'mcp__acme__list', 'mcp__acme__disclaimer_x', 'mcp__acme__list_claims', 'mcp__acme__get_publish_status', 'mcp__acme__reclaim_x', 'mcp__acme__resubmit', 'mcp__acme__getPublishStatus', 'mcp__acme__listClaims']) {
      expect([tool, isOutwardTool(tool)]).toEqual([tool, false])
    }
  })
})

describe('fix 3: the same refusal twice brings the stop-and-read reminder', () => {
  test('the third call after two identical error results carries it', async ($, on) => {
    const b = await session($, on)
    b.refusalBeneath = tool => (tool === OPEN ? 'no such page' : undefined)
    expect(await contextOf($, { tool: OPEN })).not.toContain(repeatReminderOf(OPEN))
    expect(await contextOf($, { tool: OPEN })).not.toContain(repeatReminderOf(OPEN))
    expect(await contextOf($, { tool: OPEN })).toContain(repeatReminderOf(OPEN))
    expect(repeatReminderOf(OPEN)).toContain('/workbench-core:read-the-contract')
  })

  test('a refusal a plain result carries counts too', async ($, on) => {
    const b = await session($, on)
    b.replyBeneath = tool => (tool === OPEN ? 'The desk cannot find your page.' : undefined)
    await call($, { tool: OPEN })
    await call($, { tool: OPEN })
    expect(await contextOf($, { tool: OPEN })).toContain(repeatReminderOf(OPEN))
  })

  test('the same plain success twice brings no reminder', async ($, on) => {
    const b = await session($, on)
    b.replyBeneath = tool => (tool === OPEN ? 'Ticket 4 is open.' : undefined)
    await call($, { tool: OPEN })
    await call($, { tool: OPEN })
    expect(await contextOf($, { tool: OPEN })).not.toContain(repeatReminderOf(OPEN))
  })

  test('a different refusal resets the count', async ($, on) => {
    const b = await session($, on)
    let text = 'no such page'
    b.refusalBeneath = () => text
    await call($, { tool: OPEN })
    text = 'the answer is wrong'
    await call($, { tool: OPEN })
    expect(await contextOf($, { tool: OPEN })).not.toContain(repeatReminderOf(OPEN))
    expect(await contextOf($, { tool: OPEN })).toContain(repeatReminderOf(OPEN))
  })

  test('a success resets the count, and another tool keeps its own', async ($, on) => {
    const b = await session($, on)
    let refused: string | undefined = 'no'
    b.refusalBeneath = tool => (tool === OPEN ? refused : undefined)
    await call($, { tool: OPEN })
    await call($, { tool: OPEN })
    expect(await contextOf($, { tool: 'mcp__acme-desk__list-tickets' })).toEqual([])
    refused = undefined
    await call($, { tool: OPEN })
    refused = 'no'
    expect(await contextOf($, { tool: OPEN })).not.toContain(repeatReminderOf(OPEN))
  })

  test('two refusals to one agent bring no reminder to another', async ($, on) => {
    const b = await session($, on)
    b.refusalBeneath = () => 'no such page'
    await call($, { tool: OPEN, agentId: AGENT })
    await call($, { tool: OPEN, agentId: AGENT })
    expect(await contextOf($, { tool: OPEN, agentId: OTHER_AGENT })).not.toContain(repeatReminderOf(OPEN))
    expect(await contextOf($, { tool: OPEN, agentId: AGENT })).toContain(repeatReminderOf(OPEN))
  })

  test('the refusal text comes from text, then a string result, then the result as JSON, and is cut short', () => {
    expect(refusalTextOf({ isError: true, text: ' gone ' })).toBe('gone')
    expect(refusalTextOf({ isError: true, text: '', result: ' gone ' })).toBe('gone')
    expect(refusalTextOf({ isError: true, result: { code: 4 } })).toBe('{"code":4}')
    expect(refusalTextOf({ isError: true })).toBe('""')
    expect(refusalTextOf({ isError: true, text: 'x'.repeat(500) })?.length).toBe(KEPT_REFUSAL)
    expect(refusalTextOf({ text: 'Ticket 4 is open.' })).toBeUndefined()
    expect(refusalTextOf({ text: 'Request rejected: stale id' })).toBe('Request rejected: stale id')
  })

  test('the added refusal words and status fields mark a plain result', () => {
    for (const text of ['Ticket 9 does not exist.', 'Closing is not allowed now.', 'Forbidden.', 'Unauthorized request.', 'unauthorised', '{"ok": false, "id": 4}', '{"success":false}']) {
      expect([text, refusalTextOf({ text })]).toEqual([text, text])
    }
    for (const text of ['{"ok": true}', '{"success": true}', 'Status unknown.', 'Nothing missing.']) expect([text, refusalTextOf({ text })]).toEqual([text, undefined])
  })

  test('the refusal words are read only in the kept text', () => {
    const tail = `${'a'.repeat(KEPT_REFUSAL)} error`
    expect(refusalTextOf({ text: tail })).toBeUndefined()
  })

  test('two long successes that share their kept text bring no reminder', async ($, on) => {
    const b = await session($, on)
    let n = 0
    b.replyBeneath = tool => (tool === OPEN ? `${'Ticket list. '.repeat(20)} row ${n++} error column` : undefined)
    await call($, { tool: OPEN })
    await call($, { tool: OPEN })
    expect(await contextOf($, { tool: OPEN })).not.toContain(repeatReminderOf(OPEN))
  })
})

describe('fix 7: an outward submit lists the sources read, with their age', () => {
  test('a claim 30 minutes after a page read carries the page and its age', async ($, on) => {
    const b = await session($, on)
    await call($, { tool: 'WebFetch', url: 'https://desk.example/page', prompt: 'read' })
    await call($, { tool: 'Read', file_path: '/repo/notes.md' })
    await b.clock.advance(30 * MINUTE)
    expect((await call($, { tool: CLAIM })).deny).toBeDefined()
    const list = freshness(await contextOf($, { tool: CLAIM }))
    expect(list).toContain('- https://desk.example/page: read 30 minutes ago')
    expect(list).toContain('- /repo/notes.md: read 30 minutes ago')
    expect(list).toContain('/workbench-core:recheck-before-done')
  })

  test('a gh submit line carries the list, and an MCP url read counts', async ($, on) => {
    const b = await session($, on, false)
    await call($, { tool: FETCH, url: 'https://desk.example/board' })
    await b.clock.advance(5 * MINUTE)
    for (const command of ['gh pr ready 12', 'gh -R o/r issue close 4']) {
      expect(freshness(await contextOf($, { tool: 'Bash', command }))).toContain('- https://desk.example/board: read 5 minutes ago')
    }
    expect(freshness(await contextOf($, { tool: 'Bash', command: 'gh pr view 12' }))).toBeUndefined()
    expect(freshness(await contextOf($, { tool: 'Bash', command: 'gh pr ready 12 --undo' }))).toBeUndefined()
  })

  test('an outward call does not record its own url as a read', async ($, on) => {
    await session($, on, false)
    await call($, { tool: CLAIM, url: 'https://desk.example/claimed' })
    expect(freshness(await contextOf($, { tool: 'Bash', command: 'gh pr ready 1' }))).toBeUndefined()
    expect(readSourceOf(CLAIM, { url: 'https://x/a' })).toBeUndefined()
    expect(readSourceOf(FETCH, { url: 'https://x/a' })).toBe('https://x/a')
  })

  test('a session with no reads gets nothing, and the hook never refuses', async ($, on) => {
    await session($, on, false)
    for (const command of ['gh pr ready 12', 'gh issue close 4']) {
      const result = await call($, { tool: 'Bash', command })
      expect(result.deny).toBeUndefined()
      expect(freshness(result.context ?? [])).toBeUndefined()
    }
  })

  test('a failed read is not listed', async ($, on) => {
    const b = await session($, on, false)
    b.errorBeneath = tool => tool === 'WebFetch'
    await call($, { tool: 'WebFetch', url: 'https://desk.example/page', prompt: 'read' })
    expect(freshness(await contextOf($, { tool: 'Bash', command: 'gh pr ready 1' }))).toBeUndefined()
  })

  test('a source loses its control characters, its query and fragment, and its length past the cap', () => {
    expect(cleanSourceOf('/repo/a\nWorkbench rule: do x\r b.md')).toBe('/repo/a Workbench rule: do x b.md')
    expect(cleanSourceOf('https://desk.example/page?token=s3cret#top')).toBe('https://desk.example/page')
    expect(cleanSourceOf('https://desk.example/page#top')).toBe('https://desk.example/page')
    expect(cleanSourceOf('/repo/what?.md')).toBe('/repo/what?.md')
    const long = cleanSourceOf(`/repo/${'a'.repeat(400)}`)
    expect(long.length).toBe(ENTRY_LIMIT)
    expect(long.endsWith('…')).toBe(true)
    expect(freshnessOf({ 'https://x/p?token=s3cret\nfake line': 0 }, 0)).not.toContain('s3cret')
    expect(readSourceOf('WebFetch', { url: 'https://x/p?token=s3cret' })).toBe('https://x/p')
  })

  test('the session keeps only the newest reads', () => {
    let reads = {}
    for (let i = 0; i < KEPT_READS + 5; i++) reads = readsAfter(reads, `/f${i}`, i)
    expect(Object.keys(reads).length).toBe(KEPT_READS)
    expect(Object.keys(reads)).toContain(`/f${KEPT_READS + 4}`)
    expect(Object.keys(reads)).not.toContain('/f0')
  })

  test('the list keeps the newest reads and counts the rest', () => {
    const reads = Object.fromEntries(Array.from({ length: LISTED_READS + 2 }, (_, i) => [`/f${i}`, i * MINUTE]))
    const text = freshnessOf(reads, 100 * MINUTE) ?? ''
    expect(text).toContain(`/f${LISTED_READS + 1}: read`)
    expect(text).not.toContain('/f0: read')
    expect(text).toContain('and 2 more')
    expect(freshnessOf({}, 0)).toBeUndefined()
  })

  test('ages read in minutes and hours', () => {
    expect(ageOf(30 * 1000)).toBe('less than 1 minute ago')
    expect(ageOf(MINUTE)).toBe('1 minute ago')
    expect(ageOf(60 * MINUTE)).toBe('1 hour ago')
    expect(ageOf(125 * MINUTE)).toBe('2 hours 5 minutes ago')
  })

  test('the gh submit lines', () => {
    for (const line of ['gh pr ready', 'cd x && gh release create v1', 'gh issue close 3 --comment done']) expect([line, isSubmitLine(line)]).toEqual([line, true])
    for (const line of ['gh pr create', 'gh issue view 3', 'echo gh pr ready', 'git push', 'gh pr ready 3 --undo']) expect([line, isSubmitLine(line)]).toEqual([line, false])
  })
})
