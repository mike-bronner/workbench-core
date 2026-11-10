import type { WorkbenchCallerLane as CallerLane, WorkbenchShellParse as ShellParse, WorkbenchShellStatement as Statement } from '../../types'

export const LEDGER_FILE = '.claude-workbench/provisioning/ledger.json'
export const MAX_DATABASE = 55
export const ROOT_FORM = '~/Developer/worktrees/<project>/<unit>'
export const NAME_FORM = 'wt_<project>_<unit>_testing'
export const LOCK_TRIES = 40
export const LOCK_WAIT_MS = 50
export const PRUNE_AFTER_MS = 10 * 60 * 1000

export type LedgerEntry = {
  project: string
  session: string
  createdAt: number
  unit: string
  worktree: string | null
  branch: string
  database: string
  connection: string
  isDatabaseCreated: boolean
}

export type LedgerRead = { entries: LedgerEntry[] } | { corrupt: string }

export type LedgerCommand =
  | { kind: 'add'; dir: string | undefined; branch: string; path: string }
  | { kind: 'remove'; dir: string | undefined; path: string }
  | { kind: 'create'; name: string; connection: string }
  | { kind: 'drop'; name: string; connection: string }
  | { kind: 'branch-delete'; branches: readonly string[] }

type Edit = (entries: readonly LedgerEntry[]) => LedgerEntry[]

export type LedgerPlan = 'pass' | { deny: string } | { before?: Edit; after?: Edit; failed?: Edit; advise?: string; stale: string }

export type LedgerFacts = {
  lane: CallerLane
  home: string | undefined
  project: string
  cwd: string
  session: string
  now: number
  isPathTaken: boolean
  isRealTree: boolean
  database: string | undefined
  names: Readonly<Record<string, string>>
  rootProblem: string | undefined
}

export const LEDGER_RULES =
  `The main session provisions a unit only under ${ROOT_FORM}, where <project> is the name of the session's project folder and <unit> is one folder name. ` +
  `A unit's test database is named ${NAME_FORM}, lowercased, with each run of other characters as one underscore. ` +
  `A name over ${MAX_DATABASE} characters is cut to ${MAX_DATABASE - 9}, then gets an underscore and the first 8 hex digits of the full name's SHA-256. ` +
  "The accepted lines, each alone, run in the project folder or with git -C <project folder>: `git worktree add -b <branch> <path> [<base>]`, `git worktree remove <path>`, " +
  "`createdb <name>` or `psql -c 'CREATE DATABASE \"<name>\"'`, and `psql -c 'DROP DATABASE \"<name>\"'`. " +
  'A database line may also carry -h, -p, -U and -w, and psql -d. A drop must carry the same -h, -p and -U as the create. ' +
  'Create the worktree first: its unit database name is reserved with it. ' +
  'Removal works only for what the provisioning ledger recorded. The main session deletes a branch with git branch -d or -D, and a sub-agent may not delete a unit branch. ' +
  'A sub-agent provisions nothing: it reports the need to its orchestrator. ' +
  'For anything else, stop and ask Mike, who runs the command himself with the ! prefix. ' +
  'Read-only commands still run: git worktree list, psql -c "SELECT ...", mysqladmin status.'

const refusal = (action: string, advice: string): { deny: string } => ({ deny: `Provisioning guard (workbench-core): ${action}. ${advice} ${LEDGER_RULES}` })

const slugOf = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

const baseOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

export async function unitDatabaseOf(project: string, unit: string): Promise<string> {
  const full = `wt_${slugOf(baseOf(project))}_${slugOf(unit)}_testing`
  if (full.length <= MAX_DATABASE) return full
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(full)))
  const hex = [...digest.slice(0, 4)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `${full.slice(0, MAX_DATABASE - 9)}_${hex}`
}

export const ledgerPathOf = (home: string): string => `${home}/${LEDGER_FILE}`

const isEntry = (value: unknown): value is LedgerEntry => {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Record<string, unknown>
  return (
    typeof e.project === 'string' &&
    typeof e.session === 'string' &&
    typeof e.createdAt === 'number' &&
    typeof e.unit === 'string' &&
    (e.worktree === null || typeof e.worktree === 'string') &&
    typeof e.branch === 'string' &&
    typeof e.database === 'string' &&
    typeof e.connection === 'string' &&
    typeof e.isDatabaseCreated === 'boolean'
  )
}

export function ledgerOf(text: string | undefined): LedgerRead {
  if (text === undefined) return { entries: [] }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { corrupt: 'the file is not valid JSON' }
  }
  const ledger = value as { version?: unknown; entries?: unknown } | null
  if (typeof ledger !== 'object' || ledger === null || ledger.version !== 1 || !Array.isArray(ledger.entries) || !ledger.entries.every(isEntry)) {
    return { corrupt: 'the file does not hold a version 1 ledger of entries' }
  }
  return { entries: ledger.entries }
}

export const ledgerTextOf = (entries: readonly LedgerEntry[]): string => `${JSON.stringify({ version: 1, entries }, null, 2)}\n`

export const corruptRefusal = (path: string, why: string): { deny: string } =>
  refusal(
    `the provisioning ledger at ${path} cannot be read (${why}), so this guard cannot tell what it recorded. Creating and removing a worktree or a database are refused until it reads`,
    'Report this to Mike, who repairs or moves the file.',
  )

export const unwrittenRefusal = (path: string): { deny: string } =>
  refusal(`the provisioning ledger at ${path} could not be written, so this line would go unrecorded`, 'Report this to Mike.')

export const lockedRefusal = (path: string): { deny: string } =>
  refusal(
    `another session held the provisioning ledger's lock at ${path}.lock for over ${(LOCK_TRIES * LOCK_WAIT_MS) / 1000} seconds, so this line could not be recorded safely`,
    'Run the line again in a moment. A lock that stays held for over a minute is a crashed holder, and the next try takes it over.',
  )

export const BACKGROUND_REFUSAL = refusal('this provisioning line runs in the background, so the provisioning ledger cannot record how it ended', 'Run it in the foreground.')

export const LEDGER_WRITE_REFUSAL = refusal(
  'this call may write in ~/.claude-workbench/provisioning, where the provisioning ledger and its lock live, and only the guard writes there. A glob or a brace on a ~/.claude-workbench path, or a link to that folder or one above it, counts too, because it can reach the ledger',
  'Read the ledger with the Read tool, or with cat, head, jq or grep alone on the line and a literal path. If an entry looks wrong, report it to Mike instead of changing it.',
)

export const staleNoteOf = (path: string, why: 'locked' | 'failed', stale: string): string =>
  `Provisioning ledger: the line ran, but the ledger at ${path} could not record its result, because ${why === 'locked' ? 'another session held its lock' : 'the file could not be written'}, so its entry is stale. ${stale}.`

const plainStatementOf = (parse: ShellParse): Statement | undefined => {
  const [s] = parse.statements
  if (parse.unknowns.length > 0 || parse.statements.length !== 1 || s === undefined) return undefined
  const isPlain = s.nameAt === 0 && s.isPlaced && s.redirects.length === 0 && s.heredocs.length === 0 && s.escaped.length === 0 && s.depth === 0
  return isPlain && s.words.every(word => !word.includes('$')) ? s : undefined
}

const isOperand = (word: string | undefined): word is string => word !== undefined && word !== '' && !word.startsWith('-')

function gitCommandOf(s: Statement): LedgerCommand | undefined {
  const { args, subcommandAt } = s
  const dir = subcommandAt === 2 && args[0] === '-C' ? args[1] : subcommandAt === 0 ? undefined : null
  if (dir === null) return undefined
  const [sub, ...rest] = args.slice(subcommandAt)
  if (sub === 'worktree' && rest[0] === 'add' && rest[1] === '-b' && (rest.length === 4 || rest.length === 5) && rest.slice(2).every(isOperand)) {
    return { kind: 'add', dir, branch: rest[2] as string, path: rest[3] as string }
  }
  if (sub === 'worktree' && rest[0] === 'remove' && rest.length === 2 && isOperand(rest[1])) return { kind: 'remove', dir, path: rest[1] }
  return undefined
}

const COMMIT_SWITCHES: ReadonlySet<string> = new Set(['-a', '--all', '-q', '--quiet'])

export function plainCommitDirOf(parse: ShellParse): string | undefined {
  const s = plainStatementOf(parse)
  if (s?.name !== 'git' || s.subcommandAt !== 2 || s.args[0] !== '-C' || s.args[2] !== 'commit') return undefined
  const rest = s.args.slice(3)
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string
    if (['-m', '--message', '-F', '--file'].includes(arg) && rest[i + 1] !== undefined) i++
    else if (!(arg.startsWith('--message=') || arg.startsWith('--file=') || COMMIT_SWITCHES.has(arg))) return undefined
  }
  return s.args[1]
}

const CONNECTION: ReadonlySet<string> = new Set(['-h', '-p', '-U', '--host', '--port', '--username'])
const SHORT: Readonly<Record<string, string>> = { '--host': '-h', '--port': '-p', '--username': '-U' }
const SWITCHES: ReadonlySet<string> = new Set(['-w', '--no-password'])
const SQL_CREATE = /^\s*create\s+database\s+("?)([^"\s;]+)\1\s*;?\s*$/i
const SQL_DROP = /^\s*drop\s+database\s+(?:if\s+exists\s+)?("?)([^"\s;]+)\1\s*;?\s*$/i

type Options = { operands: string[]; payloads: string[]; connection: string }

function optionsOf(args: readonly string[], isPsql: boolean): Options | undefined {
  const operands: string[] = []
  const payloads: string[] = []
  const pairs: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    const value = args[i + 1]
    if (isPsql && (arg === '-c' || arg === '--command')) {
      if (value === undefined) return undefined
      payloads.push(value)
      i++
    } else if (CONNECTION.has(arg) || (isPsql && (arg === '-d' || arg === '--dbname'))) {
      if (!isOperand(value)) return undefined
      if (CONNECTION.has(arg)) pairs.push(`${SHORT[arg] ?? arg} ${value}`)
      i++
    } else if (SWITCHES.has(arg) || (isPsql && ['-X', '--no-psqlrc', '-q', '--quiet'].includes(arg))) continue
    else if (arg.startsWith('-')) return undefined
    else operands.push(arg)
  }
  return { operands, payloads, connection: pairs.sort().join(' ') }
}

function databaseCommandOf(s: Statement): LedgerCommand | undefined {
  if (s.name === 'createdb') {
    const options = optionsOf(s.args, false)
    return options?.operands.length === 1 ? { kind: 'create', name: options.operands[0] as string, connection: options.connection } : undefined
  }
  if (s.name !== 'psql') return undefined
  const options = optionsOf(s.args, true)
  if (options === undefined || options.operands.length !== 0 || options.payloads.length !== 1) return undefined
  const create = SQL_CREATE.exec(options.payloads[0] as string)
  if (create) return { kind: 'create', name: create[2] as string, connection: options.connection }
  const drop = SQL_DROP.exec(options.payloads[0] as string)
  return drop ? { kind: 'drop', name: drop[2] as string, connection: options.connection } : undefined
}

const DELETE_CLUSTER = /^-[A-Za-z]*[dD][A-Za-z]*$/

export function branchDeletesOf(parse: ShellParse): string[] {
  const branches: string[] = []
  for (const s of parse.statements) {
    if (s.name !== 'git' || s.subcommandAt < 0) continue
    const [sub, ...rest] = s.args.slice(s.subcommandAt)
    const isDelete = rest.some(arg => DELETE_CLUSTER.test(arg) || arg === '--delete')
    if (sub === 'branch' && isDelete) branches.push(...rest.filter(isOperand))
    if (sub === 'update-ref' && isDelete) branches.push(...rest.filter(isOperand).slice(0, 1).map(ref => ref.replace(/^refs\/heads\//, '')))
  }
  return branches
}

export function ledgerCommandOf(parse: ShellParse): LedgerCommand | undefined {
  const s = plainStatementOf(parse)
  const command = s === undefined ? undefined : s.name === 'git' ? gitCommandOf(s) : databaseCommandOf(s)
  if (command !== undefined) return command
  const branches = branchDeletesOf(parse)
  return branches.length === 0 ? undefined : { kind: 'branch-delete', branches }
}

export const isProvisioningLine = (command: LedgerCommand | undefined): boolean => command !== undefined && command.kind !== 'branch-delete'

export function normalPathOf(path: string): string | undefined {
  if (!path.startsWith('/') || /[\s*?[\]{}$`~\\]/.test(path)) return undefined
  const parts = path.split('/').filter(Boolean)
  return parts.some(part => part === '.' || part === '..') ? undefined : `/${parts.join('/')}`
}

const UNIT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export const rootOf = (home: string, project: string): string => `${home.replace(/\/+$/, '')}/Developer/worktrees/${baseOf(project)}`

export function unitOf(path: string, home: string | undefined, project: string): string | undefined {
  const normal = normalPathOf(path)
  if (normal === undefined || home === undefined) return undefined
  const root = `${rootOf(home, project)}/`
  const unit = normal.startsWith(root) ? normal.slice(root.length) : ''
  return UNIT.test(unit) ? unit : undefined
}

const SUBAGENT_ADVICE = 'Report the need to your orchestrator instead.'

const without = (entries: readonly LedgerEntry[], match: (entry: LedgerEntry) => boolean): LedgerEntry[] => entries.filter(entry => !match(entry))
const changing = (entries: readonly LedgerEntry[], match: (entry: LedgerEntry) => boolean, change: Partial<LedgerEntry>): LedgerEntry[] =>
  entries.map(entry => (match(entry) ? { ...entry, ...change } : entry))

export const isCleaned = (entry: LedgerEntry): boolean => entry.worktree === null && !entry.isDatabaseCreated

export const isUnitForm = (entry: LedgerEntry, home: string | undefined, project: string): boolean =>
  entry.project === project && entry.worktree !== null && unitOf(entry.worktree, home, project) === entry.unit

export function ledgerPlanOf(command: LedgerCommand, facts: LedgerFacts, read: LedgerRead, path: string): LedgerPlan {
  const isMain = facts.lane === 'main'
  if (command.kind === 'branch-delete') {
    if (isMain) return 'pass'
    if ('corrupt' in read) return corruptRefusal(path, read.corrupt)
    const owned = command.branches.filter(branch => read.entries.some(entry => entry.branch === branch))
    return owned.length === 0 ? 'pass' : refusal(`a sub-agent may not delete ${owned.join(', ')}, a unit branch the provisioning ledger recorded`, SUBAGENT_ADVICE)
  }
  if (!isMain) return refusal(`a sub-agent may not ${command.kind === 'add' || command.kind === 'create' ? 'create' : 'remove'} a worktree or a database`, SUBAGENT_ADVICE)
  if ('corrupt' in read) return corruptRefusal(path, read.corrupt)
  const entries = read.entries
  const isProject = (entry: LedgerEntry): boolean => entry.project === facts.project
  const root = facts.home === undefined ? ROOT_FORM : rootOf(facts.home, facts.project)
  if (command.kind === 'add' || command.kind === 'remove') {
    const dir = command.dir ?? facts.cwd
    if (normalPathOf(dir) !== facts.project) return refusal(`this git worktree ${command.kind} runs in ${dir}, not in the session's project folder ${facts.project}`, `Run it as git -C ${facts.project} worktree ${command.kind} ...`)
    if (facts.rootProblem !== undefined) return refusal(facts.rootProblem, 'Point the root link at one of those roots, or ask Mike.')
  }
  if (command.kind === 'add') {
    const unit = unitOf(command.path, facts.home, facts.project)
    if (unit === undefined || facts.database === undefined) return refusal(`${command.path} is not a unit folder directly under this project's worktree root ${root}`, 'Pick one new folder under that root.')
    if (!facts.isRealTree) return refusal(`the real path of ${command.path} leaves the worktree root ${root} through a symbolic link`, 'Pick a unit folder whose path holds no link below the root.')
    const worktree = normalPathOf(command.path) as string
    if (facts.isPathTaken) return refusal(`${worktree} already exists, and a tree made by hand may be there`, 'Pick a unit folder that does not exist yet.')
    const taken = entries.find(entry => !isCleaned(entry) && (entry.worktree === worktree || entry.database === facts.database))
    if (taken !== undefined) return refusal(`the provisioning ledger already holds ${taken.worktree === worktree ? worktree : `the database name ${facts.database}`}`, 'Pick another unit folder name.')
    const entry: LedgerEntry = { project: facts.project, session: facts.session, createdAt: facts.now, unit, worktree, branch: command.branch, database: facts.database, connection: '', isDatabaseCreated: false }
    const isThis = (other: LedgerEntry): boolean => other.worktree === worktree && other.session === facts.session && other.createdAt === facts.now
    return {
      before: current => [...current, entry],
      failed: current => without(current, isThis),
      advise: `Provisioning ledger: recorded the worktree ${worktree} on the unit branch ${command.branch}. Its unit test database name is ${facts.database}. Create it with createdb ${facts.database} when the unit needs one.`,
      stale: `git failed, so ${worktree} does not exist, yet its entry stays in the ledger. It holds no tree, so the session-start leftover check drops it after ten minutes`,
    }
  }
  if (command.kind === 'remove') {
    const worktree = normalPathOf(command.path)
    const isOwned = (entry: LedgerEntry): boolean => worktree !== undefined && entry.worktree === worktree && isUnitForm(entry, facts.home, facts.project)
    if (!entries.some(isOwned)) return refusal(`the provisioning ledger holds no unit worktree ${command.path} for this project, so it was not made through the ledger`, 'Leave it in place, and name the exact path the add used if it was.')
    if (!facts.isRealTree) return refusal(`the real path of ${command.path} is no longer the unit folder under ${root}: a symbolic link stands in its place or above it`, 'Leave it in place, and report it to Mike.')
    return {
      after: current => changing(current, isOwned, { worktree: null }),
      stale: `${command.path} was removed. The entry still names the tree, and the session-start leftover check drops it once nothing of it exists`,
    }
  }
  if (command.name.length > MAX_DATABASE) {
    return refusal(`the database name ${command.name} is ${command.name.length} characters, over the ${MAX_DATABASE}-character limit that leaves room for Laravel's _test_<n> suffix within PostgreSQL's 63 bytes`, 'Use the reserved name the worktree add reported.')
  }
  const isNamed = (entry: LedgerEntry): boolean => isProject(entry) && entry.database === command.name && facts.names[entry.unit] === command.name
  if (command.kind === 'create') {
    const isReserved = (entry: LedgerEntry): boolean => isNamed(entry) && isUnitForm(entry, facts.home, facts.project) && !entry.isDatabaseCreated
    if (!entries.some(isReserved)) return refusal(`${command.name} is not a unit test database name the provisioning ledger reserved for a worktree of this project`, 'Create the worktree first, then create the name its add reported.')
    return {
      after: current => changing(current, isReserved, { isDatabaseCreated: true, connection: command.connection }),
      stale: `${command.name} was created, so the ledger cannot free its drop. Tell Mike, who drops it himself with the ! prefix`,
    }
  }
  const isCreated = (entry: LedgerEntry): boolean => isNamed(entry) && entry.isDatabaseCreated
  const created = entries.find(isCreated)
  if (created === undefined) return refusal(`the provisioning ledger holds no database ${command.name} created for this project, so it was not made through the ledger`, 'Leave it in place.')
  if (created.connection !== command.connection) {
    return refusal(`this drop connects with "${command.connection || 'no -h, -p or -U'}", and the create used "${created.connection || 'no -h, -p or -U'}", so it may reach another server`, 'Drop it with the same -h, -p and -U the create used.')
  }
  return {
    after: current => changing(current, isCreated, { isDatabaseCreated: false }),
    stale: `${command.name} was dropped. The session-start leftover check still lists it, and that line can be ignored`,
  }
}

export const unitEntryOf = (entries: readonly LedgerEntry[], home: string | undefined, project: string, dir: string): LedgerEntry | undefined =>
  entries.find(entry => entry.worktree === normalPathOf(dir) && isUnitForm(entry, home, project))

export type Leftover = { entry: LedgerEntry; hasTree: boolean; hasBranch: boolean }

export function leftoverBlockOf(leftovers: readonly Leftover[]): string | undefined {
  if (leftovers.length === 0) return undefined
  const lines = leftovers.map(({ entry, hasTree, hasBranch }) => {
    const parts = [hasTree ? `worktree ${entry.worktree}` : '', hasBranch ? `branch ${entry.branch}` : '', entry.isDatabaseCreated ? `database ${entry.database}` : ''].filter(Boolean)
    return `- ${parts.join(', ')} (project ${entry.project}, recorded by session ${entry.session} at ${new Date(entry.createdAt).toISOString()})`
  })
  return [
    '# Provisioning ledger leftovers',
    '',
    `An earlier session recorded these units, and their trees, branches or databases still exist. If that session no longer runs, remove each one from its project: git worktree remove <path>, git branch -d <branch>, and psql -c 'DROP DATABASE "<name>"' with the create's -h, -p and -U.`,
    '',
    ...lines,
  ].join('\n')
}

export const leftoverCorruptOf = (path: string, why: string): string =>
  `# Provisioning ledger unreadable\n\nThe provisioning ledger at ${path} cannot be read (${why}). Creating and removing a worktree or a database are refused until it reads. Tell Mike, who repairs or moves the file.`
