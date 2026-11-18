import { describe, expect, test } from 'claude-code/testing'

import { commandsOf, decodedOf, expandingOf, parseShell } from '../hooks/mods/shell'
import { CAUGHT, LET_THROUGH, OVER_COUNTED } from './commit-corpus'
import { COMMIT_SUITE, HOSTILE } from './commit-guard-corpus'
import { PARSER_CASES } from './shell-cases'
import { RANDOM_SNAPSHOT, SNAPSHOT } from './shell-snapshot-23ff5c3'

function hashOf(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

function readingOf(line: string, isEqualsTakenOut = false): string {
  try {
    const parse = parseShell(line)
    return JSON.stringify({
      statements: parse.statements,
      unknowns: isEqualsTakenOut ? parse.unknowns.filter(unknown => unknown !== 'expansion') : parse.unknowns,
      expanding: parse.statements.map(expandingOf),
      decoded: parse.statements.map(decodedOf),
      exact: commandsOf(line),
      compat: commandsOf(line, true),
    })
  } catch (error) {
    return `throws: ${String(error)}`
  }
}

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

const TOKENS = [
  'echo', 'x', 'git push', 'bash', '-c', 'eval', 'cat', '$x', '$HOME', '${', '${x', '${x}', '${#x}', '${x:-', '${x//&/and}', '${arr[@]}',
  '${x@P}', '${(e)x}', '${(%)x}', '${!x}', '$${', '$$(', '$$', '$', '{', '}', '}}', ':-', '@P', '[@]', '#', '%', '/', '"', "'", '\\',
  '\\\n', '`', '$(', '$((', '((', '))', '(', ')', '$[', ']', '[[', ']]', '|', '|&', '||', '&&', '&', ';', ';;', '<(', '>(', '<', '>',
  '<<E\nbody ${x@P}\nE\n', "<<'E'\n${y z}\nE\n", '<<E\n${x:-a}\nE\n', '<<<', 'case', 'in', 'esac', '"esac"', 'coproc', 'function',
  'f()', '\n', '=', 'x=(', "$'", '$"',
]
const SEPARATORS = [' ', ' ', ' ', '', '\n', ';']

function randomLines(seed: number, count: number): string[] {
  const random = generator(seed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)] as T
  const lines: string[] = []
  for (let n = 0; n < count; n++) {
    const length = 2 + Math.floor(random() * 10)
    let line = ''
    for (let k = 0; k < length; k++) line += (k ? pick(SEPARATORS) : '') + pick(TOKENS)
    lines.push(line)
  }
  return lines
}

const changed = (pairs: readonly (readonly [string, string])[], isEqualsTakenOut = false): string[] =>
  pairs.filter(([line, hash]) => hashOf(readingOf(line, isEqualsTakenOut)) !== hash).map(([line]) => line)

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
  randomLines(17, RANDOM_SNAPSHOT.length).map((line, k) => [line, RANDOM_SNAPSHOT[k] as string])

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

  test('statements, unknowns, expanding and decoded words, commandsOf and the compat reading are unchanged on every snapshot line but the named = lines', () => {
    expect(SNAPSHOT.length).toBeGreaterThan(1900)
    expect(changed(SNAPSHOT.filter(pair => !isEqualsLine(pair)))).toEqual([])
  })

  test('they are unchanged on 4,000 seeded random lines but the named = lines', () => {
    expect(RANDOM_SNAPSHOT).toHaveLength(4000)
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
