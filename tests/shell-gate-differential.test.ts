// The class guard for the commit gate's move onto the shared shell reader.
// The live gate (hooks/mods/commit-approval.ts on hooks/mods/shell.ts) must
// never find fewer commits or pushes than the gate of 77bb2f3, frozen as a
// test oracle in tests/oracle/commit-approval-77bb2f3.ts, on any line: the
// shared corpus, the differential corpus, and a seeded random generator over
// the shell's syntax. A reader that reads bash more exactly may only add
// what the gate finds. Each line where it would find less is a gate that
// lets through what the old one refused.

import { describe, expect, test } from 'claude-code/testing'

import { writesOf } from '../hooks/mods/commit-approval'
import { CAUGHT, LET_THROUGH, OVER_COUNTED } from './commit-corpus'
import { writesOf as oracleWritesOf } from './oracle/commit-approval-77bb2f3'
import { PARSER_CASES } from './shell-cases'

// The lines where the live gate finds fewer than the oracle, with both counts.
function lowerOn(lines: Iterable<string>): string[] {
  const lower: string[] = []
  for (const line of lines) {
    const before = oracleWritesOf(line)
    const after = writesOf(line)
    if (after.commits < before.commits || after.pushes < before.pushes) {
      lower.push(`${JSON.stringify(line)}: before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`)
    }
  }
  return lower
}

// mulberry32: the same seed gives the same lines on every run.
function generator(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Tokens of the syntax both readers read, the shapes each review found, and
// the git words the gate looks for.
const TOKENS = [
  'git', 'git push', 'git commit -m x', 'push', 'commit', 'echo', 'x', 'a', 'bash', 'sh', '-c', '--', 'eval', 'case', 'in', 'esac',
  '[[', ']]', '((', '))', '$((', '$[', ']', '$(', '`', '\\`', ')', '(', '"', "'", '\\', '|', '||', '&&', '&', ';', ';;', '>', '<', '>&-',
  '2>&1', '2>', '<<', '<<<', 'EOF', '\n', '{', '}', 'coproc', 'function', 'f', 'time', '=~', 'if', 'then', 'fi', 'cd', 'sudo', 'env',
  'x=1', '$x', "$'\\x67it'", '#', '<<-', '$"', '|&', 'trap', 'setsid', 'flock', 'cat', 'do', 'done', 'while', '!', '>|', '&>',
  '\\case', '"case"', 'c\\ase', ']]&&', ']]||', ']]>', ']]<', '${y:-$(', '(a|b', 'x)', '$(case', '|git', 'coproc N {', '\\[[', '"[["',
  '((x))', '$((1))', '$[x]', '(())', 'esac)',
]
const SEPARATORS = [' ', ' ', ' ', '', '\n', ';']

function* randomLines(seed: number, count: number): Generator<string> {
  const random = generator(seed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)] as T
  for (let n = 0; n < count; n++) {
    const length = 2 + Math.floor(random() * 10)
    let line = ''
    for (let k = 0; k < length; k++) line += (k ? pick(SEPARATORS) : '') + pick(TOKENS)
    yield line
  }
}

// Lines where reading bash exactly finds less than the old gate did, one for
// each reading the compat pass of commandsOf keeps. Random lines rarely hit
// them, so each is pinned here.
const COMPAT_LINES = [
  // A run of < > & | - was one operator, and the next word its target.
  '>&- cat git push',
  '>>| case if git push',
  '<-- a git commit -m x',
  // Backtick text kept its backslashes, on the line and in a heredoc body.
  'echo `! \\` fi git push`',
  'cat <<EOF\n`! \\` fi git push`\nEOF',
  // A case `)` closed the $( ).
  'echo $(case x in x) esac) git push',
  // Arithmetic text was read as commands.
  '((git push))',
  '(( a ; git push ))',
  'echo $((git push))',
  "$\" )) $[ $(\n$((1)) bash $'\\x67it']]&& $'\\x67it'((",
  "-c || EOF;]]||\nflock eval $[$'\\x67it'\n;",
  // `|&` was a pipe and then an `&`, so `&>` followed.
  '|&>((x)) git push',
  // A [[ ]] test's < was a redirect.
  "[[ !(()) < $[ $'\\x67it' ! (a|b",
]

describe('the live gate never finds fewer commits or pushes than the gate of 77bb2f3', () => {
  test('on the shared corpus and the differential corpus', () => {
    const counted = [...CAUGHT, ...OVER_COUNTED].map(([line]) => line)
    expect(lowerOn([...counted, ...LET_THROUGH, ...PARSER_CASES.map(c => c.command)])).toEqual([])
  })

  // The commit approval suite reads CAUGHT alone, so the counts of the lines
  // the gate over-counts on purpose are pinned here.
  for (const [line, expected] of OVER_COUNTED) {
    test(`over-counted on purpose: ${JSON.stringify(line)}`, () => {
      expect(writesOf(line)).toEqual(expected)
    })
  }

  test('on the lines only the compat reading keeps', () => {
    for (const line of COMPAT_LINES) {
      const before = oracleWritesOf(line)
      expect(before.commits + before.pushes).toBeGreaterThan(0)
    }
    expect(lowerOn(COMPAT_LINES)).toEqual([])
  })

  for (const seed of [1, 2, 3]) {
    test(`on 50,000 random lines, seed ${seed}`, { timeoutMs: 60_000 }, () => {
      expect(lowerOn(randomLines(seed, 50_000))).toEqual([])
    })
  }

  // The guard must be able to fail: the oracle finds a push where a reader
  // that skips every line would find none.
  test('control: the oracle finds what it should', () => {
    expect(oracleWritesOf('git push')).toEqual({ commits: 0, pushes: 1 })
    expect(oracleWritesOf('>&- cat git push')).toEqual({ commits: 0, pushes: 1 })
  })
})
