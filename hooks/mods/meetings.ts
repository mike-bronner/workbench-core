import type { WorkbenchShellParse as ShellParse } from '../../types'

export const FV_SERVE = '/Applications/FluidVoice.app/Contents/Helpers/fv-serve'
export const SCRIPT = 'meeting-notes.sh'
export const DOORBELL_MS = 10_000
export const RUN_TIMEOUT_MS = 60_000

export const meetingsDirOf = (home: string): string => `${home}/Library/Application Support/FluidVoice/Meetings`

export const isInside = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`)

const MEET_READS: ReadonlySet<string> = new Set(['list', 'show', 'summary', 'search'])

const WRITER_HEAD = 'Meeting-writer guard (workbench-core): '
const WRITER_ADVICE =
  'The meeting-writer runs only the read-only fv-serve commands, one per call, by its absolute path, with no pipe, redirect or other program: meet list, meet show, meet summary, meet search, and status with no argument or --json. ' +
  'Run the fv-serve command on its own. Write vault notes through the memory MCP tools.'

function isFvRead(words: readonly string[]): boolean {
  const [program, verb, ...rest] = words
  if (program !== FV_SERVE) return false
  if (verb === 'status') return rest.length === 0 || (rest.length === 1 && rest[0] === '--json')
  return verb === 'meet' && MEET_READS.has(rest[0] ?? '')
}

export function meetingWriterRefusal(parse: ShellParse): string | undefined {
  if (parse.unknowns.length > 0 || parse.statements.length !== 1) return `${WRITER_HEAD}this line is not one plain fv-serve call. ${WRITER_ADVICE}`
  const [s] = parse.statements
  if (s === undefined) return `${WRITER_HEAD}this line runs nothing. ${WRITER_ADVICE}`
  const isPlain = s.isPlaced && s.wrappers.length === 0 && s.assignments.length === 0 && s.redirects.length === 0 && s.heredocs.length === 0
  if (!isPlain || s.nameAt !== 0 || !isFvRead(s.words)) return `${WRITER_HEAD}${s.words.join(' ')} is not a read-only fv-serve call. ${WRITER_ADVICE}`
  return undefined
}

const WRITABLE = ['meetings/', 'decisions/']

export function meetingWriterPathRefusal(path: string): string | undefined {
  if (WRITABLE.some(folder => path.startsWith(folder)) && !path.split('/').includes('..')) return undefined
  return `${WRITER_HEAD}the meeting-writer writes only under meetings/ and decisions/, and ${path} is outside them. Write the meeting note under meetings/ and each decision under decisions/.`
}

export const WRITER_TOOL_REFUSAL = `${WRITER_HEAD}the meeting-writer creates notes with the memory write tool only, and never edits or appends to a note. Write each new note whole with write.`

export function meetingIdOf(text: string): string | undefined {
  const block = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/.exec(text)?.[1]
  const line = block?.split(/\r?\n/).find(row => row.startsWith('meeting_id:'))
  if (line === undefined) return undefined
  const value = line.slice('meeting_id:'.length).trim()
  const quoted = /^(["'])(.*?)\1/.exec(value)
  const id = quoted ? (quoted[2] ?? '') : value.replace(/\s+#.*$/, '')
  return id === '' ? undefined : id
}

export const NO_DISPATCH_REFUSAL = `${WRITER_HEAD}this run carries no WORKBENCH_MEETING_ID, so it was not dispatched for a meeting and writes nothing. Exit.`

export function idRefusal(path: string, dispatched: string | undefined, incoming: string | undefined): string | undefined {
  if (dispatched === undefined || dispatched === '') return NO_DISPATCH_REFUSAL
  if (incoming === dispatched) return undefined
  return `${WRITER_HEAD}${path} carries meeting_id ${incoming ?? '(none)'}, and this run was dispatched for meeting ${dispatched}. Give every note you write meeting_id: "${dispatched}" in its frontmatter.`
}

export function overwriteRefusal(path: string, dispatched: string, existing: string | undefined): string | undefined {
  if (existing === undefined || meetingIdOf(existing) === dispatched) return undefined
  return `${WRITER_HEAD}${path} already holds a note that is not this meeting's, so the meeting-writer may not write over it. Pick another path for a new note, or leave the existing one as it is.`
}

export const UNREAD_NOTE_REFUSAL = `${WRITER_HEAD}the vault could not be read, so this write might replace a note. Leave the meeting for the next run.`
