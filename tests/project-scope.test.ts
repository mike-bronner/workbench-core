import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { isInScope, isWorkType, workdirPathsOf } from '../hooks/mods/project-scope'
import type { Bench, BenchOptions } from './bench'
import { HOME, bench, run, start } from './bench'

const brief = (workdir: string) =>
  [
    `Workdir: ${workdir}`,
    'Goal: the parser accepts empty input.',
    'Context: a user hit a crash on an empty file.',
    'Constraints: none',
    'Acceptance:',
    '- an empty file parses to an empty list',
    'Done when: the suite passes.',
  ].join('\n')

const DIRS = new Set(['/', '/repo', '/repo/src', '/repo/.git', '/wt', '/wt/src', '/other', '/other/.git', '/scratch', '/scratch/run.1', HOME, `${HOME}/.git`, `${HOME}/proj`, `${HOME}/proj/.git`])

const REPOS: Record<string, { top: string; common: string }> = {
  '/repo': { top: '/repo', common: '/repo/.git' },
  '/repo/src': { top: '/repo', common: '/repo/.git' },
  '/wt': { top: '/wt', common: '/repo/.git' },
  '/wt/src': { top: '/wt', common: '/repo/.git' },
  '/other': { top: '/other', common: '/other/.git' },
  [`${HOME}/proj`]: { top: `${HOME}/proj`, common: `${HOME}/proj/.git` },
}

type World = { repos?: Record<string, { top: string; common: string }>; gitFails?: boolean }

function model(b: Bench, world: World = {}) {
  const repos = world.repos ?? REPOS
  b.run = argv => {
    const [program = '', a = '', c = '', d = ''] = argv
    if (program === 'bash' && a.endsWith('/scope-facts.sh')) {
      if (c === 'roots') return { exitCode: 0, stdout: 'root\t/scratch\ntmp\t/private/tmp\n' }
      if (c === 'dir') return { exitCode: 0, stdout: DIRS.has(d) ? `${d}\n` : '' }
      return { exitCode: 0, stdout: '' }
    }
    if (program === 'git' && a === '-C' && argv.includes('--git-common-dir')) {
      if (world.gitFails) throw new Error('git unavailable')
      const repo = repos[c]
      return repo === undefined ? { exitCode: 128, stdout: '' } : { exitCode: 0, stdout: `${repo.top}\n${repo.common}\n` }
    }
    return undefined
  }
}

async function session($: Engine, on: On, options: BenchOptions & { isInteractive?: boolean; root?: string; world?: World } = {}): Promise<Bench> {
  const b = bench(on, { ...options, env: { HOME, ...options.env } })
  if (options.root !== undefined) b.root = options.root
  model(b, options.world)
  await $.session.start(start(options.isInteractive ?? true))
  return b
}

const agent = (prompt: unknown, type?: string, agentId?: string) => ({
  tool: 'Agent',
  description: 'd',
  prompt,
  ...(type === undefined ? {} : { subagent_type: type }),
  ...(agentId === undefined ? {} : { agentId }),
})

async function dispatch($: Engine, b: Bench, call: Record<string, unknown>) {
  const before = b.inputs.length
  const result = await $.tool.call(call as never)
  return { deny: result.deny, isReached: b.inputs.length === before + 1 }
}

const WORK_TYPES = [undefined, 'general-purpose', 'workbench-dev-team:watson', 'workbench-dev-team:holmes', 'workbench-dev-team:lestrade', 'fork']

describe('AC1: a work dispatch outside the project is refused', () => {
  for (const type of WORK_TYPES) {
    test(`${type ?? 'no type'}: a Workdir in another repository is refused, naming it and the hand-off`, async ($, on) => {
      const b = await session($, on)
      const { deny, isReached } = await dispatch($, b, agent(brief('/other (branch: main)'), type))
      expect(isReached).toBe(false)
      expect(deny).toContain('Project scope guard (workbench-core)')
      expect(deny).toContain('This session works only for its own project, /repo.')
      expect(deny).toContain("The brief's Workdir, /other, is outside it")
      expect(deny).toContain('It belongs to /other.')
      expect(deny).toContain('SendMessage')
      expect(deny).toContain('/workbench-core:cross-session-messaging')
      expect(deny).toContain('If no session for that project is live, stop and ask Mike.')
    })
  }

  test('a Workdir outside every repository is refused, naming the folder', async ($, on) => {
    const b = await session($, on)
    const { deny } = await dispatch($, b, agent(brief('/elsewhere/new')))
    expect(deny).toContain('It belongs to /elsewhere/new.')
  })

  test('a ~ Workdir is read from HOME', async ($, on) => {
    const b = await session($, on)
    const { deny } = await dispatch($, b, agent(brief('`~/proj`')))
    expect(deny).toContain(`It belongs to ${HOME}/proj.`)
  })

  test('every path on the Workdir line is judged', async ($, on) => {
    const b = await session($, on)
    expect((await dispatch($, b, agent(brief('/repo, and /other for the fixture')))).deny).toContain("Workdir, /other,")
  })

  test('a Workdir with no absolute path is refused as unreadable', async ($, on) => {
    const b = await session($, on)
    for (const workdir of ['', 'the current repo', './src', '/repo/missing/../../other']) {
      const { deny, isReached } = await dispatch($, b, agent(brief(workdir)))
      expect(isReached).toBe(false)
      expect(deny).toContain('names no absolute path this guard can resolve')
    }
  })

  test('/orchestrator off does not stand the guard down', async ($, on) => {
    const b = await session($, on)
    await $.command.run(run('orchestrator', 'off'))
    expect((await dispatch($, b, agent(brief('/other')))).isReached).toBe(false)
  })

  test('a guard that cannot ask git refuses', async ($, on) => {
    const b = await session($, on, { world: { gitFails: true } })
    const { deny, isReached } = await dispatch($, b, agent(brief('/repo')))
    expect(isReached).toBe(false)
    expect(deny).toContain('could not finish')
  })
})

describe('AC2: a work dispatch inside the project, its worktrees or a scratch root goes through', () => {
  const INSIDE: [string, string][] = [
    ['the project itself', '/repo'],
    ['a project folder', '/repo/src'],
    ['a project folder that does not exist yet', '/repo/src/new/deep'],
    ['a worktree of the same repository outside the project folder', '/wt/src (worktree)'],
    ['a scratch root', '/scratch/run.1'],
    ['a new folder in a scratch root', '/scratch/run.2'],
  ]
  for (const [name, workdir] of INSIDE) {
    test(`${name}: ${workdir}`, async ($, on) => {
      const b = await session($, on)
      expect(await dispatch($, b, agent(brief(workdir), 'workbench-dev-team:watson'))).toEqual({ deny: undefined, isReached: true })
    })
  }

  test('a session started in a worktree owns the main checkout too', async ($, on) => {
    const b = await session($, on, { root: '/wt' })
    expect((await dispatch($, b, agent(brief('/repo')))).isReached).toBe(true)
    expect((await dispatch($, b, agent(brief('/other')))).isReached).toBe(false)
  })
})

describe('AC3: Explore and Plan are never judged', () => {
  for (const type of ['Explore', 'Plan']) {
    test(`${type} reads another project, or names no path at all`, async ($, on) => {
      const b = await session($, on)
      for (const workdir of ['/other', '~/proj', 'none']) {
        expect(await dispatch($, b, agent(brief(workdir), type))).toEqual({ deny: undefined, isReached: true })
      }
    })
  }
})

describe('what the guard leaves alone', () => {
  test('a session outside any repository is not a project, and dispatches anywhere', async ($, on) => {
    const b = await session($, on, { root: HOME })
    expect((await dispatch($, b, agent(brief('/other')))).isReached).toBe(true)
  })

  test('a home folder that is a repository is still no project', async ($, on) => {
    const b = await session($, on, { root: HOME, world: { repos: { ...REPOS, [HOME]: { top: HOME, common: `${HOME}/.git` } } } })
    expect((await dispatch($, b, agent(brief('/other')))).isReached).toBe(true)
  })

  test('the machine-built shapes carry no Workdir and pass', async ($, on) => {
    const b = await session($, on)
    for (const prompt of ['Item ID: 12', 'Repo sweep: owner/repo']) {
      expect((await dispatch($, b, agent(prompt, 'workbench-dev-team:watson'))).isReached).toBe(true)
    }
  })

  test("a sub-agent's own fan-out is not judged", async ($, on) => {
    const b = await session($, on)
    expect((await dispatch($, b, agent(brief('/other'), 'general-purpose', 'a5a2f4470341f9233'))).isReached).toBe(true)
  })

  test('a top-level --agent run is not judged', async ($, on) => {
    const b = await session($, on, { env: { CLAUDE_CODE_AGENT: 'workbench-dev-team:holmes' }, isInteractive: false })
    expect((await dispatch($, b, agent(brief('/other')))).isReached).toBe(true)
  })

  test('a prompt with no Workdir line, with the brief gate off, is not judged', async ($, on) => {
    const b = await session($, on)
    await $.command.run(run('orchestrator', 'off'))
    expect((await dispatch($, b, agent('Fix the parser in /other.'))).isReached).toBe(true)
  })
})

describe('the pure parts', () => {
  test('workdirPathsOf reads every absolute path on each Workdir line, and only there', () => {
    expect(workdirPathsOf('Goal: /x\nWorkdir: `/a/b` (branch: feat/y, worktree)\nworkdir: ~/c.', '/h')).toEqual(['/a/b', '/h/c'])
    expect(workdirPathsOf('Goal: /x', '/h')).toBeUndefined()
    expect(workdirPathsOf(42, '/h')).toBeUndefined()
    expect(workdirPathsOf('Workdir: and/or relative', '/h')).toEqual([])
    expect(workdirPathsOf('Workdir: ~/c', undefined)).toEqual([])
    expect(workdirPathsOf('Workdir: ~', '/h/')).toEqual(['/h'])
  })

  test('isInScope takes a root and what is under it, and nothing beside it', () => {
    expect(isInScope('/repo', ['/repo'])).toBe(true)
    expect(isInScope('/repo/x', ['/repo/'])).toBe(true)
    expect(isInScope('/Repo/x', ['/repo'])).toBe(true)
    expect(isInScope('/repo2', ['/repo'])).toBe(false)
    expect(isInScope('/x', [''])).toBe(false)
  })

  test('only Explore and Plan are read-only', () => {
    expect(isWorkType('Explore')).toBe(false)
    expect(isWorkType('Plan')).toBe(false)
    expect(isWorkType('explore')).toBe(true)
    expect(isWorkType(undefined)).toBe(true)
    expect(isWorkType('general-purpose')).toBe(true)
  })
})
