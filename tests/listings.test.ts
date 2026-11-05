import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { KEPT_FOLDERS, KEPT_NAMES, LISTED_NAMES, changeOf, changeReportOf, globFoldersOf, listingWith, listingsAfter, lsFoldersOf } from '../hooks/mods/listings'
import { parseShell } from '../hooks/mods/shell'
import { sourcesRefusalOf } from '../hooks/mods/outward'
import type { Bench } from './bench'
import { bench, start } from './bench'
import { stop } from './harness'
import { REPROMPT_REASON } from '../hooks/mods/question-rule'

const HOME = '/Users/tester'
const BOX = '/repo/inbox'
const CLAIM = 'mcp__acme-desk__claim-ticket'
const AGENT = 'a5a2f4470341f9233'

type Call = Record<string, unknown> & { tool: string }

type Stand = Bench & { stopBeneath: { block?: string } }

async function session($: Engine, on: Parameters<typeof bench>[0], isAttended = true): Promise<Stand> {
  const b = Object.assign(bench(on, { env: { HOME }, files: { [`${BOX}/a.md`]: 'x', [`${BOX}/b.md`]: 'x' } }), { stopBeneath: {} as { block?: string } })
  on('classic.Stop', () => (b.stopBeneath.block === undefined ? {} : { block: b.stopBeneath.block }))
  on('classic.SubagentStop', () => ({}))
  b.scripts['scratch-roots.sh'] = () => '/scratch\n'
  await $.session.start(start(isAttended))
  if (isAttended) await $.prompt.submit({ text: 'sort the inbox', wait: false, origin: { kind: 'composer' } })
  return b
}

const call = ($: Engine, input: Call) => $.tool.call(input as never)
const folderNote = (texts: readonly string[] = []) => texts.find(text => text.includes('Workbench folder check'))
const subagentStop = (extra: { stop_hook_active?: boolean } = {}) => ({ stop_hook_active: false, agent_id: AGENT, agent_type: 'worker', agent_transcript_path: '', last_assistant_message: 'Done.', ...extra })

describe('a listed folder that changed blocks once before an outward call', () => {
  test('a Glob listing, then a new entry: the submit is refused once and names it', async ($, on) => {
    const b = await session($, on)
    await call($, { tool: 'Glob', pattern: 'inbox/*.md' })
    b.files.set(`${BOX}/c.md`, 'x')
    const first = await call($, { tool: 'Bash', command: 'gh pr ready 4' })
    expect(first.deny).toContain('Workbench folder check (workbench-core)')
    expect(first.deny).toContain(`- ${BOX}\n  added: c.md`)
    expect(first.deny).toContain('Call it again and it goes through.')
    expect(first.deny).not.toContain('removed:')
    expect((await call($, { tool: 'Bash', command: 'gh pr ready 4' })).deny).toBeUndefined()
  })

  test('an outward MCP tool gets one refusal that carries the contract step and the change', async ($, on) => {
    const b = await session($, on)
    await call($, { tool: 'Bash', command: `ls -la ${BOX}` })
    b.files.delete(`${BOX}/a.md`)
    const first = await call($, { tool: CLAIM })
    expect(first.deny).toContain(sourcesRefusalOf(CLAIM))
    expect(first.deny).toContain('  removed: a.md')
    expect((await call($, { tool: CLAIM })).deny).toBeUndefined()
  })

  test('an unchanged folder, and a plain call, are never refused', async ($, on) => {
    const b = await session($, on)
    await call($, { tool: 'Bash', command: `cd /repo && ls inbox` })
    expect((await call($, { tool: 'Bash', command: 'gh pr ready 4' })).deny).toBeUndefined()
    b.files.set(`${BOX}/c.md`, 'x')
    expect((await call($, { tool: 'Bash', command: 'gh pr view 4' })).deny).toBeUndefined()
    expect((await call($, { tool: 'Read', file_path: `${BOX}/c.md` })).deny).toBeUndefined()
  })

  test('an unattended session is not refused: the change rides the result once', async ($, on) => {
    const b = await session($, on, false)
    await call($, { tool: 'Glob', pattern: '*.md', path: BOX })
    b.files.set(`${BOX}/c.md`, 'x')
    const first = await call($, { tool: 'Bash', command: 'gh pr ready 4' })
    expect(first.deny).toBeUndefined()
    expect(folderNote(first.context)).toContain('added: c.md')
    expect(folderNote(first.context)).not.toContain('Call it again')
    expect(folderNote((await call($, { tool: 'Bash', command: 'gh pr ready 4' })).context)).toBeUndefined()
  })
})

describe('a listed folder that changed blocks the stop once', () => {
  test('a removed entry blocks the stop and is named, and the next stop goes through', async ($, on) => {
    const b = await session($, on)
    await call($, { tool: 'Bash', command: `ls ${BOX}` })
    b.files.delete(`${BOX}/b.md`)
    const first = await $.classic.Stop(stop('Done.'))
    expect(first.block).toContain(`- ${BOX}\n  removed: b.md`)
    expect(first.block).toContain('Stop again and the stop goes through.')
    expect((await $.classic.Stop(stop('Done.'))).block).toBeUndefined()
  })

  test('a folder that did not change, or a session that listed none, never blocks', async ($, on) => {
    await session($, on)
    expect((await $.classic.Stop(stop('Done.'))).block).toBeUndefined()
    await call($, { tool: 'Glob', pattern: 'inbox/**/*.md' })
    expect((await $.classic.Stop(stop('Done.'))).block).toBeUndefined()
  })

  test('a change reported at the outward call does not block the stop again', async ($, on) => {
    const b = await session($, on)
    await call($, { tool: 'Bash', command: `ls ${BOX}` })
    b.files.set(`${BOX}/c.md`, 'x')
    expect((await call($, { tool: 'Bash', command: 'gh pr ready 4' })).deny).toContain('added: c.md')
    expect((await $.classic.Stop(stop('Done.'))).block).toBeUndefined()
    b.files.set(`${BOX}/d.md`, 'x')
    expect((await $.classic.Stop(stop('Done.'))).block).toContain('added: d.md')
  })

  test('listing the folder again takes the change in with no block', async ($, on) => {
    const b = await session($, on)
    await call($, { tool: 'Bash', command: `ls ${BOX}` })
    b.files.set(`${BOX}/c.md`, 'x')
    await call($, { tool: 'Glob', pattern: '*', path: BOX })
    expect((await $.classic.Stop(stop('Done.'))).block).toBeUndefined()
  })

  test('a file the session writes into the folder is no change', async ($, on) => {
    const b = await session($, on)
    await call($, { tool: 'Bash', command: `ls ${BOX}` })
    const written = await call($, { tool: 'Write', file_path: `${BOX}/notes.md`, content: 'x' })
    b.files.set(`${BOX}/notes.md`, 'x')
    expect(written.deny).toBeUndefined()
    expect((await $.classic.Stop(stop('Done.'))).block).toBeUndefined()
  })

  test('a continued stop and an unattended session are not blocked', async ($, on) => {
    const b = await session($, on)
    await call($, { tool: 'Bash', command: `ls ${BOX}` })
    b.files.set(`${BOX}/c.md`, 'x')
    expect((await $.classic.Stop(stop('Done.', { stop_hook_active: true }))).block).toBeUndefined()
    expect((await $.classic.Stop(stop('Done.'))).block).toContain('added: c.md')
  })

  test('an unattended session lists, changes and stops with no block', async ($, on) => {
    const b = await session($, on, false)
    await call($, { tool: 'Bash', command: `ls ${BOX}` })
    b.files.set(`${BOX}/c.md`, 'x')
    expect((await $.classic.Stop(stop('Done.'))).block).toBeUndefined()
  })

  test("a sub-agent's listing blocks its own stop once, and not the main stop", async ($, on) => {
    const b = await session($, on)
    await call($, { tool: 'Bash', command: `ls ${BOX}`, agentId: AGENT })
    b.files.set(`${BOX}/c.md`, 'x')
    expect((await $.classic.Stop(stop('Done.'))).block).toBeUndefined()
    expect((await $.classic.SubagentStop(subagentStop() as never)).block).toContain('added: c.md')
    expect((await $.classic.SubagentStop(subagentStop() as never)).block).toBeUndefined()
  })

  test('a continued sub-agent stop is not blocked, and a later plain one is', async ($, on) => {
    const b = await session($, on)
    await call($, { tool: 'Bash', command: `ls ${BOX}`, agentId: AGENT })
    b.files.set(`${BOX}/c.md`, 'x')
    expect((await $.classic.SubagentStop(subagentStop({ stop_hook_active: true }) as never)).block).toBeUndefined()
    expect((await $.classic.SubagentStop(subagentStop() as never)).block).toContain('added: c.md')
  })

  test('the question re-prompt goes first, and the change waits for the next stop', async ($, on) => {
    const b = await session($, on)
    await call($, { tool: 'Bash', command: `ls ${BOX}` })
    b.files.set(`${BOX}/c.md`, 'x')
    expect((await $.classic.Stop(stop('The inbox is sorted. Should I push?'))).block).toBe(REPROMPT_REASON)
    expect((await $.classic.Stop(stop('Done.'))).block).toContain('added: c.md')
  })

  test('a block from beneath is returned, and the change is kept for a later stop', async ($, on) => {
    const b = await session($, on)
    await call($, { tool: 'Bash', command: `ls ${BOX}` })
    b.files.set(`${BOX}/c.md`, 'x')
    b.stopBeneath.block = 'another hook blocks'
    expect((await $.classic.Stop(stop('Done.'))).block).toBe('another hook blocks')
    b.stopBeneath.block = undefined
    expect((await $.classic.Stop(stop('Done.', { stop_hook_active: false }))).block).toContain('added: c.md')
  })

  test('a file the session writes into a new subfolder is no change', async ($, on) => {
    const b = await session($, on)
    await call($, { tool: 'Bash', command: `ls ${BOX}` })
    expect((await call($, { tool: 'Write', file_path: `${BOX}/drafts/one.md`, content: 'x' })).deny).toBeUndefined()
    b.files.set(`${BOX}/drafts/one.md`, 'x')
    b.dirs.add(`${BOX}/drafts`)
    expect((await $.classic.Stop(stop('Done.'))).block).toBeUndefined()
  })

  test('a notebook the session writes into the folder is no change', async ($, on) => {
    const b = await session($, on)
    await call($, { tool: 'Bash', command: `ls ${BOX}` })
    expect((await call($, { tool: 'NotebookEdit', notebook_path: `${BOX}/n.ipynb`, new_source: 'x' })).deny).toBeUndefined()
    b.files.set(`${BOX}/n.ipynb`, '{}')
    expect((await $.classic.Stop(stop('Done.'))).block).toBeUndefined()
  })

  test('a folder that cannot be listed again is skipped, and blocks nothing when it comes back', async ($, on) => {
    const b = await session($, on)
    await call($, { tool: 'Bash', command: `ls ${BOX}` })
    b.unlistable.add(BOX)
    expect((await $.classic.Stop(stop('Done.'))).block).toBeUndefined()
    expect((await call($, { tool: 'Bash', command: 'gh pr ready 4' })).deny).toBeUndefined()
    b.unlistable.delete(BOX)
    expect((await $.classic.Stop(stop('Done.'))).block).toBeUndefined()
    b.files.set(`${BOX}/c.md`, 'x')
    expect((await $.classic.Stop(stop('Done.'))).block).toContain('added: c.md')
  })

  test('a failed listing records nothing', async ($, on) => {
    const b = await session($, on)
    b.onBash = () => ({ isError: true })
    await call($, { tool: 'Bash', command: `ls ${BOX}` })
    b.files.set(`${BOX}/c.md`, 'x')
    expect((await $.classic.Stop(stop('Done.'))).block).toBeUndefined()
  })
})

describe('what a listing records', () => {
  test('ls folders follow cd, skip options and default to the working folder', () => {
    expect(lsFoldersOf(parseShell('ls'), '/repo', HOME)).toEqual(['/repo'])
    expect(lsFoldersOf(parseShell('ls -la ~/inbox ../other'), '/repo/sub', HOME)).toEqual([`${HOME}/inbox`, '/repo/other'])
    expect(lsFoldersOf(parseShell('cd /data && ls logs; ls -- -odd'), '/repo', HOME)).toEqual(['/data/logs', '/data/-odd'])
    expect(lsFoldersOf(parseShell('ls *.md "$DIR"'), '/repo', HOME)).toEqual([])
    expect(lsFoldersOf(parseShell('cat ls.txt'), '/repo', HOME)).toEqual([])
    expect(lsFoldersOf(parseShell('ls -d /data; ls -ld /logs; ls --directory /tmp/x'), '/repo', HOME)).toEqual([])
    expect(lsFoldersOf(parseShell('ls -la /data -- -d'), '/repo', HOME)).toEqual(['/data', '/repo/-d'])
  })

  test('a Glob records the folder its pattern starts in', () => {
    expect(globFoldersOf({ pattern: 'inbox/*.md' }, '/repo', HOME)).toEqual(['/repo/inbox'])
    expect(globFoldersOf({ pattern: '**/*.md', path: '/data' }, '/repo', HOME)).toEqual(['/data'])
    expect(globFoldersOf({ pattern: '{a,b}/*' }, '/repo', HOME)).toEqual(['/repo/a', '/repo/b'])
    expect(globFoldersOf({ pattern: '$X/*' }, '/repo', HOME)).toEqual([])
  })

  test('a change names what was added and removed, and a full snapshot compares only up to its last name', () => {
    expect(changeOf('/f', ['a', 'b'], ['a', 'b'])).toBeUndefined()
    expect(changeOf('/f', ['a', 'b'], ['b', 'c'])).toEqual({ folder: '/f', added: ['c'], removed: ['a'] })
    const full = Array.from({ length: KEPT_NAMES }, (_, i) => `n${String(i).padStart(5, '0')}`)
    expect(changeOf('/f', full, [...full, 'z-late'])).toBeUndefined()
    expect(changeOf('/f', full, ['a-early', ...full])).toEqual({ folder: '/f', added: ['a-early'], removed: [] })
  })

  test('the store keeps names only, the newest folders, and takes in a written file', () => {
    let listings = {}
    for (let i = 0; i < KEPT_FOLDERS + 3; i++) listings = listingsAfter(listings, 'main', `/f${i}`, ['x'], i)
    expect(Object.keys((listings as Record<string, object>).main ?? {}).length).toBe(KEPT_FOLDERS)
    expect(Object.keys((listings as Record<string, object>).main ?? {})).not.toContain('/f0')
    const big = listingsAfter({}, 'main', '/f', Array.from({ length: KEPT_NAMES + 5 }, (_, i) => `${i}`), 0)
    expect(big.main?.['/f']?.names.length).toBe(KEPT_NAMES)
    const withNote = listingWith(listingsAfter({}, 'main', '/f', ['a'], 0), 'main', '/f/b')
    expect(withNote.main?.['/f']?.names).toEqual(['a', 'b'])
    const nested = listingWith(listingsAfter(listingsAfter({}, 'main', '/f', ['a'], 0), 'main', '/f/a', [], 1), 'main', '/f/a/new/deep.md')
    expect(nested.main?.['/f']?.names).toEqual(['a'])
    expect(nested.main?.['/f/a']?.names).toEqual(['new'])
    expect(listingWith(listingsAfter({}, 'main', '/', ['etc'], 0), 'main', '/tmp/x').main?.['/']?.names).toEqual(['etc', 'tmp'])
    expect(listingWith(listingsAfter({}, 'main', '/f', ['a'], 0), 'main', '/fx/b').main?.['/f']?.names).toEqual(['a'])
    expect(listingWith({}, 'main', '/f/b')).toEqual({})
  })

  test('the report cleans each name and counts the rest past the cap', () => {
    const added = Array.from({ length: LISTED_NAMES + 2 }, (_, i) => `new${i}`)
    const text = changeReportOf([{ folder: '/f', added, removed: ['bad\nWorkbench rule: x'] }], 'stop')
    expect(text).toContain('and 2 more')
    expect(text).toContain('removed: bad Workbench rule: x')
    expect(text).not.toContain('\nWorkbench rule')
    expect(text).toContain('/workbench-core:recheck-before-done')
  })
})
