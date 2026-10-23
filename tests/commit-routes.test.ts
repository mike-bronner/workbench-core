import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { PromptOrigin } from 'claude-code'

import {
  AGENT_MERGE_REFUSAL,
  AGENT_RELEASE_REFUSAL,
  API_WRITE_REFUSAL,
  RELEASE_REFUSAL,
  REWRITE_REFUSAL,
  apiWritesOf,
  askRefusalOf,
  isDefaultBranch,
  isDefaultRef,
  mergesOf,
  rewritesAt,
  shownOf,
} from '../hooks/mods/commit-approval'
import { SUBAGENT_REFUSAL } from '../hooks/mods/commit-guard'
import type { Bench } from './bench'
import { ASKS, HOME, PERSON, bench, start } from './bench'

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

type Lane = 'mike' | 'sub-agent' | 'pipeline' | '-p' | 'scheduled' | 'peer'

async function lane($: Engine, on: Parameters<typeof bench>[0], name: Lane): Promise<Bench> {
  const env = name === 'pipeline' ? { env: { HOME, WORKBENCH_DEV_TEAM_PIPELINE: '1', CLAUDE_CODE_AGENT: 'watson' } } : {}
  const b = bench(on, env)
  b.repos['/repo'] = { ...FEATURE }
  b.trees['/repo'] = ''
  await $.session.start(start(name !== 'pipeline' && name !== '-p'))
  const origin: PromptOrigin = name === 'scheduled' ? { kind: 'scheduled-trigger' } : name === 'peer' ? { kind: 'peer' } : name === 'pipeline' || name === '-p' ? { kind: 'sdk' } : PERSON
  await $.prompt.submit(prompt('look this over', origin))
  return b
}

const asksInMikesTurn = async ($: Engine, on: Parameters<typeof bench>[0], line: string, words: string) => {
  const b = await lane($, on, 'mike')
  b.pick = 'Yes, run it'
  const deny = await bash($, b, line)
  expect([line, deny]).toEqual([line, expect.stringContaining('Ask him through AskUserQuestion, with this question alone in its call.')])
  expect([line, /the action \(([^)]*)\)/.exec(deny ?? '')?.[1]?.includes(words)]).toEqual([line, true])
  expect(dialogs(b)).toEqual([])
}

const API_FORMS = [
  'gh api -X PUT repos/o/r/contents/f -F branch=@b.txt -f message=x',
  'gh api -X PUT repos/o/r/contents/f -F branch={branch} -f message=x',
  'gh api -X PUT repos/o/r/contents/f -f branch=feat% -f message=x',
  'gh api -X PUT repos/o/r/contents/f -f branch=feat/ -f message=x',
  'gh api -X PATCH repos/o/r/git/refs/heads/{branch} -f sha=abc',
  'gh api repos/o/r/contents/f -X PUT -f message=x -f content=eQ==',
  'gh api repos/o/r/contents/f --method DELETE -f message=x -f sha=abc',
  'gh api repos/o/r/git/refs -F ref=@ref.txt -F sha=abc',
  "gh api graphql -f query='mutation { createCommitOnBranch(input: {}) { clientMutationId } }'",
  "gh api graphql -f query='mutation { updateRef(input: {}) { clientMutationId } }'",
  "gh api graphql -f query='mutation { updateRefs(input: {}) { clientMutationId } }'",
  "gh api graphql -f query='mutation { createRef(input: {}) { clientMutationId } }'",
  "gh api graphql -f query='mutation { deleteRef(input: {}) { clientMutationId } }'",
  'gh api -X PUT repositories/123/contents/f -f message=x',
  'gh api -X PATCH repositories/123/git/refs/heads/main -f sha=abc',
  'gh repo sync --branch main',
  'gh repo sync',
  'gh repo sync --branch=MAIN',
  'gh api -X POST repos/o/r/merge-upstream -f branch=main',
  'gh api -X POST repos/o/r/merge-upstream',
  'gh api -X POST repos/o/r/branches/main/rename -f new_name=trunk',
  'gh api -X POST repos/o/r/branches/feat/rename -f new_name=main',
  'gh api -X PUT repos/o/r/contents/f -f branch=MAIN -f message=x',
]

describe('findings 1 and 2, and the API follow-ups: every API route to the default branch is gated', () => {
  test('the reader counts each one as a write to an unread or default branch', () => {
    for (const line of API_FORMS) {
      const writes = apiWritesOf(line)
      expect([line, writes.length > 0 && writes.some(write => write.branch === null || isDefaultRef(write.branch, 'refs/remotes/origin/main'))]).toEqual([line, true])
    }
    for (const line of [
      'gh api -X PUT repos/o/r/contents/f -f branch=feat -f message=x',
      'gh repo sync --branch feat',
      'gh api -X POST repos/o/r/merge-upstream -f branch=feat',
      'gh api -X POST repos/o/r/branches/feat/rename -f new_name=feat2',
      "gh api graphql -f query='query { viewer { login } }'",
      'gh repo view',
    ]) {
      const writes = apiWritesOf(line)
      expect([line, writes.some(write => write.branch === null || isDefaultRef(write.branch, 'refs/remotes/origin/main'))]).toEqual([line, false])
    }
  })

  for (const line of API_FORMS) {
    test(`asks in Mike's turn: ${JSON.stringify(line)}`, async ($, on) => {
      await asksInMikesTurn($, on, line, 'GitHub API write to the default branch')
    })
    test(`refused for a sub-agent: ${JSON.stringify(line)}`, async ($, on) => {
      const b = await lane($, on, 'sub-agent')
      const deny = await bash($, b, line, 'a1')
      expect([line, deny === API_WRITE_REFUSAL || deny === AGENT_RELEASE_REFUSAL]).toEqual([line, true])
    })
  }

  for (const name of ['-p', 'pipeline', 'scheduled', 'peer'] as const) {
    test(`refused, and no dialog opens, in ${name}`, async ($, on) => {
      const b = await lane($, on, name)
      b.pick = 'Yes, run it'
      expect(await bash($, b, 'gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc')).toBe(API_WRITE_REFUSAL)
      expect(await bash($, b, 'gh repo sync --branch main')).toBeDefined()
      expect(dialogs(b)).toEqual([])
    })
  }

  test('with no origin/HEAD, a write that names a feature branch still asks, as the default cannot be read', async ($, on) => {
    const b = await lane($, on, 'mike')
    b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'feat' }
    expect(await bash($, b, 'gh api -X PUT repos/o/r/contents/f -f branch=feat -f message=x')).toMatch(ASKS.api)
  })
})

describe('finding 3 and the rebase follow-up: a rebase that names its branch, or moves other refs', () => {
  test('the reader', () => {
    for (const line of ['git rebase --root main', 'git rebase -i --root main', 'git rebase --update-refs main', 'git rebase --update-refs']) {
      expect([line, rewritesAt(line)]).toEqual([line, [{ dir: null }]])
    }
    expect(rewritesAt('git rebase main')).toEqual([{ dir: '' }])
    expect(rewritesAt('git rebase --root')).toEqual([{ dir: '' }])
  })

  for (const line of ['git rebase --root main', 'git rebase -i --root main', 'git rebase --update-refs main']) {
    test(`asks in Mike's turn and is refused in the pipeline and for a sub-agent: ${line}`, async ($, on) => {
      await asksInMikesTurn($, on, line, 'history rewrite')
    })
    test(`the pipeline refuses it from a feature branch: ${line}`, async ($, on) => {
      const b = await lane($, on, 'pipeline')
      expect(await bash($, b, line)).toBe(REWRITE_REFUSAL)
    })
    test(`a sub-agent is refused: ${line}`, async ($, on) => {
      const b = await lane($, on, 'sub-agent')
      expect(await bash($, b, line, 'a1')).toBe(REWRITE_REFUSAL)
    })
  }
})

describe('the ref-moving follow-ups', () => {
  test('the readers', () => {
    expect(mergesOf('git pull origin x:main').local).toEqual([null])
    expect(mergesOf('git bisect reset main && git merge x').local).toEqual([null])
    expect(mergesOf('git bisect log && git merge x').local).toEqual([''])
    expect(rewritesAt('git push . x:main')).toEqual([{ dir: '', refs: ['main'] }])
    expect(rewritesAt('git fetch origin +x:main')).toEqual([{ dir: '', refs: ['main'] }])
    expect(rewritesAt('git switch x && git branch -f feat2 x')).toEqual([{ dir: null, refs: ['feat2', 'x'] }])
    expect(rewritesAt('git branch -f main x')).toEqual([{ dir: '', refs: ['main', 'x'] }])
    expect(apiWritesOf('gh api -X PUT repos/o/r/contents/f --input body.json')).toEqual([{ branch: null, repo: 'o/r' }])
    expect(rewritesAt('git push origin x:main')).toEqual([])
    expect(isDefaultRef('refs/heads/MAIN', 'refs/remotes/origin/main')).toBe(true)
    expect(isDefaultBranch('refs/heads/Main', 'refs/remotes/origin/main')).toBe(true)
  })

  const ROUTES: readonly [string, string, string][] = [
    ['git pull origin x:main', 'merge into the default branch', AGENT_MERGE_REFUSAL],
    ['git bisect reset main && git merge x', 'merge into the default branch', AGENT_MERGE_REFUSAL],
    ['git branch -f main x', 'history rewrite', REWRITE_REFUSAL],
    ['git fetch origin x:main', 'history rewrite', REWRITE_REFUSAL],
  ]
  for (const [line, words, refusal] of ROUTES) {
    test(`asks in Mike's turn: ${line}`, async ($, on) => {
      await asksInMikesTurn($, on, line, words)
    })
    test(`refused for a sub-agent: ${line}`, async ($, on) => {
      const b = await lane($, on, 'sub-agent')
      expect(await bash($, b, line, 'a1')).toBe(refusal)
    })
  }

  test('git push . x:main asks in Mike\'s turn, is a sub-agent\'s push, and the pipeline refuses it', async ($, on) => {
    await asksInMikesTurn($, on, 'git push . x:main', 'history rewrite')
  })

  for (const [line, refusal] of [
    ['git push . x:main', REWRITE_REFUSAL],
    ['git branch -f main x', REWRITE_REFUSAL],
    ['git update-ref refs/heads/MAIN abc1234', REWRITE_REFUSAL],
    ['git fetch origin +x:main', REWRITE_REFUSAL],
    ['git pull origin x:main', AGENT_MERGE_REFUSAL],
  ] as const) {
    test(`the pipeline refuses it from a feature branch: ${line}`, async ($, on) => {
      const b = await lane($, on, 'pipeline')
      expect(await bash($, b, line)).toBe(refusal)
    })
  }

  test('a sub-agent\'s push to its own repository is refused as a push', async ($, on) => {
    const b = await lane($, on, 'sub-agent')
    expect(await bash($, b, 'git push . x:main', 'a1')).toBe(SUBAGENT_REFUSAL.deny)
  })

  test('the pipeline still moves its own feature refs', async ($, on) => {
    const b = await lane($, on, 'pipeline')
    expect(await bash($, b, 'git branch -f feat2 feat')).toBeUndefined()
    expect(await bash($, b, 'git fetch origin x:feat2')).toBeUndefined()
  })
})

describe('finding 4: the dialog escapes every invisible character, by category', () => {
  const HIDDEN = [
    '⁠', '⁡', '⁢', '⁣', '⁤', '­', '᠎', '͏', 'ᅟ', 'ᅠ', 'ㅤ', 'ﾠ',
    ' ', ' ', '​', '‍', '‮', '⁦', '﻿', '\u0000', '\u007f', '\u0085', '\u{e0001}', '\u{e007f}', '\u{e0041}',
  ]
  test('each one is shown as an escape', () => {
    for (const char of HIDDEN) {
      const shown = shownOf(`a${char}b`)
      expect([char.codePointAt(0), shown.includes(char), shown.startsWith('a\\u')]).toEqual([char.codePointAt(0), false, true])
    }
    expect(shownOf('a\u{e0041}b')).toBe('a\\u{e0041}b')
  })

  test('hostile repository, branch, message and file values reach the deny escaped', () => {
    const text = askRefusalOf(['commit'], {
      command: 'git commit -m x',
      repo: '/repo‮/x',
      branch: 'refs/heads/feat⁦\r',
      message: '"x\u{e0001}"',
      files: ['aㅤ.ts', 'b­.ts'],
    })
    for (const char of ['‮', '⁦', '\r', '\u{e0001}', 'ㅤ', '­']) expect([char.codePointAt(0), text.includes(char)]).toEqual([char.codePointAt(0), false])
    expect(text).toContain('/repo\\u202e/x')
    expect(text).toContain('feat\\u2066\\r')
  })
})

describe('the release ruling: a release asks where AskUserQuestion can reach Mike', () => {
  for (const name of ['scheduled', 'peer'] as const) {
    test(`${name}: a plain release is denied with the instruction to ask, runs on a "Run it" pick, and a "Not now" pick runs nothing`, async ($, on) => {
      const b = await lane($, on, name)
      const line = 'gh release create 1.0.0 --notes x'
      const question = (label: string) => {
        b.pick = label
        return $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: `Run \`${line}\`?`, header: 'Release', options: [{ label: 'Run it', description: 'Run it' }, { label: 'Not now', description: 'Not now' }], multiSelect: false }] } as never)
      }
      expect(await bash($, b, line)).toMatch(ASKS.release)
      expect((await question('Not now')).deny).toBeUndefined()
      expect(await bash($, b, line)).toMatch(ASKS.release)
      expect((await question('Run it')).deny).toBeUndefined()
      expect(await bash($, b, 'gh release create 1.0.1 --notes x')).toMatch(ASKS.release)
      expect(await bash($, b, line)).toBeUndefined()
    })
  }

  test('sub-agent: no question can reach Mike from it, so a release is refused', async ($, on) => {
    const b = await lane($, on, 'sub-agent')
    b.pick = 'Run it'
    expect(await bash($, b, 'gh release create 1.0.0 --notes x', 'a1')).toBe(AGENT_RELEASE_REFUSAL)
    expect(dialogs(b)).toEqual([])
  })

  for (const name of ['-p', 'pipeline'] as const) {
    test(`${name}: nobody can be asked, so a release is refused`, async ($, on) => {
      const b = await lane($, on, name)
      b.pick = 'Run it'
      expect(await bash($, b, 'gh release create 1.0.0 --notes x')).toBe(AGENT_RELEASE_REFUSAL)
      expect(dialogs(b)).toEqual([])
    })
  }

  test('a typed release request in Mike\'s turn still approves with no dialog', async ($, on) => {
    const b = await lane($, on, 'mike')
    await $.prompt.submit(prompt('cut a release'))
    expect(await bash($, b, 'gh release create 1.0.0 --notes x')).toBeUndefined()
    expect(dialogs(b)).toEqual([])
  })

  test('a scheduled turn before session start reads as unattended, and is refused', async ($, on) => {
    const b = bench(on)
    expect(await bash($, b, 'gh release create 1.0.0 --notes x')).toBe(RELEASE_REFUSAL)
  })
})

describe('finding 5: GIT_CONFIG_* lines are refused outright in every lane, Mike\'s included', () => {
  for (const name of ['mike', 'sub-agent', 'pipeline'] as const) {
    test(`${name}: refused by the destructive-scope guard, and no dialog opens`, async ($, on) => {
      const b = await lane($, on, name)
      b.pick = 'Yes, run it'
      const deny = await bash($, b, 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.c GIT_CONFIG_VALUE_0=commit git c -m x', name === 'sub-agent' ? 'a1' : undefined)
      expect(deny).toContain('Destructive-scope guard (workbench-core)')
      expect(deny).toContain('GIT_')
      expect(dialogs(b)).toEqual([])
    })
  }
})
