// The destructive-database guard, as pure functions. It replaces
// hooks/destructive-database-guard.sh, now retired. hooks/register.ts calls it from tool.call, before the call runs.
//
// It exists because of a real loss. On 2026-09-04 an agent ran
// `php artisan db:wipe --database=pgsql --force` in the belief that `pgsql`
// named the testing database. It resolved against .env, the development
// database, and every table was dropped.
//
// WHAT IT REFUSES, wherever the command stands in the line and through any
// wrapper, container shim, `docker compose exec`, `kubectl exec --`, `ssh`,
// a shell's -c script, and a runner that hides it (`find -exec`, `xargs`,
// `parallel`):
//   artisan   db:wipe, migrate:fresh, migrate:reset, migrate:refresh, and any
//             abbreviation Symfony resolves to one, unless the command scopes
//             itself with --env=testing or --database=testing
//   shell     dropdb, dropuser, mysqladmin drop
//   docker    the volume-deleting forms: down -v, rm -v, volume rm and prune,
//             system prune --volumes; sail down -v too
//   project   ddev delete (not images), ddev stop --remove-data, lando destroy,
//             wp-env destroy
//   sql       DROP DATABASE, SCHEMA or TABLE, TRUNCATE, and DELETE FROM with no
//             WHERE, handed to a SQL client inline, on its input, in a heredoc
//             or in a file it reads. A file is read as a fact by register.ts:
//             a regular file only, its first megabyte.
// SQL is read only where a SQL client runs in the line, so `grep -rn "drop
// table"` and `echo "DROP TABLE"` run.
//
// It FAILS CLOSED where the bash guard failed open: a line the reader could
// not read whole, which names a database word, is refused, and so is a SQL
// file this guard cannot find because of a `cd` it cannot follow.
//
// Pure functions only: the engine follows `$` into no imported function.

import type { WorkbenchShellHeredoc as ShellHeredoc, WorkbenchShellParse as ShellParse, WorkbenchShellStatement as Statement } from '../../types'
import type { FactGetter } from './destructive-scope'
import { cwdsAfter, isLinearLine } from './destructive-scope'
import { SHELLS, nameOf, parseShell } from './shell'

export const MAX_INPUT = 200_000
const MAX_DEPTH = 4
// A SQL file is read this far and no further: register.ts cuts it.
export const SQL_FILE_CAP = 1_000_000

export const fileKey = (path: string): string => `file\t${path}`

const ARTISAN_VERBS = ['db:wipe', 'migrate:fresh', 'migrate:refresh', 'migrate:reset']
const DROP_COMMANDS: ReadonlySet<string> = new Set(['dropdb', 'dropuser'])
const SQL_CLIENTS: ReadonlySet<string> = new Set(['psql', 'mysql', 'mariadb', 'mysqlsh', 'sqlite3', 'sqlite', 'usql'])
const SQL_POSITIONAL_CLIENTS: ReadonlySet<string> = new Set(['sqlite3', 'sqlite'])
const SQL_INLINE_FLAGS: ReadonlySet<string> = new Set(['-c', '--command', '-e', '--execute', '--sql'])
const SQL_INLINE_PREFIXES = ['--command=', '--execute=', '--sql=']
// Clients that read -f as --file. mysql reads -f as --force.
const SQL_FILE_CLIENTS: ReadonlySet<string> = new Set(['psql', 'usql'])
const SQL_FILE_FLAGS: ReadonlySet<string> = new Set(['-f', '--file'])
const READERS: ReadonlySet<string> = new Set(['cat', 'head', 'tail'])
const ECHOES: ReadonlySet<string> = new Set(['echo', 'printf'])
const PROJECT_TOOL_VERBS: Readonly<Record<string, readonly string[]>> = { ddev: ['delete'], lando: ['destroy'], 'wp-env': ['destroy'] }
const CONTAINER_SHIMS: ReadonlySet<string> = new Set(['sail', 'lando', 'ddev', 'wp-env'])
const PREFIX_NOOP: ReadonlySet<string> = new Set(['sudo', 'doas', 'env', 'nice', 'ionice', 'time', 'nohup', 'command', 'exec', 'stdbuf'])
const DOCKER_BINARIES: ReadonlySet<string> = new Set(['docker', 'podman'])
const COMPOSE_BINARIES: ReadonlySet<string> = new Set(['docker-compose', 'podman-compose'])
const DOCKER_VALUE_FLAGS: ReadonlySet<string> = new Set(['-u', '--user', '-w', '--workdir', '-e', '--env', '--label'])
const DOCKER_GLOBAL_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-f', '--file', '-p', '--project-name', '-H', '--host', '-c', '--context', '--project-directory', '--env-file', '--profile', '--log-level',
])
const SSH_VALUE_FLAGS: ReadonlySet<string> = new Set(['-p', '-i', '-o', '-l', '-F', '-b', '-c', '-D', '-L', '-R'])
const VOLUME_FLAG = /^(--volumes?|-[A-Za-z]*v[A-Za-z]*)$/
// Commands that run a command they are given. Any suffix of their words is
// read as a command.
const RUNNERS: ReadonlySet<string> = new Set([
  'find', 'gfind', 'bfs', 'xargs', 'parallel', 'watch', 'timeout', 'gtimeout', 'flock', 'setsid', 'su', 'eval', 'source', '.', 'script', 'chroot', 'nohup',
])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/

const SQL_LITERAL = /'(?:[^']|'')*'/g
const SQL_DROP = /\bDROP\s+(DATABASE|SCHEMA|TABLE)\b/i
const SQL_TRUNCATE = /\bTRUNCATE\s+(TABLE\s+)?["'`[\w]/i
const SQL_DELETE = /\bDELETE\s+FROM\b/i
const SQL_WHERE = /\bWHERE\b/i

// The words that bring a line to this guard, as the bash guard's prefilter
// read them: quotes, backslashes and backslash-newlines out, case folded.
const SUBJECT = /artisan|db:wipe|migrate:(fresh|reset|refresh)|dropdb|dropuser|mysql|psql|mariadb|sqlite|usql|docker|podman|sail|lando|ddev|wp-env/i
export const mentionsDatabase = (line: string): boolean => SUBJECT.test(line.replaceAll('\\\n', '').replace(/["'\\]/g, ''))

// Skip the flags at the front, and each listed flag's value.
function skipFlags(words: readonly string[], valued: ReadonlySet<string>): string[] {
  let i = 0
  while (i < words.length && (words[i] as string).startsWith('-')) {
    i += valued.has(words[i] as string) ? 2 : 1
  }
  return words.slice(i)
}

// Strip wrappers until the real command leads. A command handed over as one
// string (ssh's, a shell's -c) comes back to be read on its own; `isRemote`
// marks ssh, whose files are on another machine.
function unwrap(words: readonly string[]): { rest: string[]; nested: { text: string; isRemote: boolean }[] } {
  const nested: { text: string; isRemote: boolean }[] = []
  let rest = [...words]
  for (let n = 0; n < 8 && rest.length > 0; n++) {
    const head = nameOf(rest[0] as string)
    if (ASSIGNMENT.test(rest[0] as string)) {
      rest = rest.slice(1)
      continue
    }
    if (PREFIX_NOOP.has(head) || CONTAINER_SHIMS.has(head)) {
      rest = rest.slice(1)
      while (head === 'env' && rest.length > 0 && ASSIGNMENT.test(rest[0] as string)) rest = rest.slice(1)
      continue
    }
    if (DOCKER_BINARIES.has(head) || COMPOSE_BINARIES.has(head)) {
      let inner = rest.slice(1)
      if (inner[0] === 'compose') inner = inner.slice(1)
      if (inner[0] === 'exec' || inner[0] === 'run') {
        inner = skipFlags(inner.slice(1), DOCKER_VALUE_FLAGS)
        rest = inner.slice(1)
        continue
      }
      break
    }
    if (head === 'kubectl') {
      const at = rest.indexOf('--')
      if (at === -1) break
      rest = rest.slice(at + 1)
      continue
    }
    if (head === 'ssh') {
      const inner = skipFlags(rest.slice(1), SSH_VALUE_FLAGS).slice(1)
      if (inner.length === 1) {
        nested.push({ text: inner[0] as string, isRemote: true })
        rest = []
      } else rest = inner
      continue
    }
    if (SHELLS.has(head) && rest.includes('-c')) {
      const at = rest.indexOf('-c')
      if (at + 1 < rest.length) nested.push({ text: rest[at + 1] as string, isRemote: false })
      rest = []
      break
    }
    break
  }
  return { rest, nested }
}

const hasTestingScope = (words: readonly string[]): boolean =>
  words.some((w, i) => ['--env', '--database'].some(flag => w === `${flag}=testing` || (w === flag && words[i + 1] === 'testing')))

// The reset verb a typed Artisan command resolves to, read as Symfony
// Console finds a command: each `:` segment a prefix, case folded.
function artisanVerb(typed: string | undefined): string | undefined {
  if (typed === undefined || !typed.includes(':')) return undefined
  const parts = typed.toLowerCase().split(':')
  return ARTISAN_VERBS.find(verb => {
    const segments = verb.split(':')
    return segments.length === parts.length && segments.every((full, i) => full.startsWith(parts[i] as string))
  })
}

function checkArtisan(words: readonly string[]): string | undefined {
  const at = words.slice(0, 3).findIndex(w => nameOf(w) === 'artisan')
  if (at === -1) return undefined
  const typed = words.slice(at + 1).find(w => !w.startsWith('-'))
  const verb = artisanVerb(typed)
  if (verb === undefined || hasTestingScope(words)) return undefined
  return `\`php artisan ${typed}\` runs ${verb}, which empties or rebuilds the database it resolves to, and the command does not scope itself to the testing database. Without --env=testing or --database=testing it resolves against .env, which is the development database`
}

function checkDocker(words: readonly string[]): string | undefined {
  const head = nameOf(words[0] ?? '')
  let isCompose = false
  let rest: string[]
  if (DOCKER_BINARIES.has(head)) {
    rest = skipFlags(words.slice(1), DOCKER_GLOBAL_VALUE_FLAGS)
    if (rest[0] === 'compose') {
      isCompose = true
      rest = skipFlags(rest.slice(1), DOCKER_GLOBAL_VALUE_FLAGS)
    }
  } else if (COMPOSE_BINARIES.has(head) || head === 'sail') {
    isCompose = true
    rest = skipFlags(words.slice(1), DOCKER_GLOBAL_VALUE_FLAGS)
  } else return undefined
  const [verb, ...args] = rest
  const hasVolumes = args.some(a => VOLUME_FLAG.test(a))
  const label = isCompose && DOCKER_BINARIES.has(head) ? `${head} compose` : head
  if (verb === 'down' && hasVolumes) return `\`${label} down\` with --volumes deletes the named volumes, which is where a containerised database keeps its data`
  if (verb === 'rm' && hasVolumes) return `\`${label} rm\` with --volumes deletes the containers' volumes along with them`
  if (verb === 'volume' && (args[0] === 'rm' || args[0] === 'prune')) return `\`${head} volume ${args[0]}\` deletes volumes outright, and a database container keeps its data in one`
  if (verb === 'system' && args[0] === 'prune' && hasVolumes) return `\`${head} system prune --volumes\` deletes every unused volume, including a stopped database's`
  return undefined
}

function checkProjectTool(words: readonly string[]): string | undefined {
  const head = nameOf(words[0] ?? '')
  const verbs = PROJECT_TOOL_VERBS[head]
  if (verbs === undefined) return undefined
  const plain = words.slice(1).filter(w => !w.startsWith('-'))
  const verb = plain[0]
  if (verb !== undefined && verbs.includes(verb)) {
    if (head === 'ddev' && verb === 'delete' && plain[1] === 'images') return undefined
    return `\`${head} ${verb}\` destroys the project, and the database it owns goes with it`
  }
  if (head === 'ddev' && verb === 'stop' && words.includes('--remove-data')) return '`ddev stop --remove-data` deletes the project database'
  return undefined
}

function checkShellDrop(words: readonly string[]): string | undefined {
  const head = nameOf(words[0] ?? '')
  if (DROP_COMMANDS.has(head)) return `\`${head}\` destroys a database or role outright, with no undo`
  if (head === 'mysqladmin' && words.slice(1).some(w => w.toLowerCase() === 'drop')) return '`mysqladmin drop` destroys a database outright, with no undo'
  return undefined
}

export function checkSql(payload: string): string | undefined {
  for (const statement of payload.replace(SQL_LITERAL, "''").split(';')) {
    const drop = SQL_DROP.exec(statement)
    if (drop) return `the SQL runs DROP ${(drop[1] as string).toUpperCase()}`
    if (SQL_TRUNCATE.test(statement)) return 'the SQL runs TRUNCATE, which empties a table with no undo'
    if (SQL_DELETE.test(statement) && !SQL_WHERE.test(statement)) return 'the SQL runs DELETE FROM with no WHERE clause'
  }
  return undefined
}

// Every command finding for one command, given as its words from the name on.
// The Docker and project rules read the docker or ddev command itself, before
// unwrap strips it down to what it runs.
function commandFinding(words: readonly string[]): string | undefined {
  const lead = stripNoop(words)
  const { rest } = unwrap(words)
  return checkDocker(lead) ?? checkProjectTool(lead) ?? checkArtisan(rest) ?? checkShellDrop(rest)
}

function stripNoop(words: readonly string[]): string[] {
  let rest = [...words]
  while (rest.length > 0) {
    if (ASSIGNMENT.test(rest[0] as string)) {
      rest = rest.slice(1)
      continue
    }
    const head = nameOf(rest[0] as string)
    if (!PREFIX_NOOP.has(head)) break
    rest = rest.slice(1)
    while (head === 'env' && rest.length > 0 && ASSIGNMENT.test(rest[0] as string)) rest = rest.slice(1)
  }
  return rest
}

// The SQL a command hands its client: -c and its kin, here-strings, heredoc
// bodies, and sqlite's positional SQL.
function sqlPayloads(words: readonly string[], s: Statement | undefined): string[] {
  const payloads: string[] = []
  const positionals: string[] = []
  for (let i = 1; i < words.length; i++) {
    const w = words[i] as string
    if (SQL_INLINE_FLAGS.has(w) && i + 1 < words.length) {
      payloads.push(words[++i] as string)
      continue
    }
    const prefix = SQL_INLINE_PREFIXES.find(p => w.startsWith(p))
    if (prefix !== undefined) payloads.push(w.slice(prefix.length))
    else if (!w.startsWith('-')) positionals.push(w)
  }
  if (SQL_POSITIONAL_CLIENTS.has(nameOf(words[0] ?? ''))) payloads.push(...positionals.slice(1))
  if (s !== undefined) {
    for (const r of s.redirects) if (r.isReal && r.op === '<<<') payloads.push(r.target)
    for (const doc of s.heredocs) payloads.push(bodyOf(doc))
  }
  return payloads
}

// The files a command feeds a SQL client.
function sqlFiles(words: readonly string[], s: Statement | undefined): string[] {
  const head = nameOf(words[0] ?? '')
  const paths: string[] = []
  if (s !== undefined) for (const r of s.redirects) if (r.isReal && r.op === '<' && (r.fd === '' || r.fd === '0')) paths.push(r.target)
  for (let i = 1; i < words.length; i++) {
    const w = words[i] as string
    if (SQL_FILE_CLIENTS.has(head)) {
      if (SQL_FILE_FLAGS.has(w) && i + 1 < words.length) paths.push(words[++i] as string)
      else if (w.startsWith('--file=')) paths.push(w.slice(7))
    } else if (READERS.has(head) && !w.startsWith('-')) paths.push(w)
  }
  return paths
}

const UNREADABLE = /[*?[\]{}$`\uE000-\uE002]/

// A heredoc body as the client reads it: bash joins a backslash-newline in a
// body whose delimiter was not quoted.
const bodyOf = (doc: ShellHeredoc): string => (doc.isQuoted ? doc.body : doc.body.replaceAll('\\\n', ''))

// What the line does to a database, or undefined. `start` holds the folders
// the line may start in, which its files resolve against, and is empty on
// another host; `home` is for a `~` path.
function findingOf(text: string, parse: ShellParse, start: readonly (string | undefined)[], home: string | undefined, get: FactGetter, depth: number, isRemote: boolean): string | undefined {
  if (depth > MAX_DEPTH) return undefined
  const isLinear = isLinearLine(text)
  // The folders a statement may run in, worked out only when a file must be
  // read there: following a `cd` asks the file system, which an ordinary line
  // never needs.
  const cds: Statement[] = []
  const cwdsAt = (before: readonly Statement[]): (string | undefined)[] => before.reduce<(string | undefined)[]>((cwds, cd) => cwdsAfter(cd, cwds, isLinear, get, home), [...start])
  const clients: string[] = []
  const units: { words: string[]; s: Statement | undefined; cds: Statement[] }[] = []
  for (const s of parse.statements) {
    if (s.nameAt === -1) continue
    const words = s.words.slice(s.nameAt)
    if (s.name === 'cd' || s.name === 'pushd' || s.name === 'popd') {
      cds.push(s)
      continue
    }
    // Every suffix of a runner's words is read as a command too.
    const candidates = RUNNERS.has(s.name) ? words.map((_, i) => words.slice(i)) : [words]
    for (const candidate of candidates) {
      const found = commandFinding(candidate)
      if (found !== undefined) return found
      const { rest, nested } = unwrap(candidate)
      const inner: { text: string; isRemote: boolean }[] = [...nested, ...(RUNNERS.has(s.name) ? candidate.slice(1).filter(word => /\s/.test(word.trim())).map(word => ({ text: word, isRemote: false })) : [])]
      for (const piece of inner) {
        const remote = isRemote || piece.isRemote
        const innerFound = findingOf(piece.text, parseShell(piece.text), remote ? [] : cwdsAt(cds), home, get, depth + 1, remote)
        if (innerFound !== undefined) return innerFound
      }
      if (rest.length > 0) {
        if (SQL_CLIENTS.has(nameOf(rest[0] as string))) clients.push(nameOf(rest[0] as string))
        // The statement's redirects and heredocs feed the command it leads with.
        units.push({ words: rest, s: candidate === words ? s : undefined, cds: [...cds] })
      }
    }
  }
  if (clients.length === 0) return undefined
  const client = clients[0] as string
  // SQL is read only where a SQL client runs in the line. Then every payload
  // in it counts: `echo "DROP TABLE x" | psql` sends echo's words.
  for (const unit of units) {
    const head = nameOf(unit.words[0] ?? '')
    const payloads = [...sqlPayloads(unit.words, unit.s), ...(ECHOES.has(head) ? unit.words.slice(1).filter(w => !w.startsWith('-')) : [])]
    for (const payload of payloads) {
      const sql = checkSql(payload)
      if (sql !== undefined) return `${sql}. It is handed to \`${client}\`, which runs it against a live database`
    }
  }
  for (const s of parse.statements) {
    for (const doc of s.heredocs) {
      const sql = checkSql(bodyOf(doc))
      if (sql !== undefined) return `${sql}. It is handed to \`${client}\`, which runs it against a live database`
    }
  }
  // SQL handed over as a file. Only the verdict is reported, never a line of
  // the file. A file on another host is not read.
  if (isRemote) return undefined
  for (const unit of units) {
    const paths = sqlFiles(unit.words, unit.s)
    const cwds = paths.length === 0 ? [] : cwdsAt(unit.cds)
    for (const path of paths) {
      for (const base of cwds) {
        let full: string | undefined
        if (UNREADABLE.test(path)) full = undefined
        else if (path === '~' || path.startsWith('~/')) full = home === undefined ? undefined : home + path.slice(1)
        else if (path.startsWith('~')) full = undefined
        else if (path.startsWith('/')) full = path
        else full = base === undefined ? undefined : `${base}/${path}`
        if (full === undefined) {
          return `\`${path}\` is fed to \`${client}\` as SQL, and this guard cannot tell which file that is (a variable, a glob, or a cd it cannot follow), so it cannot read what the file does`
        }
        const content = get(fileKey(full))
        const sql = content === null ? undefined : checkSql(content)
        if (sql !== undefined) return `${sql}. It comes from \`${path}\`, which is fed to \`${client}\``
      }
    }
  }
  return undefined
}

const HEAD = 'Destructive-database guard (workbench-core): '
const ADVICE =
  'Nothing an agent does should destroy a database, and there is no flag that clears this. If the reset is really needed, stop and ask Mike: he runs it himself with the ! prefix. Read-only inspection, such as psql -c "SELECT ...", still runs, and so does an Artisan reset scoped with --env=testing or --database=testing.'

const UNREAD =
  'the shell reader could not read all of this command (an unclosed quote, an escape it does not decode, or a script nested too deep), and it names a database command'

// The refusal for a Bash line, or undefined.
export function databaseRefusal(line: string, parse: ShellParse, cwd: string | undefined, home: string | undefined, get: FactGetter): string | undefined {
  if (line.length > MAX_INPUT) return `${HEAD}this command is longer than 200,000 characters, so it could not be read whole. Split it into smaller commands. ${ADVICE}`
  const found = findingOf(line, parse, [cwd], home, get, 0, false)
  if (found !== undefined) return `${HEAD}${found}. ${ADVICE}`
  if (mentionsDatabase(line) && (parse.unknowns.length > 0 || parse.statements.some(s => !s.isPlaced))) return `${HEAD}${UNREAD}. ${ADVICE}`
  return undefined
}
