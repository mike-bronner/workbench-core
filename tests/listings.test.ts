import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { KEPT_FOLDERS, KEPT_NAMES, LISTED_NAMES, changeOf, changeReportOf, globFoldersOf, isOwnAdd, listingWith, listingsAfter, listingsAfterOwn, lsFoldersOf, takenBy } from '../hooks/mods/listings'
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

const writerOf = (b: Bench, isCaseFolding = false) => (input: Call) => {
  const path = input.tool === 'NotebookEdit' ? input.notebook_path : input.file_path
  if (typeof path !== 'string' || !['Write', 'Edit', 'NotebookEdit'].includes(input.tool)) return
  b.files.set((isCaseFolding ? [...b.files.keys()].find(file => file.toLowerCase() === path.toLowerCase()) : undefined) ?? path, 'y')
  for (let dir = path.slice(0, path.lastIndexOf('/')); dir.startsWith(`${BOX}/`); dir = dir.slice(0, dir.lastIndexOf('/'))) b.dirs.add(dir)
}

async function session($: Engine, on: Parameters<typeof bench>[0], isAttended = true): Promise<Stand> {
  const b = Object.assign(bench(on, { env: { HOME }, files: { [`${BOX}/a.md`]: 'x', [`${BOX}/b.md`]: 'x' } }), { stopBeneath: {} as { block?: string } })
  on('classic.Stop', () => (b.stopBeneath.block === undefined ? {} : { block: b.stopBeneath.block }))
  on('classic.SubagentStop', () => ({}))
  b.scripts['scratch-roots.sh'] = () => '/scratch\n'
  b.onTool = writerOf(b)
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

describe("the session's own change to a listed folder is no change", () => {
  test('an entry its own Bash call removes does not block the outward call', async ($, on) => {
    const b = await session($, on)
    await call($, { tool: 'Bash', command: `ls ${BOX}` })
    b.onBash = command => void (command.startsWith('rm ') && b.files.delete(`${BOX}/a.md`))
    expect((await call($, { tool: 'Bash', command: `rm ${BOX}/a.md` })).deny).toBeUndefined()
    expect((await call($, { tool: CLAIM })).deny).not.toContain('Workbench folder check')
    expect((await call($, { tool: 'Bash', command: 'gh pr ready 4' })).deny).toBeUndefined()
  })

  test('entries its own Bash call adds, unnamed on the line, do not block', async ($, on) => {
    const b = await session($, on)
    await call($, { tool: 'Glob', pattern: '*.md', path: BOX })
    b.onBash = command => {
      if (command === 'tar -xf drafts.tar') for (const name of ['c.md', 'd.md']) b.files.set(`${BOX}/${name}`, 'x')
    }
    expect((await call($, { tool: 'Bash', command: 'tar -xf drafts.tar' })).deny).toBeUndefined()
    expect((await call($, { tool: 'Bash', command: 'gh pr ready 4' })).deny).toBeUndefined()
    expect((await $.classic.Stop(stop('Done.'))).block).toBeUndefined()
  })

  test('a Bash call that fails after it changed the folder still counts as its own', async ($, on) => {
    const b = await session($, on)
    await call($, { tool: 'Bash', command: `ls ${BOX}` })
    b.onBash = () => {
      b.files.delete(`${BOX}/b.md`)
      return { isError: true }
    }
    expect((await call($, { tool: 'Bash', command: `rm ${BOX}/b.md && false` })).isError).toBe(true)
    b.onBash = undefined
    expect((await call($, { tool: 'Bash', command: 'gh pr ready 4' })).deny).toBeUndefined()
  })

  test('a file its own Edit call creates is no change', async ($, on) => {
    const b = await session($, on)
    await call($, { tool: 'Bash', command: `ls ${BOX}` })
    expect((await call($, { tool: 'Edit', file_path: `${BOX}/new.md`, old_string: '', new_string: 'x' })).deny).toBeUndefined()
    expect((await call($, { tool: 'Bash', command: 'gh pr ready 4' })).deny).toBeUndefined()
  })

  test('an outside change made before an unrelated Bash call still blocks once', async ($, on) => {
    const b = await session($, on)
    await call($, { tool: 'Bash', command: `ls ${BOX}` })
    b.files.set(`${BOX}/c.md`, 'x')
    b.files.delete(`${BOX}/a.md`)
    await call($, { tool: 'Bash', command: 'echo hi' })
    const first = await call($, { tool: 'Bash', command: 'gh pr ready 4' })
    expect(first.deny).toContain(`- ${BOX}\n  added: c.md\n  removed: a.md`)
    expect((await call($, { tool: 'Bash', command: 'gh pr ready 4' })).deny).toBeUndefined()
  })

  test('an own change and an outside change in one folder: the block names only the outside entries', async ($, on) => {
    const b = await session($, on)
    await call($, { tool: 'Bash', command: `ls ${BOX}` })
    b.files.set(`${BOX}/outside.md`, 'x')
    b.files.delete(`${BOX}/b.md`)
    b.onBash = command => {
      if (command !== 'make tidy') return
      b.files.delete(`${BOX}/a.md`)
      b.files.set(`${BOX}/own.md`, 'x')
    }
    expect((await call($, { tool: 'Bash', command: 'make tidy' })).deny).toBeUndefined()
    await call($, { tool: 'Write', file_path: `${BOX}/written.md`, content: 'x' })
    const first = await call($, { tool: 'Bash', command: 'gh pr ready 4' })
    expect(first.deny).toContain(`- ${BOX}\n  added: outside.md\n  removed: b.md\n`)
    for (const own of ['a.md', 'own.md', 'written.md']) expect(first.deny).not.toContain(own)
    expect((await call($, { tool: 'Bash', command: 'gh pr ready 4' })).deny).toBeUndefined()
  })

  test("a sub-agent's Bash change still blocks the main loop's outward call", async ($, on) => {
    const b = await session($, on)
    await call($, { tool: 'Bash', command: `ls ${BOX}` })
    b.onBash = command => void (command.startsWith('rm ') && b.files.delete(`${BOX}/a.md`))
    expect((await call($, { tool: 'Bash', command: `rm ${BOX}/a.md`, agentId: AGENT })).deny).toBeUndefined()
    expect((await call($, { tool: 'Bash', command: 'gh pr ready 4' })).deny).toContain('  removed: a.md')
  })

  test('a change that lands inside a refused Bash call is not its own, and blocks once', async ($, on) => {
    const b = await session($, on)
    await call($, { tool: 'Bash', command: `ls ${BOX}` })
    b.denyBeneath = tool => {
      if (tool !== 'Bash') return undefined
      b.files.delete(`${BOX}/a.md`)
      return 'denied by the person'
    }
    expect((await call($, { tool: 'Bash', command: 'make tidy' })).deny).toBe('denied by the person')
    b.denyBeneath = undefined
    const first = await call($, { tool: 'Bash', command: 'gh pr ready 4' })
    expect(first.deny).toContain(`- ${BOX}\n  removed: a.md`)
    expect((await call($, { tool: 'Bash', command: 'gh pr ready 4' })).deny).toBeUndefined()
  })

  test('an own add into a full record keeps an outside removal of its last name', async ($, on) => {
    const b = await session($, on)
    const full = Array.from({ length: KEPT_NAMES }, (_, i) => `n${String(i).padStart(4, '0')}`)
    for (const name of full) b.files.set(`/repo/full/${name}`, 'x')
    await call($, { tool: 'Bash', command: 'ls /repo/full' })
    b.files.delete('/repo/full/n0999')
    b.onBash = command => void (command === 'touch /repo/full/a1' && b.files.set('/repo/full/a1', 'x'))
    expect((await call($, { tool: 'Bash', command: 'touch /repo/full/a1' })).deny).toBeUndefined()
    const first = await call($, { tool: 'Bash', command: 'gh pr ready 4' })
    expect(first.deny).toContain('- /repo/full\n  removed: n0999\n')
    expect(first.deny).not.toContain('a1')
    expect((await call($, { tool: 'Bash', command: 'gh pr ready 4' })).deny).toBeUndefined()
  })

  const edits: Call[] = [
    { tool: 'Edit', file_path: `${BOX}/f.md`, old_string: 'x', new_string: 'y' },
    { tool: 'Write', file_path: `${BOX}/f.md`, content: 'y' },
    { tool: 'NotebookEdit', notebook_path: `${BOX}/f.md`, new_source: 'y' },
  ]
  for (const edit of edits) {
    test(`${edit.tool} of an entry made outside the session takes nothing in, and blocks once`, async ($, on) => {
      const b = await session($, on)
      await call($, { tool: 'Bash', command: `ls ${BOX}` })
      b.files.set(`${BOX}/f.md`, 'x')
      expect((await call($, edit)).deny).toBeUndefined()
      const first = await call($, { tool: 'Bash', command: 'gh pr ready 4' })
      expect(first.deny).toContain(`- ${BOX}\n  added: f.md\n`)
      expect((await call($, { tool: 'Bash', command: 'gh pr ready 4' })).deny).toBeUndefined()
    })
  }

  test('a Write into a subfolder made outside the session takes nothing in, and blocks once', async ($, on) => {
    const b = await session($, on)
    await call($, { tool: 'Bash', command: `ls ${BOX}` })
    b.dirs.add(`${BOX}/drafts`)
    expect((await call($, { tool: 'Write', file_path: `${BOX}/drafts/one.md`, content: 'x' })).deny).toBeUndefined()
    expect((await call($, { tool: 'Bash', command: 'gh pr ready 4' })).deny).toContain(`- ${BOX}\n  added: drafts\n`)
  })

  test('a Write into a folder that cannot be listed before the call takes nothing in', async ($, on) => {
    const b = await session($, on)
    await call($, { tool: 'Bash', command: `ls ${BOX}` })
    b.unlistable.add(BOX)
    b.denyBeneath = () => void b.unlistable.delete(BOX)
    expect((await call($, { tool: 'Write', file_path: `${BOX}/new.md`, content: 'x' })).deny).toBeUndefined()
    b.denyBeneath = undefined
    expect((await call($, { tool: 'Bash', command: 'gh pr ready 4' })).deny).toContain(`- ${BOX}\n  added: new.md\n`)
  })

  for (const disk of [{ shape: 'a disk that folds letter case', isCaseFolding: true }, { shape: 'a disk that tells letter case apart', isCaseFolding: false }]) {
    test(`on ${disk.shape}, an own Write to Foo.md beside a listed foo.md does not block, and names nothing removed`, async ($, on) => {
      const b = await session($, on)
      b.onTool = writerOf(b, disk.isCaseFolding)
      b.files.set(`${BOX}/foo.md`, 'x')
      await call($, { tool: 'Bash', command: `ls ${BOX}` })
      expect((await call($, { tool: 'Write', file_path: `${BOX}/Foo.md`, content: 'y' })).deny).toBeUndefined()
      expect(b.files.has(`${BOX}/Foo.md`)).toBe(!disk.isCaseFolding)
      expect((await call($, { tool: 'Bash', command: 'gh pr ready 4' })).deny).toBeUndefined()
      expect((await $.classic.Stop(stop('Done.'))).block).toBeUndefined()
    })

    test(`on ${disk.shape}, an own Write to Foo.md beside an outside foo.md the record lacks still blocks once`, async ($, on) => {
      const b = await session($, on)
      b.onTool = writerOf(b, disk.isCaseFolding)
      await call($, { tool: 'Bash', command: `ls ${BOX}` })
      b.files.set(`${BOX}/foo.md`, 'x')
      expect((await call($, { tool: 'Write', file_path: `${BOX}/Foo.md`, content: 'y' })).deny).toBeUndefined()
      const first = await call($, { tool: 'Bash', command: 'gh pr ready 4' })
      expect(first.deny).toContain(`- ${BOX}\n  added: foo.md\n`)
      expect(first.deny).not.toContain('Foo.md')
      expect((await call($, { tool: 'Bash', command: 'gh pr ready 4' })).deny).toBeUndefined()
    })
  }

  test('an own Write that renames an outside foo.md to Foo.md takes nothing in, and blocks once', async ($, on) => {
    const b = await session($, on)
    b.onTool = () => {
      b.files.delete(`${BOX}/foo.md`)
      b.files.set(`${BOX}/Foo.md`, 'y')
    }
    await call($, { tool: 'Bash', command: `ls ${BOX}` })
    b.files.set(`${BOX}/foo.md`, 'x')
    expect((await call($, { tool: 'Write', file_path: `${BOX}/Foo.md`, content: 'y' })).deny).toBeUndefined()
    const first = await call($, { tool: 'Bash', command: 'gh pr ready 4' })
    expect(first.deny).toContain(`- ${BOX}\n  added: Foo.md\n`)
    expect((await call($, { tool: 'Bash', command: 'gh pr ready 4' })).deny).toBeUndefined()
  })

  for (const tool of ['Write', 'Edit']) {
    test(`${tool} that returns an error takes nothing in, so a file made outside afterwards blocks once`, async ($, on) => {
      const b = await session($, on)
      await call($, { tool: 'Bash', command: `ls ${BOX}` })
      b.errorBeneath = failed => failed === tool
      const input: Call = tool === 'Write' ? { tool, file_path: `${BOX}/c.md`, content: 'x' } : { tool, file_path: `${BOX}/c.md`, old_string: '', new_string: 'x' }
      const written = await call($, input)
      expect(written.deny).toBeUndefined()
      expect(written.isError).toBe(true)
      expect(b.files.has(`${BOX}/c.md`)).toBe(false)
      b.errorBeneath = undefined
      b.files.set(`${BOX}/c.md`, 'x')
      const first = await call($, { tool: 'Bash', command: 'gh pr ready 4' })
      expect(first.deny).toContain(`- ${BOX}\n  added: c.md\n`)
      expect((await call($, { tool: 'Bash', command: 'gh pr ready 4' })).deny).toBeUndefined()
    })
  }

  test('a hook failure after the tool ran leaves the tool run once', async ($, on) => {
    let isCorrupt = false
    on('state.get', async (_$, e, next) => {
      const held = await next(e)
      if (!isCorrupt || e.plugin !== 'workbench-core' || e.key !== 'folderListings' || held.value === undefined) return held
      const listings = held.value.value as Record<string, Record<string, object>>
      return { value: { version: held.value.version, value: { ...listings, main: { ...listings.main, [BOX]: { at: 0 } } } as never } }
    })
    const b = await session($, on)
    await call($, { tool: 'Bash', command: `ls ${BOX}` })
    isCorrupt = true
    let runs = 0
    b.onBash = command => {
      if (command !== 'touch own.md') return
      runs += 1
      b.files.set(`${BOX}/own.md`, 'x')
    }
    const result = await call($, { tool: 'Bash', command: 'touch own.md' })
    expect(result.deny).toBeUndefined()
    expect(runs).toBe(1)
    expect(b.calls.filter(({ tool }) => tool === 'Bash').length).toBe(2)
    isCorrupt = false
    expect((await call($, { tool: 'Bash', command: 'gh pr ready 4' })).deny).toContain(`- ${BOX}\n  added: own.md`)
  })

  for (const tool of ['Write', 'Edit']) {
    test(`a refused ${tool} takes nothing in, so a file made outside afterwards blocks once`, async ($, on) => {
      const b = await session($, on)
      await call($, { tool: 'Bash', command: `ls ${BOX}` })
      b.denyBeneath = denied => (denied === tool ? 'denied by the person' : undefined)
      const input: Call = tool === 'Write' ? { tool, file_path: `${BOX}/c.md`, content: 'x' } : { tool, file_path: `${BOX}/c.md`, old_string: '', new_string: 'x' }
      expect((await call($, input)).deny).toBe('denied by the person')
      b.denyBeneath = undefined
      b.files.set(`${BOX}/c.md`, 'x')
      const first = await call($, { tool: 'Bash', command: 'gh pr ready 4' })
      expect(first.deny).toContain(`- ${BOX}\n  added: c.md\n`)
      expect((await call($, { tool: 'Bash', command: 'gh pr ready 4' })).deny).toBeUndefined()
    })
  }
})

describe('a full folder record compares up to the bound its listing set', () => {
  const FULL = Array.from({ length: KEPT_NAMES }, (_, i) => `n${String(i).padStart(4, '0')}`)
  const fullSession = async ($: Engine, on: Parameters<typeof bench>[0], isAttended = true) => {
    const b = await session($, on, isAttended)
    for (const name of FULL) b.files.set(`/repo/full/${name}`, 'x')
    await call($, { tool: 'Bash', command: 'ls /repo/full' })
    return b
  }

  test('an outside add below the last name blocks once, and an add past it does not', async ($, on) => {
    const b = await fullSession($, on)
    b.files.set('/repo/full/n0998a', 'x')
    b.files.set('/repo/full/zz-late', 'x')
    const first = await call($, { tool: 'Bash', command: 'gh pr ready 4' })
    expect(first.deny).toContain('- /repo/full\n  added: n0998a\n')
    expect(first.deny).not.toContain('zz-late')
    expect((await call($, { tool: 'Bash', command: 'gh pr ready 4' })).deny).toBeUndefined()
  })

  test('an own Bash call that removes the last name and adds a1 keeps a pending outside add', async ($, on) => {
    const b = await fullSession($, on)
    b.files.set('/repo/full/n0998a', 'x')
    b.onBash = command => {
      if (command !== 'make swap') return
      b.files.delete('/repo/full/n0999')
      b.files.set('/repo/full/a1', 'x')
    }
    expect((await call($, { tool: 'Bash', command: 'make swap' })).deny).toBeUndefined()
    const first = await call($, { tool: 'Bash', command: 'gh pr ready 4' })
    expect(first.deny).toContain('- /repo/full\n  added: n0998a\n')
    for (const own of ['a1', 'n0999', 'removed:']) expect(first.deny).not.toContain(own)
    expect((await call($, { tool: 'Bash', command: 'gh pr ready 4' })).deny).toBeUndefined()
  })

  test('an Edit into the folder keeps a pending outside add and removal', async ($, on) => {
    const b = await fullSession($, on)
    b.files.set('/repo/full/n0998a', 'x')
    b.files.delete('/repo/full/n0999')
    expect((await call($, { tool: 'Edit', file_path: '/repo/full/a1', old_string: '', new_string: 'x' })).deny).toBeUndefined()
    b.files.set('/repo/full/a1', 'x')
    const first = await call($, { tool: 'Bash', command: 'gh pr ready 4' })
    expect(first.deny).toContain('- /repo/full\n  added: n0998a\n  removed: n0999\n')
    expect(first.deny).not.toContain('a1')
    expect((await call($, { tool: 'Bash', command: 'gh pr ready 4' })).deny).toBeUndefined()
  })

  test('a Write into the folder after a pending outside removal of the last name still names it', async ($, on) => {
    const b = await fullSession($, on)
    b.files.delete('/repo/full/n0999')
    expect((await call($, { tool: 'Write', file_path: '/repo/full/a1', content: 'x' })).deny).toBeUndefined()
    b.files.set('/repo/full/a1', 'x')
    b.files.set('/repo/full/n0998a', 'x')
    const first = await call($, { tool: 'Bash', command: 'gh pr ready 4' })
    expect(first.deny).toContain('- /repo/full\n  added: n0998a\n  removed: n0999\n')
    expect(first.deny).not.toContain('a1')
  })

  test('an own Bash call that adds 50 names to a record of 999 cuts it at its bound, so an add past it does not block', async ($, on) => {
    const b = await session($, on)
    for (const name of FULL.slice(0, -1)) b.files.set(`/repo/full/${name}`, 'x')
    await call($, { tool: 'Bash', command: 'ls /repo/full' })
    b.onBash = command => {
      if (command === 'make many') for (let i = 0; i < 50; i++) b.files.set(`/repo/full/p${String(i).padStart(4, '0')}`, 'x')
    }
    expect((await call($, { tool: 'Bash', command: 'make many' })).deny).toBeUndefined()
    b.onBash = undefined
    expect((await call($, { tool: 'Bash', command: 'gh pr ready 4' })).deny).toBeUndefined()
    b.files.set('/repo/full/zz-late', 'x')
    expect((await call($, { tool: 'Bash', command: 'gh pr ready 4' })).deny).toBeUndefined()
    b.files.set('/repo/full/n0998a', 'x')
    const first = await call($, { tool: 'Bash', command: 'gh pr ready 4' })
    expect(first.deny).toContain('- /repo/full\n  added: n0998a\n')
    expect(first.deny).not.toContain('zz-late')
  })

  test('own adds that grow a record of 999 names to 1,000 keep its null bound, so an add past the last name blocks', async ($, on) => {
    const b = await session($, on)
    for (const name of FULL.slice(0, -1)) b.files.set(`/repo/full/${name}`, 'x')
    await call($, { tool: 'Bash', command: 'ls /repo/full' })
    expect((await call($, { tool: 'Write', file_path: '/repo/full/n0999', content: 'x' })).deny).toBeUndefined()
    b.files.set('/repo/full/n0999', 'x')
    expect((await call($, { tool: 'Bash', command: 'gh pr ready 4' })).deny).toBeUndefined()
    b.files.set('/repo/full/zz-late', 'x')
    const first = await call($, { tool: 'Bash', command: 'gh pr ready 4' })
    expect(first.deny).toContain('- /repo/full\n  added: zz-late\n')
    expect((await call($, { tool: 'Bash', command: 'gh pr ready 4' })).deny).toBeUndefined()
  })
})

describe('in the quiet lane, the note keeps the submit line\'s own change out', () => {
  const owns: [string, Call][] = [
    ['Edit', { tool: 'Edit', file_path: `${BOX}/own.md`, old_string: '', new_string: 'x' }],
    ['Write', { tool: 'Write', file_path: `${BOX}/own.md`, content: 'x' }],
    ['Bash', { tool: 'Bash', command: 'make own' }],
  ]
  for (const [tool, input] of owns) {
    test(`an own ${tool} add carries no note`, async ($, on) => {
      const b = await session($, on, false)
      await call($, { tool: 'Bash', command: `ls ${BOX}` })
      b.onBash = command => void (command === 'make own' && b.files.set(`${BOX}/own.md`, 'x'))
      expect((await call($, input)).deny).toBeUndefined()
      b.files.set(`${BOX}/own.md`, 'x')
      b.onBash = undefined
      const submit = await call($, { tool: 'Bash', command: 'gh pr ready 4' })
      expect(submit.deny).toBeUndefined()
      expect(folderNote(submit.context)).toBeUndefined()
    })
  }

  test('an own add beside an outside add: the note names only the outside entry', async ($, on) => {
    const b = await session($, on, false)
    await call($, { tool: 'Bash', command: `ls ${BOX}` })
    b.files.set(`${BOX}/outside.md`, 'x')
    b.onBash = command => void (command === 'make own' && b.files.set(`${BOX}/own.md`, 'x'))
    expect((await call($, { tool: 'Bash', command: 'make own' })).deny).toBeUndefined()
    b.onBash = undefined
    const note = folderNote((await call($, { tool: 'Bash', command: 'gh pr ready 4' })).context)
    expect(note).toContain(`- ${BOX}\n  added: outside.md\n`)
    expect(note).not.toContain('own.md')
  })

  test('a submit line that changes a listed folder leaves the next note naming only the outside entries', async ($, on) => {
    const b = await session($, on, false)
    await call($, { tool: 'Bash', command: `ls ${BOX}` })
    b.files.set(`${BOX}/c.md`, 'x')
    b.onBash = command => void (command === 'gh pr ready 4 && make tidy' && b.files.delete(`${BOX}/a.md`))
    const first = await call($, { tool: 'Bash', command: 'gh pr ready 4 && make tidy' })
    expect(first.deny).toBeUndefined()
    expect(folderNote(first.context)).toContain(`- ${BOX}\n  added: c.md\n`)
    expect(folderNote(first.context)).not.toContain('a.md')
    b.onBash = undefined
    expect(folderNote((await call($, { tool: 'Bash', command: 'gh pr ready 4' })).context)).toBeUndefined()
    b.files.set(`${BOX}/d.md`, 'x')
    const next = folderNote((await call($, { tool: 'Bash', command: 'gh pr ready 4' })).context)
    expect(next).toContain(`- ${BOX}\n  added: d.md\n`)
    for (const name of ['a.md', 'c.md', 'removed:']) expect(next).not.toContain(name)
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
    expect((await $.classic.Stop(stop('Done.'))).block).toBeUndefined()
  })

  test('a notebook the session writes into the folder is no change', async ($, on) => {
    const b = await session($, on)
    await call($, { tool: 'Bash', command: `ls ${BOX}` })
    expect((await call($, { tool: 'NotebookEdit', notebook_path: `${BOX}/n.ipynb`, new_source: 'x' })).deny).toBeUndefined()
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

  test('a change names what was added and removed, and a bounded record compares only up to its bound', () => {
    expect(changeOf('/f', { names: ['a', 'b'], bound: null }, ['a', 'b'])).toBeUndefined()
    expect(changeOf('/f', { names: ['a', 'b'], bound: null }, ['b', 'c'])).toEqual({ folder: '/f', added: ['c'], removed: ['a'] })
    expect(changeOf('/f', { names: ['a', 'b'], bound: 'b' }, ['a', 'b', 'c'])).toBeUndefined()
    expect(changeOf('/f', { names: ['a', 'b'], bound: 'c' }, ['a', 'b', 'c'])).toEqual({ folder: '/f', added: ['c'], removed: [] })
    const full = Array.from({ length: KEPT_NAMES }, (_, i) => `n${String(i).padStart(4, '0')}`)
    expect(listingsAfter({}, 'main', '/f', full, 0).main?.['/f']?.bound).toBe('n0999')
    expect(listingsAfter({}, 'main', '/f', [...full, 'z'], 0).main?.['/f']?.bound).toBe('n0999')
    expect(listingsAfter({}, 'main', '/f', full.slice(1), 0).main?.['/f']?.bound).toBe(null)
    expect(changeOf('/f', { names: full, bound: null }, [...full, 'z-late'])).toEqual({ folder: '/f', added: ['z-late'], removed: [] })
    const grown = listingWith(listingsAfter({}, 'main', '/f', full.slice(0, -1), 0), 'main', '/f/n0999').main?.['/f']
    expect(grown).toEqual({ names: full, at: 0, bound: null })
  })

  test('a record an older build saved with no bound is bound by its last name when it holds 1,000 names or more', () => {
    const full = Array.from({ length: KEPT_NAMES }, (_, i) => `n${String(i).padStart(4, '0')}`)
    expect(changeOf('/f', { names: full }, [...full, 'z-late'])).toBeUndefined()
    expect(changeOf('/f', { names: full }, ['a-early', ...full])).toEqual({ folder: '/f', added: ['a-early'], removed: [] })
    expect(changeOf('/f', { names: full.slice(0, -1) }, full)).toEqual({ folder: '/f', added: ['n0999'], removed: [] })
    const old = { main: { '/f': { names: full, at: 0 } } }
    const own = listingsAfterOwn(old, 'main', '/f', full, ['a1', ...full.slice(0, -1)])
    expect(own.main?.['/f']).toEqual({ names: ['a1', ...full.slice(0, -1)], at: 0, bound: 'n0999' })
    expect(changeOf('/f', own.main?.['/f'] ?? { names: [] }, ['a1', ...full.slice(0, -1), 'n0998a'])).toEqual({ folder: '/f', added: ['n0998a'], removed: [] })
    expect(listingWith(old, 'main', '/f/z').main?.['/f']).toEqual(old.main['/f'])
    expect(listingWith(old, 'main', '/f/a1').main?.['/f']).toEqual({ names: ['a1', ...full], at: 0, bound: 'n0999' })
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
    const two = listingsAfter(listingsAfter({}, 'main', '/f', ['a'], 0), 'main', '/f/sub', [], 1)
    expect(takenBy(two, 'main', '/f/sub/n.md')).toEqual([['/f/sub', 'n.md'], ['/f', 'sub']])
    const held = listingWith(two, 'main', '/f/sub/n.md', new Set(['/f']))
    expect(held.main?.['/f']?.names).toEqual(['a'])
    expect(held.main?.['/f/sub']?.names).toEqual(['n.md'])
  })

  test('a written name is an own add only when the call made it under that exact name and moved no other letter case', () => {
    expect(isOwnAdd('Foo.md', ['foo.md'], ['Foo.md', 'foo.md'])).toBe(true)
    expect(isOwnAdd('new.md', ['a.md'], ['a.md', 'new.md'])).toBe(true)
    expect(isOwnAdd('Foo.md', ['foo.md'], ['foo.md'])).toBe(false)
    expect(isOwnAdd('Foo.md', ['foo.md'], ['Foo.md'])).toBe(false)
    expect(isOwnAdd('f.md', ['f.md'], ['f.md'])).toBe(false)
    expect(isOwnAdd('new.md', ['a.md'], ['a.md'])).toBe(false)
    expect(isOwnAdd('new.md', undefined, ['new.md'])).toBe(false)
    expect(isOwnAdd('new.md', ['a.md'], undefined)).toBe(false)
  })

  test('an own change applies only its own difference, and keeps the bound of a full record', () => {
    const listings = listingsAfter({}, 'main', '/f', ['a', 'b', 'gone'], 0)
    const own = listingsAfterOwn(listings, 'main', '/f', ['a', 'b', 'outside'], ['b', 'mine', 'outside'])
    expect(own.main?.['/f']?.names).toEqual(['b', 'gone', 'mine'])
    expect(changeOf('/f', own.main?.['/f'] ?? { names: [] }, ['b', 'mine', 'outside'])).toEqual({ folder: '/f', added: ['outside'], removed: ['gone'] })
    expect(listingsAfterOwn(listings, 'main', '/other', ['a'], [])).toBe(listings)
    expect(listingsAfterOwn(listings, AGENT, '/f', ['a'], [])).toBe(listings)
    const full = Array.from({ length: KEPT_NAMES + 3 }, (_, i) => `n${String(i).padStart(5, '0')}`)
    const record = listingsAfter({}, 'main', '/f', full, 0)
    const after = full.slice(1)
    const trimmed = listingsAfterOwn(record, 'main', '/f', full, after).main?.['/f']
    expect(trimmed?.names).toEqual(full.slice(1, KEPT_NAMES))
    expect(trimmed?.bound).toBe(full[KEPT_NAMES - 1])
    expect(changeOf('/f', trimmed ?? { names: [] }, after)).toBeUndefined()
  })

  test('own changes that grow a record with no bound past 1,000 names cut it to 1,000, bound by its last kept name', () => {
    const full = Array.from({ length: KEPT_NAMES }, (_, i) => `n${String(i).padStart(4, '0')}`)
    const many = Array.from({ length: 50 }, (_, i) => `p${String(i).padStart(4, '0')}`)
    const record = listingsAfter({}, 'main', '/f', full.slice(0, -1), 0)
    const grown = listingsAfterOwn(record, 'main', '/f', full.slice(0, -1), [...full.slice(0, -1), ...many]).main?.['/f']
    expect(grown).toEqual({ names: [...full.slice(0, -1), 'p0000'], at: 0, bound: 'p0000' })
    expect(changeOf('/f', grown ?? { names: [] }, [...full.slice(0, -1), ...many, 'zz-late'])).toBeUndefined()
    const early = Array.from({ length: 50 }, (_, i) => `a${String(i).padStart(4, '0')}`)
    const before = listingsAfterOwn(record, 'main', '/f', full.slice(0, -1), [...early, ...full.slice(0, -1)]).main?.['/f']
    expect(before?.names).toEqual([...early, ...full.slice(0, KEPT_NAMES - 50)])
    expect(before?.bound).toBe(full[KEPT_NAMES - 51])
    const atFull = listingWith(record, 'main', '/f/n0999')
    expect(atFull.main?.['/f']).toEqual({ names: full, at: 0, bound: null })
    expect(listingWith(atFull, 'main', '/f/p0000').main?.['/f']).toEqual({ names: full, at: 0, bound: 'n0999' })
    const bounded = listingsAfter({}, 'main', '/f', full, 0)
    expect(listingsAfterOwn(bounded, 'main', '/f', full, ['a1', ...full]).main?.['/f']).toEqual({ names: ['a1', ...full], at: 0, bound: 'n0999' })
  })

  test('an own merge into a full record never lowers its bound', () => {
    const full = Array.from({ length: KEPT_NAMES }, (_, i) => `n${String(i).padStart(4, '0')}`)
    const record = listingsAfter({}, 'main', '/f', full, 0)
    const recorded = (listings: ReturnType<typeof listingsAfter>) => listings.main?.['/f'] ?? { names: [] }
    const removed = full.slice(0, -1)
    const ownBash = listingsAfterOwn(record, 'main', '/f', removed, ['a1', ...removed])
    expect(changeOf('/f', recorded(ownBash), ['a1', ...removed])).toEqual({ folder: '/f', added: [], removed: ['n0999'] })
    const written = listingWith(record, 'main', '/f/a1')
    expect(changeOf('/f', recorded(written), ['a1', ...removed])).toEqual({ folder: '/f', added: [], removed: ['n0999'] })
    const between = [...full, 'n0998a'].sort()
    const addBash = listingsAfterOwn(record, 'main', '/f', between, ['a1', ...between])
    expect(changeOf('/f', recorded(addBash), ['a1', ...between])).toEqual({ folder: '/f', added: ['n0998a'], removed: [] })
    expect(changeOf('/f', recorded(listingWith(record, 'main', '/f/a1')), ['a1', ...between])).toEqual({ folder: '/f', added: ['n0998a'], removed: [] })
    const swapped = ['a1', ...between.filter(name => name !== 'n0999')]
    const swapBash = listingsAfterOwn(record, 'main', '/f', between, swapped)
    expect(recorded(swapBash)).toEqual({ names: ['a1', ...removed], at: 0, bound: 'n0999' })
    expect(changeOf('/f', recorded(swapBash), swapped)).toEqual({ folder: '/f', added: ['n0998a'], removed: [] })
    const later = listingsAfterOwn(record, 'main', '/f', full, ['a1', ...removed])
    expect(changeOf('/f', recorded(later), ['a1', ...removed])).toBeUndefined()
    expect(changeOf('/f', recorded(later), ['a1', ...between.filter(name => name !== 'n0999')])).toEqual({ folder: '/f', added: ['n0998a'], removed: [] })
    const quiet = listingsAfterOwn(record, 'main', '/f', full, ['a1', ...full])
    expect(recorded(quiet).names).toEqual(['a1', ...full])
    expect(changeOf('/f', recorded(quiet), ['a1', ...full])).toBeUndefined()
    expect(recorded(listingsAfterOwn(record, 'main', '/f', full, [...full, 'z']))).toEqual(recorded(record))
    expect(recorded(listingWith(record, 'main', '/f/z'))).toEqual(recorded(record))
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
