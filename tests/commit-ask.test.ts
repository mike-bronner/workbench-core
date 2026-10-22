import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { PromptOrigin } from 'claude-code'

import {
  AGENT_MERGE_REFUSAL,
  AGENT_RELEASE_REFUSAL,
  ALIAS_REFUSAL,
  APPROVE_LABEL,
  COMMIT_REFUSAL,
  DECLINE_LABEL,
  MERGE_ASK_REFUSAL,
  MERGE_TARGET_REFUSAL,
  PUSH_REFUSAL,
  RELEASE_REFUSAL,
  REWRITE_REFUSAL,
  aliasSetsOf,
  askTextOf,
  declinedRefusal,
  gitSubOf,
  isDefaultRef,
  mergeNamesOf,
  mergeTargetRefusalOf,
  mergesOf,
  rewritesAt,
  rewritesOf,
} from '../hooks/mods/commit-approval'
import { MERGE_REFUSAL, PLAIN_REFUSAL, SUBAGENT_REFUSAL, isReadOnlyPipeline } from '../hooks/mods/commit-guard'
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

async function attended($: Engine, on: Parameters<typeof bench>[0]): Promise<Bench> {
  const b = bench(on)
  b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'main', originHead: 'main' }
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
]

const lineOf = (name: string, first: string): string => (name === 'a commit' ? 'git commit -m "fix: 🐛 X."' : first)

describe('AC1: in an attended session a gated action asks Mike, and runs only on a yes', () => {
  for (const [name, first, words] of ACTIONS) {
    const line = lineOf(name, first)
    test(`${name}: one dialog names the action and its target, and a yes runs it`, async ($, on) => {
      const b = await attended($, on)
      b.trees['/repo'] = name === 'a commit' ? 'A  a.ts\0A  b.ts\0' : b.trees['/repo'] ?? ''
      b.pick = APPROVE_LABEL
      expect(await bash($, b, line)).toBeUndefined()
      const asked = dialogs(b)
      expect(asked.length).toBe(1)
      for (const word of words) expect([word, asked[0]?.includes(word)]).toEqual([word, true])
      expect(asked[0]?.endsWith('Run it?')).toBe(true)
    })

    test(`${name}: a no or a closed dialog refuses it`, async ($, on) => {
      const b = await attended($, on)
      b.trees['/repo'] = name === 'a commit' ? 'A  a.ts\0A  b.ts\0' : b.trees['/repo'] ?? ''
      b.pick = DECLINE_LABEL
      const no = await bash($, b, line)
      expect(no).toContain('Mike answered no in the approval dialog')
      b.pick = undefined
      expect(await bash($, b, line)).toBe(no)
      expect(b.calls.some(call => call.tool === 'Bash')).toBe(false)
    })
  }

  test('a typed request or a pick still approves with no dialog', async ($, on) => {
    const b = await attended($, on)
    b.trees['/repo'] = ''
    await $.prompt.submit(prompt('commit and push'))
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
    expect(await bash($, b, 'git push')).toBeUndefined()
    expect(dialogs(b)).toEqual([])
  })

  test('a rewrite and an alias set ask even under a typed commit request', async ($, on) => {
    const b = await attended($, on)
    await $.prompt.submit(prompt('commit and push'))
    b.pick = DECLINE_LABEL
    expect(await bash($, b, 'git rebase main')).toBe(declinedRefusal(['rewrite']))
    expect(await bash($, b, "gh alias set co 'pr checkout'")).toBe(declinedRefusal(['alias']))
  })

  test('the question names the repository and branch, and the commit message and files', () => {
    const text = askTextOf(['commit'], { command: 'git commit -F m.txt', asker: 'your own turn', repo: '/repo', branch: 'refs/heads/fix/x', message: 'the text of m.txt', files: ['a.ts'] })
    expect(text).toBe('Asked by your own turn. Approve this git commit in /repo, on fix/x: `git commit -F m.txt`. The message is the text of m.txt. The tree holds 1 file to commit: a.ts. Run it?')
    expect(askTextOf(['merge'], { command: 'git merge x' })).toContain('a repository the gate cannot read, on a branch the gate cannot read')
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
  b.pick = APPROVE_LABEL
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
    test(`a ${origin.kind} turn in Mike's session: every gated action is refused with the fallback reason, and a release still asks`, async ($, on) => {
      const b = bench(on)
      b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'main', originHead: 'main' }
      b.trees['/repo'] = ''
      b.pick = APPROVE_LABEL
      await $.session.start(start())
      await $.prompt.submit(prompt('commit and push', origin))
      expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBe(COMMIT_REFUSAL)
      expect(await bash($, b, 'git push')).toBe(PUSH_REFUSAL)
      expect(await bash($, b, 'git merge fix/x')).toBe(MERGE_ASK_REFUSAL)
      expect(await bash($, b, 'git cherry-pick abc1234')).toBe(REWRITE_REFUSAL)
      expect(await bash($, b, "gh alias set co 'pr checkout'")).toBe(ALIAS_REFUSAL)
      expect(dialogs(b)).toEqual([])
      expect(await bash($, b, 'gh release create 1.0.0')).toBeUndefined()
      expect(dialogs(b).length).toBe(1)
      expect(dialogs(b)[0]).toContain('Approve this release')
    })
  }
})

describe('AC3: the merge routes Holmes found are gated in every lane', () => {
  test('a merge through a git alias on the default branch asks Mike', async ($, on) => {
    const b = await attended($, on)
    b.pick = DECLINE_LABEL
    expect(await bash($, b, 'git -c alias.m=merge m feat')).toBe(declinedRefusal(['merge']))
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
      b.pick = DECLINE_LABEL
      expect(await bash($, b, line)).toContain('Mike answered no in the approval dialog')
      expect(dialogs(b)[0]).toContain('merge into the default branch')
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
    b.pick = DECLINE_LABEL
    b.files.set('/repo/q.graphql', 'query { viewer { login } }')
    expect(await bash($, b, 'gh api graphql -F query=@q.graphql')).toBe(declinedRefusal(['merge']))
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
    test(`asks in Mike's session: ${JSON.stringify(line)}`, async ($, on) => {
      const b = await attended($, on)
      b.pick = APPROVE_LABEL
      expect(await bash($, b, line)).toBeUndefined()
      expect(dialogs(b)[0]).toContain('history rewrite')
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
