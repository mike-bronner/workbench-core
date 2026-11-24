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
  catchUpsOf,
  commandsOf,
  dirOf,
  headsOf,
  isDefaultBranch,
  mergesOf,
  movesHead,
  pickOf,
  readLine,
  rewritesOf,
  writesOf,
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
    b.files.set('/repo/scripts/release.sh', 'echo released\n')
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
      b.files.set('/repo/env.sh', 'export X=1\n')
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
    b.files.set('/repo/script.sh', 'echo hi\n')
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

describe('a local merge or pull that lands a ledger unit branch is gated as a commit', () => {
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
    'echo unit/a | xargs git pull origin main',
  ]) {
    test(`with no approval, a unit landing asks Mike as a commit and names its line: ${JSON.stringify(line)}`, async ($, on) => {
      const b = withLedger(on)
      await session($)
      const refusal = await bash($, b, line)
      expect(refusal).toMatch(DECLINED.commit)
      expect(refusal).toContain(`\`${line}\``)
      expect(refusal).toContain('the branch fix/x')
    })
  }

  for (const line of ['git merge origin/main', 'git merge --no-ff main', 'git merge --no-ff unit/c', 'git merge -m "unit/a" feat/y', 'git pull', 'git pull origin', 'git pull origin main', 'git pull --no-ff . feat/y', 'git merge --abort']) {
    test(`a catch-up merge or pull of a branch that is no unit runs with no question: ${JSON.stringify(line)}`, async ($, on) => {
      const b = withLedger(on)
      await session($)
      expect(await bash($, b, line)).toBeUndefined()
    })
  }

  test('a merge or pull that names no branch reads the upstream, and asks when it is a unit branch or cannot be read', async ($, on) => {
    const b = withLedger(on)
    await session($)
    b.repos['/repo'] = { ...FEATURE, upstream: 'refs/heads/unit/a' }
    expect(await bash($, b, 'git pull')).toMatch(DECLINED.commit)
    expect(await bash($, b, 'git merge')).toMatch(DECLINED.commit)
    b.repos['/repo'] = { ...FEATURE, upstream: 'refs/remotes/origin/unit/a' }
    expect(await bash($, b, 'git pull')).toMatch(DECLINED.commit)
    expect(await bash($, b, 'git pull origin')).toMatch(DECLINED.commit)
    expect(await bash($, b, 'git merge')).toMatch(DECLINED.commit)
    b.repos['/repo'] = { ...FEATURE, upstream: 'refs/heads/feat/y' }
    expect(await bash($, b, 'git pull')).toBeUndefined()
    b.repos['/repo'] = { ...FEATURE, upstream: 'refs/remotes/origin/feat-x' }
    expect(await bash($, b, 'git pull')).toBeUndefined()
    b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'fix/x', originHead: 'main' }
    expect(await bash($, b, 'git pull')).toMatch(DECLINED.commit)
    expect(await bash($, b, 'git merge')).toMatch(DECLINED.commit)
  })

  for (const line of ['git pull /tmp/unit-tree', 'git pull file:///tmp/r', 'git pull ../unit-tree', 'git pull upstream', 'git pull .', 'git pull "$S"', 'git pull --rebase /tmp/unit-tree']) {
    test(`a pull that names a source other than the branch's remote, with no refspec, asks as a commit: ${JSON.stringify(line)}`, async ($, on) => {
      const b = withLedger(on)
      await session($)
      expect(await bash($, b, line)).toMatch(DECLINED.commit)
    })
  }

  test("a pull that names the branch's own remote reads the upstream, and one whose branch or remote cannot be read asks", async ($, on) => {
    const b = withLedger(on)
    await session($)
    expect(await bash($, b, 'git pull origin')).toBeUndefined()
    b.repos['/repo'] = { ...FEATURE, upstream: 'refs/heads/feat/y', remote: '.' }
    expect(await bash($, b, 'git pull .')).toBeUndefined()
    b.repos['/repo'] = { ...FEATURE, upstream: 'refs/heads/unit/a', remote: '.' }
    expect(await bash($, b, 'git pull .')).toMatch(DECLINED.commit)
    b.repos['/repo'] = { ...FEATURE, remote: undefined }
    expect(await bash($, b, 'git pull origin')).toMatch(DECLINED.commit)
    expect(await bash($, b, 'git pull')).toBeUndefined()
    b.repos['/repo'] = { ...FEATURE, branch: null }
    expect(await bash($, b, 'git pull origin')).toMatch(DECLINED.merge)
  })

  for (const line of ['git merge "$B"', 'git merge 1a2b3c4', 'git merge --continue', 'git -c alias.m=merge m feat/y', 'git pull /tmp/tree HEAD', 'git merge a1b2c3', 'git merge fetch_head', 'git merge aaaaaaaa0123456789abcdef0123456789abcdef0123456789abcdefbbbbbbbb']) {
    test(`a merge whose merged refs cannot be read asks as a commit: ${JSON.stringify(line)}`, async ($, on) => {
      const b = withLedger(on)
      await session($)
      expect(await bash($, b, line)).toMatch(DECLINED.commit)
    })
  }

  for (const [name, text] of [
    ['a ledger that is not JSON', '{'],
    ['a ledger of another shape', '{"version":2,"entries":[]}'],
  ] as const) {
    test(`with ${name}, every merge or pull on a feature branch asks`, async ($, on) => {
      const b = withLedger(on, text)
      await session($)
      expect(await bash($, b, 'git merge origin/main')).toMatch(DECLINED.commit)
      expect(await bash($, b, 'git pull')).toMatch(DECLINED.commit)
      expect(await bash($, b, 'git pull origin main')).toMatch(DECLINED.commit)
    })

    test(`with ${name}, a sub-agent's merge that makes no commit is refused as a commit`, async ($, on) => {
      const b = withLedger(on, text)
      await $.session.start(start())
      await $.prompt.submit(prompt('delegate it'))
      expect(await bash($, b, 'git merge --ff-only origin/main', 'a1')).toBe(SUBAGENT_REFUSAL.deny)
    })
  }

  test('with no HOME to find the ledger, a merge on a feature branch asks', async ($, on) => {
    const b = bench(on, { env: {} })
    b.repos['/repo'] = { ...FEATURE }
    await session($)
    expect(await bash($, b, 'git merge origin/main')).toMatch(DECLINED.commit)
    expect(await bash($, b, 'git pull')).toMatch(DECLINED.commit)
  })

  test('with no ledger file, nothing is a unit branch, so a merge runs', async ($, on) => {
    const b = bench(on)
    b.repos['/repo'] = { ...FEATURE }
    await session($)
    expect(await bash($, b, 'git merge --no-ff unit/a')).toBeUndefined()
  })

  test('a commit pick approves one landing, and nothing after it', async ($, on) => {
    const b = withLedger(on)
    await session($)
    await pick($, b)
    expect(await bash($, b, 'git merge --no-ff unit/a')).toBeUndefined()
    expect(await bash($, b, 'git merge --no-ff unit/b')).toMatch(DECLINED.commit)
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toMatch(DECLINED.commit)
  })

  test('a commit pick used by a commit approves no landing after it', async ($, on) => {
    const b = withLedger(on)
    await session($)
    await pick($, b)
    expect(await bash($, b, 'git commit -m "fix: 🐛 X."')).toBeUndefined()
    expect(await bash($, b, 'git merge --no-ff unit/a')).toMatch(DECLINED.commit)
  })

  test('the pick is tied to the branch HEAD held when Mike picked', async ($, on) => {
    const b = withLedger(on)
    await session($)
    await pick($, b)
    b.repos['/repo'] = { ...FEATURE, branch: 'feat/y' }
    const refusal = await bash($, b, 'git -C /repo merge --no-ff unit/a')
    expect(refusal).toContain('HEAD was on fix/x')
    expect(refusal).toContain('HEAD is now on feat/y')
    b.repos['/repo'] = { ...FEATURE }
    expect(await bash($, b, 'git -C /repo merge --no-ff unit/a')).toMatch(DECLINED.commit)
  })

  test('a typed commit request approves landings for its turn, and a push request approves none', async ($, on) => {
    const b = withLedger(on)
    await session($, 'commit it')
    expect(await bash($, b, 'git merge --no-ff unit/a')).toBeUndefined()
    expect(await bash($, b, 'git -C /repo pull . unit/b')).toBeUndefined()
    await $.prompt.submit(prompt('push it'))
    expect(await bash($, b, 'git merge --no-ff unit/a')).toMatch(DECLINED.commit)
  })

  test('a merge pick or a typed merge request approves no landing on a feature branch', async ($, on) => {
    const b = withLedger(on)
    await session($)
    await pick($, b, 'Merge locally', [MERGE_QUESTION])
    expect(await bash($, b, 'git merge --no-ff unit/a')).toMatch(DECLINED.commit)
    await $.prompt.submit(prompt('merge it locally'))
    expect(await bash($, b, 'git merge --no-ff unit/a')).toMatch(DECLINED.commit)
  })

  test('two landings, or a landing and a commit, on one line are refused under any approval', async ($, on) => {
    const b = withLedger(on)
    await session($, 'commit it')
    expect(await bash($, b, 'git merge --no-ff unit/a && git commit -m "fix: 🐛 X."')).toBe(ONE_REFUSAL)
    expect(await bash($, b, 'git merge --no-ff unit/a; git pull . unit/b')).toBe(ONE_REFUSAL)
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
    'git config branch.main.merge refs/heads/fix/x && git pull',
    'git -c alias.m=merge m origin/main',
    'echo origin/main | xargs git merge',
    'git -c branch.main.merge=refs/heads/fix/x pull',
    'git -c remote.origin.url=/path/to/other pull origin main',
    'git -c include.path=/tmp/evil.config pull',
    'HOME=/tmp/evil git pull',
    'XDG_CONFIG_HOME=/tmp/evil git pull',
    'env HOME=/tmp/evil git pull',
    'export HOME=/tmp/evil; git pull',
    'git -c remote.origin.fetch=+refs/heads/fix/x:refs/remotes/origin/main fetch && git merge origin/main',
    'git fetch --prune && git merge origin/main',
    'git fetch origin fix/x && git merge origin/main',
    'git pull --rebase',
    'git pull -r',
    'git pull --rebase=merges',
    'git pull --rebase=interactive origin main',
    'git pull --rebase=true',
    'git pull --refmap=+refs/heads/fix/x:refs/remotes/origin/main',
    'git merge -s ours origin/main',
  ]) {
    test(`a merge or pull into main of anything but its own upstream still asks for a merge approval: ${JSON.stringify(line)}`, async ($, on) => {
      const b = onMain(on)
      await session($)
      expect(await bash($, b, line)).toMatch(DECLINED.merge)
    })
  }

  test('a fetch that maps a branch onto origin/main before the merge is no catch-up, and asks for the merge with the rewrite', async ($, on) => {
    const line = 'git fetch --refmap=+refs/heads/fix/x:refs/remotes/origin/main origin fix/x && git merge origin/main'
    const b = onMain(on)
    await session($)
    expect(catchUpsOf(line)).toEqual([])
    expect(await bash($, b, line)).toBe(
      'This line was refused: it runs a merge into the default branch and history rewrite, and Mike has approved none of them. ' +
        'One pick approves one action, so run each as a line of its own, and ask him about each one through AskUserQuestion, alone.',
    )
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
      expect(await bash($, b, 'git pull')).toMatch(DECLINED.merge)
      expect(await bash($, b, 'git pull origin main')).toMatch(DECLINED.merge)
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
    for (const value of ['true', 'merges', 'interactive', 'i', 'm', 'yes', '']) {
      b.repos['/repo'] = { ...MAIN, pullRebase: value }
      expect([value, DECLINED.merge.test((await bash($, b, 'git pull')) ?? '')]).toEqual([value, true])
      b.repos['/repo'] = { ...MAIN, branchRebase: value }
      expect([value, DECLINED.merge.test((await bash($, b, 'git pull origin main')) ?? '')]).toEqual([value, true])
    }
    b.repos['/repo'] = { ...MAIN, pullRebase: 'true' }
    expect(await bash($, b, 'git merge origin/main')).toBeUndefined()
    expect(await bash($, b, 'git pull --no-rebase')).toBeUndefined()
    b.repos['/repo'] = { ...MAIN, pullRebase: 'true', branchRebase: 'false' }
    expect(await bash($, b, 'git pull')).toBeUndefined()
    b.repos['/repo'] = { ...MAIN, pullRebase: 'false', branchRebase: 'merges' }
    expect(await bash($, b, 'git pull')).toMatch(DECLINED.merge)
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
