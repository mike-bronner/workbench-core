import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptOrigin } from 'claude-code'

import { followedTagsOf } from '../hooks/mods/follow-tags'
import { FORCE_REFUSAL, SUBAGENT_REFUSAL } from '../hooks/mods/commit-guard'
import type { Script } from '../hooks/mods/full-suite'
import { SUITE_PARTS_FILE, isWholeRun, partOf, suitePartsOf } from '../hooks/mods/full-suite'
import type { Bench } from './bench'
import { ASKS, HOME, PERSON, SID, bench, exactly, start } from './bench'

const TREE = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const URL = 'git@github.com:o/r.git'
const SUITE = 'claude plugin test .'
const COMMIT = 'git commit -m "fix: 🐛 X."'
const ALLOW = { behavior: 'allow' }
const ASKED = /^This (line|git commit) was refused/

type World = {
  work: string
  staged: string
  scratch: Map<string, string>
  branch: string
  pushTarget: string
  pushUrls: string[]
  config: Record<string, string>
  indexEnvs: (string | undefined)[]
  committed: Map<string, string>
  dirty: Set<string>
  tracked: string | undefined
  fetchSpec: string | undefined
  parents: Map<string, string[]>
  trees: Map<string, string>
  otherFetch: string[]
  hooksPath: string | undefined
  hookConfig: string
  unreadable: Set<string>
  dryRun: { exitCode: number; stdout: string } | 'reject'
  dryRuns: { argv: readonly string[]; env: Readonly<Record<string, string>> | undefined }[]
}

const ok = (stdout: string) => ({ exitCode: 0, stdout })
const SCRATCH = /^workbench-tree-index-[A-Za-z0-9-]+$/
const PUSH_KEYS: ReadonlySet<string> = new Set(['push.default', 'remote.origin.push', 'remote.origin.mirror', 'push.followTags', 'push.recurseSubmodules', 'submodule.recurse'])

const world = (): World => ({ work: TREE, staged: TREE, scratch: new Map(), branch: 'feat', pushTarget: 'origin refs/heads/feat', pushUrls: [URL], config: {}, indexEnvs: [], committed: new Map(), dirty: new Set(), tracked: undefined, fetchSpec: '+refs/heads/*:refs/remotes/origin/*', parents: new Map(), trees: new Map(), otherFetch: [], hooksPath: undefined, hookConfig: '', unreadable: new Set(), dryRun: { exitCode: 0, stdout: '' }, dryRuns: [] })

const pushedLine = (branch: string, flag = '*'): string => `${flag}\trefs/heads/${branch}:refs/heads/${branch}\t[new branch]`
const tagLine = (tag: string): string => `*\trefs/tags/${tag}:refs/tags/${tag}\t[new tag]`
const porcelain = (...lines: string[]): string => [`To ${URL}`, ...lines, 'Done', ''].join('\n')

function ancestorsOf(w: World, from: string | undefined): Set<string> {
  const seen = new Set<string>()
  const queue = from === undefined ? [] : [from]
  while (queue.length > 0) {
    const at = queue.shift() as string
    if (seen.has(at)) continue
    seen.add(at)
    queue.push(...(w.parents.get(at) ?? []))
  }
  return seen
}

function modelGit(b: Bench, worlds: Record<string, World>): void {
  b.run = (argv, init) => {
    if (argv[0] === 'cp') {
      const at = Object.keys(worlds).find(top => (argv[2] ?? '').startsWith(`${top}/.git/`))
      if (at !== undefined) (worlds[at] as World).scratch.set(argv[2] as string, (worlds[at] as World).staged)
      return ok('')
    }
    if (argv[0] === 'rm') {
      for (const w of Object.values(worlds)) for (const path of argv.slice(2)) w.scratch.delete(path)
      return ok('')
    }
    if (argv[0] !== 'git' || argv[1] !== '-C') return undefined
    const top = argv[2] ?? ''
    const w = worlds[top]
    if (w === undefined) return undefined
    const verb = argv.slice(3).join(' ')
    const index = init?.env?.GIT_INDEX_FILE
    if (verb === 'rev-parse --path-format=absolute --git-path index') return ok(`${top}/.git/index\n`)
    if (argv[3] === 'rev-parse' && argv[5] === '--git-path' && SCRATCH.test(argv[6] ?? '')) return ok(`${top}/.git/${argv[6]}\n`)
    if (verb === 'add -A' || verb === 'write-tree') {
      w.indexEnvs.push(index)
      if (index === undefined || !w.scratch.has(index)) return { exitCode: 128, stdout: '' }
      if (verb === 'add -A') {
        w.scratch.set(index, w.work)
        return ok('')
      }
      return ok(`${w.scratch.get(index)}\n`)
    }
    const head = b.repos[top]?.head ?? ''
    if (verb === 'show -s --no-show-signature --format=%H %T %P HEAD') return ok(`${head} ${w.trees.get(head) ?? ''} ${(w.parents.get(head) ?? []).join(' ')}\n`)
    if (verb === 'rev-parse --path-format=absolute --git-path hooks') return ok(`${w.hooksPath ?? `${top}/.git/hooks`}\n`)
    if (verb === 'config --get-regexp ^hook\\.') return w.hookConfig === '' ? { exitCode: 1, stdout: '' } : ok(w.hookConfig)
    if (verb === 'config --get-regexp ^remote\\..*\\.fetch$') {
      const lines = [...(w.fetchSpec === undefined ? [] : [`remote.origin.fetch ${w.fetchSpec}`]), ...w.otherFetch]
      return lines.length === 0 ? { exitCode: 1, stdout: '' } : ok(lines.map(line => `${line}\n`).join(''))
    }
    if (verb === 'config --get-all remote.origin.fetch') return w.fetchSpec === undefined ? { exitCode: 1, stdout: '' } : ok(`${w.fetchSpec}\n`)
    if (verb === `merge-base --is-ancestor refs/remotes/origin/${w.branch} HEAD`) return { exitCode: w.tracked === undefined ? 128 : ancestorsOf(w, head).has(w.tracked) ? 0 : 1, stdout: '' }
    if (verb === `rev-list refs/remotes/origin/${w.branch}..HEAD`) {
      if (w.tracked === undefined) return { exitCode: 128, stdout: '' }
      const sent = ancestorsOf(w, w.tracked)
      return ok([...ancestorsOf(w, head)].filter(sha => !sent.has(sha)).map(sha => `${sha}\n`).join(''))
    }
    if (verb === 'symbolic-ref --short -q HEAD') return ok(`${w.branch}\n`)
    if (verb === `for-each-ref --format=%(push:remotename) %(push:remoteref) refs/heads/${w.branch}`) return ok(`${w.pushTarget}\n`)
    if (verb === 'remote get-url --push --all origin') return ok(w.pushUrls.map(url => `${url}\n`).join(''))
    if (verb === `push --dry-run --porcelain --no-verify --follow-tags --recurse-submodules=no -- origin refs/heads/${w.branch}:refs/heads/${w.branch}`) {
      w.dryRuns.push({ argv, env: init?.env })
      if (w.dryRun === 'reject') throw new Error('timed out')
      return w.dryRun
    }
    if (argv[3] === 'config' && argv[4] === '--get' && argv.length === 6 && w.unreadable.has(argv[5] ?? '')) return { exitCode: 128, stdout: '' }
    if (argv[3] === 'config' && (argv[4] === '--get' || argv[4] === '--get-all') && argv.length === 6 && PUSH_KEYS.has(argv[5] ?? '')) {
      const value = w.config[argv[5] ?? '']
      return value === undefined ? { exitCode: 1, stdout: '' } : ok(`${value}\n`)
    }
    if (verb.startsWith('--literal-pathspecs ls-tree --name-only HEAD -- ')) {
      const path = argv.at(-1) ?? ''
      return ok(w.committed.has(path) ? `${path}\n` : '')
    }
    if (argv[3] === 'show' && argv.length === 5 && (argv[4] ?? '').startsWith('HEAD:')) {
      const text = w.committed.get((argv[4] ?? '').slice('HEAD:'.length))
      return text === undefined ? { exitCode: 128, stdout: '' } : ok(text)
    }
    if (argv[3] === 'cat-file' && argv[4] === '-e' && argv.length === 6) return { exitCode: w.committed.has((argv[5] ?? '').replace(/^HEAD:/, '')) ? 0 : 128, stdout: '' }
    if (verb.startsWith('--literal-pathspecs diff --quiet HEAD -- ')) {
      const paths = argv.slice(argv.indexOf('--') + 1)
      return { exitCode: paths.some(path => w.dirty.has(path)) ? 1 : 0, stdout: '' }
    }
    return undefined
  }
}

const brief = (goal: string): string =>
  `Workdir: /repo\nGoal: ${goal}\nContext: The tree holds the change.\nConstraints:\n- Run no mutation testing of any kind.\nAcceptance:\n- AC1: it holds.\nDone when: it holds.`

const FINAL = brief('Final suite run: the uncommitted tree at /repo.')

type Options = { isInteractive?: boolean; env?: Record<string, string>; origin?: PromptOrigin }

async function session($: Engine, on: On, options: Options = {}): Promise<{ b: Bench; w: World; worlds: Record<string, World> }> {
  const b = bench(on, { env: { HOME, ...options.env } })
  b.scripts['scratch-roots.sh'] = () => '/scratch\n'
  for (const top of ['/repo', '/other']) {
    b.repos[top] = { head: 'c1', pushed: 'c1', branch: 'feat', originHead: 'main', originUrl: URL }
    b.trees[top] = 'M  README.md\0'
  }
  const worlds = { '/repo': world(), '/other': world() }
  modelGit(b, worlds)
  on('agent.spawn', async (_$, e) => ({ model: 'opus', agentId: (e as { description: string }).description }))
  on('classic.SubagentStop', () => ({}))
  await $.session.start(start(options.isInteractive ?? true))
  await $.prompt.submit({ text: 'look this over', wait: false, origin: options.origin ?? PERSON })
  return { b, w: worlds['/repo'], worlds }
}

async function bash($: Engine, b: Bench, command: string, agentId?: string, extra: Record<string, unknown> = {}): Promise<string | undefined> {
  const before = b.calls.filter(call => call.tool === 'Bash').length
  const result = await $.tool.call({ tool: 'Bash', command, ...(agentId ? { agentId } : {}), ...extra } as never)
  expect([command, b.calls.filter(call => call.tool === 'Bash').length > before]).toEqual([command, result.deny === undefined])
  return result.deny
}

async function asked($: Engine, command: string, agentId?: string): Promise<unknown> {
  const result = await $.classic.PermissionRequest({
    ...(agentId === undefined ? {} : { agent_id: agentId }),
    hook_event_name: 'PermissionRequest',
    session_id: 's',
    transcript_path: '/t.jsonl',
    cwd: '/repo',
    tool_name: 'Bash',
    tool_input: { command },
  } as never)
  return (result as { decision?: unknown }).decision
}

async function spawnFinal($: Engine): Promise<void> {
  expect((await $.agent.spawn({ prompt: FINAL, subagentType: 'workbench-dev-team:holmes', description: 'holmes' } as never)).agentId).toBe('holmes')
}

async function spawnWatson($: Engine): Promise<void> {
  expect((await $.agent.spawn({ prompt: brief('Fix the bug.'), subagentType: 'workbench-dev-team:watson', description: 'watson' } as never)).agentId).toBe('watson')
}

async function finalRun($: Engine, b: Bench, isRed = false, line = SUITE, extra: Record<string, unknown> = {}): Promise<void> {
  await spawnFinal($)
  b.onBash = command => (command === line && isRed ? { isError: true } : undefined)
  expect(await bash($, b, line, 'holmes', extra)).toBeUndefined()
  b.onBash = undefined
}

describe('AC1: a commit of the tree a green final suite run saw runs with no question', () => {
  test('after a green run, the commit runs and its permission dialog is answered', async ($, on) => {
    const { b, w } = await session($, on)
    await finalRun($, b)
    expect(await asked($, COMMIT)).toEqual(ALLOW)
    expect(await asked($, 'git commit -F /repo/message.txt')).toEqual(ALLOW)
    expect(await bash($, b, COMMIT)).toBeUndefined()
    expect(w.indexEnvs.length).toBeGreaterThan(0)
    expect(w.indexEnvs.every(index => index !== undefined && SCRATCH.test(index.split('/').pop() ?? ''))).toBe(true)
  })

  test('each tree reading uses an index of its own, and removes it and its lock', async ($, on) => {
    const { b, w } = await session($, on)
    await finalRun($, b)
    const indexes = new Set(w.indexEnvs)
    expect(indexes.size).toBeGreaterThan(1)
    expect(w.scratch.size).toBe(0)
    const removed = b.runs.filter(argv => argv[0] === 'rm').flatMap(argv => argv.slice(2))
    for (const index of indexes) expect(removed).toEqual(expect.arrayContaining([index, `${index}.lock`]))
  })

  test('with no final suite run, the commit asks as today', async ($, on) => {
    const { b } = await session($, on)
    expect(await asked($, COMMIT)).toBeUndefined()
    expect(await bash($, b, COMMIT)).toMatch(ASKS.commit)
  })

  test('after a red run, the commit asks', async ($, on) => {
    const { b } = await session($, on)
    await finalRun($, b, true)
    expect(await asked($, COMMIT)).toBeUndefined()
    expect(await bash($, b, COMMIT)).toMatch(ASKS.commit)
  })

  test('a red run after a green one takes the green back', async ($, on) => {
    const { b } = await session($, on)
    await finalRun($, b)
    await finalRun($, b, true)
    expect(await bash($, b, COMMIT)).toMatch(ASKS.commit)
  })

  test('a run in the background records no green', async ($, on) => {
    const { b } = await session($, on)
    await finalRun($, b, false, SUITE, { run_in_background: true })
    expect(await bash($, b, COMMIT)).toMatch(ASKS.commit)
  })

  test('a run whose result carries a background task id records no green', async ($, on) => {
    const { b } = await session($, on)
    b.replyBeneath = tool => (tool === 'Bash' ? ({ backgroundTaskId: 'bg1' } as never) : undefined)
    await finalRun($, b)
    b.replyBeneath = undefined
    expect(await bash($, b, COMMIT)).toMatch(ASKS.commit)
  })

  test('a tree staged after the run differs from the green tree, so the commit asks', async ($, on) => {
    const { b, w } = await session($, on)
    await finalRun($, b)
    w.staged = OTHER
    expect(await asked($, COMMIT)).toBeUndefined()
    expect(await bash($, b, COMMIT)).toMatch(ASKS.commit)
  })

  test('a tree that changed during the run records no green', async ($, on) => {
    const { b, w } = await session($, on)
    b.duringBash = async command => {
      if (command === SUITE) w.work = OTHER
    }
    await finalRun($, b)
    w.staged = OTHER
    expect(await bash($, b, COMMIT)).toMatch(ASKS.commit)
  })

  test('a commit in another repository whose staged tree equals the green tree asks', async ($, on) => {
    const { b } = await session($, on)
    await finalRun($, b)
    b.cwd = '/other'
    expect(await bash($, b, COMMIT)).toMatch(ASKS.commit)
  })

  test('/clear drops the green record', async ($, on) => {
    const { b } = await session($, on)
    await finalRun($, b)
    await $.session.end({ reason: 'clear', sessionId: SID } as never)
    await $.prompt.submit({ text: 'look again', wait: false, origin: PERSON })
    expect(await bash($, b, COMMIT)).toMatch(ASKS.commit)
  })

  for (const line of [`${SUITE} | tail -5`, `${SUITE} || true`, `${SUITE}; true`, `${SUITE} && true`, `WORKBENCH_CHECKS=plugin_json ${SUITE}`]) {
    test(`a run that may not be whole or green, ${JSON.stringify(line)}, records no green`, async ($, on) => {
      const { b } = await session($, on)
      await finalRun($, b, false, line)
      expect(await bash($, b, COMMIT)).toMatch(ASKS.commit)
    })
  }

  test('a Holmes that is no final run is refused the suite and records nothing', async ($, on) => {
    const { b } = await session($, on)
    await $.agent.spawn({ prompt: brief('Review the uncommitted tree at /repo.'), subagentType: 'workbench-dev-team:holmes', description: 'holmes' } as never)
    expect(await bash($, b, SUITE, 'holmes')).toBeDefined()
    expect(await bash($, b, COMMIT)).toMatch(ASKS.commit)
  })

  test('with the full-suite gate stood down, a suite run by the main session or a non-runner sub-agent records nothing', async ($, on) => {
    const { b, w } = await session($, on, { env: { WORKBENCH_ORCHESTRATOR: '0' } })
    await $.agent.spawn({ prompt: brief('Fix the bug.'), subagentType: 'workbench-dev-team:watson', description: 'watson' } as never)
    expect(await bash($, b, SUITE)).toBeUndefined()
    expect(await bash($, b, SUITE, 'watson')).toBeUndefined()
    expect(w.indexEnvs).toEqual([])
    expect(await bash($, b, COMMIT)).toMatch(ASKS.commit)
  })

  test('a final run in a session no one sits at records nothing', async ($, on) => {
    const { b, w } = await session($, on, { isInteractive: false })
    await finalRun($, b)
    expect(w.indexEnvs).toEqual([])
  })

  test('a commit with -a, or a second commit on the line, still asks after a green run', async ($, on) => {
    const { b } = await session($, on)
    await finalRun($, b)
    expect(await asked($, 'git commit -am "fix: 🐛 X."')).toBeUndefined()
    expect(await asked($, `${COMMIT} && git commit -m "fix: 🐛 Y."`)).toBeUndefined()
  })

  test('a free commit still needs the whole tree staged and a valid subject', async ($, on) => {
    const { b } = await session($, on)
    await finalRun($, b)
    b.trees['/repo'] = 'M  README.md\0?? notes.md\0'
    expect(await bash($, b, COMMIT)).toContain('notes.md')
    b.trees['/repo'] = 'M  README.md\0'
    expect(await bash($, b, 'git commit -m "fixed things"')).toBeDefined()
  })

  test('after a green run, a commit with a push runs free on a feature branch and asks on main with no remote-tracking ref', async ($, on) => {
    const { b, w } = await session($, on)
    await finalRun($, b)
    expect(await bash($, b, `${COMMIT} && git push`)).toBeUndefined()
    w.branch = 'main'
    w.pushTarget = 'origin refs/heads/main'
    b.repos['/repo'] = { ...b.repos['/repo'], branch: 'main' }
    expect(await bash($, b, `${COMMIT} && git push`)).toMatch(ASKED)
  })

  for (const line of [
    `${COMMIT} && git rebase main`,
    'gh pr merge 12',
    'gh release create 1.0.0 --notes x',
    "gh alias set co 'pr checkout'",
    'gh api repos/o/r/git/refs/heads/main -X PATCH -f sha=abc',
  ]) {
    test(`after a green run, ${JSON.stringify(line)} still asks`, async ($, on) => {
      const { b } = await session($, on)
      await finalRun($, b)
      expect(await bash($, b, line)).toBeDefined()
    })
  }
})

describe('AC2: a plain push of a feature branch runs free, and a push to the default branch with no green commit asks', () => {
  test('a plain git push, and git push origin <branch>, of a feature branch run with no question', async ($, on) => {
    const { b } = await session($, on)
    expect(await asked($, 'git push')).toEqual(ALLOW)
    expect(await bash($, b, 'git push')).toBeUndefined()
    expect(await bash($, b, 'git push origin feat')).toBeUndefined()
  })

  test('a push from the default branch asks', async ($, on) => {
    const { b, w } = await session($, on)
    w.branch = 'main'
    w.pushTarget = 'origin refs/heads/main'
    b.repos['/repo'] = { ...b.repos['/repo'], branch: 'main' }
    expect(await asked($, 'git push')).toBeUndefined()
    expect(await bash($, b, 'git push')).toMatch(ASKS.push)
  })

  test('a plain push whose upstream is the default branch asks', async ($, on) => {
    const { b, w } = await session($, on)
    w.pushTarget = 'origin refs/heads/main'
    expect(await bash($, b, 'git push')).toMatch(ASKS.push)
  })

  for (const line of ['git push origin main', 'git push origin feat:main', 'git push origin --tags', 'git push -u origin feat', 'git push upstream feat']) {
    test(`${JSON.stringify(line)} asks`, async ($, on) => {
      const { b } = await session($, on)
      expect(await bash($, b, line)).toMatch(ASKS.push)
    })
  }

  for (const [key, value] of [
    ['push.default', 'matching'],
    ['remote.origin.push', '+refs/heads/*:refs/heads/*'],
    ['remote.origin.mirror', 'true'],
  ] as const) {
    test(`a push with ${key}=${value} asks, in both forms`, async ($, on) => {
      const { b, w } = await session($, on)
      w.config[key] = value
      expect(await asked($, 'git push')).toBeUndefined()
      expect(await bash($, b, 'git push')).toMatch(ASKS.push)
      expect(await bash($, b, 'git push origin feat')).toMatch(ASKS.push)
    })
  }

  test('push.default=simple and false switches keep the plain push free', async ($, on) => {
    const { b, w } = await session($, on)
    w.config = { 'push.default': 'simple', 'remote.origin.mirror': 'false', 'push.followTags': 'false' }
    expect(await bash($, b, 'git push')).toBeUndefined()
    expect(w.dryRuns).toEqual([])
  })

  test('a force push is refused as today', async ($, on) => {
    const { b } = await session($, on)
    expect(await bash($, b, 'git push --force')).toBeDefined()
  })

  test('a push whose push URL differs from the pinned origin asks', async ($, on) => {
    const { b, w } = await session($, on)
    w.pushUrls = ['git@evil.example:o/r.git']
    expect(await bash($, b, 'git push')).toMatch(ASKS.push)
  })

  test('a remote with two push URLs, one of them not pinned, asks in both forms', async ($, on) => {
    const { b, w } = await session($, on)
    w.pushUrls = [URL, 'git@evil.example:o/r.git']
    expect(await bash($, b, 'git push')).toMatch(ASKS.push)
    expect(await bash($, b, 'git push origin feat')).toMatch(ASKS.push)
  })

  test('a push to an origin with no known default branch asks', async ($, on) => {
    const { b } = await session($, on)
    b.repos['/repo'] = { ...b.repos['/repo'], originHead: undefined }
    expect(await bash($, b, 'git push')).toMatch(ASKS.push)
  })
})

const BASE = 'd'.repeat(40)
const SIDE = 'f'.repeat(40)

function onMain(b: Bench, w: World): void {
  w.branch = 'main'
  w.pushTarget = 'origin refs/heads/main'
  w.tracked = BASE
  b.repos['/repo'] = { ...b.repos['/repo'], branch: 'main', head: BASE }
}

function commitOn(b: Bench, w: World, tree: string, parents: string[] = [b.repos['/repo']?.head ?? '']): string {
  const sha = (w.parents.size + 1).toString(16).padStart(40, 'e')
  w.parents.set(sha, parents)
  w.trees.set(sha, tree)
  b.repos['/repo'] = { ...b.repos['/repo'], head: sha }
  return sha
}

async function greenCommit($: Engine, b: Bench, w: World, landed: (b: Bench, w: World) => void = () => void commitOn(b, w, w.staged)): Promise<void> {
  await finalRun($, b)
  b.duringBash = async command => {
    if (command === COMMIT) landed(b, w)
  }
  expect(await bash($, b, COMMIT)).toBeUndefined()
  b.duringBash = undefined
}

describe('a plain push of the default branch runs free when every commit it sends came from a green run', () => {
  test('after a free green commit on main, git push and git push origin main run with no question', async ($, on) => {
    const { b, w } = await session($, on)
    onMain(b, w)
    await greenCommit($, b, w)
    expect(await asked($, 'git push')).toEqual(ALLOW)
    expect(await asked($, 'git push origin main')).toEqual(ALLOW)
    expect(await bash($, b, 'git push')).toBeUndefined()
    expect(await bash($, b, 'git push origin main')).toBeUndefined()
  })

  test('two free green commits in a row push free together', async ($, on) => {
    const { b, w } = await session($, on)
    onMain(b, w)
    await greenCommit($, b, w)
    w.work = OTHER
    w.staged = OTHER
    await greenCommit($, b, w)
    expect(await bash($, b, 'git push')).toBeUndefined()
  })

  test('with no commit hooks, a green commit and its push on one line run free on main, and the commit is recorded', async ($, on) => {
    const { b, w } = await session($, on)
    onMain(b, w)
    await finalRun($, b)
    const line = `${COMMIT} && git push`
    b.duringBash = async command => {
      if (command === line) commitOn(b, w, w.staged)
    }
    expect(await asked($, line)).toEqual(ALLOW)
    expect(await bash($, b, line)).toBeUndefined()
    b.duringBash = undefined
    expect(await bash($, b, 'git push')).toBeUndefined()
  })

  for (const [name, setUp] of [
    ['a pre-commit hook', (b: Bench, w: World) => void b.files.set('/repo/.git/hooks/pre-commit', '#!/bin/sh\n')],
    ['a commit-msg hook under core.hooksPath', (b: Bench, w: World) => {
      w.hooksPath = '/hooks'
      b.files.set('/hooks/commit-msg', '#!/bin/sh\n')
    }],
    ['a post-commit hook', (b: Bench, w: World) => void b.files.set('/repo/.git/hooks/post-commit', '#!/bin/sh\n')],
    ['a prepare-commit-msg hook', (b: Bench, w: World) => void b.files.set('/repo/.git/hooks/prepare-commit-msg', '#!/bin/sh\n')],
    ['a hook set in git config', (b: Bench, w: World) => void (w.hookConfig = 'hook.lint.event pre-commit\n')],
  ] as const) {
    test(`with ${name}, a green commit and its push on one line ask, and separate lines stay free`, async ($, on) => {
      const { b, w } = await session($, on)
      setUp(b, w)
      await finalRun($, b)
      expect(await asked($, `${COMMIT} && git push`)).toBeUndefined()
      expect(await bash($, b, `${COMMIT} && git push`)).toMatch(ASKED)
      onMain(b, w)
      expect(await bash($, b, `${COMMIT} && git push`)).toMatch(ASKED)
      await greenCommit($, b, w)
      expect(await bash($, b, 'git push')).toBeUndefined()
    })
  }

  test('a hooks path the gate cannot read makes the combined line ask', async ($, on) => {
    const { b, w } = await session($, on)
    w.hooksPath = 'relative/hooks'
    await finalRun($, b)
    expect(await bash($, b, `${COMMIT} && git push`)).toMatch(ASKED)
  })

  test('with no green commit, a push of main asks', async ($, on) => {
    const { b, w } = await session($, on)
    onMain(b, w)
    commitOn(b, w, TREE)
    expect(await asked($, 'git push')).toBeUndefined()
    expect(await bash($, b, 'git push')).toMatch(ASKS.push)
  })

  test('a commit made another way after the green one makes the push ask', async ($, on) => {
    const { b, w } = await session($, on)
    onMain(b, w)
    await greenCommit($, b, w)
    commitOn(b, w, OTHER)
    expect(await asked($, 'git push')).toBeUndefined()
    expect(await bash($, b, 'git push')).toMatch(ASKS.push)
    expect(await bash($, b, 'git push origin main')).toMatch(ASKS.push)
  })

  test('a merge commit on top of a green commit makes the push ask', async ($, on) => {
    const { b, w } = await session($, on)
    onMain(b, w)
    await greenCommit($, b, w)
    w.parents.set(SIDE, [BASE])
    commitOn(b, w, TREE, [b.repos['/repo']?.head ?? '', SIDE])
    expect(await bash($, b, 'git push')).toMatch(ASKS.push)
  })

  test('a commit the free line made with a tree other than the green one is not recorded', async ($, on) => {
    const { b, w } = await session($, on)
    onMain(b, w)
    await greenCommit($, b, w, (b, w) => void commitOn(b, w, OTHER))
    expect(await bash($, b, 'git push')).toMatch(ASKS.push)
  })

  test('a free line that leaves a second commit on top records neither', async ($, on) => {
    const { b, w } = await session($, on)
    onMain(b, w)
    await greenCommit($, b, w, (b, w) => {
      commitOn(b, w, w.staged)
      commitOn(b, w, w.staged)
    })
    expect(await bash($, b, 'git push')).toMatch(ASKS.push)
  })

  test('a non-fast-forward push of main asks', async ($, on) => {
    const { b, w } = await session($, on)
    onMain(b, w)
    await greenCommit($, b, w)
    w.parents.set(SIDE, [BASE])
    w.tracked = SIDE
    expect(await bash($, b, 'git push')).toMatch(ASKS.push)
  })

  test('a push of main with no remote-tracking ref asks', async ($, on) => {
    const { b, w } = await session($, on)
    onMain(b, w)
    await greenCommit($, b, w)
    w.tracked = undefined
    expect(await bash($, b, 'git push')).toMatch(ASKS.push)
  })

  test('a push of main with nothing to send asks', async ($, on) => {
    const { b, w } = await session($, on)
    onMain(b, w)
    await greenCommit($, b, w)
    w.tracked = b.repos['/repo']?.head
    expect(await bash($, b, 'git push')).toMatch(ASKS.push)
  })

  test('a fetch refspec other than the default makes the push of main ask', async ($, on) => {
    const { b, w } = await session($, on)
    onMain(b, w)
    await greenCommit($, b, w)
    w.fetchSpec = '+refs/heads/*:refs/remotes/origin/other/*'
    expect(await bash($, b, 'git push')).toMatch(ASKS.push)
  })

  test('a push of main whose push URL changed asks, in both forms', async ($, on) => {
    const { b, w } = await session($, on)
    onMain(b, w)
    await greenCommit($, b, w)
    w.pushUrls = ['git@evil.example:o/r.git']
    expect(await bash($, b, 'git push')).toMatch(ASKS.push)
    expect(await bash($, b, 'git push origin main')).toMatch(ASKS.push)
  })

  for (const [key, value] of [
    ['push.default', 'matching'],
    ['remote.origin.push', '+refs/heads/*:refs/heads/*'],
    ['remote.origin.mirror', 'true'],
  ] as const) {
    test(`a push of main with ${key}=${value} asks, in both forms`, async ($, on) => {
      const { b, w } = await session($, on)
      onMain(b, w)
      await greenCommit($, b, w)
      w.config[key] = value
      expect(await bash($, b, 'git push')).toMatch(ASKS.push)
      expect(await bash($, b, 'git push origin main')).toMatch(ASKS.push)
    })
  }

  for (const [line, refusal] of [
    ['git push --force', exactly(FORCE_REFUSAL.deny)],
    ['git push origin +main', exactly(FORCE_REFUSAL.deny)],
    ['git push origin main:other', ASKS.push],
    ['git push -u origin main', ASKS.push],
    ['git push origin --tags', ASKS.push],
    ['gh pr merge 12', ASKS.merge],
    ['gh release create 1.0.0 --notes x', ASKS.release],
    ['git rebase origin/main', ASKS.rewrite],
    ["gh alias set co 'pr checkout'", ASKS.alias],
    ['gh api repos/o/r/git/refs/heads/main -X PATCH -f sha=abc', ASKS.api],
  ] as const) {
    test(`after a free green commit on main, ${JSON.stringify(line)} is refused as before`, async ($, on) => {
      const { b, w } = await session($, on)
      onMain(b, w)
      await greenCommit($, b, w)
      expect(await asked($, line)).toBeUndefined()
      expect(await bash($, b, line)).toMatch(refusal)
    })
  }

  for (const [key, value] of [
    ['push.recurseSubmodules', 'on-demand'],
    ['push.recurseSubmodules', 'check'],
    ['submodule.recurse', 'true'],
  ] as const) {
    test(`${key}=${value} makes both the feature push and the push of main ask`, async ($, on) => {
      const { b, w } = await session($, on)
      w.config[key] = value
      expect(await bash($, b, 'git push')).toMatch(ASKS.push)
      onMain(b, w)
      await greenCommit($, b, w)
      expect(await asked($, 'git push')).toBeUndefined()
      expect(await bash($, b, 'git push')).toMatch(ASKS.push)
      expect(await bash($, b, 'git push origin main')).toMatch(ASKS.push)
    })
  }

  test('push.recurseSubmodules=no and submodule.recurse=false keep both pushes free', async ($, on) => {
    const { b, w } = await session($, on)
    w.config = { 'push.recurseSubmodules': 'no', 'submodule.recurse': 'false' }
    expect(await bash($, b, 'git push')).toBeUndefined()
    onMain(b, w)
    await greenCommit($, b, w)
    expect(await bash($, b, 'git push')).toBeUndefined()
  })

  test('push.default=current keeps the push of main free', async ($, on) => {
    const { b, w } = await session($, on)
    onMain(b, w)
    await greenCommit($, b, w)
    w.config['push.default'] = 'current'
    expect(await bash($, b, 'git push')).toBeUndefined()
  })

  test("another remote whose fetch refspec writes into origin's remote-tracking refs makes the push of main ask", async ($, on) => {
    const { b, w } = await session($, on)
    onMain(b, w)
    await greenCommit($, b, w)
    w.otherFetch = ['remote.up.fetch +refs/heads/*:refs/remotes/up/*']
    expect(await bash($, b, 'git push')).toBeUndefined()
    w.otherFetch = ['remote.up.fetch +refs/heads/*:refs/remotes/origin/*']
    expect(await bash($, b, 'git push')).toMatch(ASKS.push)
    w.otherFetch = ['remote.up.fetch +refs/heads/main:refs/remotes/origin/main']
    expect(await bash($, b, 'git push')).toMatch(ASKS.push)
    w.otherFetch = ['remote.up.fetch +refs/*:refs/*']
    expect(await bash($, b, 'git push')).toMatch(ASKS.push)
  })

  test('an amend that replaces the green tip makes the push of main ask', async ($, on) => {
    const { b, w } = await session($, on)
    onMain(b, w)
    await greenCommit($, b, w)
    commitOn(b, w, w.staged, [BASE])
    expect(await bash($, b, 'git push')).toMatch(ASKS.push)
  })

  test('a free commit that fails and leaves HEAD unchanged records nothing', async ($, on) => {
    const { b, w } = await session($, on)
    onMain(b, w)
    commitOn(b, w, TREE)
    await greenCommit($, b, w, () => undefined)
    expect(await bash($, b, 'git push')).toMatch(ASKS.push)
  })

  test('with no origin HEAD, a push asks until every commit it sends is green, then runs free', async ($, on) => {
    const { b, w } = await session($, on)
    w.tracked = BASE
    b.repos['/repo'] = { ...b.repos['/repo'], originHead: undefined, head: BASE }
    commitOn(b, w, OTHER)
    expect(await bash($, b, 'git push')).toMatch(ASKS.push)
    w.tracked = b.repos['/repo']?.head
    await greenCommit($, b, w)
    expect(await bash($, b, 'git push')).toBeUndefined()
  })

  test('/clear drops the green commits, so the push of main asks', async ($, on) => {
    const { b, w } = await session($, on)
    onMain(b, w)
    await greenCommit($, b, w)
    await $.session.end({ reason: 'clear', sessionId: SID } as never)
    await $.prompt.submit({ text: 'look again', wait: false, origin: PERSON })
    expect(await bash($, b, 'git push')).toMatch(ASKS.push)
  })

  test('a sub-agent pushes main free after a free green commit, and is refused once an unrecorded commit joins it', async ($, on) => {
    const { b, w } = await session($, on)
    onMain(b, w)
    await greenCommit($, b, w)
    await spawnWatson($)
    expect(await asked($, 'git push', 'watson')).toEqual(ALLOW)
    expect(await bash($, b, 'git push', 'watson')).toBeUndefined()
    commitOn(b, w, OTHER)
    expect(await asked($, 'git push', 'watson')).toBeUndefined()
    expect(await bash($, b, 'git push', 'watson')).toBe(SUBAGENT_REFUSAL.deny)
  })

  test('a feature-branch push still needs no green commit and no remote-tracking ref', async ($, on) => {
    const { b, w } = await session($, on)
    w.tracked = undefined
    w.fetchSpec = undefined
    expect(await bash($, b, 'git push')).toBeUndefined()
  })
})

describe('AC3: other lanes keep their commit and push behavior', () => {
  test('with no green run, a sub-agent is refused its commit and its push', async ($, on) => {
    const { b } = await session($, on)
    await spawnWatson($)
    expect(await asked($, COMMIT, 'watson')).toBeUndefined()
    expect(await bash($, b, COMMIT, 'watson')).toBe(SUBAGENT_REFUSAL.deny)
    expect(await bash($, b, 'git push', 'watson')).toBe(SUBAGENT_REFUSAL.deny)
  })

  test('after a green run, a sub-agent commits the green tree and pushes the green commit with no question', async ($, on) => {
    const { b, w } = await session($, on)
    w.tracked = BASE
    b.repos['/repo'] = { ...b.repos['/repo'], head: BASE }
    await finalRun($, b)
    await spawnWatson($)
    b.duringBash = async command => {
      if (command === COMMIT) commitOn(b, w, w.staged)
    }
    expect(await asked($, COMMIT, 'watson')).toEqual(ALLOW)
    expect(await bash($, b, COMMIT, 'watson')).toBeUndefined()
    b.duringBash = undefined
    expect(await asked($, 'git push', 'watson')).toEqual(ALLOW)
    expect(await bash($, b, 'git push', 'watson')).toBeUndefined()
  })

  test('a sub-agent feature push with an unrecorded commit, or no remote-tracking ref, is refused', async ($, on) => {
    const { b, w } = await session($, on)
    await finalRun($, b)
    await spawnWatson($)
    expect(await bash($, b, 'git push', 'watson')).toBe(SUBAGENT_REFUSAL.deny)
    w.tracked = BASE
    b.repos['/repo'] = { ...b.repos['/repo'], head: BASE }
    commitOn(b, w, w.staged)
    expect(await bash($, b, 'git push', 'watson')).toBe(SUBAGENT_REFUSAL.deny)
  })

  test('after a green run, a sub-agent commit of another tree is refused', async ($, on) => {
    const { b, w } = await session($, on)
    await finalRun($, b)
    await spawnWatson($)
    w.staged = OTHER
    expect(await bash($, b, COMMIT, 'watson')).toBe(SUBAGENT_REFUSAL.deny)
  })

  test('a sub-agent cannot record green itself, so its commit stays refused', async ($, on) => {
    const { b, w } = await session($, on)
    await spawnWatson($)
    expect(await bash($, b, SUITE, 'watson')).toBeDefined()
    expect(w.indexEnvs).toEqual([])
    expect(await bash($, b, COMMIT, 'watson')).toBe(SUBAGENT_REFUSAL.deny)
  })

  test('a sub-agent in a -p run is refused its commit and its push as before', async ($, on) => {
    const { b } = await session($, on, { isInteractive: false })
    await spawnWatson($)
    expect(await bash($, b, COMMIT, 'watson')).toBe(SUBAGENT_REFUSAL.deny)
    expect(await bash($, b, 'git push', 'watson')).toBe(SUBAGENT_REFUSAL.deny)
  })

  for (const [name, options] of [
    ['a scheduled tick', { origin: { kind: 'scheduled-trigger' } }],
    ['the pipeline flag in an attended session', { env: { WORKBENCH_DEV_TEAM_PIPELINE: '1' } }],
  ] as const) {
    test(`after a green run in ${name}, a sub-agent is refused its commit and its push`, async ($, on) => {
      const { b, w } = await session($, on, options as Options)
      w.tracked = BASE
      b.repos['/repo'] = { ...b.repos['/repo'], head: BASE }
      await finalRun($, b)
      await spawnWatson($)
      expect(await asked($, COMMIT, 'watson')).not.toEqual(ALLOW)
      expect(await bash($, b, COMMIT, 'watson')).toBe(SUBAGENT_REFUSAL.deny)
      expect(await asked($, 'git push', 'watson')).not.toEqual(ALLOW)
      expect(await bash($, b, 'git push', 'watson')).toBe(SUBAGENT_REFUSAL.deny)
    })
  }

  test('a green tree recorded in a person\'s turn frees no sub-agent commit once a scheduled tick opens', async ($, on) => {
    const { b, w } = await session($, on)
    w.tracked = BASE
    b.repos['/repo'] = { ...b.repos['/repo'], head: BASE }
    await finalRun($, b)
    await spawnWatson($)
    expect(await asked($, COMMIT, 'watson')).toEqual(ALLOW)
    await $.prompt.submit({ text: 'tick', wait: false, origin: { kind: 'scheduled-trigger' } })
    expect(await asked($, COMMIT, 'watson')).not.toEqual(ALLOW)
    expect(await bash($, b, COMMIT, 'watson')).toBe(SUBAGENT_REFUSAL.deny)
  })

  test('a green commit recorded in a person\'s turn frees no sub-agent push once a scheduled tick opens', async ($, on) => {
    const { b, w } = await session($, on)
    onMain(b, w)
    await greenCommit($, b, w)
    await spawnWatson($)
    expect(await asked($, 'git push', 'watson')).toEqual(ALLOW)
    await $.prompt.submit({ text: 'tick', wait: false, origin: { kind: 'scheduled-trigger' } })
    expect(await asked($, 'git push', 'watson')).not.toEqual(ALLOW)
    expect(await bash($, b, 'git push', 'watson')).toBe(SUBAGENT_REFUSAL.deny)
  })

  for (const [name, options] of [
    ['a -p run', { isInteractive: false }],
    ['the pipeline', { env: { WORKBENCH_DEV_TEAM_PIPELINE: '1', CLAUDE_CODE_AGENT: 'watson' }, isInteractive: false, origin: { kind: 'sdk' } }],
    ['a scheduled tick', { origin: { kind: 'scheduled-trigger' } }],
  ] as const) {
    test(`${name} pushes main with an unrecorded commit as before`, async ($, on) => {
      const { b, w } = await session($, on, options as Options)
      onMain(b, w)
      commitOn(b, w, OTHER)
      expect(await bash($, b, 'git push')).toBeUndefined()
    })
  }

  test('a -p run commits and pushes as before, with no run', async ($, on) => {
    const { b } = await session($, on, { isInteractive: false })
    expect(await bash($, b, COMMIT)).toBeUndefined()
    expect(await bash($, b, 'git push')).toBeUndefined()
  })

  test('the pipeline commits and pushes as before', async ($, on) => {
    const { b } = await session($, on, { env: { WORKBENCH_DEV_TEAM_PIPELINE: '1', CLAUDE_CODE_AGENT: 'watson' }, isInteractive: false, origin: { kind: 'sdk' } })
    expect(await bash($, b, COMMIT)).toBeUndefined()
    expect(await bash($, b, 'git push')).toBeUndefined()
  })

  test('a scheduled tick commits and pushes as before', async ($, on) => {
    const { b } = await session($, on, { origin: { kind: 'scheduled-trigger' } })
    expect(await bash($, b, COMMIT)).toBeUndefined()
    expect(await bash($, b, 'git push')).toBeUndefined()
  })
})

describe('isWholeRun counts only a lone, unnarrowed whole-suite run whose exit status is the suite\'s', () => {
  const CHECK = 'set -u\nclaude plugin test "$ROOT"\nbash hooks/test-rule-source.sh\n'
  const read = async (path: string): Promise<Script | undefined> => (path === '/repo/scripts/check.sh' ? { kind: 'text', text: CHECK } : undefined)
  for (const [line, expected] of [
    [SUITE, true],
    [`${SUITE} 2>&1`, true],
    ['claude plugin test /repo', true],
    ['bash scripts/check.sh', true],
    ['bash /repo/scripts/check.sh', true],
    ['vendor/bin/pest', true],
    ['vendor/bin/pest --parallel', true],
    ['make test', true],
    ['WORKBENCH_CHECKS=plugin_json bash scripts/check.sh', false],
    ['HOME=/s CLAUDE_CONFIG_DIR=/s claude plugin test .', false],
    ['env WORKBENCH_CHECKS=x bash scripts/check.sh', false],
    ['bash scripts/check.sh plugin_json', false],
    ['claude plugin test /repo/sub', false],
    ['claude plugin test tests', false],
    ['claude plugin test . --verbose', false],
    ['claude plugin test /other', false],
    ['claude plugin test ../other', false],
    ['claude plugin test ~/other', false],
    ['vendor/bin/pest --group unit', false],
    ['vendor/bin/pest --testsuite=Unit', false],
    ['vendor/bin/pest --exclude-group slow', false],
    ['vendor/bin/pest --shard=1/4', false],
    ['vendor/bin/pest --filter Foo', false],
    ['vendor/bin/pest tests/Unit', false],
    ['vendor/bin/pest Unit', false],
    ['vendor/bin/pest tests/Unit/FooTest.php', false],
    ['npm --prefix /other test', false],
    ['make -C /other test', false],
    [`${SUITE} | tail -5`, false],
    [`${SUITE} || true`, false],
    [`${SUITE} && true`, false],
    [`${SUITE}; true`, false],
    [`${SUITE} &`, false],
    [`! ${SUITE}`, false],
    [`(${SUITE})`, false],
    [`bash <<'EOF'\n${SUITE}\nEOF`, false],
    ['bash < scripts/check.sh', false],
    ['claude plugin test $(pwd)', false],
    [`cd /repo && ${SUITE}`, false],
    ['git status', false],
  ] as const) {
    test(`${JSON.stringify(line)} is ${expected}`, async () => {
      expect(await isWholeRun(line, '/repo', HOME, [], read)).toBe(expected)
    })
  }
})

const PARTS = ['bash scripts/check-part-1.sh', 'bash scripts/check-part-2.sh', 'bash scripts/check-part-3.sh', 'bash scripts/check-part-4.sh']
const WHOLE = 'bash scripts/check.sh'
const PINNED = ['scripts/check.sh', 'scripts/omit-claude-md-check.py', 'tsconfig.json']
const DECLARATION = JSON.stringify({ parts: PARTS, whole: WHOLE, files: PINNED })

function declare(w: World, text = DECLARATION): void {
  w.committed.set(SUITE_PARTS_FILE, text)
  for (const file of [...PINNED, ...PARTS.map(part => part.replace(/^bash /, ''))]) w.committed.set(file, '#!/bin/bash\n')
}

async function spawnRunner($: Engine, id: string): Promise<void> {
  expect((await $.agent.spawn({ prompt: FINAL, subagentType: 'workbench-dev-team:holmes', description: id } as never)).agentId).toBe(id)
}

async function runParts($: Engine, b: Bench, lines: readonly string[], agentId = 'holmes', red?: string): Promise<void> {
  b.onBash = command => (command === red ? { isError: true } : undefined)
  for (const line of lines) expect([line, await bash($, b, line, agentId)]).toEqual([line, undefined])
  b.onBash = undefined
}

describe('green from declared parts: a long suite records green part by part', () => {
  test('every declared part passing on one tree in one final run records green, and not before the last part', async ($, on) => {
    const { b, w } = await session($, on)
    declare(w)
    await spawnRunner($, 'holmes')
    await runParts($, b, PARTS.slice(0, 3))
    expect(await asked($, COMMIT)).toBeUndefined()
    await runParts($, b, PARTS.slice(3))
    expect(await asked($, COMMIT)).toEqual(ALLOW)
    expect(await bash($, b, COMMIT)).toBeUndefined()
  })

  test('the parts may run in any order', async ($, on) => {
    const { b, w } = await session($, on)
    declare(w)
    await spawnRunner($, 'holmes')
    await runParts($, b, [...PARTS].reverse())
    expect(await bash($, b, COMMIT)).toBeUndefined()
  })

  test('one part missing records nothing', async ($, on) => {
    const { b, w } = await session($, on)
    declare(w)
    await spawnRunner($, 'holmes')
    await runParts($, b, [PARTS[0], PARTS[1], PARTS[3]] as string[])
    expect(await bash($, b, COMMIT)).toMatch(ASKS.commit)
  })

  test('one red part records nothing, even when every other part passes', async ($, on) => {
    const { b, w } = await session($, on)
    declare(w)
    await spawnRunner($, 'holmes')
    await runParts($, b, PARTS, 'holmes', PARTS[1])
    expect(await bash($, b, COMMIT)).toMatch(ASKS.commit)
  })

  test('a tree change between parts records nothing', async ($, on) => {
    const { b, w } = await session($, on)
    declare(w)
    await spawnRunner($, 'holmes')
    await runParts($, b, PARTS.slice(0, 2))
    w.work = OTHER
    w.staged = OTHER
    await runParts($, b, PARTS.slice(2))
    expect(await bash($, b, COMMIT)).toMatch(ASKS.commit)
  })

  test('a backgrounded part clears the parts that passed', async ($, on) => {
    const { b, w } = await session($, on)
    declare(w)
    await spawnRunner($, 'holmes')
    await runParts($, b, PARTS.slice(0, 3))
    expect(await bash($, b, PARTS[3] as string, 'holmes', { run_in_background: true })).toBeUndefined()
    await runParts($, b, PARTS.slice(3))
    expect(await bash($, b, COMMIT)).toMatch(ASKS.commit)
  })

  test('a new counted run that starts between parts clears the parts that passed', async ($, on) => {
    const { b, w } = await session($, on)
    declare(w)
    await spawnRunner($, 'holmes')
    await runParts($, b, PARTS.slice(0, 3))
    b.onBash = command => (command === WHOLE ? { isError: true } : undefined)
    expect(await bash($, b, WHOLE, 'holmes')).toBeUndefined()
    await runParts($, b, PARTS.slice(3))
    expect(await bash($, b, COMMIT)).toMatch(ASKS.commit)
  })

  test('parts spread across two final runs record nothing', async ($, on) => {
    const { b, w } = await session($, on)
    declare(w)
    await spawnRunner($, 'holmes')
    await runParts($, b, PARTS.slice(0, 2))
    await $.classic.SubagentStop({ stop_hook_active: false, last_assistant_message: 'Done.', agent_id: 'holmes', agent_type: 'workbench-dev-team:holmes' } as never)
    await spawnRunner($, 'holmes2')
    await runParts($, b, PARTS.slice(2), 'holmes2')
    expect(await bash($, b, COMMIT)).toMatch(ASKS.commit)
  })

  test('parts run by a sub-agent that is no final run, with the full-suite gate stood down, record nothing', async ($, on) => {
    const { b, w } = await session($, on, { env: { WORKBENCH_ORCHESTRATOR: '0' } })
    declare(w)
    await $.agent.spawn({ prompt: brief('Fix the bug.'), subagentType: 'workbench-dev-team:watson', description: 'watson' } as never)
    await runParts($, b, PARTS, 'watson')
    expect(w.indexEnvs).toEqual([])
    expect(await bash($, b, COMMIT)).toMatch(ASKS.commit)
  })

  test('with no declaration, the part lines record nothing and one whole-suite line still records green', async ($, on) => {
    const { b } = await session($, on)
    await spawnRunner($, 'holmes')
    await runParts($, b, PARTS)
    expect(await bash($, b, COMMIT)).toMatch(ASKS.commit)
    await runParts($, b, [SUITE])
    expect(await bash($, b, COMMIT)).toBeUndefined()
  })

  test('with a declaration, a whole-suite line that is not the declared one, such as claude plugin test ., records nothing', async ($, on) => {
    const { b, w } = await session($, on)
    declare(w)
    await spawnRunner($, 'holmes')
    await runParts($, b, [SUITE, 'vendor/bin/pest'])
    expect(await bash($, b, COMMIT)).toMatch(ASKS.commit)
  })

  test('with a declaration, the declared whole line records green on its own when every pinned file matches HEAD', async ($, on) => {
    const { b, w } = await session($, on)
    declare(w)
    await spawnRunner($, 'holmes')
    await runParts($, b, [WHOLE])
    expect(await bash($, b, COMMIT)).toBeUndefined()
  })

  for (const file of ['scripts/check.sh', SUITE_PARTS_FILE, 'tsconfig.json']) {
    test(`with a declaration, the declared whole line records nothing when ${file} differs from HEAD`, async ($, on) => {
      const { b, w } = await session($, on)
      declare(w)
      w.dirty.add(file)
      await spawnRunner($, 'holmes')
      await runParts($, b, [WHOLE, SUITE])
      expect(await bash($, b, COMMIT)).toMatch(ASKS.commit)
    })
  }

  test('a declaration with no whole line counts only its parts', async ($, on) => {
    const { b, w } = await session($, on)
    declare(w, JSON.stringify({ parts: PARTS, files: ['scripts/check.sh'] }))
    await spawnRunner($, 'holmes')
    await runParts($, b, [WHOLE, SUITE])
    expect(await bash($, b, COMMIT)).toMatch(ASKS.commit)
    await runParts($, b, PARTS)
    expect(await bash($, b, COMMIT)).toBeUndefined()
  })

  test('a declaration that cannot be read as plain parts declares nothing', async ($, on) => {
    const { b, w } = await session($, on)
    declare(w, JSON.stringify({ parts: [...PARTS.slice(0, 3), 'WORKBENCH_CHECKS=x bash scripts/check-part-4.sh'] }))
    await spawnRunner($, 'holmes')
    await runParts($, b, PARTS.slice(0, 3))
    await runParts($, b, [SUITE, WHOLE])
    expect(await bash($, b, COMMIT)).toMatch(ASKS.commit)
  })
})

describe('green from parts reads the declaration and the part scripts from HEAD', () => {
  for (const [cut, line] of [
    [{ parts: [PARTS[0]] }, PARTS[0]],
    [{ parts: ['true'] }, 'true'],
  ] as const) {
    test(`a working-copy declaration cut to ${JSON.stringify(cut)} records no green`, async ($, on) => {
      const { b, w } = await session($, on)
      declare(w)
      b.files.set(`/repo/${SUITE_PARTS_FILE}`, JSON.stringify(cut))
      w.dirty.add(SUITE_PARTS_FILE)
      await spawnRunner($, 'holmes')
      await runParts($, b, [line as string])
      expect(await bash($, b, COMMIT)).toMatch(ASKS.commit)
    })
  }

  test('a committed four-part declaration needs all four parts, so one part alone records no green', async ($, on) => {
    const { b, w } = await session($, on)
    declare(w)
    await spawnRunner($, 'holmes')
    await runParts($, b, [PARTS[0] as string, 'true'])
    expect(await bash($, b, COMMIT)).toMatch(ASKS.commit)
  })

  for (const file of [SUITE_PARTS_FILE, 'scripts/check-part-2.sh', 'scripts/check.sh']) {
    test(`a working-copy edit to ${file} records no green from the parts`, async ($, on) => {
      const { b, w } = await session($, on)
      declare(w)
      w.dirty.add(file)
      await spawnRunner($, 'holmes')
      await runParts($, b, PARTS)
      expect(await bash($, b, COMMIT)).toMatch(ASKS.commit)
    })
  }

  test('a declared file missing from HEAD declares nothing', async ($, on) => {
    const { b, w } = await session($, on)
    declare(w)
    w.committed.delete('scripts/check.sh')
    await spawnRunner($, 'holmes')
    await runParts($, b, PARTS)
    expect(await bash($, b, COMMIT)).toMatch(ASKS.commit)
  })

  test('a part whose result carries a background task id, then the same part in the foreground, still asks', async ($, on) => {
    const { b, w } = await session($, on)
    declare(w)
    await spawnRunner($, 'holmes')
    await runParts($, b, PARTS.slice(0, 3))
    b.replyBeneath = tool => (tool === 'Bash' ? ({ backgroundTaskId: 'bg1' } as never) : undefined)
    await runParts($, b, PARTS.slice(3))
    b.replyBeneath = undefined
    await runParts($, b, PARTS.slice(3))
    expect(await bash($, b, COMMIT)).toMatch(ASKS.commit)
  })

  test('/clear between parts 3 and 4 drops the parts record', async ($, on) => {
    const { b, w } = await session($, on)
    declare(w)
    await spawnRunner($, 'holmes')
    await runParts($, b, PARTS.slice(0, 3))
    await $.session.end({ reason: 'clear', sessionId: SID } as never)
    await $.prompt.submit({ text: 'look again', wait: false, origin: PERSON })
    await runParts($, b, PARTS.slice(3))
    expect(await bash($, b, COMMIT)).toMatch(ASKS.commit)
  })

  test('two final runs live at once on one tree do not add up', async ($, on) => {
    const { b, w } = await session($, on)
    declare(w)
    await spawnRunner($, 'holmes')
    await spawnRunner($, 'holmes2')
    await runParts($, b, PARTS.slice(0, 2), 'holmes')
    await runParts($, b, PARTS.slice(2, 3), 'holmes2')
    await runParts($, b, PARTS.slice(3), 'holmes')
    expect(await bash($, b, COMMIT)).toMatch(ASKS.commit)
  })

  test('parts another final run passes while one part runs do not join that part', async ($, on) => {
    const { b, w } = await session($, on)
    declare(w)
    await spawnRunner($, 'holmes')
    await spawnRunner($, 'holmes2')
    let isInside = false
    b.duringBash = async command => {
      if (command !== PARTS[3] || isInside) return
      isInside = true
      for (const line of PARTS.slice(0, 3)) expect([line, await bash($, b, line, 'holmes2')]).toEqual([line, undefined])
    }
    expect(await bash($, b, PARTS[3] as string, 'holmes')).toBeUndefined()
    b.duringBash = undefined
    expect(isInside).toBe(true)
    expect(await bash($, b, COMMIT)).toMatch(ASKS.commit)
  })
})

describe('suitePartsOf and partOf read the declaration and the part lines', () => {
  test('the declaration names itself, its files, its whole line\'s script and every part script to pin to HEAD', () => {
    expect(suitePartsOf(DECLARATION, '/repo')?.files.sort()).toEqual([SUITE_PARTS_FILE, ...PINNED, ...PARTS.map(part => part.replace(/^bash /, ''))].sort())
  })
  test('the declared whole line is read as its own line, apart from the parts', () => {
    const declared = suitePartsOf(DECLARATION, '/repo')
    expect(partOf(WHOLE, '/repo', declared?.whole === undefined ? [] : [declared.whole])).toBeDefined()
    expect(partOf(WHOLE, '/repo', declared?.parts ?? [])).toBeUndefined()
  })
  const keys = suitePartsOf(DECLARATION, '/repo')?.parts ?? []
  test('a declaration of plain part lines is read whole', () => {
    expect(keys.length).toBe(4)
  })
  for (const part of PARTS) {
    test(`${JSON.stringify(part)} is a declared part`, () => {
      expect(partOf(part, '/repo', keys)).toBeDefined()
    })
  }
  for (const line of [
    'bash scripts/check-part-1.sh plugin_json',
    'WORKBENCH_CHECKS=plugin_json bash scripts/check-part-1.sh',
    'env X=1 bash scripts/check-part-1.sh',
    'bash scripts/check-part-1.sh | tail -5',
    'bash scripts/check-part-1.sh && true',
    'bash scripts/check-part-5.sh',
    'bash scripts/check.sh',
  ]) {
    test(`${JSON.stringify(line)} is no declared part`, () => {
      expect(partOf(line, '/repo', keys)).toBeUndefined()
    })
  }
  for (const text of ['not json', '{}', '{"parts": []}', '{"parts": [1]}', JSON.stringify({ parts: ['bash scripts/check-part-1.sh x'] }), JSON.stringify({ parts: [PARTS[0], PARTS[0]] }), JSON.stringify({ parts: PARTS, files: ['../x.sh'] }), JSON.stringify({ parts: PARTS, files: 'scripts/check.sh' }), JSON.stringify({ parts: PARTS, whole: PARTS[0] }), JSON.stringify({ parts: PARTS, whole: 1 }), JSON.stringify({ parts: PARTS, whole: 'WORKBENCH_CHECKS=x bash scripts/check.sh' }), JSON.stringify({ parts: ['bash /other/x.sh'] })]) {
    test(`${JSON.stringify(text)} declares nothing`, () => {
      expect(suitePartsOf(text, '/repo')).toBeUndefined()
    })
  }
})

describe('push.followTags: a plain push runs free only when it would send no annotated tag', () => {
  test('AC1: with push.followTags on, a feature push that sends no tag runs with no question, in both forms', async ($, on) => {
    const { b, w } = await session($, on)
    w.config['push.followTags'] = 'true'
    w.dryRun = { exitCode: 0, stdout: porcelain(pushedLine('feat')) }
    expect(await asked($, 'git push')).toEqual(ALLOW)
    expect(await bash($, b, 'git push')).toBeUndefined()
    expect(await bash($, b, 'git push origin feat')).toBeUndefined()
    expect(w.dryRuns.length).toBeGreaterThan(0)
    expect(w.dryRuns.every(run => run.env?.GIT_TERMINAL_PROMPT === '0')).toBe(true)
  })

  test('AC2: a feature push that would send an annotated tag asks, in both forms, and the deny names the tag', async ($, on) => {
    const { b, w } = await session($, on)
    w.config['push.followTags'] = 'true'
    w.dryRun = { exitCode: 0, stdout: porcelain(pushedLine('feat'), tagLine('v1.2.0')) }
    expect(await asked($, 'git push')).toBeUndefined()
    for (const line of ['git push', 'git push origin feat']) {
      const deny = await bash($, b, line)
      expect(deny).toMatch(ASKS.push)
      expect(deny).toContain('With push.followTags on, this push also sends the annotated tag v1.2.0. Name that tag in the question.')
    }
  })

  test('AC2: a push that would send two annotated tags names each of them', async ($, on) => {
    const { b, w } = await session($, on)
    w.config['push.followTags'] = 'true'
    w.dryRun = { exitCode: 0, stdout: porcelain(pushedLine('feat'), tagLine('v1.2.0'), tagLine('v1.3.0')) }
    expect(await bash($, b, 'git push')).toContain('also sends the annotated tags v1.2.0, v1.3.0. Name each tag in the question.')
  })

  test('AC3: a dry run that fails keeps the push asking', async ($, on) => {
    const { b, w } = await session($, on)
    w.config['push.followTags'] = 'true'
    w.dryRun = { exitCode: 128, stdout: '' }
    expect(await asked($, 'git push')).toBeUndefined()
    expect(await bash($, b, 'git push')).toMatch(ASKS.push)
    expect(w.dryRuns.length).toBeGreaterThan(0)
  })

  test('AC3: a dry run that rejects or times out keeps the push asking, in both forms', async ($, on) => {
    const { b, w } = await session($, on)
    w.config['push.followTags'] = 'true'
    w.dryRun = 'reject'
    expect(await asked($, 'git push')).toBeUndefined()
    expect(await bash($, b, 'git push')).toMatch(ASKS.push)
    expect(await bash($, b, 'git push origin feat')).toMatch(ASKS.push)
    expect(w.dryRuns.length).toBeGreaterThan(0)
  })

  for (const [name, stdout] of [
    ['prints no ref line at all', ['To git@github.com:o/r.git', 'Done', ''].join('\n')],
    ['names only another branch', porcelain(pushedLine('other'))],
    ['prints its ref line with spaces for tabs', porcelain(pushedLine('feat').replace(/\t/g, ' '))],
  ] as const) {
    test(`AC3: a dry run that exits 0 but ${name} keeps the push asking`, async ($, on) => {
      const { b, w } = await session($, on)
      w.config['push.followTags'] = 'true'
      w.dryRun = { exitCode: 0, stdout }
      expect(await asked($, 'git push')).toBeUndefined()
      expect(await bash($, b, 'git push')).toMatch(ASKS.push)
      expect(w.dryRuns.length).toBeGreaterThan(0)
    })
  }

  test('AC3: a push.followTags the gate cannot read keeps the push asking, with no dry run', async ($, on) => {
    const { b, w } = await session($, on)
    w.unreadable.add('push.followTags')
    w.dryRun = { exitCode: 0, stdout: porcelain(pushedLine('feat')) }
    expect(await bash($, b, 'git push')).toMatch(ASKS.push)
    expect(w.dryRuns).toEqual([])
  })

  test('a push URL the session never saw asks before any dry run reaches it', async ($, on) => {
    const { b, w } = await session($, on)
    w.config['push.followTags'] = 'true'
    w.pushUrls = ['git@evil.example:o/r.git']
    expect(await bash($, b, 'git push')).toMatch(ASKS.push)
    expect(w.dryRuns).toEqual([])
  })

  test('AC4: after a free green commit on main, push.followTags on and no tag keeps both forms free', async ($, on) => {
    const { b, w } = await session($, on)
    onMain(b, w)
    await greenCommit($, b, w)
    w.config['push.followTags'] = 'true'
    w.dryRun = { exitCode: 0, stdout: porcelain(pushedLine('main', ' ')) }
    expect(await bash($, b, 'git push')).toBeUndefined()
    expect(await bash($, b, 'git push origin main')).toBeUndefined()
    expect(w.dryRuns.length).toBeGreaterThan(0)
  })

  test('AC4: a green push of main that would send an annotated tag asks and names it', async ($, on) => {
    const { b, w } = await session($, on)
    onMain(b, w)
    await greenCommit($, b, w)
    w.config['push.followTags'] = 'true'
    w.dryRun = { exitCode: 0, stdout: porcelain(pushedLine('main', ' '), tagLine('0.67.0')) }
    const deny = await bash($, b, 'git push')
    expect(deny).toMatch(ASKS.push)
    expect(deny).toContain('also sends the annotated tag 0.67.0.')
  })

  test('AC4: a green push of main whose dry run fails asks', async ($, on) => {
    const { b, w } = await session($, on)
    onMain(b, w)
    await greenCommit($, b, w)
    w.config['push.followTags'] = 'true'
    w.dryRun = { exitCode: 1, stdout: '' }
    expect(await bash($, b, 'git push')).toMatch(ASKS.push)
  })

  test('AC4: with no green commit on main, push.followTags on and no tag still asks', async ($, on) => {
    const { b, w } = await session($, on)
    onMain(b, w)
    commitOn(b, w, OTHER)
    w.config['push.followTags'] = 'true'
    w.dryRun = { exitCode: 0, stdout: porcelain(pushedLine('main', ' ')) }
    expect(await bash($, b, 'git push')).toMatch(ASKS.push)
    expect(w.dryRuns).toEqual([])
  })

  test('the porcelain reader counts each tag line that would be sent, once, and nothing else', () => {
    const text = [
      `To ${URL}`,
      pushedLine('feat'),
      tagLine('v1'),
      '=\trefs/tags/v0:refs/tags/v0\t[up to date]',
      '!\trefs/tags/v2:refs/tags/v2\t[rejected] (already exists)',
      'Done',
      `To git@github.com:o/mirror.git`,
      tagLine('v1'),
      'Done',
    ].join('\n')
    expect(followedTagsOf(text, 'feat')).toEqual(['v1', 'v2'])
    expect(followedTagsOf(porcelain(pushedLine('feat', ' ')), 'feat')).toEqual([])
    expect(followedTagsOf(porcelain(pushedLine('feat', '=')), 'feat')).toEqual([])
  })

  test('the porcelain reader recognises nothing without the pushed branch line', () => {
    expect(followedTagsOf('', 'feat')).toBeUndefined()
    expect(followedTagsOf(porcelain(tagLine('v1')), 'feat')).toBeUndefined()
    expect(followedTagsOf(porcelain(pushedLine('feature')), 'feat')).toBeUndefined()
    expect(followedTagsOf(porcelain(pushedLine('feat')), 'feature')).toBeUndefined()
  })
})
