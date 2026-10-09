// The five guards that run in the hooks module, as pure functions. Each reads a
// tool call and answers with a refusal, or undefined to let the call go on.
// hooks/register.ts calls them from its tool.call hook, before the call runs.
//
//   peer message      a sub-agent's SendMessage goes to "main" or to an agent
//                     id, and nowhere else
//   provisioning      no agent creates a git worktree or a database, or deletes
//                     a worktree: Bash, Agent with isolation "worktree",
//                     EnterWorktree, and ExitWorktree with action "remove"
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
import { SHELLS, nameOf, parseShell, shellScriptOf } from './shell'

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
// substitution, a wrapper option it cannot place, or a script piped into a
// shell. Every guard refuses such a line, whatever it mentions, because the
// command it hides may be any guard's subject. Other unknowns (an unclosed
// quote, an escape the reader does not decode) refuse only where the line
// names a guard's subject.
export function hiddenCommandRefusal(parse: ShellParse): string | undefined {
  const why = parse.unknowns.includes('expansion')
    ? 'a command name comes from a variable or a substitution'
    : parse.unknowns.includes('stdin')
      ? 'a script is piped or fed into a shell'
      : parse.unknowns.includes('wrapper') || parse.statements.some(s => !s.isPlaced)
        ? 'a wrapper carries an option the reader does not know, so the command after it is a guess'
        : undefined
  if (why === undefined) return undefined
  return (
    `Workbench guards (workbench-core): the shell reader cannot tell which command this line runs: ${why}. ` +
    'Write each command name out plainly, with no variable or substitution in it, and run a script with bash -c or as a file instead of piping it into a shell. ' +
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

const PROVISIONING_TAIL =
  'The worktrees and databases on this machine are made by hand, and they are where you are meant to work. ' +
  'Work in the directory you were given. If a new worktree or database is really needed, stop and ask Mike, who runs the command himself with the ! prefix. ' +
  'Read-only commands still run: git worktree list, psql -c "SELECT ...", mysqladmin status.'

const provisioning = (action: string, advice: string): string => `Provisioning guard (workbench-core): ${action}. ${advice} ${PROVISIONING_TAIL}`

export const ENTER_WORKTREE_REFUSAL = provisioning(
  'EnterWorktree creates a git worktree or moves this session into one',
  'Do not call EnterWorktree.',
)
export const EXIT_WORKTREE_REFUSAL = provisioning(
  'ExitWorktree with action "remove" deletes this session\'s worktree and its branch',
  'Exit with action "keep" instead: it leaves the worktree and the branch on disk.',
)
export const AGENT_WORKTREE_REFUSAL = provisioning(
  'an Agent dispatch with isolation "worktree" makes the harness create a git worktree for the sub-agent',
  'Dispatch without isolation, so the sub-agent works in the tree you are in, or pass cwd with a directory that already exists.',
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
  if (found !== undefined) return provisioning(found, 'Do not create or delete it yourself.')
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

// ─── credential ──────────────────────────────────────────────────────────────

const CREDENTIAL_ADVICE =
  'Work without it. If the task really needs this file, stop and ask Mike: he runs the step himself with the ! prefix. ' +
  'Never link, copy or read a keychain or a credential to make a run authenticate, and never run the same read through another program to get around this guard.'

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
// `.env` and `.env.production`, never `.envrc`, in any case. In a Bash word,
// `$.env` (the hooks module's own `$.env.get`) is code, not a file.
const DOTENV = /\.env(?![A-Za-z0-9_-])/i
const DOTENV_WORD = /(?<!\$)\.env(?![A-Za-z0-9_-])/i
const TEMPLATE = /\.env[^/]*\.(example|sample|template|dist|defaults?)$/i
// The keychain commands that read a secret out: Claude's own credentials sit
// in the login keychain on macOS.
const SECRET_READS: ReadonlySet<string> = new Set(['find-generic-password', 'find-internet-password', 'dump-keychain', 'export', 'export-item'])

// Programs that read file contents, or link or copy a file. A protected path
// alone does not refuse: `ls ~/.ssh` lists names and shows no secret.
const READERS = [
  'cat', 'head', 'tail', 'less', 'more', 'strings', 'xxd', 'hexdump', 'od', 'base64', 'nl', 'tac', 'rev',
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'awk', 'gawk', 'sed', 'jq', 'yq', 'cut', 'paste', 'sort', 'uniq', 'diff',
  'cp', 'mv', 'scp', 'rsync', 'tar', 'zip', 'gzip', 'curl', 'wget', 'nc', 'ncat', 'openssl', 'gpg', 'dd', 'tee',
  'python', 'python3', 'node', 'bun', 'deno', 'php', 'ruby', 'perl', 'sqlite3', 'plutil', 'security',
  'ssh-keygen', 'ssh-add', 'vim', 'nvim', 'nano', 'emacs', 'code', 'open',
  // Beyond the bash guard: what links or copies a folder.
  'ln', 'link', 'ditto', 'install', 'cpio',
]
const READER = new RegExp(`(?<![A-Za-z0-9_])(${READERS.map(escapeRegExp).join('|')})(?![A-Za-z0-9_])`)
// The refusal for a path a file tool names, or undefined.
export function credentialPathRefusal(raw: string, home: string | undefined): string | undefined {
  const path = collapsed(raw)
  if (homeDirsRe(home).test(path)) return credential('a protected credential folder (~/.ssh, ~/.aws, ~/.gnupg)', `: ${path}`)
  if (KEYCHAINS.test(path)) return credential('a macOS keychain folder', `: ${path}`)
  if (CLAUDE_CREDENTIALS.test(path)) return credential("Claude's credential store", `: ${path}`)
  if (DOTENV.test(path) && !TEMPLATE.test(path)) return credential('a .env file', `: ${path}`)
  return undefined
}

// A Bash word that names a real dotenv file: no whitespace in it (a sentence
// about one is a word full of spaces), not `$.env`, and no committed template.
const readsDotenv = (word: string): boolean => DOTENV_WORD.test(word) && !/\s/.test(word) && !TEMPLATE.test(word)

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

// `security -i`, or `-p`, which implies it, reads its subcommands from its input.
const isInteractiveSecurity = (s: Statement): boolean => {
  for (const arg of s.args) {
    if (!arg.startsWith('-')) return false
    if (/^-[A-Za-z]*[ip]/.test(arg)) return true
  }
  return s.args.length === 0
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
  const security = parse.statements.find(s => s.name === 'security' && (s.args.some(a => SECRET_READS.has(a)) || isInteractiveSecurity(s)))
  if (security !== undefined) return credential('a secret in the macOS keychain', ' through security')
  const hasReader = texts.some(text => READER.test(text))
  if (hasReader) {
    if (texts.some(text => dirs.test(text))) return credential('a protected credential folder (~/.ssh, ~/.aws, ~/.gnupg)', '')
    if (texts.some(text => KEYCHAINS.test(text))) return credential('a macOS keychain folder', '')
    if (texts.some(text => CLAUDE_CREDENTIALS.test(text))) return credential("Claude's credential store", '')
    // A dotenv path in a word, a redirect target, or a heredoc body. Only a
    // body a plain cat or tee writes to a file is text.
    const dotenvUnits = parse.statements.flatMap(s => [
      ...s.words,
      ...s.redirects.filter(r => r.isReal).map(r => r.target),
      ...(regularTargets.has(exemptTarget(s, parse) ?? '\u0000') ? [] : s.heredocs.flatMap(h => piecesOf(h.body))),
    ])
    if (dotenvUnits.map(collapsed).some(readsDotenv)) return credential('a .env file', '')
  }
  const isSubject = texts.some(
    text =>
      dirs.test(text) ||
      KEYCHAINS.test(text) ||
      CLAUDE_CREDENTIALS.test(text) ||
      DOTENV.test(text) ||
      /(?<![A-Za-z0-9_-])security(?![A-Za-z0-9_-])/i.test(text) ||
      piecesOf(text).some(piece => SECRET_READS.has(piece)),
  )
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

// The words that are not options or option values, and the values of the
// options in `wanted`.
function operandsOf(args: readonly string[], options: Options, wanted: readonly string[] = [], stops: readonly string[] = []): { operands: string[]; values: Record<string, string[]>; flags: Set<string> } {
  const operands: string[] = []
  const values: Record<string, string[]> = {}
  const flags = new Set<string>()
  const add = (name: string, value: string) => (values[name] ??= []).push(value)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--') {
      operands.push(...args.slice(i + 1))
      break
    }
    if (arg.startsWith('--')) {
      const [name = '', value] = arg.slice(2).split(/=(.*)/s)
      if (stops.includes(name)) break
      flags.add(name)
      if (options.long.includes(name) || wanted.includes(name)) add(name, value ?? (args[++i] ?? ''))
      continue
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        const letter = arg[j] as string
        if (stops.includes(letter)) return { operands, values, flags }
        flags.add(letter)
        if (options.short.includes(letter)) {
          add(letter, j < arg.length - 1 ? arg.slice(j + 1) : (args[++i] ?? ''))
          break
        }
      }
      continue
    }
    operands.push(arg)
  }
  return { operands, values, flags }
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

// Every place the line's search commands search, with each `cd` before them
// followed. A relative root after a `cd` the reader cannot follow is
// unresolvable.
export function searchRoots(parse: ShellParse, cwd: string, home: string | undefined): SearchRoot[] {
  const roots: SearchRoot[] = []
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
    const search = searchWords(statement)
    if (search === undefined) continue
    let at = changesDirectory(statement) ? undefined : dir
    if (search.base !== undefined) at = resolvePath(search.base, at, home)
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
