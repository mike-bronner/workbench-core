import type { commandsOf, decodedOf, expandingOf, parseShell } from '../hooks/mods/shell.ts'
import { CAUGHT, LET_THROUGH, OVER_COUNTED } from './commit-corpus.ts'
import { COMMIT_MAIN_PASSES, COMMIT_PASSES, COMMIT_REFUSALS, GREP_READS, GREP_WRITES } from './commit-guard-cases.ts'
import { COMMIT_SUITE, HOSTILE } from './commit-guard-corpus.ts'
import { CORE_REFUSES, DEV_TEAM_VERDICTS, INTENDED_DIFFERENCES } from './commit-guard-parity.ts'
import { DENIED } from './guard-corpus/guard-cases.ts'
import { WORLD_DENIED } from './guard-corpus/world-cases.ts'
import { PARSER_CASES } from './shell-cases.ts'

export type Reader = { parseShell: typeof parseShell; commandsOf: typeof commandsOf; expandingOf: typeof expandingOf; decodedOf: typeof decodedOf }

export function hashOf(text: string): string {
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

export function readingOf(reader: Reader, line: string, takenOut?: string): string {
  try {
    const parse = reader.parseShell(line)
    return JSON.stringify({
      statements: parse.statements,
      unknowns: parse.unknowns.filter(unknown => unknown !== takenOut),
      expanding: parse.statements.map(reader.expandingOf),
      decoded: parse.statements.map(reader.decodedOf),
      exact: reader.commandsOf(line),
      compat: reader.commandsOf(line, true),
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

export const RANDOM_SEED = 17
export const RANDOM_COUNT = 4000

export function randomLines(seed: number, count: number): string[] {
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

const bashCommandOf = (payload: string): string | undefined => {
  try {
    const call = JSON.parse(payload) as { tool_name?: unknown; tool_input?: { command?: unknown } }
    return call.tool_name === 'Bash' && typeof call.tool_input?.command === 'string' ? call.tool_input.command : undefined
  } catch {
    return undefined
  }
}

export const COMMIT_CORPORA: readonly string[] = [
  ...HOSTILE,
  ...COMMIT_SUITE,
  ...[...CAUGHT, ...OVER_COUNTED].map(([line]) => line),
  ...LET_THROUGH,
  ...PARSER_CASES.map(c => c.command),
]

export const GUARD_CORPORA: readonly string[] = [
  ...COMMIT_PASSES,
  ...GREP_READS,
  ...GREP_WRITES,
  ...COMMIT_MAIN_PASSES,
  ...COMMIT_REFUSALS.map(([line]) => line),
  ...[...DEV_TEAM_VERDICTS, ...INTENDED_DIFFERENCES, ...CORE_REFUSES].map(([line]) => line),
  ...[...DENIED, ...WORLD_DENIED].flatMap(c => bashCommandOf(c.payload) ?? []),
]
