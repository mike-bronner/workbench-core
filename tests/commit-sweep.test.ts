import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { PromptOrigin } from 'claude-code'

import {
  AGENT_CONFIG_MERGE_REFUSAL,
  AGENT_MERGE_REFUSAL,
  AGENT_RELEASE_REFUSAL,
  API_WRITE_REFUSAL,
  MOVE_REFUSAL,
  ONE_REFUSAL,
  REWRITE_REFUSAL,
  apiWritesOf,
  askRefusalOf,
  configuredMergesOf,
  leftOutRefusal,
  mergesOf,
  movesHead,
  rewritesAt,
  rewritesOf,
  shownOf,
} from '../hooks/mods/commit-approval'
import { FORCE_REFUSAL } from '../hooks/mods/commit-guard'
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

async function mike($: Engine, on: Parameters<typeof bench>[0], text = 'look this over'): Promise<Bench> {
  const b = bench(on)
  b.repos['/repo'] = { ...FEATURE }
  b.trees['/repo'] = ''
  await $.session.start(start())
  await $.prompt.submit(prompt(text))
  return b
}

async function subAgent($: Engine, on: Parameters<typeof bench>[0]): Promise<Bench> {
  const b = bench(on)
  b.repos['/repo'] = { ...FEATURE }
  b.pick = 'Yes, run it'
  await $.session.start(start())
  await $.prompt.submit(prompt('delegate it'))
  return b
}

async function pipeline($: Engine, on: Parameters<typeof bench>[0]): Promise<Bench> {
  const b = bench(on, { env: { HOME, WORKBENCH_DEV_TEAM_PIPELINE: '1', CLAUDE_CODE_AGENT: 'watson' } })
  b.repos['/repo'] = { ...FEATURE }
  await $.session.start(start(false))
  await $.prompt.submit(prompt('Item ID: 12', { kind: 'sdk' }))
  return b
}

const HEAD_WRITERS = [
  'git switch -C main',
  'git symbolic-ref HEAD refs/heads/main',
  'git branch -M main',
  'git branch -m feat main',
  'git branch -f main HEAD',
  'git branch -C feat main',
  'git rebase origin/main main',
  'git fetch . feat:main',
]

describe('finding 2: every verb that writes HEAD or a branch ref makes the branch unknown', () => {
  test('the readers', () => {
    for (const verb of [...HEAD_WRITERS, 'git checkout -B main', 'git replace abc1234 def5678', 'git checkout main', 'git update-ref HEAD abc1234', 'git filter-branch -f HEAD']) {
      expect([verb, movesHead(verb)]).toEqual([verb, true])
    }
    for (const verb of [...HEAD_WRITERS, 'git checkout -B main', 'git replace abc1234 def5678']) {
      expect([verb, mergesOf(`${verb} && git merge x`).local]).toEqual([verb, [null]])
    }
    for (const line of ['git symbolic-ref HEAD', 'git symbolic-ref -q --short HEAD', 'git branch -v', 'git branch --list', 'git fetch origin', 'git replace -l', 'git rebase main']) {
      expect([line, movesHead(line), mergesOf(`${line} && git merge x`).local]).toEqual([line, false, ['']])
    }
  })

  for (const verb of HEAD_WRITERS) {
    test(`in Mike's turn, a merge after it is denied with the instruction to ask: ${verb}`, async ($, on) => {
      const b = await mike($, on)
      const deny = await bash($, b, `${verb} && git merge x`)
      expect(deny).toContain('merge into the default branch')
      expect(deny).toContain('through AskUserQuestion')
      expect(dialogs(b)).toEqual([])
    })

    test(`for a sub-agent, a merge after it is refused: ${verb}`, async ($, on) => {
      const b = await subAgent($, on)
      expect(await bash($, b, `${verb} && git merge x`, 'a1')).toBeDefined()
    })
  }

  for (const verb of ['git symbolic-ref HEAD refs/heads/main', 'git branch -M main', 'git update-ref HEAD abc1234', 'git fetch . feat:main']) {
    test(`under a commit pick, a commit after it is refused as a head move: ${verb}`, async ($, on) => {
      const b = await mike($, on)
      b.pick = 'Commit it'
      expect((await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'Commit "fix: 🐛 X." on feat?', header: 'Q', options: [{ label: 'Commit it', description: 'x' }, { label: 'Not yet', description: 'y' }], multiSelect: false }] } as never)).deny).toBeUndefined()
      expect(await bash($, b, `${verb} && git commit -m "fix: 🐛 X."`)).toBe(MOVE_REFUSAL)
    })
  }
})

describe('findings 1 and 3: update-ref, rebase with a branch, and a bare reset', () => {
  test('update-ref reads its ref past -m and its other options', () => {
    expect(rewritesAt('git update-ref -m msg refs/heads/main abc1234')).toEqual([{ dir: '', refs: ['refs/heads/main'] }])
    expect(rewritesAt('git update-ref --create-reflog -m x refs/heads/main abc1234')).toEqual([{ dir: '', refs: ['refs/heads/main'] }])
    expect(rewritesAt('git update-ref --stdin')).toEqual([{ dir: '', refs: [''] }])
  })

  for (const line of ['git update-ref -m msg refs/heads/main abc1234', 'git update-ref --create-reflog -m x refs/heads/main abc1234', 'git rebase feat/x main', 'git rebase --onto A B main', 'git update-ref --stdin']) {
    test(`the pipeline refuses it from a feature branch: ${line}`, async ($, on) => {
      const b = await pipeline($, on)
      expect(await bash($, b, line)).toBe(REWRITE_REFUSAL)
    })
  }

  test('the pipeline still updates its own feature ref with a message', async ($, on) => {
    const b = await pipeline($, on)
    expect(await bash($, b, 'git update-ref -m msg refs/heads/feat abc1234')).toBeUndefined()
  })

  test('a bare reset to a branch or a commit moves the branch, and a reset of paths does not', () => {
    for (const line of ['git reset main', 'git reset -q feat', 'git reset abc12', 'git reset a.ts', 'git commit --amend -m x', 'git commit --amend --no-edit']) {
      expect([line, rewritesOf(line)]).toEqual([line, 1])
    }
    for (const line of ['git reset', 'git reset -q', 'git reset HEAD', 'git reset -- a.ts', 'git reset HEAD -- a.ts', 'git commit -m x']) {
      expect([line, rewritesOf(line)]).toEqual([line, 0])
    }
  })

  test('in Mike\'s turn, an amend is denied as a rewrite even under his typed commit request', async ($, on) => {
    const b = await mike($, on, 'commit it')
    expect(await bash($, b, 'git commit --amend -m "fix: 🐛 X."')).toMatch(ASKS.rewrite)
  })
})

const CONFIGURED = [
  'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.c GIT_CONFIG_VALUE_0=commit git c -m x',
  'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.m GIT_CONFIG_VALUE_0=merge git m feat',
  'GIT_CONFIG_PARAMETERS="\'alias.c=commit\'" git c -m x',
  'export GIT_CONFIG_GLOBAL=/tmp/x.cfg; git c -m x',
]

describe('finding 4: an alias set through GIT_CONFIG_* is read as unknown', () => {
  test('the gate reads each git statement under GIT_CONFIG_* as an unknown alias: a merge, a rewrite and a head move', () => {
    for (const line of CONFIGURED) {
      expect([line, rewritesOf(line), movesHead(line)]).toEqual([line, 1, true])
      expect([line, mergesOf(line).local]).toEqual([line, [null]])
    }
  })

  for (const line of CONFIGURED) {
    test(`it never runs, in Mike's turn, for a sub-agent or in the pipeline: ${JSON.stringify(line)}`, async ($, on) => {
      const b = await mike($, on)
      b.pick = 'Yes, run it'
      expect(await bash($, b, line)).toBeDefined()
      expect(await bash($, b, line, 'a1')).toBeDefined()
    })

    test(`the pipeline refuses it: ${JSON.stringify(line)}`, async ($, on) => {
      const b = await pipeline($, on)
      expect(await bash($, b, line)).toBeDefined()
    })
  }
})

const REMOVES_CONFIG = [
  'env GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git config --show-origin --list',
  'env GIT_CONFIG_SYSTEM=/dev/null git config --show-origin --list',
  'env GIT_CONFIG_NOSYSTEM=1 git config --show-origin --list',
  'GIT_CONFIG_GLOBAL=/dev/null git config --list',
]

const ADDS_CONFIG = [
  'GIT_CONFIG_GLOBAL=/tmp/x.cfg git config --list',
  'env GIT_CONFIG_SYSTEM=/etc/gitconfig git config --list',
  'GIT_CONFIG_SYSTEM=/dev/nullx git config --list',
  'GIT_CONFIG_GLOBAL="/dev/null" git config --list',
  'GIT_CONFIG_NOSYSTEM=1;GIT_CONFIG_GLOBAL=/tmp/x.cfg git config --list',
  'GIT_CONFIG_NOSYSTEM=$(cat f) git config --list',
  'GIT_CONFIG_COUNT=1 git config --list',
  'GIT_CONFIG_KEY_0=alias.m git config --list',
  'GIT_CONFIG_VALUE_0=merge git config --list',
  'GIT_CONFIG_PARAMETERS="\'alias.m=merge\'" git config --list',
  'GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.m GIT_CONFIG_VALUE_0=merge git config --list',
  'export GIT_CONFIG_GLOBAL=/tmp/x.cfg; git config --list',
]

const CONFIG_PULL = 'GIT_CONFIG_GLOBAL=/tmp/x.cfg git pull'
const ALIAS_MERGE = 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.m GIT_CONFIG_VALUE_0=merge git m feat'

describe('a GIT_CONFIG_* variable that only removes configuration is not read as an alias', () => {
  test('the reader: NOSYSTEM, and GLOBAL or SYSTEM set to /dev/null, leave the git statement as it is', () => {
    for (const line of REMOVES_CONFIG) {
      expect([line, mergesOf(line), configuredMergesOf(line), rewritesOf(line), movesHead(line)]).toEqual([line, { local: [], pr: 0, targets: [] }, [], 0, false])
    }
    expect(mergesOf('env GIT_CONFIG_GLOBAL=/dev/null git merge feat')).toEqual({ local: [''], pr: 0, targets: [{ refs: ['feat'] }] })
  })

  test('the reader: a variable that can add configuration is still read as an unknown alias', () => {
    for (const line of ADDS_CONFIG) {
      expect([line, mergesOf(line).local, configuredMergesOf(line), rewritesOf(line), movesHead(line)]).toEqual([line, [null], [null], 1, true])
    }
  })

  for (const line of REMOVES_CONFIG) {
    test(`a sub-agent runs it: ${JSON.stringify(line)}`, async ($, on) => {
      const b = await subAgent($, on)
      expect(await bash($, b, line, 'a1')).toBeUndefined()
    })
  }

  for (const line of ADDS_CONFIG) {
    test(`a sub-agent is refused it, and the refusal names the configuration: ${JSON.stringify(line)}`, async ($, on) => {
      const b = await subAgent($, on)
      expect(await bash($, b, line, 'a1')).toBe(AGENT_CONFIG_MERGE_REFUSAL)
    })
  }

  test('a sub-agent\'s merge on the default branch keeps the default-branch refusal', async ($, on) => {
    const b = await subAgent($, on)
    b.repos['/repo'] = { ...FEATURE, branch: 'main' }
    expect(await bash($, b, 'git merge fix/x', 'a1')).toBe(AGENT_MERGE_REFUSAL)
    expect(await bash($, b, 'env GIT_CONFIG_GLOBAL=/dev/null git merge fix/x', 'a1')).toBe(AGENT_MERGE_REFUSAL)
    expect(await bash($, b, 'GIT_CONFIG_GLOBAL=/tmp/x.cfg git config --list', 'a1')).toBe(AGENT_CONFIG_MERGE_REFUSAL)
  })

  test('the reader: a pull, an alias merge and an escaped variable name under added configuration are configured merges', () => {
    for (const line of [CONFIG_PULL, ALIAS_MERGE, 'env GIT_CONFIG_\\COUNT=1 git m', 'env GIT_CONFIG_\\COUNT=1 git config --list']) {
      expect([line, mergesOf(line).local, configuredMergesOf(line)]).toEqual([line, [null], [null]])
    }
  })

  for (const branch of ['feat', 'main']) {
    test(`on ${branch}, a sub-agent's pull under added configuration gets the configuration refusal`, async ($, on) => {
      const b = await subAgent($, on)
      b.repos['/repo'] = { ...FEATURE, branch }
      expect(await bash($, b, CONFIG_PULL, 'a1')).toBe(AGENT_CONFIG_MERGE_REFUSAL)
    })

    test(`on ${branch}, a sub-agent's alias merge under GIT_CONFIG_COUNT is refused first by the destructive-scope guard`, async ($, on) => {
      const b = await subAgent($, on)
      b.repos['/repo'] = { ...FEATURE, branch }
      expect(await bash($, b, ALIAS_MERGE, 'a1')).toContain('Destructive-scope guard (workbench-core)')
    })
  }

  test('a line with added configuration beside a plain merge on main gets the configuration refusal', async ($, on) => {
    const b = await subAgent($, on)
    b.repos['/repo'] = { ...FEATURE, branch: 'main' }
    expect(await bash($, b, 'GIT_CONFIG_GLOBAL=/tmp/x.cfg git config --list; git merge fix/x', 'a1')).toBe(AGENT_CONFIG_MERGE_REFUSAL)
  })

  test('an escaped GIT_CONFIG_* name is still read as added configuration', async ($, on) => {
    const b = await subAgent($, on)
    expect(await bash($, b, 'env GIT_CONFIG_\\COUNT=1 git config --list', 'a1')).toBe(AGENT_CONFIG_MERGE_REFUSAL)
    expect(await bash($, b, 'env GIT_CONFIG_\\COUNT=1 git m', 'a1')).toBeDefined()
  })

  test('the pipeline gets the configuration refusal', async ($, on) => {
    const b = await pipeline($, on)
    expect(await bash($, b, CONFIG_PULL)).toBe(AGENT_CONFIG_MERGE_REFUSAL)
  })

  test('a scheduled turn gets the configuration refusal', async ($, on) => {
    const b = bench(on)
    b.repos['/repo'] = { ...FEATURE }
    await $.session.start(start())
    await $.prompt.submit(prompt('run the tick', { kind: 'scheduled-trigger' }))
    expect(await bash($, b, 'GIT_CONFIG_COUNT=1 git config --list')).toBe(AGENT_CONFIG_MERGE_REFUSAL)
  })
})

const DEFAULT_WRITES = [
  'gh api -X PUT repos/o/r/contents/a.md -f message=x -f content=eQ==',
  'gh api -X PUT repos/o/r/contents/a.md -f message=x -f content=eQ== -f branch=main',
  'gh api -X PUT repos/o/r/contents/a.md -f branch=feat -f branch=main -f message=x',
  'gh api --method DELETE repos/o/r/contents/a.md -f message=x -f sha=abc',
  'gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc',
  'gh api repos/o/r/git/refs -f ref=refs/heads/main -f sha=abc',
  'gh api -X DELETE repos/o/r/git/refs/heads/main',
  'gh api -X PATCH "repos/o/r/git/refs/heads/$B" -f sha=abc',
]

describe('ruling B: a gh api write to the default branch, or to a branch the gate cannot read, is gated', () => {
  test('the reader', () => {
    for (const line of DEFAULT_WRITES) expect([line, apiWritesOf(line).length]).toEqual([line, 1])
    expect(apiWritesOf('gh api -X PUT repos/o/r/contents/a.md -f branch=feat -f message=x')).toEqual([{ branch: 'feat', repo: 'o/r' }])
    expect(apiWritesOf('gh api -X PUT repos/o/r/contents/a.md -f branch=feat -f branch=main')).toEqual([{ branch: 'main', repo: 'o/r' }])
    expect(apiWritesOf('gh api repos/o/r/git/refs -f ref=refs/heads/feat -f sha=abc')).toEqual([{ branch: 'feat', repo: 'o/r' }])
    for (const line of ['gh api repos/o/r/contents/a.md', 'gh api -X GET repos/o/r/git/refs/heads/main', 'gh api repos/o/r/git/refs -f ref=refs/tags/v1 -f sha=abc', 'gh api -X POST repos/o/r/issues -f title=x']) {
      expect([line, apiWritesOf(line)]).toEqual([line, []])
    }
  })

  for (const line of DEFAULT_WRITES) {
    test(`in Mike's turn it is denied with the instruction to ask, and runs on his pick: ${JSON.stringify(line)}`, async ($, on) => {
      const b = await mike($, on)
      expect(await bash($, b, line)).toMatch(ASKS.api)
      expect(dialogs(b)).toEqual([])
      b.pick = 'Run it'
      const question = { question: `Run \`${line}\` in /repo?`, header: 'API', options: [{ label: 'Run it', description: 'x' }, { label: 'Not now', description: 'y' }], multiSelect: false }
      expect((await $.tool.call({ tool: 'AskUserQuestion', questions: [question] } as never)).deny).toBeUndefined()
      expect(await bash($, b, line)).toBeUndefined()
    })

    test(`for a sub-agent and the pipeline it is refused: ${JSON.stringify(line)}`, async ($, on) => {
      const b = await pipeline($, on)
      expect(await bash($, b, line)).toBe(line.includes('$B') ? AGENT_RELEASE_REFUSAL : API_WRITE_REFUSAL)
    })
  }

  test('a write to a feature branch runs with no dialog in Mike\'s turn, for a sub-agent and in the pipeline', async ($, on) => {
    const b = await mike($, on)
    for (const line of ['gh api -X PUT repos/o/r/contents/a.md -f branch=feat -f message=x -f content=eQ==', 'gh api -X PATCH repos/o/r/git/refs/heads/feat -f sha=abc']) {
      expect(await bash($, b, line)).toBeUndefined()
      expect(await bash($, b, line, 'a1')).toBeUndefined()
    }
    expect(dialogs(b)).toEqual([])
  })

  test('a sub-agent\'s write to the default branch is refused', async ($, on) => {
    const b = await subAgent($, on)
    expect(await bash($, b, 'gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc', 'a1')).toBe(API_WRITE_REFUSAL)
  })
})

describe('finding 7: the deny shows the line that runs, with every hidden character escaped', () => {
  test('control characters, backticks and bidi marks', () => {
    expect(shownOf('a\nb')).toBe('a\\nb')
    expect(shownOf('a\rb')).toBe('a\\rb')
    expect(shownOf('a\u001bb')).toBe('a\\u001bb')
    expect(shownOf('a‮b')).toBe('a\\u202eb')
    expect(shownOf('a`b\\c')).toBe('a\\`b\\\\c')
    const text = askRefusalOf(['commit'], { command: 'git commit -m "x‮"\rgit push', repo: '/repo', branch: 'refs/heads/main', message: '"x\u001b"', files: ['a\nb.ts'] })
    expect(text).toContain('`git commit -m "x\\u202e"\\rgit push`')
    expect(text).toContain('Name the message, "x\\u001b",')
    expect(text).toContain('a\\nb.ts')
    expect(/[\r\n\u001b‮]/.test(text)).toBe(false)
  })
})

describe('a commit and its push on one line', () => {
  test('with no approval the line is denied, naming both, with the instruction to run each on a line of its own', async ($, on) => {
    const b = await mike($, on)
    b.pick = 'Yes, run it'
    const deny = await bash($, b, 'git commit -m "fix: 🐛 X." && git push')
    expect(deny).toContain('it runs a git commit and git push, and Mike has approved none of them')
    expect(deny).toContain('run each as a line of its own')
    expect(dialogs(b)).toEqual([])
  })
})

const permission = ($: Engine, command: string, agentId?: string) =>
  $.classic
    .PermissionRequest({
      hook_event_name: 'PermissionRequest',
      session_id: 's',
      transcript_path: '/t.jsonl',
      cwd: '/repo',
      tool_name: 'Bash',
      tool_input: { command },
      ...(agentId ? { agent_id: agentId, agent_type: 'watson' } : {}),
    } as never)
    .then(result => (result as { decision?: unknown }).decision)

const runIt = ($: Engine, b: Bench, line: string) => {
  b.pick = 'Run it'
  const question = { question: `Run \`${line}\` in /repo, on feat?`, header: 'Approve', options: [{ label: 'Run it', description: 'x' }, { label: 'Not now', description: 'y' }], multiSelect: false }
  return $.tool.call({ tool: 'AskUserQuestion', questions: [question] } as never)
}

describe('finding 6: the permission prompt is answered only for the line Mike picked, while it runs', () => {
  for (const [kind, line, other] of [
    ['release', 'gh release create 1.0.0 --notes x', 'gh release create 1.0.1 --notes x'],
    ['rewrite', 'git rebase main', 'git rebase other'],
  ] as const) {
    test(`${kind}: the exact line is allowed while it runs, and a different line, an agent's and one after the call are not`, async ($, on) => {
      const b = await mike($, on)
      const seen: unknown[] = []
      b.duringBash = async command => {
        if (command !== line) return
        seen.push(await permission($, line, 'a1'))
        seen.push(await permission($, other))
        seen.push(await permission($, line))
      }
      expect(await permission($, line)).toBeUndefined()
      expect(await bash($, b, line)).toMatch(ASKS[kind])
      expect(await permission($, line)).toBeUndefined()
      expect((await runIt($, b, line)).deny).toBeUndefined()
      expect(await bash($, b, line)).toBeUndefined()
      expect(seen).toEqual([undefined, undefined, { behavior: 'allow' }])
      expect(await permission($, line)).toBeUndefined()
    })
  }
})

describe('ruling D: the refusals no answer can fix open no dialog in Mike\'s turn', () => {
  test('a tree that leaves a file out, two commits on a line, a force push', async ($, on) => {
    const b = await mike($, on)
    b.pick = 'Yes, run it'
    b.trees['/repo'] = '?? stray.txt\0'
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBe(leftOutRefusal(['stray.txt']))
    b.trees['/repo'] = ''
    expect(await bash($, b, 'git commit -m "fix: 🐛 A."; git commit -m "fix: 🐛 B."')).toBe(ONE_REFUSAL)
    expect(await bash($, b, 'git push --force')).toBe(FORCE_REFUSAL.deny)
    expect(dialogs(b)).toEqual([])
  })

  test('a pick used on another branch, and a switch while a pick is held', async ($, on) => {
    const b = await mike($, on)
    b.pick = 'Commit it'
    const question = { question: 'Commit "fix: 🐛 X." on feat?', header: 'Q', options: [{ label: 'Commit it', description: 'x' }, { label: 'Not yet', description: 'y' }], multiSelect: false }
    await $.tool.call({ tool: 'AskUserQuestion', questions: [question] } as never)
    const before = dialogs(b).length
    expect(await bash($, b, 'git switch main')).toBe(MOVE_REFUSAL)
    b.repos['/repo'] = { ...FEATURE, branch: 'main' }
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toContain('HEAD is now on main')
    expect(dialogs(b).length).toBe(before)
  })
})
