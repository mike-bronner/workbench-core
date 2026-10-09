// The delegation reminder (hooks/mods/delegation.ts, judged in
// hooks/register.ts's tool.call hook), driven through the engine. It holds
// the port to every branch of the retired bash delegation gate:
// the reminder path, each silent branch on its own, once per session, the
// scratch and plan roots compared physically, and silence on a failure. The
// scratch-root resolver itself, run as a real script on a real file system,
// is pinned by hooks/test-scratch-roots.sh.

import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { DEV_TEAM_LINE, ONCE_LINE, REMINDER, REMIND_DAYS, REMIND_STORE_KEY, hasDotPart, isInRoots, reminderOf, remindedOf, splitTarget, targetOf } from '../hooks/mods/delegation'
import { STORE_KEY } from '../hooks/mods/orchestrator'
import type { Bench, BenchOptions } from './bench'
import { DAY, HOME, LEGACY, SID, START, bench, run, start } from './bench'

const OTHER_SID = '9a8b7c6d-0000-4000-8000-000000000001'
const PAD = `/private/tmp/claude-501/-repo/${SID}/scratchpad`
const OTHER_PAD = `/private/tmp/claude-501/-repo/${OTHER_SID}/scratchpad`
const LINK_PAD = '/private/tmp/claude-501/-repo/linked/scratchpad'
const DEV_PAD = `${HOME}/Developer/scratchpad`
const PLANS = `${HOME}/.claude/plans`
const CACHE = `${HOME}/.claude/plugins/cache`
const AGENT = 'a5a2f4470341f9233'

// The modeled file system: the physical folders and files, and each symbolic
// link with where it points. /tmp is a link to /private/tmp, as on macOS.
const DIRS = new Set(['/', '/repo', '/repo/src', '/outside', '/private', '/private/tmp', PAD, `${PAD}/sub`, OTHER_PAD, `${PAD}-evil`, HOME, `${HOME}/.claude`, PLANS, `${PLANS}-evil`, DEV_PAD, CACHE])
const FILES = new Set(['/outside/target.txt', '/repo/src/a.ts'])
const LINKS: Record<string, string> = { '/tmp': '/private/tmp', [LINK_PAD]: '/outside', [`${PAD}/escape`]: '/outside', [`${PAD}/linked-file.txt`]: '/outside/target.txt' }
for (let dir = PAD; dir !== '/private'; dir = dir.slice(0, dir.lastIndexOf('/'))) DIRS.add(dir)
for (let dir = OTHER_PAD; dir !== '/private'; dir = dir.slice(0, dir.lastIndexOf('/'))) DIRS.add(dir)
DIRS.add('/private/tmp/claude-501/-repo/linked')

// Where a path lands, every link followed and `.` and `..` folded.
function realOf(path: string, dirs: ReadonlySet<string>): string {
  let real = ''
  for (const part of path.split('/').filter(Boolean)) {
    if (part === '.') continue
    real = part === '..' ? real.slice(0, real.lastIndexOf('/')) : `${real}/${part}`
    const to = LINKS[real]
    if (to !== undefined) real = to
  }
  return real || '/'
}

function model(b: Bench, dirs: Set<string> = new Set(DIRS)): Set<string> {
  b.stat = path => {
    const isLink = LINKS[path.replace(/\/+$/, '')] !== undefined
    const real = realOf(path, dirs)
    if (dirs.has(real)) return { kind: 'dir', isLink, realPath: real }
    if (FILES.has(real)) return { kind: 'file', isLink, realPath: real }
    return isLink ? { kind: 'other', isLink } : null
  }
  return dirs
}

type Options = BenchOptions & { roots?: string; isStarted?: boolean }

// A started main-agent session in /repo, under HOME, with the gate on.
async function session($: Engine, on: On, options: Options = {}): Promise<Bench> {
  const b = bench(on, { ...options, env: { HOME, ...options.env } })
  b.scripts['scratch-roots.sh'] = argv => options.roots ?? (argv[2] === SID ? `${PAD}\n${DEV_PAD}\n${PLANS}\n` : `${DEV_PAD}\n${PLANS}\n`)
  model(b)
  if (options.isStarted !== false) await $.session.start(start())
  return b
}

const write = (file_path: string, agentId?: string) => ({ tool: 'Write', file_path, content: 'x', ...(agentId ? { agentId } : {}) })
const notebook = (notebook_path: string) => ({ tool: 'NotebookEdit', notebook_path, new_source: 'x' })

// The reminder the call drew, or undefined for silence. Every call must reach
// the engine and come back with no verdict: the reminder never denies.
async function reminderFor($: Engine, b: Bench, call: Record<string, unknown>): Promise<string | undefined> {
  const before = b.inputs.length
  const result = await $.tool.call(call as never)
  expect(result.deny).toBeUndefined()
  expect(b.inputs.length).toBe(before + 1)
  const reminders = (result.context ?? []).filter(text => typeof text === 'string' && text.startsWith(REMINDER))
  expect(reminders.length).toBeLessThanOrEqual(1)
  return reminders[0] as string | undefined
}

describe('the reminder path (main agent, gate on)', () => {
  test('a main-agent Write draws the reminder, byte for byte', async ($, on) => {
    const b = await session($, on)
    expect(await reminderFor($, b, write('/repo/src/new.ts'))).toBe(`${REMINDER} ${ONCE_LINE}`)
  })

  test('a main-agent NotebookEdit draws it, its target read from notebook_path', async ($, on) => {
    const b = await session($, on)
    expect(await reminderFor($, b, notebook('/repo/n.ipynb'))).toBe(`${REMINDER} ${ONCE_LINE}`)
  })

  test('the text says the write goes ahead, names the routes, and carries no emphasis or deny', () => {
    const text = reminderOf(true)
    for (const part of ['advisory, this write goes ahead', 'a sub-agent dispatched with the Agent tool', 'Use Edit for a partial change', 'once per session']) {
      expect(text).toContain(part)
    }
    expect(text).not.toContain('**')
    expect(text).not.toContain('deny')
  })

  test('the reminder names Watson only when a dev-team plugin is installed', async ($, on) => {
    const b = await session($, on)
    const dirs = model(b)
    b.dirs.add(`${CACHE}/claude-workbench`)
    dirs.add(`${CACHE}/claude-workbench/workbench-dev-team`)
    expect(await reminderFor($, b, write('/repo/a.ts'))).toBe(`${REMINDER} ${DEV_TEAM_LINE} ${ONCE_LINE}`)
  })

  test('another plugin in the cache is not a dev-team plugin', async ($, on) => {
    const b = await session($, on)
    b.dirs.add(`${CACHE}/claude-workbench`)
    expect(await reminderFor($, b, write('/repo/a.ts'))).not.toContain(DEV_TEAM_LINE)
  })

  test('the write is not given an allow: the permission flow beneath decides', async ($, on) => {
    const b = await session($, on)
    const result = await $.tool.call(write('/repo/a.ts') as never)
    expect(Object.keys(result).filter(key => key !== 'result' && key !== 'context')).toEqual([])
    expect(b.inputs).toHaveLength(1)
  })
})

describe('the reminder fires at most once per session', () => {
  test('the first write is reminded, the second Write and a later NotebookEdit are not', async ($, on) => {
    const b = await session($, on)
    expect(await reminderFor($, b, write('/repo/a.ts'))).toBeDefined()
    expect(await reminderFor($, b, write('/repo/b.ts'))).toBeUndefined()
    expect(await reminderFor($, b, notebook('/repo/n.ipynb'))).toBeUndefined()
  })

  test('two writes racing each other draw one reminder', async ($, on) => {
    const b = await session($, on)
    const results = await Promise.all([1, 2, 3].map(n => $.tool.call(write(`/repo/${n}.ts`) as never)))
    expect(results.filter(result => (result.context ?? []).some(text => String(text).startsWith(REMINDER)))).toHaveLength(1)
    expect(b.inputs).toHaveLength(3)
  })

  test('the reminded session is recorded in the store, so a new process stays quiet', async ($, on) => {
    const b = await session($, on)
    await reminderFor($, b, write('/repo/a.ts'))
    expect(b.store.get(REMIND_STORE_KEY)).toEqual({ [SID]: START })
  })

  test('a session already reminded in an earlier process is not reminded again', async ($, on) => {
    const b = await session($, on, { store: { [REMIND_STORE_KEY]: { [SID]: START - DAY } } })
    expect(await reminderFor($, b, write('/repo/a.ts'))).toBeUndefined()
  })

  test('a different session still gets its own reminder', async ($, on) => {
    const b = await session($, on, { store: { [REMIND_STORE_KEY]: { [OTHER_SID]: START } } })
    expect(await reminderFor($, b, write('/repo/a.ts'))).toBeDefined()
  })

  test('records older than the keep window are swept on the next write', async ($, on) => {
    const old = START - REMIND_DAYS * DAY
    const b = await session($, on, { store: { [REMIND_STORE_KEY]: { [OTHER_SID]: old, [SID]: old } } })
    expect(await reminderFor($, b, write('/repo/a.ts'))).toBeDefined()
    expect(b.store.get(REMIND_STORE_KEY)).toEqual({ [SID]: START })
  })

  test('remindedOf keeps fresh numeric entries only', () => {
    expect(remindedOf({ a: 5, b: 'x', c: 0 }, REMIND_DAYS * DAY)).toEqual({ a: 5 })
    expect(remindedOf(null, 0)).toEqual({})
  })
})

describe('a write denied beneath the module', () => {
  test('draws no reminder, and the next write in the session still gets it', async ($, on) => {
    const b = await session($, on)
    b.denyBeneath = tool => (tool === 'Write' ? 'denied by a rule' : undefined)
    const denied = await $.tool.call(write('/repo/a.ts') as never)
    expect(denied.deny).toBe('denied by a rule')
    expect((denied.context ?? []).some(text => String(text).startsWith(REMINDER))).toBe(false)
    b.denyBeneath = undefined
    expect(await reminderFor($, b, write('/repo/b.ts'))).toBe(`${REMINDER} ${ONCE_LINE}`)
  })
})

describe('silent branches, each on its own', () => {
  test('Edit is not gated', async ($, on) => {
    const b = await session($, on)
    const result = await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' } as never)
    expect((result.context ?? []).some(text => String(text).startsWith(REMINDER))).toBe(false)
    // Edit spent no reminder: the next Write still draws it.
    expect(await reminderFor($, b, write('/repo/a.ts'))).toBeDefined()
  })

  test('Bash and Read are not gated', async ($, on) => {
    const b = await session($, on)
    for (const call of [{ tool: 'Bash', command: 'true' }, { tool: 'Read', file_path: '/repo/src/a.ts' }]) {
      const result = await $.tool.call(call as never)
      expect((result.context ?? []).some(text => String(text).startsWith(REMINDER))).toBe(false)
    }
    expect(await reminderFor($, b, write('/repo/a.ts'))).toBeDefined()
  })

  test('a sub-agent, with agentId, is silent and spends no reminder', async ($, on) => {
    const b = await session($, on)
    expect(await reminderFor($, b, write('/repo/a.ts', AGENT))).toBeUndefined()
    expect(await reminderFor($, b, write('/repo/a.ts'))).toBeDefined()
  })

  test('a top-level --agent run, with no agentId, is silent', async ($, on) => {
    const b = await session($, on, { env: { CLAUDE_CODE_AGENT: 'holmes' } })
    expect(await reminderFor($, b, write('/repo/a.ts'))).toBeUndefined()
  })

  test('WORKBENCH_ORCHESTRATOR=0 silences it, and any other value does not', async ($, on) => {
    const b = await session($, on, { env: { WORKBENCH_ORCHESTRATOR: '0' } })
    expect(await reminderFor($, b, write('/repo/a.ts'))).toBeUndefined()
  })

  test('WORKBENCH_ORCHESTRATOR=1 leaves it on', async ($, on) => {
    const b = await session($, on, { env: { WORKBENCH_ORCHESTRATOR: '1' } })
    expect(await reminderFor($, b, write('/repo/a.ts'))).toBeDefined()
  })

  test('/orchestrator off silences it, and /orchestrator on brings it back', async ($, on) => {
    const b = await session($, on)
    await $.command.run(run('orchestrator', 'off'))
    expect(await reminderFor($, b, write('/repo/a.ts'))).toBeUndefined()
    await $.command.run(run('orchestrator', 'on'))
    expect(await reminderFor($, b, write('/repo/a.ts'))).toBeDefined()
  })

  test('a session stored as off is silent', async ($, on) => {
    const b = await session($, on, { store: { [STORE_KEY]: { [SID]: START } } })
    expect(await reminderFor($, b, write('/repo/a.ts'))).toBeUndefined()
  })

  test('another session stored as off does not silence this one', async ($, on) => {
    const b = await session($, on, { store: { [STORE_KEY]: { [OTHER_SID]: START } } })
    expect(await reminderFor($, b, write('/repo/a.ts'))).toBeDefined()
  })

  test('a legacy off file the model planted is removed, and the reminder stays on', async ($, on) => {
    const b = await session($, on)
    b.files.set(LEGACY, '')
    expect(await reminderFor($, b, write('/repo/a.ts'))).toBeDefined()
    expect(b.files.has(LEGACY)).toBe(false)
  })

  test('a session id that cannot name a file is silent', async ($, on) => {
    const b = await session($, on, { sessionId: '../escape' })
    expect(await reminderFor($, b, write('/repo/a.ts'))).toBeUndefined()
  })

  test('an empty HOME is silent', async ($, on) => {
    const b = await session($, on, { env: { HOME: '' } })
    expect(await reminderFor($, b, write('/repo/a.ts'))).toBeUndefined()
  })
})

describe('scratch files and plans draw no reminder', () => {
  const silent: [string, string][] = [
    ['a commit message in the session scratchpad', `${PAD}/commit-msg.txt`],
    ['a subfolder not made yet', `${PAD}/new/deeper/x.md`],
    ['the pad by its /tmp spelling', `${PAD.replace('/private', '')}/msg.txt`],
    ["the login home's Developer/scratchpad", `${DEV_PAD}/x.txt`],
    ['a plan in .claude/plans', `${PLANS}/plan.md`],
  ]
  for (const [name, path] of silent) {
    test(`silent: ${name}`, async ($, on) => {
      const b = await session($, on)
      expect(await reminderFor($, b, write(path))).toBeUndefined()
      // Silence spends no reminder.
      expect(await reminderFor($, b, write('/repo/a.ts'))).toBeDefined()
    })
  }

  test('silent: a NotebookEdit with only notebook_path in the pad', async ($, on) => {
    const b = await session($, on)
    expect(await reminderFor($, b, notebook(`${PAD}/scratch.ipynb`))).toBeUndefined()
  })

  test('silent: a plan whose plans folder does not exist yet', async ($, on) => {
    const b = await session($, on)
    const dirs = model(b)
    dirs.delete(PLANS)
    expect(await reminderFor($, b, write(`${PLANS}/first-plan.md`))).toBeUndefined()
  })

  const reminded: [string, string, string?][] = [
    ['a project file', '/repo/src/file.txt'],
    ['the scratchpad folder itself', PAD],
    ["another session's scratchpad", `${OTHER_PAD}/msg.txt`],
    ['a scratchpad that is a symlink out', `${LINK_PAD}/x.txt`, `${LINK_PAD}\n`],
    ['a symlinked folder inside the pad', `${PAD}/escape/x.txt`],
    ['a symlinked file inside the pad', `${PAD}/linked-file.txt`],
    ['climbing out with ..', `${PAD}/../../../../outside.txt`],
    ['climbing out of a folder not made yet', `${PAD}/never/../../x.txt`],
    ['a . below the deepest folder', `${PAD}/never/./x.txt`],
    ['a relative path', 'scratchpad/msg.txt'],
    ['no file_path at all', ''],
    ["a sibling sharing the pad's prefix", `${PAD}-evil/x.txt`],
    ['a plans folder lookalike', `${PLANS}-evil/x.md`],
  ]
  for (const [name, path, roots] of reminded) {
    test(`reminded: ${name}`, async ($, on) => {
      const b = await session($, on, roots === undefined ? {} : { roots })
      expect(await reminderFor($, b, write(path))).toBeDefined()
    })
  }

  test('a filesystem root in the resolver answer counts for nothing', async ($, on) => {
    const b = await session($, on, { roots: '/\n' })
    expect(await reminderFor($, b, write('/repo/a.ts'))).toBeDefined()
  })

  test('a resolver that cannot run means no root, so the reminder fires', async ($, on) => {
    const b = await session($, on)
    delete b.scripts['scratch-roots.sh']
    expect(await reminderFor($, b, write(`${PAD}/x.txt`))).toBeDefined()
  })

  test('the target helpers', () => {
    expect(targetOf({ file_path: '/a', notebook_path: '/b' })).toBe('/a')
    expect(targetOf({ notebook_path: '/b' })).toBe('/b')
    expect(targetOf({ file_path: 7 })).toBe('')
    expect(splitTarget('/a/b')).toEqual({ dir: '/a', name: 'b' })
    for (const bad of ['rel/x', '/a/', '/a/.', '/a/..', '']) expect(splitTarget(bad)).toBeUndefined()
    expect(hasDotPart('a/../b')).toBe(true)
    expect(hasDotPart('a/./b')).toBe(true)
    expect(hasDotPart('a/..b')).toBe(false)
    expect(isInRoots('/pad/x', ['/pad/'])).toBe(true)
    expect(isInRoots('/pad-evil/x', ['/pad'])).toBe(false)
    expect(isInRoots('/x', ['/', ''])).toBe(false)
  })
})

describe('a failure inside it is silence, never a blocked write', () => {
  test('a store that cannot be read: the write goes ahead, silent', async ($, on) => {
    const b = await session($, on, { storeFails: true })
    expect(await reminderFor($, b, write('/repo/a.ts'))).toBeUndefined()
  })

  test('a store that cannot be written: silent, and not repeated', async ($, on) => {
    const b = await session($, on, { storeSetFails: [REMIND_STORE_KEY] })
    expect(await reminderFor($, b, write('/repo/a.ts'))).toBeUndefined()
    expect(await reminderFor($, b, write('/repo/b.ts'))).toBeUndefined()
  })

  test('a stat that throws on the target: the write goes ahead, silent', async ($, on) => {
    const b = await session($, on)
    b.stat = () => {
      throw new Error('stat failed')
    }
    expect(await reminderFor($, b, write('/repo/a.ts'))).toBeUndefined()
  })

  test('before session start the lane is unknown: silent', async ($, on) => {
    const b = await session($, on, { isStarted: false })
    expect(await reminderFor($, b, write('/repo/a.ts'))).toBeUndefined()
  })
})
