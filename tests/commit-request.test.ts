import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptOrigin } from 'claude-code'

import {
  COMMIT_REFUSAL,
  ONE_REFUSAL,
  PATHSPEC_REFUSAL,
  PUSH_REFUSAL,
  RELEASE_REFUSAL,
  SHARED_LINE_REFUSAL,
  UNREAD_TREE_REFUSAL,
  changesIndexBeside,
  leftOutOf,
  leftOutRefusal,
  releasesOf,
  requestedCallsOf,
  requestedOf,
  shapeOf,
  unnamedOf,
} from '../hooks/mods/commit-approval'
import type { Bench } from './bench'
import { HOME, PERSON, bench, start } from './bench'
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

async function pick($: Engine, b: Bench): Promise<void> {
  b.pick = 'Commit it'
  expect((await $.tool.call({ tool: 'AskUserQuestion', questions: [COMMIT_QUESTION] } as never)).deny).toBeUndefined()
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
    const refusal = await bash($, b, 'git commit -m x')
    expect(refusal).toBe(leftOutRefusal(['notes/draft.md', 'README.md']))
    expect(refusal).toContain('notes/draft.md')
    expect(refusal).toContain('README.md')
    expect(refusal).not.toContain('hooks/new.ts')
    b.trees['/repo'] = entry('A ', 'hooks/new.ts') + entry('A ', 'notes/draft.md') + entry('M ', 'README.md')
    expect(await bash($, b, 'git commit -m x')).toBeUndefined()
  })

  test('a file staged in part is left out in part, so it is named', async ($, on) => {
    const b = await typed($, on, 'commit it')
    b.trees['/repo'] = entry('MM', 'a.ts') + entry('M ', 'b.ts')
    expect(await bash($, b, 'git commit -m x')).toBe(leftOutRefusal(['a.ts']))
  })

  test('a pick approves the commit, and the tree is still checked', async ($, on) => {
    const b = await typed($, on, 'my review is done')
    await pick($, b)
    b.trees['/repo'] = entry('??', 'stray.txt')
    expect(await bash($, b, 'git commit -m x')).toBe(leftOutRefusal(['stray.txt']))
    b.trees['/repo'] = entry('A ', 'stray.txt')
    expect(await bash($, b, 'git commit -m x')).toBeUndefined()
  })

  test('the tree is read in the repository the commit runs in', async ($, on) => {
    const b = await typed($, on, 'commit it', { env: { HOME } })
    b.trees['/other'] = entry('??', 'left.txt')
    expect(await bash($, b, 'git -C /other commit -m x')).toBe(leftOutRefusal(['left.txt']))
    expect(await bash($, b, 'git commit -m x')).toBeUndefined()
    expect(b.runs.filter(argv => argv[3] === 'status').map(argv => argv[2])).toEqual(['/other', '/repo'])
  })

  test('git commit -a takes the tracked changes, and still leaves an untracked file out', async ($, on) => {
    const b = await typed($, on, 'commit it')
    b.trees['/repo'] = entry(' M', 'a.ts') + entry(' D', 'gone.ts')
    expect(await bash($, b, 'git commit -am x')).toBeUndefined()
    b.trees['/repo'] = entry(' M', 'a.ts') + entry('??', 'new.ts')
    expect(await bash($, b, 'git commit -a -m x')).toBe(leftOutRefusal(['new.ts']))
  })

  for (const line of [
    'git reset -q HEAD f && git commit -m x',
    'git restore --staged f && git commit -m x',
    'git rm --cached f; git commit -m x',
    'git commit -m x; git reset HEAD~1',
    'git stash && git commit -m x',
    'git update-index --assume-unchanged f && git commit -m x',
  ]) {
    test(`a fully staged tree is still refused when the line can change the index beside the commit: ${line}`, async ($, on) => {
      const b = await typed($, on, 'commit it')
      b.trees['/repo'] = entry('M ', 'f') + entry('A ', 'g')
      expect(await bash($, b, line)).toBe(SHARED_LINE_REFUSAL)
    })
  }

  test('staging, reads and a push beside the commit leave the line alone', () => {
    for (const line of ['git add -A && git commit -m x', 'git status && git commit -m x', 'git commit -m x && git push', 'git diff --cached; git commit -m x']) {
      expect(changesIndexBeside(line)).toBe(false)
    }
  })

  for (const line of [
    'git commit -m x a.ts',
    'git commit -m x -- a.ts',
    'git commit --only -m x',
    'git commit -p',
    'git commit -i a.ts',
    'git commit --pathspec-from-file=list -m x',
    'git commit --pathspec-from=list -m x',
    'git commit --onl -m x',
    'git commit --inter',
    'git commit --incl -m x',
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
    expect(await bash($, b, 'git commit -m x')).toBe(UNREAD_TREE_REFUSAL)
  })

  test('a commit spelled through an alias cannot be read, so it is refused', async ($, on) => {
    const b = await typed($, on, 'commit it')
    expect(await bash($, b, 'git -c alias.ci=commit ci -m x')).toBe(UNREAD_TREE_REFUSAL)
  })

  test('a sub-agent and the pipeline are not checked here: they commit as before', async ($, on) => {
    const b = bench(on, { env: { HOME, WORKBENCH_DEV_TEAM_PIPELINE: '1' } })
    b.trees['/repo'] = entry('??', 'left.txt')
    await $.session.start(start())
    await $.prompt.submit(prompt('Item ID: 12'))
    expect(await bash($, b, 'git commit -m x a.ts')).toBeUndefined()
    expect(await bash($, b, 'git commit -m x', 'a1')).toBeUndefined()
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
    expect(await bash($, b, 'git commit -m x')).toBeUndefined()
  })

  nameTest('a folder named with its slash covers the files in it', async ($, on) => {
    const b = await typed($, on, 'commit it')
    b.trees['/repo'] = entry('M ', 'a.ts') + entry('??', 'dist/app.js') + entry('??', 'dist/app.css')
    b.shown = 'Leaving out dist/, a stray build artifact.'
    expect(await bash($, b, 'git commit -m x')).toBeUndefined()
  })

  nameTest('only the named file may stay out: an unnamed one is still refused, and named alone', async ($, on) => {
    const b = await typed($, on, 'commit it')
    b.trees['/repo'] = entry('??', '.env.local') + entry('??', 'notes.md')
    b.shown = 'Leaving out .env.local, which holds a secret.'
    expect(await bash($, b, 'git commit -m x')).toBe(leftOutRefusal(['notes.md']))
  })

  nameTest('a reply that does not name the file lets nothing through', async ($, on) => {
    const b = await typed($, on, 'commit it')
    b.trees['/repo'] = entry('??', '.env')
    b.shown = 'Committing the whole tree now.'
    expect(await bash($, b, 'git commit -m x')).toBe(leftOutRefusal(['.env']))
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
    expect(await bash($, b, 'git commit -m "chore: bump"')).toBeUndefined()
    expect(await bash($, b, 'git push origin main')).toBeUndefined()
    expect(b.calls.some(call => call.tool === 'AskUserQuestion')).toBe(false)
  })

  test('"commit and push and release" approves the release path: the bump commit, the push and gh release create', async ($, on) => {
    const b = await typed($, on, 'commit and push and release')
    expect(await bash($, b, 'git commit -m "feat: x"')).toBeUndefined()
    expect(await bash($, b, 'git commit -m "chore: 🔖 Bump version to 0.49.0."')).toBeUndefined()
    expect(await bash($, b, 'git push')).toBeUndefined()
    expect(await bash($, b, 'gh release create 0.49.0 --target main --title "0.49.0: x" --notes \'The gate reads the tree.\'')).toBeUndefined()
  })

  test('"release" alone covers the commit and the push a release needs', async ($, on) => {
    const b = await typed($, on, 'cut a release')
    expect(await bash($, b, 'git commit -m bump')).toBeUndefined()
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
      'git commit -m m',
      'git commit -am m',
      'git -C /repo commit -m x',
      'git -C /repo/sub commit -m x',
      'git -C /wt commit -m x',
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
    expect(await asked($, 'git commit -m x')).toEqual({ behavior: 'deny', message: 'no' })
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
  ] as const) {
    test(`a request names exactly its actions: ${JSON.stringify(text)}`, () => {
      expect(requestedOf(text).sort()).toEqual([...actions].sort())
    })
  }
})

describe('AC4: an action the prompt did not name is still refused, and the approval ends with the turn', () => {
  test('"commit" approves no push and no release', async ($, on) => {
    const b = await typed($, on, 'commit it')
    expect(await bash($, b, 'git commit -m x')).toBeUndefined()
    expect(await bash($, b, 'git push')).toBe(PUSH_REFUSAL)
    expect(await bash($, b, 'git commit -m y && git push')).toBe(PUSH_REFUSAL)
    expect(await bash($, b, 'gh release create 1.0.0')).toBe(RELEASE_REFUSAL)
    expect(await asked($, 'git push')).toBeUndefined()
    expect(await asked($, 'gh release create 1.0.0')).toBeUndefined()
  })

  test('"push" approves no commit', async ($, on) => {
    const b = await typed($, on, 'push')
    expect(await bash($, b, 'git commit -m x')).toBe(COMMIT_REFUSAL)
    expect(await asked($, 'git commit -m x')).toBeUndefined()
  })

  test('a release needs a typed request: a pick does not approve one', async ($, on) => {
    const b = await typed($, on, 'my review is done')
    await pick($, b)
    expect(await bash($, b, 'gh release create 1.0.0')).toBe(RELEASE_REFUSAL)
    expect(await bash($, b, 'gh api -X POST repos/o/r/releases -f tag_name=1.0.0')).toBe(RELEASE_REFUSAL)
    expect(await bash($, b, 'gh release view 1.0.0')).toBeUndefined()
    expect(await bash($, b, 'gh api repos/o/r/releases/latest')).toBeUndefined()
  })

  test('two commits, pushes or releases on one line are refused under a request', async ($, on) => {
    const b = await typed($, on, 'commit, push and release')
    expect(await bash($, b, 'git commit -m a; git commit -m b')).toBe(ONE_REFUSAL)
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
  ]) {
    test(`a negated, deferred or question-form prompt approves nothing: ${JSON.stringify(text)}`, async ($, on) => {
      expect(requestedOf(text)).toEqual([])
      const b = await typed($, on, text)
      expect(await bash($, b, 'git commit -m x')).toBe(COMMIT_REFUSAL)
      expect(await bash($, b, 'git push')).toBe(PUSH_REFUSAL)
      expect(await asked($, 'git commit -m x')).toBeUndefined()
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
    expect(await bash($, b, 'git commit -m x')).toBe(COMMIT_REFUSAL)
    expect(await asked($, 'git commit -m x')).toBeUndefined()
    await $.prompt.submit(prompt('commit and push'))
    await $.prompt.submit(prompt('one more thing', PERSON, 'running'))
    expect(await bash($, b, 'git push')).toBe(PUSH_REFUSAL)
  })

  test('a new turn of any other origin ends it, and one folded into the turn keeps it', async ($, on) => {
    const b = await typed($, on, 'commit and push')
    await $.prompt.submit(prompt('agent finished', { kind: 'task-notification' }, 'running'))
    expect(await bash($, b, 'git push')).toBeUndefined()
    await $.prompt.submit(prompt('agent finished', { kind: 'task-notification' }))
    expect(await bash($, b, 'git push')).toBe(PUSH_REFUSAL)
  })

  test('/clear ends it', async ($, on) => {
    const b = await typed($, on, 'commit it')
    await $.session.end({ reason: 'clear', sessionId: 's' } as never)
    expect(await bash($, b, 'git commit -m x')).toBe(COMMIT_REFUSAL)
  })

  for (const line of [
    'git push && rm -rf /tmp/x',
    'git commit -m x && gh pr merge 3',
    'git push --force',
    'git push -f origin main',
    'git push origin +main',
    'git push origin :old',
    'git push --delete origin old',
    'git push 2>&1 | tail -3',
    'git push > /tmp/out',
    'git -C "$(pwd)" push',
    'git push origin "$BRANCH"',
    'HUSKY=0 git commit -m x',
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
    'git commit --amend -m x',
    'git commit --no-verify -m x',
    'git commit -n -m x',
    'git commit -m',
    'gh release create 1.0.0 -R other/repo',
    'gh release create 1.0.0 --repo=other/repo',
    'gh -R other/repo release create 1.0.0',
    'git -C /other commit -m x',
    'git -C /repo/link commit -m x',
    'git -C /repo/../other commit -m x',
    'git -C relative commit -m x',
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
    expect(requestedCallsOf('git commit -m x', ['commit'])).toEqual([{ action: 'commit' }])
    expect(requestedCallsOf('git -C /a push origin main', ['push'])).toEqual([{ action: 'push', dir: '/a', remote: 'origin', ref: 'main' }])
    expect(requestedCallsOf('git push', ['commit'])).toBeUndefined()
    expect(requestedCallsOf('git push', ['release'])).toEqual([{ action: 'push' }])
    expect(requestedCallsOf('gh release create 1', ['commit', 'push'])).toBeUndefined()
    expect(requestedCallsOf('', ['commit'])).toBeUndefined()
    for (const line of ['git -c core.hooksPath=/x commit -m m', 'git --exec-path=/x push', 'git -C relative commit -m m', 'git -C /a/../b push']) {
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
      expect(await bash($, b, 'git commit -m x')).toBe(COMMIT_REFUSAL)
      expect(await bash($, b, 'git push')).toBe(PUSH_REFUSAL)
      expect(await bash($, b, 'gh release create 1.0.0')).toBe(RELEASE_REFUSAL)
      expect(await asked($, 'git commit -m x')).toBeUndefined()
    })
  }

  test('a scheduled fire typed through the composer approves nothing, and its turn is ungated as before', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    await $.prompt.submit(prompt('<scheduled-task name="tick">commit and push</scheduled-task>'))
    expect(await asked($, 'git commit -m x')).toBeUndefined()
    await $.prompt.submit(prompt('back at the desk', { kind: 'peer' }))
    expect(await bash($, b, 'git commit -m x')).toBe(COMMIT_REFUSAL)
  })

  test("a sub-agent's permission dialog is never answered, even inside Mike's request", async ($, on) => {
    await typed($, on, 'commit and push')
    expect(await asked($, 'git commit -m x', 'a1')).toBeUndefined()
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
