import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Caller } from '../hooks/mods/commit-guard'
import { BUILT_REFUSAL, FAILED_REFUSAL, FORCE_REFUSAL, MERGE_REFUSAL, PLAIN_REFUSAL, SUBAGENT_REFUSAL, commitVerdict, isReadOnlyPipeline } from '../hooks/mods/commit-guard'
import { subjectVerdict } from '../hooks/mods/commit-subject'
import { parseShell } from '../hooks/mods/shell'
import type { WorkbenchShellParse } from '../types'
import type { Bench } from './bench'
import { HOME, PERSON, bench, start } from './bench'
import { COMMIT_MAIN_PASSES, COMMIT_PASSES, COMMIT_REFUSALS, GREP_READS, GREP_WRITES } from './commit-guard-cases'
import type { CommitLane } from './commit-guard-cases'
import type { Kind } from './commit-guard-parity'
import { DEV_TEAM_VERDICTS, INTENDED_DIFFERENCES, SOURCE } from './commit-guard-parity'

const CALLERS: Readonly<Record<CommitLane, Caller>> = {
  main: { lane: 'main', isUnattended: false },
  'sub-agent': { lane: 'sub-agent', isUnattended: false },
  pipeline: { lane: 'top-level-agent', isUnattended: true },
}
const LANES: readonly CommitLane[] = ['main', 'sub-agent', 'pipeline']

const verdictOf = (line: string, caller: Caller) => {
  const parse = parseShell(line)
  return commitVerdict(parse, line, caller) ?? subjectVerdict(parse)
}

const KINDS: readonly [Exclude<Kind, 'subject' | 'pass'>, { deny: string }][] = [
  ['force', FORCE_REFUSAL],
  ['merge', MERGE_REFUSAL],
  ['subagent', SUBAGENT_REFUSAL],
  ['plain', PLAIN_REFUSAL],
  ['built', BUILT_REFUSAL],
]

const kindOf = (line: string, caller: Caller): Kind | 'other' => {
  const parse = parseShell(line)
  const verdict = commitVerdict(parse, line, caller)
  if (verdict === undefined) return subjectVerdict(parse) === undefined ? 'pass' : 'subject'
  return KINDS.find(([, refusal]) => refusal.deny === verdict.deny)?.[0] ?? 'other'
}

describe('the commit guard, ported from workbench-dev-team: the spellings review rounds found stay refused', () => {
  for (const [line, lanes] of COMMIT_REFUSALS) {
    test(JSON.stringify(line), () => {
      for (const lane of LANES) {
        const verdict = verdictOf(line, CALLERS[lane])
        const isRefused = verdict?.deny.includes('Commit guard (workbench-core)') ?? false
        expect([lane, isRefused]).toEqual([lane, lanes.includes(lane)])
      }
    })
  }
})

describe('the commit guard: the false positives pass', () => {
  for (const line of [...COMMIT_PASSES, ...GREP_READS]) {
    test(`every lane: ${JSON.stringify(line)}`, () => {
      for (const lane of LANES) expect([lane, verdictOf(line, CALLERS[lane])]).toEqual([lane, undefined])
    })
  }
  for (const line of COMMIT_MAIN_PASSES) {
    test(`the main loop: ${JSON.stringify(line)}`, () => {
      expect(verdictOf(line, CALLERS.main)).toBeUndefined()
    })
  }
  for (const line of GREP_WRITES) {
    test(`a search whose output can run is refused for a sub-agent: ${JSON.stringify(line)}`, () => {
      expect(verdictOf(line, CALLERS['sub-agent'])).toBeDefined()
    })
  }
})

describe('the commit guard gives workbench-dev-team 0.55.0\'s verdict on its corpus and core\'s, in four lanes', () => {
  const FOUR: readonly Caller[] = [CALLERS.main, CALLERS['sub-agent'], CALLERS.pipeline, { lane: 'sub-agent', isUnattended: true }]
  test('the record covers the hostile corpus and the bash suite', () => {
    expect(DEV_TEAM_VERDICTS.length).toBe(450)
    expect(SOURCE).toBe('workbench-dev-team a4ccfc5b (0.55.0)')
    expect(DEV_TEAM_VERDICTS.some(([, ...kinds]) => kinds.includes('plain'))).toBe(true)
    expect(DEV_TEAM_VERDICTS.some(([, ...kinds]) => kinds.includes('subagent'))).toBe(true)
  })
  for (const [line, ...kinds] of DEV_TEAM_VERDICTS) {
    test(JSON.stringify(line), () => {
      expect(INTENDED_DIFFERENCES.some(([named]) => named === line)).toBe(false)
      expect(FOUR.map(caller => kindOf(line, caller))).toEqual(kinds)
    })
  }
  for (const [line, ...kinds] of INTENDED_DIFFERENCES) {
    test(`an intended difference, a read-only search dev-team refuses and core passes: ${JSON.stringify(line)}`, () => {
      expect(kinds.some(kind => kind !== 'pass')).toBe(true)
      expect(FOUR.map(caller => kindOf(line, caller))).toEqual(['pass', 'pass', 'pass', 'pass'])
    })
  }
})

describe('the commit guard: each refusal names its rule', () => {
  for (const [line, lane, words] of [
    ['git push --force', 'main', 'forces or deletes'],
    ['gh pr merge 5', 'sub-agent', 'does not merge'],
    ['gh pr merge 5', 'pipeline', 'does not merge'],
    ['git commit -m x', 'sub-agent', 'a sub-agent does not commit or push'],
    ['HUSKY=0 git commit -m x', 'main', 'as a plain line'],
    ['"$PY" script.py', 'pipeline', 'a command name the guard cannot read'],
    ['git commit -m x', 'main', 'a commit subject that breaks the git-commit format'],
  ] as const) {
    test(`${lane}: ${line}`, () => {
      expect(verdictOf(line, CALLERS[lane])?.deny).toContain(words)
    })
  }

  test('the built-name rule meets only an unwatched run', () => {
    expect(verdictOf('"$PY" script.py', { lane: 'main', isUnattended: true })?.deny).toBe(BUILT_REFUSAL.deny)
    expect(verdictOf('"$PY" script.py', { lane: 'top-level-agent', isUnattended: false })).toBeUndefined()
    expect(verdictOf('"$PY" script.py', CALLERS.main)).toBeUndefined()
    expect(verdictOf('"$PY" script.py', { lane: undefined, isUnattended: false })?.deny).toBe(BUILT_REFUSAL.deny)
    expect(verdictOf('g$(echo it) com$(echo mit) -m x', CALLERS.main)).toBeUndefined()
    expect(verdictOf('git commit -m "fix: 🐛 Fix x."', { lane: 'main', isUnattended: true })).toBeUndefined()
  })

  test('a lane the noun cannot give is read as a sub-agent', () => {
    expect(verdictOf('git push', { lane: undefined, isUnattended: false })?.deny).toBe(SUBAGENT_REFUSAL.deny)
  })

  test('a statement not placed is a hidden push, and an open array or case is refused where nobody watches', () => {
    const unplaced = (line: string): WorkbenchShellParse => {
      const parse = parseShell(line)
      return { ...parse, unknowns: [], statements: parse.statements.map(s => ({ ...s, isPlaced: false })) }
    }
    expect(commitVerdict(unplaced('sudo -s git push'), 'sudo -s git push', CALLERS.main)).toEqual(PLAIN_REFUSAL)
    for (const line of ['x=(a $(echo b)', 'case x in\n a) ls ;;']) {
      expect(parseShell(line).unknowns).toEqual(['compound'])
      expect(commitVerdict(parseShell(line), line, CALLERS['sub-agent'])).toEqual(BUILT_REFUSAL)
      expect(commitVerdict(parseShell(line), line, CALLERS.pipeline)).toEqual(BUILT_REFUSAL)
      expect(commitVerdict(parseShell(line), line, CALLERS.main)).toBeUndefined()
    }
    expect(commitVerdict(parseShell('case x in\n a) git push ;;'), 'case x in\n a) git push ;;', CALLERS.main)).toEqual(PLAIN_REFUSAL)
    for (const line of ['x=(a b) ; ls', 'case x in\n a) ls ;;\nesac']) {
      expect(parseShell(line).unknowns).toEqual([])
      expect(commitVerdict(parseShell(line), line, CALLERS['sub-agent'])).toBeUndefined()
    }
  })
})

describe('the commit guard: a read-only grep, rg or sed -n line passes in every lane, whatever words it searches for', () => {
  for (const line of [
    "sed -n '/git push/p' f",
    "sed -n '/gh pr merge/,+5p' f",
    "sed -n -e '/git commit/p' f",
    "sed -n '1,/git push/p' f",
    'sed -nE "/git (push|commit)/=" "$F"',
    "sed -n '/git push/p;/git commit/p' a b",
    "grep -n 'git push' f | awk -F: '{print $1}'",
    "grep -n 'git push' f | awk -F : '{print $1, $2}'",
    "rg -n 'git push' f | sed -n '/commit/p'",
    "grep -rn 'git push' . | sed -n '1,/x/p'",
    "grep -rn 'git push' . --include='*.ts'",
    "rg -n -A3 'gh pr merge' tests",
    "rg -e 'git push' -e 'git commit' f | head -20",
    "grep -rn 'gh pr merge' . 2>/dev/null | column -t | tail -5 | wc -l",
    "rg -n 'git push' f | cut -d: -f1 | sort -u | head -3",
    "grep -oh 'git commit' f | sort | uniq -c | sort -rn",
  ]) {
    test(JSON.stringify(line), () => {
      for (const lane of LANES) expect([lane, verdictOf(line, CALLERS[lane])]).toEqual([lane, undefined])
    })
  }

  for (const line of [
    "sed -n '/git push/e' f",
    "sed -n 's/x/git push/e' f",
    "sed -n '/git push/p' f | sh",
    "sed '/git push/p' f | sh",
    "grep -oh 'git push' f | awk -F: '{system($0)}'",
    "grep -oh 'git push' f | sort -o s.sh; bash s.sh",
    "grep -oh 'git push' f | sed -n '1w s.sh'; bash s.sh",
    "grep -oh 'git push' f | awk '{print > \"s.sh\"}'; bash s.sh",
    "grep -oh 'git push' f | column -t | sh",
    "grep -oh 'git push' f | tee s.sh | head -1; bash s.sh",
    "grep -oh 'git push' f > s.sh; bash s.sh",
    "rg --pre=sh 'git push' f | head -1",
    "awk -F: 'BEGIN{system(\"git push\")}'",
    "bash -c 'git push'",
    'eval "git commit -m x"',
    'env git push',
    'echo "$(git push)"',
    'xargs git commit -m x',
  ]) {
    test(`a search whose script can run, and a commit or push hidden behind a shell, eval, a wrapper or a substitution, stay refused for a sub-agent: ${JSON.stringify(line)}`, () => {
      expect(verdictOf(line, CALLERS['sub-agent'])).toBeDefined()
    })
  }

  for (const line of ["bash -c 'git push'", 'eval "git commit -m x"', 'env git push', 'echo "$(git push)"', 'HUSKY=0 git commit -m x']) {
    test(`a hidden commit or push stays refused in the main loop: ${JSON.stringify(line)}`, () => {
      expect(verdictOf(line, CALLERS.main)).toEqual(PLAIN_REFUSAL)
    })
  }
})

async function refusalOf($: Engine, b: Bench, command: string, agentId?: string): Promise<string | undefined> {
  const before = b.calls.length
  const result = await $.tool.call({ tool: 'Bash', command, ...(agentId === undefined ? {} : { agentId }) } as never)
  expect([command, b.calls.length > before]).toEqual([command, result.deny === undefined])
  return result.deny
}

describe('the commit guard: a grep or rg host hides nothing that runs or writes', () => {
  for (const line of [
    'grep "`git push`" f',
    "rg -n x f | sed -n \"/`git commit`/p\"",
    'grep x <(git push)',
    "grep -n 'git push' f | head -1 && git push",
    "grep -n x f | awk '{\"git push\" | getline}'",
    "grep -oh 'git push' f | awk '{print | \"sh\"}'",
    "grep -oh 'git push' f | sed -n 's/a/b/w out'; bash out",
    "rg -z --pre x 'git push' f",
    "grep -oh 'git push' f >&s.sh; bash s.sh",
    "grep -oh 'git push' f 2>&s.sh; bash s.sh",
    "rg --search-zip 'git push' f | sh",
  ]) {
    test(`refused for a sub-agent: ${JSON.stringify(line)}`, () => {
      expect(verdictOf(line, CALLERS['sub-agent'])).toBeDefined()
    })
  }

  test('a descriptor redirect keeps a pipeline read-only, and a file behind >& or 2>& does not', () => {
    for (const line of ["grep -n 'git push' f >&2", "grep -n 'git push' f 2>&1 | head -1", "grep -n 'git push' f 2>&- | wc -l", "grep -n 'git push' f &>/dev/null"]) {
      expect([line, isReadOnlyPipeline(parseShell(line))]).toEqual([line, true])
    }
    for (const line of ["grep -oh 'git push' f >&s.sh", "grep -oh 'git push' f 2>&s.sh", "grep -oh 'git push' f &>s.sh", "grep -oh 'git push' f > s.sh"]) {
      expect([line, isReadOnlyPipeline(parseShell(line))]).toEqual([line, false])
    }
  })

  test('rg with a zip search, in any short cluster, is not read-only', () => {
    for (const line of ["rg -z 'git push' f", "rg -nz 'git push' f | head", "rg -zn 'git push' f", "rg --search-zip 'git push' f"]) {
      expect([line, isReadOnlyPipeline(parseShell(line))]).toEqual([line, false])
    }
    expect(isReadOnlyPipeline(parseShell("rg -n 'git push' f | head"))).toBe(true)
  })

  for (const line of ['gh api repos/o/r/merges -f base=main -f head=feat', 'gh api -X POST /repos/o/r/merges -f base=main -f head=feat', 'gh api "repos/$R/merges" -f base=main -f head=feat']) {
    test(`the REST branch merge is a merge: ${JSON.stringify(line)}`, () => {
      expect(verdictOf(line, CALLERS['sub-agent'])).toEqual(MERGE_REFUSAL)
      expect(verdictOf(line, CALLERS.pipeline)).toEqual(MERGE_REFUSAL)
    })
  }

  test('a read of other endpoints is not a merge', () => {
    expect(verdictOf('gh api repos/o/r/pulls/5/commits', CALLERS['sub-agent'])).toBeUndefined()
    expect(verdictOf('gh api repos/o/r/merges-report', CALLERS['sub-agent'])).toBeUndefined()
  })
})

describe('the commit guard in the hooks module: each lane reaches it', () => {
  test('a sub-agent commits and pushes nothing, and reads and searches freely', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    await $.prompt.submit({ text: 'delegate it', wait: false, origin: PERSON })
    expect(await refusalOf($, b, 'git commit -m "fix: 🐛 Fix x."', 'a1')).toBe(SUBAGENT_REFUSAL.deny)
    expect(await refusalOf($, b, 'git push', 'a1')).toBe(SUBAGENT_REFUSAL.deny)
    expect(await refusalOf($, b, 'gh pr merge 5', 'a1')).toBe(MERGE_REFUSAL.deny)
    expect(await refusalOf($, b, 'git status', 'a1')).toBeUndefined()
    expect(await refusalOf($, b, 'grep -n "git push" t.ts | sed -n 1,5p', 'a1')).toBeUndefined()
    expect(await refusalOf($, b, "sed -n '/git push/p' t.ts", 'a1')).toBeUndefined()
  })

  test('a forced push is refused in Mike\'s session, even under his typed push', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    await $.prompt.submit({ text: 'push it', wait: false, origin: PERSON })
    expect(await refusalOf($, b, 'git push --force')).toBe(FORCE_REFUSAL.deny)
  })

  test('the pipeline commits and pushes plainly, holds a commit subject to the format, and merges nothing', async ($, on) => {
    const b = bench(on, { env: { HOME, WORKBENCH_DEV_TEAM_PIPELINE: '1', CLAUDE_CODE_AGENT: 'watson' } })
    await $.session.start(start(false))
    await $.prompt.submit({ text: 'Item ID: 12', wait: false, origin: { kind: 'sdk' } })
    expect(await refusalOf($, b, 'git commit -m "fix: 🐛 Fix x."')).toBeUndefined()
    expect(await refusalOf($, b, 'git push')).toBeUndefined()
    expect(await refusalOf($, b, 'git commit -m "fix: 🐛 Fix x"')).toContain('the description does not end with a period')
    expect(await refusalOf($, b, 'gh pr merge 5')).toBe(MERGE_REFUSAL.deny)
    expect(await refusalOf($, b, '"$PY" script.py')).toBeDefined()
    expect(await refusalOf($, b, 'git commit -m "fix: 🐛 Fix x."', 'helper-1')).toBe(SUBAGENT_REFUSAL.deny)
  })

  test('a turn nobody attends in Mike\'s session merges nothing, and an attended one leaves the merge to the approval', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    await $.prompt.submit({ text: 'merge it', wait: false, origin: { kind: 'peer' } })
    expect(await refusalOf($, b, 'gh pr merge 5')).toBe(MERGE_REFUSAL.deny)
    await $.prompt.submit({ text: 'merge it', wait: false, origin: PERSON })
    expect(await refusalOf($, b, 'gh pr merge 5')).toBeUndefined()
  })

  test('the guard refuses a call it failed to judge', () => {
    expect(FAILED_REFUSAL.deny).toContain('could not judge')
  })
})
