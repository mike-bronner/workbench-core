import { describe, expect, test } from 'claude-code/testing'

import * as shell from '../hooks/mods/shell'
import { CAUGHT, LET_THROUGH, OVER_COUNTED } from './commit-corpus'
import { COMMIT_MAIN_PASSES, COMMIT_PASSES, COMMIT_REFUSALS, GREP_READS, GREP_WRITES } from './commit-guard-cases'
import { COMMIT_SUITE, HOSTILE } from './commit-guard-corpus'
import { CORE_REFUSES, DEV_TEAM_VERDICTS, INTENDED_DIFFERENCES } from './commit-guard-parity'
import { DENIED } from './guard-corpus/guard-cases'
import { WORLD_DENIED } from './guard-corpus/world-cases'
import { PARSER_CASES } from './shell-cases'
import { RANDOM_SNAPSHOT, SNAPSHOT } from './shell-snapshot-23ff5c3'
import { RANDOM_COUNT, RANDOM_SEED, hashOf, randomLines, readingOf } from './shell-snapshot-reading'

const { parseShell } = shell

const bashCommandsOf = (cases: readonly { payload: string }[]): string[] =>
  cases.flatMap(c => {
    const call = JSON.parse(c.payload) as { tool_name?: unknown; tool_input?: { command?: unknown } }
    return call.tool_name === 'Bash' && typeof call.tool_input?.command === 'string' ? [call.tool_input.command] : []
  })

const changed = (pairs: readonly (readonly [string, string])[], isEqualsTakenOut = false): string[] =>
  pairs.filter(([line, hash]) => hashOf(readingOf(shell, line, isEqualsTakenOut)) !== hash).map(([line]) => line)

const EQUALS_LINES: readonly string[] = ['=git push', '=rm README.md', '=~']
const EQUALS_RANDOM_LINES: readonly string[] = [
  '}} =@P $$ $ esac {$${$',
  '/ ="esac"<<<',
  '="esac" $HOME\n(( > <<<;:-',
  '/\n=# :- |&\n]] ||',
  ':-[[ ]] =}}',
  '{ =eval',
]
const isEqualsLine = ([line]: readonly [string, string]): boolean => EQUALS_LINES.includes(line) || EQUALS_RANDOM_LINES.includes(line)

const randomPairs = (): (readonly [string, string])[] =>
  randomLines(RANDOM_SEED, RANDOM_COUNT).map((line, k) => [line, RANDOM_SNAPSHOT[k] as string])

describe('AC3: every line reads as the reader of 23ff5c3 read it', () => {
  test('the snapshot holds every line of the corpora', () => {
    const held = new Set(SNAPSHOT.map(([line]) => line))
    const corpora = [
      ...HOSTILE,
      ...COMMIT_SUITE,
      ...[...CAUGHT, ...OVER_COUNTED].map(([line]) => line),
      ...LET_THROUGH,
      ...PARSER_CASES.map(c => c.command),
    ]
    expect(corpora.filter(line => !held.has(line))).toEqual([])
  })

  test("the snapshot holds every line of the guard suites' own corpora, and every Bash command the guard corpus replays", () => {
    const held = new Set(SNAPSHOT.map(([line]) => line))
    const replayed = bashCommandsOf([...DENIED, ...WORLD_DENIED])
    expect(replayed.length).toBeGreaterThan(1300)
    const corpora = [
      ...COMMIT_PASSES,
      ...GREP_READS,
      ...GREP_WRITES,
      ...COMMIT_MAIN_PASSES,
      ...COMMIT_REFUSALS.map(([line]) => line),
      ...[...DEV_TEAM_VERDICTS, ...INTENDED_DIFFERENCES, ...CORE_REFUSES].map(([line]) => line),
      ...replayed,
    ]
    expect(corpora.filter(line => !held.has(line))).toEqual([])
  })

  test('control: the completeness check finds a line the snapshot lacks', () => {
    const held = new Set(SNAPSHOT.map(([line]) => line))
    const absent = 'echo no corpus holds this line'
    expect([absent, COMMIT_PASSES[0] as string].filter(line => !held.has(line))).toEqual([absent])
  })

  test('statements, unknowns, expanding and decoded words, commandsOf and the compat reading are unchanged on every snapshot line but the named = lines', () => {
    expect(SNAPSHOT.length).toBeGreaterThan(3400)
    expect(changed(SNAPSHOT.filter(pair => !isEqualsLine(pair)))).toEqual([])
  })

  test('they are unchanged on 4,000 seeded random lines but the named = lines', () => {
    expect(RANDOM_COUNT).toBe(4000)
    expect(RANDOM_SNAPSHOT).toHaveLength(RANDOM_COUNT)
    expect(changed(randomPairs().filter(pair => !isEqualsLine(pair)))).toEqual([])
  })

  test('each named = line now reads the expansion unknown, and reads as 23ff5c3 read it with that unknown taken out', () => {
    const snapshot = SNAPSHOT.filter(isEqualsLine)
    const random = randomPairs().filter(isEqualsLine)
    expect(snapshot.map(([line]) => line)).toEqual([...EQUALS_LINES])
    expect(random.map(([line]) => line)).toEqual([...EQUALS_RANDOM_LINES])
    for (const [line] of [...snapshot, ...random]) expect([line, parseShell(line).unknowns.includes('expansion')]).toEqual([line, true])
    expect(changed([...snapshot, ...random])).toEqual([...EQUALS_LINES, ...EQUALS_RANDOM_LINES])
    expect(changed([...snapshot, ...random], true)).toEqual([])
  })

  test('control: a snapshot hash tells two readings apart', () => {
    const hashes = new Map(SNAPSHOT)
    expect(new Set(hashes.values()).size).toBeGreaterThan(1000)
    expect(changed([[': "${x}"', hashes.get(': "${x@P}"') as string]])).toEqual([': "${x}"'])
    expect(changed([[': "${x@P}"', hashes.get(': "${x@P}"') as string]])).toEqual([])
  })
})
