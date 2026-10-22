import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { PromptOrigin } from 'claude-code'

import {
  AGENT_RELEASE_REFUSAL,
  API_WRITE_REFUSAL,
  APPROVE_LABEL,
  ASK_TIMEOUT_MS,
  ASK_TIMEOUT_NOTICE,
  DECLINE_LABEL,
  REWRITE_REFUSAL,
  apiWritesOf,
  askerOf,
  declinedRefusal,
  isOtherRepo,
  mergesOf,
  originRepoOf,
  rewritesAt,
  shownOf,
} from '../hooks/mods/commit-approval'
import { MERGE_REFUSAL, isUnreadGraphql } from '../hooks/mods/commit-guard'
import { parseShell } from '../hooks/mods/shell'
import type { Bench } from './bench'
import { HOME, PERSON, bench, start } from './bench'

const prompt = (text: string, origin: PromptOrigin = PERSON) => ({ text, wait: false, origin })

async function bash($: Engine, b: Bench, command: string, agentId?: string): Promise<string | undefined> {
  const before = b.calls.filter(call => call.tool === 'Bash').length
  const result = await $.tool.call({ tool: 'Bash', command, ...(agentId ? { agentId } : {}) } as never)
  expect([command, b.calls.filter(call => call.tool === 'Bash').length > before]).toEqual([command, result.deny === undefined])
  return result.deny
}

const dialogs = (b: Bench): string[] =>
  b.inputs.filter(input => input.tool === 'AskUserQuestion').map(input => ((input.questions as { question: string }[])[0]?.question ?? ''))

const FEATURE = { head: 'c1', pushed: 'c1', branch: 'feat', originHead: 'main', originUrl: 'git@github.com:o/r.git' }

type Lane = 'mike' | 'sub-agent' | 'pipeline' | 'scheduled' | 'peer' | 'channel' | 'plugin' | 'sdk'

const ORIGINS: Readonly<Record<Lane, PromptOrigin>> = {
  mike: PERSON,
  'sub-agent': PERSON,
  pipeline: { kind: 'sdk' },
  scheduled: { kind: 'scheduled-trigger' },
  peer: { kind: 'peer' },
  channel: { kind: 'channel', server: 'slack' },
  plugin: { kind: 'plugin', name: 'x' },
  sdk: { kind: 'sdk' },
}

async function lane($: Engine, on: Parameters<typeof bench>[0], name: Lane): Promise<Bench> {
  const b = bench(on, name === 'pipeline' ? { env: { HOME, WORKBENCH_DEV_TEAM_PIPELINE: '1', CLAUDE_CODE_AGENT: 'watson' } } : {})
  b.repos['/repo'] = { ...FEATURE }
  b.trees['/repo'] = ''
  await $.session.start(start(name !== 'pipeline'))
  await $.prompt.submit(prompt('look this over', ORIGINS[name]))
  return b
}

async function asks($: Engine, on: Parameters<typeof bench>[0], line: string): Promise<void> {
  const b = await lane($, on, 'mike')
  b.pick = DECLINE_LABEL
  expect([line, await bash($, b, line)]).toEqual([line, expect.stringContaining('Mike answered no in the approval dialog')])
  expect(dialogs(b).length).toBe(1)
}

async function refusedForAgents($: Engine, on: Parameters<typeof bench>[0], line: string): Promise<void> {
  const b = await lane($, on, 'sub-agent')
  b.pick = APPROVE_LABEL
  expect([line, await bash($, b, line, 'a1')]).toEqual([line, expect.any(String)])
  expect(dialogs(b)).toEqual([])
}

describe('finding 1: a fragment, %, // or a dot step in an endpoint is unread', () => {
  const LINES = [
    'gh api repos/o/r/git/refs/heads/main#x -X PATCH -f sha=abc',
    'gh api -X PATCH repos/o/r/git/refs/heads/feat#main -f sha=abc',
    'gh api -X PUT repos/o/r/%63ontents/f -f message=x',
    'gh api -X PATCH repos/o/r/git%2Frefs/heads/main -f sha=abc',
    'gh api -X PUT repos/o/r//contents/f -f message=x -f branch=feat',
    'gh api -X PUT repos/o/r/contents/f -f branch=main#x -f message=x',
  ]
  test('a built endpoint to a branch-writing route is unread, and the guard refuses it as a plain-line merge first', async ($, on) => {
    const line = 'gh api -X PUT "repos/o/$R/contents/f" -f branch=feat -f message=x'
    expect(apiWritesOf(line)).toEqual([{ branch: null, repo: null }])
    const b = await lane($, on, 'mike')
    expect(await bash($, b, line)).toBeDefined()
    expect(dialogs(b)).toEqual([])
  })
  test('the reader', () => {
    for (const line of LINES) expect([line, apiWritesOf(line).every(write => write.branch === null)]).toEqual([line, true])
  })
  for (const line of LINES) {
    test(`asks in Mike's turn: ${JSON.stringify(line)}`, async ($, on) => asks($, on, line))
    test(`refused for a sub-agent: ${JSON.stringify(line)}`, async ($, on) => refusedForAgents($, on, line))
  }
  test('the pipeline refuses one', async ($, on) => {
    const b = await lane($, on, 'pipeline')
    expect(await bash($, b, 'gh api repos/o/r/git/refs/heads/main#x -X PATCH -f sha=abc')).toBe(API_WRITE_REFUSAL)
  })
})

describe('finding 2: a GraphQL field the shell expands is unread, in every lane', () => {
  const LINES = [
    'gh api graphql -f query="$(cat q.graphql)"',
    'gh api graphql --raw-field=query="$(cat q.graphql)"',
    'gh api graphql -f query="$Q"',
    'gh api graphql -f query="`cat q`"',
    "gh api graphql -f query='query{viewer{login}}' -F owner=\"$O\"",
  ]
  test('the readers', () => {
    for (const line of LINES) {
      const st = parseShell(line).statements.find(each => each.name === 'gh')!
      expect([line, isUnreadGraphql(st, st.args), apiWritesOf(line)]).toEqual([line, true, [{ branch: null }]])
    }
    for (const line of ["gh api graphql -f query='query($o:String!){x}' -f o=x", "gh api graphql -f query='query { viewer { login } }'"]) {
      const st = parseShell(line).statements.find(each => each.name === 'gh')!
      expect([line, isUnreadGraphql(st, st.args), apiWritesOf(line)]).toEqual([line, false, []])
    }
  })
  for (const line of LINES) {
    test(`asks in Mike's turn: ${JSON.stringify(line)}`, async ($, on) => asks($, on, line))
    test(`refused for a sub-agent and the pipeline: ${JSON.stringify(line)}`, async ($, on) => {
      await refusedForAgents($, on, line)
    })
  }
  test('the pipeline refuses one as a merge', async ($, on) => {
    const b = await lane($, on, 'pipeline')
    expect([MERGE_REFUSAL.deny, AGENT_RELEASE_REFUSAL]).toContain(await bash($, b, 'gh api graphql -f query="$(cat q.graphql)"'))
  })
})

describe('a write to another repository counts as a write to its default branch', () => {
  test('the readers', () => {
    expect(originRepoOf('git@github.com:o/r.git')).toBe('o/r')
    expect(originRepoOf('https://github.com/O/R')).toBe('o/r')
    expect(originRepoOf(undefined)).toBeUndefined()
    expect(isOtherRepo('o/r', 'o/r')).toBe(false)
    expect(isOtherRepo(null, undefined)).toBe(true)
    expect(isOtherRepo('other/x', 'o/r')).toBe(true)
    expect(isOtherRepo(null, 'o/r')).toBe(true)
    expect(isOtherRepo('o/r', undefined)).toBe(true)
    expect(isOtherRepo(undefined, 'o/r')).toBe(false)
  })
  for (const line of [
    'gh api -X PUT repos/other/x/contents/f -f branch=feat -f message=x',
    'gh api -X PUT repositories/123/contents/f -f branch=feat -f message=x',
    'gh repo sync -R other/x --branch feat',
    'gh repo sync other/x --branch feat',
  ]) {
    test(`asks in Mike's turn: ${JSON.stringify(line)}`, async ($, on) => asks($, on, line))
    test(`refused for a sub-agent: ${JSON.stringify(line)}`, async ($, on) => refusedForAgents($, on, line))
  }
  test('a feature-branch write to this repository, by name or by {owner}/{repo}, runs with no dialog', async ($, on) => {
    const b = await lane($, on, 'mike')
    expect(await bash($, b, 'gh api -X PUT repos/o/r/contents/f -f branch=feat -f message=x')).toBeUndefined()
    expect(await bash($, b, 'gh api -X PUT repos/{owner}/{repo}/contents/f -f branch=feat -f message=x')).toBeUndefined()
    expect(dialogs(b)).toEqual([])
  })
})

describe('git option abbreviations read as their full option', () => {
  test('the reader', () => {
    expect(rewritesAt('git branch --fo main x')).toEqual([{ dir: '', refs: ['main', 'x'] }])
    expect(rewritesAt('git branch --mo feat main')).toEqual([{ dir: '', refs: ['feat', 'main'] }])
    expect(rewritesAt('git rebase --update-r main')).toEqual([{ dir: null }])
    expect(rewritesAt('git rebase --ro main')).toEqual([{ dir: null }])
    expect(rewritesAt('git push -o x . y:main')).toEqual([{ dir: '', refs: ['main'] }])
    expect(rewritesAt('git push --push-o x . y:main')).toEqual([{ dir: '', refs: ['main'] }])
  })
  for (const line of ['git branch --fo main x', 'git rebase --update-r main', 'git push -o x . y:main']) {
    test(`the pipeline refuses it from a feature branch: ${line}`, async ($, on) => {
      const b = await lane($, on, 'pipeline')
      expect(await bash($, b, line)).toBe(REWRITE_REFUSAL)
    })
    test(`asks in Mike's turn: ${line}`, async ($, on) => asks($, on, line))
  }
})

describe('the escape covers variation selectors and every space but U+0020', () => {
  test('each one', () => {
    for (const char of ['\ufe0f', '\ufe00', '\u{e0100}', '\u{e01ef}', '\u180b', '\u00a0', '\u2003', '\u3000', '\u2009', '\u202f']) {
      expect([char.codePointAt(0), shownOf(`a${char}b`).includes(char)]).toEqual([char.codePointAt(0), false])
    }
    expect(shownOf('a b')).toBe('a b')
  })
})

describe('an unanswered dialog counts as no within the stated bound', () => {
  test('the bound is ten minutes', () => {
    expect(ASK_TIMEOUT_MS).toBe(600_000)
  })

  test('a scheduled tick whose dialog nobody answers is refused when the bound passes, and nothing runs', async ($, on) => {
    const b = await lane($, on, 'scheduled')
    b.hangDialog = true
    const pending = $.tool.call({ tool: 'Bash', command: 'gh release create 1.0.0 --notes x' } as never)
    await b.clock.advance(ASK_TIMEOUT_MS - 1)
    await b.clock.advance(1)
    expect(((await pending) as { deny?: string }).deny).toBe(declinedRefusal(['release']))
    expect(b.calls.some(call => call.tool === 'Bash')).toBe(false)
  })

  test('in Mike\'s turn too', async ($, on) => {
    const b = await lane($, on, 'mike')
    b.hangDialog = true
    const pending = $.tool.call({ tool: 'Bash', command: 'git rebase main' } as never)
    await b.clock.advance(ASK_TIMEOUT_MS)
    expect(((await pending) as { deny?: string }).deny).toBe(declinedRefusal(['rewrite']))
  })
})

describe('every dialog names who asked', () => {
  test('the reader', () => {
    expect(askerOf(undefined, 'composer', false)).toBe('your own turn')
    expect(askerOf(undefined, 'bridge', false)).toBe('your own turn, through Remote Control')
    expect(askerOf('a1', 'composer', false)).toBe('a sub-agent')
    expect(askerOf(undefined, 'composer', true)).toBe('a scheduled task')
    expect(askerOf(undefined, 'scheduled-trigger', false)).toBe('a scheduled task')
    expect(askerOf(undefined, 'peer', false)).toBe('a peer session')
    expect(askerOf(undefined, 'channel', false)).toBe('a channel')
    expect(askerOf(undefined, 'plugin', false)).toBe('a plugin')
    expect(askerOf(undefined, 'sdk', false)).toBe('the SDK')
    expect(askerOf(undefined, 'unheard-of', false)).toBe('a turn the gate cannot name')
  })

  for (const [name, asker, agentId] of [
    ['mike', 'your own turn', undefined],
    ['sub-agent', 'a sub-agent', 'a1'],
    ['scheduled', 'a scheduled task', undefined],
    ['peer', 'a peer session', undefined],
    ['channel', 'a channel', undefined],
    ['plugin', 'a plugin', undefined],
    ['sdk', 'the SDK', undefined],
  ] as const) {
    test(`${name}: the release dialog says it was asked by ${asker}`, async ($, on) => {
      const b = await lane($, on, name)
      b.pick = APPROVE_LABEL
      expect(await bash($, b, 'gh release create 1.0.0 --notes x', agentId)).toBeUndefined()
      expect(dialogs(b)[0]?.startsWith(`Asked by ${asker}.`)).toBe(true)
    })
  }

  test('the pipeline cannot open one, so its release is refused with the dialog route named', async ($, on) => {
    const b = await lane($, on, 'pipeline')
    expect(await bash($, b, 'gh release create 1.0.0 --notes x')).toBe(AGENT_RELEASE_REFUSAL)
    expect(AGENT_RELEASE_REFUSAL).toContain('asks him in the approval dialog')
  })
})

describe('round six: repos/{owner}/{repo} and a bare gh repo sync name the current repository', () => {
  const PUT = 'gh api -X PUT repos/{owner}/{repo}/contents/f -f message=x'
  const FEATURE_LINES = [
    `${PUT} -f branch=feat`,
    'gh repo sync --branch feat',
    'gh repo sync --branch=feat --force',
    `GH_REPO=x/y ${PUT} -f branch=feat`,
    'GH_REPO=x/y gh repo sync --branch feat',
    `gh repo set-default x/y && ${PUT} -f branch=feat`,
  ]
  const DEFAULT_LINES = [
    PUT,
    `${PUT} -f branch=$B`,
    `${PUT} -f branch=main`,
    'gh repo sync',
    'gh repo sync --branch "$B"',
    'gh repo sync --branch MAIN',
    `GH_REPO=x/y ${PUT} -f branch=main`,
    'GH_REPO=x/y gh repo sync',
    `gh repo set-default x/y && ${PUT}`,
  ]
  const OTHER_LINES = [
    'gh api -X PUT repos/x/y/contents/f -f branch=feat -f message=x',
    'gh api -X PUT repos/{owner}/y/contents/f -f branch=feat -f message=x',
    'gh repo sync x/y --branch feat',
    'gh repo sync -R x/y --branch feat',
    'gh repo sync --repo=x/y --branch feat',
    'gh repo sync --source o/r x/y --branch feat',
  ]
  test('the reader', () => {
    for (const line of [...FEATURE_LINES, ...DEFAULT_LINES]) expect([line, apiWritesOf(line).map(write => write.repo)]).toEqual([line, [undefined]])
    for (const line of OTHER_LINES) expect([line, apiWritesOf(line).map(write => write.repo)]).toEqual([line, [line.includes('repos/x/y') ? 'x/y' : null]])
    expect(apiWritesOf('gh repo sync --source o/r --branch feat').map(write => write.repo)).toEqual([undefined])
  })
  for (const line of FEATURE_LINES) {
    test(`runs in Mike's turn with no dialog: ${JSON.stringify(line)}`, async ($, on) => {
      const b = await lane($, on, 'mike')
      expect(await bash($, b, line)).toBeUndefined()
      expect(dialogs(b)).toEqual([])
    })
    test(`the pipeline runs it: ${JSON.stringify(line)}`, async ($, on) => {
      const b = await lane($, on, 'pipeline')
      expect(await bash($, b, line)).toBeUndefined()
    })
  }
  for (const line of [...DEFAULT_LINES, ...OTHER_LINES]) {
    test(`asks in Mike's turn: ${JSON.stringify(line)}`, async ($, on) => asks($, on, line))
    test(`refused for a sub-agent: ${JSON.stringify(line)}`, async ($, on) => refusedForAgents($, on, line))
    test(`refused in the pipeline: ${JSON.stringify(line)}`, async ($, on) => {
      const b = await lane($, on, 'pipeline')
      expect(await bash($, b, line)).toBe(API_WRITE_REFUSAL)
    })
  }
  test('an inherited GH_REPO leaves a feature write running and a default write asking', async ($, on) => {
    const b = bench(on, { env: { HOME, GH_REPO: 'x/y' } })
    b.repos['/repo'] = { ...FEATURE }
    await $.session.start(start())
    await $.prompt.submit(prompt('look this over'))
    expect(await bash($, b, `${PUT} -f branch=feat`)).toBeUndefined()
    expect(await bash($, b, 'gh repo sync --branch feat')).toBeUndefined()
    expect(dialogs(b)).toEqual([])
    b.pick = DECLINE_LABEL
    expect(await bash($, b, `${PUT} -f branch=main`)).toBe(declinedRefusal(['api']))
    expect(dialogs(b).length).toBe(1)
  })
})

describe('round six: a GraphQL body piped to -F query=@- is unread', () => {
  const LINE = 'echo "$Q" | gh api graphql -F query=@-'
  test('the readers', () => {
    const st = parseShell(LINE).statements.find(each => each.name === 'gh')!
    expect(isUnreadGraphql(st, st.args)).toBe(true)
    expect(mergesOf(LINE).pr).toBe(1)
  })
  test('in Mike\'s turn the outbound prose guard refuses the piped body before any dialog', async ($, on) => {
    const b = await lane($, on, 'mike')
    b.pick = APPROVE_LABEL
    expect(await bash($, b, LINE)).toEqual(expect.stringContaining('Outbound prose guard'))
    expect(dialogs(b)).toEqual([])
  })
  test('refused for a sub-agent', async ($, on) => refusedForAgents($, on, LINE))
})

describe('round six: the dialog timer, a late yes and the asker of each origin', () => {
  test('an answer before the bound leaves no timer pending', async ($, on) => {
    const b = await lane($, on, 'mike')
    b.pick = APPROVE_LABEL
    expect(await bash($, b, 'git rebase main')).toBeUndefined()
    await b.clock.advance(ASK_TIMEOUT_MS * 2)
    expect(b.toasts).not.toContain(ASK_TIMEOUT_NOTICE)
  })

  test('a yes that comes after the bound runs nothing', async ($, on) => {
    const b = await lane($, on, 'mike')
    b.pick = APPROVE_LABEL
    b.answerAfterMs = ASK_TIMEOUT_MS + 1
    const pending = $.tool.call({ tool: 'Bash', command: 'git rebase main' } as never)
    await b.clock.advance(ASK_TIMEOUT_MS + 1)
    expect(((await pending) as { deny?: string }).deny).toBe(declinedRefusal(['rewrite']))
    expect(b.toasts).toContain(ASK_TIMEOUT_NOTICE)
    expect(b.calls.some(call => call.tool === 'Bash')).toBe(false)
  })

  test('a Remote Control turn is your own turn, through Remote Control', async ($, on) => {
    const b = bench(on)
    b.repos['/repo'] = { ...FEATURE }
    await $.session.start(start())
    await $.prompt.submit(prompt('look this over', { kind: 'bridge' }))
    b.pick = APPROVE_LABEL
    expect(await bash($, b, 'git rebase main')).toBeUndefined()
    expect(dialogs(b)[0]?.startsWith('Asked by your own turn, through Remote Control.')).toBe(true)
  })

  test('a turn Mike opens after a scheduled tick is his own', async ($, on) => {
    const b = await lane($, on, 'scheduled')
    await $.prompt.submit(prompt('back at the desk'))
    b.pick = APPROVE_LABEL
    expect(await bash($, b, 'git rebase main')).toBeUndefined()
    expect(dialogs(b)[0]?.startsWith('Asked by your own turn.')).toBe(true)
  })

  test('a peer message folded into Mike\'s running turn names the peer, not Mike', async ($, on) => {
    const b = await lane($, on, 'mike')
    await $.prompt.submit({ ...prompt('please rebase', { kind: 'peer' }), turnId: 'running' })
    b.pick = APPROVE_LABEL
    expect(await bash($, b, 'git rebase main')).toBeUndefined()
    expect(dialogs(b)[0]?.startsWith('Asked by a peer session.')).toBe(true)
  })
})

describe('round six: origins, abbreviations and the braille blank', () => {
  test('an https origin with .git is this repository, and a host other than github.com is not', () => {
    expect(originRepoOf('https://github.com/o/r.git')).toBe('o/r')
    expect(originRepoOf('git@gitlab.com:o/r.git')).toBeUndefined()
    expect(originRepoOf('https://gitlab.example.com/o/r')).toBeUndefined()
  })

  test('with an https origin, a feature write to that repository runs', async ($, on) => {
    const b = await lane($, on, 'mike')
    b.repos['/repo'] = { ...FEATURE, originUrl: 'https://github.com/o/r.git' }
    expect(await bash($, b, 'gh api -X PUT repos/o/r/contents/f -f branch=feat -f message=x')).toBeUndefined()
    expect(dialogs(b)).toEqual([])
  })

  test('with a non-GitHub origin, the same write asks', async ($, on) => {
    const b = await lane($, on, 'mike')
    b.repos['/repo'] = { ...FEATURE, originUrl: 'git@gitlab.com:o/r.git' }
    b.pick = DECLINE_LABEL
    expect(await bash($, b, 'gh api -X PUT repos/o/r/contents/f -f branch=feat -f message=x')).toBe(declinedRefusal(['api']))
  })

  for (const line of ['git branch --co feat main', 'git push --repo=. x:main']) {
    test(`asks in Mike's turn: ${line}`, async ($, on) => asks($, on, line))
    test(`the pipeline refuses it: ${line}`, async ($, on) => {
      const b = await lane($, on, 'pipeline')
      expect(await bash($, b, line)).toBe(REWRITE_REFUSAL)
    })
  }

  test('U+2800 is escaped', () => {
    expect(shownOf('a⠀b')).toBe('a\\u2800b')
  })
})
