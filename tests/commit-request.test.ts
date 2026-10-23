import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptOrigin } from 'claude-code'

import {
  AGENT_RELEASE_REFUSAL,
  COMMIT_REFUSAL,
  ONE_REFUSAL,
  PATHSPEC_REFUSAL,
  PUSH_REFUSAL,
  RELEASE_REFUSAL,
  SHARED_LINE_REFUSAL,
  UNREAD_TREE_REFUSAL,
  UNREAD_LINE_REFUSAL,
  agentReleaseRefusalOf,
  changesIndexBeside,
  leftOutOf,
  leftOutRefusal,
  releasesOf,
  requestedCallsOf,
  requestedOf,
  shapeOf,
  unnamedOf,
  unreadReleasesOf,
} from '../hooks/mods/commit-approval'

import { PLAIN_REFUSAL, SUBAGENT_REFUSAL } from '../hooks/mods/commit-guard'
import type { Bench } from './bench'
import { ASKS as DECLINED, HOME, PERSON, bench, exactly, start } from './bench'
import { ID_RECORDER } from './harness'

const DIRS: Record<string, string> = { '/': '/', '/repo': '/repo', '/repo/sub': '/repo/sub', '/repo/link': '/other', '/wt': '/wt', '/other': '/other', '/repo/.git': '/repo/.git', '/other/.git': '/other/.git' }
const REPOS: Record<string, { top: string; common: string }> = {
  '/repo': { top: '/repo', common: '/repo/.git' },
  '/repo/sub': { top: '/repo', common: '/repo/.git' },
  '/wt': { top: '/wt', common: '/repo/.git' },
  '/other': { top: '/other', common: '/other/.git' },
}
const GIT: Record<string, string> = {
  'symbolic-ref --short -q HEAD': 'main',
  'config --get branch.main.remote': 'origin',
  'rev-parse --verify -q refs/tags/0.49.0^{commit}': 'c9',
  'rev-parse --verify -q HEAD': 'c9',
  'rev-parse --show-toplevel': '/repo',
  'symbolic-ref -q HEAD': 'refs/heads/main',
  'worktree list --porcelain': 'worktree /repo\nHEAD c9\nbranch refs/heads/main',
}

function project(b: Bench): Bench {
  b.run = argv => {
    const [program = '', a = '', c = '', d = ''] = argv
    if (program === 'bash' && a.endsWith('/scope-facts.sh')) {
      if (c === 'roots') return { exitCode: 0, stdout: '' }
      if (c === 'dir') return { exitCode: 0, stdout: DIRS[d] === undefined ? '' : `${DIRS[d]}\n` }
      return { exitCode: 0, stdout: '' }
    }
    if (program !== 'git' || a !== '-C') return undefined
    if (argv.includes('--git-common-dir')) {
      const repo = REPOS[c]
      return repo === undefined ? { exitCode: 128, stdout: '' } : { exitCode: 0, stdout: `${repo.top}\n${repo.common}\n` }
    }
    const answer = GIT[argv.slice(3).join(' ')]
    return answer === undefined ? (argv[3] === 'status' ? undefined : { exitCode: 1, stdout: '' }) : { exitCode: 0, stdout: `${answer}\n` }
  }
  return b
}

const prompt = (text: string, origin: PromptOrigin = PERSON, turnId?: string) => ({ text, wait: false, origin, ...(turnId ? { turnId } : {}) })

const COMMIT_QUESTION = {
  question: 'Commit feat: add the gate on main?',
  header: 'Q',
  options: [
    { label: 'Not yet', description: 'Not yet' },
    { label: 'Commit it', description: 'Commit it' },
  ],
  multiSelect: false,
}

async function bash($: Engine, b: Bench, command: string, agentId?: string): Promise<string | undefined> {
  const before = b.calls.filter(call => call.tool === 'Bash').length
  const result = await $.tool.call({ tool: 'Bash', command, ...(agentId ? { agentId } : {}) } as never)
  expect(b.calls.filter(call => call.tool === 'Bash').length > before).toBe(result.deny === undefined)
  return result.deny
}

const PUSH_QUESTION = { ...COMMIT_QUESTION, question: 'Push main to origin?', options: [{ label: 'Push', description: 'Push' }, { label: 'Not yet', description: 'Not yet' }] }
const MERGE_QUESTION = { ...COMMIT_QUESTION, question: 'Merge pull request 12 into main?', options: [{ label: 'Merge it', description: 'Merge' }, { label: 'Open a PR', description: 'PR' }] }

async function pick($: Engine, b: Bench, question: unknown = COMMIT_QUESTION, label = 'Commit it'): Promise<void> {
  b.repos['/repo'] ??= { head: 'c1', pushed: 'c1' }
  b.pick = label
  expect((await $.tool.call({ tool: 'AskUserQuestion', questions: [question] } as never)).deny).toBeUndefined()
}

async function asked($: Engine, command: string, agentId?: string): Promise<unknown> {
  const result = await $.classic.PermissionRequest({
    hook_event_name: 'PermissionRequest',
    session_id: 's',
    transcript_path: '/t.jsonl',
    cwd: '/repo',
    tool_name: 'Bash',
    tool_input: { command },
    ...(agentId ? { agent_id: agentId, agent_type: 'watson' } : {}),
  } as never)
  return (result as { decision?: unknown }).decision
}

const ALLOW = { behavior: 'allow' }

async function typed($: Engine, on: On, text: string, options: Parameters<typeof bench>[1] = {}): Promise<Bench> {
  const b = bench(on, options)
  await $.session.start(start())
  await $.prompt.submit(prompt(text))
  return b
}

const entry = (xy: string, path: string): string => `${xy} ${path}\0`

describe('AC1: a commit that leaves files out of the tree is refused, and names them', () => {
  test('an untracked file and an unstaged change are named, and the commit runs once they are staged', async ($, on) => {
    const b = await typed($, on, 'commit it')
    b.trees['/repo'] = entry('A ', 'hooks/new.ts') + entry('??', 'notes/draft.md') + entry(' M', 'README.md')
    const refusal = await bash($, b, 'git commit -m "fix: 🐛 X."')
    expect(refusal).toBe(leftOutRefusal(['notes/draft.md', 'README.md']))
    expect(refusal).toContain('notes/draft.md')
    expect(refusal).toContain('README.md')
    expect(refusal).not.toContain('hooks/new.ts')
    b.trees['/repo'] = entry('A ', 'hooks/new.ts') + entry('A ', 'notes/draft.md') + entry('M ', 'README.md')
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
  })

  test('a file staged in part is left out in part, so it is named', async ($, on) => {
    const b = await typed($, on, 'commit it')
    b.trees['/repo'] = entry('MM', 'a.ts') + entry('M ', 'b.ts')
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBe(leftOutRefusal(['a.ts']))
  })

  test('a pick approves the commit, and the tree is still checked', async ($, on) => {
    const b = await typed($, on, 'my review is done')
    await pick($, b)
    b.trees['/repo'] = entry('??', 'stray.txt')
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBe(leftOutRefusal(['stray.txt']))
    b.trees['/repo'] = entry('A ', 'stray.txt')
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
  })

  test('the tree is read in the repository the commit runs in', async ($, on) => {
    const b = await typed($, on, 'commit it', { env: { HOME } })
    b.trees['/other'] = entry('??', 'left.txt')
    expect(await bash($, b, 'git -C /other commit -m "fix: 🐛 X."')).toBe(leftOutRefusal(['left.txt']))
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
    expect(b.runs.filter(argv => argv[3] === 'status').map(argv => argv[2])).toEqual(['/other', '/repo'])
  })

  test('git commit -a takes the tracked changes, and still leaves an untracked file out', async ($, on) => {
    const b = await typed($, on, 'commit it')
    b.trees['/repo'] = entry(' M', 'a.ts') + entry(' D', 'gone.ts')
    expect(await bash($, b, 'git commit -am "fix: 🐛 X."')).toBeUndefined()
    b.trees['/repo'] = entry(' M', 'a.ts') + entry('??', 'new.ts')
    expect(await bash($, b, 'git commit -a -m "fix: 🐛 X."')).toBe(leftOutRefusal(['new.ts']))
  })

  for (const line of [
    'git reset -q HEAD f && git commit -m "fix: 🐛 X."',
    'git restore --staged f && git commit -m "fix: 🐛 X."',
    'git rm --cached f; git commit -m "fix: 🐛 X."',
    'git commit -m "fix: 🐛 X."; git reset HEAD~1',
    'git stash && git commit -m "fix: 🐛 X."',
    'git update-index --assume-unchanged f && git commit -m "fix: 🐛 X."',
  ]) {
    test(`a fully staged tree is still refused when the line can change the index beside the commit: ${line}`, async ($, on) => {
      const b = await typed($, on, 'commit it')
      b.trees['/repo'] = entry('M ', 'f') + entry('A ', 'g')
      expect(await bash($, b, line)).toBe(SHARED_LINE_REFUSAL)
    })
  }

  test('staging, reads and a push beside the commit leave the line alone', () => {
    for (const line of ['git add -A && git commit -m "fix: 🐛 X."', 'git status && git commit -m "fix: 🐛 X."', 'git commit -m "fix: 🐛 X." && git push', 'git diff --cached; git commit -m "fix: 🐛 X."']) {
      expect(changesIndexBeside(line)).toBe(false)
    }
  })

  for (const line of [
    'git commit -m "fix: 🐛 X." a.ts',
    'git commit -m "fix: 🐛 X." -- a.ts',
    'git commit --only -m "fix: 🐛 X."',
    'git commit -p',
    'git commit -i a.ts',
    'git commit --pathspec-from-file=list -m x',
    'git commit --pathspec-from=list -m x',
    'git commit --onl -m "fix: 🐛 X."',
    'git commit --inter',
    'git commit --incl -m "fix: 🐛 X."',
    'git commit --pat',
  ]) {
    test(`a commit that names paths or picks hunks is refused: ${line}`, async ($, on) => {
      const b = await typed($, on, 'commit it')
      expect(await bash($, b, line)).toBe(PATHSPEC_REFUSAL)
    })
  }

  test('a tree git cannot read refuses the commit', async ($, on) => {
    const b = await typed($, on, 'commit it')
    b.trees['/repo'] = null
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBe(UNREAD_TREE_REFUSAL)
  })

  test('a commit spelled through an alias is refused, and asked to run as a plain line', async ($, on) => {
    const b = await typed($, on, 'commit it')
    expect(await bash($, b, 'git -c alias.ci=commit ci -m x')).toBe(PLAIN_REFUSAL.deny)
  })

  test('the pipeline is not checked here and commits as before, and a sub-agent does not commit', async ($, on) => {
    const b = bench(on, { env: { HOME, WORKBENCH_DEV_TEAM_PIPELINE: '1' } })
    b.trees['/repo'] = entry('??', 'left.txt')
    await $.session.start(start())
    await $.prompt.submit(prompt('Item ID: 12'))
    expect(await bash($, b, 'git commit -m "fix: 🐛 X." a.ts')).toBeUndefined()
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."', 'a1')).toBe(SUBAGENT_REFUSAL.deny)
  })

  test('the porcelain reader takes renames, copies and the -a rule apart', () => {
    expect(leftOutOf(`R  new.ts\0old.ts\0${entry('RM', 'b2.ts')}b.ts\0${entry('??', 'u.ts')}`, false)).toEqual(['b2.ts', 'u.ts'])
    expect(leftOutOf(entry(' T', 'link') + entry('UU', 'conflict.ts') + entry('??', 'u.ts'), true)).toEqual(['conflict.ts', 'u.ts'])
    expect(leftOutOf('', false)).toEqual([])
  })

  test('the commit shape reader finds -a and paths past every value option', () => {
    expect(shapeOf(['-m', 'a.ts'])).toEqual({ isAll: false, isPartial: false })
    expect(shapeOf(['-am', 'msg'])).toEqual({ isAll: true, isPartial: false })
    expect(shapeOf(['-mmsg', 'a.ts'])).toEqual({ isAll: false, isPartial: true })
    expect(shapeOf(['-F', '/tmp/m', '--author', 'A <a@b>', '--all'])).toEqual({ isAll: true, isPartial: false })
    expect(shapeOf(['--message=x', '--no-verify'])).toEqual({ isAll: false, isPartial: false })
    expect(shapeOf(['-S', '-m', 'x', '--'])).toEqual({ isAll: false, isPartial: false })
    expect(shapeOf(['-m', 'x', '--', 'a.ts'])).toEqual({ isAll: false, isPartial: true })
  })
})

describe('AC2: a never-ship file Mike is told about can stay out', () => {
  const nameTest = (name: string, body: ($: Engine, on: On) => Promise<void>): void => test(name, { plugins: [ID_RECORDER] }, body)

  nameTest('a left-out path named in the reply lets the commit run', async ($, on) => {
    const b = await typed($, on, 'commit it')
    b.trees['/repo'] = entry('M ', 'a.ts') + entry('??', '.env.local')
    b.shown = 'I staged everything but `.env.local`, which holds an API token, so it must never ship.'
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
  })

  nameTest('a folder named with its slash covers the files in it', async ($, on) => {
    const b = await typed($, on, 'commit it')
    b.trees['/repo'] = entry('M ', 'a.ts') + entry('??', 'dist/app.js') + entry('??', 'dist/app.css')
    b.shown = 'Leaving out dist/, a stray build artifact.'
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
  })

  nameTest('only the named file may stay out: an unnamed one is still refused, and named alone', async ($, on) => {
    const b = await typed($, on, 'commit it')
    b.trees['/repo'] = entry('??', '.env.local') + entry('??', 'notes.md')
    b.shown = 'Leaving out .env.local, which holds a secret.'
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBe(leftOutRefusal(['notes.md']))
  })

  nameTest('a reply that does not name the file lets nothing through', async ($, on) => {
    const b = await typed($, on, 'commit it')
    b.trees['/repo'] = entry('??', '.env')
    b.shown = 'Committing the whole tree now.'
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBe(leftOutRefusal(['.env']))
  })

  test('a name counts only as a whole path, never inside a longer one', () => {
    expect(unnamedOf(['.env'], 'Leaving out x.env and .envrc.')).toEqual(['.env'])
    expect(unnamedOf(['a/b.ts'], 'Leaving out "a/b.ts".')).toEqual([])
    expect(unnamedOf(['a/b/c.ts'], 'Leaving out (a/b/).')).toEqual([])
    expect(unnamedOf(['a/b/c.ts'], 'Leaving out a/b.')).toEqual(['a/b/c.ts'])
  })
})

describe('AC3: a prompt Mike types approves the actions it names, for that turn', () => {
  test('"commit and push" runs a commit, a version-bump commit and the pushes with no pick', async ($, on) => {
    const b = await typed($, on, 'Looks good, commit and push.')
    expect(await bash($, b, 'git commit -F /tmp/msg')).toBeUndefined()
    expect(await bash($, b, 'git push')).toBeUndefined()
    expect(await bash($, b, 'git commit -m "chore: 🔖 Bump version to 0.49.0."')).toBeUndefined()
    expect(await bash($, b, 'git push origin main')).toBeUndefined()
    expect(b.calls.some(call => call.tool === 'AskUserQuestion')).toBe(false)
  })

  test('"commit and push and release" approves the release path: the bump commit, the push and gh release create', async ($, on) => {
    const b = await typed($, on, 'commit and push and release')
    expect(await bash($, b, 'git commit -m "feat: ✨ Add x."')).toBeUndefined()
    expect(await bash($, b, 'git commit -m "chore: 🔖 Bump version to 0.49.0."')).toBeUndefined()
    expect(await bash($, b, 'git push')).toBeUndefined()
    expect(await bash($, b, 'gh release create 0.49.0 --target main --title "0.49.0: x" --notes \'The gate reads the tree.\'')).toBeUndefined()
  })

  test('"release" alone covers the commit and the push a release needs', async ($, on) => {
    const b = await typed($, on, 'cut a release')
    expect(await bash($, b, 'git commit -m "chore: 🔖 Bump version to 0.49.0."')).toBeUndefined()
    expect(await bash($, b, 'git push')).toBeUndefined()
    expect(await bash($, b, 'gh release create 0.49.0 --notes x')).toBeUndefined()
  })

  test('"push" alone runs a push with no commit before it', async ($, on) => {
    const b = await typed($, on, 'push it')
    expect(await bash($, b, 'git push')).toBeUndefined()
  })

  test('the permission dialog is answered for each approved action, so it never opens', async ($, on) => {
    project(await typed($, on, 'commit, push, and release'))
    for (const line of [
      'git commit -F /tmp/msg',
      'git commit -m "fix: 🐛 M."',
      'git commit -am "fix: 🐛 M."',
      'git -C /repo commit -m "fix: 🐛 X."',
      'git -C /repo/sub commit -m "fix: 🐛 X."',
      'git -C /wt commit -m "fix: 🐛 X."',
      'git push',
      'git push origin main',
      'git -C /repo push origin refs/heads/main',
      'git push origin 0.49.0',
      'gh release create 0.49.0 --title t --notes-file /tmp/n.md',
    ]) {
      expect({ line, decision: await asked($, line) }).toEqual({ line, decision: ALLOW })
    }
  })

  test('the release tag is answered only under a release request', async ($, on) => {
    project(await typed($, on, 'commit and push'))
    expect(await asked($, 'git push origin main')).toEqual(ALLOW)
    expect(await asked($, 'git push origin 0.49.0')).toBeUndefined()
  })

  test('a decision from a settings hook beneath stands', async ($, on) => {
    const b = await typed($, on, 'commit it')
    b.permissionBeneath = { decision: { behavior: 'deny', message: 'no' } }
    expect(await asked($, 'git commit -m "fix: 🐛 X."')).toEqual({ behavior: 'deny', message: 'no' })
  })

  for (const [text, actions] of [
    ['commit it', ['commit']],
    ['Commit.', ['commit']],
    ['ok commit', ['commit']],
    ['push', ['push']],
    ['push it to origin', ['push']],
    ['please commit everything and push it', ['commit', 'push']],
    ['go ahead and commit and push', ['commit', 'push']],
    ['my review is done, commit and push', ['commit', 'push']],
    ['commit & push', ['commit', 'push']],
    ['release 0.49.0', ['release']],
    ['create a new release', ['release']],
    ['cut a release', ['release']],
    ['commit, push and release', ['commit', 'push', 'release']],
    ['commit and push and release', ['commit', 'push', 'release']],
    ['Commit it. Push it. Release it.', ['commit', 'push', 'release']],
    ['great work! commit and push', ['commit', 'push']],
    ['commit now', ['commit']],
    ['go ahead and commit the changes', ['commit']],
    ['ok, commit this work', ['commit']],
    ['looks good, commit', ['commit']],
    ["let's commit the fix", ['commit']],
    ['nice work, commit the staged files and push the branch', ['commit', 'push']],
    ['push to origin', ['push']],
    ['merge it into main', ['merge']],
    ['go ahead and merge the PR', ['merge']],
    ['merge locally', ['merge']],
  ] as const) {
    test(`a request names exactly its actions: ${JSON.stringify(text)}`, () => {
      expect(requestedOf(text).sort()).toEqual([...actions].sort())
    })
  }
})

describe('AC4: an action the prompt did not name is still refused, and the approval ends with the turn', () => {
  test('"commit" approves no push and no release', async ($, on) => {
    const b = await typed($, on, 'commit it')
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
    expect(await bash($, b, 'git push')).toMatch(DECLINED.push)
    expect(await bash($, b, 'git commit -m "fix: 🐛 Y." && git push')).toMatch(DECLINED.push)
    expect(await bash($, b, 'gh release create 1.0.0')).toMatch(DECLINED.release)
    expect(await asked($, 'git push')).toBeUndefined()
    expect(await asked($, 'gh release create 1.0.0')).toBeUndefined()
  })

  test('"push" approves no commit', async ($, on) => {
    const b = await typed($, on, 'push')
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toMatch(DECLINED.commit)
    expect(await asked($, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
  })

  test('a release needs a typed request: a pick does not approve one', async ($, on) => {
    const b = await typed($, on, 'my review is done')
    await pick($, b)
    expect(await bash($, b, 'gh release create 1.0.0')).toMatch(DECLINED.release)
    expect(await bash($, b, 'gh api -X POST repos/o/r/releases -f tag_name=1.0.0')).toMatch(DECLINED.release)
    expect(await bash($, b, 'gh release view 1.0.0')).toBeUndefined()
    expect(await bash($, b, 'gh api repos/o/r/releases/latest')).toBeUndefined()
  })

  test('two commits, pushes or releases on one line are refused under a request', async ($, on) => {
    const b = await typed($, on, 'commit, push and release')
    expect(await bash($, b, 'git commit -m "fix: 🐛 A."; git commit -m "fix: 🐛 B."')).toBe(ONE_REFUSAL)
    expect(await bash($, b, 'git push && git push --tags')).toBe(ONE_REFUSAL)
    expect(await bash($, b, 'gh release create 1 && gh release create 2')).toBe(ONE_REFUSAL)
  })

  for (const text of [
    "don't commit yet",
    'do not commit',
    'commit later',
    'should I commit?',
    'can you commit and push?',
    'ready to commit?',
    'commit after the tests pass',
    'commit, but not push',
    'push once CI is green',
    'wait before you push',
    'hold the push',
    'never release on a Friday',
    'if it looks good, commit',
    'commit when you are done',
    'commit it, then wait for me before pushing',
    'Don’t commit',
    'go ahead and commit the changes once the suite is green',
    "don't commit the changes yet",
    'could you commit the changes',
    'go ahead and commit the changes?',
    'merge it into main if CI passes',
    'commit it as long as the tests pass',
    'commit it so long as the build is green',
    'commit it, assuming CI is green',
    'push it provided the diff is clean',
    'push it providing the diff is clean',
    'commit it given the review passed',
    'commit it pending the review',
    'commit it in case I forget',
    'commit it supposing the tests pass',
    'commit it depending on the review',
    'commit it, barring a failure',
    "commit it, it isn't done",
    'commit it, it isnt done',
    "commit it, the review hasn't finished",
    "commit it, the tests haven't run",
    "commit it, the checks aren't green",
    "commit it, the build wasn't run",
    "commit it, the checks weren't green",
    'you need not push it',
    "you needn't push it",
    "you mustn't push it",
    'you must not push it',
    'commit only the docs',
  ]) {
    test(`a negated, deferred or question-form prompt approves nothing: ${JSON.stringify(text)}`, async ($, on) => {
      expect(requestedOf(text)).toEqual([])
      const b = await typed($, on, text)
      expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toMatch(DECLINED.commit)
      expect(await bash($, b, 'git push')).toMatch(DECLINED.push)
      expect(await asked($, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
    })
  }

  for (const text of [
    'the commit message looks wrong',
    'push notifications are broken',
    'the release notes need a fix',
    'I committed it already',
    'review the commit history',
    '```\ngit commit -m x\npush\n```',
    '> commit and push',
    '<command-message>commit and push</command-message>',
    'explain why you want to commit',
    'release the lock in foo.ts',
    'commit to option B',
    'push on with the refactor',
    'merge conflicts are a pain',
    'the merged list looks right',
    'release the hold on the queue',
    'Here is the earlier reply:\nThe tree is staged.\nTwo files changed.\nThe suite passes.\nCommit it.\nNothing else is left.',
    'The label read "Commit it." in the dialog',
    '"Commit it."',
  ]) {
    test(`a prompt that only mentions an action approves nothing: ${JSON.stringify(text)}`, () => {
      expect(requestedOf(text)).toEqual([])
    })
  }

  test("Mike's next prompt ends the approval, folded into the turn or not", async ($, on) => {
    const b = await typed($, on, 'commit and push')
    await $.prompt.submit(prompt('thanks'))
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toMatch(DECLINED.commit)
    expect(await asked($, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
    await $.prompt.submit(prompt('commit and push'))
    await $.prompt.submit(prompt('one more thing', PERSON, 'running'))
    expect(await bash($, b, 'git push')).toMatch(DECLINED.push)
  })

  test('a new turn of any other origin ends it, and one folded into the turn keeps it', async ($, on) => {
    const b = await typed($, on, 'commit and push')
    await $.prompt.submit(prompt('agent finished', { kind: 'task-notification' }, 'running'))
    expect(await bash($, b, 'git push')).toBeUndefined()
    await $.prompt.submit(prompt('agent finished', { kind: 'task-notification' }))
    expect(await bash($, b, 'git push')).toMatch(DECLINED.push)
  })

  test('/clear ends it', async ($, on) => {
    const b = await typed($, on, 'commit it')
    await $.session.end({ reason: 'clear', sessionId: 's' } as never)
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toMatch(DECLINED.commit)
  })

  for (const line of [
    'git push && rm -rf /tmp/x',
    'git commit -m "fix: 🐛 X." && gh pr merge 3',
    'git push --force',
    'git push -f origin main',
    'git push origin +main',
    'git push origin :old',
    'git push --delete origin old',
    'git push 2>&1 | tail -3',
    'git push > /tmp/out',
    'git -C "$(pwd)" push',
    'git push origin "$BRANCH"',
    'HUSKY=0 git commit -m "fix: 🐛 X."',
    'env git push',
    'bash -c "git push"',
    'git log',
    "$'\\x67it' push",
    'git -c core.hooksPath=/x commit -m m',
    'git -c core.fsmonitor=/x commit',
    'git -c core.sshCommand=/x push',
    'git --exec-path=/x push',
    'git push --receive-pack=/x',
    'git push --exec=/x',
    'git --git-dir=/repo/.git commit -m m',
    'git push git@github.com:other/repo.git main',
    'git push https://example.com/r.git main',
    'git push upstream main',
    'git push origin other-branch',
    'git push origin main:other',
    'git push origin HEAD:main',
    'git push --tags',
    'git push origin --tags',
    'git push -u origin main',
    'git push origin 9.9.9',
    'git commit --amend -m "fix: 🐛 X."',
    'git commit --no-verify -m "fix: 🐛 X."',
    'git commit -n -m "fix: 🐛 X."',
    'git commit -m',
    'gh release create 1.0.0 -R other/repo',
    'gh release create 1.0.0 --repo=other/repo',
    'gh -R other/repo release create 1.0.0',
    'git -C /other commit -m "fix: 🐛 X."',
    'git -C /repo/link commit -m "fix: 🐛 X."',
    'git -C /repo/../other commit -m "fix: 🐛 X."',
    'git -C relative commit -m "fix: 🐛 X."',
    'git -C /repo -C /other commit -m x',
  ]) {
    test(`the dialog is left to Mike for a line that does more than an approved action: ${JSON.stringify(line)}`, async ($, on) => {
      project(await typed($, on, 'commit, push and release'))
      expect(await asked($, line)).toBeUndefined()
    })
  }

  test('a release in a session that points gh at another repository gets the dialog', async ($, on) => {
    project(await typed($, on, 'release it', { env: { HOME, GH_REPO: 'other/repo' } }))
    expect(await asked($, 'gh release create 1.0.0')).toBeUndefined()
  })

  test('requestedCallsOf reads each call, and refuses a line with one it does not name', () => {
    expect(requestedCallsOf('git commit -m "fix: 🐛 X."', ['commit'])).toEqual([{ action: 'commit' }])
    expect(requestedCallsOf('git -C /a push origin main', ['push'])).toEqual([{ action: 'push', dir: '/a', remote: 'origin', ref: 'main' }])
    expect(requestedCallsOf('git push', ['commit'])).toBeUndefined()
    expect(requestedCallsOf('git push', ['release'])).toEqual([{ action: 'push' }])
    expect(requestedCallsOf('gh release create 1', ['commit', 'push'])).toBeUndefined()
    expect(requestedCallsOf('', ['commit'])).toBeUndefined()
    for (const line of ['git -c core.hooksPath=/x commit -m m', 'git --exec-path=/x push', 'git -C relative commit -m "fix: 🐛 M."', 'git -C /a/../b push']) {
      expect(requestedCallsOf(line, ['commit', 'push'])).toBeUndefined()
    }
  })

  test('releasesOf counts a gh release create and a release write through gh api', () => {
    expect(releasesOf('gh release create 1.0.0')).toBe(1)
    expect(releasesOf('gh -R o/r release create 1.0.0')).toBe(1)
    expect(releasesOf('gh api --method POST repos/o/r/releases')).toBe(1)
    expect(releasesOf('gh release list && gh release view 1')).toBe(0)
    expect(releasesOf('echo gh release create')).toBe(1)
    expect(releasesOf('grep release create notes.md')).toBe(0)
  })
})

describe('AC5: no other turn and no sub-agent gains an approval', () => {
  for (const origin of [
    { kind: 'peer' },
    { kind: 'peer-send-message' },
    { kind: 'channel', server: 'slack' },
    { kind: 'plugin', name: 'x' },
    { kind: 'sdk' },
    { kind: 'task-notification' },
    { kind: 'projects-relay' },
  ] as PromptOrigin[]) {
    test(`a ${origin.kind} prompt that asks for a commit, a push and a release approves nothing`, async ($, on) => {
      const b = bench(on)
      await $.session.start(start())
      await $.prompt.submit(prompt('commit and push and release', origin))
      expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toMatch(origin.kind === 'task-notification' ? DECLINED.commit : exactly(COMMIT_REFUSAL))
      expect(await bash($, b, 'git push')).toMatch(origin.kind === 'task-notification' ? DECLINED.push : exactly(PUSH_REFUSAL))
      expect(await bash($, b, 'gh release create 1.0.0')).toMatch(DECLINED.release)
      expect(await asked($, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
    })
  }

  test('a scheduled fire typed through the composer approves nothing, and its turn is ungated as before', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    await $.prompt.submit(prompt('<scheduled-task name="tick">commit and push</scheduled-task>'))
    expect(await asked($, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
    await $.prompt.submit(prompt('back at the desk', { kind: 'peer' }))
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBe(COMMIT_REFUSAL)
  })

  test("a sub-agent's permission dialog is never answered, even inside Mike's request", async ($, on) => {
    await typed($, on, 'commit and push')
    expect(await asked($, 'git commit -m "fix: 🐛 X."', 'a1')).toBeUndefined()
    expect(await asked($, 'git push', 'a1')).toBeUndefined()
  })

  test('an unattended session answers no dialog: the pipeline has its own hook', async ($, on) => {
    bench(on, { env: { HOME, WORKBENCH_DEV_TEAM_PIPELINE: '1' } })
    await $.session.start(start())
    await $.prompt.submit(prompt('commit and push'))
    expect(await asked($, 'git push')).toBeUndefined()
  })

  test('a top-level --agent run answers no dialog', async ($, on) => {
    bench(on, { env: { HOME, CLAUDE_CODE_AGENT: 'watson' } })
    await $.session.start(start())
    await $.prompt.submit(prompt('commit and push'))
    expect(await asked($, 'git push')).toBeUndefined()
  })
})

const RELEASE_SPELLINGS = [
  'gh release create 1.0.0',
  'gh release create 1.0.0 -R other/repo',
  'gh release create 1.0.0 --repo other/repo',
  'gh release create 1.0.0 --repo=other/repo',
  'gh -R other/repo release create 1.0.0',
  'gh --repo other/repo release create 1.0.0',
  'GH_REPO=other/repo gh release create 1.0.0',
  'gh api -X POST repos/o/r/releases -f tag_name=1.0.0',
  'cd /repo && gh release create 1.0.0 --notes x',
  "bash -c 'gh release create 1.0.0'",
]

describe('AC5: a sub-agent or a pipeline run cannot publish a release', () => {
  for (const line of RELEASE_SPELLINGS) {
    test(`a sub-agent's release is refused in every spelling, inside Mike's release request: ${JSON.stringify(line)}`, async ($, on) => {
      const b = project(await typed($, on, 'commit, push and release'))
      expectDenied(line, await bash($, b, line, 'a1'), AGENT_RELEASE_REFUSAL)
      expect(b.inputs.filter(input => input.tool === 'AskUserQuestion')).toEqual([])
    })

    test(`a pipeline run's release is refused: ${JSON.stringify(line)}`, async ($, on) => {
      const b = bench(on, { env: { HOME, WORKBENCH_DEV_TEAM_PIPELINE: '1' } })
      await $.session.start(start())
      await $.prompt.submit(prompt('release it'))
      expectDenied(line, await bash($, b, line), AGENT_RELEASE_REFUSAL)
    })
  }

  test('a top-level --agent run cannot release either', async ($, on) => {
    const b = bench(on, { env: { HOME, CLAUDE_CODE_AGENT: 'watson' } })
    await $.session.start(start())
    await $.prompt.submit(prompt('release it'))
    expect(await bash($, b, 'gh release create 1.0.0')).toBe(AGENT_RELEASE_REFUSAL)
  })

  test('a line that names a release and that the reader cannot read whole is refused for a sub-agent', async ($, on) => {
    const b = await typed($, on, 'release it')
    expect(await bash($, b, 'gh release "$VERB" 1.0.0', 'a1')).toBe(AGENT_RELEASE_REFUSAL)
  })

  test("a sub-agent's other gh lines run, and its commit and push meet the commit guard", async ($, on) => {
    const b = await typed($, on, 'release it')
    for (const line of AGENT_RUNS) expectRuns(line, await bash($, b, line, 'a1'))
    for (const line of ['git commit -m "fix: 🐛 X."', 'git push']) expect(await bash($, b, line, 'a1')).toBe(SUBAGENT_REFUSAL.deny)
  })

  test('agentReleaseRefusalOf refuses each release and each unread line that names one, and nothing else', () => {
    for (const line of RELEASE_SPELLINGS) expect(agentReleaseRefusalOf(line)).toBe(AGENT_RELEASE_REFUSAL)
    expect(releasesOf("$'\\u0067h' release create 1")).toBe(0)
    expect(agentReleaseRefusalOf("$'\\u0067h' release create 1")).toBe(AGENT_RELEASE_REFUSAL)
    expect(agentReleaseRefusalOf("$'\\x67it' push")).toBeUndefined()
    expect(agentReleaseRefusalOf('gh release view 1 && gh release list')).toBe(AGENT_RELEASE_REFUSAL)
    expect(agentReleaseRefusalOf('git commit -m "fix: 🐛 X."')).toBeUndefined()
    for (const line of AGENT_RUNS) expect(agentReleaseRefusalOf(line)).toBeUndefined()
  })

  test('unreadReleasesOf counts a gh line an expansion may turn into a release, and releasesOf the new spellings', () => {
    for (const line of EXPANDED_RELEASES) expect([line, agentReleaseRefusalOf(line), unreadReleasesOf(line)]).toEqual([line, AGENT_RELEASE_REFUSAL, /gh api/.test(line) ? 0 : 1])
    expect(releasesOf("gh api graphql -f query='mutation { createRelease(input: {tagName: \"v1\"}) { clientMutationId } }'")).toBe(1)
    expect(releasesOf('gh api -XPOST repos/o/r/releases')).toBe(1)
    expect(unreadReleasesOf('gh release create "$TAG"')).toBe(0)
    expect(releasesOf('gh release create "$TAG"')).toBe(1)
    expect(unreadReleasesOf('gh api -X POST "repos/$R/releases"')).toBe(0)
    for (const line of NOT_RELEASES) expect(unreadReleasesOf(line) + releasesOf(line)).toBe(0)
    for (const line of STDIN_RELEASES) expect(releasesOf(line)).toBe(1)
  })

  test('an expansion counts in the endpoint, the method and a graphql query, and nowhere else', () => {
    for (const line of [
      'gh api "repos/$R/pulls" -f title=x',
      'gh api -X PATCH "repos/$R/pulls/1"',
      'gh api --input body.json "repos/$R/x"',
      'gh api -X "$M" repos/o/r/x',
      'gh api --method="$M" repos/o/r/x',
      'gh api -X"$M" repos/o/r/x',
      'gh api graphql -f query="$Q"',
      'gh api graphql -F query="mutation{$M}"',
      'gh api graphql --raw-field=query="$(cat q.graphql)"',
      'gh api graphql -f query=$Q',
      'gh api graphql -fquery="`cat q`"',
      'gh api graphql -f query="${Q}" <<\'EOF\'\nx\nEOF',
    ]) {
      expect([line, agentReleaseRefusalOf(line), unreadReleasesOf(line)]).toEqual([line, AGENT_RELEASE_REFUSAL, 0])
    }
    for (const line of [
      "gh api graphql -f query='query($owner:String!){x}' -F owner=\"$OWNER\"",
      "gh api graphql -f query='query($o:String!){x}' -f owner=x",
      'gh api graphql -f query=\'query{viewer{login}}\' -F owner="$O"',
      "gh api graphql -f query='query($o:String!){x}' -F o=\"$o\"",
      "gh api graphql -f query='query($owner:String!){x}' -F owner=\"$O\" <<'EOF'\n$X\nEOF",
      "gh api graphql -f query=$'query($o:String!){x}'",
      'gh api graphql -f query=query\\(\\$o:String!\\){x}',
    ]) {
      expect([line, agentReleaseRefusalOf(line), unreadReleasesOf(line)]).toEqual([line, undefined, 0])
    }
  })
})

const EXPANDED_RELEASES = ['r=rel; s=ease; gh $r$s create v1', 'gh "$SUB" create v1', 'gh -R o/r "$SUB" create v1', 'gh release "$VERB" v1', 'gh api "$PATH" -f tag_name=v1']

const STDIN_RELEASES = [
  `gh api graphql --input - <<'EOF'\n{"query":"mutation{createRelease(input:{tagName:\\"v1\\"}){clientMutationId}}"}\nEOF`,
  `echo '{"query":"mutation{createRelease(input:{tagName:\\"v1\\"}){clientMutationId}}"}' | gh api graphql --input -`,
]

const SHAPED_RELEASES = ["gh $'r\\u0065lease' create v1", 'gh {release,create} v1', 'gh release {create,} v1', 'gh rel{ease,} create v1']

const HIDDEN_RELEASES = [
  ...EXPANDED_RELEASES.slice(0, 2),
  "gh api graphql -f query='mutation { createRelease(input: {tagName: \"v1\"}) { clientMutationId } }'",
  'gh api -XPOST repos/o/r/releases',
  ...STDIN_RELEASES,
  ...SHAPED_RELEASES,
]

const PLAIN_RELEASE_WORK = [
  'gh release edit v1 --draft=false',
  'gh release upload v1 dist/a.zip',
  'gh release delete v1 --yes',
  'gh release list',
  "gh api graphql -f query='mutation { updateRelease(input: {id: \"R\", isDraft: false}) { clientMutationId } }'",
  "gh api graphql -f query='mutation { deleteRelease(input: {id: \"R\"}) { clientMutationId } }'",
  'gh api repos/o/r/releases',
]

describe('AC23: an agent runs no gh release command, releases endpoint or Release mutation, in any shape', () => {
  for (const line of [...SHAPED_RELEASES, ...PLAIN_RELEASE_WORK]) {
    test(`a sub-agent: ${JSON.stringify(line)}`, async ($, on) => {
      const b = await typed($, on, 'commit, push and release')
      expectDenied(line, await bash($, b, line, 'a1'), AGENT_RELEASE_REFUSAL)
    })

    for (const env of [{ WORKBENCH_DEV_TEAM_PIPELINE: '1' }, { CLAUDE_CODE_AGENT: 'watson' }] as Record<string, string>[]) {
      test(`${Object.keys(env)[0]}: ${JSON.stringify(line)}`, async ($, on) => {
        const b = bench(on, { env: { HOME, ...env } })
        await $.session.start(start())
        await $.prompt.submit(prompt('release it'))
        expectDenied(line, await bash($, b, line), AGENT_RELEASE_REFUSAL)
      })
    }
  }

  test('the shape rule, read directly: a word that is not plain text up to the subcommand is refused, and a value is not', () => {
    for (const line of ['{g,}h release create v1', '/usr/local/bin/g? pr view 7', 'gh p{r,} view 7', 'gh "$SUB" view 7', 'gh --re{po,}=o/r pr view 7', "gh $'\\x72elease' list", 'sudo gh rel*ase list']) {
      expect([line, agentReleaseRefusalOf(line)]).toEqual([line, AGENT_RELEASE_REFUSAL])
    }
    for (const line of ['gh frobnicate "$X"', 'gh -R "$REPO" pr view 7', 'gh --repo="$REPO" pr view 7', 'gh api repos/{owner}/{repo}/pulls', '[ -n "$x" ] && gh pr view 7', 'env A="$X" gh pr list']) {
      expect([line, agentReleaseRefusalOf(line)]).toEqual([line, undefined])
    }
  })
})

describe("AC25: Mike's main session keeps the plain f94ba45 rule, and the hidden shapes need his request", () => {
  test('plain release work other than gh release create runs with no request, as at f94ba45', async ($, on) => {
    const b = project(await typed($, on, 'commit and push'))
    for (const line of [...PLAIN_RELEASE_WORK, 'gh release view v1']) expectRuns(line, await bash($, b, line))
  })
})

const LANES: [string, Record<string, string> | undefined][] = [
  ['a sub-agent', undefined],
  ['the pipeline', { WORKBENCH_DEV_TEAM_PIPELINE: '1' }],
  ['a top-level agent run', { CLAUDE_CODE_AGENT: 'watson' }],
  ['a plain claude -p session', {}],
]

async function inLane($: Engine, on: On, env: Record<string, string> | undefined): Promise<(line: string) => Promise<string | undefined>> {
  if (env === undefined) {
    const b = await typed($, on, 'commit, push and release')
    return line => bash($, b, line, 'a1')
  }
  const b = bench(on, { env: { HOME, ...env } })
  await $.session.start(start(false))
  await $.prompt.submit(prompt('release it', { kind: 'sdk' }))
  return line => bash($, b, line)
}

const PIPELINE_READS = ['gh api --paginate "repos/$REPO/branches"', 'gh api "repos/$REPO/compare/$BASE...$wr_b"', 'gh api --paginate "repos/$REPO/issues/$ISSUE/comments"']

const MAIN_API_WRITES = ['gh api -X PATCH "repos/$REPO/pulls/1" -f title=x', 'gh api -X POST "repos/$REPO/issues/5/comments" -f body=hi']

const AGENT_REFUSED = [
  ...MAIN_API_WRITES,
  'gh api -X POST "repos/$R/releases"',
  'gh api "repos/$R/releases" -f tag_name=v1',
  'gh api -iX DELETE repos/o/r/releases/1',
  'gh api -iX POST repos/o/r/releases',
  "gh alias set rc 'release create'",
  "gh alias set --shell rc 'gh release create \"$1\"'",
  'gh alias list',
  'gh extension install o/gh-x',
  'gh ext install o/gh-x',
  'gh api graphql --input q.json',
  'gh api graphql -F query=@q.graphql',
  "gh api graphql -f query='query { viewer { l\\u006fgin } }'",
  'gh release create v1',
]

const AGENT_RUNS_TOO = [...PIPELINE_READS, 'gh -R"$REPO" pr view 5', 'gh -R$REPO pr view 5', 'echo {a,b} x', 'gh api -iX GET "repos/$R/pulls"']

describe('AC29 to AC34: the agent guard defends against mistakes, in every unattended lane', () => {
  for (const [lane, env] of LANES) {
    test(`${lane}: releases, aliases, extensions and unread graphql are refused`, async ($, on) => {
      const run = await inLane($, on, env)
      for (const line of AGENT_REFUSED) expectDenied(line, await run(line), AGENT_RELEASE_REFUSAL)
    })

    test(`${lane}: pipeline reads, an attached -R and a brace that is not a command run`, async ($, on) => {
      const run = await inLane($, on, env)
      for (const line of AGENT_RUNS_TOO) expect([line, await run(line)]).toEqual([line, undefined])
    })

    test(`${lane}: a line the reader cannot read whole that runs no gh gets the general reason`, async ($, on) => {
      const run = await inLane($, on, env)
      expect(await run("echo $'\\u0041'")).toBe(UNREAD_LINE_REFUSAL)
    })
  }

  test("AC36: Mike's main session runs a gh api write to an expanding endpoint with no release request, as at f94ba45", async ($, on) => {
    const b = project(await typed($, on, 'commit and push'))
    for (const line of MAIN_API_WRITES) expect([line, await bash($, b, line)]).toEqual([line, undefined])
    for (const line of ['gh release create v1', ...SHAPED_RELEASES.slice(1), '{g,}h release create v1']) expectDenied(line, await bash($, b, line), DECLINED.release)
  })

  test("Mike's main session runs the pipeline reads and an unread line with no request", async ($, on) => {
    const b = project(await typed($, on, 'commit and push'))
    for (const line of [...PIPELINE_READS, "echo $'\\u0041'"]) expectRuns(line, await bash($, b, line))
  })
})

describe('AC35: the hidden spellings Holmes listed, at unit level and in the main session', () => {
  const SPELLED = ['{g,}h release create v1', "$'gh' release create 1", 'g\\h release create v1']

  test('T2: unreadReleasesOf counts each, and a brace that is not a command is no release', () => {
    for (const line of SPELLED) expect([line, unreadReleasesOf(line)]).toEqual([line, 1])
    expect(agentReleaseRefusalOf('echo {a,b} x')).toBeUndefined()
  })

  for (const line of SPELLED) {
    test(`T2: the main session refuses ${JSON.stringify(line)} with no request, and gives no allow under one`, async ($, on) => {
      const b = project(await typed($, on, 'commit and push'))
      expect(await bash($, b, line)).toMatch(DECLINED.release)
      await $.prompt.submit(prompt('release it'))
      expect(await asked($, line)).toBeUndefined()
    })
  }

  test('T1: a graphql query the line does not hold is refused for an agent, with no createRelease in sight', () => {
    for (const line of ['gh api graphql --input q.json', 'gh api graphql -F query=@q.graphql', "gh api graphql -f query='query { viewer { l\\u006fgin } }'"]) {
      expect([line, /createRelease/i.test(line), agentReleaseRefusalOf(line)]).toEqual([line, false, AGENT_RELEASE_REFUSAL])
    }
    expect(agentReleaseRefusalOf("gh api graphql --input - <<'EOF'\n{\"query\":\"query { viewer { login } }\"}\nEOF")).toBeUndefined()
  })

  test('T3: a gh line inside bash -c is read at its own offsets', () => {
    expect(unreadReleasesOf("bash -c 'A=1 gh \"$SUB\" create v1'")).toBe(1)
    expect(unreadReleasesOf("bash -c 'A=1 gh pr view \"$N\"'")).toBe(0)
  })
})

describe('AC26: the mark offset holds past assignments, wrappers and nesting', () => {
  test('unreadReleasesOf reads the mark at the right word after a prefix', () => {
    for (const line of ['env gh "$SUB" create v1', 'sudo gh release "$VERB" v1']) expect([line, unreadReleasesOf(line)]).toEqual([line, 1])
    expect(agentReleaseRefusalOf('A=1 gh api graphql -f query="$Q"')).toBe(AGENT_RELEASE_REFUSAL)
    expect(agentReleaseRefusalOf('A=1 gh api graphql -f query=q -F x="$Q"')).toBeUndefined()
    expect(unreadReleasesOf('A="$X" gh pr view 7')).toBe(0)
  })
})

const PROSE_GUARD = 'Outbound prose guard (workbench-core)'
const OTHER_GUARDS: ReadonlyMap<string, string> = new Map([
  ['gh api repos/o/r/issues/1/comments -f body="$B"', PROSE_GUARD],
  ["gh api repos/o/r/issues/1/comments -f body='costs $5'", PROSE_GUARD],
  ...STDIN_RELEASES.slice(1).map(line => [line, PROSE_GUARD] as [string, string]),
  ['grep -rn gh "$DIR"', 'Whole-disk search guard (workbench-core)'],
  [SHAPED_RELEASES[0] as string, 'Provisioning guard (workbench-core)'],
  ['gh api graphql --input q.json', PROSE_GUARD],
  ['gh api graphql -F query=@q.graphql', PROSE_GUARD],
])

function expectDenied(line: string, deny: string | undefined, expected: string | RegExp): void {
  const guard = OTHER_GUARDS.get(line)
  if (guard !== undefined) expect([line, deny?.startsWith(guard)]).toEqual([line, true])
  else if (typeof expected === 'string') expect([line, deny]).toEqual([line, expected])
  else expect([line, deny, expected.test(deny ?? '')]).toEqual([line, deny, true])
}

function expectRuns(line: string, deny: string | undefined): void {
  const guard = OTHER_GUARDS.get(line)
  expect([line, guard === undefined ? deny : deny?.startsWith(guard)]).toEqual([line, guard === undefined ? undefined : true])
}

const NOT_RELEASES = [
  'gh release view 1.0.0',
  'gh release list',
  'gh api repos/o/r/releases/latest',
  'gh pr view "$N"',
  'gh -R "$REPO" pr view 7',
  'gh issue comment "$N" --body x',
  'gh api repos/o/r/issues/1/comments -f body="$B"',
  "gh api graphql -f query='query($owner:String!){repository(owner:$owner,name:\"r\"){id}}' -f owner=o",
  "gh api repos/o/r/issues/1/comments -f body='costs $5'",
  'grep -rn gh "$DIR"',
  'brew upgrade gh "$x"',
  'cp -r ~/.config/gh "$DEST"',
  'echo "$SUB" create v1',
]

const AGENT_RUNS = [...NOT_RELEASES.filter(line => !/release/.test(line)), 'gh frobnicate "$X"', 'gh frobnicate --level="$L" now', 'A="$X" gh pr view 7']

describe('AC13: a release spelled through an expansion or a graphql mutation is refused in every agent lane', () => {
  for (const line of HIDDEN_RELEASES) {
    test(`a sub-agent: ${JSON.stringify(line)}`, async ($, on) => {
      const b = await typed($, on, 'commit, push and release')
      expectDenied(line, await bash($, b, line, 'a1'), AGENT_RELEASE_REFUSAL)
    })

    for (const env of [{ WORKBENCH_DEV_TEAM_PIPELINE: '1' }, { CLAUDE_CODE_AGENT: 'watson' }] as Record<string, string>[]) {
      test(`${Object.keys(env)[0]}: ${JSON.stringify(line)}`, async ($, on) => {
        const b = bench(on, { env: { HOME, ...env } })
        await $.session.start(start())
        await $.prompt.submit(prompt('release it'))
        expectDenied(line, await bash($, b, line), AGENT_RELEASE_REFUSAL)
      })
    }
  }
})

describe("AC14: in Mike's main session a hidden release needs his release request, and still gets the dialog", () => {
  for (const line of HIDDEN_RELEASES) {
    test(`refused with no release request, and no allow under one: ${JSON.stringify(line)}`, async ($, on) => {
      const b = project(await typed($, on, 'commit and push'))
      expectDenied(line, await bash($, b, line), EXPANDED_RELEASES.slice(0, 2).includes(line) ? PLAIN_REFUSAL.deny : DECLINED.release)
      await $.prompt.submit(prompt('release it'))
      const deny = await bash($, b, line)
      if (EXPANDED_RELEASES.slice(0, 2).includes(line)) expectDenied(line, deny, PLAIN_REFUSAL.deny)
      else expectRuns(line, deny)
      expect(await asked($, line)).toBeUndefined()
    })
  }

  test('a main-session line that is not a release runs under a commit and push request', async ($, on) => {
    const b = project(await typed($, on, 'commit and push'))
    for (const line of NOT_RELEASES) expectRuns(line, await bash($, b, line))
  })

  for (const env of [{ WORKBENCH_DEV_TEAM_PIPELINE: '1' }, { CLAUDE_CODE_AGENT: 'watson' }] as Record<string, string>[]) {
    test(`${Object.keys(env)[0]}: a line that is not a release is not refused`, async ($, on) => {
      const b = bench(on, { env: { HOME, ...env } })
      await $.session.start(start())
      await $.prompt.submit(prompt('go'))
      for (const line of AGENT_RUNS) expectRuns(line, await bash($, b, line))
    })
  }
})

describe("AC6: Mike's main session keeps the release rule", () => {
  test('a typed release request still approves the release, and no request still refuses it', async ($, on) => {
    const b = project(await typed($, on, 'release it'))
    expect(await bash($, b, 'gh release create 0.49.0 --notes x')).toBeUndefined()
    await $.prompt.submit(prompt('looks good'))
    expect(await bash($, b, 'gh release create 0.49.0 --notes x')).toMatch(DECLINED.release)
    await pick($, b)
    expect(await bash($, b, 'gh release create 0.49.0 --notes x')).toMatch(DECLINED.release)
  })

  test('a release line in the main session never gets the sub-agent refusal', async ($, on) => {
    const b = project(await typed($, on, 'commit it'))
    for (const line of RELEASE_SPELLINGS) expect(await bash($, b, line)).not.toBe(AGENT_RELEASE_REFUSAL)
  })
})

describe('AC8: a "Commit it" pick lets its commit run with no permission dialog, and a push needs its own pick', () => {
  test('the plain commit gets allow, the push never does under it, and a push pick allows the push', async ($, on) => {
    const b = project(await typed($, on, 'review done'))
    await pick($, b)
    expect(await asked($, 'git commit -m "fix: 🐛 X."')).toEqual(ALLOW)
    expect(await asked($, 'git -C /repo commit -F /tmp/message.txt')).toEqual(ALLOW)
    expect(await asked($, 'git push')).toBeUndefined()
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
    expect(await asked($, 'git push')).toBeUndefined()
    expect(await bash($, b, 'git push')).toMatch(DECLINED.push)
    await pick($, b, PUSH_QUESTION, 'Push')
    expect(await asked($, 'git push')).toEqual(ALLOW)
    expect(await asked($, 'git push origin main')).toEqual(ALLOW)
    expect(await asked($, 'git commit -m "fix: 🐛 Y."')).toBeUndefined()
  })
})

describe('AC9: a pick approves one plain commit, and nothing more', () => {
  for (const line of [
    'git commit --amend -m "fix: 🐛 X."',
    'git commit --no-verify -m "fix: 🐛 X."',
    'git -C /other commit -m "fix: 🐛 X."',
    'git commit -m "fix: 🐛 X." && git commit -m "fix: 🐛 Y."',
    'git push origin --tags',
    'gh release create 1.0.0',
  ]) {
    test(`a line a pick does not cover gets the dialog: ${JSON.stringify(line)}`, async ($, on) => {
      const b = project(await typed($, on, 'review done'))
      await pick($, b)
      expect(await asked($, line)).toBeUndefined()
    })
  }

  test('a second commit after the pick was used gets the dialog, and so does a second push', async ($, on) => {
    const b = project(await typed($, on, 'review done'))
    await pick($, b)
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
    expect(await asked($, 'git commit -m "fix: 🐛 Y."')).toBeUndefined()
    await pick($, b, PUSH_QUESTION, 'Push')
    expect(await bash($, b, 'git push')).toBeUndefined()
    expect(await asked($, 'git push')).toBeUndefined()
  })

  test('a commit and its push on one line get the dialog, before and after the commit lands', async ($, on) => {
    const b = project(await typed($, on, 'review done'))
    await pick($, b)
    expect(await asked($, 'git commit -m "fix: 🐛 X." && git push')).toBeUndefined()
    expect(await bash($, b, 'git commit -m "fix: 🐛 X." && git push')).toMatch(DECLINED.push)
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
    expect(await asked($, 'git commit -m "fix: 🐛 X." && git push')).toBeUndefined()
    expect(await asked($, 'git push')).toBeUndefined()
  })

  test('a merge pick answers a plain gh pr merge, and a typed merge request does too', async ($, on) => {
    const b = project(await typed($, on, 'review done'))
    expect(await asked($, 'gh pr merge 12 --squash')).toBeUndefined()
    await pick($, b, MERGE_QUESTION, 'Merge it')
    expect(await asked($, 'gh pr merge 12 --squash')).toEqual(ALLOW)
    expect(await asked($, 'gh pr merge 12 -R other/repo')).toBeUndefined()
    await $.prompt.submit(prompt('go ahead and merge the PR'))
    expect(await asked($, 'gh pr merge --merge --delete-branch')).toEqual(ALLOW)
  })

  test("a sub-agent's call and a call after Mike's next prompt get the dialog", async ($, on) => {
    const b = project(await typed($, on, 'review done'))
    await pick($, b)
    expect(await asked($, 'git commit -m "fix: 🐛 X."', 'a1')).toBeUndefined()
    await $.prompt.submit(prompt('wait, one more change'))
    expect(await asked($, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
  })
})
