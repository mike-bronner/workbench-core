import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { PromptOrigin } from 'claude-code'

import {
  AGENT_MERGE_REFUSAL,
  AGENT_RELEASE_REFUSAL,
  ALIAS_REFUSAL,
  BUNDLE_REFUSAL,
  COMMIT_REFUSAL,
  LINES_BUNDLE_REFUSAL,
  MERGE_ASK_REFUSAL,
  MERGE_TARGET_REFUSAL,
  MOVE_REFUSAL,
  PUSH_REFUSAL,
  REWRITE_REFUSAL,
  aliasSetsOf,
  askRefusalOf,
  gateOf,
  gitSubOf,
  isRunLabel,
  isDefaultRef,
  mergeNamesOf,
  mergeTargetRefusalOf,
  mergesOf,
  movesHead,
  rewritesAt,
  rewritesOf,
  shownOf,
} from '../hooks/mods/commit-approval'
import { MERGE_REFUSAL, PLAIN_REFUSAL, SUBAGENT_REFUSAL, isReadOnlyPipeline } from '../hooks/mods/commit-guard'
import { parseShell } from '../hooks/mods/shell'
import type { Bench } from './bench'
import { ASKS, HOME, PERSON, asks, bench, start } from './bench'

const prompt = (text: string, origin: PromptOrigin = PERSON) => ({ text, wait: false, origin })

async function bash($: Engine, b: Bench, command: string, agentId?: string): Promise<string | undefined> {
  const before = b.calls.filter(call => call.tool === 'Bash').length
  const result = await $.tool.call({ tool: 'Bash', command, ...(agentId ? { agentId } : {}) } as never)
  expect([command, b.calls.filter(call => call.tool === 'Bash').length > before]).toEqual([command, result.deny === undefined])
  return result.deny
}

const dialogs = (b: Bench): string[] =>
  b.inputs.filter(input => input.tool === 'AskUserQuestion').map(input => ((input.questions as { question: string }[])[0]?.question ?? ''))

async function attended($: Engine, on: Parameters<typeof bench>[0]): Promise<Bench> {
  const b = bench(on)
  b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'main', originHead: 'main', originUrl: 'git@github.com:o/r.git' }
  b.trees['/repo'] = ' M a.ts\0?? b.ts\0'
  await $.session.start(start())
  await $.prompt.submit(prompt('look this over'))
  return b
}

const ACTIONS: readonly [string, string, readonly string[]][] = [
  ['a commit', 'git add -A', ['git commit', '/repo', 'main', '"fix: 🐛 X."', 'a.ts, b.ts']],
  ['a push', 'git push origin main', ['git push', '/repo', 'main', 'git push origin main']],
  ['a merge', 'git merge fix/x', ['merge into the default branch', 'git merge fix/x']],
  ['a pull request merge', 'gh pr merge 12 --squash', ['merge into the default branch', 'gh pr merge 12 --squash']],
  ['a release', 'gh release create 1.0.0 --notes x', ['release', 'gh release create 1.0.0']],
  ['a cherry-pick', 'git cherry-pick abc1234', ['history rewrite', 'git cherry-pick abc1234']],
  ['a gh alias set', "gh alias set co 'pr checkout'", ['gh alias set', 'gh alias set co']],
  ['an API write to the default branch', 'gh api -X PUT repos/o/r/contents/f -f branch=main -f message=x', ['GitHub API write to the default branch', 'the repository /repo, and the branch main.']],
]

const lineOf = (name: string, first: string): string => (name === 'a commit' ? 'git commit -m "fix: 🐛 X."' : first)

const ask = (question: string, labels: readonly string[]) => ({
  tool: 'AskUserQuestion' as const,
  questions: [{ question, header: 'Approve', options: labels.map(label => ({ label, description: label })), multiSelect: false }],
})

const QUESTIONS: Readonly<Record<string, readonly [string, string, string]>> = {
  'a commit': ['Commit "fix: 🐛 X." on main, with a.ts and b.ts?', 'Commit it', 'Not yet'],
  'a push': ['Push main to origin?', 'Push', 'Not yet'],
  'a merge': ['Merge fix/x into main?', 'Merge it', 'Open a PR'],
  'a pull request merge': ['Merge PR 12 into main?', 'Merge it', 'Open a PR'],
}

const questionFor = (name: string, line: string): readonly [string, string, string] => QUESTIONS[name] ?? [`Run \`${line}\` in /repo, on main?`, 'Run it', 'Not now']

async function picks($: Engine, b: Bench, name: string, line: string, label?: string): Promise<void> {
  const [question, yes, no] = questionFor(name, line)
  b.pick = label ?? yes
  expect((await $.tool.call(ask(question, [yes, no]) as never)).deny).toBeUndefined()
}

describe('AC6: in an attended session an unapproved gated action is denied, with the instruction to ask Mike', () => {
  for (const [name, first, words] of ACTIONS) {
    const line = lineOf(name, first)
    test(`${name}: the deny names the line, the action and its target, and opens no dialog of its own`, async ($, on) => {
      const b = await attended($, on)
      b.trees['/repo'] = name === 'a commit' ? 'A  a.ts\0A  b.ts\0' : b.trees['/repo'] ?? ''
      b.pick = 'Yes'
      const deny = await bash($, b, line)
      expect(deny).toContain('Ask him through AskUserQuestion, with this question alone in its call.')
      expect(deny).toContain(`name the exact line \`${line}\``)
      expect(deny).toContain('After he picks, run the line again, unchanged.')
      for (const word of words) expect([word, deny?.includes(word)]).toEqual([word, true])
      expect(dialogs(b)).toEqual([])
    })

    test(`${name}: his pick approves it once, and a pick of the other option approves nothing`, async ($, on) => {
      const b = await attended($, on)
      b.trees['/repo'] = name === 'a commit' ? 'A  a.ts\0A  b.ts\0' : b.trees['/repo'] ?? ''
      const deny = await bash($, b, line)
      await picks($, b, name, line, questionFor(name, line)[2])
      expect(await bash($, b, line)).toBe(deny)
      await picks($, b, name, line)
      expect(await bash($, b, line)).toBeUndefined()
      expect(await bash($, b, line)).toBe(deny)
    })
  }

  test('a typed request or a pick still approves, and opens no dialog', async ($, on) => {
    const b = await attended($, on)
    b.trees['/repo'] = ''
    await $.prompt.submit(prompt('commit and push'))
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
    expect(await bash($, b, 'git push')).toBeUndefined()
    expect(dialogs(b)).toEqual([])
  })

  test('a rewrite and an alias set are denied even under a typed commit request', async ($, on) => {
    const b = await attended($, on)
    await $.prompt.submit(prompt('commit and push'))
    expect(await bash($, b, 'git rebase main')).toMatch(ASKS.rewrite)
    expect(await bash($, b, "gh alias set co 'pr checkout'")).toMatch(ASKS.alias)
    expect(dialogs(b)).toEqual([])
  })

  test('the deny names the repository and branch, and the commit message and files', () => {
    const text = askRefusalOf(['commit'], { command: 'git commit -F m.txt', repo: '/repo', branch: 'refs/heads/fix/x', message: 'the text of m.txt', files: ['a.ts'] })
    expect(text).toContain('name the exact line `git commit -F m.txt`, the action (git commit), the repository /repo, and the branch fix/x.')
    expect(text).toContain('Name the message, the text of m.txt, and every file git status lists: a.ts.')
    expect(text).toContain('offer "Commit it" and "Not yet"')
    expect(askRefusalOf(['commit'], { command: 'git commit -m x', files: [] })).toContain('and that git status lists no files.')
    expect(askRefusalOf(['merge'], { command: 'git merge x' })).toContain('the repository a repository the gate cannot read, and the branch a branch the gate cannot read.')
    expect(askRefusalOf(['release'], { command: 'gh release create 1.0.0' })).toContain('offer "Run it" and "Not now". A "Run it" pick approves this one line, once.')
  })

  for (const [name, line, repo, branch] of [
    ['a release with -R', 'gh release create 1.0.0 -R x/y --notes n', 'x/y on GitHub', 'the default branch of x/y'],
    ['a release with --repo=', 'gh release create 1.0.0 --repo=x/y --notes n', 'x/y on GitHub', 'the default branch of x/y'],
    ['a release under GH_REPO', 'GH_REPO=x/y gh release create 1.0.0 --notes n', 'x/y on GitHub', 'the default branch of x/y'],
    ['an API write to another repository', 'gh api -X PUT repos/x/y/contents/f -f branch=feat -f message=x', 'x/y on GitHub', 'feat'],
  ] as const) {
    test(`AC6: ${name} is denied naming that repository and its branch, not the session's`, async ($, on) => {
      const b = await attended($, on)
      const deny = await bash($, b, line)
      expect(deny).toContain(`the repository ${repo}, and the branch ${branch}.`)
      expect(deny).not.toContain('the repository /repo')
    })
  }

  test('AC6: a write to this repository by name still names the local checkout', async ($, on) => {
    const b = await attended($, on)
    expect(await bash($, b, 'gh api -X PUT repos/o/r/contents/f -f branch=main -f message=x')).toContain('the repository /repo, and the branch main.')
  })

  test('AC7: a line that is both a commit and a rewrite lists the message and every file', async ($, on) => {
    const b = await attended($, on)
    b.trees['/repo'] = 'A  a.ts\0A  b.ts\0'
    const deny = await bash($, b, 'git commit --amend -m "fix: 🐛 X."')
    expect(deny).toMatch(asks('git commit and history rewrite'))
    expect(deny).toContain('Name the message, "fix: 🐛 X.", and every file git status lists: a.ts, b.ts.')
  })

  test('a line that needs two approvals is denied with the instruction to split it', async ($, on) => {
    const b = await attended($, on)
    b.trees['/repo'] = ''
    const deny = await bash($, b, 'git commit -m "fix: 🐛 X." && git push')
    expect(deny).toBe(askRefusalOf(['commit', 'push'], { command: '' }))
    expect(deny).toContain('run each as a line of its own')
  })
})

describe('AC7: a pick approves exactly one action of the kind its question names', () => {
  for (const [name, line] of [
    ['a release', 'gh release create 1.0.0 --notes x'],
    ['a cherry-pick', 'git cherry-pick abc1234'],
    ['a gh alias set', "gh alias set co 'pr checkout'"],
    ['an API write to the default branch', 'gh api -X PUT repos/o/r/contents/f -f branch=main -f message=x'],
  ] as const) {
    test(`${name}: a "Run it" pick on a question that names the line approves that line once, and no other line`, async ($, on) => {
      const b = await attended($, on)
      expect(await bash($, b, line)).toBeDefined()
      await picks($, b, name, line)
      expect(await bash($, b, `${line} `)).toBeDefined()
      expect(await bash($, b, line)).toBeUndefined()
      expect(await bash($, b, line)).toBeDefined()
    })

    test(`${name}: a question that does not name the line in backticks, or a pick before the deny, approves nothing`, async ($, on) => {
      const b = await attended($, on)
      await picks($, b, name, line)
      expect(await bash($, b, line)).toBeDefined()
      b.pick = 'Run it'
      expect((await $.tool.call(ask(`Run ${line}?`, ['Run it', 'Not now']) as never)).deny).toBeUndefined()
      expect(await bash($, b, line)).toBeDefined()
    })

    test(`${name}: his next prompt ends the pick and the line it waits on`, async ($, on) => {
      const b = await attended($, on)
      await bash($, b, line)
      await $.prompt.submit(prompt('wait'))
      await picks($, b, name, line)
      expect(await bash($, b, line)).toBeDefined()
      await picks($, b, name, line)
      await $.prompt.submit(prompt('wait'))
      expect(await bash($, b, line)).toBeDefined()
    })
  }

  test('AC1: a question that names a line with a hidden character only in its raw form approves nothing, and the escaped form does', async ($, on) => {
    const b = await attended($, on)
    const line = "gh alias set co 'pr checkout ‮'"
    expect(await bash($, b, line)).toMatch(ASKS.alias)
    b.pick = 'Run it'
    expect((await $.tool.call(ask(`Run \`${line}\`?`, ['Run it', 'Not now']) as never)).deny).toBeUndefined()
    expect(await bash($, b, line)).toMatch(ASKS.alias)
    expect(shownOf(line)).toContain('\\u202e')
    expect((await $.tool.call(ask(`Run \`${shownOf(line)}\`?`, ['Run it', 'Not now']) as never)).deny).toBeUndefined()
    expect(await bash($, b, line)).toBeUndefined()
  })

  test('a line pick question beside another question, or naming two waiting lines, is refused', async ($, on) => {
    const b = await attended($, on)
    await bash($, b, 'git rebase main')
    await bash($, b, 'git cherry-pick abc1234')
    const other = { question: 'Which name?', header: 'Name', options: [{ label: 'x', description: 'x' }, { label: 'y', description: 'y' }], multiSelect: false }
    const one = ask('Run `git rebase main` in /repo, on main?', ['Run it', 'Not now']).questions[0]
    expect((await $.tool.call({ tool: 'AskUserQuestion', questions: [one, other] } as never)).deny).toBe(BUNDLE_REFUSAL)
    expect((await $.tool.call(ask('Run `git rebase main` and `git cherry-pick abc1234`?', ['Run it', 'Not now']) as never)).deny).toBe(LINES_BUNDLE_REFUSAL)
  })

  test('a rewrite pick is bound to the branch HEAD held, and a branch switch before it is refused', async ($, on) => {
    const b = await attended($, on)
    await bash($, b, 'git rebase main')
    await picks($, b, 'a rewrite', 'git rebase main')
    expect(await bash($, b, 'git switch feat')).toBe(MOVE_REFUSAL)
    b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'feat', originHead: 'main' }
    expect(await bash($, b, 'git rebase main')).toContain('Mike picked it while HEAD was on main, and HEAD is now on feat')
    expect(await bash($, b, 'git rebase main')).toMatch(ASKS.rewrite)
  })

  test('a reset pick runs its own line, which moves HEAD', async ($, on) => {
    const b = await attended($, on)
    expect(movesHead('git reset --soft HEAD~1')).toBe(true)
    expect(await bash($, b, 'git reset --soft HEAD~1')).toMatch(ASKS.rewrite)
    await picks($, b, 'a rewrite', 'git reset --soft HEAD~1')
    expect(await bash($, b, 'git reset --soft HEAD~1')).toBeUndefined()
  })

  test('one command that counts as a push and a rewrite asks once, and one pick on its line runs it once', async ($, on) => {
    const b = await attended($, on)
    const line = 'git push . x:main'
    const deny = await bash($, b, line)
    expect(deny).toMatch(asks('git push and history rewrite'))
    expect(deny).toContain('offer "Run it" and "Not now"')
    await picks($, b, 'a rewrite', line)
    expect(await bash($, b, line)).toBeUndefined()
    expect(await bash($, b, line)).toBe(deny)
  })

  test('two commands that need two approvals get the split instruction, and no pick covers them', async ($, on) => {
    const b = await attended($, on)
    const line = 'git rebase main && git push'
    expect(await bash($, b, line)).toContain('run each as a line of its own')
    await picks($, b, 'a rewrite', line)
    expect(await bash($, b, line)).toContain('run each as a line of its own')
  })

  test('a line pick covers only its own line, only the kind it was asked for, and only one action of it', () => {
    const counts = { writes: { commits: 0, pushes: 0 }, releases: 0, merges: 0, rewrites: 1, aliases: 0, apiWrites: 0 }
    const pick = { action: 'rewrite' as const, heads: [], line: 'x' }
    expect(gateOf(counts, pick, [], 'x').missing).toEqual([])
    expect(gateOf(counts, pick, [], 'y').missing).toEqual(['rewrite'])
    expect(gateOf(counts, { ...pick, action: 'release' as const }, [], 'x').missing).toEqual(['rewrite'])
    expect(gateOf({ ...counts, rewrites: 2 }, pick, [], 'x').missing).toEqual(['rewrite'])
    expect(gateOf({ ...counts, writes: { commits: 0, pushes: 1 } }, pick, [], 'x').missing).toEqual([])
  })

  test('the label must approve: a negated or unrelated label approves nothing', () => {
    for (const label of ['Run it', 'Yes', 'Yes, run it', 'Approve', 'Release it', 'Go ahead']) expect([label, isRunLabel(label)]).toEqual([label, true])
    for (const label of ['Not now', 'No', "Don't run it", 'Run it later', 'Keep it', 'Hold']) expect([label, isRunLabel(label)]).toEqual([label, false])
  })
})

type Lane = { name: string; options: Parameters<typeof bench>[1]; isInteractive: boolean; agentId?: string; origin: PromptOrigin }
const UNATTENDED: readonly Lane[] = [
  { name: 'a -p run', options: {}, isInteractive: false, origin: { kind: 'sdk' } },
  { name: 'the pipeline', options: { env: { HOME, WORKBENCH_DEV_TEAM_PIPELINE: '1', CLAUDE_CODE_AGENT: 'watson' } }, isInteractive: false, origin: { kind: 'sdk' } },
  { name: 'a scheduled turn', options: {}, isInteractive: true, origin: { kind: 'scheduled-trigger' } },
  { name: 'a sub-agent', options: {}, isInteractive: true, agentId: 'a1', origin: PERSON },
]

async function inLane($: Engine, on: Parameters<typeof bench>[0], lane: Lane): Promise<Bench> {
  const b = bench(on, lane.options)
  b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'main', originHead: 'main' }
  b.pick = 'Yes'
  await $.session.start(start(lane.isInteractive))
  await $.prompt.submit(prompt('Item ID: 12', lane.origin))
  return b
}

describe('AC2: where nobody can answer, the same actions are refused, and no dialog opens', () => {
  for (const lane of UNATTENDED) {
    test(`${lane.name}: a rewrite, an alias set and a merge into the default branch are refused`, async ($, on) => {
      const b = await inLane($, on, lane)
      const isAgent = lane.name !== 'a scheduled turn'
      expect(await bash($, b, 'git cherry-pick abc1234', lane.agentId)).toBe(REWRITE_REFUSAL)
      expect(await bash($, b, 'git rebase origin/main', lane.agentId)).toBe(REWRITE_REFUSAL)
      expect(await bash($, b, "gh alias set co 'pr checkout'", lane.agentId)).toBe(isAgent ? AGENT_RELEASE_REFUSAL : ALIAS_REFUSAL)
      expect(await bash($, b, 'git merge fix/x', lane.agentId)).toBe(AGENT_MERGE_REFUSAL)
      expect(dialogs(b)).toEqual([])
    })
  }

  test('a sub-agent and the pipeline: a commit or push in a sub-agent and a pull request merge in either are refused', async ($, on) => {
    const sub = await inLane($, on, UNATTENDED[3] as Lane)
    expect(await bash($, sub, 'git commit -m "fix: 🐛 X."', 'a1')).toBe(SUBAGENT_REFUSAL.deny)
    expect(await bash($, sub, 'gh pr merge 12', 'a1')).toBe(MERGE_REFUSAL.deny)
    expect(dialogs(sub)).toEqual([])
  })

  for (const origin of [{ kind: 'peer' }, { kind: 'channel', server: 'slack' }, { kind: 'sdk' }] as PromptOrigin[]) {
    test(`a ${origin.kind} turn in Mike's session: every gated action is refused with the fallback reason, and a release is denied with the instruction to ask`, async ($, on) => {
      const b = bench(on)
      b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'main', originHead: 'main' }
      b.trees['/repo'] = ''
      b.pick = 'Yes'
      await $.session.start(start())
      await $.prompt.submit(prompt('commit and push', origin))
      expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBe(COMMIT_REFUSAL)
      expect(await bash($, b, 'git push')).toBe(PUSH_REFUSAL)
      expect(await bash($, b, 'git merge fix/x')).toBe(MERGE_ASK_REFUSAL)
      expect(await bash($, b, 'git cherry-pick abc1234')).toBe(REWRITE_REFUSAL)
      expect(await bash($, b, "gh alias set co 'pr checkout'")).toBe(ALIAS_REFUSAL)
      expect(await bash($, b, 'gh release create 1.0.0')).toMatch(ASKS.release)
      expect(dialogs(b)).toEqual([])
      await picks($, b, 'a release', 'gh release create 1.0.0')
      expect(await bash($, b, 'git cherry-pick abc1234')).toBe(REWRITE_REFUSAL)
      expect(await bash($, b, 'gh release create 1.0.0')).toBeUndefined()
    })
  }
})

describe('AC3: the merge routes Holmes found are gated in every lane', () => {
  test('a merge through a git alias on the default branch asks Mike', async ($, on) => {
    const b = await attended($, on)
    expect(await bash($, b, 'git -c alias.m=merge m feat')).toMatch(ASKS.merge)
  })

  for (const lane of UNATTENDED) {
    test(`${lane.name}: a merge through a git alias, or through a shell alias, is refused`, async ($, on) => {
      const b = await inLane($, on, lane)
      expect(await bash($, b, 'git -c alias.m=merge m feat', lane.agentId)).toBe(AGENT_MERGE_REFUSAL)
      expect(await bash($, b, "git -c alias.m='!git merge feat' m", lane.agentId)).toBeDefined()
    })
  }

  for (const line of ['git switch main && git merge feat', 'git switch main; git pull']) {
    test(`from a feature branch, ${JSON.stringify(line)} asks Mike, and is refused where nobody can answer`, async ($, on) => {
      const b = await attended($, on)
      b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'feat', originHead: 'main' }
      expect(await bash($, b, line)).toMatch(ASKS.merge)
      expect(dialogs(b)).toEqual([])
    })
    for (const lane of UNATTENDED) {
      test(`${lane.name}: ${JSON.stringify(line)} from a feature branch is refused`, async ($, on) => {
        const b = await inLane($, on, lane)
        b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'feat', originHead: 'main' }
        expect(await bash($, b, line, lane.agentId)).toBe(AGENT_MERGE_REFUSAL)
      })
    }
  }

  test('a branch switch on the line makes the merge directory unknown, so it counts as the default', () => {
    expect(mergesOf('git checkout main && git merge feat').local).toEqual([null])
    expect(mergesOf('git switch main; git pull').local).toEqual([null])
    expect(mergesOf('git merge feat').local).toEqual([''])
    expect(gitSubOf(parseShell('git -c alias.m=merge m feat').statements[0]!)).toBe('merge')
    expect(gitSubOf(parseShell("git -c alias.m='!git merge feat' m").statements[0]!)).toBe('!')
    expect(mergesOf("git -c alias.m='!git merge feat' m").local).toEqual([null])
  })

  for (const line of [
    "gh api graphql -f query='mutation { mergeBranch(input: {repositoryId: \"x\", base: \"main\", head: \"feat\"}) { clientMutationId } }'",
    'gh api graphql --input body.json',
    'echo "$Q" | gh api graphql --input -',
    'gh api graphql -F query=@q.graphql',
  ]) {
    test(`a GraphQL merge, or a GraphQL body the guard cannot read, is a merge: ${JSON.stringify(line)}`, () => {
      expect(mergesOf(line).pr).toBe(1)
    })
    for (const lane of UNATTENDED.filter(each => each.agentId !== undefined || each.name === 'the pipeline')) {
      test(`${lane.name}: refused, ${JSON.stringify(line)}`, async ($, on) => {
        const b = await inLane($, on, lane)
        expect(await bash($, b, line, lane.agentId)).toBeDefined()
        expect(dialogs(b)).toEqual([])
      })
    }
  }

  test('in Mike\'s session the unread GraphQL body asks, and the literal mergeBranch is asked to run as a plain line', async ($, on) => {
    const b = await attended($, on)
    b.files.set('/repo/q.graphql', 'query { viewer { login } }')
    expect(await bash($, b, 'gh api graphql -F query=@q.graphql')).toMatch(ASKS.merge)
    expect(await bash($, b, "gh api graphql -f query='mutation { mergeBranch(input: {}) { clientMutationId } }'")).toBe(PLAIN_REFUSAL.deny)
  })

  test('a GraphQL query fed from a heredoc is read, so a plain query is no merge', () => {
    expect(mergesOf("gh api graphql -F query=@- <<'EOF'\nquery { viewer { login } }\nEOF").pr).toBe(0)
  })
})

describe('AC4: history rewrites and gh alias set need Mike\'s approval', () => {
  test('the rewrite reader', () => {
    for (const line of ['git cherry-pick abc1234', 'git revert HEAD', 'git am < p.patch', 'git rebase main', 'git rebase --continue', 'git update-ref refs/heads/main abc1234', 'git reset --hard HEAD~2', 'git reset origin/main', 'git reset --soft abc1234', "bash -c 'git rebase main'", 'git -c alias.r=rebase r main']) {
      expect([line, rewritesOf(line)]).toEqual([line, 1])
    }
    for (const line of ['git rebase --abort', 'git cherry-pick --quit', 'git reset', 'git reset -q', 'git reset HEAD', 'git reset HEAD -- a.ts', 'git reset -- a.ts', 'git log --grep rebase', 'echo git rebase']) {
      expect([line, rewritesOf(line)]).toEqual([line, 0])
    }
    expect(aliasSetsOf("gh alias set co 'pr checkout'")).toBe(1)
    expect(aliasSetsOf('gh alias import aliases.yml')).toBe(1)
    expect(aliasSetsOf('gh alias list')).toBe(0)
  })

  for (const line of ['git revert HEAD', 'git am < p.patch', 'git rebase main', 'git reset --soft HEAD~2', 'git update-ref refs/heads/main abc1234']) {
    test(`is denied with the instruction to ask in Mike's session, and runs on his pick: ${JSON.stringify(line)}`, async ($, on) => {
      const b = await attended($, on)
      expect(await bash($, b, line)).toMatch(ASKS.rewrite)
      expect(dialogs(b)).toEqual([])
      await picks($, b, 'a rewrite', line)
      expect(await bash($, b, line)).toBeUndefined()
    })
  }
})

describe('the pipeline rewrites history on its own feature branches, and never on the default branch', () => {
  const PIPELINE = UNATTENDED[1] as Lane
  const REWRITES = ['git rebase origin/main', 'git cherry-pick abc1234', 'git revert HEAD', 'git am < p.patch', 'git reset --soft HEAD~1']

  for (const line of [...REWRITES, 'git update-ref refs/heads/feat abc1234']) {
    test(`on a feature branch it runs: ${JSON.stringify(line)}`, async ($, on) => {
      const b = await inLane($, on, PIPELINE)
      b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'feat', originHead: 'main' }
      expect(await bash($, b, line)).toBeUndefined()
      expect(dialogs(b)).toEqual([])
    })
  }

  for (const line of REWRITES) {
    test(`on the default branch, on a branch it cannot read, with no origin/HEAD, or after a cd, it is refused: ${JSON.stringify(line)}`, async ($, on) => {
      const b = await inLane($, on, PIPELINE)
      b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'main', originHead: 'main' }
      expect(await bash($, b, line)).toBe(REWRITE_REFUSAL)
      b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: null, originHead: 'main' }
      expect(await bash($, b, line)).toBe(REWRITE_REFUSAL)
      b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'feat' }
      expect(await bash($, b, line)).toBe(REWRITE_REFUSAL)
      b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'feat', originHead: 'main' }
      expect(await bash($, b, `cd /repo && ${line}`)).toBe(REWRITE_REFUSAL)
    })
  }

  test('an update-ref of the default branch\'s ref is refused from a feature branch', async ($, on) => {
    const b = await inLane($, on, PIPELINE)
    b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'feat', originHead: 'main' }
    for (const line of ['git update-ref refs/heads/main abc1234', 'git update-ref main abc1234', 'git update-ref -d refs/heads/main']) {
      expect([line, await bash($, b, line)]).toEqual([line, REWRITE_REFUSAL])
    }
  })

  for (const lane of [UNATTENDED[0], UNATTENDED[2], UNATTENDED[3], { ...PIPELINE, name: 'a sub-agent of the pipeline', agentId: 'helper-1' }] as Lane[]) {
    test(`${lane.name} still never rewrites, even on a feature branch`, async ($, on) => {
      const b = await inLane($, on, lane)
      b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'feat', originHead: 'main' }
      expect(await bash($, b, 'git rebase origin/main', lane.agentId)).toBe(REWRITE_REFUSAL)
    })
  }

  test('the rewrite reader gives each rewrite\'s directory and the ref an update-ref moves', () => {
    expect(rewritesAt('git rebase main')).toEqual([{ dir: '' }])
    expect(rewritesAt('git -C /a cherry-pick x')).toEqual([{ dir: '/a' }])
    expect(rewritesAt('git switch feat && git rebase main')).toEqual([{ dir: null }])
    expect(rewritesAt('git update-ref -d refs/heads/x')).toEqual([{ dir: '', refs: ['refs/heads/x'] }])
    expect(isDefaultRef('refs/heads/main', 'refs/remotes/origin/main')).toBe(true)
    expect(isDefaultRef('main', 'refs/remotes/origin/main')).toBe(true)
    expect(isDefaultRef('refs/heads/feat', 'refs/remotes/origin/main')).toBe(false)
    expect(isDefaultRef('refs/heads/feat', undefined)).toBe(true)
  })
})

describe('AC5: a merge pick binds to the remote, the subject and the base its question named', () => {
  test('a pull from a URL is not the branch the pick named', () => {
    const names = mergeNamesOf([{ question: 'Merge feat into main?' }])
    expect(mergeTargetRefusalOf(names, mergesOf('git pull origin feat').targets)).toBeUndefined()
    expect(mergeTargetRefusalOf(names, mergesOf('git pull https://x/y feat').targets)).toBe(MERGE_TARGET_REFUSAL)
    expect(mergeTargetRefusalOf(names, mergesOf('git pull ../other feat').targets)).toBe(MERGE_TARGET_REFUSAL)
    for (const change of ['git remote set-url origin https://x/y', 'git remote add origin https://x/y', 'git remote rename up origin']) {
      expect([change, mergeTargetRefusalOf(names, mergesOf(`${change} && git pull origin feat`).targets)]).toEqual([change, MERGE_TARGET_REFUSAL])
    }
  })

  test('the destination of the question is not a branch it approves', () => {
    const names = mergeNamesOf([{ question: 'Merge PR 12 into main?' }])
    expect(mergeTargetRefusalOf(names, mergesOf('git merge main').targets)).toBe(MERGE_TARGET_REFUSAL)
    expect(mergeTargetRefusalOf(names, mergesOf('gh pr merge 12').targets)).toBeUndefined()
    expect(names.bases).toEqual(['main'])
  })

  test('the REST branch merge needs both its head and its base named', () => {
    const names = mergeNamesOf([{ question: 'Merge feat into main?' }])
    expect(mergeTargetRefusalOf(names, mergesOf('gh api repos/o/r/merges -f base=main -f head=feat').targets)).toBeUndefined()
    expect(mergeTargetRefusalOf(names, mergesOf('gh api repos/o/r/merges -f base=release -f head=feat').targets)).toBe(MERGE_TARGET_REFUSAL)
    expect(mergeTargetRefusalOf(names, mergesOf('gh api repos/o/r/merges -f head=feat').targets)).toBe(MERGE_TARGET_REFUSAL)
  })

  test('in the hook, a pick on "Merge PR 12 into main" refuses git merge main', async ($, on) => {
    const b = await attended($, on)
    b.pick = 'Merge it'
    expect((await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'Merge PR 12 into main?', header: 'Q', options: [{ label: 'Merge it', description: 'x' }, { label: 'Open a PR', description: 'y' }], multiSelect: false }] } as never)).deny).toBeUndefined()
    expect(await bash($, b, 'git merge main')).toBe(MERGE_TARGET_REFUSAL)
    expect(await bash($, b, 'gh pr merge 12')).toBeUndefined()
  })
})

describe('AC6: the test gaps Holmes listed', () => {
  test('a sed with a w command is never a read-only stage', () => {
    for (const line of ["grep -oh 'git push' f | sed -n 's/a/b/w out'", "sed -n '1w out' f", "grep -n x f | sed -n '/x/w out'"]) {
      expect([line, isReadOnlyPipeline(parseShell(line))]).toEqual([line, false])
    }
  })
})
