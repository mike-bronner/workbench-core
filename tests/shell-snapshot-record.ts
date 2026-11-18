import { SNAPSHOT } from './shell-snapshot-23ff5c3.ts'
import type { Reader } from './shell-snapshot-reading.ts'
import { COMMIT_CORPORA, GUARD_CORPORA, RANDOM_COUNT, RANDOM_SEED, hashOf, randomLines, readingOf } from './shell-snapshot-reading.ts'

const [readerPath] = process.argv.slice(2)
if (readerPath === undefined) throw new Error('usage: node tests/shell-snapshot-record.ts <absolute path of the 23ff5c3 hooks/mods/shell.ts>')
const reader = (await import(readerPath)) as Reader

const lines = [...new Set([...SNAPSHOT.map(([line]) => line), ...COMMIT_CORPORA, ...GUARD_CORPORA])]
const random = randomLines(RANDOM_SEED, RANDOM_COUNT).map(line => `'${hashOf(readingOf(reader, line))}'`)
const rows: string[] = []
for (let k = 0; k < random.length; k += 8) rows.push(`  ${random.slice(k, k + 8).join(', ')},`)

process.stdout.write(
  [
    'export const SNAPSHOT: readonly (readonly [string, string])[] = [',
    ...lines.map(line => `  [${JSON.stringify(line)}, '${hashOf(readingOf(reader, line))}'],`),
    ']',
    '',
    'export const RANDOM_SNAPSHOT: readonly string[] = [',
    ...rows,
    ']',
    '',
  ].join('\n'),
)
