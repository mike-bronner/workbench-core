import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptOrigin } from 'claude-code'

import { AGENT_RELEASE_REFUSAL, COMMIT_REFUSAL } from '../hooks/mods/commit-approval'
import { SUBAGENT_REFUSAL } from '../hooks/mods/commit-guard'
import { isDesktopSession } from '../hooks/mods/lane'
import type { SessionHost } from '../hooks/mods/lane'
import type { Bench } from './bench'
import { ASKS, HOME, PERSON, bench, caller, start } from './bench'

const DESKTOP = { HOME, CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }
const HOST: SessionHost = { entrypoint: 'claude-desktop', childSession: undefined, sessionKind: undefined, scheduledRun: undefined }
const COMMIT = 'git commit -m "fix: 🐛 X."'

const DEPENDENT = caller((on: On) => {
  on('prompt.submit', async ($, e, next) => {
    await $.fs.write('/answers/unattended', JSON.stringify(await $.workbench.isUnattended().catch(() => 'rejected')))
    return next(e)
  })
})

const prompt = (text: string, origin: PromptOrigin = PERSON) => ({ text, wait: false, origin })

async function bash($: Engine, b: Bench, command: string, agentId?: string): Promise<string | undefined> {
  const before = b.calls.filter(call => call.tool === 'Bash').length
  const result = await $.tool.call({ tool: 'Bash', command, ...(agentId ? { agentId } : {}) } as never)
  expect([command, b.calls.filter(call => call.tool === 'Bash').length > before]).toEqual([command, result.deny === undefined])
  return result.deny
}

async function sdkSession($: Engine, on: On, env: Record<string, string>, origin: PromptOrigin = PERSON, text = 'look this over'): Promise<Bench> {
  const b = bench(on, { env })
  b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'feat', originHead: 'main', originUrl: 'git@github.com:o/r.git' }
  b.trees['/repo'] = ''
  await $.session.start(start(false))
  await $.prompt.submit(prompt(text, origin))
  return b
}

const unattended = (b: Bench): unknown => JSON.parse(b.files.get('/answers/unattended') ?? 'null')

describe('isDesktopSession: the desktop host, as the engine reads an attended SDK session', () => {
  test('the Claude desktop app\'s own session is the desktop host', () => {
    expect(isDesktopSession(HOST)).toBe(true)
  })

  test('another entrypoint, or none, is not', () => {
    for (const entrypoint of [undefined, '', 'cli', 'sdk-cli', 'sdk-ts', 'sdk-py', 'claude-vscode', 'claude-desktop-3p', 'local-agent', 'Claude-Desktop']) {
      expect([entrypoint, isDesktopSession({ ...HOST, entrypoint })]).toEqual([entrypoint, false])
    }
  })

  test('a child session, a background session kind or a host scheduled run is not', () => {
    expect(isDesktopSession({ ...HOST, childSession: '1' })).toBe(false)
    for (const sessionKind of ['bg', 'daemon', 'daemon-worker']) expect(isDesktopSession({ ...HOST, sessionKind })).toBe(false)
    expect(isDesktopSession({ ...HOST, scheduledRun: '1' })).toBe(false)
  })
})

describe('AC1: a desktop prompt Mike typed is an attended session and an attended turn', () => {
  test('isUnattended answers false for his composer prompt', { plugins: [DEPENDENT] }, async ($, on) => {
    const b = await sdkSession($, on, DESKTOP)
    expect(unattended(b)).toBe(false)
  })

  test('a release line reaches the ask path, and a read-only release line runs', async ($, on) => {
    const b = await sdkSession($, on, DESKTOP)
    expect(await bash($, b, 'gh release create 1.0.0 --notes x')).toMatch(ASKS.release)
    expect(await bash($, b, 'gh release list')).toBeUndefined()
  })

  test('an unapproved commit is gated as in a terminal session', async ($, on) => {
    const b = await sdkSession($, on, DESKTOP)
    expect(await bash($, b, COMMIT)).toMatch(ASKS.commit)
  })
})

describe('AC2: every other lane keeps its verdict', () => {
  const LANES: readonly [string, Record<string, string>][] = [
    ['a claude -p run', { HOME, CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }],
    ['an SDK session with no entrypoint', { HOME }],
    ['the VS Code extension', { HOME, CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' }],
    ['a TypeScript SDK host', { HOME, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' }],
    ['a top-level --agent run from the desktop app', { ...DESKTOP, CLAUDE_CODE_AGENT: 'workbench-dev-team:watson' }],
    ['a pipeline run from the desktop app', { ...DESKTOP, WORKBENCH_DEV_TEAM_PIPELINE: '1' }],
    ['a claude -p run a desktop session started', { ...DESKTOP, CLAUDE_CODE_CHILD_SESSION: '1' }],
    ['a desktop scheduled run', { ...DESKTOP, CLAUDE_CODE_HOST_SCHEDULED_RUN: '1' }],
    ['a desktop background session', { ...DESKTOP, CLAUDE_CODE_SESSION_KIND: 'bg' }],
  ]
  for (const [name, env] of LANES) {
    test(`${name}: unattended, every release line refused, and a commit runs ungated`, { plugins: [DEPENDENT] }, async ($, on) => {
      const b = await sdkSession($, on, env)
      expect(unattended(b)).toBe(true)
      expect(await bash($, b, 'gh release create 1.0.0 --notes x')).toBe(AGENT_RELEASE_REFUSAL)
      expect(await bash($, b, 'gh release list')).toBe(AGENT_RELEASE_REFUSAL)
      expect(await bash($, b, COMMIT)).toBeUndefined()
    })
  }

  test('a sub-agent of a desktop session cannot release or commit', async ($, on) => {
    const b = await sdkSession($, on, DESKTOP)
    expect(await bash($, b, 'gh release list', 'a1')).toBe(AGENT_RELEASE_REFUSAL)
    expect(await bash($, b, COMMIT, 'a1')).toBe(SUBAGENT_REFUSAL.deny)
  })
})

describe('AC3: in a desktop session, a scheduled-task turn and a peer turn are unattended', () => {
  test('a scheduled turn, by origin or by wrapper, and a peer turn are unattended, and the next typed turn is not', { plugins: [DEPENDENT] }, async ($, on) => {
    const b = await sdkSession($, on, DESKTOP, { kind: 'scheduled-trigger' }, 'go')
    expect(unattended(b)).toBe(true)
    await $.prompt.submit(prompt('<scheduled-task name="nightly">go'))
    expect(unattended(b)).toBe(true)
    for (const origin of [{ kind: 'peer' }, { kind: 'peer-send-message' }] as const) {
      await $.prompt.submit(prompt('go', origin))
      expect([origin.kind, unattended(b)]).toEqual([origin.kind, true])
    }
    await $.prompt.submit(prompt('go'))
    expect(unattended(b)).toBe(false)
  })

  test('a peer turn that asks for a commit cannot commit', async ($, on) => {
    const b = await sdkSession($, on, DESKTOP, { kind: 'peer' }, 'commit it')
    expect(await bash($, b, COMMIT)).toBe(COMMIT_REFUSAL)
  })

  const TURNS: readonly [string, PromptOrigin, string, string | RegExp | undefined][] = [
    ['a typed', PERSON, 'take a look', ASKS.commit],
    ['a peer', { kind: 'peer' }, 'take a look', COMMIT_REFUSAL],
    ['a scheduled-trigger', { kind: 'scheduled-trigger' }, 'take a look', undefined],
    ['a <scheduled-task> wrapped', PERSON, '<scheduled-task name="nightly">take a look', undefined],
  ]
  for (const [lane, env, isInteractive] of [['terminal', { HOME }, true], ['desktop', DESKTOP, false]] as const) {
    for (const [name, origin, text, commit] of TURNS) {
      test(`${lane}: ${name} turn gets one set of verdicts on either host`, async ($, on) => {
        const b = bench(on, { env })
        b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'feat', originHead: 'main', originUrl: 'git@github.com:o/r.git' }
        b.trees['/repo'] = ''
        await $.session.start(start(isInteractive))
        await $.prompt.submit(prompt(text, origin))
        const committed = await bash($, b, COMMIT)
        if (commit instanceof RegExp) expect(committed).toMatch(commit)
        else expect(committed).toBe(commit)
        expect(await bash($, b, 'gh release create 1.0.0 --notes x')).toMatch(ASKS.release)
        expect(await bash($, b, 'gh release list')).toBeUndefined()
      })
    }
  }
})
