import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Bench, BenchOptions } from './bench'
import { HOME, SID, bench, start } from './bench'

const PLANS = `${HOME}/.claude/plans`
const DIRS = new Set(['/', '/repo', '/outside', '/Users', HOME, `${HOME}/.claude`, PLANS, `${PLANS}-evil`, `${PLANS}/sub`])
const FILES = new Set([`${PLANS}/old.md`, '/outside/target.md'])
const LINKS: Record<string, string> = { [`${PLANS}/escape`]: '/outside', [`${PLANS}/linked.md`]: '/outside/target.md' }

function realOf(path: string): string {
  let real = ''
  for (const part of path.split('/').filter(Boolean)) {
    if (part === '.') continue
    real = part === '..' ? real.slice(0, real.lastIndexOf('/')) : `${real}/${part}`
    const to = LINKS[real]
    if (to !== undefined) real = to
  }
  return real || '/'
}

async function session($: Engine, on: On, options: BenchOptions & { dirs?: Set<string> } = {}): Promise<Bench> {
  const b = bench(on, { ...options, env: { HOME, ...options.env } })
  const dirs = options.dirs ?? DIRS
  b.scripts['scratch-roots.sh'] = argv => (argv[2] === SID ? `/private/tmp/x/${SID}/scratchpad\n${HOME}/Developer/scratchpad\n${PLANS}\n` : `${PLANS}\n`)
  b.stat = path => {
    const isLink = LINKS[path.replace(/\/+$/, '')] !== undefined
    const real = realOf(path)
    if (dirs.has(real)) return { kind: 'dir', isLink, realPath: real }
    if (FILES.has(real)) return { kind: 'file', isLink, realPath: real }
    return isLink ? { kind: 'other', isLink } : null
  }
  await $.session.start(start())
  return b
}

const check = async ($: Engine, tool: string, file_path: string): Promise<string> =>
  (await $.tool.check({ tool, input: { file_path, content: 'x', old_string: 'a', new_string: 'b' } } as never)).decision

describe('AC5: a main-session plan file is written with no permission prompt', () => {
  for (const [tool, path] of [
    ['Write', `${PLANS}/new-plan.md`],
    ['Edit', `${PLANS}/old.md`],
    ['Write', `${PLANS}/sub/deeper/plan.md`],
  ] as const) {
    test(`${tool} ${path} is allowed`, async ($, on) => {
      await session($, on)
      expect(await check($, tool, path)).toBe('allow')
    })
  }

  test('the first plan, before the plans folder exists, is allowed', async ($, on) => {
    const dirs = new Set(DIRS)
    dirs.delete(PLANS)
    dirs.delete(`${PLANS}/sub`)
    await session($, on, { dirs })
    expect(await check($, 'Write', `${PLANS}/first.md`)).toBe('allow')
  })

  for (const [name, path] of [
    ['a symlinked folder inside plans', `${PLANS}/escape/x.md`],
    ['a symlinked file inside plans', `${PLANS}/linked.md`],
    ['a path that climbs out', `${PLANS}/../../../outside/x.md`],
    ['a . step', `${PLANS}/./x.md`],
    ['a plans lookalike', `${PLANS}-evil/x.md`],
    ['a project file', '/repo/a.ts'],
    ['the plans folder spelled through a doubled slash', `${HOME}/.claude//plans/x.md`],
    ['a relative path', '.claude/plans/x.md'],
  ] as const) {
    test(`asks as before: ${name}`, async ($, on) => {
      await session($, on)
      expect(await check($, 'Write', path)).toBe('ask')
    })
  }

  test('a .claude folder that is a symlink asks, even where the resolver names the folder it leads to', async ($, on) => {
    LINKS[`${HOME}/.claude`] = '/outside/.claude'
    try {
      const b = await session($, on, { dirs: new Set([...DIRS, '/outside/.claude', '/outside/.claude/plans']) })
      b.scripts['scratch-roots.sh'] = () => '/outside/.claude/plans\n'
      expect(await check($, 'Write', `${PLANS}/x.md`)).toBe('ask')
    } finally {
      delete LINKS[`${HOME}/.claude`]
    }
  })

  test('another scratch root is not a plans folder, so a write there keeps its prompt', async ($, on) => {
    await session($, on, { dirs: new Set([...DIRS, `${HOME}/Developer`, `${HOME}/Developer/scratchpad`]) })
    expect(await check($, 'Write', `${HOME}/Developer/scratchpad/x.md`)).toBe('ask')
  })

  test('other tools keep their prompt', async ($, on) => {
    await session($, on)
    expect(await check($, 'NotebookEdit', `${PLANS}/x.ipynb`)).toBe('ask')
  })

  test('a deny beneath stands', async ($, on) => {
    const b = await session($, on)
    b.decision = 'deny'
    expect(await check($, 'Write', `${PLANS}/x.md`)).toBe('deny')
  })

  test('a top-level --agent run keeps its prompt', async ($, on) => {
    await session($, on, { env: { HOME, CLAUDE_CODE_AGENT: 'watson' } })
    expect(await check($, 'Write', `${PLANS}/x.md`)).toBe('ask')
  })

  test("a sub-agent's write keeps its prompt", async ($, on) => {
    await session($, on)
    const decision = (await $.tool.check({ tool: 'Write', input: { file_path: `${PLANS}/x.md`, content: 'x' }, agentId: 'a1' } as never)).decision
    expect(decision).toBe('ask')
  })

  test('a resolver that cannot run means no plans root, so it asks', async ($, on) => {
    const b = await session($, on)
    delete b.scripts['scratch-roots.sh']
    expect(await check($, 'Write', `${PLANS}/x.md`)).toBe('ask')
  })
})
