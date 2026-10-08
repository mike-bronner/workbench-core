// The commit approval rule (hooks/register.ts, hooks/mods/commit-approval.ts):
// in Mike's interactive session, one "Commit it" pick allows one commit and the
// push of that commit, his next prompt ends it, the commit question is asked
// alone, and only the lanes that commit unattended by design are exempt.

import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { PromptOrigin } from 'claude-code'

import {
  BUNDLE_REFUSAL,
  COMMIT_REFUSAL,
  ONE_REFUSAL,
  PUSH_REFUSAL,
  bundlesCommit,
  commandsOf,
  dirOf,
  isCommitPick,
  readLine,
  writesOf,
} from '../hooks/mods/commit-approval'
import type { Bench } from './bench'
import { HOME, PERSON, bench, start } from './bench'
import { CAUGHT, LET_THROUGH } from './commit-corpus'

const prompt = (text: string, origin: PromptOrigin = PERSON) => ({ text, wait: false, origin })

const question = (text: string, labels: string[]) => ({
  question: text,
  header: 'Q',
  options: labels.map(label => ({ label, description: label })),
  multiSelect: false,
})

const COMMIT_QUESTION = question('Commit feat: add the gate on main?', ['Not yet', 'Commit it'])
const OTHER_QUESTION = question('Which approach?', ['A', 'B'])

const ask = (questions: unknown[], agentId?: string) => ({ tool: 'AskUserQuestion' as const, questions, ...(agentId ? { agentId } : {}) }) as never

// The Bash call's refusal, or undefined when it reached the engine.
async function bash($: Engine, b: Bench, command: string, agentId?: string): Promise<string | undefined> {
  const before = b.calls.filter(call => call.tool === 'Bash').length
  const result = await $.tool.call({ tool: 'Bash', command, ...(agentId ? { agentId } : {}) } as never)
  const reached = b.calls.filter(call => call.tool === 'Bash').length > before
  expect(reached).toBe(result.deny === undefined)
  return result.deny
}

// Mike answers `label` in a dialog holding the commit question alone.
async function pick($: Engine, b: Bench, label = 'Commit it', questions: unknown[] = [COMMIT_QUESTION]): Promise<void> {
  b.pick = label
  expect((await $.tool.call(ask(questions))).deny).toBeUndefined()
}

// What the repository at /repo does under each Bash line: a commit moves HEAD
// and a push brings the push target up to HEAD, unless told to fail. A line
// whose commit fails runs no push after it. A failure reports an error unless
// `masks` hides it, as `| tail` does, and `errors` makes every line report one.
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

// An interactive session with a typed prompt open.
async function session($: Engine, text = 'my review is done'): Promise<void> {
  await $.session.start(start())
  await $.prompt.submit(prompt(text))
}

describe('AC1: one "Commit it" pick allows one commit, then the push of that commit', () => {
  test('with no pick, a commit and a push are refused, with a reason to ask first', async ($, on) => {
    const b = bench(on)
    await session($)
    expect(await bash($, b, 'git commit -m "feat: add the gate"')).toBe(COMMIT_REFUSAL)
    expect(await bash($, b, 'git push origin main')).toBe(PUSH_REFUSAL)
    for (const reason of [COMMIT_REFUSAL, PUSH_REFUSAL]) {
      expect(reason).toContain('Ask first')
      expect(reason).toContain('Commit it')
    }
    expect(COMMIT_REFUSAL).toContain('AskUserQuestion')
  })

  test('after a pick, the commit runs, then its push, and nothing more', async ($, on) => {
    const b = bench(on)
    await session($)
    await pick($, b)
    expect(await bash($, b, 'git commit -m "feat: add the gate"')).toBeUndefined()
    expect(await bash($, b, 'git commit -m "fix: one more"')).toBe(COMMIT_REFUSAL)
    expect(await bash($, b, 'git push')).toBeUndefined()
    expect(await bash($, b, 'git push')).toBe(PUSH_REFUSAL)
    expect(await bash($, b, 'git commit -m "fix: one more"')).toBe(COMMIT_REFUSAL)
  })

  test('a second commit after one pick is refused, before or after the push', async ($, on) => {
    const b = bench(on)
    await session($)
    await pick($, b)
    expect(await bash($, b, 'git commit -m a')).toBeUndefined()
    expect(await bash($, b, 'git commit -m b')).toBe(COMMIT_REFUSAL)
  })

  test('a push before the approved commit is refused, and the pick still allows the commit', async ($, on) => {
    const b = bench(on)
    await session($)
    await pick($, b)
    expect(await bash($, b, 'git push')).toBe(PUSH_REFUSAL)
    expect(await bash($, b, 'git commit -m x')).toBeUndefined()
    expect(await bash($, b, 'git push')).toBeUndefined()
  })

  test('a commit and its push on one line use the pick up', async ($, on) => {
    const b = bench(on)
    await session($)
    await pick($, b)
    expect(await bash($, b, 'git commit -m x && git push')).toBeUndefined()
    expect(await bash($, b, 'git push')).toBe(PUSH_REFUSAL)
  })

  test('two commits or two pushes on one line are refused under any pick', async ($, on) => {
    const b = bench(on)
    await session($)
    await pick($, b)
    expect(await bash($, b, 'git commit -m a; git commit -m b')).toBe(ONE_REFUSAL)
    expect(await bash($, b, 'git commit -m a')).toBeUndefined()
    expect(await bash($, b, 'git push && git push --tags')).toBe(ONE_REFUSAL)
  })

  test('a commit that does not move HEAD leaves the pick unused, so it can run again', async ($, on) => {
    const b = bench(on)
    const r = repo(b)
    await session($)
    await pick($, b)
    r.commitFails = true
    expect(await bash($, b, 'git commit -m x')).toBeUndefined()
    r.commitFails = false
    expect(await bash($, b, 'git commit -m x')).toBeUndefined()
    expect(await bash($, b, 'git commit -m y')).toBe(COMMIT_REFUSAL)
  })

  for (const line of ['git commit -m x | tail -1', 'git commit -m x; echo done', 'git commit -m x || true']) {
    test(`a failed commit behind a masked exit status uses the pick up, as it cannot be told from one that landed elsewhere: ${line}`, async ($, on) => {
      const b = bench(on)
      const r = repo(b)
      r.commitFails = true
      r.masks = true
      await session($)
      await pick($, b)
      expect(await bash($, b, line)).toBeUndefined()
      expect(await bash($, b, 'git commit -m y')).toBe(COMMIT_REFUSAL)
    })
  }

  test('a commit that lands in another repository than the one read uses the pick up', async ($, on) => {
    const b = bench(on)
    b.repos['/repo'] = { head: 'c1', pushed: 'c1' }
    const other = { head: 'o1', pushed: 'o1' }
    b.repos['/other'] = other
    // HEAD at /repo, which the reader reads, never moves. The commit lands in
    // /other, by a route the line does not show, and reports success.
    b.onBash = () => {
      other.head = 'o2'
    }
    await session($)
    await pick($, b)
    expect(await bash($, b, './scripts/release.sh && git commit -m x')).toBeUndefined()
    expect(await bash($, b, 'git commit -m y')).toBe(COMMIT_REFUSAL)
    expect(await bash($, b, 'git push')).toBeUndefined()
  })

  // The line moves the shell, or sources a file that may set GIT_DIR, where
  // the walk does not follow. The commit lands in /other, the line fails, and
  // HEAD at /repo never moves: read there, the pick would survive.
  for (const line of [
    'if cd ../other; then git commit -m x && git push; fi',
    '{ cd ../other; git commit -m x && git push; }',
    '! cd ../other || git commit -m x && git push',
    '. ./env.sh; git commit -m x; false',
    'source ./env.sh && git commit -m x && git push',
    'command cd ../other && git commit -m x && git push',
    // A cd that may not move this shell: a shell -c script, a pipeline (bash
    // runs each stage in a child, zsh runs the last one here), a lone &, an
    // assignment before it, a heredoc fed to a shell.
    "bash -c 'cd ../other'; git commit -m x; false",
    'cd ../other | true; git commit -m x; false',
    'true | cd ../other; git commit -m x; false',
    'cd ../other & git commit -m x; false',
    'X=1 cd ../other; git commit -m x; false',
    'sh <<EOF\ncd ../other\nEOF\ngit commit -m x; false',
    // A cd after && or || may be skipped.
    'false && cd ../other; git commit -m x; false',
    '[ -d x ] || cd ../other; git commit -m x; false',
    'eval "true || cd ../other"; git commit -m x; false',
    // CDPATH, under any spelling or a name built at run time, can redirect a
    // bare cd target, so a bare target is always unknown.
    "eval CDP''ATH=/x; cd other; git commit -m x; false",
    'export CDP\\ATH=/x; cd other; git commit -m x; false',
    'cdpath=(/x); cd other; git commit -m x; false',
    'declare -x "CDPATH=/x"; cd other; git commit -m x; false',
    'n=CDP; printf -v "${n}ATH" /x; cd other; git commit -m x; false',
    'cd other; git commit -m x; false',
  ]) {
    test(`a commit that lands where the walk did not follow uses the pick up: ${JSON.stringify(line)}`, async ($, on) => {
      const b = bench(on)
      b.repos['/repo'] = { head: 'c1', pushed: 'c1' }
      const other = { head: 'o1', pushed: 'o1' }
      b.repos['/other'] = other
      b.onBash = command => {
        if (writesOf(command).commits > 0) other.head = 'o2'
        return { isError: true }
      }
      await session($)
      await pick($, b)
      expect(await bash($, b, line)).toBeUndefined()
      expect(b.runs.filter(argv => argv[0] === 'git')).toEqual([])
      expect(await bash($, b, 'git commit -m y')).toBe(COMMIT_REFUSAL)
    })
  }

  // An eval whose command name is built at run time: since batch C1 the
  // guards refuse the whole line before the commit gate reads it, because the
  // reader cannot name the command eval runs. The pick is left unused.
  test('a commit behind an eval whose command name is built at run time never runs', async ($, on) => {
    const b = bench(on)
    await session($)
    await pick($, b)
    expect(await bash($, b, 'n=CDP; eval "${n}ATH=/x"; cd other; git commit -m x; false')).toContain('the shell reader cannot tell which command this line runs')
  })

  test('an escaped command word counts as a commit and push, so beside a real commit the line is refused under any pick', async ($, on) => {
    const b = bench(on)
    await session($)
    await pick($, b)
    expect(await bash($, b, "$'\\x63d' ../other; git commit -m x")).toBe(ONE_REFUSAL)
    expect(await bash($, b, "$'\\x67it' push")).toBeUndefined()
    expect(await bash($, b, 'git commit -m y')).toBe(COMMIT_REFUSAL)
  })

  test('a bare relative cd is unknown, and a /, ~ or ./ target is followed', async ($, on) => {
    const b = bench(on, { env: { HOME } })
    await session($)
    const dirs = async (line: string) => {
      b.runs.length = 0
      await pick($, b)
      await bash($, b, line)
      return [...new Set(b.runs.filter(argv => argv[0] === 'git').map(argv => argv[2]))]
    }
    expect(await dirs('cd other && git commit -m x')).toEqual([])
    expect(await dirs('cd ./other && git commit -m x')).toEqual(['/repo/./other'])
    expect(await dirs('cd /abs && git commit -m x')).toEqual(['/abs'])
    expect(await dirs('cd ~/code && git commit -m x')).toEqual([`${HOME}/code`])
  })

  // /repo/link is a symlink to /elsewhere/target. The shell reads `link/..` as
  // written and lands in /repo/other. git -C resolves it through the link and
  // lands in /elsewhere/other, another repository whose HEAD never moves.
  for (const line of [
    'cd ./link/../other; git commit -m x; false',
    'cd ./link; cd ../other; git commit -m x; false',
    'git -C ./link/../other commit -m x; false',
    'cd /abs/link/../other; git commit -m x; false',
    // The session's directory, or $HOME, may be a symlink too: a session in
    // /tmp is in /private/tmp, and git -C .. reads /private.
    'cd ../other; git commit -m x; false',
    'cd ..; git commit -m x; false',
    'git -C .. commit -m x; false',
    'cd ~/../other; git commit -m x; false',
  ]) {
    test(`a .. is not followed, as the shell and git resolve it apart through a symlink: ${JSON.stringify(line)}`, async ($, on) => {
      const b = bench(on)
      const landed = { head: 'r1', pushed: 'r1' }
      b.repos['/repo/other'] = landed
      b.repos['/repo/./link/../other'] = { head: 'e1', pushed: 'e1' }
      b.repos['/repo/./link/./../other'] = { head: 'e1', pushed: 'e1' }
      b.onBash = command => {
        if (writesOf(command).commits > 0) landed.head = 'r2'
        return { isError: true }
      }
      await session($)
      await pick($, b)
      expect(await bash($, b, line)).toBeUndefined()
      expect(b.runs.filter(argv => argv[0] === 'git')).toEqual([])
      expect(await bash($, b, 'git commit -m y')).toBe(COMMIT_REFUSAL)
    })
  }

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

  test('a cd the walk records, and words that only look like one, keep the directory known', async ($, on) => {
    const b = bench(on)
    await session($)
    for (const [line, dir] of [
      ['cd ./sub && git commit -m x', '/repo/./sub'],
      ['git add . && git commit -m x', '/repo'],
      ['echo cd source . && git commit -m x', '/repo'],
      ['eval cd ./sub; git commit -m x', '/repo/./sub'],
      ['cd /a; cd ./b && git commit -m x', '/a/./b'],
    ] as const) {
      b.runs.length = 0
      await pick($, b)
      await bash($, b, line)
      expect(new Set(b.runs.filter(argv => argv[0] === 'git').map(argv => argv[2]))).toEqual(new Set([dir]))
    }
  })

  test('a directory the reader cannot follow reads no refs: GIT_DIR, --git-dir, --work-tree, env -C, popd, and a cd in a subshell', async ($, on) => {
    const b = bench(on)
    await session($)
    for (const line of [
      'GIT_DIR=/other/.git git commit -m x',
      'export GIT_WORK_TREE=/other; git commit -m x',
      'git --git-dir=/other/.git commit -m x',
      'git --work-tree /other commit -m x',
      'env -C /other git commit -m x',
      'env --chdir=/other git commit -m x',
      'pushd /a && popd && git commit -m x',
      '(cd ../other && make); git commit -m x',
      'x=$(cd /other && pwd); git commit -m x',
    ]) {
      b.runs.length = 0
      await pick($, b)
      expect(await bash($, b, line)).toBeUndefined()
      expect(b.runs.filter(argv => argv[0] === 'git')).toEqual([])
      expect(await bash($, b, 'git commit -m y')).toBe(COMMIT_REFUSAL)
    }
  })

  test('a commit that lands behind an error status still uses the pick', async ($, on) => {
    const b = bench(on)
    const r = repo(b)
    r.errors = true
    await session($)
    await pick($, b)
    expect(await bash($, b, 'git commit -m x && false')).toBeUndefined()
    expect(await bash($, b, 'git commit -m y')).toBe(COMMIT_REFUSAL)
    expect(await bash($, b, 'git push')).toBeUndefined()
  })

  test('a commit and push whose push fails leaves the push: a retry is allowed, and a second commit is not', async ($, on) => {
    const b = bench(on)
    const r = repo(b)
    r.pushFails = true
    await session($)
    await pick($, b)
    expect(await bash($, b, 'git commit -m x && git push')).toBeUndefined()
    expect(await bash($, b, 'git commit -m y')).toBe(COMMIT_REFUSAL)
    r.pushFails = false
    expect(await bash($, b, 'git push')).toBeUndefined()
    expect(await bash($, b, 'git push')).toBe(PUSH_REFUSAL)
  })

  test('a push that fails can be retried, and one that lands uses the approval up', async ($, on) => {
    const b = bench(on)
    const r = repo(b)
    await session($)
    await pick($, b)
    await bash($, b, 'git commit -m x')
    r.pushFails = true
    expect(await bash($, b, 'git push 2>&1 | tail -3')).toBeUndefined()
    r.pushFails = false
    expect(await bash($, b, 'git push')).toBeUndefined()
    expect(await bash($, b, 'git push')).toBe(PUSH_REFUSAL)
  })

  test('a background commit cannot be watched, so it uses the pick and leaves its push', async ($, on) => {
    const b = bench(on)
    // The background commit has not landed when the call returns.
    repo(b).commitFails = true
    await session($)
    await pick($, b)
    const result = await $.tool.call({ tool: 'Bash', command: 'git commit -m x', run_in_background: true } as never)
    expect(result.deny).toBeUndefined()
    expect(await bash($, b, 'git commit -m y')).toBe(COMMIT_REFUSAL)
    expect(await bash($, b, 'git push')).toBeUndefined()
  })

  test('HEAD is read where the line commits: after its cd, and at its -C', async ($, on) => {
    const b = bench(on, { env: { HOME } })
    await session($)
    const dirs = () => b.runs.filter(argv => argv[0] === 'git').map(argv => argv[2])
    const cases: [string, string][] = [
      ['git commit -m x', '/repo'],
      ['git -C /other commit -m x', '/other'],
      ['cd ./sub && git commit -m x', '/repo/./sub'],
      ['cd ~/code && git -C app commit -m x', `${HOME}/code/app`],
      ['cd /a; cd ./b && git commit -m x', '/a/./b'],
    ]
    for (const [line, dir] of cases) {
      b.runs.length = 0
      await pick($, b)
      await bash($, b, line)
      expect(new Set(dirs())).toEqual(new Set([dir]))
    }
  })

  test('a directory the reader cannot follow reads no refs, and the commit is taken as landed', async ($, on) => {
    const b = bench(on)
    await session($)
    await pick($, b)
    expect(await bash($, b, 'git -C "$(git rev-parse --show-toplevel)" commit -m x')).toBeUndefined()
    expect(b.runs.some(argv => argv[0] === 'git')).toBe(false)
    expect(await bash($, b, 'git commit -m y')).toBe(COMMIT_REFUSAL)
  })

  test('a new pick approves the next commit', async ($, on) => {
    const b = bench(on)
    await session($)
    await pick($, b)
    await bash($, b, 'git commit -m a')
    await bash($, b, 'git push')
    await pick($, b)
    expect(await bash($, b, 'git commit -m b')).toBeUndefined()
  })

  test('only the exact "Commit it" label is a pick: other labels, typed text and an away dialog approve nothing', async ($, on) => {
    const b = bench(on)
    await session($)
    for (const label of ['Not yet', 'Review with Holmes first', 'commit it', ' Commit it', 'Commit it, then push']) {
      await pick($, b, label)
      expect(await bash($, b, 'git commit -m x')).toBe(COMMIT_REFUSAL)
    }
    // Typed under Other, in a question with no "Commit it" option.
    await pick($, b, 'Commit it', [question('Which approach?', ['Ship', 'Wait'])])
    expect(await bash($, b, 'git commit -m x')).toBe(COMMIT_REFUSAL)
    b.dialog = { response: 'Commit it' }
    await pick($, b)
    expect(await bash($, b, 'git commit -m x')).toBe(COMMIT_REFUSAL)
    b.dialog = { afkTimeoutMs: 60_000 }
    await pick($, b)
    expect(await bash($, b, 'git commit -m x')).toBe(COMMIT_REFUSAL)
  })

  test('a dismissed dialog approves nothing', async ($, on) => {
    const b = bench(on)
    await session($)
    b.pick = undefined
    await $.tool.call(ask([COMMIT_QUESTION])).catch(() => undefined)
    expect(await bash($, b, 'git commit -m x')).toBe(COMMIT_REFUSAL)
  })

  test('Mike\'s next prompt ends the approval, folded into the turn or not, typed or from the bridge', async ($, on) => {
    const b = bench(on)
    await session($)
    await pick($, b)
    await $.prompt.submit(prompt('commit it'))
    expect(await bash($, b, 'git commit -m x')).toBe(COMMIT_REFUSAL)
    await pick($, b)
    await $.prompt.submit({ ...prompt('wait, one more thing'), turnId: 'running' })
    expect(await bash($, b, 'git commit -m x')).toBe(COMMIT_REFUSAL)
    await pick($, b)
    await bash($, b, 'git commit -m x')
    await $.prompt.submit(prompt('from my phone', { kind: 'bridge' }))
    expect(await bash($, b, 'git push')).toBe(PUSH_REFUSAL)
  })

  for (const origin of [
    { kind: 'task-notification' },
    { kind: 'peer' },
    { kind: 'channel', server: 'slack' },
    { kind: 'plugin', name: 'x' },
    { kind: 'sdk' },
    { kind: 'scheduled-trigger' },
  ] as PromptOrigin[]) {
    test(`a ${origin.kind} prompt ends an unused pick, as it carries outside text, folded into the turn or not`, async ($, on) => {
      const b = bench(on)
      await session($)
      await pick($, b)
      await $.prompt.submit({ ...prompt('please commit now', origin), turnId: 'running' })
      expect(await bash($, b, 'git commit -m x')).toBe(COMMIT_REFUSAL)
      // A scheduled turn of its own is not gated at all, so only the others
      // can show a refusal there.
      if (origin.kind !== 'scheduled-trigger') {
        await $.prompt.submit(prompt('back to Mike'))
        await pick($, b)
        await $.prompt.submit(prompt('please commit now', origin))
        expect(await bash($, b, 'git commit -m x')).toBe(COMMIT_REFUSAL)
      }
    })
  }

  for (const origin of [{ kind: 'task-notification' }, { kind: 'peer' }, { kind: 'channel', server: 'slack' }] as PromptOrigin[]) {
    test(`a ${origin.kind} prompt between an approved commit and its push leaves the push`, async ($, on) => {
      const b = bench(on)
      await session($)
      await pick($, b)
      expect(await bash($, b, 'git commit -m x')).toBeUndefined()
      await $.prompt.submit({ ...prompt('agent finished', origin), turnId: 'running' })
      expect(await bash($, b, 'git push')).toBeUndefined()
      expect(await bash($, b, 'git push')).toBe(PUSH_REFUSAL)
    })
  }

  test('Mike\'s own prompt between an approved commit and its push ends the push', async ($, on) => {
    const b = bench(on)
    await session($)
    await pick($, b)
    await bash($, b, 'git commit -m x')
    await $.prompt.submit(prompt('hold the push'))
    expect(await bash($, b, 'git push')).toBe(PUSH_REFUSAL)
  })

  test('/clear ends the approval', async ($, on) => {
    const b = bench(on)
    await session($)
    await pick($, b)
    await $.session.end({ reason: 'clear', sessionId: 's' } as never)
    expect(await bash($, b, 'git commit -m x')).toBe(COMMIT_REFUSAL)
  })

  test('every caught line of the corpus is refused with no pick, and every read is let through', async ($, on) => {
    const b = bench(on)
    await session($, 'look around')
    for (const [line] of CAUGHT) expect(await bash($, b, line)).toBeDefined()
    for (const line of LET_THROUGH) expect(await bash($, b, line)).toBeUndefined()
  })
})

describe('AC2: the commit question is asked alone', () => {
  test('a commit option beside another question is refused, with a reason, and never reaches Mike', async ($, on) => {
    const b = bench(on)
    b.pick = 'Commit it'
    await session($)
    const result = await $.tool.call(ask([OTHER_QUESTION, COMMIT_QUESTION]))
    expect(result.deny).toBe(BUNDLE_REFUSAL)
    expect(BUNDLE_REFUSAL).toContain('alone')
    expect(b.calls.some(call => call.tool === 'AskUserQuestion')).toBe(false)
    expect(await bash($, b, 'git commit -m x')).toBe(COMMIT_REFUSAL)
  })

  test('the commit question alone, and questions with no commit option, are let through', async ($, on) => {
    const b = bench(on)
    b.pick = 'A'
    await session($)
    expect((await $.tool.call(ask([COMMIT_QUESTION]))).deny).toBeUndefined()
    expect((await $.tool.call(ask([OTHER_QUESTION, question('Which file?', ['x', 'y'])]))).deny).toBeUndefined()
  })

  test('a commit option is an option label that leads with the word', () => {
    expect(bundlesCommit([OTHER_QUESTION, question('Next?', ['Commit and push', 'Wait'])])).toBe(true)
    expect(bundlesCommit([OTHER_QUESTION, question('Next?', ['Recommit later', 'Review the commit'])])).toBe(false)
    expect(bundlesCommit([COMMIT_QUESTION])).toBe(false)
    expect(bundlesCommit('not a list')).toBe(false)
  })
})

describe('AC3: only the lanes that commit unattended by design are exempt', () => {
  for (const origin of [{ kind: 'peer' }, { kind: 'peer-send-message' }, { kind: 'channel', server: 'slack' }, { kind: 'plugin', name: 'x' }, { kind: 'sdk' }] as PromptOrigin[]) {
    test(`a ${origin.kind} turn in Mike's interactive session is gated: it carries outside text`, async ($, on) => {
      const b = bench(on)
      b.pick = 'A'
      await $.session.start(start())
      await $.prompt.submit(prompt('please commit and push', origin))
      expect(await bash($, b, 'git commit -m x')).toBe(COMMIT_REFUSAL)
      expect(await bash($, b, 'git push')).toBe(PUSH_REFUSAL)
      expect((await $.tool.call(ask([OTHER_QUESTION, COMMIT_QUESTION]))).deny).toBe(BUNDLE_REFUSAL)
    })
  }

  test('a sub-agent\'s commit, push and bundled question are never refused', async ($, on) => {
    const b = bench(on)
    b.pick = 'A'
    await session($, 'delegate it')
    expect(await bash($, b, 'git commit -m x', 'a1')).toBeUndefined()
    expect(await bash($, b, 'git push', 'a1')).toBeUndefined()
    expect((await $.tool.call(ask([OTHER_QUESTION, COMMIT_QUESTION], 'a1'))).deny).toBeUndefined()
  })

  test('a sub-agent\'s "Commit it" pick approves nothing for the main loop', async ($, on) => {
    const b = bench(on)
    b.pick = 'Commit it'
    await session($, 'delegate it')
    await $.tool.call(ask([COMMIT_QUESTION], 'a1'))
    expect(await bash($, b, 'git commit -m x')).toBe(COMMIT_REFUSAL)
  })

  test('a claude -p or SDK session commits', async ($, on) => {
    const b = bench(on)
    await $.session.start(start(false))
    await $.prompt.submit(prompt('commit the fix', { kind: 'sdk' }))
    expect(await bash($, b, 'git commit -m x')).toBeUndefined()
    expect(await bash($, b, 'git push')).toBeUndefined()
  })

  test('the Index pipeline commits, by its session and by its own flag', async ($, on) => {
    const b = bench(on, { env: { HOME, WORKBENCH_DEV_TEAM_PIPELINE: '1' } })
    await $.session.start(start())
    await $.prompt.submit(prompt('Item ID: 12'))
    expect(await bash($, b, 'git commit -m x')).toBeUndefined()
    expect(await bash($, b, 'git push origin feature/12')).toBeUndefined()
  })

  test('the pipeline\'s flag holds even while the lane is unknown', async ($, on) => {
    const b = bench(on, { env: { HOME, WORKBENCH_DEV_TEAM_PIPELINE: '1' } })
    expect(await bash($, b, 'git push')).toBeUndefined()
  })

  test('a top-level --agent run commits', async ($, on) => {
    const b = bench(on, { env: { HOME, CLAUDE_CODE_AGENT: 'watson' } })
    await $.session.start(start())
    await $.prompt.submit(prompt('Item ID: 12'))
    expect(await bash($, b, 'git commit -m x')).toBeUndefined()
  })

  test('a scheduled tick commits, by origin or by wrapper, and the next typed turn is gated again', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    await $.prompt.submit(prompt('run the tick', { kind: 'scheduled-trigger' }))
    expect(await bash($, b, 'git commit -m x')).toBeUndefined()
    await $.prompt.submit(prompt('<scheduled-task name="tick">run</scheduled-task>'))
    expect(await bash($, b, 'git push')).toBeUndefined()
    await $.prompt.submit(prompt('back at the desk'))
    expect(await bash($, b, 'git push')).toBe(PUSH_REFUSAL)
  })

  test('while the lane is unknown, both checks take the gate\'s side', async ($, on) => {
    const b = bench(on)
    b.pick = 'Commit it'
    expect(await bash($, b, 'git commit -m x')).toBe(COMMIT_REFUSAL)
    expect((await $.tool.call(ask([OTHER_QUESTION, COMMIT_QUESTION]))).deny).toBe(BUNDLE_REFUSAL)
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

  test('isCommitPick wants the exact label of a "Commit it" option of the question it answers', () => {
    const q = [COMMIT_QUESTION]
    expect(isCommitPick(q, { answers: { [COMMIT_QUESTION.question]: 'Commit it' } })).toBe(true)
    expect(isCommitPick(q, { answers: { [COMMIT_QUESTION.question]: 'Commit it' }, afkTimeoutMs: 1 })).toBe(false)
    expect(isCommitPick(q, { answers: { [COMMIT_QUESTION.question]: 'Commit it' }, response: 'Commit it' })).toBe(false)
    expect(isCommitPick(q, { answers: { other: 'Commit it' } })).toBe(false)
    expect(isCommitPick(q, { answers: {} })).toBe(false)
    expect(isCommitPick(q, undefined)).toBe(false)
    expect(isCommitPick(undefined, { answers: { [COMMIT_QUESTION.question]: 'Commit it' } })).toBe(false)
  })
})
