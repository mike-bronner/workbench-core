import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { PromptOrigin } from 'claude-code'

import {
  BUNDLE_REFUSAL,
  COMMIT_REFUSAL,
  AGENT_MERGE_REFUSAL,
  MERGE_ASK_REFUSAL,
  MERGE_TARGET_REFUSAL,
  MOVE_REFUSAL,
  NAMED_BUNDLE_REFUSAL,
  ONE_REFUSAL,
  PUSH_REFUSAL,
  UNREAD_TREE_REFUSAL,
  bindingRefusalOf,
  bundleRefusalOf,
  commandsOf,
  dirOf,
  headsOf,
  isDefaultBranch,
  mergesOf,
  movesHead,
  pickOf,
  readLine,
  writesOf,
} from '../hooks/mods/commit-approval'

import { PLAIN_REFUSAL, SUBAGENT_REFUSAL } from '../hooks/mods/commit-guard'
import type { Bench } from './bench'
import { ASKS as DECLINED, HOME, PERSON, bench, exactly, start } from './bench'
import { hiddenCommandRefusal } from '../hooks/mods/guards'
import { parseShell } from '../hooks/mods/shell'
import { CAUGHT, LET_THROUGH } from './commit-corpus'

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

describe('AC1: one "Commit it" pick allows one commit, and no push', () => {
  test('with no pick, a commit and a push are refused, with a reason to ask first', async ($, on) => {
    const b = bench(on)
    await session($)
    expect(await bash($, b, 'git commit -m "feat: ✨ Add the gate."')).toMatch(DECLINED.commit)
    expect(await bash($, b, 'git push origin main')).toMatch(DECLINED.push)
    expect(COMMIT_REFUSAL).toContain('Ask first')
    expect(COMMIT_REFUSAL).toContain('Commit it')
    expect(COMMIT_REFUSAL).toContain('AskUserQuestion')
    expect(COMMIT_REFUSAL).toContain('no push and no merge')
    expect(PUSH_REFUSAL).toContain('approves no push')
    expect(PUSH_REFUSAL).toContain('of its own')
    for (const reason of [COMMIT_REFUSAL, PUSH_REFUSAL]) expect(reason).not.toMatch(/push of that commit/)
  })

  test('after a pick, the commit runs and nothing more: its push is refused', async ($, on) => {
    const b = bench(on)
    await session($)
    await pick($, b)
    expect(await bash($, b, 'git commit -m "feat: ✨ Add the gate."')).toBeUndefined()
    expect(await bash($, b, 'git commit -m "fix: 🐛 One more."')).toMatch(DECLINED.commit)
    expect(await bash($, b, 'git push')).toMatch(DECLINED.push)
  })

  test('a push pick allows one push, and no commit', async ($, on) => {
    const b = bench(on)
    await session($)
    await pick($, b)
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
    await pushPick($, b)
    expect(await bash($, b, 'git commit -m "fix: 🐛 Y."')).toMatch(DECLINED.commit)
    expect(await bash($, b, 'git push')).toBeUndefined()
    expect(await bash($, b, 'git push')).toMatch(DECLINED.push)
  })

  test('a push before the approved commit is refused, and the pick still allows the commit', async ($, on) => {
    const b = bench(on)
    await session($)
    await pick($, b)
    expect(await bash($, b, 'git push')).toMatch(DECLINED.push)
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
  })

  test('a commit and a push on one line are refused under a commit pick, and the pick stays', async ($, on) => {
    const b = bench(on)
    await session($)
    await pick($, b)
    expect(await bash($, b, 'git commit -m "fix: 🐛 X." && git push')).toMatch(DECLINED.push)
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
  })

  test('two commits or two pushes on one line are refused under any pick', async ($, on) => {
    const b = bench(on)
    await session($)
    await pick($, b)
    expect(await bash($, b, 'git commit -m "fix: 🐛 A."; git commit -m "fix: 🐛 B."')).toBe(ONE_REFUSAL)
    expect(await bash($, b, 'git commit -m "fix: 🐛 A."')).toBeUndefined()
    await pushPick($, b)
    expect(await bash($, b, 'git push && git push --tags')).toBe(ONE_REFUSAL)
  })

  test('a commit that does not move HEAD leaves the pick unused, so it can run again', async ($, on) => {
    const b = bench(on)
    const r = repo(b)
    await session($)
    await pick($, b)
    r.commitFails = true
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
    r.commitFails = false
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
    expect(await bash($, b, 'git commit -m "fix: 🐛 Y."')).toMatch(DECLINED.commit)
  })

  for (const line of ['git commit -m "fix: 🐛 X." | tail -1', 'git commit -m "fix: 🐛 X."; echo done', 'git commit -m "fix: 🐛 X." || true']) {
    test(`a failed commit behind a masked exit status uses the pick up, as it cannot be told from one that landed elsewhere: ${line}`, async ($, on) => {
      const b = bench(on)
      const r = repo(b)
      r.commitFails = true
      r.masks = true
      await session($)
      await pick($, b)
      expect(await bash($, b, line)).toBeUndefined()
      expect(await bash($, b, 'git commit -m "fix: 🐛 Y."')).toMatch(DECLINED.commit)
    })
  }

  test('a commit that lands in another repository than the one read uses the pick up', async ($, on) => {
    const b = bench(on)
    b.repos['/repo'] = { head: 'c1', pushed: 'c1' }
    const other = { head: 'o1', pushed: 'o1' }
    b.repos['/other'] = other
    b.onBash = () => {
      other.head = 'o2'
    }
    await session($)
    await pick($, b)
    expect(await bash($, b, './scripts/release.sh && git commit -m "fix: 🐛 X."')).toBeUndefined()
    expect(await bash($, b, 'git commit -m "fix: 🐛 Y."')).toMatch(DECLINED.commit)
  })

  for (const line of [
    'if cd ../other; then git commit -m "fix: 🐛 X."; fi',
    '{ cd ../other; git commit -m "fix: 🐛 X."; }',
    '! cd ../other || git commit -m "fix: 🐛 X."',
    '. ./env.sh; git commit -m "fix: 🐛 X."; false',
    'source ./env.sh && git commit -m "fix: 🐛 X."',
    'command cd ../other && git commit -m "fix: 🐛 X."',
    "bash -c 'cd ../other'; git commit -m 'fix: 🐛 X.'; false",
    'cd ../other | true; git commit -m "fix: 🐛 X."; false',
    'true | cd ../other; git commit -m "fix: 🐛 X."; false',
    'cd ../other & git commit -m "fix: 🐛 X."; false',
    'X=1 cd ../other; git commit -m "fix: 🐛 X."; false',
    'false && cd ../other; git commit -m "fix: 🐛 X."; false',
    '[ -d x ] || cd ../other; git commit -m "fix: 🐛 X."; false',
    'eval "true || cd ../other"; git commit -m "fix: 🐛 X."; false',
    "eval CDP''ATH=/x; cd other; git commit -m 'fix: 🐛 X.'; false",
    'export CDP\\ATH=/x; cd other; git commit -m "fix: 🐛 X."; false',
    'cdpath=(/x); cd other; git commit -m "fix: 🐛 X."; false',
    'declare -x "CDPATH=/x"; cd other; git commit -m "fix: 🐛 X."; false',
    'cd other; git commit -m "fix: 🐛 X."; false',
    'sh <<EOF\ncd ../other\nEOF\ngit commit -m x; false',
  ]) {
    test(`a commit where the walk did not follow is refused, as its tree cannot be read, and the pick stays: ${JSON.stringify(line)}`, async ($, on) => {
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
      b.runs.length = 0
      expect(await bash($, b, line)).toBe(UNREAD_TREE_REFUSAL)
      expect(gitRuns(b)).toEqual([])
      expect(other.head).toBe('o1')
      expect(await bash($, b, 'git commit -m "fix: 🐛 Y."')).toBeUndefined()
    })
  }

  test('a commit and a push behind a wrapper are refused under a pick, and asked to run as plain lines', async ($, on) => {
    const b = bench(on)
    await session($)
    await pick($, b)
    for (const line of ['HUSKY=0 git commit -m "fix: 🐛 X."', "bash -c 'git commit -m x'"]) {
      expect([line, await bash($, b, line)]).toEqual([line, PLAIN_REFUSAL.deny])
    }
    expect(await bash($, b, 'git commit -m "fix: 🐛 Y."')).toBeUndefined()
  })

  test('a commit behind an eval whose command name is built at run time never runs', async ($, on) => {
    const b = bench(on)
    await session($)
    await pick($, b)
    expect(await bash($, b, 'n=CDP; eval "${n}ATH=/x"; cd other; git commit -m "fix: 🐛 X."; false')).toContain('the shell reader cannot tell which command this line runs')
  })

  for (const line of [
    'n=CDP; printf -v "${n}ATH" /x; cd other; git commit -m "fix: 🐛 X."; false',
    'n=CDP; printf -v"${n}ATH" /x; cd other; git commit -m "fix: 🐛 X."; false',
  ]) {
    test(`a commit behind printf -v into a name built at run time never runs: ${JSON.stringify(line)}`, async ($, on) => {
      const b = bench(on)
      await session($)
      await pick($, b)
      expect(await bash($, b, line)).toContain('the shell reader cannot tell which command this line runs')
      expect(await bash($, b, 'git commit -m "fix: 🐛 Y."')).toBeUndefined()
    })
  }

  test('an escaped command word is refused beside a real commit, and the pick stays', async ($, on) => {
    const b = bench(on)
    await session($)
    await pick($, b)
    expect(await bash($, b, "$'\\x63d' ../other; git commit -m 'fix: 🐛 X.'")).toBe(ONE_REFUSAL)
    expect(await bash($, b, "$'\\x67it' push")).toBeDefined()
    expect(await bash($, b, 'git commit -m "fix: 🐛 Y."')).toBeUndefined()
  })

  test('a bare relative cd is unknown, and a /, ~ or ./ target is followed', async ($, on) => {
    const b = bench(on, { env: { HOME } })
    await session($)
    const dirs = async (line: string) => {
      await pick($, b)
      b.runs.length = 0
      await bash($, b, line)
      return [...new Set(gitRuns(b).map(argv => argv[2]))]
    }
    expect(await dirs('cd other && git commit -m "fix: 🐛 X."')).toEqual([])
    expect(await dirs('cd ./other && git commit -m "fix: 🐛 X."')).toEqual(['/repo/./other'])
    expect(await dirs('cd /abs && git commit -m "fix: 🐛 X."')).toEqual(['/abs'])
    expect(await dirs('cd ~/code && git commit -m "fix: 🐛 X."')).toEqual([`${HOME}/code`])
  })

  for (const line of [
    'cd ./link/../other; git commit -m "fix: 🐛 X."; false',
    'cd ./link; cd ../other; git commit -m "fix: 🐛 X."; false',
    'git -C ./link/../other commit -m "fix: 🐛 X."; false',
    'cd /abs/link/../other; git commit -m "fix: 🐛 X."; false',
    'cd ../other; git commit -m "fix: 🐛 X."; false',
    'cd ..; git commit -m "fix: 🐛 X."; false',
    'git -C .. commit -m "fix: 🐛 X."; false',
    'cd ~/../other; git commit -m "fix: 🐛 X."; false',
  ]) {
    test(`a .. is not followed, as the shell and git resolve it apart through a symlink, so the commit is refused: ${JSON.stringify(line)}`, async ($, on) => {
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
      b.runs.length = 0
      expect(await bash($, b, line)).toBe(UNREAD_TREE_REFUSAL)
      expect(gitRuns(b)).toEqual([])
      expect(landed.head).toBe('r1')
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
      ['cd ./sub && git commit -m "fix: 🐛 X."', '/repo/./sub'],
      ['git add . && git commit -m "fix: 🐛 X."', '/repo'],
      ['echo cd source . && git commit -m "fix: 🐛 X."', '/repo'],
      ['eval cd ./sub; git commit -m "fix: 🐛 X."', '/repo/./sub'],
      ['cd /a; cd ./b && git commit -m "fix: 🐛 X."', '/a/./b'],
    ] as const) {
      await pick($, b)
      b.runs.length = 0
      await bash($, b, line)
      expect(new Set(gitRuns(b).map(argv => argv[2]))).toEqual(new Set([dir]))
    }
  })

  test('a commit in a directory the reader cannot follow is refused, and reads nothing: GIT_DIR, --git-dir, --work-tree, env -C, popd, and a cd in a subshell', async ($, on) => {
    const b = bench(on)
    await session($)
    for (const line of [
      'git --git-dir=/other/.git commit -m "fix: 🐛 X."',
      'git --work-tree /other commit -m "fix: 🐛 X."',
      'export GIT_WORK_TREE=/other; git commit -m "fix: 🐛 X."',
      'pushd /a && popd && git commit -m "fix: 🐛 X."',
      '(cd ../other && make); git commit -m "fix: 🐛 X."',
      'x=$(cd /other && pwd); git commit -m "fix: 🐛 X."',
    ]) {
      await pick($, b)
      b.runs.length = 0
      expect([line, await bash($, b, line)]).toEqual([line, UNREAD_TREE_REFUSAL])
      expect(gitRuns(b)).toEqual([])
      expect(await bash($, b, 'git commit -m "fix: 🐛 Y."')).toBeUndefined()
    }
    for (const line of ['GIT_DIR=/other/.git git commit -m "fix: 🐛 X."', 'env -C /other git commit -m "fix: 🐛 X."', 'env --chdir=/other git commit -m "fix: 🐛 X."']) {
      await pick($, b)
      expect([line, await bash($, b, line)]).toEqual([line, PLAIN_REFUSAL.deny])
    }
  })

  test('a commit that lands behind an error status still uses the pick', async ($, on) => {
    const b = bench(on)
    const r = repo(b)
    r.errors = true
    await session($)
    await pick($, b)
    expect(await bash($, b, 'git commit -m "fix: 🐛 X." && false')).toBeUndefined()
    expect(await bash($, b, 'git commit -m "fix: 🐛 Y."')).toMatch(DECLINED.commit)
  })

  test('a push that fails can be retried under its pick, and one that lands uses the pick up', async ($, on) => {
    const b = bench(on)
    const r = repo(b)
    await session($)
    await pick($, b)
    await bash($, b, 'git commit -m "fix: 🐛 X."')
    await pushPick($, b)
    r.pushFails = true
    expect(await bash($, b, 'git push 2>&1 | tail -3')).toBeUndefined()
    r.pushFails = false
    expect(await bash($, b, 'git push')).toBeUndefined()
    expect(await bash($, b, 'git push')).toMatch(DECLINED.push)
  })

  test('a background commit cannot be watched, so it uses the pick', async ($, on) => {
    const b = bench(on)
    repo(b).commitFails = true
    await session($)
    await pick($, b)
    const result = await $.tool.call({ tool: 'Bash', command: 'git commit -m "fix: 🐛 X."', run_in_background: true } as never)
    expect(result.deny).toBeUndefined()
    expect(await bash($, b, 'git commit -m "fix: 🐛 Y."')).toMatch(DECLINED.commit)
  })

  test('HEAD is read where the line commits: after its cd, and at its -C', async ($, on) => {
    const b = bench(on, { env: { HOME } })
    await session($)
    const cases: [string, string][] = [
      ['git commit -m "fix: 🐛 X."', '/repo'],
      ['git -C /other commit -m "fix: 🐛 X."', '/other'],
      ['cd ./sub && git commit -m "fix: 🐛 X."', '/repo/./sub'],
      ['cd ~/code && git -C app commit -m "fix: 🐛 X."', `${HOME}/code/app`],
      ['cd /a; cd ./b && git commit -m "fix: 🐛 X."', '/a/./b'],
    ]
    for (const [line, dir] of cases) {
      await pick($, b)
      b.runs.length = 0
      await bash($, b, line)
      expect(new Set(gitRuns(b).map(argv => argv[2]))).toEqual(new Set([dir]))
    }
  })

  test('a directory the reader cannot follow reads no refs: a commit there is refused, and a picked push there is refused too', async ($, on) => {
    const b = bench(on)
    await session($)
    await pick($, b)
    b.runs.length = 0
    expect(await bash($, b, 'git -C "$(git rev-parse --show-toplevel)" commit -m "fix: 🐛 X."')).toBe(UNREAD_TREE_REFUSAL)
    expect(gitRuns(b)).toEqual([])
    expect(await bash($, b, 'git commit -m "fix: 🐛 Y."')).toBeUndefined()
    await pushPick($, b)
    b.runs.length = 0
    expect(await bash($, b, 'git -C "$(git rev-parse --show-toplevel)" push')).toContain('a branch the gate cannot read')
    expect(await bash($, b, 'git push')).toMatch(DECLINED.push)
  })

  test('a new pick approves the next commit', async ($, on) => {
    const b = bench(on)
    await session($)
    await pick($, b)
    await bash($, b, 'git commit -m "fix: 🐛 A."')
    await pick($, b)
    expect(await bash($, b, 'git commit -m "fix: 🐛 B."')).toBeUndefined()
  })

  test('a dismissed dialog approves nothing', async ($, on) => {
    const b = bench(on)
    await session($)
    b.pick = undefined
    await $.tool.call(ask([COMMIT_QUESTION])).catch(() => undefined)
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toMatch(DECLINED.commit)
  })

  test('/clear ends the approval', async ($, on) => {
    const b = bench(on)
    await session($)
    await pick($, b)
    await $.session.end({ reason: 'clear', sessionId: 's' } as never)
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toMatch(DECLINED.commit)
  })

  test('every caught line of the corpus is refused with no pick, and every read is let through', async ($, on) => {
    const b = bench(on)
    await session($, 'look around')
    for (const [line] of CAUGHT) expect(await bash($, b, line)).toBeDefined()
    for (const line of LET_THROUGH) expect(await bash($, b, line)).toBe(hiddenCommandRefusal(parseShell(line)))
  })
})

describe('AC2: a pick counts by intent, for exactly one commit', () => {
  for (const label of ['Commit it', 'Commit', 'Commit and push', 'Commit it, full message', 'Commit it (Recommended)', 'Yes, commit']) {
    test(`the label ${JSON.stringify(label)} approves one commit and no push`, async ($, on) => {
      const b = bench(on)
      await session($)
      await pick($, b, label, [question('Commit "feat: ✨ Add the gate." on main?', ['Not yet', label])])
      expect(await bash($, b, 'git push')).toMatch(DECLINED.push)
      expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
      expect(await bash($, b, 'git commit -m "fix: 🐛 Y."')).toMatch(DECLINED.commit)
    })
  }

  for (const label of ['Not yet', "Don't commit", 'Do not commit', 'Commit later', 'Review with Holmes first', 'Review the commit']) {
    test(`the label ${JSON.stringify(label)} approves nothing`, async ($, on) => {
      const b = bench(on)
      await session($)
      await pick($, b, label, [question('Commit "feat: ✨ Add the gate." on main?', [label, 'Commit it'])])
      expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toMatch(DECLINED.commit)
    })
  }

  test('typed text, an away dialog and a label from another question approve nothing', async ($, on) => {
    const b = bench(on)
    await session($)
    await pick($, b, 'Commit it', [question('Which approach?', ['Ship', 'Wait'])])
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toMatch(DECLINED.commit)
    b.dialog = { response: 'Commit it' }
    await pick($, b)
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toMatch(DECLINED.commit)
    b.dialog = { afkTimeoutMs: 60_000 }
    await pick($, b)
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toMatch(DECLINED.commit)
  })

  test('pickOf reads the pick by the option it chose, and the question it answers', () => {
    const answered = (q: ReturnType<typeof question>, label: string, extra = {}) => pickOf([q], { answers: { [q.question]: label }, ...extra })
    expect(answered(COMMIT_QUESTION, 'Commit it')).toBe('commit')
    expect(answered(COMMIT_QUESTION, 'Not yet')).toBeUndefined()
    expect(answered(COMMIT_QUESTION, 'Commit')).toBeUndefined()
    expect(answered(COMMIT_QUESTION, 'Commit it', { afkTimeoutMs: 1 })).toBeUndefined()
    expect(answered(COMMIT_QUESTION, 'Commit it', { response: 'Commit it' })).toBeUndefined()
    expect(answered(PUSH_QUESTION, 'Push')).toBe('push')
    expect(answered(question('Push main to origin?', ["Don't push", 'Push']), "Don't push")).toBeUndefined()
    expect(answered(question('Which approach?', ['Push', 'Wait']), 'Push')).toBeUndefined()
    expect(answered(MERGE_QUESTION, 'Merge locally')).toBe('merge')
    expect(answered(MERGE_QUESTION, 'Open a PR')).toBeUndefined()
    expect(answered(question('Which approach?', ['Merge', 'Rebase']), 'Merge')).toBeUndefined()
    expect(pickOf([COMMIT_QUESTION], { answers: { other: 'Commit it' } })).toBeUndefined()
    expect(pickOf([COMMIT_QUESTION], undefined)).toBeUndefined()
    expect(pickOf(undefined, { answers: { [COMMIT_QUESTION.question]: 'Commit it' } })).toBeUndefined()
  })
})

describe('AC3: a commit approval approves no push and no merge, and each gets its own', () => {
  test('a merge into the default branch is refused under a commit or push pick, and a merge pick allows one', async ($, on) => {
    const b = bench(on)
    await session($)
    await pick($, b)
    expect(await bash($, b, 'git merge fix/x')).toMatch(DECLINED.merge)
    expect(await bash($, b, 'gh pr merge 12 --squash')).toMatch(DECLINED.merge)
    await pushPick($, b)
    expect(await bash($, b, 'git pull')).toMatch(DECLINED.merge)
    await pick($, b, 'Merge locally', [MERGE_QUESTION])
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toMatch(DECLINED.commit)
    expect(await bash($, b, 'git push')).toMatch(DECLINED.push)
    expect(await bash($, b, 'git merge fix/x')).toBeUndefined()
    expect(await bash($, b, 'git merge fix/y')).toMatch(DECLINED.merge)
    expect(MERGE_ASK_REFUSAL).toContain('his choice')
  })

  for (const line of [
    'gh pr merge 12',
    'gh -R o/r pr merge 12',
    'gh api -X PUT repos/o/r/pulls/12/merge',
    'gh api repos/o/r/merges -f base=main -f head=feat',
    'git -C /repo merge fix/x',
    'git pull --rebase',
  ]) {
    test(`a merge with no approval is refused in Mike's session: ${JSON.stringify(line)}`, async ($, on) => {
      const b = bench(on)
      b.repos['/repo'] = { head: 'c1', pushed: 'c1' }
      await session($)
      expect(await bash($, b, line)).toMatch(DECLINED.merge)
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
    b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'fix/x', originHead: 'main' }
    await session($)
    expect(await bash($, b, 'git merge origin/main')).toBeUndefined()
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
    test(`${lane}: a git merge or pull on the default branch is refused, and one on a feature branch runs`, async ($, on) => {
      const b = bench(on, options)
      b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'main', originHead: 'main' }
      await $.session.start(start(isInteractive))
      await $.prompt.submit(prompt('Item ID: 12', isInteractive ? PERSON : { kind: 'sdk' }))
      expect(await bash($, b, 'git merge fix/x', agentId)).toBe(AGENT_MERGE_REFUSAL)
      expect(await bash($, b, 'git pull', agentId)).toBe(AGENT_MERGE_REFUSAL)
      expect(await bash($, b, "bash -c 'git -C /repo merge fix/x'", agentId)).toBe(AGENT_MERGE_REFUSAL)
      b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'fix/x', originHead: 'main' }
      expect(await bash($, b, 'git merge origin/main', agentId)).toBeUndefined()
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

  test('two merges on one line are refused under one merge pick', async ($, on) => {
    const b = bench(on)
    await session($)
    await pick($, b, 'Merge it', [question('Merge PR 1 and PR 2 into main?', ['Merge it', 'Open a PR'])])
    expect(await bash($, b, 'gh pr merge 1; gh pr merge 2')).toBe(ONE_REFUSAL)
    expect(await bash($, b, 'gh pr merge 1')).toBeUndefined()
  })

  test('the merge reader finds each merge and where it runs, and a doubt reads as the default branch', () => {
    expect(mergesOf('git merge x')).toEqual({ local: [''], pr: 0, targets: [{ refs: ['x'] }] })
    expect(mergesOf('git -C /a pull')).toEqual({ local: ['/a'], pr: 0, targets: [{ refs: [] }] })
    expect(mergesOf('git pull origin main')).toEqual({ local: [''], pr: 0, targets: [{ refs: ['main'] }] })
    expect(mergesOf('git merge -m "Merge it." --no-ff fix/x')).toEqual({ local: [''], pr: 0, targets: [{ refs: ['fix/x'] }] })
    expect(mergesOf('cd /a && git merge x').local).toEqual([null])
    expect(mergesOf('git -C rel merge x').local).toEqual([null])
    expect(mergesOf('GIT_DIR=/x/.git git merge y').local).toEqual([null])
    expect(mergesOf("bash -c 'git merge x'").local).toEqual([''])
    expect(mergesOf('git merge --abort; git log --merges')).toEqual({ local: [], pr: 0, targets: [] })
    expect(mergesOf('gh pr merge 1; gh pr view 1')).toEqual({ local: [], pr: 1, targets: [{ pr: '1', refs: [] }] })
    expect(mergesOf('gh pr merge --squash -b "Done." 12')).toEqual({ local: [], pr: 1, targets: [{ pr: '12', refs: [] }] })
    expect(mergesOf('gh pr merge https://github.com/o/r/pull/7')).toEqual({ local: [], pr: 1, targets: [{ pr: '7', refs: [] }] })
    expect(mergesOf('gh pr merge fix/x')).toEqual({ local: [], pr: 1, targets: [{ refs: ['fix/x'] }] })
    expect(mergesOf('gh api repos/o/r/pulls/1/merge -X PUT')).toEqual({ local: [], pr: 1, targets: [{ pr: '1', refs: [] }] })
    expect(mergesOf('gh api repos/o/r/merges -f base=main -f head=feat')).toEqual({ local: [], pr: 1, targets: [{ refs: ['feat'], bases: ['main'] }] })
    expect(mergesOf('grep -n "git merge" notes.md')).toEqual({ local: [], pr: 0, targets: [] })
    expect(isDefaultBranch('refs/heads/main', undefined)).toBe(true)
    expect(isDefaultBranch('refs/heads/fix/x', undefined)).toBe(true)
    expect(isDefaultBranch('refs/heads/fix/x', 'refs/remotes/origin/main')).toBe(false)
    expect(isDefaultBranch('refs/heads/trunk', 'refs/remotes/origin/trunk')).toBe(true)
    expect(isDefaultBranch('refs/heads/main', 'refs/remotes/origin/trunk')).toBe(false)
    expect(isDefaultBranch(undefined, undefined)).toBe(true)
  })
})

describe('AC4: the commit question is asked alone, and names only the commit', () => {
  test('a commit option beside another question is refused, with a reason, and never reaches Mike', async ($, on) => {
    const b = bench(on)
    b.pick = 'Commit it'
    await session($)
    const result = await $.tool.call(ask([OTHER_QUESTION, COMMIT_QUESTION]))
    expect(result.deny).toBe(BUNDLE_REFUSAL)
    expect(BUNDLE_REFUSAL).toContain('alone')
    expect(b.calls.some(call => call.tool === 'AskUserQuestion')).toBe(false)
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toMatch(DECLINED.commit)
  })

  for (const text of [
    'Commit all 27 staged files on fix/persistence-calls-chain-root, merge into main locally, and push main?',
    'Commit it and push to origin?',
    'Commit the version bump and release 0.51.0?',
    'Commit, then merge?',
  ]) {
    test(`a commit question whose own text names a push, a merge or a release is refused: ${JSON.stringify(text)}`, async ($, on) => {
      const b = bench(on)
      b.pick = 'Commit it'
      await session($)
      expect((await $.tool.call(ask([question(text, ['Not yet', 'Commit it'])]))).deny).toBe(NAMED_BUNDLE_REFUSAL)
      expect(b.calls.some(call => call.tool === 'AskUserQuestion')).toBe(false)
      expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toMatch(DECLINED.commit)
    })
  }

  test('the refusal says to ask about the push and the merge afterwards', () => {
    expect(NAMED_BUNDLE_REFUSAL).toContain('Once the commit has landed, ask about the push')
    expect(NAMED_BUNDLE_REFUSAL).toContain('how the branch lands')
  })

  test('a word that only holds the action inside a branch, a path or a quoted message is not a bundle', () => {
    for (const text of [
      'Commit "fix: 🐛 Refuse a forced push." on fix/push-guard?',
      'Commit the change to hooks/mods/merge-reader.ts on main?',
      'Commit `git push` docs on main?',
    ]) {
      expect([text, bundleRefusalOf([question(text, ['Not yet', 'Commit it'])])]).toEqual([text, undefined])
    }
  })

  test('the commit, push and merge questions alone, and questions with no approval option, are let through', async ($, on) => {
    const b = bench(on)
    b.pick = 'A'
    await session($)
    for (const questions of [[COMMIT_QUESTION], [PUSH_QUESTION], [MERGE_QUESTION], [OTHER_QUESTION, question('Which file?', ['x', 'y'])]]) {
      expect((await $.tool.call(ask(questions))).deny).toBeUndefined()
    }
    expect((await $.tool.call(ask([OTHER_QUESTION, PUSH_QUESTION]))).deny).toBe(BUNDLE_REFUSAL)
    expect((await $.tool.call(ask([OTHER_QUESTION, MERGE_QUESTION]))).deny).toBe(BUNDLE_REFUSAL)
  })

  test('a commit option is an option label that leads with the word, or that approves a commit', () => {
    expect(bundleRefusalOf([OTHER_QUESTION, question('Next?', ['Commit and push', 'Wait'])])).toBe(BUNDLE_REFUSAL)
    expect(bundleRefusalOf([OTHER_QUESTION, question('Next?', ['Yes, commit', 'Wait'])])).toBe(BUNDLE_REFUSAL)
    expect(bundleRefusalOf([OTHER_QUESTION, question('Next?', ['Recommit later', 'Review the commit'])])).toBeUndefined()
    expect(bundleRefusalOf([COMMIT_QUESTION])).toBeUndefined()
    expect(bundleRefusalOf('not a list')).toBeUndefined()
  })
})

describe('AC5: a pick is tied to the repository and branch HEAD held when Mike picked', () => {
  test('a commit on another branch than the one picked is refused, and the pick is used up', async ($, on) => {
    const b = bench(on)
    b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'fix/x' }
    await session($)
    await pick($, b)
    b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'main' }
    const refusal = await bash($, b, 'git commit -m "fix: 🐛 X."')
    expect(refusal).toContain('HEAD was on fix/x')
    expect(refusal).toContain('HEAD is now on main')
    b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'fix/x' }
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toMatch(DECLINED.commit)
  })

  test('a push on another branch than the one picked is refused', async ($, on) => {
    const b = bench(on)
    b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'fix/x' }
    await session($)
    await pushPick($, b)
    b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'main' }
    expect(await bash($, b, 'git push')).toContain('HEAD is now on main')
  })

  test('a commit in another worktree is tied to the branch that worktree held, and a repository not read at the pick is refused', async ($, on) => {
    const b = bench(on)
    b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'main' }
    b.repos['/wt'] = { head: 'w1', pushed: 'w1', branch: 'feat/y' }
    await session($)
    await pick($, b)
    b.trees['/wt'] = ''
    expect(await bash($, b, 'git -C /wt commit -m "fix: 🐛 X."')).toBeUndefined()
    await pick($, b)
    delete b.repos['/wt']
    b.repos['/elsewhere'] = { head: 'e1', pushed: 'e1' }
    expect(await bash($, b, 'git -C /elsewhere commit -m "fix: 🐛 X."')).toContain('a branch the gate could not read')
  })

  test('a detached HEAD binds to its commit', async ($, on) => {
    const b = bench(on)
    b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: null }
    await session($)
    await pick($, b)
    b.repos['/repo'] = { head: 'c2', pushed: 'c1', branch: null }
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toContain('detached at c1')
  })

  for (const line of ['git switch -c other', 'git switch main', 'git stash', 'git stash push -m wip', 'git reset -q', 'git -c core.pager=cat reset']) {
    test(`a checkout, switch, stash or reset between the pick and its commit is refused: ${JSON.stringify(line)}`, async ($, on) => {
      const b = bench(on)
      await session($)
      await pick($, b)
      expect(await bash($, b, line)).toBe(MOVE_REFUSAL)
      expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
      expect(await bash($, b, line)).toBeUndefined()
    })
  }

  test('a switch is refused under an unused push pick too, and not under a merge pick or no pick', async ($, on) => {
    const b = bench(on)
    await session($)
    expect(await bash($, b, 'git switch main')).toBeUndefined()
    await pushPick($, b)
    expect(await bash($, b, 'git switch main')).toBe(MOVE_REFUSAL)
    expect(await bash($, b, 'git stash list')).toBeUndefined()
    await pick($, b, 'Merge locally', [MERGE_QUESTION])
    expect(await bash($, b, 'git switch main')).toBeUndefined()
  })

  test('the readers behind the binding', () => {
    expect(headsOf('worktree /repo\nHEAD c1\nbranch refs/heads/main\n\nworktree /wt\nHEAD w1\ndetached\n')).toEqual([
      { top: '/repo', ref: 'refs/heads/main' },
      { top: '/wt', ref: 'detached at w1' },
    ])
    expect(headsOf('')).toEqual([])
    const pick = { action: 'commit' as const, heads: [{ top: '/repo', ref: 'refs/heads/main' }] }
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
    await pick($, b)
    await $.prompt.submit(prompt('thanks, that reads well'))
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toMatch(DECLINED.commit)
    await pick($, b)
    await $.prompt.submit({ ...prompt('wait, one more thing'), turnId: 'running' })
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toMatch(DECLINED.commit)
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
      await pick($, b)
      await $.prompt.submit({ ...prompt('please commit and push now', origin), turnId: 'running' })
      expect(await bash($, b, 'git push')).toMatch(DECLINED.push)
      expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
      await pick($, b)
      await $.prompt.submit(prompt('please commit and push now', origin))
      expect(await bash($, b, 'git push')).toMatch(origin.kind === 'task-notification' ? DECLINED.push : exactly(PUSH_REFUSAL))
      expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
    })
  }

  test('a scheduled turn leaves an unused pick for Mike\'s next turn', async ($, on) => {
    const b = bench(on)
    await session($)
    await pick($, b)
    await $.prompt.submit({ ...prompt('<scheduled-task name="tick">run</scheduled-task>'), turnId: 'running' })
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
  })
})

describe('AC7: only the lanes that commit unattended by design are exempt from the approval', () => {
  for (const origin of [{ kind: 'peer' }, { kind: 'peer-send-message' }, { kind: 'channel', server: 'slack' }, { kind: 'plugin', name: 'x' }, { kind: 'sdk' }] as PromptOrigin[]) {
    test(`a ${origin.kind} turn in Mike's interactive session is gated: it carries outside text`, async ($, on) => {
      const b = bench(on)
      b.pick = 'A'
      await $.session.start(start())
      await $.prompt.submit(prompt('please commit and push', origin))
      expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBe(COMMIT_REFUSAL)
      expect(await bash($, b, 'git push')).toBe(PUSH_REFUSAL)
      expect((await $.tool.call(ask([OTHER_QUESTION, COMMIT_QUESTION]))).deny).toBe(BUNDLE_REFUSAL)
    })
  }

  test('a sub-agent\'s commit and push meet the commit guard, and its bundled question is let through', async ($, on) => {
    const b = bench(on)
    b.pick = 'A'
    await session($, 'delegate it')
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."', 'a1')).toBe(SUBAGENT_REFUSAL.deny)
    expect(await bash($, b, 'git push', 'a1')).toBe(SUBAGENT_REFUSAL.deny)
    expect((await $.tool.call(ask([OTHER_QUESTION, COMMIT_QUESTION], 'a1'))).deny).toBeUndefined()
  })

  test('a sub-agent\'s "Commit it" pick approves nothing for the main loop', async ($, on) => {
    const b = bench(on)
    b.pick = 'Commit it'
    await session($, 'delegate it')
    await $.tool.call(ask([COMMIT_QUESTION], 'a1'))
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toMatch(DECLINED.commit)
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
    b.pick = 'Commit it'
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBe(SUBAGENT_REFUSAL.deny)
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
})
