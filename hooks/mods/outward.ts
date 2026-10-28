import { parseShell } from './shell'

export type Refusals = Readonly<Record<string, { text: string; count: number }>>
export type Reads = Readonly<Record<string, number>>

const OUTWARD_WORDS: ReadonlySet<string> = new Set(['claim', 'submit', 'publish'])
const GH_SUBMITS: readonly (readonly [string, string])[] = [
  ['pr', 'ready'],
  ['release', 'create'],
  ['issue', 'close'],
]
const REFUSAL_WORDS = /\b(cannot|can't|could not|refus\w*|reject\w*|denied|invalid|not found|wrong|failed|error|does not exist|not allowed|forbidden|unauthori[sz]ed)\b|"(ok|success)"\s*:\s*false/i
export const LISTED_READS = 20
export const KEPT_READS = 200
export const ENTRY_LIMIT = 200
export const KEPT_REFUSAL = 200

const mcpNameOf = (tool: string): string | undefined => (tool.startsWith('mcp__') ? tool.slice(tool.lastIndexOf('__') + 2) : undefined)

export const isMcpTool = (tool: string): boolean => mcpNameOf(tool) !== undefined

export function isOutwardTool(tool: string): boolean {
  const words = (mcpNameOf(tool) ?? '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[_.-]+/)
  return OUTWARD_WORDS.has(words[0] ?? '') || OUTWARD_WORDS.has(words.at(-1) ?? '')
}

export function isSubmitLine(line: string): boolean {
  return parseShell(line).statements.some(
    st =>
      st.name === 'gh' &&
      st.subcommandAt >= 0 &&
      GH_SUBMITS.some(([noun, verb]) => st.args[st.subcommandAt] === noun && st.args[st.subcommandAt + 1] === verb) &&
      !(st.args[st.subcommandAt] === 'pr' && st.args.includes('--undo')),
  )
}

export const callerKeyOf = (agentId: string | undefined, tool: string): string => `${agentId ?? 'main'} ${tool}`

export const sourcesRefusalOf = (tool: string): string =>
  `Workbench outward-call check (workbench-core): ${tool} sends work out. This is its first call here, so it is refused once. Before you call it again:\n` +
  "1. Quote the description of each required field from the tool's schema.\n" +
  '2. For each field, say where its value came from: a tool reply, a file, a page or the user.\n' +
  '3. If a description names a tool as the source of a value, such as "the id X gave you" or "the receipts you were handed", call that tool first and take the value from its reply. Never send {}, a placeholder or a guess in its place.\n' +
  '4. Call the tool again. The next call goes through.\n' +
  '/workbench-core:read-the-contract holds the full check.'

export const repeatReminderOf = (tool: string): string =>
  `Workbench outward-call check (workbench-core): ${tool} returned the same refusal twice. Stop changing the inputs. ` +
  'Find the contract that defines what the tool accepts: its field descriptions, the server instructions, and the replies of the tools that hand out its values. ' +
  'Quote it, then send the call it describes, as /workbench-core:read-the-contract says.'

const textOf = (result: { text?: unknown; result?: unknown }): string =>
  typeof result.text === 'string' && result.text.trim() !== ''
    ? result.text.trim()
    : typeof result.result === 'string'
      ? result.result.trim()
      : JSON.stringify(result.result ?? '')

export function refusalTextOf(result: { isError?: boolean; text?: unknown; result?: unknown }): string | undefined {
  const kept = textOf(result).slice(0, KEPT_REFUSAL)
  return result.isError === true || REFUSAL_WORDS.test(kept) ? kept : undefined
}

export function refusalsAfter(refusals: Refusals, key: string, text: string | undefined): Refusals {
  const { [key]: last, ...rest } = refusals
  if (text === undefined) return rest
  return { ...rest, [key]: { text, count: last?.text === text ? last.count + 1 : 1 } }
}

export const isRepeated = (refusals: Refusals, key: string): boolean => (refusals[key]?.count ?? 0) >= 2

export function cleanSourceOf(source: string): string {
  const flat = source.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim()
  const bare = /^[a-z][a-z0-9+.-]*:\/\//i.test(flat) ? flat.replace(/[?#].*$/, '') : flat
  return bare.length > ENTRY_LIMIT ? `${bare.slice(0, ENTRY_LIMIT - 1)}…` : bare
}

export function readSourceOf(tool: string, input: Record<string, unknown>): string | undefined {
  const source = tool === 'Read' ? input.file_path : tool === 'WebFetch' || (isMcpTool(tool) && !isOutwardTool(tool)) ? input.url : undefined
  const clean = typeof source === 'string' ? cleanSourceOf(source) : ''
  return clean === '' ? undefined : clean
}

export const readsAfter = (reads: Reads, source: string, at: number): Reads =>
  Object.fromEntries(
    Object.entries({ ...reads, [source]: at })
      .sort(([, a], [, b]) => b - a)
      .slice(0, KEPT_READS),
  )

export function ageOf(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return 'less than 1 minute ago'
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  return hours === 0 ? `${unit(minutes, 'minute')} ago` : rest === 0 ? `${unit(hours, 'hour')} ago` : `${unit(hours, 'hour')} ${unit(rest, 'minute')} ago`
}

export function freshnessOf(reads: Reads, now: number): string | undefined {
  const sources = Object.entries(reads).sort(([, a], [, b]) => b - a)
  if (sources.length === 0) return undefined
  const listed = sources.slice(0, LISTED_READS).map(([source, at]) => `- ${cleanSourceOf(source)}: read ${ageOf(now - at)}`)
  const more = sources.length > LISTED_READS ? [`- and ${sources.length - LISTED_READS} more, read earlier`] : []
  return [
    'Workbench freshness check (workbench-core): this call sends work out. The session read these sources, newest first:',
    ...listed,
    ...more,
    'A source may have changed since you read it. Re-fetch each one this work depends on before you rely on it, as /workbench-core:recheck-before-done says.',
  ].join('\n')
}
