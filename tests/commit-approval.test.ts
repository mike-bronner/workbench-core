import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { PromptOrigin } from 'claude-code'

import {
  BUNDLE_REFUSAL,
  AGENT_MERGE_REFUSAL,
  MERGE_ASK_REFUSAL,
  MERGE_TARGET_REFUSAL,
  MOVE_REFUSAL,
  ONE_REFUSAL,
  PUSH_REFUSAL,
  bindingRefusalOf,
  bundleRefusalOf,
  catchUpsOf,
  commandsOf,
  dirOf,
  headsOf,
  isDefaultBranch,
  mergesOf,
  movesHead,
  pickOf,
  pullRebasesOf,
  readLine,
  rewriteKindsOf,
  rewritesAt,
  rewriteNameOf,
  rewriteRefusalOf,
  rewritesOf,
  writesOf,
  BRANCH_RESET_REFUSAL,
  REWRITE_REFUSAL,
  TRACKING_REFUSAL,
} from '../hooks/mods/commit-approval'

import { PLAIN_REFUSAL, SUBAGENT_REFUSAL } from '../hooks/mods/commit-guard'
import type { Bench } from './bench'
import { ASKS as DECLINED, HOME, PERSON, asks, bench, exactly, start } from './bench'
import { hiddenCommandRefusal } from '../hooks/mods/guards'
import { parseShell } from '../hooks/mods/shell'
import { CAUGHT, LET_THROUGH } from './commit-corpus'
import { FED_GH } from './commit-guard-cases'

const prompt = (text: string, origin: PromptOrigin = PERSON) => ({ text, wait: false, origin })

const question = (text: string, labels: string[]) => ({
  question: text,
  header: 'Q',
  options: labels.map(label => ({ label, description: label })),
  multiSelect: false,
})

const COMMIT_QUESTION = question('Commit "feat: ✨ Add the gate." on main?', ['Not yet', 'Commit it'])
const PUSH_QUESTION = question('Push main to origin, with the one new commit?', ['Push', 'Not yet'])
const MERGE_QUESTION = question('How should fix/x land on main: merge it locally, or open a pull request?', ['Open a PR', 'Merge locally', 'Leave it'])
const LANDING_QUESTION = question('How should fix/x land on main?', ['Open a pull request', 'I merge locally into main'])
const OTHER_QUESTION = question('Which approach?', ['A', 'B'])

const ask = (questions: unknown[], agentId?: string) => ({ tool: 'AskUserQuestion' as const, questions, ...(agentId ? { agentId } : {}) }) as never

async function bash($: Engine, b: Bench, command: string, agentId?: string): Promise<string | undefined> {
  const before = b.calls.filter(call => call.tool === 'Bash').length
  const result = await $.tool.call({ tool: 'Bash', command, ...(agentId ? { agentId } : {}) } as never)
  const reached = b.calls.filter(call => call.tool === 'Bash').length > before
  expect(reached).toBe(result.deny === undefined)
  return result.deny
}

async function pick($: Engine, b: Bench, label = 'Commit it', questions: unknown[] = [COMMIT_QUESTION]): Promise<void> {
  b.repos['/repo'] ??= { head: 'c1', pushed: 'c1' }
  b.pick = label
  expect((await $.tool.call(ask(questions))).deny).toBeUndefined()
}

const pushPick = ($: Engine, b: Bench) => pick($, b, 'Push', [PUSH_QUESTION])

type Repo = { commitFails: boolean; pushFails: boolean; masks: boolean; errors: boolean }
function repo(b: Bench): Repo {
  const r: Repo = { commitFails: false, pushFails: false, masks: false, errors: false }
  const refs = { head: 'c1', pushed: 'c1' }
  let made = 1
  b.repos['/repo'] = refs
  b.onBash = command => {
    const { commits, pushes } = writesOf(command)
    let failed = false
    if (commits > 0) {
      if (r.commitFails) failed = true
      else refs.head = `c${++made}`
    }
    if (pushes > 0 && !failed) {
      if (r.pushFails) failed = true
      else refs.pushed = refs.head
    }
    return { isError: r.errors || (failed && !r.masks) }
  }
  return r
}

async function session($: Engine, text = 'my review is done'): Promise<void> {
  await $.session.start(start())
  await $.prompt.submit(prompt(text))
}

const gitRuns = (b: Bench) => b.runs.filter(argv => argv[0] === 'git')

describe('AC1: a main-session commit runs with no question, and a push still needs its own approval', () => {
  test('with no request and no pick, a commit runs, and a push is refused with a reason to ask first', async ($, on) => {
    const b = bench(on)
    await session($)
    expect(await bash($, b, 'git commit -m "feat: ✨ Add the gate."')).toBeUndefined()
    expect(await bash($, b, 'git commit -m "fix: 🐛 One more."')).toBeUndefined()
    expect(await bash($, b, 'git push origin main')).toMatch(DECLINED.push)
    expect(PUSH_REFUSAL).toContain('approves no push')
    expect(PUSH_REFUSAL).toContain('of its own')
    expect(PUSH_REFUSAL).not.toMatch(/push of that commit/)
  })

  for (const line of ['git commit', 'git commit -m "fix: 🐛 X."', 'git commit -F msg.txt', 'git -C /repo commit -m "fix: 🐛 X."', 'git commit -am "fix: 🐛 X."', 'git commit -m "fix: 🐛 X." docs/a.md']) {
    test(`a commit runs with no question and reads no tree, whatever it leaves out: ${JSON.stringify(line)}`, async ($, on) => {
      const b = bench(on)
      b.trees['/repo'] = ' M a.ts\0?? b.ts\0'
      await session($)
      b.runs.length = 0
      expect(await bash($, b, line)).toBeUndefined()
      expect(gitRuns(b).filter(argv => argv.includes('status'))).toEqual([])
    })
  }

  test('a commit on the default branch and on a feature branch both run', async ($, on) => {
    const b = bench(on)
    b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'main', originHead: 'main' }
    await session($)
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
    b.repos['/repo'] = { head: 'c2', pushed: 'c1', branch: 'fix/x', originHead: 'main' }
    expect(await bash($, b, 'git commit -m "fix: 🐛 Y."')).toBeUndefined()
  })

  test('a push pick allows one push, and a commit runs before and after it', async ($, on) => {
    const b = bench(on)
    await session($)
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
    await pushPick($, b)
    expect(await bash($, b, 'git commit -m "fix: 🐛 Y."')).toBeUndefined()
    expect(await bash($, b, 'git push')).toBeUndefined()
    expect(await bash($, b, 'git push')).toMatch(DECLINED.push)
  })

  test('a commit and a push on one line ask only about the push', async ($, on) => {
    const b = bench(on)
    await session($)
    const deny = await bash($, b, 'git commit -m "fix: 🐛 X." && git push')
    expect(deny).toMatch(DECLINED.push)
    expect(deny).toContain('the action (git push)')
    expect(deny).not.toContain('Name the message')
  })

  test('two commits on one line run, and two pushes on one line are refused under a push pick', async ($, on) => {
    const b = bench(on)
    await session($)
    expect(await bash($, b, 'git commit -m "fix: 🐛 A."; git commit -m "fix: 🐛 B."')).toBeUndefined()
    await pushPick($, b)
    expect(await bash($, b, 'git push && git push --tags')).toBe(ONE_REFUSAL)
  })

  test('a "Commit it" pick approves nothing, so a push after it is still refused', async ($, on) => {
    const b = bench(on)
    await session($)
    await pick($, b)
    expect(await bash($, b, 'git push')).toMatch(DECLINED.push)
    expect(await bash($, b, 'git switch -c other')).toBeUndefined()
  })

  test('a commit and a push behind a wrapper are still refused by the commit guard, and asked to run as plain lines', async ($, on) => {
    const b = bench(on)
    await session($)
    for (const line of ['HUSKY=0 git commit -m "fix: 🐛 X."', "bash -c 'git commit -m x'", 'GIT_DIR=/other/.git git commit -m "fix: 🐛 X."', 'env -C /other git commit -m "fix: 🐛 X."', 'env --chdir=/other git commit -m "fix: 🐛 X."', 'HUSKY=0 git push', "bash -c 'git push'", 'env git push']) {
      expect([line, await bash($, b, line)]).toEqual([line, PLAIN_REFUSAL.deny])
    }
    expect(await bash($, b, 'git commit -m "fix: 🐛 Y."')).toBeUndefined()
  })

  for (const line of ['eval eval eval eval eval true', "bash -c 'eval eval eval eval true'"]) {
    test(`a line nested past the reader's depth with no literal op word counts as a commit and a push, so it asks about the push: ${JSON.stringify(line)}`, async ($, on) => {
      expect(writesOf(line)).toEqual({ commits: 1, pushes: 1 })
      const b = bench(on)
      await session($)
      expect(await bash($, b, line)).toMatch(DECLINED.push)
    })
  }

  test('a commit behind an eval whose command name is built at run time never runs', async ($, on) => {
    const b = bench(on)
    await session($)
    expect(await bash($, b, 'n=CDP; eval "${n}ATH=/x"; cd other; git commit -m "fix: 🐛 X."; false')).toContain('the shell reader cannot tell which command this line runs')
  })

  for (const line of [
    'n=CDP; printf -v "${n}ATH" /x; cd other; git commit -m "fix: 🐛 X."; false',
    'n=CDP; printf -v"${n}ATH" /x; cd other; git commit -m "fix: 🐛 X."; false',
  ]) {
    test(`a commit behind printf -v into a name built at run time never runs: ${JSON.stringify(line)}`, async ($, on) => {
      const b = bench(on)
      await session($)
      expect(await bash($, b, line)).toContain('the shell reader cannot tell which command this line runs')
    })
  }

  test('an escaped command word beside a real commit counts as a push, so it asks about the push', async ($, on) => {
    const b = bench(on)
    await session($)
    expect(await bash($, b, "$'\\x63d' ../other; git commit -m 'fix: 🐛 X.'")).toMatch(DECLINED.push)
    expect(await bash($, b, "$'\\x67it' push")).toBeDefined()
  })

  test('dirOf leaves any .. unknown, and follows ., absolute and ~ steps', () => {
    for (const steps of [['./link/../other'], ['./link', '../other'], ['/a/../b'], ['../c'], ['..'], ['/', '../c'], ['~/../x'], ['./a/..']]) {
      expect(dirOf(steps, '/repo', HOME)).toBeUndefined()
    }
    expect(dirOf(['./a/./b'], '/repo', HOME)).toBe('/repo/./a/./b')
    expect(dirOf(['./a', '/b', './c'], '/repo', HOME)).toBe('/b/./c')
    expect(dirOf(['~/x'], '/repo', HOME)).toBe(`${HOME}/x`)
    expect(dirOf(['..x/y'], '/repo', HOME)).toBe('/repo/..x/y')
  })

  test('a bare relative target is unknown whether or not CDPATH shows on the line', () => {
    for (const line of ['cd other; git commit -m x', 'CDPATH=/p; cd other; git commit -m x', 'cd sub/dir && git commit -m x']) {
      expect(readLine(line).dir).toBeNull()
    }
    expect(readLine('cd ./other; git commit -m x').dir).toEqual(['./other'])
  })

  test('only `pushd <dir>` is followed, with the same target rule: no target, +N, -N, an option or a bare target is unknown', () => {
    expect(readLine('pushd ./sub; git commit -m x').dir).toEqual(['./sub'])
    expect(readLine('pushd /abs; git commit -m x').dir).toEqual(['/abs'])
    for (const line of ['pushd sub; git commit -m x', 'pushd; git commit -m x', 'pushd +1; git commit -m x', 'pushd -2; git commit -m x', 'pushd -n ./sub; git commit -m x']) {
      expect(readLine(line).dir).toBeNull()
    }
  })

  test('a cd before the first && or || is followed, and one after it is not', () => {
    expect(readLine('cd ./sub && git commit -m x').dir).toEqual(['./sub'])
    expect(readLine('cd /a; cd ./b || exit 1; git commit -m x').dir).toEqual(['/a', './b'])
    expect(readLine('true && cd ./sub; git commit -m x').dir).toBeNull()
    expect(readLine('echo "a && b"; cd ./sub; git commit -m x').dir).toBeNull()
  })

  test('a push that fails can be retried under its pick, and one that lands uses the pick up', async ($, on) => {
    const b = bench(on)
    const r = repo(b)
    await session($)
    await bash($, b, 'git commit -m "fix: 🐛 X."')
    await pushPick($, b)
    r.pushFails = true
    expect(await bash($, b, 'git push 2>&1 | tail -3')).toBeUndefined()
    r.pushFails = false
    expect(await bash($, b, 'git push')).toBeUndefined()
    expect(await bash($, b, 'git push')).toMatch(DECLINED.push)
  })

  test('a directory the reader cannot follow reads no refs, so a picked push there is refused', async ($, on) => {
    const b = bench(on)
    await session($)
    await pushPick($, b)
    b.runs.length = 0
    expect(await bash($, b, 'git -C "$(git rev-parse --show-toplevel)" push')).toContain('a branch the gate cannot read')
    expect(await bash($, b, 'git push')).toMatch(DECLINED.push)
  })

  test('every caught push line of the corpus is refused with no pick, and every read is let through', async ($, on) => {
    const b = bench(on)
    b.files.set('/repo/script.sh', 'echo hi\n')
    await session($, 'look around')
    for (const [line, expected] of CAUGHT) if (expected.pushes > 0) expect([line, await bash($, b, line)]).not.toEqual([line, undefined])
    for (const line of LET_THROUGH) expect(await bash($, b, line)).toBe(hiddenCommandRefusal(parseShell(line)))
  })
})

describe('AC2: a commit question approves nothing, and its labels never approve a push', () => {
  for (const label of ['Commit it', 'Commit', 'Commit and push', 'Commit it, full message', 'Commit it (Recommended)', 'Yes, commit']) {
    test(`the label ${JSON.stringify(label)} approves no push, and the commits run with no pick`, async ($, on) => {
      const b = bench(on)
      await session($)
      await pick($, b, label, [question('Commit "feat: ✨ Add the gate." on main, and push it?', ['Not yet', label])])
      expect(await bash($, b, 'git push')).toMatch(DECLINED.push)
      expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
      expect(await bash($, b, 'git commit -m "fix: 🐛 Y."')).toBeUndefined()
    })
  }

  test('pickOf reads the pick by the option it chose, and the question it answers', () => {
    const answered = (q: ReturnType<typeof question>, label: string, extra = {}) => pickOf([q], { answers: { [q.question]: label }, ...extra })
    expect(answered(COMMIT_QUESTION, 'Commit it')).toBeUndefined()
    expect(answered(question('Commit and push main to origin?', ['Commit and push', 'Not yet']), 'Commit and push')).toBeUndefined()
    expect(answered(PUSH_QUESTION, 'Push')).toBe('push')
    expect(answered(PUSH_QUESTION, 'Push', { afkTimeoutMs: 1 })).toBeUndefined()
    expect(answered(PUSH_QUESTION, 'Push', { response: 'Push' })).toBeUndefined()
    expect(answered(question('Push main to origin?', ["Don't push", 'Push']), "Don't push")).toBeUndefined()
    expect(answered(question('Which approach?', ['Push', 'Wait']), 'Push')).toBeUndefined()
    expect(answered(MERGE_QUESTION, 'Merge locally')).toBe('merge')
    expect(answered(MERGE_QUESTION, 'Open a PR')).toBeUndefined()
    expect(answered(question('Which approach?', ['Merge', 'Rebase']), 'Merge')).toBeUndefined()
    expect(answered(LANDING_QUESTION, 'I merge locally into main')).toBe('merge')
    const landing = (label: string) => question('How should fix/x land on main?', [label, 'Leave it'])
    expect(answered(landing('Merge locally (Recommended)'), 'Merge locally (Recommended)')).toBe('merge')
    expect(answered(LANDING_QUESTION, 'Open a pull request')).toBeUndefined()
    expect(answered(landing('Leave it'), 'Leave it')).toBeUndefined()
    for (const label of ['Merge it through a PR', "Don't merge yet", 'Skip the merge', 'Cancel the merge', 'Avoid merging', 'Merge locally?', 'Squash and merge on GitHub']) expect([label, answered(landing(label), label)]).toEqual([label, undefined])
    expect(answered(question('How should this land?', ['Merge locally', 'Leave it']), 'Merge locally')).toBe('merge')
    expect(answered({ ...question('Which way for fix/x?', ['Merge locally', 'Leave it']), header: 'Landing' }, 'Merge locally')).toBe('merge')
    expect(answered(question('Which way for fix/x, "land it"?', ['Merge locally', 'Leave it']), 'Merge locally')).toBeUndefined()
    expect(answered(question('Which way for fix/x, `land`?', ['Merge locally', 'Leave it']), 'Merge locally')).toBeUndefined()
    expect(answered(question('Has fix/x landed on main?', ['Merge locally', 'Leave it']), 'Merge locally')).toBeUndefined()
    expect(bundleRefusalOf([OTHER_QUESTION, LANDING_QUESTION])).toBe(BUNDLE_REFUSAL)
    expect(bundleRefusalOf([OTHER_QUESTION, question('Which way for fix/x?', ['Merge locally', 'Leave it'])])).toBeUndefined()
    expect(answered(question('Should fix/x stay as it is?', ['I merge locally into main', 'Leave it']), 'I merge locally into main')).toBeUndefined()
    expect(answered(question('Merge PR 12 into main?', ['Merge PR 12', 'Not yet']), 'Merge PR 12')).toBe('merge')
    expect(pickOf([PUSH_QUESTION], { answers: { other: 'Push' } })).toBeUndefined()
    expect(pickOf([PUSH_QUESTION], undefined)).toBeUndefined()
    expect(pickOf(undefined, { answers: { [PUSH_QUESTION.question]: 'Push' } })).toBeUndefined()
  })
})

describe('AC3: a commit approves no push and no merge, and each gets its own', () => {
  test('a merge into the default branch is refused after a commit or under a push pick, and a merge pick allows one', async ($, on) => {
    const b = bench(on)
    await session($)
    expect(await bash($, b, 'git commit -m "fix: 🐛 W."')).toBeUndefined()
    expect(await bash($, b, 'git merge fix/x')).toMatch(DECLINED.merge)
    expect(await bash($, b, 'gh pr merge 12 --squash')).toMatch(DECLINED.merge)
    await pushPick($, b)
    expect(await bash($, b, 'git pull')).toMatch(DECLINED.merge)
    await pick($, b, 'Merge locally', [MERGE_QUESTION])
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
    expect(await bash($, b, 'git push')).toMatch(DECLINED.push)
    expect(await bash($, b, 'git merge fix/x')).toBeUndefined()
    expect(await bash($, b, 'git merge fix/y')).toMatch(DECLINED.merge)
    expect(MERGE_ASK_REFUSAL).toContain('his choice')
    expect(MERGE_ASK_REFUSAL).toContain('before any push of the branch')
    expect(MERGE_ASK_REFUSAL).toContain('A pull request pick approves no merge.')
  })

  test('a local merge pick on the landing question runs that one merge of the named branch with no second question', async ($, on) => {
    const b = bench(on)
    await session($)
    expect(await bash($, b, 'git merge --no-ff fix/x')).toMatch(DECLINED.merge)
    await pick($, b, 'I merge locally into main', [LANDING_QUESTION])
    expect(await bash($, b, 'git merge --no-ff fix/y')).toMatch(MERGE_TARGET_REFUSAL)
    expect(await bash($, b, 'gh pr merge 12')).toMatch(MERGE_TARGET_REFUSAL)
    expect(await bash($, b, 'git merge --no-ff fix/x')).toBeUndefined()
    expect(await bash($, b, 'git merge --no-ff fix/x')).toMatch(DECLINED.merge)
  })

  test('a local merge pick on a landing question that names no branch approves no merge of any branch', async ($, on) => {
    const b = bench(on)
    await session($)
    await pick($, b, 'Merge locally', [question('How should this land?', ['Merge locally', 'Leave it'])])
    expect(await bash($, b, 'git merge feature-y')).toMatch(MERGE_TARGET_REFUSAL)
  })

  test('a pull request pick on the landing question approves no merge', async ($, on) => {
    const b = bench(on)
    await session($)
    await pick($, b, 'Open a pull request', [LANDING_QUESTION])
    expect(await bash($, b, 'git merge --no-ff fix/x')).toMatch(DECLINED.merge)
    expect(await bash($, b, 'gh pr merge 12')).toMatch(DECLINED.merge)
  })

  for (const line of [
    'gh pr merge 12',
    'gh -R o/r pr merge 12',
    'gh api -X PUT repos/o/r/pulls/12/merge',
    'gh api repos/o/r/merges -f base=main -f head=feat',
    'git -C /repo merge fix/x',
    'git pull',
  ]) {
    test(`a merge with no approval is refused in Mike's session: ${JSON.stringify(line)}`, async ($, on) => {
      const b = bench(on)
      b.repos['/repo'] = { head: 'c1', pushed: 'c1' }
      await session($)
      expect(await bash($, b, line)).toMatch(DECLINED.merge)
    })
  }

  test("a rebase pull into the default branch is refused in Mike's session as a merge and a history rewrite", async ($, on) => {
    const b = bench(on)
    b.repos['/repo'] = { head: 'c1', pushed: 'c1' }
    await session($)
    expect(await bash($, b, 'git pull --rebase')).toMatch(asks('merge into the default branch and history rewrite'))
  })

  for (const line of FED_GH) {
    test(`a gh behind xargs counts as a merge, and is refused in Mike's session: ${JSON.stringify(line)}`, async ($, on) => {
      const b = bench(on)
      b.repos['/repo'] = { head: 'c1', pushed: 'c1' }
      await session($)
      expect(await bash($, b, line)).toBe(PLAIN_REFUSAL.deny)
      expect(mergesOf(line)).toEqual({ local: [], landings: [], pr: 1, targets: [{ refs: [] }] })
    })
  }

  for (const line of [
    "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'",
    "gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {pullRequestId: \"x\"}) { clientMutationId } }'",
  ]) {
    test(`a GraphQL merge, which no ask rule sees, is refused even under a merge approval: ${JSON.stringify(line)}`, async ($, on) => {
      const b = bench(on)
      await session($, 'merge it into main')
      expect(await bash($, b, line)).toBe(PLAIN_REFUSAL.deny)
      expect(mergesOf(line).pr).toBe(1)
    })
  }

  test('a typed merge request approves the merge for its turn, and a commit request approves none', async ($, on) => {
    const b = bench(on)
    await session($, 'go ahead and merge the PR')
    expect(await bash($, b, 'gh pr merge 12 --squash')).toBeUndefined()
    await $.prompt.submit(prompt('commit and push'))
    expect(await bash($, b, 'gh pr merge 12 --squash')).toMatch(DECLINED.merge)
    expect(await bash($, b, 'git merge fix/x')).toMatch(DECLINED.merge)
  })

  test('a local merge or pull on a feature branch, and an aborted merge, need no merge approval', async ($, on) => {
    const b = bench(on)
    b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'fix/x', originHead: 'main', upstream: 'refs/remotes/origin/fix/x' }
    await session($)
    expect(await bash($, b, 'git merge origin/main')).toBeUndefined()
    expect(await bash($, b, 'git merge --no-ff main')).toBeUndefined()
    expect(await bash($, b, 'git pull')).toBeUndefined()
    b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'main', originHead: 'main' }
    expect(await bash($, b, 'git merge --abort')).toBeUndefined()
    expect(await bash($, b, 'git merge fix/x')).toMatch(DECLINED.merge)
    b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'trunk', originHead: 'trunk' }
    expect(await bash($, b, 'git merge fix/x')).toMatch(DECLINED.merge)
  })

  test('with no origin/HEAD, the branch HEAD is on counts as the default, so a trunk merge asks', async ($, on) => {
    const b = bench(on)
    b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'trunk' }
    await session($)
    expect(await bash($, b, 'git merge fix/x')).toMatch(DECLINED.merge)
    expect(await bash($, b, 'git pull')).toMatch(DECLINED.merge)
    b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'trunk', originHead: 'develop' }
    expect(await bash($, b, 'git merge fix/x')).toBeUndefined()
  })

  const LANES: readonly [string, Parameters<typeof bench>[1], boolean, string | undefined][] = [
    ['a sub-agent', {}, true, 'a1'],
    ['an --agent run', { env: { HOME, CLAUDE_CODE_AGENT: 'watson' } }, true, undefined],
    ['a session nobody sits at', {}, false, undefined],
    ['the pipeline', { env: { HOME, WORKBENCH_DEV_TEAM_PIPELINE: '1' } }, true, undefined],
  ]
  for (const [lane, options, isInteractive, agentId] of LANES) {
    test(`${lane}: a git merge or pull on the default branch is refused, and one on a feature branch runs unless a sub-agent's makes a commit`, async ($, on) => {
      const b = bench(on, options)
      b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'main', originHead: 'main' }
      await $.session.start(start(isInteractive))
      await $.prompt.submit(prompt('Item ID: 12', isInteractive ? PERSON : { kind: 'sdk' }))
      expect(await bash($, b, 'git merge fix/x', agentId)).toBe(AGENT_MERGE_REFUSAL)
      expect(await bash($, b, 'git pull', agentId)).toBe(AGENT_MERGE_REFUSAL)
      expect(await bash($, b, "bash -c 'git -C /repo merge fix/x'", agentId)).toBe(agentId !== undefined ? SUBAGENT_REFUSAL.deny : PLAIN_REFUSAL.deny)
      b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'fix/x', originHead: 'main', upstream: 'refs/remotes/origin/fix/x' }
      const committing = agentId === undefined ? undefined : SUBAGENT_REFUSAL.deny
      expect(await bash($, b, 'git merge origin/main', agentId)).toBe(committing)
      expect(await bash($, b, 'git merge --no-ff main', agentId)).toBe(committing)
      expect(await bash($, b, 'git pull', agentId)).toBe(committing)
      expect(await bash($, b, 'git merge --ff-only origin/main', agentId)).toBeUndefined()
      expect(await bash($, b, 'git pull --ff-only', agentId)).toBeUndefined()
    })
  }

  test('a scheduled turn in Mike\'s session does not merge into the default branch', async ($, on) => {
    const b = bench(on)
    b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'main', originHead: 'main' }
    await $.session.start(start())
    await $.prompt.submit(prompt('run the tick', { kind: 'scheduled-trigger' }))
    expect(await bash($, b, 'git merge fix/x')).toBe(AGENT_MERGE_REFUSAL)
  })

  test('a merge pick approves only the pull request or branch its question named', async ($, on) => {
    const b = bench(on)
    await session($)
    const named = question('Merge pull request #12 (fix/x) into main?', ['Merge it', 'Open a PR'])
    await pick($, b, 'Merge it', [named])
    expect(await bash($, b, 'gh pr merge 99')).toBe(MERGE_TARGET_REFUSAL)
    expect(await bash($, b, 'gh pr merge')).toBe(MERGE_TARGET_REFUSAL)
    expect(await bash($, b, 'git merge fix/y')).toBe(MERGE_TARGET_REFUSAL)
    expect(await bash($, b, 'gh pr merge 12 --squash')).toBeUndefined()
    await pick($, b, 'Merge it', [named])
    expect(await bash($, b, 'git merge origin/fix/x')).toBeUndefined()
    await pick($, b, 'Merge it', [named])
    expect(await bash($, b, 'gh api -X PUT repos/o/r/pulls/12/merge')).toBeUndefined()
    await pick($, b, 'Merge it', [named])
    expect(await bash($, b, 'gh api repos/o/r/merges -f base=main -f head=fix/x')).toBeUndefined()
    await pick($, b, 'Merge it', [named])
    expect(await bash($, b, 'gh api repos/o/r/merges -f base=main -f head=feat')).toBe(MERGE_TARGET_REFUSAL)
  })

  test('a git merge behind xargs takes refs from its input, so a pick that names its branch does not match it', async ($, on) => {
    const line = 'echo main | xargs git merge feature'
    const b = bench(on)
    await session($)
    expect(mergesOf(line).targets).toEqual([{ refs: [] }])
    await pick($, b, 'Merge it', [question('Merge branch feature into main?', ['Merge it', 'Open a PR'])])
    expect(await bash($, b, line)).toBe(MERGE_TARGET_REFUSAL)
    expect(await bash($, b, 'git merge feature')).toBeUndefined()
  })

  test('two merges on one line are refused under one merge pick', async ($, on) => {
    const b = bench(on)
    await session($)
    await pick($, b, 'Merge it', [question('Merge PR 1 and PR 2 into main?', ['Merge it', 'Open a PR'])])
    expect(await bash($, b, 'gh pr merge 1; gh pr merge 2')).toBe(ONE_REFUSAL)
    expect(await bash($, b, 'gh pr merge 1')).toBeUndefined()
  })

  test('the merge reader finds each merge and where it runs, and a doubt reads as the default branch', () => {
    expect(mergesOf('git merge x')).toEqual({ local: [''], landings: [{ dir: '', refs: ['x'] }], pr: 0, targets: [{ refs: ['x'] }] })
    expect(mergesOf('git -C /a pull')).toEqual({ local: ['/a'], landings: [{ dir: '/a', refs: [], upstream: true }], pr: 0, targets: [{ refs: [] }] })
    expect(mergesOf('git pull origin main')).toEqual({ local: [''], landings: [{ dir: '', refs: ['main'] }], pr: 0, targets: [{ refs: ['main'] }] })
    expect(mergesOf('git merge -m "Merge it." --no-ff fix/x')).toEqual({ local: [''], landings: [{ dir: '', refs: ['fix/x'] }], pr: 0, targets: [{ refs: ['fix/x'] }] })
    expect(mergesOf('cd /a && git merge x').local).toEqual([null])
    expect(mergesOf('git -C rel merge x').local).toEqual([null])
    expect(mergesOf('GIT_DIR=/x/.git git merge y').local).toEqual([null])
    expect(mergesOf("bash -c 'git merge x'").local).toEqual([''])
    expect(mergesOf('git merge --abort; git log --merges')).toEqual({ local: [], landings: [], pr: 0, targets: [] })
    expect(mergesOf('gh pr merge 1; gh pr view 1')).toEqual({ local: [], landings: [], pr: 1, targets: [{ pr: '1', refs: [] }] })
    expect(mergesOf('gh pr merge --squash -b "Done." 12')).toEqual({ local: [], landings: [], pr: 1, targets: [{ pr: '12', refs: [] }] })
    expect(mergesOf('gh pr merge https://github.com/o/r/pull/7')).toEqual({ local: [], landings: [], pr: 1, targets: [{ pr: '7', refs: [] }] })
    expect(mergesOf('gh pr merge fix/x')).toEqual({ local: [], landings: [], pr: 1, targets: [{ refs: ['fix/x'] }] })
    expect(mergesOf('gh api repos/o/r/pulls/1/merge -X PUT')).toEqual({ local: [], landings: [], pr: 1, targets: [{ pr: '1', refs: [] }] })
    expect(mergesOf('gh api repos/o/r/merges -f base=main -f head=feat')).toEqual({ local: [], landings: [], pr: 1, targets: [{ refs: ['feat'], bases: ['main'] }] })
    expect(mergesOf('grep -n "git merge" notes.md')).toEqual({ local: [], landings: [], pr: 0, targets: [] })
    expect(isDefaultBranch('refs/heads/main', undefined)).toBe(true)
    expect(isDefaultBranch('refs/heads/fix/x', undefined)).toBe(true)
    expect(isDefaultBranch('refs/heads/fix/x', 'refs/remotes/origin/main')).toBe(false)
    expect(isDefaultBranch('refs/heads/trunk', 'refs/remotes/origin/trunk')).toBe(true)
    expect(isDefaultBranch('refs/heads/main', 'refs/remotes/origin/trunk')).toBe(false)
    expect(isDefaultBranch(undefined, undefined)).toBe(true)
  })
})

describe('AC4: a commit question is no approval question, so it is never refused as a bundle', () => {
  test('a commit option beside another question reaches Mike, and the commit runs with no pick', async ($, on) => {
    const b = bench(on)
    b.pick = 'Commit it'
    await session($)
    expect((await $.tool.call(ask([OTHER_QUESTION, COMMIT_QUESTION]))).deny).toBeUndefined()
    expect(b.calls.some(call => call.tool === 'AskUserQuestion')).toBe(true)
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
  })

  for (const text of [
    'Commit all 27 staged files on fix/persistence-calls-chain-root, merge into main locally, and push main?',
    'Commit it and push to origin?',
    'Commit the version bump and release 0.51.0?',
    'Commit, then merge?',
  ]) {
    test(`a commit question whose own text names a push, a merge or a release is let through, and approves none of them: ${JSON.stringify(text)}`, async ($, on) => {
      const b = bench(on)
      b.pick = 'Commit it'
      await session($)
      expect((await $.tool.call(ask([question(text, ['Not yet', 'Commit it'])]))).deny).toBeUndefined()
      expect(await bash($, b, 'git push')).toMatch(DECLINED.push)
      expect(await bash($, b, 'git merge fix/x')).toMatch(DECLINED.merge)
    })
  }

  test('the push and merge questions are asked alone, and questions with no approval option are let through', async ($, on) => {
    const b = bench(on)
    b.pick = 'A'
    await session($)
    for (const questions of [[COMMIT_QUESTION], [PUSH_QUESTION], [MERGE_QUESTION], [OTHER_QUESTION, question('Which file?', ['x', 'y'])]]) {
      expect((await $.tool.call(ask(questions))).deny).toBeUndefined()
    }
    expect((await $.tool.call(ask([OTHER_QUESTION, PUSH_QUESTION]))).deny).toBe(BUNDLE_REFUSAL)
    expect((await $.tool.call(ask([OTHER_QUESTION, MERGE_QUESTION]))).deny).toBe(BUNDLE_REFUSAL)
    expect(BUNDLE_REFUSAL).toContain('alone')
    expect(BUNDLE_REFUSAL).not.toContain('commit')
  })

  test('a label that leads with commit, or that approves a commit, is no approval option', () => {
    expect(bundleRefusalOf([OTHER_QUESTION, question('Next?', ['Commit and push', 'Wait'])])).toBeUndefined()
    expect(bundleRefusalOf([OTHER_QUESTION, question('Next?', ['Yes, commit', 'Wait'])])).toBeUndefined()
    expect(bundleRefusalOf([OTHER_QUESTION, question('Commit it and push to origin?', ['Not yet', 'Commit it'])])).toBeUndefined()
    expect(bundleRefusalOf([OTHER_QUESTION, question('Push main to origin?', ['Push', 'Wait'])])).toBe(BUNDLE_REFUSAL)
    expect(bundleRefusalOf([COMMIT_QUESTION])).toBeUndefined()
    expect(bundleRefusalOf('not a list')).toBeUndefined()
  })
})

describe('AC5: a push pick is tied to the repository and branch HEAD held when Mike picked', () => {
  test('a commit runs on any branch, with no pick to bind', async ($, on) => {
    const b = bench(on)
    b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'fix/x' }
    await session($)
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
    b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'main' }
    expect(await bash($, b, 'git commit -m "fix: 🐛 Y."')).toBeUndefined()
    b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: null }
    expect(await bash($, b, 'git commit -m "fix: 🐛 Z."')).toBeUndefined()
  })

  test('a push on another branch than the one picked is refused', async ($, on) => {
    const b = bench(on)
    b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'fix/x' }
    await session($)
    await pushPick($, b)
    b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'main' }
    expect(await bash($, b, 'git push')).toMatch(/^This git push was refused: Mike picked it while HEAD was on fix\/x, and HEAD is now on main\./)
  })

  for (const line of ['git switch -c other', 'git switch main', 'git stash', 'git stash push -m wip', 'git reset -q', 'git -c core.pager=cat reset']) {
    test(`a checkout, switch, stash or reset between a push pick and its push is refused: ${JSON.stringify(line)}`, async ($, on) => {
      const b = bench(on)
      await session($)
      await pushPick($, b)
      expect(await bash($, b, line)).toBe(MOVE_REFUSAL)
      expect(await bash($, b, 'git push')).toBeUndefined()
      expect(await bash($, b, line)).toBeUndefined()
    })
  }

  test('a switch is refused under an unused push pick, and not under a commit question, a merge pick or no pick', async ($, on) => {
    const b = bench(on)
    await session($)
    expect(await bash($, b, 'git switch main')).toBeUndefined()
    await pick($, b)
    expect(await bash($, b, 'git switch main')).toBeUndefined()
    await pushPick($, b)
    expect(await bash($, b, 'git switch main')).toBe(MOVE_REFUSAL)
    expect(await bash($, b, 'git stash list')).toBeUndefined()
    await pick($, b, 'Merge locally', [MERGE_QUESTION])
    expect(await bash($, b, 'git switch main')).toBeUndefined()
    expect(MOVE_REFUSAL).not.toContain('commit')
  })

  test('the readers behind the binding', () => {
    expect(headsOf('worktree /repo\nHEAD c1\nbranch refs/heads/main\n\nworktree /wt\nHEAD w1\ndetached\n')).toEqual([
      { top: '/repo', ref: 'refs/heads/main' },
      { top: '/wt', ref: 'detached at w1' },
    ])
    expect(headsOf('')).toEqual([])
    const pick = { action: 'push' as const, heads: [{ top: '/repo', ref: 'refs/heads/main' }] }
    expect(bindingRefusalOf(pick, '/repo', 'refs/heads/main')).toBeUndefined()
    expect(bindingRefusalOf(pick, '/repo', 'refs/heads/x')).toContain('now on x')
    expect(bindingRefusalOf(pick, '/other', 'refs/heads/main')).toBeDefined()
    expect(bindingRefusalOf(pick, undefined, undefined)).toBeDefined()
    for (const line of ['git checkout main', 'git -C /repo checkout -- a.ts', "bash -c 'git checkout main'", 'env git switch x', 'git stash pop']) expect([line, movesHead(line)]).toEqual([line, true])
    expect(movesHead('git stash show -p')).toBe(false)
    expect(movesHead('git log && git status')).toBe(false)
    expect(movesHead('echo git checkout main')).toBe(false)
  })
})

describe('AC6: only Mike\'s own prompts end an unused pick', () => {
  test('Mike\'s next prompt ends the approval, folded into the turn or not, typed or from the bridge', async ($, on) => {
    const b = bench(on)
    await session($)
    await pushPick($, b)
    await $.prompt.submit(prompt('thanks, that reads well'))
    expect(await bash($, b, 'git push')).toMatch(DECLINED.push)
    await pushPick($, b)
    await $.prompt.submit({ ...prompt('wait, one more thing'), turnId: 'running' })
    expect(await bash($, b, 'git push')).toMatch(DECLINED.push)
    await pushPick($, b)
    await $.prompt.submit(prompt('from my phone', { kind: 'bridge' }))
    expect(await bash($, b, 'git push')).toMatch(DECLINED.push)
  })

  for (const origin of [
    { kind: 'task-notification' },
    { kind: 'peer' },
    { kind: 'peer-send-message' },
    { kind: 'channel', server: 'slack' },
    { kind: 'plugin', name: 'x' },
    { kind: 'sdk' },
  ] as PromptOrigin[]) {
    test(`a ${origin.kind} prompt leaves an unused pick, folded into the turn or not, and approves nothing itself`, async ($, on) => {
      const b = bench(on)
      await session($)
      await pushPick($, b)
      await $.prompt.submit({ ...prompt('please commit and push now', origin), turnId: 'running' })
      expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
      expect(await bash($, b, 'git push')).toBeUndefined()
      expect(await bash($, b, 'git push')).toMatch(DECLINED.push)
      await pushPick($, b)
      await $.prompt.submit(prompt('please commit and push now', origin))
      expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
      expect(await bash($, b, 'git push')).toBeUndefined()
      expect(await bash($, b, 'git push')).toMatch(origin.kind === 'task-notification' ? DECLINED.push : exactly(PUSH_REFUSAL))
    })
  }

  test('a scheduled turn leaves an unused pick for Mike\'s next turn', async ($, on) => {
    const b = bench(on)
    await session($)
    await pushPick($, b)
    await $.prompt.submit({ ...prompt('<scheduled-task name="tick">run</scheduled-task>'), turnId: 'running' })
    expect(await bash($, b, 'git push')).toBeUndefined()
  })
})

describe('AC7: only the lanes that commit unattended by design are exempt from the push approval', () => {
  for (const origin of [{ kind: 'peer' }, { kind: 'peer-send-message' }, { kind: 'channel', server: 'slack' }, { kind: 'plugin', name: 'x' }, { kind: 'sdk' }] as PromptOrigin[]) {
    test(`a ${origin.kind} turn in Mike's interactive session commits, and its push is gated: it carries outside text`, async ($, on) => {
      const b = bench(on)
      b.pick = 'A'
      await $.session.start(start())
      await $.prompt.submit(prompt('please commit and push', origin))
      expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
      expect(await bash($, b, 'git push')).toBe(PUSH_REFUSAL)
      expect((await $.tool.call(ask([OTHER_QUESTION, PUSH_QUESTION]))).deny).toBe(BUNDLE_REFUSAL)
    })
  }

  test('a sub-agent\'s commit and push meet the commit guard, and its bundled question is let through', async ($, on) => {
    const b = bench(on)
    b.pick = 'A'
    await session($, 'delegate it')
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."', 'a1')).toBe(SUBAGENT_REFUSAL.deny)
    expect(await bash($, b, 'git push', 'a1')).toBe(SUBAGENT_REFUSAL.deny)
    expect((await $.tool.call(ask([OTHER_QUESTION, PUSH_QUESTION], 'a1'))).deny).toBeUndefined()
  })

  test('a sub-agent\'s "Push" pick approves nothing for the main loop', async ($, on) => {
    const b = bench(on)
    b.pick = 'Push'
    await session($, 'delegate it')
    await $.tool.call(ask([PUSH_QUESTION], 'a1'))
    expect(await bash($, b, 'git push')).toMatch(DECLINED.push)
  })

  test('a claude -p or SDK session commits', async ($, on) => {
    const b = bench(on)
    await $.session.start(start(false))
    await $.prompt.submit(prompt('commit the fix', { kind: 'sdk' }))
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
    expect(await bash($, b, 'git push')).toBeUndefined()
  })

  test('the Index pipeline commits, by its session and by its own flag', async ($, on) => {
    const b = bench(on, { env: { HOME, WORKBENCH_DEV_TEAM_PIPELINE: '1' } })
    await $.session.start(start())
    await $.prompt.submit(prompt('Item ID: 12'))
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
    expect(await bash($, b, 'git push origin feature/12')).toBeUndefined()
  })

  test('a top-level --agent run commits', async ($, on) => {
    const b = bench(on, { env: { HOME, CLAUDE_CODE_AGENT: 'watson' } })
    await $.session.start(start())
    await $.prompt.submit(prompt('Item ID: 12'))
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
  })

  test('a scheduled tick commits, by origin or by wrapper, and the next typed turn is gated again', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    await $.prompt.submit(prompt('run the tick', { kind: 'scheduled-trigger' }))
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
    await $.prompt.submit(prompt('<scheduled-task name="tick">run</scheduled-task>'))
    expect(await bash($, b, 'git push')).toBeUndefined()
    await $.prompt.submit(prompt('back at the desk'))
    expect(await bash($, b, 'git push')).toMatch(DECLINED.push)
  })

  test('while the lane is unknown, the guard reads a sub-agent and the question check takes the gate\'s side', async ($, on) => {
    const b = bench(on)
    b.pick = 'Push'
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBe(SUBAGENT_REFUSAL.deny)
    expect((await $.tool.call(ask([OTHER_QUESTION, PUSH_QUESTION]))).deny).toBe(BUNDLE_REFUSAL)
  })
})

describe('the shell reader, against the hostile-input corpus', () => {
  for (const [line, expected] of CAUGHT) {
    test(`caught: ${JSON.stringify(line)}`, () => {
      expect(writesOf(line)).toEqual(expected)
    })
  }

  for (const line of LET_THROUGH) {
    test(`let through: ${JSON.stringify(line)}`, () => {
      expect(writesOf(line)).toEqual({ commits: 0, pushes: 0 })
    })
  }

  test('a quoted word stays one word, separators split commands, and a substitution keeps its outer word', () => {
    expect(commandsOf('echo "git push"; git status')).toEqual([['echo', 'git push'], ['git', 'status']])
    expect(commandsOf("a 'b c' d\\ e")).toEqual([['a', 'b c', 'd e']])
    expect(commandsOf('a | b && c\nd')).toEqual([['a'], ['b'], ['c'], ['d']])
    expect(commandsOf('git \\\n  push')).toEqual([['git', 'push']])
    expect(commandsOf('git -C $(pwd) push')).toEqual([['pwd'], ['git', '-C', '$_', 'push']])
    expect(commandsOf('2>/dev/null git push >out')).toEqual([['git', 'push']])
  })
})

describe('a local merge or pull that lands a ledger unit branch on a feature branch runs with no question', () => {
  const FEATURE = { head: 'c1', pushed: 'c1', branch: 'fix/x', originHead: 'main', upstream: 'refs/remotes/origin/fix/x', remote: 'origin' }
  const LEDGER = `${HOME}/.claude-workbench/provisioning/ledger.json`
  const UNIT = { project: '/repo', session: 's0', createdAt: 1, unit: 'unit-a', worktree: null, branch: 'unit/a', database: 'wt_repo_unit_a_testing', connection: '', isDatabaseCreated: false }
  const LEDGER_TEXT = JSON.stringify({ version: 1, entries: [UNIT, { ...UNIT, unit: 'unit-b', branch: 'unit/b' }, { ...UNIT, project: '/other', unit: 'unit-c', branch: 'unit/c' }] })
  const withLedger = (on: Parameters<typeof bench>[0], text = LEDGER_TEXT): Bench => {
    const b = bench(on, { env: { HOME }, files: { [LEDGER]: text } })
    b.repos['/repo'] = { ...FEATURE }
    return b
  }

  test('the reader skips every value an option takes and reads the merged refs, in any option form', () => {
    const refsOf = (line: string) => mergesOf(line).landings.map(({ refs }) => refs)
    for (const line of [
      'git merge --no-ff unit/a',
      'git merge -nm --squash unit/a',
      'git merge --squash --no-squ unit/a',
      'git merge --message --ff-only unit/a',
      'git merge --mess --ff-only unit/a',
      'git merge --message=--ff-only unit/a',
      'git merge -m--ff-only unit/a',
      'git merge -s ours -X theirs -F msg unit/a',
      'git merge -S --into-name x unit/a',
      'git pull --no-ff . unit/a',
      'git pull -j 4 -o opt --depth 1 ../tree unit/a:x',
      'git pull file:///tmp/r +unit/a',
      'git remote add r /tmp/r; git pull r unit/a',
      'git pull origin unit/a',
      'git pull --rebase upstream unit/a',
      'git pull git@github.com:o/r.git unit/a',
      'git pull https://github.com/o/r unit/a',
      'git remote add self .; git pull self unit/a',
      'git pull --refmap x . unit/a',
      'git pull --refm x . unit/a',
      'git pull --filter blob:none --negotiation-restrict main --negotiation-include main --negotiation-tip main origin unit/a',
      'git pull --qui origin unit/a',
      'git pull --qu origin unit/a',
    ]) {
      expect([line, refsOf(line)]).toEqual([line, [['unit/a']]])
    }
    expect(refsOf('git merge -m "Merge it."')).toEqual([[]])
    expect(mergesOf('git merge -m "Merge it."').landings).toEqual([{ dir: '', refs: [], upstream: true }])
    for (const line of ['git pull origin', 'git pull --refmap x origin']) {
      expect([line, mergesOf(line).landings]).toEqual([line, [{ dir: '', refs: [], upstream: true, source: 'origin' }]])
    }
    expect(mergesOf('git pull --ff-only /tmp/unit-tree').landings).toEqual([{ dir: '', refs: [], upstream: true, source: '/tmp/unit-tree', commitless: true }])
    expect(mergesOf('git pull file:///tmp/r').landings).toEqual([{ dir: '', refs: [], upstream: true, source: 'file:///tmp/r' }])
    expect(mergesOf('git pull file:///tmp/r unit/a:x').local).toEqual([null])
    expect(mergesOf('git pull --ff-only').landings).toEqual([{ dir: '', refs: [], upstream: true, commitless: true }])
    expect(refsOf('git pull origin main')).toEqual([['main']])
    expect(refsOf('git merge aaaaaaaa0123456789abcdef0123456789abcdef0123456789abcdefbbbbbbbbc')).toEqual([['aaaaaaaa0123456789abcdef0123456789abcdef0123456789abcdefbbbbbbbbc']])
    for (const line of ['git merge --abo', 'git merge --quit']) {
      expect([line, refsOf(line)]).toEqual([line, []])
    }
  })

  test('the reader marks a merge or pull as commitless only by its last --ff-only, --no-commit or --squash, read as exact words', () => {
    const isCommitless = (line: string) => mergesOf(line).landings.map(landing => landing.commitless === true)
    for (const line of [
      'git merge --ff-only origin/main',
      'git merge --squash main',
      'git merge --no-commit main',
      'git merge --no-ff --ff-only main',
      'git merge --commit --no-commit main',
      'git merge -m "Merge it." --ff-only main',
      'git merge --comm --no-commit main',
      'git merge --no-squ --squash main',
      'git pull --ff-only',
      'git pull --ff-only origin main',
      'git pull --squash origin main',
      'git pull --no-rebase --ff-only',
    ]) {
      expect([line, isCommitless(line)]).toEqual([line, [true]])
    }
    for (const line of [
      'git merge origin/main',
      'git merge --no-ff origin/main',
      'git merge main',
      'git merge --ff-only --no-ff main',
      'git merge --ff-only --ff main',
      'git merge --no-commit --commit main',
      'git merge --squash --no-squash main',
      'git merge --ff-o main',
      'git merge --no-commit --comm main',
      'git merge --squash --no-squ main',
      'git merge --no-commit --no-squ main',
      'git merge --ff-only --no-f main',
      'git merge --ff-only --f main',
      'git merge -m --ff-only main',
      'git merge --continue',
      'git -c alias.m=merge m --ff-only main',
      'git pull',
      'git pull origin main',
      'git pull --no-ff',
      'git pull --ff-only --rebase',
      'git pull --rebase=merges --ff-only',
      'git pull -r --ff-only',
      'git pull -qr --ff-only',
    ]) {
      expect([line, isCommitless(line)]).toEqual([line, [false]])
    }
  })

  test('a ref, option or source the reader cannot read is a landing it cannot read', () => {
    for (const line of [
      'git merge "$B"',
      'git merge -',
      'git merge @{-1}',
      'git merge 1a2b3c4',
      'git merge a1b2c3',
      'git merge a1b2',
      'git merge aaaaaaaa0123456789abcdef0123456789abcdef0123456789abcdefbbbbbbbb',
      'git merge FETCH_HEAD',
      'git merge fetch_head',
      'git merge Orig_Head',
      'git pull unitdir HEAD',
      'git pull origin :x',
      'git merge unit/a^{commit}',
      'git merge --continue',
      'git merge --cont',
      'git merge -m x -- --ff-only',
      'git -c alias.m=merge m unit/a',
      'git -c alias.m=merge m',
      'git pull . "$B"',
      'echo main | xargs git merge feature',
      'echo unit/a | xargs git merge',
      'echo unit/a | xargs git pull origin',
    ]) {
      expect([line, mergesOf(line).landings.map(({ refs }) => refs)]).toEqual([line, [null]])
    }
  })

  for (const line of [
    'git merge --no-ff unit/a',
    'git merge --ff-only unit/a',
    'git merge -nm --squash unit/a',
    'git merge --squash --no-squ unit/a',
    'git merge --no-commit origin/unit/b',
    'git merge unit/a~1',
    'git -C /repo merge --no-ff Unit/A',
    'git pull --no-ff . unit/a',
    'git pull origin unit/a',
    'git pull --qui origin unit/a',
    'git pull --qu origin unit/a',
    'git remote add self .; git pull self unit/a',
    'git pull --refmap x . unit/a',
    'git pull unitdir HEAD',
    'git merge a1b2c3',
    'git merge fetch_head',
    'echo unit/a | xargs git merge feat/y',
  ]) {
    test(`with no approval, a unit landing on a feature branch runs with no question: ${JSON.stringify(line)}`, async ($, on) => {
      const b = withLedger(on)
      await session($)
      expect(await bash($, b, line)).toBeUndefined()
    })
  }

  test('a pull behind xargs, whose rebase config the gate cannot read, asks only as a history rewrite', async ($, on) => {
    const line = 'echo unit/a | xargs git pull origin main'
    const b = withLedger(on)
    await session($)
    expect(pullRebasesOf(line)).toEqual([{ dir: '', rebase: 'unread' }])
    const refusal = await bash($, b, line)
    expect(refusal).toMatch(DECLINED.rewrite)
    expect(refusal).not.toContain('git commit')
  })

  for (const line of ['git merge origin/main', 'git merge --no-ff main', 'git merge --no-ff unit/c', 'git merge -m "unit/a" feat/y', 'git pull', 'git pull origin', 'git pull origin main', 'git pull --no-ff . feat/y', 'git merge --abort']) {
    test(`a catch-up merge or pull of a branch that is no unit runs with no question: ${JSON.stringify(line)}`, async ($, on) => {
      const b = withLedger(on)
      await session($)
      expect(await bash($, b, line)).toBeUndefined()
    })
  }

  test('a merge or pull that names no branch runs on a feature branch, whatever its upstream', async ($, on) => {
    const b = withLedger(on)
    await session($)
    for (const upstream of ['refs/heads/unit/a', 'refs/remotes/origin/unit/a', 'refs/heads/feat/y', 'refs/remotes/origin/feat-x']) {
      b.repos['/repo'] = { ...FEATURE, upstream }
      for (const line of ['git pull', 'git pull origin', 'git merge']) expect([upstream, line, await bash($, b, line)]).toEqual([upstream, line, undefined])
    }
    b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'fix/x', originHead: 'main' }
    for (const line of ['git pull', 'git merge']) expect([line, await bash($, b, line)]).toEqual([line, undefined])
  })

  for (const line of ['git pull /tmp/unit-tree', 'git pull file:///tmp/r', 'git pull ../unit-tree', 'git pull upstream', 'git pull .', 'git pull "$S"']) {
    test(`a pull that names a source other than the branch's remote runs on a feature branch: ${JSON.stringify(line)}`, async ($, on) => {
      const b = withLedger(on)
      await session($)
      expect(await bash($, b, line)).toBeUndefined()
    })
  }

  for (const [line, fixture] of [
    ['git pull --rebase /tmp/unit-tree', {}],
    ['git pull --rebase origin unit/a', {}],
    ['git pull -r origin unit/a', {}],
    ['git pull origin unit/a', { pullRebase: 'true' }],
    ['git pull origin unit/a', { branchRebase: 'merges' }],
    ['git pull origin unit/a', { pullRebase: null }],
    ['git -c pull.rebase=true pull origin unit/a', {}],
  ] as const) {
    test(`a unit-landing pull that would rebase asks only the rewrite, in one pick: ${JSON.stringify([line, fixture])}`, async ($, on) => {
      const b = withLedger(on)
      b.repos['/repo'] = { ...FEATURE, ...fixture }
      await session($)
      const refusal = await bash($, b, line)
      expect(refusal).toMatch(DECLINED.rewrite)
      expect(refusal).not.toContain('two picks')
    })
  }

  const A = 'git pull --rebase origin unit/a'
  const runIt = (line: string) => [question(`Run \`${line}\` in /repo, on fix/x?`, ['Run it', 'Not now'])]

  test('a unit-landing rebase pull runs after a pick of its line alone, once', async ($, on) => {
    const b = withLedger(on)
    await session($)
    expect(await bash($, b, A)).toMatch(DECLINED.rewrite)
    await pick($, b, 'Run it', runIt(A))
    expect(await bash($, b, 'git pull --rebase origin unit/b')).toMatch(DECLINED.rewrite)
    expect(await bash($, b, A)).toBeUndefined()
    expect(await bash($, b, A)).toMatch(DECLINED.rewrite)
  })

  test('a commit question or a typed commit request does not let a unit-landing rebase pull run', async ($, on) => {
    const b = withLedger(on)
    await session($, 'commit it')
    await pick($, b)
    expect(await bash($, b, A)).toMatch(DECLINED.rewrite)
    expect(await bash($, b, 'git pull origin unit/a')).toBeUndefined()
  })

  test("Mike's next prompt ends a pick of the rebase pull's line", async ($, on) => {
    const b = withLedger(on)
    await session($)
    expect(await bash($, b, A)).toMatch(DECLINED.rewrite)
    await pick($, b, 'Run it', runIt(A))
    await $.prompt.submit(prompt('and then?'))
    expect(await bash($, b, A)).toMatch(DECLINED.rewrite)
  })

  test("a pull that names the branch's own remote runs on a feature branch, and one whose branch cannot be read asks as a merge", async ($, on) => {
    const b = withLedger(on)
    await session($)
    expect(await bash($, b, 'git pull origin')).toBeUndefined()
    b.repos['/repo'] = { ...FEATURE, upstream: 'refs/heads/feat/y', remote: '.' }
    expect(await bash($, b, 'git pull .')).toBeUndefined()
    b.repos['/repo'] = { ...FEATURE, upstream: 'refs/heads/unit/a', remote: '.' }
    expect(await bash($, b, 'git pull .')).toBeUndefined()
    b.repos['/repo'] = { ...FEATURE, remote: undefined }
    expect(await bash($, b, 'git pull origin')).toBeUndefined()
    expect(await bash($, b, 'git pull')).toBeUndefined()
    b.repos['/repo'] = { ...FEATURE, branch: null }
    expect(await bash($, b, 'git pull origin')).toMatch(DECLINED.merge)
  })

  for (const line of ['git merge "$B"', 'git merge 1a2b3c4', 'git merge --continue', 'git -c alias.m=merge m feat/y', 'git pull /tmp/tree HEAD', 'git merge a1b2c3', 'git merge fetch_head', 'git merge aaaaaaaa0123456789abcdef0123456789abcdef0123456789abcdefbbbbbbbb']) {
    test(`a merge whose merged refs cannot be read runs on a feature branch: ${JSON.stringify(line)}`, async ($, on) => {
      const b = withLedger(on)
      await session($)
      expect(await bash($, b, line)).toBeUndefined()
    })
  }

  for (const [name, text] of [
    ['a ledger that is not JSON', '{'],
    ['a ledger of another shape', '{"version":2,"entries":[]}'],
  ] as const) {
    test(`with ${name}, every merge or pull on a feature branch runs`, async ($, on) => {
      const b = withLedger(on, text)
      await session($)
      expect(await bash($, b, 'git merge origin/main')).toBeUndefined()
      expect(await bash($, b, 'git pull')).toBeUndefined()
      expect(await bash($, b, 'git pull origin main')).toBeUndefined()
    })

    test(`with ${name}, a sub-agent's merge that makes no commit is refused as a commit`, async ($, on) => {
      const b = withLedger(on, text)
      await $.session.start(start())
      await $.prompt.submit(prompt('delegate it'))
      expect(await bash($, b, 'git merge --ff-only origin/main', 'a1')).toBe(SUBAGENT_REFUSAL.deny)
    })
  }

  test('with no HOME to find the ledger, a merge on a feature branch runs', async ($, on) => {
    const b = bench(on, { env: {} })
    b.repos['/repo'] = { ...FEATURE }
    await session($)
    expect(await bash($, b, 'git merge origin/main')).toBeUndefined()
    expect(await bash($, b, 'git pull')).toBeUndefined()
  })

  test('with no ledger file, nothing is a unit branch, so a merge runs', async ($, on) => {
    const b = bench(on)
    b.repos['/repo'] = { ...FEATURE }
    await session($)
    expect(await bash($, b, 'git merge --no-ff unit/a')).toBeUndefined()
  })

  test('landings run one after another with no pick, beside commits, and a push request changes nothing', async ($, on) => {
    const b = withLedger(on)
    await session($)
    expect(await bash($, b, 'git merge --no-ff unit/a')).toBeUndefined()
    expect(await bash($, b, 'git merge --no-ff unit/b')).toBeUndefined()
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
    expect(await bash($, b, 'git -C /repo pull . unit/b')).toBeUndefined()
    await $.prompt.submit(prompt('push it'))
    expect(await bash($, b, 'git merge --no-ff unit/a')).toBeUndefined()
  })

  test('a landing runs on any feature branch, whatever branch HEAD held at an earlier pick', async ($, on) => {
    const b = withLedger(on)
    await session($)
    await pick($, b)
    b.repos['/repo'] = { ...FEATURE, branch: 'feat/y' }
    expect(await bash($, b, 'git -C /repo merge --no-ff unit/a')).toBeUndefined()
  })

  test('two landings, or a landing and a commit, on one line run on a feature branch', async ($, on) => {
    const b = withLedger(on)
    await session($)
    expect(await bash($, b, 'git merge --no-ff unit/a && git commit -m "fix: 🐛 X."')).toBeUndefined()
    expect(await bash($, b, 'git merge --no-ff unit/a; git pull . unit/b')).toBeUndefined()
  })

  test('on the default branch a landing stays a merge: a commit request approves none, and a merge pick does', async ($, on) => {
    const b = withLedger(on)
    b.repos['/repo'] = { ...FEATURE, branch: 'main' }
    await session($, 'commit it')
    expect(await bash($, b, 'git merge --no-ff unit/a')).toMatch(DECLINED.merge)
    await $.prompt.submit(prompt('my review is done'))
    await pick($, b, 'Merge locally', [question('How should unit/a land on main: merge it locally, or open a pull request?', ['Open a PR', 'Merge locally', 'Leave it'])])
    expect(await bash($, b, 'git merge --no-ff unit/a')).toBeUndefined()
  })

  for (const hasLedger of [false, true]) {
    test(`on the default branch, a commit beside a merge asks the merge, ${hasLedger ? 'with' : 'with no'} unit branch in the ledger`, async ($, on) => {
      const b = hasLedger ? withLedger(on) : bench(on, { env: { HOME } })
      b.repos['/repo'] = { ...FEATURE, branch: 'main' }
      await session($)
      for (const line of ['git commit -m "fix: 🐛 X." && git merge fix/x', 'git commit -m "fix: 🐛 X." && git merge unit/a']) {
        expect([line, DECLINED.merge.test((await bash($, b, line)) ?? '')]).toEqual([line, true])
      }
    })
  }

  test('a landing whose branch the gate cannot read is a merge into the default branch', async ($, on) => {
    const b = withLedger(on)
    await session($, 'commit it')
    expect(await bash($, b, 'cd /repo && git merge --no-ff unit/a')).toMatch(DECLINED.merge)
    expect(await bash($, b, 'git -C rel merge --no-ff unit/a')).toMatch(DECLINED.merge)
  })

  test('a sub-agent is refused a landing as a commit, whatever its options', async ($, on) => {
    const b = withLedger(on)
    await $.session.start(start())
    await $.prompt.submit(prompt('delegate it'))
    for (const line of ['git merge --ff-only unit/a', 'git merge --squash unit/a', 'git pull --ff-only origin unit/a', 'git merge --ff-only "$B"', 'git pull --ff-only /tmp/unit-tree', 'git pull --ff-only file:///tmp/r']) expect([line, await bash($, b, line, 'a1')]).toEqual([line, SUBAGENT_REFUSAL.deny])
  })

  test("a sub-agent's merge or pull that may make a commit is refused whatever it merges, and one that makes none runs", async ($, on) => {
    const b = withLedger(on)
    await $.session.start(start())
    await $.prompt.submit(prompt('delegate it'))
    for (const line of ['git merge --no-ff origin/main', 'git merge main', 'git merge origin/main', 'git pull', 'git pull origin main', 'git pull --rebase', 'git pull -r', 'git pull --rebase --ff-only', 'git merge --ff-only --no-ff main', 'git pull --qui origin main', 'git pull --qu origin main', 'git merge --no-commit --comm main', 'git merge --squash --no-squ main']) {
      expect([line, await bash($, b, line, 'a1')]).toEqual([line, SUBAGENT_REFUSAL.deny])
    }
    for (const line of ['git merge --ff-only origin/main', 'git merge --squash main', 'git merge --no-commit main', 'git pull --ff-only', 'git pull --ff-only origin', 'git pull --ff-only origin main']) {
      expect([line, await bash($, b, line, 'a1')]).toEqual([line, undefined])
    }
  })

  test("the main session's catch-up merge and pull on a feature branch still run free", async ($, on) => {
    const b = withLedger(on)
    await session($)
    for (const line of ['git merge origin/main', 'git merge --no-ff origin/main', 'git pull']) expect([line, await bash($, b, line)]).toEqual([line, undefined])
  })

  test("a sub-agent's bare merge or pull that makes no commit is refused when its upstream is a unit branch", async ($, on) => {
    const b = withLedger(on)
    await $.session.start(start())
    await $.prompt.submit(prompt('delegate it'))
    expect(await bash($, b, 'git pull --ff-only', 'a1')).toBeUndefined()
    b.repos['/repo'] = { ...FEATURE, upstream: 'refs/heads/unit/a' }
    expect(await bash($, b, 'git merge --ff-only', 'a1')).toBe(SUBAGENT_REFUSAL.deny)
    b.repos['/repo'] = { ...FEATURE, upstream: 'refs/remotes/origin/unit/a' }
    expect(await bash($, b, 'git pull --ff-only', 'a1')).toBe(SUBAGENT_REFUSAL.deny)
  })

  test('the pipeline runs a landing, as it runs a commit', async ($, on) => {
    const b = bench(on, { env: { HOME, WORKBENCH_DEV_TEAM_PIPELINE: '1' }, files: { [LEDGER]: LEDGER_TEXT } })
    b.repos['/repo'] = { ...FEATURE }
    await $.session.start(start())
    await $.prompt.submit(prompt('Item ID: 12'))
    expect(await bash($, b, 'git merge --no-ff unit/a')).toBeUndefined()
  })
})

describe('a catch-up of the default branch from its own upstream runs free, and every other merge into it still asks', () => {
  const MAIN = {
    head: 'c1',
    pushed: 'c1',
    branch: 'main',
    originHead: 'main',
    upstream: 'refs/remotes/origin/main',
    remote: 'origin',
    originUrl: 'git@github.com:o/r.git',
    fetchSpec: '+refs/heads/*:refs/remotes/origin/*',
    fullNames: { 'origin/main': 'refs/remotes/origin/main', 'refs/remotes/origin/main': 'refs/remotes/origin/main', 'origin/fix/x': 'refs/remotes/origin/fix/x' },
  }
  const LEDGER = `${HOME}/.claude-workbench/provisioning/ledger.json`
  const UNIT = { project: '/repo', session: 's0', createdAt: 1, unit: 'unit-a', worktree: null, branch: 'unit/a', database: 'wt_repo_unit_a_testing', connection: '', isDatabaseCreated: false }
  const onMain = (on: Parameters<typeof bench>[0], options: Parameters<typeof bench>[1] = {}): Bench => {
    const b = bench(on, { env: { HOME }, files: { [LEDGER]: JSON.stringify({ version: 1, entries: [UNIT] }) }, ...options })
    b.repos['/repo'] = { ...MAIN }
    return b
  }

  for (const line of [
    'git merge --no-edit origin/main',
    'git merge origin/main',
    'git merge refs/remotes/origin/main',
    'git merge',
    'git pull',
    'git pull --no-edit',
    'git pull origin',
    'git pull origin main',
    'git pull origin refs/heads/main',
    'git pull --no-rebase',
    'git pull --rebase=false origin main',
    'git -C /repo pull origin main',
    'git fetch && git merge --no-edit origin/main',
    'git fetch origin && git merge --no-edit origin/main',
    'git pull 2>&1 | tail -5',
  ]) {
    test(`Mike's session catches main up from origin/main with no question: ${JSON.stringify(line)}`, async ($, on) => {
      const b = onMain(on)
      await session($)
      expect(await bash($, b, line)).toBeUndefined()
    })
  }

  for (const line of [
    'git merge fix/x',
    'git merge origin/fix/x',
    'git merge --no-ff unit/a',
    'git merge --ff-only unit/a',
    'git merge origin/main fix/x',
    'git pull origin fix/x',
    'git pull origin unit/a',
    'git pull origin main fix/x',
    'git pull upstream main',
    'git pull /tmp/unit-tree',
    'git pull /tmp/unit-tree main',
    'git remote set-url origin /tmp/unit-tree && git pull',
    'git -c alias.m=merge m origin/main',
    'echo origin/main | xargs git merge',
    'git fetch --prune && git merge origin/main',
    'git fetch origin fix/x && git merge origin/main',
    'git pull --refmap=+refs/heads/fix/x:refs/remotes/origin/main',
    'git merge -s ours origin/main',
  ]) {
    test(`a merge or pull into main of anything but its own upstream still asks for a merge approval: ${JSON.stringify(line)}`, async ($, on) => {
      const b = onMain(on)
      await session($)
      expect(await bash($, b, line)).toMatch(DECLINED.merge)
    })
  }

  for (const line of [
    'git config branch.main.merge refs/heads/fix/x && git pull',
    'git -c branch.main.merge=refs/heads/fix/x pull',
    'git -c remote.origin.url=/path/to/other pull origin main',
    'git -c include.path=/tmp/evil.config pull',
    'HOME=/tmp/evil git pull',
    'XDG_CONFIG_HOME=/tmp/evil git pull',
    'env HOME=/tmp/evil git pull',
    'export HOME=/tmp/evil; git pull',
    'git pull --rebase',
    'git pull -r',
    'git pull --rebase=merges',
    'git pull --rebase=interactive origin main',
    'git pull --rebase=true',
    'git pull --rebase origin fix/x',
  ]) {
    test(`a pull into main that would rebase, or whose rebase config the gate cannot read, asks for the merge and the rewrite: ${JSON.stringify(line)}`, async ($, on) => {
      const b = onMain(on)
      await session($)
      expect(await bash($, b, line)).toContain('merge into the default branch and history rewrite')
    })
  }

  test('a rebase pull into main runs only after a merge pick and then a pick of its line', async ($, on) => {
    const line = 'git pull --rebase origin fix/x'
    const b = onMain(on)
    await session($)
    const refusal = await bash($, b, line)
    expect(refusal).toMatch(asks('merge into the default branch and history rewrite'))
    expect(refusal).toContain('This pull would rebase, so it needs two picks, each asked alone. First ask the merge question')
    await pick($, b, 'Merge it', [question('Merge fix/x into main?', ['Merge it', 'Open a PR'])])
    expect(await bash($, b, line)).toMatch(DECLINED.rewrite)
    await pick($, b, 'Run it', [question(`Run \`${line}\` in /repo, on main?`, ['Run it', 'Not now'])])
    expect(await bash($, b, line)).toBeUndefined()
    expect(await bash($, b, line)).toMatch(asks('merge into the default branch and history rewrite'))
  })

  test('a kept merge pick approves only the branch its question named, leaves other merges asking, and ends with the next prompt', async ($, on) => {
    const line = 'git pull --rebase origin fix/y'
    const b = onMain(on)
    await session($)
    expect(await bash($, b, line)).toMatch(asks('merge into the default branch and history rewrite'))
    await pick($, b, 'Merge it', [question('Merge fix/x into main?', ['Merge it', 'Open a PR'])])
    await pick($, b, 'Run it', [question(`Run \`${line}\` in /repo, on main?`, ['Run it', 'Not now'])])
    expect(await bash($, b, line)).toBe(MERGE_TARGET_REFUSAL)
    expect(await bash($, b, 'git merge fix/y')).toMatch(DECLINED.merge)
    await $.prompt.submit(prompt('next'))
    expect(await bash($, b, line)).toMatch(asks('merge into the default branch and history rewrite'))
  })

  test('a merge pick alone, or a pick of its line alone, does not let a rebase pull into main run', async ($, on) => {
    const line = 'git pull --rebase origin fix/x'
    const b = onMain(on)
    await session($)
    await pick($, b, 'Merge it', [question('Merge fix/x into main?', ['Merge it', 'Open a PR'])])
    expect(await bash($, b, line)).toMatch(DECLINED.rewrite)
    await $.prompt.submit(prompt('next'))
    expect(await bash($, b, line)).toMatch(asks('merge into the default branch and history rewrite'))
    await pick($, b, 'Run it', [question(`Run \`${line}\` in /repo, on main?`, ['Run it', 'Not now'])])
    expect(await bash($, b, line)).toMatch(DECLINED.merge)
  })

  test('a merge-style pull into main that is not the catch-up keeps its merge question alone', async ($, on) => {
    const b = onMain(on)
    await session($)
    for (const line of ['git pull origin fix/x', 'git pull --no-rebase origin fix/x']) {
      expect([line, DECLINED.merge.test((await bash($, b, line)) ?? '')]).toEqual([line, true])
    }
  })

  for (const line of ['cd /repo && git pull --rebase origin fix/x', 'cd /repo && git pull origin fix/x', 'git -C repo pull origin fix/x', 'git switch main; git pull']) {
    test(`a pull whose directory the gate cannot place counts as a rebase, so it asks for the merge and the rewrite: ${JSON.stringify(line)}`, async ($, on) => {
      const b = onMain(on)
      await session($)
      expect(pullRebasesOf(line).map(pull => pull.dir)).toEqual([null])
      expect(await bash($, b, line)).toContain('merge into the default branch and history rewrite')
    })
  }

  for (const line of ['cd /repo && git pull --no-rebase origin fix/x', 'git -C repo pull --no-rebase origin fix/x', 'git -C repo pull --rebase=false origin fix/x']) {
    test(`a pull whose directory the gate cannot place, with --no-rebase, keeps its merge question alone: ${JSON.stringify(line)}`, async ($, on) => {
      const b = onMain(on)
      await session($)
      expect(await bash($, b, line)).toMatch(DECLINED.merge)
    })
  }

  test('a fetch that maps a branch onto origin/main before the merge is no catch-up, and asks for the merge with the remote-tracking ref update', async ($, on) => {
    const line = 'git fetch --refmap=+refs/heads/fix/x:refs/remotes/origin/main origin fix/x && git merge origin/main'
    const b = onMain(on)
    await session($)
    expect(catchUpsOf(line)).toEqual([])
    expect(await bash($, b, line)).toBe(
      'This line was refused: it runs a merge into the default branch and remote-tracking ref update, and Mike has approved none of them. ' +
        'One pick approves one action, so run each as a line of its own, and ask him about each one through AskUserQuestion, alone.',
    )
  })

  const OWN_TRACKING = 'git fetch origin develop feat/923-turnstile-registration:refs/remotes/origin/feat/923-turnstile-registration'

  test('the reader: a fetch that maps each branch onto its own remote-tracking ref is no rewrite and no head move, and every other refspec still is', () => {
    for (const line of [
      OWN_TRACKING,
      'git fetch origin x:refs/remotes/origin/x',
      'git fetch origin +refs/heads/x:refs/remotes/origin/x',
      'git -C /repo fetch upstream main:refs/remotes/upstream/main',
      'git fetch origin x:refs/remotes/origin/x y:refs/remotes/origin/y',
    ]) {
      expect([line, rewritesOf(line), movesHead(line)]).toEqual([line, 0, false])
    }
    for (const [line, kinds] of [
      ['git fetch origin fix/x:refs/remotes/origin/main', ['tracking']],
      ['git fetch upstream x:refs/remotes/origin/x', ['tracking']],
      ['git fetch origin HEAD:refs/remotes/origin/HEAD', ['tracking']],
      ['git fetch origin x:refs/remotes/origin/x --refmap=', ['tracking']],
      ['git fetch --refmap= origin x', ['tracking']],
      ['git update-ref --stdin', ['reset']],
      ['git -c remote.origin.fetch=+refs/heads/fix/x:refs/remotes/origin/main fetch origin x:refs/remotes/origin/x', ['tracking']],
      ['git fetch --refmap=+refs/heads/x:refs/remotes/origin/main origin x', ['tracking']],
      ['git fetch origin x:refs/remotes/origin/x y:main', ['reset']],
      ['git fetch . feat:main', ['reset']],
      ['git update-ref refs/remotes/origin/main abc1234', ['tracking']],
      ['git update-ref refs/heads/main abc1234', ['reset']],
      ['git branch -f main x', ['reset']],
      ['git reset --hard HEAD~1', ['reset']],
      ['git push . x:main', ['reset']],
      ['git cherry-pick abc1234', ['history']],
      ['git commit --amend --no-edit', ['history']],
      ['git rebase main && git branch -f feat2 x', ['history', 'reset']],
    ] as const) {
      expect([line, rewriteKindsOf(line)]).toEqual([line, kinds])
    }
    expect(rewriteNameOf(['tracking', 'history', 'reset'])).toBe('history rewrite and branch reset and remote-tracking ref update')
    expect(rewriteNameOf([])).toBe('history rewrite')
    expect([rewriteRefusalOf(['tracking', 'reset']), rewriteRefusalOf(['tracking']), rewriteRefusalOf(['reset', 'history']), rewriteRefusalOf([])]).toEqual([
      `${BRANCH_RESET_REFUSAL} ${TRACKING_REFUSAL}`,
      TRACKING_REFUSAL,
      `${REWRITE_REFUSAL} ${BRANCH_RESET_REFUSAL}`,
      REWRITE_REFUSAL,
    ])
    for (const line of ['git fetch -o origin /tmp/other main:refs/remotes/origin/main', 'git fetch --upload-pack=/tmp/evil origin main:refs/remotes/origin/main', 'git fetch --server-option x origin main:refs/remotes/origin/main', 'git fetch --depth 1 origin main:refs/remotes/origin/main', 'git fetch --filter=blob:none origin main:refs/remotes/origin/main']) {
      expect([line, rewriteKindsOf(line), movesHead(line)]).toEqual([line, ['tracking'], true])
    }
    expect(rewritesOf('git fetch --prune --quiet origin main:refs/remotes/origin/main')).toBe(0)
    for (const flag of ['-p', '--prune', '-q', '--quiet', '-v', '--verbose', '-f', '--force', '-t', '--tags', '-n', '--no-tags', '--progress', '--no-progress', '--atomic', '--dry-run']) {
      const line = `git fetch ${flag} origin main:refs/remotes/origin/main`
      expect([line, rewritesOf(line), movesHead(line)]).toEqual([line, 0, false])
    }
    for (const flag of ['--prune-tags', '-P', '--unshallow', '--update-head-ok']) {
      const line = `git fetch ${flag} origin main:refs/remotes/origin/main`
      expect([line, rewriteKindsOf(line)]).toEqual([line, ['tracking']])
    }
    expect(rewriteRefusalOf(['tracking', 'reset', 'history'])).toBe(`${REWRITE_REFUSAL} ${BRANCH_RESET_REFUSAL} ${TRACKING_REFUSAL}`)
    expect([rewriteKindsOf('git fetch --std origin'), rewritesAt('git fetch --std origin').map(rewrite => rewrite.refs)]).toEqual([['reset'], [['']]])
    for (const line of ["printf 'fix/x:refs/remotes/origin/main\\n' | git fetch origin --stdin", 'git fetch origin --stdin < specs.txt']) {
      expect([line, rewriteKindsOf(line), rewritesAt(line).map(rewrite => rewrite.refs)]).toEqual([line, ['reset'], [['']]])
    }
  })

  for (const line of [OWN_TRACKING, `${OWN_TRACKING} && git merge-base --is-ancestor origin/develop origin/feat/923-turnstile-registration && git log --oneline -3 origin/feat/923-turnstile-registration`]) {
    test(`Mike's session runs a fetch into its own remote-tracking refs with no question, beside read-only git commands: ${JSON.stringify(line)}`, async ($, on) => {
      const b = onMain(on)
      await session($)
      expect(await bash($, b, line)).toBeUndefined()
    })
  }

  for (const line of ['git fetch origin main:refs/remotes/origin/main && git merge origin/main', 'git fetch origin fix/x:refs/remotes/origin/fix/x && git merge --no-edit origin/main', 'git fetch origin main:refs/remotes/origin/main && git pull --no-rebase']) {
    test(`the same fetch beside a merge or pull into main takes away the catch-up's free pass, and the merge asks alone: ${JSON.stringify(line)}`, async ($, on) => {
      const b = onMain(on)
      await session($)
      expect(catchUpsOf(line)).toEqual([])
      expect(await bash($, b, line)).toMatch(DECLINED.merge)
    })
  }

  test('a fetch that maps another branch onto origin/main asks as a remote-tracking ref update, never as a history rewrite, so a later catch-up cannot merge that branch with no question', async ($, on) => {
    const line = 'git fetch origin fix/x:refs/remotes/origin/main'
    const b = onMain(on)
    await session($)
    const deny = await bash($, b, line)
    expect(deny).toMatch(DECLINED.tracking)
    expect(deny).not.toContain('history rewrite')
    expect(deny).toContain('say that a remote-tracking ref update changes only refs under refs/remotes/, and no local branch and no commit')
  })

  const CONFIGURED_FETCHES = [
    'git -c remote.origin.fetch=+refs/heads/fix/x:refs/remotes/origin/main fetch',
    'git --config-env=remote.origin.fetch=SPEC fetch',
    'GIT_CONFIG_PARAMETERS="\'remote.origin.fetch=+refs/heads/fix/x:refs/remotes/origin/main\'" git fetch',
    'env HOME=/tmp/evil git fetch',
    'HOME=/tmp/evil git fetch origin',
    'XDG_CONFIG_HOME=/tmp/evil git fetch',
    'GIT_DIR=/tmp/other git fetch',
    'git fetch --refmap=+refs/heads/fix/x:refs/remotes/origin/main origin',
    'git config remote.origin.fetch +refs/heads/fix/x:refs/remotes/origin/main && git fetch',
    'git remote set-url origin /tmp/unit-tree && git fetch',
    'git remote add up /tmp/unit-tree && git fetch',
    'git remote rename origin up && git fetch',
    'export HOME=/tmp/evil; git fetch',
    'HOME=/tmp/x; git fetch',
  ]

  test('the reader: a fetch that may read another fetch refspec is a remote-tracking ref update, and a plain fetch is none', () => {
    for (const line of CONFIGURED_FETCHES) {
      expect([line, rewriteKindsOf(line)]).toEqual([line, ['tracking']])
    }
    for (const line of ['git fetch', 'git fetch --all', 'git fetch origin', 'git fetch --prune origin', 'git -C /repo fetch origin', 'git config --get remote.origin.fetch && git fetch', 'git remote -v && git fetch']) {
      expect([line, rewritesOf(line), rewriteKindsOf(line)]).toEqual([line, 0, []])
    }
  })

  for (const line of ['git fetch', 'git fetch --all', 'git fetch origin', 'git config --get remote.origin.fetch && git fetch']) {
    test(`Mike's session runs a plain fetch with no question, as it reads the stored fetch refspec: ${JSON.stringify(line)}`, async ($, on) => {
      const b = onMain(on)
      await session($)
      expect(await bash($, b, line)).toBeUndefined()
    })
  }

  for (const line of [
    'git -c remote.origin.fetch=+refs/heads/fix/x:refs/remotes/origin/main fetch',
    'GIT_CONFIG_PARAMETERS="\'remote.origin.fetch=+refs/heads/fix/x:refs/remotes/origin/main\'" git fetch',
    'HOME=/tmp/evil git fetch origin',
    'git remote set-url origin /tmp/unit-tree && git fetch',
  ]) {
    test(`Mike's session asks for a fetch that may read another fetch refspec, as a remote-tracking ref update: ${JSON.stringify(line)}`, async ($, on) => {
      const b = onMain(on)
      await session($)
      const deny = await bash($, b, line)
      expect(deny).toContain('remote-tracking ref update')
      expect(deny).not.toContain('history rewrite')
    })
  }

  for (const line of ['git --config-env=remote.origin.fetch=SPEC fetch', 'env HOME=/tmp/evil git fetch']) {
    test(`Mike's session does not run a fetch with --config-env or a wrapper free: ${JSON.stringify(line)}`, async ($, on) => {
      const b = onMain(on)
      await session($)
      expect(await bash($, b, line)).toBeDefined()
    })
  }

  test('a configured fetch beside a merge into main is no catch-up, and asks for the merge with the remote-tracking ref update', async ($, on) => {
    const line = 'git -c remote.origin.fetch=+refs/heads/fix/x:refs/remotes/origin/main fetch && git merge origin/main'
    const b = onMain(on)
    await session($)
    expect(catchUpsOf(line)).toEqual([])
    expect(await bash($, b, line)).toBe(
      'This line was refused: it runs a merge into the default branch and remote-tracking ref update, and Mike has approved none of them. ' +
        'One pick approves one action, so run each as a line of its own, and ask him about each one through AskUserQuestion, alone.',
    )
  })

  test('a sub-agent is refused a configured fetch as a remote-tracking ref update, and runs a plain one', async ($, on) => {
    const b = onMain(on)
    await session($)
    expect(await bash($, b, 'git -c remote.origin.fetch=+refs/heads/fix/x:refs/remotes/origin/main fetch', 'a1')).toBe(TRACKING_REFUSAL)
    expect(await bash($, b, 'HOME=/tmp/evil git fetch origin', 'a1')).toBe(TRACKING_REFUSAL)
    expect(await bash($, b, 'git fetch --all', 'a1')).toBeUndefined()
  })

  for (const line of ['git fetch -o origin /tmp/other main:refs/remotes/origin/main', 'git fetch --upload-pack=/tmp/evil origin main:refs/remotes/origin/main']) {
    test(`an own-ref fetch with an option that takes a value asks as a remote-tracking ref update, as the gate cannot tell where it fetches from: ${JSON.stringify(line)}`, async ($, on) => {
      const b = onMain(on)
      await session($)
      const deny = await bash($, b, line)
      expect(deny).toMatch(DECLINED.tracking)
      expect(deny).not.toContain('history rewrite')
    })
  }

  for (const line of ["printf 'fix/x:refs/remotes/origin/main\\n' | git fetch origin --stdin", 'git fetch origin --stdin < specs.txt', 'git fetch --std origin < specs.txt']) {
    test(`a fetch that reads its refspecs from stdin asks as a branch reset, as the gate cannot read them: ${JSON.stringify(line)}`, async ($, on) => {
      const b = onMain(on)
      await session($)
      expect(await bash($, b, line)).toMatch(DECLINED.reset)
      expect(await bash($, b, line, 'a1')).toBe(BRANCH_RESET_REFUSAL)
    })
  }

  for (const line of ['git fetch origin fix/x:refs/remotes/origin/main', 'git -c remote.origin.fetch=+refs/heads/fix/x:refs/remotes/origin/main fetch']) {
    test(`a "Run it" pick on a remote-tracking ref update question runs that line once: ${JSON.stringify(line)}`, async ($, on) => {
      const b = onMain(on)
      await session($)
      const deny = await bash($, b, line)
      expect(deny).toMatch(DECLINED.tracking)
      await pick($, b, 'Run it', [question(`Update a remote-tracking ref with \`${line}\` in /repo, on main? It changes no local branch and no commit.`, ['Run it', 'Not now'])])
      expect(await bash($, b, line)).toBeUndefined()
      expect(await bash($, b, line)).toBe(deny)
    })
  }

  test("Mike's session asks for the catch-up when origin's URL changed after the session started, and runs it free while the URL is unchanged", async ($, on) => {
    const b = onMain(on)
    await session($)
    expect(await bash($, b, 'git fetch')).toBeUndefined()
    expect(await bash($, b, 'git merge origin/main')).toBeUndefined()
    expect(await bash($, b, 'git remote set-url origin https://github.com/other/repo')).toBeUndefined()
    b.repos['/repo'] = { ...MAIN, originUrl: 'https://github.com/other/repo' }
    expect(await bash($, b, 'git fetch')).toBeUndefined()
    expect(await bash($, b, 'git merge origin/main')).toMatch(DECLINED.merge)
    expect(await bash($, b, 'git pull')).toMatch(DECLINED.merge)
    b.repos['/repo'] = { ...MAIN }
    expect(await bash($, b, 'git pull')).toBeUndefined()
  })

  test('the URL recorded at session start, before any catch-up, makes the first catch-up after a set-url ask', async ($, on) => {
    const b = onMain(on)
    await session($)
    b.repos['/repo'] = { ...MAIN, originUrl: 'https://github.com/other/repo' }
    expect(await bash($, b, 'git pull')).toMatch(DECLINED.merge)
    expect(await bash($, b, 'git merge origin/main')).toMatch(DECLINED.merge)
  })

  test('a remote added after session start and made the upstream gives main no catch-up', async ($, on) => {
    const b = onMain(on)
    await session($)
    b.repos['/repo'] = {
      ...MAIN,
      remote: 'evil',
      upstream: 'refs/remotes/evil/main',
      originUrl: 'https://github.com/x/y',
      fetchSpec: '+refs/heads/*:refs/remotes/evil/*',
      remoteUrls: 'remote.origin.url git@github.com:o/r.git\nremote.evil.url https://github.com/x/y',
      fullNames: { 'evil/main': 'refs/remotes/evil/main' },
    }
    expect(await bash($, b, 'git pull')).toMatch(DECLINED.merge)
    expect(await bash($, b, 'git merge evil/main')).toMatch(DECLINED.merge)
  })

  test('the session-start record reads remote names and their URLs, so a partial-clone line or a URL with a space in git remote -v does not leave it empty', async ($, on) => {
    const b = onMain(on)
    const odd = {
      remoteUrls: 'remote.origin.url git@github.com:o/r.git\nremote.up.url /tmp/a b',
      remotesShown: 'origin\tgit@github.com:o/r.git (fetch) [blob:none]\norigin\tgit@github.com:o/r.git (push)\nup\t/tmp/a b (fetch)\nup\t/tmp/a b (push)\n',
    }
    b.repos['/repo'] = { ...MAIN, ...odd }
    await session($)
    b.repos['/repo'] = { ...MAIN, ...odd, originUrl: 'https://github.com/other/repo', remoteUrls: 'remote.origin.url https://github.com/other/repo\nremote.up.url /tmp/a b' }
    expect(await bash($, b, 'git pull')).toMatch(DECLINED.merge)
  })

  for (const line of ['git -C /repo/ pull', 'git -C //repo pull']) {
    test(`another spelling of the folder reads the same record: ${JSON.stringify(line)}`, async ($, on) => {
      const b = onMain(on)
      b.tops['/repo/'] = '/repo'
      b.tops['//repo'] = '/repo'
      await session($)
      b.repos['/repo'] = { ...MAIN, originUrl: 'https://github.com/other/repo' }
      expect(await bash($, b, line)).toMatch(DECLINED.merge)
      b.repos['/repo'] = { ...MAIN }
      expect(await bash($, b, line)).toBeUndefined()
    })
  }

  test('a session started in a subfolder records its repository, so git -C <root> pull after a set-url asks', async ($, on) => {
    const b = onMain(on)
    b.tops['/repo/sub'] = '/repo'
    b.cwd = '/repo/sub'
    await $.session.start(start())
    await $.prompt.submit(prompt('my review is done'))
    b.repos['/repo'] = { ...MAIN, originUrl: 'https://github.com/other/repo' }
    expect(await bash($, b, 'git -C /repo pull')).toMatch(DECLINED.merge)
    b.repos['/repo'] = { ...MAIN }
    expect(await bash($, b, 'git -C /repo pull')).toBeUndefined()
  })

  test('with no URL read at session start, the first catch-up pins the URL, and a later change asks', async ($, on) => {
    const b = onMain(on)
    b.repos['/repo'] = { ...MAIN, remoteUrls: null }
    await session($)
    b.repos['/repo'] = { ...MAIN }
    expect(await bash($, b, 'git merge origin/main')).toBeUndefined()
    b.repos['/repo'] = { ...MAIN, originUrl: 'git@github.com:other/repo.git' }
    expect(await bash($, b, 'git merge origin/main')).toMatch(DECLINED.merge)
  })

  const EVIL_UPSTREAM = {
    remote: 'evil',
    upstream: 'refs/remotes/evil/main',
    originUrl: 'https://github.com/x/y',
    fetchSpec: '+refs/heads/*:refs/remotes/evil/*',
    remoteUrls: 'remote.origin.url git@github.com:o/r.git\nremote.evil.url https://github.com/x/y',
    fullNames: { 'evil/main': 'refs/remotes/evil/main' },
  }

  test('a linked worktree shares the main worktree record, so a remote added after session start gives its main no catch-up', async ($, on) => {
    const b = onMain(on)
    b.repos['/wt'] = { ...MAIN, commonDir: '/repo/.git' }
    await session($)
    b.repos['/repo'] = { ...MAIN, ...EVIL_UPSTREAM, branch: 'other' }
    b.repos['/wt'] = { ...MAIN, ...EVIL_UPSTREAM, commonDir: '/repo/.git' }
    expect(await bash($, b, 'git -C /wt pull')).toMatch(DECLINED.merge)
    expect(await bash($, b, 'git -C /wt merge evil/main')).toMatch(DECLINED.merge)
    b.repos['/wt'] = { ...MAIN, commonDir: '/repo/.git' }
    expect(await bash($, b, 'git -C /wt pull')).toBeUndefined()
  })

  test('a session started in a linked worktree records the repository, so a set-url seen from the main worktree asks', async ($, on) => {
    const b = onMain(on)
    b.repos['/wt'] = { ...MAIN, commonDir: '/repo/.git' }
    b.cwd = '/wt'
    await $.session.start(start())
    await $.prompt.submit(prompt('my review is done'))
    b.repos['/repo'] = { ...MAIN, originUrl: 'https://github.com/other/repo' }
    expect(await bash($, b, 'git -C /repo pull')).toMatch(DECLINED.merge)
    b.repos['/repo'] = { ...MAIN }
    expect(await bash($, b, 'git -C /repo pull')).toBeUndefined()
  })

  const withOldRemote = (b: Bench, urlRead: { exitCode: number; stdout: string } | undefined, configRead: { exitCode: number; stdout: string }): void => {
    b.run = argv => {
      const line = argv.join(' ')
      if (line === 'git -C /repo remote') return { exitCode: 0, stdout: 'origin\nold\n' }
      if (line === 'git -C /repo remote get-url old') return urlRead ?? { exitCode: 128, stdout: '' }
      if (line === 'git -C /repo config --get remote.old.url') return configRead
      return undefined
    }
  }

  test('a remote with no URL is recorded as such, so the record is made at session start and origin catches up free until its URL changes', async ($, on) => {
    const b = onMain(on)
    withOldRemote(b, undefined, { exitCode: 1, stdout: '' })
    await session($)
    expect(await bash($, b, 'git pull')).toBeUndefined()
    b.repos['/repo'] = { ...MAIN, originUrl: 'https://github.com/other/repo' }
    expect(await bash($, b, 'git pull')).toMatch(DECLINED.merge)
  })

  for (const [label, urlRead] of [
    ['a failed URL read', undefined],
    ['the name git reads as its URL', { exitCode: 0, stdout: 'old\n' }],
  ] as const) {
    test(`a catch-up from a remote with no URL asks, with ${label}`, async ($, on) => {
      const b = onMain(on)
      withOldRemote(b, urlRead, { exitCode: 1, stdout: '' })
      await session($)
      b.repos['/repo'] = { ...MAIN, remote: 'old', upstream: 'refs/remotes/old/main', fetchSpec: '+refs/heads/*:refs/remotes/old/*', fullNames: { 'old/main': 'refs/remotes/old/main' } }
      expect(await bash($, b, 'git pull')).toMatch(DECLINED.merge)
      expect(await bash($, b, 'git merge old/main')).toMatch(DECLINED.merge)
    })
  }

  for (const [label, configRead] of [
    ['its URL is configured', { exitCode: 0, stdout: 'https://github.com/x/y\n' }],
    ['its config cannot be read', { exitCode: 128, stdout: '' }],
  ] as const) {
    test(`a URL read that fails while ${label} makes no record at session start, and the first catch-up records as before`, async ($, on) => {
      const b = onMain(on)
      withOldRemote(b, undefined, configRead)
      await session($)
      expect(await bash($, b, 'git pull')).toMatch(DECLINED.merge)
      b.run = undefined
      b.repos['/repo'] = { ...MAIN, originUrl: 'https://github.com/o/r' }
      expect(await bash($, b, 'git pull')).toBeUndefined()
      b.repos['/repo'] = { ...MAIN }
      expect(await bash($, b, 'git pull')).toMatch(DECLINED.merge)
    })
  }

  test('a sub-agent runs a fetch into its own remote-tracking refs, and is refused one that maps another branch onto origin/main as a remote-tracking ref update', async ($, on) => {
    const b = onMain(on)
    await session($)
    expect(await bash($, b, OWN_TRACKING, 'a1')).toBeUndefined()
    expect(await bash($, b, 'git fetch origin fix/x:refs/remotes/origin/main', 'a1')).toBe(TRACKING_REFUSAL)
  })

  test('a pull that reads another config through GIT_CONFIG_GLOBAL is no catch-up, and asks for the merge with the rewrite', async ($, on) => {
    const line = 'GIT_CONFIG_GLOBAL=/tmp/evil.config git pull'
    const b = onMain(on)
    await session($)
    expect(catchUpsOf(line)).toEqual([])
    expect(await bash($, b, line)).toMatch(asks('merge into the default branch and history rewrite'))
  })

  test('a pull whose config override git reads from --config-env is no catch-up, and gets the plain-line refusal', async ($, on) => {
    const line = 'git --config-env=branch.main.merge=B pull'
    const b = onMain(on)
    await session($)
    expect(catchUpsOf(line)).toEqual([])
    expect(await bash($, b, line)).toBe(PLAIN_REFUSAL.deny)
  })

  test('a rebase config the gate cannot read gives a pull no catch-up, and leaves a merge and --no-rebase free', async ($, on) => {
    const b = onMain(on)
    await session($)
    for (const fixture of [{ pullRebase: null }, { branchRebase: null }]) {
      b.repos['/repo'] = { ...MAIN, ...fixture }
      expect(await bash($, b, 'git pull')).toMatch(asks('merge into the default branch and history rewrite'))
      expect(await bash($, b, 'git pull origin main')).toMatch(asks('merge into the default branch and history rewrite'))
      expect(await bash($, b, 'git pull --no-rebase')).toBeUndefined()
      expect(await bash($, b, 'git merge --no-edit origin/main')).toBeUndefined()
    }
  })

  test('a fetch that maps a branch onto a remote-tracking ref writes a ref, whatever the spelling of --refmap', () => {
    for (const line of ['git fetch --refmap=+refs/heads/x:refs/remotes/origin/main origin x', 'git fetch --refm=+refs/heads/x:refs/remotes/origin/main origin', 'git fetch --refmap +refs/heads/x:refs/remotes/origin/main origin']) {
      expect([line, rewritesOf(line)]).toEqual([line, 1])
    }
    expect(catchUpsOf('git pull --refmap=+refs/heads/x:refs/remotes/origin/main')).toEqual([])
  })

  test("a remote whose URL is no GitHub repository, or whose fetch refspec maps anything else, gives main no catch-up", async ($, on) => {
    const b = onMain(on)
    await session($)
    b.repos['/repo'] = { ...MAIN, originUrl: '/tmp/unit-tree' }
    expect(await bash($, b, 'git pull')).toMatch(DECLINED.merge)
    expect(await bash($, b, 'git merge origin/main')).toMatch(DECLINED.merge)
    b.repos['/repo'] = { ...MAIN, originUrl: undefined }
    expect(await bash($, b, 'git pull')).toMatch(DECLINED.merge)
    b.repos['/repo'] = { ...MAIN, fetchSpec: '+refs/heads/fix/x:refs/remotes/origin/main' }
    expect(await bash($, b, 'git pull')).toMatch(DECLINED.merge)
    expect(await bash($, b, 'git merge origin/main')).toMatch(DECLINED.merge)
    b.repos['/repo'] = { ...MAIN, fetchSpec: undefined }
    expect(await bash($, b, 'git pull')).toMatch(DECLINED.merge)
    b.repos['/repo'] = { ...MAIN }
    expect(await bash($, b, 'git pull')).toBeUndefined()
  })

  test('a plain pull that stored config makes a rebase is no catch-up, and one that turns the rebase off is', async ($, on) => {
    const b = onMain(on)
    await session($)
    const both = asks('merge into the default branch and history rewrite')
    for (const value of ['true', 'merges', 'interactive', 'i', 'm', 'yes', '']) {
      b.repos['/repo'] = { ...MAIN, pullRebase: value }
      expect([value, both.test((await bash($, b, 'git pull')) ?? '')]).toEqual([value, true])
      b.repos['/repo'] = { ...MAIN, branchRebase: value }
      expect([value, both.test((await bash($, b, 'git pull origin main')) ?? '')]).toEqual([value, true])
    }
    b.repos['/repo'] = { ...MAIN, pullRebase: 'true' }
    expect(await bash($, b, 'git merge origin/main')).toBeUndefined()
    expect(await bash($, b, 'git pull --no-rebase')).toBeUndefined()
    b.repos['/repo'] = { ...MAIN, pullRebase: 'true', branchRebase: 'false' }
    expect(await bash($, b, 'git pull')).toBeUndefined()
    b.repos['/repo'] = { ...MAIN, pullRebase: 'false', branchRebase: 'merges' }
    expect(await bash($, b, 'git pull')).toMatch(both)
    for (const value of ['false', 'no', 'off', '0']) {
      b.repos['/repo'] = { ...MAIN, pullRebase: value }
      expect([value, await bash($, b, 'git pull')]).toEqual([value, undefined])
    }
  })

  test('a ref that resolves to anything but the upstream, or an upstream of another branch, is no catch-up', async ($, on) => {
    const b = onMain(on)
    await session($)
    b.repos['/repo'] = { ...MAIN, fullNames: { 'origin/main': 'refs/heads/origin/main' } }
    expect(await bash($, b, 'git merge origin/main')).toMatch(DECLINED.merge)
    b.repos['/repo'] = { ...MAIN, fullNames: {} }
    expect(await bash($, b, 'git merge origin/main')).toMatch(DECLINED.merge)
    b.repos['/repo'] = { ...MAIN, upstream: 'refs/remotes/origin/fix/x' }
    expect(await bash($, b, 'git pull')).toMatch(DECLINED.merge)
    expect(await bash($, b, 'git merge origin/fix/x')).toMatch(DECLINED.merge)
    b.repos['/repo'] = { ...MAIN, upstream: 'refs/heads/unit/a', remote: '.' }
    expect(await bash($, b, 'git pull')).toMatch(DECLINED.merge)
    b.repos['/repo'] = { ...MAIN, remote: undefined }
    expect(await bash($, b, 'git pull')).toMatch(DECLINED.merge)
    b.repos['/repo'] = { ...MAIN, upstream: undefined }
    expect(await bash($, b, 'git pull origin main')).toMatch(DECLINED.merge)
    b.repos['/repo'] = { ...MAIN, branch: null }
    expect(await bash($, b, 'git pull origin main')).toMatch(DECLINED.merge)
    b.repos['/repo'] = { ...MAIN }
    expect(await bash($, b, 'git pull origin main')).toBeUndefined()
  })

  test('a catch-up beside a landing on one line still asks for the landing', async ($, on) => {
    const b = onMain(on)
    await session($)
    expect(await bash($, b, 'git pull; git merge fix/x')).toMatch(DECLINED.merge)
    expect(await bash($, b, 'git merge origin/main && git merge --no-ff unit/a')).toMatch(DECLINED.merge)
    expect(await bash($, b, 'git pull && git pull origin main')).toBeUndefined()
  })

  for (const [where, fixture] of [
    ['the default branch', {}],
    ['a feature branch tracking its own remote', { branch: 'fix/x', upstream: 'refs/remotes/origin/fix/x' }],
  ] as const) {
    test(`Mike's session syncs ${where} with its own remote by fetch --all, pull and push, each a line of its own`, async ($, on) => {
      const b = onMain(on)
      b.repos['/repo'] = { ...MAIN, ...fixture }
      await session($)
      expect(await bash($, b, 'git fetch --all')).toBeUndefined()
      expect(await bash($, b, 'git pull')).toBeUndefined()
      expect(await bash($, b, 'git push')).toMatch(DECLINED.push)
      await pushPick($, b)
      expect(await bash($, b, 'git push')).toBeUndefined()
    })
  }

  test('a catch-up that is free does not approve the push beside it', async ($, on) => {
    const b = onMain(on)
    await session($)
    expect(await bash($, b, 'git pull && git push')).toMatch(DECLINED.push)
  })

  for (const [lane, options, isInteractive, agentId] of [
    ['a sub-agent', {}, true, 'a1'],
    ['the pipeline', { env: { HOME, WORKBENCH_DEV_TEAM_PIPELINE: '1' } }, true, undefined],
    ['a session nobody sits at', {}, false, undefined],
  ] as const) {
    test(`${lane}: a catch-up of main that may make a commit is still refused`, async ($, on) => {
      const b = onMain(on, options)
      await $.session.start(start(isInteractive))
      await $.prompt.submit(prompt('Item ID: 12', isInteractive ? PERSON : { kind: 'sdk' }))
      for (const line of ['git merge --no-edit origin/main', 'git pull', 'git pull origin main']) {
        expect([line, await bash($, b, line, agentId)]).toEqual([line, AGENT_MERGE_REFUSAL])
      }
    })
  }

  test("a sub-agent's catch-up of a feature branch that may make a commit is still refused", async ($, on) => {
    const b = onMain(on)
    b.repos['/repo'] = { ...MAIN, branch: 'fix/x', upstream: 'refs/remotes/origin/fix/x' }
    await $.session.start(start())
    await $.prompt.submit(prompt('delegate it'))
    for (const line of ['git merge --no-edit origin/main', 'git pull', 'git pull origin main']) {
      expect([line, await bash($, b, line, 'a1')]).toEqual([line, SUBAGENT_REFUSAL.deny])
    }
  })

  test('a merge pick honours a ref that its question names with its remote', async ($, on) => {
    const b = bench(on)
    b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'main', originHead: 'main' }
    await session($)
    await pick($, b, 'Merge it', [question('Merge upstream/main into main?', ['Merge it', 'Open a PR'])])
    expect(await bash($, b, 'git merge --no-edit upstream/main')).toBeUndefined()
    await pick($, b, 'Merge it', [question('Merge origin/main into main?', ['Merge it', 'Open a PR'])])
    expect(await bash($, b, 'git merge --no-edit origin/main')).toBeUndefined()
    await pick($, b, 'Merge it', [question('Merge origin/main into main?', ['Merge it', 'Open a PR'])])
    expect(await bash($, b, 'git merge --no-edit upstream/main')).toBe(MERGE_TARGET_REFUSAL)
  })

  test('the catch-up reader keeps one merged ref and the pulled remote, and gives up on a line that runs other git', () => {
    expect(catchUpsOf('git merge --no-edit origin/main')).toEqual([{ dir: '', kind: 'merge', ref: 'origin/main' }])
    expect(catchUpsOf('git pull')).toEqual([{ dir: '', kind: 'pull' }])
    expect(catchUpsOf('git -C /repo pull origin main')).toEqual([{ dir: '/repo', kind: 'pull', remote: 'origin', ref: 'main' }])
    expect(catchUpsOf('git fetch && git pull origin')).toEqual([{ dir: '', kind: 'pull', remote: 'origin' }])
    expect(catchUpsOf('git pull --no-rebase')).toEqual([{ dir: '', kind: 'pull', isRebaseOff: true }])
    expect(catchUpsOf('git pull --rebase=false origin main')).toEqual([{ dir: '', kind: 'pull', remote: 'origin', ref: 'main', isRebaseOff: true }])
    for (const line of ['git -c x.y=z pull', 'HOME=/x git pull', 'git pull --rebase', 'git pull -r', 'git fetch --prune && git pull', 'git fetch origin main && git pull', 'git pull > out.txt', 'echo x >> .git/config; git pull', 'git merge -s ours origin/main', 'git pull origin main:main', 'cd /repo && git pull', 'git checkout main && git pull', 'git remote add o /tmp/x && git pull o main', 'git branch -u origin/fix/x && git pull', 'git merge --continue', 'git merge "$B"']) {
      expect([line, catchUpsOf(line)]).toEqual([line, []])
    }
  })
})

describe('on a feature branch, a pull that would rebase asks as a history rewrite, and a merge-style pull runs free', () => {
  const OWN = { head: 'c1', pushed: 'c1', branch: 'fix/x', originHead: 'main', upstream: 'refs/remotes/origin/fix/x', remote: 'origin' }
  const onFeature = (on: Parameters<typeof bench>[0]): Bench => {
    const b = bench(on)
    b.repos['/repo'] = { ...OWN }
    return b
  }

  for (const line of [
    'git pull --rebase',
    'git pull -r',
    'git pull -qr',
    'git pull --reb',
    'git pull --rebase=merges',
    'git pull --rebase=interactive origin fix/x',
    'git pull --rebase=true',
    'git pull --no-rebase --rebase',
    'git pull --ff-only --rebase',
    'git -C /repo pull --rebase',
  ]) {
    test(`a rebase flag makes the pull a history rewrite that asks: ${JSON.stringify(line)}`, async ($, on) => {
      const b = onFeature(on)
      await session($)
      expect(await bash($, b, line)).toMatch(DECLINED.rewrite)
    })
  }

  for (const line of ['git pull', 'git pull origin', 'git pull origin fix/x', 'git pull --no-rebase', 'git pull --rebase=false', 'git pull --rebase=no', 'git pull --rebase --no-rebase', 'git pull --no-ff', 'git pull --ff-only']) {
    test(`a merge-style pull of the branch's own remote runs with no question: ${JSON.stringify(line)}`, async ($, on) => {
      const b = onFeature(on)
      await session($)
      expect(await bash($, b, line)).toBeUndefined()
    })
  }

  test('a plain pull that stored config makes a rebase asks, and one whose config turns the rebase off runs', async ($, on) => {
    const b = onFeature(on)
    await session($)
    for (const value of ['true', 'merges', 'interactive', 'i', 'm', 'yes', '']) {
      b.repos['/repo'] = { ...OWN, pullRebase: value }
      expect([value, DECLINED.rewrite.test((await bash($, b, 'git pull')) ?? '')]).toEqual([value, true])
      b.repos['/repo'] = { ...OWN, branchRebase: value }
      expect([value, DECLINED.rewrite.test((await bash($, b, 'git pull origin fix/x')) ?? '')]).toEqual([value, true])
    }
    b.repos['/repo'] = { ...OWN, pullRebase: 'true' }
    expect(await bash($, b, 'git pull --no-rebase')).toBeUndefined()
    expect(await bash($, b, 'git merge origin/main')).toBeUndefined()
    b.repos['/repo'] = { ...OWN, pullRebase: 'true', branchRebase: 'false' }
    expect(await bash($, b, 'git pull')).toBeUndefined()
    b.repos['/repo'] = { ...OWN, pullRebase: 'false', branchRebase: 'merges' }
    expect(await bash($, b, 'git pull')).toMatch(DECLINED.rewrite)
    for (const value of ['false', 'no', 'off', '0', 'FALSE']) {
      b.repos['/repo'] = { ...OWN, pullRebase: value }
      expect([value, await bash($, b, 'git pull')]).toEqual([value, undefined])
    }
  })

  test('a rebase config the gate cannot read counts as a rebase, and an explicit --no-rebase still runs', async ($, on) => {
    const b = onFeature(on)
    await session($)
    for (const fixture of [{ pullRebase: null }, { branchRebase: null }]) {
      b.repos['/repo'] = { ...OWN, ...fixture }
      expect(await bash($, b, 'git pull')).toMatch(DECLINED.rewrite)
      expect(await bash($, b, 'git pull --no-rebase')).toBeUndefined()
    }
    b.repos['/repo'] = { ...OWN }
    for (const line of ['git -c pull.rebase=true pull', 'HOME=/tmp/evil git pull', 'export HOME=/tmp/evil; git pull', 'git config pull.rebase true && git pull', 'git --no-pager pull']) {
      expect([line, DECLINED.rewrite.test((await bash($, b, line)) ?? '')]).toEqual([line, true])
    }
    expect(await bash($, b, 'git -c pull.rebase=true pull --no-rebase')).toBeUndefined()
  })

  test('a rebase pull runs after a pick of its own line', async ($, on) => {
    const b = onFeature(on)
    await session($)
    expect(await bash($, b, 'git pull --rebase')).toMatch(DECLINED.rewrite)
    await pick($, b, 'Run it', [question('Run `git pull --rebase` in /repo, on fix/x?', ['Run it', 'Not now'])])
    expect(await bash($, b, 'git pull --rebase')).toBeUndefined()
  })

  test('the rebase reader takes the last rebase flag, and marks config it cannot read', () => {
    expect(pullRebasesOf('git pull')).toEqual([{ dir: '', rebase: 'config' }])
    expect(pullRebasesOf('git -C /repo pull --rebase')).toEqual([{ dir: '/repo', rebase: 'on' }])
    expect(pullRebasesOf('git pull --rebase --no-rebase')).toEqual([{ dir: '', rebase: 'off' }])
    expect(pullRebasesOf('git pull --no-rebase -r')).toEqual([{ dir: '', rebase: 'on' }])
    expect(pullRebasesOf('git pull --rebase=0')).toEqual([{ dir: '', rebase: 'off' }])
    expect(pullRebasesOf('git pull -j 4 -o r origin fix/x')).toEqual([{ dir: '', rebase: 'config' }])
    expect(pullRebasesOf('git merge origin/main')).toEqual([])
    for (const line of ['git -c pull.rebase=true pull', 'HOME=/x git pull', 'env HOME=/x git pull', 'HOME=/x; git pull', 'git config pull.rebase true; git pull', 'git --no-pager pull']) {
      expect([line, pullRebasesOf(line).map(pull => pull.rebase)]).toEqual([line, ['unread']])
    }
  })
})
