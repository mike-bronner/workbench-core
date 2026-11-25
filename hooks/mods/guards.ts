// The five guards that run in the hooks module, as pure functions. Each reads a
// tool call and answers with a refusal, or undefined to let the call go on.
// hooks/register.ts calls them from its tool.call hook, before the call runs.
//
//   peer message      a sub-agent's SendMessage goes to "main" or to an agent
//                     id, and nowhere else
//   summary writer    the detached summary-writer (WORKBENCH_SUMMARY_WRITER=1)
//                     writes no markdown file with Bash
//   credential        no call reads, links or copies ~/.ssh, ~/.aws, ~/.gnupg,
//                     a .env file, a macOS keychain folder or Claude's own
//                     credential store
//   whole-disk search no search starts at the whole disk, a home folder, a
//                     Library folder or a system tree: Bash, Grep and Glob
//
// The first four replace retired bash hooks of the same names.
// tests/guard-corpus.test.ts holds each port to refusing everything its bash
// hook refused, unless a sandboxed run in bash and zsh showed the command does
// no harm.
//
// Four more guards run in the same hook from modules of their own: the
// destructive-scope, destructive-database and vault-git guards
// (destructive-scope.ts, destructive-database.ts, vault-git.ts), and the
// outbound prose guard (outbound-prose.ts). Each is held to the cases its bash
// hook refused, recorded in tests/guard-corpus/.
//
// HOW A COMMAND IS READ. A Bash command is read only through parseShell
// (hooks/mods/shell.ts), never as raw text. A guard reads the statements'
// words, their redirect targets and their heredoc bodies. A line whose command
// the reader cannot name (hiddenCommandRefusal) is refused by every guard.
// Where the reader left another part unread, a guard whose subject the line
// mentions refuses: the part it could not read may be the part that matters.
//
// Pure functions only: the engine follows `$` into no imported function.

import type { WorkbenchShellParse as ShellParse, WorkbenchShellStatement as Statement } from '../../types'
import { LEDGER_RULES, LEDGER_WRITE_REFUSAL } from './ledger.ts'
import { SHELLS, nameOf, parseShell, shellScriptOf } from './shell.ts'

// The tools a guard judges. When the tool.call hook fails before it passes one
// of them on, its .catch refuses the call: Agent and SendMessage too, so a
// sub-agent's call is refused when the guards cannot judge it.
export const GUARDED: ReadonlySet<string> = new Set(['Bash', 'Read', 'Edit', 'Write', 'NotebookEdit', 'Grep', 'Glob', 'Agent', 'EnterWorktree', 'ExitWorktree', 'SendMessage'])

// The bash guards read at most this much of a command, and refused a longer
// one that holds their subject. The ports read every byte, and keep the
// refusal, so a padded command is refused as it was.
export const MAX_INPUT = 200_000

// Every piece of text the reading holds: each statement's words, its redirect
// targets, and its heredoc bodies. A comment is never in it.
export function textsOf(parse: ShellParse): string[] {
  return parse.statements.flatMap(s => [...s.words, ...s.redirects.map(r => r.target), ...s.heredocs.map(h => h.body)])
}

// Whether the reader left part of the line unread.
export const isPartlyRead = (parse: ShellParse): boolean => parse.unknowns.length > 0 || parse.statements.some(s => !s.isPlaced)

const piecesOf = (text: string): string[] => text.split(/[ \t\n\r\v\f]+/).filter(Boolean)

// A command the reader cannot name: a command name from a variable or a
// substitution, a wrapper option it cannot place, a script piped into a
// shell, or a quote or heredoc the reader cannot close. Every guard refuses
// such a line, whatever it mentions, because the command it hides may be any
// guard's subject. zsh closes a `"` inside $[ ] and $(( )) where the reader
// does not, and a heredoc delimiter the reader cannot build ends the body
// where it cannot see, so after either the reader cannot tell where the
// commands end. Other unknowns (an escape the reader does not decode) refuse
// only where the line names a guard's subject.
export function hiddenCommandRefusal(parse: ShellParse): string | undefined {
  const why = parse.unknowns.includes('expansion')
    ? 'a command name, a script for bash -c, eval or trap, or an unquoted heredoc fed to a shell, takes text from a variable or a substitution, or the line both takes in outside data (a substitution, read, mapfile, select or printf -v) and does arithmetic or uses a value as a variable name. To do that, split the line: run the arithmetic or the name lookup in a separate Bash call'
    : parse.unknowns.includes('stdin')
      ? 'a script is piped or fed into a shell'
      : parse.unknowns.includes('wrapper') || parse.statements.some(s => !s.isPlaced)
        ? 'a wrapper carries an option the reader does not know, so the command after it is a guess'
        : parse.unknowns.includes('quote') || parse.unknowns.includes('heredoc')
          ? 'a quote or a heredoc is left open, so the reader cannot tell where the commands end'
          : undefined
  if (why === undefined) return undefined
  return (
    `Workbench guards (workbench-core): the shell reader cannot tell which command this line runs: ${why}. ` +
    'Write each command name out plainly, with no variable or substitution in it, close every quote and heredoc, and run a script with bash -c or as a file instead of piping it into a shell. ' +
    "A heredoc fed to a shell must be quoted (bash <<'EOF'), because the outer shell expands a $, runs a backtick and removes a backslash in an unquoted one before the inner shell reads it. " +
    'If the line must stay as it is, stop and ask Mike to run it himself with the ! prefix.'
  )
}

// Why a guard refused a line it could not read whole, which names its subject.
const unreadNote =
  'The shell reader could not read all of this command (an unclosed quote, a command name in a variable, a script piped into a shell, or a wrapper option it does not know), and the command mentions what this guard protects.'

// ─── peer message ────────────────────────────────────────────────────────────

const SKILL_LINE = 'The protocol for a message between sessions is in /workbench-core:cross-session-messaging.'

export const PEER_REFUSAL =
  'Peer message gate (workbench-core): a sub-agent sends messages to its own orchestrator and to agents it spawned, and nowhere else. ' +
  'This send names a destination that is neither "main" nor an agent id. Send it to "main" instead, and let the orchestrator decide whether to reach the other session. ' +
  'A peer session reached from a sub-agent gets the message under your parent session\'s address, and any reply goes to that conversation, not to you. ' +
  SKILL_LINE

export const PEER_ADVICE =
  'Peer message note (advisory, nothing was blocked): this send names an agent id. A sub-agent may message an agent it spawned itself. ' +
  'It may not message a sibling or a peer session, and no hook can tell those apart, so only you can answer this. ' +
  'If you did not spawn this agent, cancel the send and report to your orchestrator instead. ' +
  SKILL_LINE

// An agent id as measured: lowercase hex, 17 characters. The floor is 16, so a
// wider id still passes. Spelled as a character test, never a regex anchor.
const isAgentId = (value: string): boolean => value.length >= 16 && [...value].every(c => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))

// The verdict on a sub-agent's send: `deny`, `advise` (an agent id), or
// `allow` ("main"). Every destination field present is read, and the strictest
// wins. A send with no destination at all is refused: it names nobody the
// sub-agent may reach.
export function peerVerdict(input: { to?: unknown; recipient?: unknown }): 'allow' | 'advise' | 'deny' {
  const destinations = [input.to, input.recipient].filter(value => value !== undefined && value !== null && value !== '')
  if (destinations.length === 0) return 'deny'
  const classes = destinations.map(value => (typeof value !== 'string' ? 'other' : value === 'main' ? 'main' : isAgentId(value) ? 'agent' : 'other'))
  if (classes.includes('other')) return 'deny'
  return classes.includes('agent') ? 'advise' : 'allow'
}

// ─── provisioning ────────────────────────────────────────────────────────────

const provisioning = (action: string, advice: string): string => `Provisioning guard (workbench-core): ${action}. ${advice} ${LEDGER_RULES}`

export const ENTER_WORKTREE_REFUSAL = provisioning(
  'EnterWorktree creates a git worktree or moves this session into one, outside the provisioning ledger',
  'Do not call EnterWorktree. Make the worktree with git worktree add as below.',
)
export const EXIT_WORKTREE_REFUSAL = provisioning(
  'ExitWorktree with action "remove" deletes this session\'s worktree and its branch, outside the provisioning ledger',
  'Exit with action "keep" instead: it leaves the worktree and the branch on disk.',
)
export const AGENT_WORKTREE_REFUSAL = provisioning(
  'an Agent dispatch with isolation "worktree" makes the harness create a git worktree for the sub-agent, outside the provisioning ledger',
  'Dispatch without isolation, with a Workdir in the tree you are in or in a worktree you made as below.',
)

const WORKTREE_VERBS: Readonly<Record<string, string>> = {
  add: 'git worktree add creates a git worktree',
  remove: 'git worktree remove deletes a worktree',
  prune: 'git worktree prune deletes the records of worktrees git believes are gone, which breaks a tree that is only unmounted',
}
const CREATE_COMMANDS: Readonly<Record<string, string>> = {
  createdb: 'createdb creates a PostgreSQL database',
  createuser: 'createuser creates a PostgreSQL role',
}
// Clients whose payload is SQL. sqlite3 is left out on purpose: a migration
// that creates database.sqlite is ordinary work.
const SQL_CLIENTS: ReadonlySet<string> = new Set(['psql', 'mysql', 'mariadb', 'mysqlsh', 'usql'])
const SQL_FLAGS: ReadonlySet<string> = new Set(['-c', '--command', '-e', '--execute', '--sql'])
const SQL_PREFIXES = ['--command=', '--execute=', '--sql=']
// Commands that run a command they are given inside a container, a project
// stack or another host. Any word after one may be the command it runs.
const RUNNERS: ReadonlySet<string> = new Set([
  'docker', 'docker-compose', 'podman', 'podman-compose', 'kubectl', 'ssh', 'sail', 'lando', 'ddev', 'wp-env',
])
const SQL_CREATE = /\bCREATE\s+(DATABASE|SCHEMA)\b/i
const SQL_LITERAL = /'(?:[^']|'')*'/g

function sqlCreate(payload: string): string | undefined {
  for (const part of payload.replace(SQL_LITERAL, "''").split(';')) {
    const match = SQL_CREATE.exec(part)
    if (match) return `the SQL runs CREATE ${(match[1] as string).toUpperCase()}`
  }
  return undefined
}

// The finding for one command, given as its words from the name on: the git
// worktree verbs, the creation binaries, and mysqladmin create.
function provisioningOf(words: readonly string[]): string | undefined {
  const name = nameOf(words[0] ?? '')
  const args = words.slice(1)
  if (name === 'git') {
    const at = args.indexOf('worktree')
    if (at === -1) return undefined
    const verb = args.slice(at + 1).find(word => !word.startsWith('-'))
    return verb !== undefined && Object.hasOwn(WORKTREE_VERBS, verb) ? WORKTREE_VERBS[verb] : undefined
  }
  if (Object.hasOwn(CREATE_COMMANDS, name)) return CREATE_COMMANDS[name]
  if (name === 'mysqladmin' && args.includes('create')) return 'mysqladmin create creates a MySQL database'
  return undefined
}

// The SQL a statement hands its client: -c, --command, -e, --execute and --sql
// values, here-strings, and heredoc bodies.
function sqlPayloads(statement: Statement): string[] {
  const payloads: string[] = []
  const { args } = statement
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (SQL_FLAGS.has(arg) && i + 1 < args.length) payloads.push(args[++i] as string)
    for (const prefix of SQL_PREFIXES) if (arg.startsWith(prefix)) payloads.push(arg.slice(prefix.length))
  }
  for (const redirect of statement.redirects) if (redirect.isReal && redirect.op === '<<<') payloads.push(redirect.target)
  for (const doc of statement.heredocs) payloads.push(doc.body)
  return payloads
}

// What a command run through a runner (`docker compose exec db createdb x`,
// `ssh box "git worktree add x"`) would do: every suffix of its words is read
// as a command, and each word holding a space is read as a command line.
function runnerFinding(statement: Statement, depth: number): string | undefined {
  const { args } = statement
  for (let i = 0; i < args.length; i++) {
    const words = args.slice(i)
    const found = provisioningOf(words)
    if (found !== undefined) return found
    const name = nameOf(words[0] as string)
    if (SQL_CLIENTS.has(name)) {
      for (const payload of sqlPayloads({ ...statement, args: words.slice(1) })) {
        const sql = sqlCreate(payload)
        if (sql !== undefined) return `${sql}, handed to ${name}`
      }
    }
    if (SHELLS.has(name)) {
      const { script } = shellScriptOf(words.slice(1))
      if (script !== undefined) {
        const inner = provisioningFinding(script, depth + 1)
        if (inner !== undefined) return inner
      }
    }
    if (/\s/.test(words[0] as string)) {
      const inner = provisioningFinding(words[0] as string, depth + 1)
      if (inner !== undefined) return inner
    }
  }
  return undefined
}

// What the line provisions, or undefined.
export function provisioningFinding(line: string, depth = 0, parse?: ShellParse): string | undefined {
  if (depth > 4) return undefined
  const reading = parse ?? parseShell(line)
  const statements = reading.statements
  for (const statement of statements) {
    if (statement.nameAt === -1) continue
    const found = provisioningOf(statement.words.slice(statement.nameAt))
    if (found !== undefined) return found
    // An escaped word among git's options and subcommand, or anywhere after a
    // worktree subcommand, may spell a worktree verb.
    if (statement.name === 'git') {
      const last = statement.args.includes('worktree') || statement.subcommandAt === -1 ? statement.words.length : statement.nameAt + 1 + statement.subcommandAt
      if (statement.escaped.some(at => at > statement.nameAt && at <= last)) return 'a git command with an escaped word, which may spell a worktree verb'
    }
    if (RUNNERS.has(statement.name)) {
      const inner = runnerFinding(statement, depth)
      if (inner !== undefined) return inner
    }
  }
  // SQL is read only where a SQL client runs in the line. Then every payload
  // in the line counts: `echo "CREATE DATABASE x" | psql` sends echo's words.
  const clients = statements.filter(s => SQL_CLIENTS.has(s.name))
  if (clients.length > 0) {
    for (const statement of statements) {
      const payloads = [...sqlPayloads(statement), ...(statement.name === 'echo' || statement.name === 'printf' ? statement.args.filter(a => !a.startsWith('-')) : [])]
      for (const payload of payloads) {
        const sql = sqlCreate(payload)
        if (sql !== undefined) return `${sql}, handed to ${(clients[0] as Statement).name}, which runs it against a live database server`
      }
    }
  }
  return undefined
}

// The refusal for a Bash line, or undefined.
export function provisioningRefusal(line: string, parse: ShellParse = parseShell(line)): string | undefined {
  const isSubject = /create|worktree/i.test(line)
  if (isSubject && line.length > MAX_INPUT) {
    return provisioning('this command is longer than 200,000 characters and mentions a creation verb', 'Split it into smaller commands.')
  }
  const found = provisioningFinding(line, 0, parse)
  if (found !== undefined) return provisioning(found, 'Only the accepted lines below provision, each alone on its line, with no wrapper.')
  if (isSubject && isPartlyRead(parse)) return provisioning(unreadNote, 'Write the command out plainly, with no variable as a command name.')
  return undefined
}

// ─── summary writer ──────────────────────────────────────────────────────────

export const SUMMARY_REFUSAL_HEAD = 'Summary-writer guard (workbench-core): '
const SUMMARY_ADVICE =
  'The summary-writer writes summaries, and every vault file, only through the memory MCP write tool (mcp__plugin_workbench-core_memory__write) with a vault-relative sessions/... path, never with Bash. ' +
  'A shell write lands relative to the current directory, which is the source project, not the vault. ' +
  'Write the file through the MCP tool. If that tool is not available, leave the pending marker in place and exit.'

const MD = /\.md(?![A-Za-z0-9])/
const WRITERS: ReadonlySet<string> = new Set(['tee', 'cp', 'mv', 'install', 'rsync'])
const OUTPUT_OPS: ReadonlySet<string> = new Set(['>', '>>', '>|', '&>', '&>>', '<>', '>&'])

// What in the line writes a markdown file, or undefined.
export function markdownWrite(parse: ShellParse): string | undefined {
  for (const statement of parse.statements) {
    for (const redirect of statement.redirects) {
      if (redirect.isReal && OUTPUT_OPS.has(redirect.op) && redirect.target.includes('.md')) return `a redirect writes ${redirect.target}`
    }
  }
  const texts = textsOf(parse)
  if (!texts.some(text => MD.test(text))) return undefined
  // A sed whose options hold an i anywhere, `-Ei` or `--in-place`, edits in
  // place.
  for (const statement of parse.statements) {
    if ((statement.name === 'sed' || statement.name === 'gsed') && statement.args.some(a => /^-[A-Za-z]*i/.test(a) || a.startsWith('--in-place'))) {
      return 'sed -i edits a .md file in place'
    }
  }
  // A writer word anywhere counts, as it did for the bash guard, which read the
  // text: the command `tee x.md`, and `xargs tee` read past an option the
  // reader cannot place.
  for (const text of texts) {
    const pieces = piecesOf(text)
    for (let i = 0; i < pieces.length; i++) {
      if (WRITERS.has(pieces[i] as string)) return `${pieces[i]} touches a .md file`
      if (pieces[i] === 'sed' && (pieces[i + 1] ?? '').startsWith('-i')) return 'sed -i edits a .md file in place'
    }
  }
  return undefined
}

export function summaryWriterRefusal(parse: ShellParse): string | undefined {
  const found = markdownWrite(parse)
  if (found !== undefined) return `${SUMMARY_REFUSAL_HEAD}${found}. ${SUMMARY_ADVICE}`
  if (isPartlyRead(parse) && textsOf(parse).some(text => text.includes('.md'))) return `${SUMMARY_REFUSAL_HEAD}${unreadNote} ${SUMMARY_ADVICE}`
  return undefined
}

const WORKBENCH = /\.claude-workbench/i
const PROTECTED = /provisioning/i
const LEDGER_READERS: ReadonlySet<string> = new Set(['cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'jq', 'ls', 'stat', 'file', 'diff', 'cmp', 'shasum'])
const LITERAL = /^[^*?[\]{}$`]*$/
const expands = (word: string): boolean => /[*?[]/.test(word) || /\{[^}]*(,|\.\.)[^}]*\}/.test(word)

export const workbenchDirOf = (home: string): string => `${home.replace(/\/+$/, '')}/.claude-workbench`
export const ledgerDirOf = (home: string): string => `${workbenchDirOf(home)}/provisioning`

export type CwdPlace = 'ledger' | 'workbench' | 'outside'

const isAtOrAbove = (path: string, dir: string): boolean => {
  const [p, d] = [path.toLowerCase(), dir.toLowerCase()]
  return p === '/' || p === d || d.startsWith(`${p}/`) || p.startsWith(`${d}/`)
}

function linksToLedger(parse: ShellParse, cwd: string | undefined, home: string | undefined): boolean {
  if (home === undefined) return false
  return parse.statements.some(s => {
    if (s.name !== 'ln') return false
    const operands = s.args.filter(arg => !arg.startsWith('-'))
    const targets = operands.length === 1 ? operands : operands.slice(0, -1)
    return targets.some(target => {
      const path = resolvePath(target, cwd, home)
      return path !== undefined && isAtOrAbove(path, ledgerDirOf(home))
    })
  })
}

const FINDERS: ReadonlySet<string> = new Set(['find', 'gfind', 'bfs'])
const FIND_RUNS: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir'])
const RECURSIVE_CP = /^-[A-Za-z]*[Rra][A-Za-z]*$|^--(recursive|archive)$/
const SUBSTITUTED = /\$_|\$\(|`/

function bulkReachesLedger(parse: ShellParse, cwd: string | undefined, home: string | undefined): boolean {
  if (home === undefined) return false
  const reaches = (word: string | undefined): boolean => {
    const path = word === undefined ? undefined : resolvePath(word, cwd, home)
    return path !== undefined && isAtOrAbove(path, ledgerDirOf(home))
  }
  return parse.statements.some(s => {
    const operands = s.args.filter(arg => !arg.startsWith('-'))
    const last = operands.at(-1)
    if (FINDERS.has(s.name) && s.args.some(arg => FIND_RUNS.has(arg))) {
      const starts = s.args.slice(0, Math.max(0, s.args.findIndex(arg => arg.startsWith('-') || arg === '(' || arg === '!')))
      return (starts.length === 0 ? ['.'] : starts).some(reaches)
    }
    if (s.name === 'cp' && s.args.some(arg => RECURSIVE_CP.test(arg))) return reaches(last)
    if (s.name === 'rsync' || s.name === 'ditto') return reaches(last)
    if (s.name === 'mv' || s.name === 'rename') return operands.some(reaches)
    if (s.name === 'unzip') return reaches(s.args[s.args.indexOf('-d') + 1] ?? '.')
    if (s.name === 'tar' || s.name === 'bsdtar' || s.name === 'gtar') {
      const at = s.args.findIndex(arg => arg === '-C' || arg === '--directory')
      const into = at === -1 ? s.args.find(arg => arg.startsWith('--directory='))?.slice('--directory='.length) : s.args[at + 1]
      const isExtract = s.args.some((arg, i) => /^-[A-Za-z]*x[A-Za-z]*$/.test(arg) || (i === 0 && /^[A-Za-z]*x[A-Za-z]*$/.test(arg)) || arg === '--extract' || arg === '--get')
      return isExtract && reaches(into ?? '.')
    }
    return false
  })
}

export function ledgerWriteRefusal(parse: ShellParse, cwd: string | undefined, home: string | undefined, place: CwdPlace): string | undefined {
  if (linksToLedger(parse, cwd, home) || bulkReachesLedger(parse, cwd, home)) return LEDGER_WRITE_REFUSAL.deny
  const texts = textsOf(parse)
  const isHidden = texts.some(text => WORKBENCH.test(text)) && parse.statements.some(s => (s.name === 'cd' || s.name === 'pushd') && s.args.some(arg => SUBSTITUTED.test(arg)))
  const isEntered = place !== 'outside' || isHidden || parse.statements.some(s => (s.name === 'cd' || s.name === 'pushd') && s.args.some(arg => WORKBENCH.test(arg)))
  if (!isEntered && !texts.some(text => WORKBENCH.test(text))) return undefined
  const expanded = parse.statements.flatMap(s => [...s.words.filter(word => !s.assignments.includes(word)), ...s.redirects.map(r => r.target)])
  const isRisky = expanded.some(word => (WORKBENCH.test(word) || (isEntered && !word.startsWith('/'))) && expands(word))
  const isProtected = place === 'ledger' || isHidden || texts.some(text => PROTECTED.test(text))
  if (!isRisky && !isProtected) return undefined
  const isQuiet = (s: Statement): boolean => s.redirects.every(r => !r.isReal || !OUTPUT_OPS.has(r.op) || r.target === '/dev/null')
  const isReader = (s: Statement): boolean => s.nameAt === 0 && LEDGER_READERS.has(s.name) && s.heredocs.length === 0 && isQuiet(s) && s.args.every(arg => LITERAL.test(arg))
  return !isRisky && !isPartlyRead(parse) && parse.statements.every(isReader) ? undefined : LEDGER_WRITE_REFUSAL.deny
}

export const isInsideDir = (path: string, dir: string): boolean => path.toLowerCase() === dir.toLowerCase() || path.toLowerCase().startsWith(`${dir.toLowerCase()}/`)

export const ledgerPathRefusal = (path: string, realPath: string | undefined, realDir: string | undefined): string | undefined =>
  (WORKBENCH.test(path) && PROTECTED.test(path)) || (realPath !== undefined && realDir !== undefined && isInsideDir(realPath, realDir)) ? LEDGER_WRITE_REFUSAL.deny : undefined

// ─── credential ──────────────────────────────────────────────────────────────

const CREDENTIAL_ADVICE =
  'Work without it. If the task really needs this file, stop and ask Mike: he runs the step himself with the ! prefix. ' +
  'Never link, copy or read a keychain folder or a credential to make a run authenticate, and never run the same read through another program to get around this guard.'

const credential = (what: string, where: string): string => `Credential guard (workbench-core): this call touches ${what}${where}. ${CREDENTIAL_ADVICE}`

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A path as the file system reads it: `//` is `/`, `/./` is `/`, and `x/..`
// is gone. The protected families are matched on this, and without regard to
// case, because APFS finds `~/library/KEYCHAINS` at `~/Library/Keychains`.
export function collapsed(text: string): string {
  let out = text
  let before: string
  do {
    before = out
    out = out
      .replace(/\/{2,}/g, '/')
      .replace(/\/\.(?=\/|$|[\s"';)])/g, '')
      .replace(/(^|\/)(?!\.\.(?:\/|$))[^/\s"'=:()~$]+\/\.\.(?=\/|$|[\s"';)])/g, '$1')
  } while (out !== before)
  return out
}

// ~/.ssh, ~/.aws and ~/.gnupg reached through ~, $HOME, ${HOME} or the home
// path. A ~ counts only where bash expands it, at the start of a word or after
// = or :. $HOME and the home path count anywhere, so `-c$HOME/.ssh/id_rsa` is
// caught too. A folder that only shares the name, `Developer/x/.ssh`, is not.
function homeDirsRe(home: string | undefined): RegExp {
  const homes = ['(^|[\\s"\'=:(])~', '\\$HOME', '\\$\\{HOME\\}', ...(home ? [escapeRegExp(home)] : [])]
  return new RegExp(`(${homes.join('|')})/\\.(ssh|aws|gnupg)(/|$|[\\s"';)])`, 'i')
}
// A macOS keychain folder and Claude's credential file, under any home.
const KEYCHAINS = /(^|[\s"'=:(/])Library\/Keychains(\/|$|[\s"';)])/i
const CLAUDE_CREDENTIALS = /(^|[\s"'=:(/])\.credentials\.json($|[\s"';)])/i
const DOTENV_NAMES = /\.env(?![A-Za-z0-9_-])/gi
const DOTENV_BASE = /^\.env(?![A-Za-z0-9_-])/i
const STEM_CHAR = /[A-Za-z0-9_]/
const PATTERN_CHARS = '*?[{(|^#~<>'
const TEMPLATE_REST = /^(\.[A-Za-z0-9_-]+)*\.(example|sample|template|dist|defaults?)\)?[.,:;!]*(['"`][.,:;!'"`)\]]*)?$/i
const TEMPLATE_KEYWORD = /\.(example|sample|template|dist|defaults?)(?=[(|)])/gi
const SCAN_LIMIT = 256

function scanWhile(line: string, from: number, test: (char: string) => boolean): number | undefined {
  let at = from
  while (at < line.length && test(line[at] as string)) if (++at - from > SCAN_LIMIT) return undefined
  return at
}

function hasTemplateGroup(line: string): boolean {
  for (const m of line.matchAll(TEMPLATE_KEYWORD)) {
    let start = m.index
    while (start > 0 && /[A-Za-z0-9_.-]/.test(line[start - 1] as string)) if (m.index - --start > SCAN_LIMIT) return true
    if (!/\.env(\.[A-Za-z0-9_-]+)*\.$/i.test(line.slice(start, m.index + 1))) continue
    let at = m.index + m[0].length
    if (line[at] === '(') return true
    if (line[at] === '|') {
      const end = scanWhile(line, at + 1, char => !/[\s;&<>()]/.test(char))
      if (end === undefined) return true
      at = end
    }
    if (line[at] !== ')') continue
    const after = scanWhile(line, at + 1, char => '.,:;!)'.includes(char))
    if (after === undefined) return true
    if (!(after >= line.length || /[\s'"`]/.test(line[after] as string))) return true
  }
  return false
}
// Programs that read file contents, or link or copy a file. A protected path
// alone does not refuse: `ls ~/.ssh` lists names and shows no secret.
export const READERS = [
  'cat', 'head', 'tail', 'less', 'more', 'strings', 'xxd', 'hexdump', 'od', 'base64', 'nl', 'tac', 'rev',
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'awk', 'gawk', 'sed', 'jq', 'yq', 'cut', 'paste', 'sort', 'uniq', 'diff',
  'cp', 'mv', 'scp', 'rsync', 'tar', 'zip', 'gzip', 'curl', 'wget', 'nc', 'ncat', 'openssl', 'gpg', 'dd', 'tee',
  'python', 'python3', 'node', 'bun', 'deno', 'php', 'ruby', 'perl', 'sqlite3', 'plutil', 'security',
  'ssh-keygen', 'ssh-add', 'vim', 'nvim', 'nano', 'emacs', 'code', 'open',
  // Beyond the bash guard: what links or copies a folder.
  'ln', 'link', 'ditto', 'install', 'cpio',
]
const READER_NAMES = READERS.map(escapeRegExp).join('|')
const READER = new RegExp(`(?<![A-Za-z0-9_.])(${READER_NAMES})(?![A-Za-z0-9_])|(?<=\\.)(${READER_NAMES})(?![A-Za-z0-9_])(?![.,:;!?'"\`]*(\\s|$))`)
// The refusal for a path a file tool names, or undefined.
export function credentialPathRefusal(raw: string, home: string | undefined): string | undefined {
  const path = collapsed(raw)
  if (homeDirsRe(home).test(path)) return credential('a protected credential folder (~/.ssh, ~/.aws, ~/.gnupg)', `: ${path}`)
  if (KEYCHAINS.test(path)) return credential('a macOS keychain folder', `: ${path}`)
  if (CLAUDE_CREDENTIALS.test(path)) return credential("Claude's credential store", `: ${path}`)
  if (namesDotenvPath(path)) return credential('a .env file', `: ${path}`)
  return undefined
}

const isDotenvBase = (part: string): boolean => DOTENV_BASE.test(part) && !TEMPLATE_REST.test(part.slice(4))

const hasPatternChar = (text: string): boolean => [...text].some(char => PATTERN_CHARS.includes(char))

const PART_STARTS = '{,(|[)'

const isDotGlob = (word: string): boolean => word.split('/').some(part => hasPatternChar(part) && (part.startsWith('.') || [...PART_STARTS].some(char => part.includes(`${char}.`))))

const DOTENV_SUFFIXES: ReadonlySet<string> = new Set(['env', 'local', 'production', 'staging', 'development', 'test', 'testing', 'dev', 'prod', 'keys', 'vault', 'ci', 'bak'])
const DOTENV_TARGETS = ['.env', ...[...DOTENV_SUFFIXES].flatMap(suffix => [`.env.${suffix}`, `.env.${suffix}.local`])]

function expandGlobBraces(pattern: string, budget: { left: number }): string[] | undefined {
  const open = pattern.indexOf('{')
  if (open === -1) return [pattern]
  let depth = 0
  const commas: number[] = []
  for (let i = open; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '{') depth++
    else if (char === ',' && depth === 1) commas.push(i)
    else if (char === '}' && --depth === 0) {
      const bounds = [open, ...commas, i]
      const results: string[] = []
      for (let n = 0; n < bounds.length - 1; n++) {
        if (--budget.left < 0) return undefined
        const expanded = expandGlobBraces(pattern.slice(0, open) + pattern.slice((bounds[n] as number) + 1, bounds[n + 1]) + pattern.slice(i + 1), budget)
        if (expanded === undefined) return undefined
        results.push(...expanded)
      }
      return results
    }
  }
  return undefined
}

function stepsOf(part: string): ({ kind: 'star' } | { kind: 'any' } | { kind: 'set'; test: (char: string) => boolean })[] | undefined {
  const steps: ({ kind: 'star' } | { kind: 'any' } | { kind: 'set'; test: (char: string) => boolean })[] = []
  for (let i = 0; i < part.length; i++) {
    const char = part[i] as string
    const close = char === '[' ? part.indexOf(']', i + 2) : -1
    if (char === '*') steps.push({ kind: 'star' })
    else if (char === '?') steps.push({ kind: 'any' })
    else if (close !== -1) {
      const body = part.slice(i + 1, close)
      let set: RegExp
      try {
        set = new RegExp(`^[${body.replace(/^!/, '^').replace(/\\/g, '\\\\')}]$`, 'i')
      } catch {
        return undefined
      }
      steps.push({ kind: 'set', test: c => set.test(c) })
      i = close
    } else {
      const literal = char.toLowerCase()
      steps.push({ kind: 'set', test: c => c.toLowerCase() === literal })
    }
  }
  return steps
}

function partCanMatchDotenv(part: string): boolean {
  const extension = /^\*\.([A-Za-z]{1,12})$/.exec(part)?.[1]
  if (extension !== undefined) return DOTENV_SUFFIXES.has(extension.toLowerCase())
  const steps = stepsOf(part)
  if (steps === undefined) return true
  return DOTENV_TARGETS.some(target => {
    let reached = new Set([0])
    for (const step of steps) {
      const next = new Set<number>()
      for (const at of reached) {
        if (step.kind === 'star') for (let to = at; to <= target.length; to++) next.add(to)
        else if (at < target.length && (step.kind === 'any' || step.test(target[at] as string))) next.add(at + 1)
      }
      reached = next
      if (reached.size === 0) return false
    }
    return reached.has(target.length)
  })
}

function globCanMatchDotenv(pattern: string): boolean {
  if (!hasPatternChar(pattern)) return false
  const alternatives = expandGlobBraces(pattern, { left: 64 })
  if (alternatives === undefined) return true
  return alternatives.some(alternative => partCanMatchDotenv(alternative.split('/').at(-1) ?? ''))
}

const isDotenvName = (piece: string, at: number): boolean => {
  let start = at
  while (start > 0 && STEM_CHAR.test(piece[start - 1] as string)) start--
  const isVariable = start > 0 && piece[start - 1] === '$'
  const stem = (isVariable ? 1 : 0) + at - start
  if (stem > 1) return isVariable
  return stem === 0 && !/[.*?\]-]/.test(piece[at - 1] ?? '')
}

const isTemplateRest = (rest: string): boolean => rest.length <= 256 && TEMPLATE_REST.test(rest)

const readsDotenv = (word: string): boolean =>
  piecesOf(word).some(piece => [...piece.matchAll(DOTENV_NAMES)].some(m => isDotenvName(piece, m.index) && !isTemplateRest(piece.slice(m.index + 4, m.index + 261))))

const REUSES_LAST = /\$(_(?![A-Za-z0-9_])|\{_(?![A-Za-z0-9_]))/
const isDotglobLine = (line: string): boolean =>
  /globdots|dotglob|globignore/.test(line.toLowerCase().replaceAll('_', '')) || [...line.matchAll(/\(([^()\s]*)\)/g)].some(group => group[1]?.includes('D'))
const DOT_RANGE = /(^|[\s/'"])\.[^\s/<>;|&'"]*<\d*-\d*>/

type Lexed = { text: string; isDotGlob: boolean; isGlob: boolean }
type Quoting = { words: Lexed[]; targets: Lexed[]; subWords: Lexed[]; subTargets: Lexed[]; isDotGroup: boolean; isSubBroken: boolean; reusesLast: boolean }

function closingOf(line: string, at: number, open: string, close: string): number {
  let depth = 0
  for (let i = at; i < line.length; i++) {
    const char = line[i]
    if (char === '\\') i++
    else if (char === "'" && open !== "'") {
      i = line.indexOf("'", i + 1)
      if (i === -1) return -1
    } else if (char === open && open !== close) depth++
    else if (char === close && (open === close ? i > at : --depth === 0)) return i
  }
  return -1
}

function quotingOf(line: string): Quoting | undefined {
  const words: Lexed[] = []
  const targets: Lexed[] = []
  const subWords: Lexed[] = []
  const subTargets: Lexed[] = []
  const heredocs: { delimiter: string; strips: boolean; expands: boolean }[] = []
  let reusesLast = false
  let isDotGroup = false
  let isSubBroken = false
  let closeAt = -2
  let pipeDotAt = -2
  let text = ''
  let isWord = false
  let isTarget = false
  let isGlob = false
  let isDotGlobWord = false
  let isSegmentStart = true
  let isDotSegment = false
  let hasSegmentPattern = false
  const add = (chars: string, isQuoted: boolean): void => {
    for (const char of chars) {
      if (char === '/') {
        isDotSegment = false
        hasSegmentPattern = false
      } else if (isSegmentStart && char === '.') isDotSegment = true
      if (!isQuoted && PATTERN_CHARS.includes(char)) {
        isGlob = true
        hasSegmentPattern = true
      }
      if (isDotSegment && hasSegmentPattern) isDotGlobWord = true
      isSegmentStart = char === '/' || (!isQuoted && PART_STARTS.includes(char))
      text += char
    }
    isWord = true
  }
  const end = (): void => {
    if (isWord) (isTarget ? targets : words).push({ text, isDotGlob: isDotGlobWord, isGlob })
    if (isWord) isTarget = false
    text = ''
    isWord = false
    isGlob = false
    isDotGlobWord = false
    isSegmentStart = true
    isDotSegment = false
    hasSegmentPattern = false
  }
  const substitution = (at: number, open: string, close: string): number => {
    const closed = closingOf(line, at, open, close)
    if (closed === -1) return -1
    const inner = quotingOf(line.slice(at + 1, closed))
    if (inner === undefined) {
      isSubBroken = true
      if (REUSES_LAST.test(line.slice(at, closed))) reusesLast = true
    } else {
      subWords.push(...inner.subWords, ...inner.words)
      subTargets.push(...inner.subTargets, ...inner.targets)
      reusesLast ||= inner.reusesLast
      isDotGroup ||= inner.isDotGroup
      isSubBroken ||= inner.isSubBroken
    }
    add('$_', true)
    return closed
  }
  for (let i = 0; i < line.length; i++) {
    const char = line[i] as string
    const next = line[i + 1] ?? ''
    if (char === '\\' && next === '\n') i++
    else if (char === '\\') {
      add(next, true)
      i++
    } else if (char === "'" || (char === '$' && next === "'")) {
      const open = char === '$' ? i + 1 : i
      let close = open + 1
      while (close < line.length && line[close] !== "'") close += char === '$' && line[close] === '\\' ? 2 : 1
      if (close >= line.length) return undefined
      add(line.slice(open + 1, close), true)
      i = close
    } else if (char === '"') {
      let at = i + 1
      for (; at < line.length && line[at] !== '"'; at++) {
        const inner = line[at] as string
        if (inner === '\\' && line[at + 1] === '\n') at++
        else if (inner === '\\' && '$`"\\'.includes(line[at + 1] ?? '')) add(line[++at] as string, true)
        else if (inner === '$' && line[at + 1] === '(') {
          at = substitution(at + 1, '(', ')')
          if (at === -1) return undefined
        } else if (inner === '`') {
          at = substitution(at, '`', '`')
          if (at === -1) return undefined
        } else {
          if (inner === '$' && REUSES_LAST.test(line.slice(at, at + 4))) reusesLast = true
          add(inner, true)
        }
      }
      if (at >= line.length) return undefined
      add('', true)
      i = at
    } else if (char === '$' && next === '(') {
      i = substitution(i + 1, '(', ')')
      if (i === -1) return undefined
    } else if (char === '`') {
      i = substitution(i, '`', '`')
      if (i === -1) return undefined
    } else if (char === '<' && next === '<' && line[i + 2] !== '<') {
      end()
      let at = i + 2
      const strips = line[at] === '-'
      if (strips) at++
      while (line[at] === ' ' || line[at] === '\t') at++
      const start = at
      while (at < line.length && !/[\s;&|<>()]/.test(line[at] as string)) at++
      const raw = line.slice(start, at)
      if (raw === '') return undefined
      heredocs.push({ delimiter: raw.replace(/["'\\]/g, ''), strips, expands: !/["'\\]/.test(raw) })
      i = at - 1
    } else if (char === '\n' && heredocs.length > 0) {
      end()
      let at = i + 1
      for (const heredoc of heredocs.splice(0)) {
        for (;;) {
          if (at > line.length) return undefined
          const newline = line.indexOf('\n', at)
          const stop = newline === -1 ? line.length : newline
          const body = line.slice(at, stop)
          at = stop + 1
          if ((heredoc.strips ? body.replace(/^\t+/, '') : body) === heredoc.delimiter) break
          if (heredoc.expands && REUSES_LAST.test(body)) reusesLast = true
        }
      }
      i = at - 2
    } else if ((char === '<' || char === '>') && next === '(') {
      i = substitution(i + 1, '(', ')')
      if (i === -1) return undefined
    } else if (char === '<' || char === '>') {
      if (isWord && /^\d+$/.test(text)) isWord = false
      end()
      while (i + 1 < line.length && '<>&|'.includes(line[i + 1] as string)) i++
      isTarget = true
    } else if (char === '(') {
      if (closeAt !== -1 && closeAt < i) closeAt = line.indexOf(')', i)
      if (pipeDotAt !== -1 && pipeDotAt < i) pipeDotAt = line.indexOf('|.', i)
      const after = closeAt === -1 ? '' : (line[closeAt + 1] ?? '')
      const isAttached = isWord || (after !== '' && !/[\s;&|<>()]/.test(after))
      const hasDotPart = next === '.' || (pipeDotAt !== -1 && (closeAt === -1 || pipeDotAt < closeAt))
      if (isAttached && (isDotSegment || after === '.' || hasDotPart)) isDotGroup = true
      if (isWord && isDotSegment) isDotGlobWord = true
      end()
    } else if (/\s/.test(char) || ';&|)'.includes(char)) end()
    else if (char === '#' && !isWord) {
      const newline = line.indexOf('\n', i)
      i = newline === -1 ? line.length : newline - 1
    } else {
      if (char === '$' && REUSES_LAST.test(line.slice(i, i + 4))) reusesLast = true
      add(char, false)
    }
  }
  if (heredocs.length > 0) return undefined
  end()
  return { words, targets, subWords, subTargets, isDotGroup, isSubBroken, reusesLast }
}

type WordFlags = { words: boolean[]; targets: boolean[] }
type LineFlags = { flags: Map<Statement, WordFlags>; reusesLast: boolean; isDotglobLine: boolean; isDotGroup: boolean }

const fromText = (text: string, isDotglob: boolean): boolean => isDotGlob(text) || (isDotglob && hasPatternChar(text))
const LOOSE_DOT_GROUP = /[(|)]\.|\.[^\s().]*\(/

function flagsOf(parse: ShellParse, line: string): LineFlags {
  const isDotglob = isDotglobLine(line)
  const quoting = quotingOf(line)
  const flags = new Map<Statement, WordFlags>()
  const targetsOf = (s: Statement): string[] => s.redirects.filter(r => r.isReal && r.op !== '<<' && r.op !== '<<-').map(r => r.target)
  for (const s of parse.statements) flags.set(s, { words: s.words.map(word => fromText(word, isDotglob)), targets: targetsOf(s).map(target => fromText(target, isDotglob)) })
  const fallback: LineFlags = { flags, reusesLast: REUSES_LAST.test(line), isDotglobLine: isDotglob, isDotGroup: quoting?.isDotGroup ?? LOOSE_DOT_GROUP.test(line) }
  if (quoting === undefined) return fallback
  const take = (list: readonly Lexed[], from: number, text: string): number => {
    for (let at = from; at < list.length; at++) if (list[at]?.text === text) return at
    return -1
  }
  const flag = (lexed: Lexed | undefined): boolean => lexed !== undefined && (lexed.isDotGlob || (isDotglob && lexed.isGlob))
  const cursors = { line: [0, 0], substitution: [0, 0] }
  const aligned = new Map<Statement, WordFlags>()
  for (const s of parse.statements) {
    if (s.source !== 'line' && (s.source !== 'substitution' || quoting.isSubBroken)) continue
    const [lexedWords, lexedTargets] = s.source === 'line' ? [quoting.words, quoting.targets] : [quoting.subWords, quoting.subTargets]
    const cursor = s.source === 'line' ? cursors.line : cursors.substitution
    const words: boolean[] = []
    for (const word of s.words) {
      const at = take(lexedWords, cursor[0] as number, word)
      if (at === -1) return fallback
      words.push(flag(lexedWords[at]))
      cursor[0] = at + 1
    }
    const targets: boolean[] = []
    for (const target of targetsOf(s)) {
      const at = take(lexedTargets, cursor[1] as number, target)
      if (at === -1) return fallback
      targets.push(flag(lexedTargets[at]))
      cursor[1] = at + 1
    }
    aligned.set(s, { words, targets })
  }
  for (const [s, wordFlags] of aligned) flags.set(s, wordFlags)
  return { flags, reusesLast: quoting.reusesLast, isDotglobLine: isDotglob, isDotGroup: quoting.isDotGroup }
}

const namesDotenvPath = (word: string): boolean =>
  collapsed(word)
    .split('/')
    .some(part => isDotenvBase(part) || (part.startsWith('.') && hasPatternChar(part))) || /(\$\{?[A-Za-z0-9_]+\}?|`)\.env(?![A-Za-z0-9_-])/i.test(word)

export const credentialGlobRefusal = (glob: string): string | undefined =>
  namesDotenvPath(glob) || readsDotenv(glob) || globCanMatchDotenv(glob) ? credential('a .env file', `: ${glob}`) : undefined

// The one heredoc shape a body is text in, an allowlist: a plain `cat`, with
// no wrapper, in a line the reader read whole, whose standard output goes to
// a literal file path that is missing or a regular file when the call is
// judged. A sandboxed run proved that shape reads no file named in its body.
// Anything else counts the body: a body fed on may reach a program that opens
// it (`xargs cat <<EOF`, `cat <<EOF | xargs cat`, `cat > >(xargs cat) <<EOF`,
// a `while read` loop, a FIFO). `tee` is left out: it writes the body to each
// file it names as well, and any of them may be a process substitution or a
// FIFO.
//
// Whether the target is a regular file is the file system's answer, so it is
// asked in hooks/register.ts: bodyTargets names the targets to ask about, and
// credentialRefusal is handed the ones that are missing or regular files.
const exemptTarget = (s: Statement, parse: ShellParse): string | undefined => {
  // The command word itself is `cat`, spelled plainly.
  if (parse.unknowns.length > 0 || !s.isPlaced || s.wrappers.length > 0 || s.words[s.nameAt] !== 'cat') return undefined
  if (s.heredocs.length === 0 || parse.statements.some(t => MAKES_SPECIAL.has(t.name))) return undefined
  const target = stdoutFile(s)
  // A relative target after a cd lands where the reader does not follow.
  if (target === undefined || (!target.startsWith('/') && !target.startsWith('~/') && changesAnyDirectory(parse))) return undefined
  return target
}

// Commands that make a FIFO, a device node or a link, which a later redirect
// in the same line could write into.
const MAKES_SPECIAL: ReadonlySet<string> = new Set(['mkfifo', 'mknod', 'ln', 'link'])

const changesAnyDirectory = (parse: ShellParse): boolean =>
  parse.statements.some(s => s.name === 'cd' || s.name === 'pushd' || s.name === 'popd' || changesDirectory(s))

// The literal targets of the heredocs that may be exempt, for the caller to
// stat. Each is exempt only when the caller finds it missing or a regular file.
export const bodyTargets = (parse: ShellParse): string[] =>
  [...new Set(parse.statements.flatMap(s => exemptTarget(s, parse) ?? []))]

// A literal file path: no expansion, substitution or process substitution
// (`$X`, `"$X"`, a backtick, the `$_` a substitution leaves), no glob
// character, and nothing under /dev/ but /dev/null, which the stat in
// hooks/register.ts then drops as no regular file.
const isLiteralFile = (target: string): boolean => target !== '' && !/[$`*?[\]{}]/.test(target) && !isDevice(target)

// Where standard output goes, as bash reads the redirects: left to right, the
// last one on fd 1 wins. Undefined unless it lands on a literal file path: a
// redirect that duplicates, closes or moves a descriptor (`>&`, `<&`, `&>`,
// `<>` on fd 1) gives the shape up.
function stdoutFile(s: Statement): string | undefined {
  let file: string | undefined
  for (const r of s.redirects) {
    if (!r.isReal) continue
    if (r.op === '>&' || r.op === '<&' || r.op === '&>' || r.op === '&>>') return undefined
    const isStdout = r.fd === '' || r.fd === '1'
    if (r.op === '<>' && r.fd === '1') return undefined
    if (isStdout && (r.op === '>' || r.op === '>>' || r.op === '>|')) file = r.target
  }
  return file !== undefined && isLiteralFile(file) ? file : undefined
}

// A target under /dev/ is no file: /dev/stdout, /dev/fd/1 and /dev/tty send
// the body on, where a pipe or a terminal may read it. /dev/null keeps
// nothing, but it is no regular file either, so the stat drops it too.
const isDevice = (target: string): boolean => {
  const path = collapsed(target).toLowerCase()
  return /^\/+dev(\/|$)/.test(path) && !/^\/+dev\/null$/.test(path)
}

// The refusal for a Bash line, or undefined.
// `regularTargets` holds the bodyTargets the caller found missing or regular
// files; with none given, no heredoc body is exempt.
export function credentialRefusal(
  line: string,
  home: string | undefined,
  parse: ShellParse = parseShell(line),
  regularTargets: ReadonlySet<string> = new Set(),
): string | undefined {
  const texts = textsOf(parse).map(collapsed)
  const dirs = homeDirsRe(home)
  const hasReader = texts.some(text => READER.test(text))
  if (hasReader) {
    if (texts.some(text => dirs.test(text))) return credential('a protected credential folder (~/.ssh, ~/.aws, ~/.gnupg)', '')
    if (texts.some(text => KEYCHAINS.test(text))) return credential('a macOS keychain folder', '')
    if (texts.some(text => CLAUDE_CREDENTIALS.test(text))) return credential("Claude's credential store", '')
  }
  const { flags, reusesLast, isDotglobLine: isDotglob, isDotGroup } = flagsOf(parse, line)
  const feedsArgs = parse.statements.some(s => ARG_FEEDERS.has(s.name) || s.wrappers.some(w => ARG_FEEDERS.has(w)))
  const units: [string, boolean][] = []
  const dropped: [string, boolean][] = []
  for (const s of parse.statements) {
    const words = pathWords(s, parse, line)
    const isText = readsMessageInput(s, parse) || readsText(s, parse)
    const wordFlags = flags.get(s)
    const isExpanding = (at: number): boolean => wordFlags?.words[at] ?? true
    const targets = s.redirects.filter(r => r.isReal && r.op !== '<<' && r.op !== '<<-')
    units.push(
      ...words.kept.map((at): [string, boolean] => [s.words[at] as string, isExpanding(at)]),
      ...targets.flatMap((r, at): [string, boolean][] => (isText && r.op === '<<<' ? [] : [[r.target, wordFlags?.targets[at] ?? true]])),
      ...(isText || regularTargets.has(exemptTarget(s, parse) ?? '\u0000') ? [] : s.heredocs.flatMap(h => piecesOf(h.body)).map((piece): [string, boolean] => [piece, feedsArgs && fromText(piece, isDotglob)])),
    )
    dropped.push(...words.dropped.map((at): [string, boolean] => [s.words[at] as string, isExpanding(at)]))
  }
  const reads = ([word, isDotGlobWord]: [string, boolean]): boolean => isDotGlobWord || readsDotenv(collapsed(word))
  const isDotenvLine =
    units.some(reads) ||
    (reusesLast && dropped.some(reads)) ||
    parse.statements.some(s => programGlobs(s, parse, line).some(globCanMatchDotenv)) ||
    isDotGroup ||
    DOT_RANGE.test(line) ||
    hasTemplateGroup(collapsed(line))
  if (isDotenvLine) return credential('a .env file', '')
  const isSubject = texts.some(text => dirs.test(text) || KEYCHAINS.test(text) || CLAUDE_CREDENTIALS.test(text) || readsDotenv(text) || isDotGlob(text))
  if (isSubject && line.length > MAX_INPUT) return credential('a credential path in a command longer than 200,000 characters', '')
  if (isSubject && isPartlyRead(parse)) return credential('a credential path', `. ${unreadNote}`)
  return undefined
}

// ─── whole-disk search ───────────────────────────────────────────────────────

// One place a search command searches: its path, or undefined when the word
// cannot be resolved (a variable, a substitution, a glob, `~user`), and where
// the path lands once its symbolic links are followed, when known.
export type SearchRoot = { tool: string; word: string; path: string | undefined; real?: string }

const SEARCH_TOOLS: ReadonlySet<string> = new Set(['find', 'gfind', 'bfs', 'fd', 'fdfind', 'rg', 'ag', 'ack', 'grep', 'egrep', 'fgrep', 'ggrep', 'mdfind'])
const SEARCH_WORD = new RegExp(`(?<![A-Za-z0-9_])(${[...SEARCH_TOOLS].join('|')})(?![A-Za-z0-9_])`)

// The absolute, normalized path of `word`, or undefined.
export function resolvePath(word: string, cwd: string | undefined, home: string | undefined): string | undefined {
  if (word === '' || /[$`*?[\]{}]/.test(word)) return undefined
  let path: string
  if (word === '~' || word.startsWith('~/')) {
    if (home === undefined || !home.startsWith('/')) return undefined
    path = home + word.slice(1)
  } else if (word.startsWith('~')) return undefined
  else if (word.startsWith('/')) path = word
  else if (cwd === undefined) return undefined
  else path = `${cwd}/${word}`
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

// The roots too broad to search: the whole disk, every home, this home, its
// Library, the system's own trees, and a mounted volume's root. Each is matched exactly, without regard
// to case, after `//`, `/./` and `..` are taken out: a search under one of
// them, such as another repository or the plugin cache, is narrow enough.
const BROAD_ROOTS = ['/', '/users', '/system', '/library', '/applications', '/volumes', '/private', '/private/var', '/var', '/opt', '/usr']

export function isBroadRoot(path: string, home: string | undefined): boolean {
  const flat = (p: string): string => (resolvePath(p, '/', undefined) ?? p).toLowerCase()
  const p = flat(path)
  const h = home !== undefined && home.startsWith('/') ? flat(home) : undefined
  // A mounted volume's own root is a whole disk too.
  const isVolume = /^\/volumes\/[^/]+$/.test(p)
  return BROAD_ROOTS.includes(p) || isVolume || (h !== undefined && (p === h || p === `${h === '/' ? '' : h}/library`))
}

// Options that take the next word as their value, by tool. Short letters in a
// string, long names in a list. An option not listed is read as a flag, so
// its value, if it had one, is read as a pattern or a path: never the root
// left out.
type Options = { short: string; long: readonly string[] }
const RG: Options = {
  short: 'efgtTmABCjMEr',
  long: [
    'regexp', 'file', 'glob', 'iglob', 'type', 'type-not', 'type-add', 'type-clear', 'max-count', 'after-context', 'before-context', 'context',
    'threads', 'max-columns', 'max-depth', 'maxdepth', 'encoding', 'engine', 'colors', 'color', 'sort', 'sortr', 'path-separator', 'replace',
    'pre', 'pre-glob', 'max-filesize', 'dfa-size-limit', 'regex-size-limit', 'ignore-file', 'context-separator',
  ],
}
const GREP: Options = { short: 'efmABCdD', long: ['regexp', 'file', 'max-count', 'after-context', 'before-context', 'context', 'include', 'exclude', 'exclude-dir', 'exclude-from', 'directories', 'devices', 'label', 'binary-files'] }
const FD: Options = {
  short: 'etEdcjSo',
  long: [
    'extension', 'type', 'exclude', 'max-depth', 'min-depth', 'exact-depth', 'color', 'threads', 'size', 'changed-within', 'changed-before',
    'owner', 'path-separator', 'max-results', 'ignore-file', 'format', 'max-buffer-time', 'batch-size', 'and',
  ],
}
const AG: Options = { short: 'mABCGgp', long: ['max-count', 'after', 'before', 'context', 'file-search-regex', 'ignore', 'ignore-dir', 'path-to-ignore', 'depth', 'pager'] }
const GIT_GREP: Options = { short: GREP.short, long: [...GREP.long, 'max-depth', 'threads'] }
const PATTERN_TOOLS: ReadonlyMap<string, Options> = new Map([
  ['grep', GREP],
  ['egrep', GREP],
  ['fgrep', GREP],
  ['ggrep', GREP],
  ['rg', RG],
  ['ag', AG],
  ['ack', AG],
])
const COMMIT: Options = {
  short: 'mFCct',
  long: ['message', 'file', 'reuse-message', 'reedit-message', 'template', 'author', 'date', 'fixup', 'squash', 'cleanup', 'trailer', 'pathspec-from-file'],
}
const TEXT_REDIRECTS: ReadonlySet<string> = new Set(['<<', '<<-', '<<<'])
const ARG_FEEDERS: ReadonlySet<string> = new Set(['xargs', 'parallel', 'read', 'mapfile', 'readarray'])

const subcommandOf = (s: Statement): string | undefined => (s.name === 'git' && s.subcommandAt !== -1 ? s.args[s.subcommandAt] : undefined)

function patternsOf(s: Statement): { patterns: string[]; at: number[]; isGiven: boolean } {
  const isGitGrep = subcommandOf(s) === 'grep'
  const options = isGitGrep ? GIT_GREP : PATTERN_TOOLS.get(s.name)
  if (options === undefined) return { patterns: [], at: [], isGiven: false }
  const base = s.nameAt + 1 + (isGitGrep ? s.subcommandAt + 1 : 0)
  const { operands, operandAt, values, valueAt } = operandsOf(s.args.slice(base - s.nameAt - 1), options, [], [], true)
  const given = [...(values.e ?? []), ...(values.regexp ?? [])]
  const givenAt = [...(valueAt.e ?? []), ...(valueAt.regexp ?? [])]
  const isGiven = given.length > 0 || values.f !== undefined || values.file !== undefined
  const patterns = isGiven ? given : operands.slice(0, 1)
  return { patterns, at: (isGiven ? givenAt : operandAt.slice(0, 1)).map(at => base + at), isGiven }
}

const commitOperands = (s: Statement, parse: ShellParse): Operands | undefined =>
  subcommandOf(s) === 'commit' && s.isPlaced && s.source === 'line' && parse.feeds.length === 0 ? operandsOf(s.args.slice(s.subcommandAt + 1), COMMIT, [], [], true) : undefined

const commitValues = (s: Statement, parse: ShellParse): Record<string, string[]> | undefined => commitOperands(s, parse)?.values

function pathWords(s: Statement, parse: ShellParse, line: string): { kept: number[]; dropped: number[] } {
  const commit = commitOperands(s, parse)
  const commitBase = s.nameAt + s.subcommandAt + 2
  const messageAt = [...(commit?.valueAt.m ?? []), ...(commit?.valueAt.message ?? [])].map(at => commitBase + at)
  const { patterns, at: patternAt, isGiven } = patternsOf(s)
  const droppedAt = new Set([...messageAt, ...patternAt.filter((_, n) => isGiven || !namesDotenvPath(patterns[n] as string))])
  const inert = inertWords(s, parse, line)
  const kept: number[] = []
  const dropped: number[] = []
  s.words.forEach((word, index) => {
    const at = droppedAt.has(index) ? -1 : inert.indexOf(word)
    if (!droppedAt.has(index) && at === -1) kept.push(index)
    else {
      if (at !== -1) inert.splice(at, 1)
      dropped.push(index)
    }
  })
  return { kept, dropped }
}

const FIND_ACTIONS_OK: ReadonlySet<string> = new Set(['-print', '-print0'])
const ARCHIVERS: ReadonlySet<string> = new Set(['tar', 'gtar', 'bsdtar', 'rsync', 'zip'])

const EXCLUDES = /^(--exclude[a-z-]*|--filter|-X|-x)$/

function programGlobs(s: Statement, parse: ShellParse, line: string): string[] {
  if (s.name === 'git' && s.subcommandAt !== -1) {
    const after = s.nameAt + s.subcommandAt + 2
    const { at: patternAt } = patternsOf(s)
    return pathWords(s, parse, line)
      .kept.filter(at => at >= after && !patternAt.includes(at))
      .map(at => s.words[at] as string)
      .filter(word => !word.startsWith('-') && !/^:(!|\^|\(exclude)/.test(word))
  }
  if (s.name === 'find' || s.name === 'gfind' || s.name === 'bfs') {
    const hasAction = s.args.some(arg => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|printf|fls|ls|quit)$/.test(arg) && !FIND_ACTIONS_OK.has(arg))
    return hasAction ? s.args.filter((_, at) => at > 0 && FIND_PATTERNS.has(s.args[at - 1] as string)) : []
  }
  if (s.name === 'rg') {
    const { values } = operandsOf(s.args, RG, [], [], true)
    return [...(values.g ?? []), ...(values.glob ?? []), ...(values.iglob ?? [])].filter(glob => !glob.startsWith('!'))
  }
  if (['grep', 'ggrep', 'egrep', 'fgrep'].includes(s.name)) return operandsOf(s.args, GREP, [], [], true).values.include ?? []
  if (ARCHIVERS.has(s.name)) {
    return s.args.filter((arg, at) => !EXCLUDES.test(arg) && !EXCLUDES.test(s.args[at - 1] ?? '') && !/^--(exclude|filter)[a-z-]*=/.test(arg)).map(arg => arg.replace(/^-[^=]*=/, ''))
  }
  return []
}

const LS_FLAGS = /^-[@1ABCFGHLOPRSTUWabcdefghiklmnopqrstuvwxy]+$/
const STAT_FLAGS = /^-[FLlnqrsx]+$/
const ECHO_FLAGS = /^-[neE]+$/
const FILE_TESTS: ReadonlySet<string> = new Set(['-e', '-f', '-d', '-r', '-s', '-L', '-h', '-w', '-x', '-b', '-c', '-p', '-S', '-O', '-G', '-N'])
const TEST_NAMES: ReadonlySet<string> = new Set(['test', '[', '[['])
const FIND_PATTERNS: ReadonlySet<string> = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename'])
const FIND_VALUES: ReadonlySet<string> = new Set(['-type', '-maxdepth', '-mindepth'])
const FIND_WORDS: ReadonlySet<string> = new Set(['-print', '-print0', '-prune', '-not', '!', '(', ')', '-o', '-or', '-a', '-and'])
const GIT_INERT: ReadonlyMap<string, RegExp> = new Map([
  ['rm', /^(-[nqr]+|--(cached|dry-run|quiet)|--)$/],
  ['check-ignore', /^(-[qvn]+|--(quiet|verbose|non-matching|no-index)|--)$/],
])
const SHADOWERS: ReadonlySet<string> = new Set(['function', 'alias', 'hash', 'enable', 'builtin', 'command'])
const DEFINES_FUNCTION = /\(\s*\)|(^|[\s;&|({])function\s/

const isQuietLine = (s: Statement, parse: ShellParse, line: string): boolean =>
  s.source === 'line' &&
  s.isPlaced &&
  s.wrappers.length === 0 &&
  !(s.words[s.nameAt] ?? '/').includes('/') &&
  parse.feeds.length === 0 &&
  s.redirects.every(r => !r.isReal) &&
  !DEFINES_FUNCTION.test(line) &&
  parse.statements.every(
    t => t.source === 'line' && t.assignments.length === 0 && !SHADOWERS.has(t.name) && !ARG_FEEDERS.has(t.name) && !t.wrappers.some(w => ARG_FEEDERS.has(w)),
  )

function operandsAfter(args: readonly string[], flags: RegExp, valued: readonly string[] = []): string[] | undefined {
  const operands: string[] = []
  for (let i = 0, isEnd = false; i < args.length; i++) {
    const arg = args[i] as string
    if (isEnd || !arg.startsWith('-') || arg === '-') operands.push(arg)
    else if (arg === '--') isEnd = true
    else if (valued.includes(arg)) i++
    else if (!flags.test(arg)) return undefined
  }
  return operands
}

function testOperands(args: readonly string[]): string[] | undefined {
  const operands: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (FILE_TESTS.has(arg) && i + 1 < args.length) operands.push(args[++i] as string)
    else if (arg !== '!' && arg !== ']' && arg !== ']]') return undefined
  }
  return operands
}

function findPatterns(args: readonly string[]): string[] | undefined {
  const patterns: string[] = []
  let i = 0
  while (i < args.length && /^-[HLP]$/.test(args[i] as string)) i++
  while (i < args.length && !/^[-!(]/.test(args[i] as string)) i++
  for (; i < args.length; i++) {
    const arg = args[i] as string
    if (FIND_PATTERNS.has(arg) && i + 1 < args.length) patterns.push(args[++i] as string)
    else if (FIND_VALUES.has(arg)) i++
    else if (!FIND_WORDS.has(arg)) return undefined
  }
  return patterns
}

function inertWords(s: Statement, parse: ShellParse, line: string): string[] {
  if (!isQuietLine(s, parse, line)) return []
  const sub = subcommandOf(s)
  if (sub !== undefined) {
    const flags = GIT_INERT.get(sub)
    const globals = s.args.slice(0, s.subcommandAt)
    const rest = s.args.slice(s.subcommandAt + 1)
    const options = rest.includes('--') ? rest.slice(0, rest.indexOf('--')) : rest
    const isPlain = globals.length % 2 === 0 && globals.every((arg, i) => i % 2 === 1 || arg === '-C')
    if (flags === undefined || !isPlain || (sub === 'rm' && !options.includes('--cached'))) return []
    return operandsAfter(rest, flags) ?? []
  }
  if (s.name === 'ls') return operandsAfter(s.args, LS_FLAGS) ?? []
  if (s.name === 'stat') return operandsAfter(s.args, STAT_FLAGS, ['-f', '-t']) ?? []
  if (TEST_NAMES.has(s.name)) return testOperands(s.args) ?? []
  if (s.name === 'find') return findPatterns(s.args) ?? []
  if (s.name === 'echo') return (operandsAfter(s.args, ECHO_FLAGS) ?? []).filter(word => /\s/.test(word))
  if (s.name === 'printf' && !(s.args[0] ?? '-').startsWith('-')) return s.args.filter(word => /\s/.test(word))
  return []
}

const GH_BODY_SUBCOMMANDS: ReadonlySet<string> = new Set(['pr', 'issue', 'release'])

function readsText(s: Statement, parse: ShellParse): boolean {
  if (s.source !== 'line' || !s.isPlaced || s.wrappers.length > 0 || parse.feeds.length > 0) return false
  if (parse.statements.some(t => ARG_FEEDERS.has(t.name) || t.wrappers.some(w => ARG_FEEDERS.has(w)))) return false
  if (s.name === 'wc') return s.args.every(arg => /^-[clmwL]+$/.test(arg))
  if (s.name === 'pbcopy') return s.args.length === 0
  if (s.name !== 'gh' || !GH_BODY_SUBCOMMANDS.has(s.args[s.subcommandAt] ?? '')) return false
  return s.args.some((arg, i) => ((arg === '--body-file' || arg === '--notes-file' || arg === '-F') && s.args[i + 1] === '-') || arg === '--body-file=-' || arg === '--notes-file=-')
}

function readsMessageInput(s: Statement, parse: ShellParse): boolean {
  const values = commitValues(s, parse)
  const isStdin = [...(values?.F ?? []), ...(values?.file ?? [])].includes('-')
  const inputs = s.redirects.filter(r => r.isReal && (r.fd === '' || r.fd === '0') && r.op.startsWith('<'))
  return isStdin && inputs.length === 1 && TEXT_REDIRECTS.has(inputs[0]?.op ?? '') && s.heredocs.length <= 1
}

// The words that are not options or option values, and the values of the
// options in `wanted`.
type Operands = { operands: string[]; values: Record<string, string[]>; flags: Set<string>; operandAt: number[]; valueAt: Record<string, number[]> }

function operandsOf(args: readonly string[], options: Options, wanted: readonly string[] = [], stops: readonly string[] = [], abbreviates = false): Operands {
  const operands: string[] = []
  const operandAt: number[] = []
  const values: Record<string, string[]> = {}
  const valueAt: Record<string, number[]> = {}
  const flags = new Set<string>()
  const add = (name: string, value: string, at: number) => {
    ;(values[name] ??= []).push(value)
    ;(valueAt[name] ??= []).push(at)
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--') {
      operands.push(...args.slice(i + 1))
      operandAt.push(...args.slice(i + 1).map((_, n) => i + 1 + n))
      break
    }
    if (arg.startsWith('--')) {
      const [name = '', value] = arg.slice(2).split(/=(.*)/s)
      if (stops.includes(name)) break
      flags.add(name)
      const known = [...options.long, ...wanted]
      const matches = known.includes(name) || !abbreviates ? [name].filter(option => known.includes(option)) : known.filter(option => name !== '' && option.startsWith(name))
      if (matches.length === 1) add(matches[0] as string, value ?? (args[++i] ?? ''), i)
      continue
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        const letter = arg[j] as string
        if (stops.includes(letter)) return { operands, values, flags, operandAt, valueAt }
        flags.add(letter)
        if (options.short.includes(letter)) {
          add(letter, j < arg.length - 1 ? arg.slice(j + 1) : (args[++i] ?? ''), i)
          break
        }
      }
      continue
    }
    operands.push(arg)
    operandAt.push(i)
  }
  return { operands, values, flags, operandAt, valueAt }
}

// The places one search statement searches, as words, and the directory it
// runs in when that changes (fd's --base-directory). Undefined when the
// statement is no search.
function searchWords(statement: Statement): { words: string[]; base?: string; tool: string } | undefined {
  const { name, args } = statement
  if (name === 'find' || name === 'gfind' || name === 'bfs') {
    const words: string[] = []
    let i = 0
    for (; i < args.length; i++) {
      const arg = args[i] as string
      if (arg === '--') continue
      if (/^-[HLPEXdsx]+$/.test(arg) || /^-O\d*$/.test(arg)) continue
      if (arg === '-D') {
        i++
        continue
      }
      if (arg === '-f') {
        words.push(args[++i] ?? '')
        continue
      }
      break
    }
    for (; i < args.length; i++) {
      const arg = args[i] as string
      if (arg.startsWith('-') || arg === '(' || arg === '!' || arg === ')' || arg === ',') break
      words.push(arg)
    }
    return { words: words.length > 0 ? words : ['.'], tool: name }
  }
  if (name === 'fd' || name === 'fdfind') {
    const { operands, values } = operandsOf(args, FD, ['search-path', 'base-directory'], ['x', 'X', 'exec', 'exec-batch'])
    const words = [...operands.slice(1), ...(values['search-path'] ?? [])]
    const base = values['base-directory']?.at(-1)
    return { words: words.length > 0 ? words : ['.'], tool: name, ...(base !== undefined ? { base } : {}) }
  }
  if (name === 'rg') {
    const { operands, values, flags } = operandsOf(args, RG)
    const patternGiven = ['e', 'f', 'regexp', 'file'].some(k => values[k] !== undefined) || flags.has('files') || flags.has('type-list')
    const words = patternGiven ? operands : operands.slice(1)
    return { words: words.length > 0 ? words : ['.'], tool: name }
  }
  if (name === 'ag' || name === 'ack') {
    const { operands, values } = operandsOf(args, AG)
    const words = values.g !== undefined || values.G !== undefined ? operands : operands.slice(1)
    return { words: words.length > 0 ? words : ['.'], tool: name }
  }
  if (name === 'grep' || name === 'egrep' || name === 'fgrep' || name === 'ggrep') {
    const { operands, values, flags } = operandsOf(args, GREP)
    if (!['r', 'R', 'recursive', 'dereference-recursive'].some(f => flags.has(f)) && values.d?.[0] !== 'recurse' && values.directories?.[0] !== 'recurse') return undefined
    const words = values.e !== undefined || values.f !== undefined || values.regexp !== undefined || values.file !== undefined ? operands : operands.slice(1)
    return { words: words.length > 0 ? words : ['.'], tool: name }
  }
  if (name === 'mdfind') {
    const words: string[] = []
    for (let i = 0; i < args.length; i++) if (args[i] === '-onlyin') words.push(args[++i] ?? '')
    // No -onlyin searches every indexed volume.
    return { words: words.length > 0 ? words : ['/'], tool: name }
  }
  return undefined
}

// Whether a wrapper before the command changes its directory (`env -C dir`,
// `sudo -D dir`), which the reader does not follow.
const changesDirectory = (statement: Statement): boolean =>
  statement.wrappers.length > 0 && statement.words.slice(0, Math.max(statement.nameAt, 0)).some(word => /^(-[A-Za-z]*[CD]|--ch)/.test(word))

export function statementsAt(parse: ShellParse, cwd: string, home: string | undefined): { statement: Statement; dir: string | undefined }[] {
  const placed: { statement: Statement; dir: string | undefined }[] = []
  let dir: string | undefined = cwd
  for (const statement of parse.statements) {
    if (statement.name === 'cd' || statement.name === 'pushd') {
      const target = statement.args.find(a => !a.startsWith('-') || a === '-')
      dir = target === undefined ? home : target === '-' ? undefined : resolvePath(target, dir, home)
      continue
    }
    if (statement.name === 'popd') {
      dir = undefined
      continue
    }
    placed.push({ statement, dir: changesDirectory(statement) ? undefined : dir })
  }
  return placed
}

export function searchRoots(parse: ShellParse, cwd: string, home: string | undefined): SearchRoot[] {
  const roots: SearchRoot[] = []
  for (const { statement, dir } of statementsAt(parse, cwd, home)) {
    const search = searchWords(statement)
    if (search === undefined) continue
    const at = search.base !== undefined ? resolvePath(search.base, dir, home) : dir
    for (const word of search.words) roots.push({ tool: search.tool, word, path: resolvePath(word, at, home) })
  }
  return roots
}

// Whether the line holds a search command, or a word naming one, so a line
// the reader could not read whole is refused.
export const mentionsSearch = (parse: ShellParse): boolean => textsOf(parse).some(text => SEARCH_WORD.test(text))

const SEARCH_ADVICE =
  'A search that wide can run for an hour and load the whole machine. Search a narrower folder: the project, the folder the file belongs to, or a scratch root. If you do not know where the file lives, stop and ask Mike.'

// The refusal for the roots of a line or a tool call, or undefined: a root
// that cannot be resolved, or one that is, or lands on, a broad root.
export function searchRefusal(roots: readonly SearchRoot[], home: string | undefined): string | undefined {
  for (const root of roots) {
    if (root.path === undefined) {
      return `Whole-disk search guard (workbench-core): ${root.tool} searches ${root.word}, which is a variable, a substitution, a glob or another user's home, so this guard cannot tell where it searches. Write the path out in full. ${SEARCH_ADVICE}`
    }
    const broad = [root.path, root.real].find(path => path !== undefined && isBroadRoot(path, home))
    if (broad !== undefined) {
      return `Whole-disk search guard (workbench-core): ${root.tool} searches ${broad}, which is the whole disk, a home folder, a Library folder or a system tree. ${SEARCH_ADVICE}`
    }
  }
  return undefined
}

// The roots a Grep or Glob call searches: its path, or the working directory
// when it names none. For Glob, also where its pattern starts, read from that
// directory: the text before the first glob character, so `../../**` and
// `/**` are judged where they land. A brace that comes first is judged once
// for each alternative, and one that cannot be resolved (a
// variable, a nested brace) is unresolvable.
export function toolSearchRoots(tool: 'Grep' | 'Glob', input: { path?: unknown; pattern?: unknown }, cwd: string, home: string | undefined): SearchRoot[] {
  const path = typeof input.path === 'string' && input.path !== '' ? input.path : undefined
  const base = path === undefined ? resolvePath(cwd, '/', home) : resolvePath(path, cwd, home)
  const roots: SearchRoot[] = [{ tool, word: path ?? cwd, path: base }]
  if (tool === 'Glob' && typeof input.pattern === 'string') {
    for (const word of patternStarts(input.pattern)) {
      const at = word === undefined || base === undefined ? undefined : resolvePath(word === '' ? '.' : word, base, home)
      roots.push({ tool, word: word ?? input.pattern, path: at })
    }
  }
  return roots
}

// Where each alternative of a glob pattern starts: the folder part of its text
// before the first glob character. Undefined for one that cannot be read.
function patternStarts(pattern: string): (string | undefined)[] {
  // A brace before the first other glob character, at the start or after a
  // fixed prefix (`x/{../..}/**`), is expanded, so a `..` in it is resolved.
  const open = pattern.search(/[*?[{]/)
  if (open !== -1 && pattern[open] === '{') {
    const close = pattern.indexOf('}', open)
    const inner = close === -1 ? '' : pattern.slice(open + 1, close)
    if (close === -1 || inner.includes('{')) return [undefined]
    return inner.split(',').flatMap(alternative => patternStarts(pattern.slice(0, open) + alternative + pattern.slice(close + 1)))
  }
  const fixed = pattern.slice(0, pattern.search(/[*?[{]|$/))
  const start = fixed.slice(0, fixed.lastIndexOf('/') + 1)
  return [start.includes('$') || start.includes('`') ? undefined : start]
}

export const SEARCH_UNREAD = `Whole-disk search guard (workbench-core): ${unreadNote} Write the search out plainly, with its path in full. ${SEARCH_ADVICE}`

export { GUARD_FAILED } from './guard-failed.ts'
