// The destructive-scope guard, as pure functions. It replaces
// hooks/destructive-scope-guard.sh, frozen under tests/oracle/ as a test
// oracle. hooks/register.ts calls it from tool.call, where a target nobody
// can read is refused, and from tool.check, where a target outside every
// root is put to the permission prompt and an in-scope delete is let
// through unprompted.
//
// WHAT IT JUDGES. rm and rmdir in any spelling, and the git forms that destroy
// uncommitted work: `reset --hard`, `clean` (not a dry run), `stash clear` and
// `drop`, `restore` of the working tree, `checkout` that overwrites files,
// `switch -f` and `--discard-changes`, `rm -f`, `mv -f`, `checkout-index -f`,
// `read-tree -u --reset`, and `submodule deinit -f` and `update -f`. A git alias
// is judged by what it expands to: one set with `-c alias.x=...` on the line,
// or one in a config git is asked about.
//
// THE VERDICTS, for each destructive statement:
//   deny   the target cannot be read: a variable, a glob, a substitution, a
//          relative path after a `cd` the reader cannot follow, `find -delete`,
//          `find -exec rm`, `xargs rm`, `parallel rm`, a script handed to a
//          shell, a heredoc fed to one, or a repository moved by --git-dir,
//          --work-tree or the environment. Also the filesystem root and a
//          scope root itself.
//   ask    the target is read and lies outside the project and every scratch
//          root. Mike decided on 2026-10-06 that this is a permission prompt,
//          not a deny he must retype with `!`. Under auto mode Claude Code's
//          classifier answers the prompt, not Mike, and he accepted that on
//          2026-10-08. So the ask text addresses whoever decides. A target read
//          through `~`, or a delete behind a wrapper option, asks too, even
//          inside a root.
//   allow  every target lies inside the roots, and the line does nothing but
//          those deletes, `cd` and plain prefixes such as `sudo`.
// Anything else gets no verdict, and the ordinary permission flow applies.
//
// THE ROOTS are the project, this session's scratchpad, ~/Developer/scratchpad
// and the mktemp -d directory, each physical. A delete may also remove a
// leftover `claude-*scratch*` folder this account owns directly in /tmp, and
// one session-summary marker in the memory cache's pending-summaries folder.
//
// FACTS. Where a path lands and what git says are the file system's and git's
// answers, which only hooks/register.ts can ask. So the judge asks for each
// fact by key through `get`, and register.ts answers it and runs the judge
// again (settleScope). Every answer the judge cannot get is read the closed
// way: a missing worktree refuses, an unknown branch is a path, and an
// unknown alias is a command nobody can name.
//
// PATHS are matched as the file system reads them. hooks/lib/scope-facts.sh
// resolves each existing folder with `cd -P` and `pwd -P`, which follows every
// link and folds `..` and `//`. It does not give the case a folder has on
// disk: `pwd -P` keeps each name as it was typed. So on case-insensitive APFS a
// case variant of a root reads as outside it and asks, the check for a root
// itself ignores case, and the one name whose disk case matters (a /tmp
// scratch folder) is read through `scope-facts.sh name`.
//
// Pure functions only: the engine follows `$` into no imported function.

import type { WorkbenchShellParse as ShellParse, WorkbenchShellStatement as Statement } from '../../types'
import { KEYWORDS, SHELLS, nameOf, parseShell } from './shell'

// ─── facts ───────────────────────────────────────────────────────────────────

// An answer, or null when it cannot be had.
export type Fact = string | null
// What the judge reads facts through. In a settled judgment it throws a
// NeedFact for a fact not yet asked; read statically it answers null.
export type FactGetter = (key: string) => Fact

export type NeedFact = { need: string }
const isNeed = (error: unknown): error is NeedFact => typeof error === 'object' && error !== null && typeof (error as NeedFact).need === 'string'

// A getter over the answers so far, which asks for the rest.
export const getterOf =
  (answers: ReadonlyMap<string, Fact>): FactGetter =>
  key => {
    if (!answers.has(key)) throw { need: key } satisfies NeedFact
    return answers.get(key) ?? null
  }

// One run of a judge: its value, or the fact it needs next.
export type Step<T> = { value: T } | { need: string }
export function stepOf<T>(judge: () => T): Step<T> {
  try {
    return { value: judge() }
  } catch (error) {
    if (isNeed(error)) return { need: error.need }
    throw error
  }
}

// The fact keys, one shape each, read by hooks/register.ts.
//   dir     the folder's physical path, or null when it is no folder
//   entry   `missing`, or the kind of the entry itself (`dir`, `file`, `link`,
//           `other`), a colon, and 1 when this account owns it
//   name    the name an entry of a folder has on disk, matched without regard
//           to case when no entry has the name as typed
//   git     what git says in a folder: `top`, `tracked`, `commit`, `remotes`,
//           `alias`, and `builtins`, which needs no folder
export const dirKey = (path: string): string => `dir\t${path}`
export const entryKey = (path: string): string => `entry\t${path}`
export const nameKey = (dir: string, name: string): string => `name\t${dir}\t${name}`
export const gitKey = (question: 'top' | 'tracked' | 'commit' | 'remotes' | 'alias', dir: string, arg = ''): string => `git\t${question}\t${dir}\t${arg}`
export const BUILTINS_KEY = 'git\tbuiltins\t\t'

// ─── what the judge is told ──────────────────────────────────────────────────

export type ScopeContext = {
  // The directory the Bash tool runs in, absolute.
  cwd: string | undefined
  // $HOME, for a target spelled with `~`. Such a target always asks.
  home: string | undefined
  // The physical roots: the project, the scratchpads, the mktemp -d folder.
  roots: readonly string[]
  // Where /tmp lands, for the leftover scratch folders.
  tmp: string | undefined
  // The physical pending-summaries folder, when it is this account's own.
  markers: string | undefined
}

export type ScopeVerdict = { kind: 'deny'; reason: string } | { kind: 'ask'; reason: string } | { kind: 'allow' } | { kind: 'none' }

export const MAX_INPUT = 200_000

// ─── the words ───────────────────────────────────────────────────────────────

const DELETE_VERBS: ReadonlySet<string> = new Set(['rm', 'rmdir'])
const FINDS: ReadonlySet<string> = new Set(['find', 'gfind', 'bfs'])
const FIND_EXEC: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir'])
// Commands that run a command they are given, in a string, on their input or
// on another host. A destructive word in their arguments is a command whose
// target this guard cannot read.
const RUNNERS: ReadonlySet<string> = new Set([
  ...SHELLS, 'eval', 'source', '.', 'ssh', 'su', 'parallel', 'xargs', 'watch', 'timeout', 'gtimeout', 'flock', 'setsid', 'script',
  'docker', 'docker-compose', 'podman', 'kubectl', 'chroot', 'nohup', 'sudo', 'doas', 'env', 'nice', 'command', 'exec', 'time', 'stdbuf',
])
// Wrappers whose input is the delete's targets.
const INPUT_WRAPPERS: ReadonlySet<string> = new Set(['xargs', 'parallel'])
// Wrappers the reader places that run their command from input, or again and
// again: the words after them are read from each of them on.
const RUNNER_WRAPPERS: ReadonlySet<string> = new Set(['xargs', 'watch', 'timeout', 'gtimeout', 'flock', 'setsid'])
// Prefixes that leave the command and its targets as written, when they carry
// no option: a delete behind one of them may be allowed.
const PLAIN_PREFIXES: ReadonlySet<string> = new Set(['sudo', 'doas', 'env', 'nice', 'ionice', 'time', 'nohup', 'command', 'exec', 'stdbuf', 'builtin'])
const CLOSERS: ReadonlySet<string> = new Set(['}', 'fi', 'done', 'esac'])
const CD_NAMES: ReadonlySet<string> = new Set(['cd', 'pushd', 'popd'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/

// A character that means a word is not the path it spells: a glob, an
// expansion, a substitution, an escape the reader kept as written, or the
// reader's marks for an escape, a heredoc and an unquoted expansion.
const UNREADABLE = /[*?[\]{}$`\\\uE000-\uE002]/
const isReadable = (word: string): boolean => word !== '' && !UNREADABLE.test(word)

// Whether a line names a destructive command, in any case: evidence in a line
// the reader could not read whole. Quotes and backslash-newlines are taken
// out first, because bash joins `r''m` and `r\<newline>m` into `rm`. A git
// word counts unless the word after its options is a builtin that discards
// nothing, since any other may be an alias.
const DELETE_WORD = /(^|[^A-Za-z0-9])(rm|rmdir|delete)([^A-Za-z0-9]|$)/i
export function mentionsScopeSubject(line: string): boolean {
  const text = line.replaceAll('\\\n', '').replace(/["'\\]/g, '')
  if (DELETE_WORD.test(text)) return true
  const words = text.split(/[\s;&|()<>`$]+/).filter(Boolean)
  for (let i = 0; i < words.length; i++) {
    if (nameOf(words[i] as string) !== 'git') continue
    let j = i + 1
    while (j < words.length && (words[j] as string).startsWith('-')) j += GIT_VALUE_OPTS.has(words[j] as string) ? 2 : 1
    if (words[j] === undefined || !GIT_SAFE_VERBS.has(words[j] as string)) return true
  }
  return false
}

// ─── git ─────────────────────────────────────────────────────────────────────

// The git builtins that discard nothing. Run as themselves, never as an
// alias, so none of them is asked about.
export const GIT_SAFE_VERBS: ReadonlySet<string> = new Set([
  'add', 'am', 'apply', 'archive', 'bisect', 'blame', 'branch', 'bundle', 'cat-file', 'check-attr', 'check-ignore', 'cherry', 'cherry-pick',
  'clone', 'commit', 'commit-tree', 'config', 'count-objects', 'describe', 'diff', 'diff-files', 'diff-index', 'diff-tree', 'fetch', 'for-each-ref',
  'format-patch', 'fsck', 'gc', 'grep', 'hash-object', 'help', 'init', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'merge', 'merge-base', 'mktag',
  'mktree', 'notes', 'pull', 'push', 'range-diff', 'rebase', 'reflog', 'remote', 'repack', 'rev-list', 'rev-parse', 'revert', 'shortlog', 'show',
  'show-branch', 'show-ref', 'status', 'symbolic-ref', 'tag', 'update-index', 'update-ref', 'var', 'verify-commit', 'verify-tag', 'version',
  'worktree', 'write-tree',
])
// The verbs judged by name. Each is a builtin, so git never runs an alias in
// its place.
const GIT_JUDGED: ReadonlySet<string> = new Set(['restore', 'checkout', 'switch', 'rm', 'mv', 'checkout-index', 'read-tree', 'submodule', 'reset', 'clean', 'stash'])
const GIT_VALUE_OPTS: ReadonlySet<string> = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env'])
const GIT_OPAQUE_OPTS: ReadonlySet<string> = new Set(['--git-dir', '--work-tree'])
// Variables that move the repository or point git at config this guard does
// not read, which can set an alias or core.worktree.
const GIT_ENV_MOVES: ReadonlySet<string> = new Set([
  'GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'HOME',
  'XDG_CONFIG_HOME',
])

export const UNRESOLVED_ALIAS = 'a git alias this guard cannot expand'
const SHELL_ALIAS = 'a git alias that runs a destructive shell command'
const SUBMODULE_FOREACH = 'git submodule foreach'
const CHECKOUT_INDEX_PREFIX = 'git checkout-index --force --prefix'
// Discards that reach past the worktree they run in, so no root clears them.
const REFUSED_ANYWHERE: ReadonlySet<string> = new Set([SUBMODULE_FOREACH, CHECKOUT_INDEX_PREFIX, SHELL_ALIAS])

// A long option spelled whole or abbreviated, as git reads it.
const isLong = (token: string, name: string): boolean => {
  const spelled = token.split('=')[0] as string
  return spelled.length > 2 && name.startsWith(spelled)
}

const movesConfig = (key: string): boolean => {
  const k = key.toLowerCase()
  return k === 'core.worktree' || k === 'include.path' || (k.startsWith('includeif.') && k.endsWith('.path'))
}

type GitParts = { chdirs: string[]; isOpaque: boolean; rest: string[]; aliases: Map<string, string | null>; verbAt: number }

// git's own options before the subcommand.
function gitParts(args: readonly string[]): GitParts {
  const rest = [...args]
  const chdirs: string[] = []
  const aliases = new Map<string, string | null>()
  let isOpaque = false
  let at = 0
  while (rest.length > 0 && (rest[0] as string).startsWith('-')) {
    const option = rest.shift() as string
    at++
    const eq = option.indexOf('=')
    const name = eq === -1 ? option : option.slice(0, eq)
    const isJoined = eq !== -1
    const take = (): string | undefined => {
      if (isJoined) return option.slice(eq + 1)
      if (rest.length === 0) return undefined
      at++
      return rest.shift()
    }
    if (GIT_OPAQUE_OPTS.has(name)) {
      isOpaque = true
      take()
    } else if (name === '-C') {
      const chdir = take()
      if (chdir === undefined) isOpaque = true
      else chdirs.push(chdir)
    } else if (GIT_VALUE_OPTS.has(name)) {
      const value = take() ?? ''
      if (name === '-c' || name === '--config-env') {
        const split = value.indexOf('=')
        const key = split === -1 ? value : value.slice(0, split)
        if (movesConfig(key)) isOpaque = true
        if (key.toLowerCase().startsWith('alias.')) aliases.set(key.slice(6).toLowerCase(), name === '-c' && split !== -1 ? value.slice(split + 1) : null)
      }
    }
  }
  return { chdirs, isOpaque, rest, aliases, verbAt: at }
}

const join = (base: string, path: string): string => (path.startsWith('/') ? path : `${base.replace(/\/+$/, '')}/${path}`)

// The folder git starts in, or why it is unknown.
function gitDirectory(args: readonly string[], cwd: string | undefined): { dir: string } | { why: string } {
  const { chdirs, isOpaque } = gitParts(args)
  if (isOpaque) {
    return {
      why: 'it sets --git-dir, --work-tree, core.worktree or include.path, or one of the GIT_DIR, GIT_WORK_TREE, GIT_CONFIG_*, HOME and XDG_CONFIG_HOME variables, which moves the repository or its config somewhere this guard does not follow',
    }
  }
  let dir = cwd
  for (const chdir of chdirs) {
    if (!isReadable(chdir) || chdir.startsWith('~')) return { why: `its -C folder "${chdir}" holds a variable, a glob, a substitution or a tilde` }
    if (chdir.startsWith('/')) dir = chdir
    else if (dir !== undefined) dir = join(dir, chdir)
  }
  return dir === undefined ? { why: 'the folder it runs in is not settled by the line. A `cd ./sub` or an absolute `cd` is followed, so use one of those' } : { dir }
}

const gitDir = (args: readonly string[], cwd: string | undefined): string | undefined => {
  const found = gitDirectory(args, cwd)
  return 'dir' in found ? found.dir : undefined
}

// Whether git reads `name` as a branch to switch to rather than a path. Every
// answer it cannot get is a path, the side that discards work.
function namesBranch(dir: string | undefined, name: string, guess: boolean, get: FactGetter): boolean {
  if (name === '-') return true
  if (dir === undefined || /[$`*?[\\]/.test(name) || !isReadable(name)) return false
  if (get(gitKey('commit', dir, name)) === 'yes') return true
  if (!guess) return false
  if (get(gitKey('remotes', dir, name)) !== '1') return false
  return get(gitKey('tracked', dir, name)) === 'no'
}

function checkoutDiscards(args: readonly string[], tail: readonly string[], cwd: string | undefined, get: FactGetter): string | undefined {
  const operands: string[] = []
  let guess = true
  let isOptions = true
  for (let i = 0; i < tail.length; i++) {
    const token = tail[i] as string
    if (token === '--') {
      if (i + 1 < tail.length) return 'git checkout -- <path>'
      break
    }
    if (!isOptions) {
      operands.push(token)
      continue
    }
    if (token === '--end-of-options') {
      isOptions = false
      continue
    }
    if (isLong(token, '--pathspec-from-file')) return 'git checkout -- <path>'
    if (token.startsWith('--')) {
      if (isLong(token, '--force')) return 'git checkout --force'
      if (isLong(token, '--patch')) return 'git checkout --patch'
      if (isLong(token, '--no-guess')) guess = false
      if (!token.includes('=') && (isLong(token, '--orphan') || isLong(token, '--conflict'))) i++
      continue
    }
    if (token.startsWith('-') && token !== '-') {
      for (let j = 1; j < token.length; j++) {
        const flag = token[j] as string
        if (flag === 'f') return 'git checkout --force'
        if (flag === 'p') return 'git checkout --patch'
        if (flag === 'b' || flag === 'B') {
          if (j === token.length - 1) i++
          break
        }
      }
      continue
    }
    operands.push(token)
  }
  if (operands.length === 0) return undefined
  if (operands.length > 1 || !namesBranch(gitDir(args, cwd), operands[0] as string, guess, get)) return 'git checkout -- <path>'
  return undefined
}

function switchDiscards(tail: readonly string[]): string | undefined {
  for (const token of tail) {
    if (token.startsWith('--')) {
      if (isLong(token, '--force') || isLong(token, '--discard-changes')) return 'git switch --discard-changes'
      continue
    }
    if (token.startsWith('-')) {
      for (const flag of token.slice(1)) {
        if (flag === 'f') return 'git switch --discard-changes'
        if (flag === 'c' || flag === 'C') break
      }
    }
  }
  return undefined
}

function restoreDiscards(tail: readonly string[]): string | undefined {
  let staged: boolean | undefined
  let worktree: boolean | undefined
  for (let i = 0; i < tail.length; i++) {
    const token = tail[i] as string
    if (token === '--' || token === '--end-of-options') break
    if (token.startsWith('--')) {
      if (isLong(token, '--source')) {
        if (!token.includes('=')) i++
      } else if (isLong(token, '--staged')) staged = true
      else if (isLong(token, '--no-staged')) staged = false
      else if (isLong(token, '--worktree')) worktree = true
      else if (isLong(token, '--no-worktree')) worktree = false
      continue
    }
    if (token.startsWith('-')) {
      for (let j = 1; j < token.length; j++) {
        const flag = token[j] as string
        if (flag === 'S') staged = true
        else if (flag === 'W') worktree = true
        else if (flag === 's') {
          if (j === token.length - 1) i++
          break
        }
      }
    }
  }
  return worktree === true || (worktree === undefined && staged === undefined) ? 'git restore' : undefined
}

type Setting = readonly [string, boolean]
// The last value each named option takes before `--`. Options are read
// anywhere among the operands, as git reads them.
function optionsOf(
  tail: readonly string[],
  shorts: Readonly<Record<string, Setting>>,
  longs: Readonly<Record<string, Setting>>,
  valued: readonly string[] = [],
  valuedShort = '',
): Record<string, boolean> {
  const state: Record<string, boolean> = {}
  for (let i = 0; i < tail.length; i++) {
    const token = tail[i] as string
    if (token === '--' || token === '--end-of-options') break
    if (token.startsWith('--')) {
      for (const [name, [key, value]] of Object.entries(longs)) {
        if (isLong(token, name)) {
          state[key] = value
          break
        }
      }
      if (!token.includes('=') && valued.some(name => isLong(token, name))) i++
      continue
    }
    if (token.startsWith('-') && token !== '-') {
      for (let j = 1; j < token.length; j++) {
        const flag = token[j] as string
        const setting = shorts[flag]
        if (setting !== undefined) state[setting[0]] = setting[1]
        if (valuedShort.includes(flag)) {
          if (j === token.length - 1) i++
          break
        }
      }
    }
  }
  return state
}

const FORCE: Record<string, Setting> = { '--force': ['force', true], '--no-force': ['force', false] }
const DRY_RUN: Record<string, Setting> = { '--dry-run': ['dry', true], '--no-dry-run': ['dry', false] }
const SHORT_FORCE: Record<string, Setting> = { f: ['force', true] }
const SHORT_DRY: Record<string, Setting> = { n: ['dry', true] }

function submoduleDiscards(tail: readonly string[]): string | undefined {
  let i = 0
  while (i < tail.length && (tail[i] as string).startsWith('-')) i++
  if (i === tail.length) return undefined
  const sub = tail[i] as string
  const rest = tail.slice(i + 1)
  // foreach takes its command as words or as one string, after options of its
  // own, so every suffix is read.
  if (sub === 'foreach') return argsHideDestructive(rest, 1) ? SUBMODULE_FOREACH : undefined
  if (sub === 'deinit') return optionsOf(rest, SHORT_FORCE, FORCE).force ? 'git submodule deinit --force' : undefined
  if (sub === 'update') return optionsOf(rest, SHORT_FORCE, FORCE, ['--reference', '--depth', '--jobs', '--filter'], 'j').force ? 'git submodule update --force' : undefined
  return undefined
}

function judgeVerb(verb: string, tail: readonly string[], args: readonly string[], cwd: string | undefined, get: FactGetter): string | undefined {
  switch (verb) {
    case 'restore':
      return restoreDiscards(tail)
    case 'checkout':
      return checkoutDiscards(args, tail, cwd, get)
    case 'switch':
      return switchDiscards(tail)
    case 'rm':
    case 'mv': {
      const state = optionsOf(tail, { ...SHORT_FORCE, ...SHORT_DRY }, { ...FORCE, ...DRY_RUN }, ['--pathspec-from-file'])
      return state.force && !state.dry ? `git ${verb} --force` : undefined
    }
    case 'checkout-index': {
      const state = optionsOf(tail, SHORT_FORCE, { ...FORCE, '--prefix': ['prefix', true] }, ['--prefix', '--stage'])
      return !state.force ? undefined : state.prefix ? CHECKOUT_INDEX_PREFIX : 'git checkout-index --force'
    }
    case 'read-tree': {
      const state = optionsOf(
        tail,
        { u: ['update', true], ...SHORT_DRY },
        { '--reset': ['reset', true], '--no-reset': ['reset', false], ...DRY_RUN },
        ['--prefix', '--exclude-per-directory', '--index-output'],
      )
      return state.update && state.reset && !state.dry ? 'git read-tree -u --reset' : undefined
    }
    case 'submodule':
      return submoduleDiscards(tail)
    case 'reset':
      // git reads an unambiguous prefix of a long option, so `--har` is --hard.
      return tail.some(t => t !== '--' && t.startsWith('--h') && isLong(t, '--hard')) ? 'git reset --hard' : undefined
    case 'clean':
      return optionsOf(tail, SHORT_DRY, DRY_RUN, ['--exclude'], 'e').dry ? undefined : 'git clean'
    case 'stash': {
      const sub = tail.find(t => !t.startsWith('-'))
      return sub === 'clear' || sub === 'drop' ? `git stash ${sub}` : undefined
    }
    default:
      return undefined
  }
}

// The words an alias expands to, null for no alias, or UNRESOLVED_ALIAS.
function aliasOf(args: readonly string[], cwd: string | undefined, name: string, aliases: ReadonlyMap<string, string | null>, get: FactGetter): string[] | null | string {
  if (!isReadable(name)) return UNRESOLVED_ALIAS
  let value: string | null
  if (aliases.has(name.toLowerCase())) value = aliases.get(name.toLowerCase()) ?? null
  else {
    const dir = gitDir(args, cwd)
    if (dir === undefined) return UNRESOLVED_ALIAS
    const found = get(gitKey('alias', dir, name))
    if (found === null) return UNRESOLVED_ALIAS
    if (found === 'none') return null
    value = found.slice(1)
  }
  if (value === null) return UNRESOLVED_ALIAS
  // git refuses to run an empty alias.
  if (value.trim() === '') return []
  if (value.startsWith('!')) return textHidesDestructive(value.slice(1), 1) ? SHELL_ALIAS : UNRESOLVED_ALIAS
  // One command of plain words, as git splits an alias.
  const reading = parseShell(value)
  const only = reading.statements[0]
  if (reading.unknowns.length > 0 || reading.statements.length !== 1 || only === undefined || only.redirects.length > 0 || only.heredocs.length > 0) {
    return UNRESOLVED_ALIAS
  }
  return [...only.words]
}

// The destructive git operation of a command and the arguments git runs once
// every alias is expanded, or undefined.
export function gitOperation(args: readonly string[], cwd: string | undefined, get: FactGetter, seen: readonly string[] = []): { op: string | undefined; args: readonly string[] } {
  const parts = gitParts(args)
  const verb = parts.rest[0]
  if (verb === undefined) return { op: undefined, args }
  if (GIT_JUDGED.has(verb)) return { op: judgeVerb(verb, parts.rest.slice(1), args, cwd, get), args }
  if (GIT_SAFE_VERBS.has(verb)) return { op: undefined, args }
  const builtins = get(BUILTINS_KEY)
  if (builtins !== null && builtins.split(' ').includes(verb)) return { op: undefined, args }
  if (seen.includes(verb.toLowerCase())) return { op: UNRESOLVED_ALIAS, args }
  const words = aliasOf(args, cwd, verb, parts.aliases, get)
  if (words === null) return { op: undefined, args }
  if (typeof words === 'string') return { op: words, args }
  if (words.length === 0) return { op: undefined, args }
  const expanded = [...args.slice(0, parts.verbAt), ...words, ...args.slice(parts.verbAt + 1)]
  return gitOperation(expanded, cwd, get, [...seen, verb.toLowerCase()])
}

// ─── reading a command without facts ─────────────────────────────────────────

const noFacts: FactGetter = () => null

// Whether a command, given as its words from the name on, is destructive. Read
// without facts, so an unknown branch is a path and an unknown alias counts.
function commandIsDestructive(words: readonly string[], depth: number): boolean {
  const name = nameOf(words[0] ?? '')
  if (DELETE_VERBS.has(name)) return true
  if (name === 'git') return gitOperation(words.slice(1), undefined, noFacts).op !== undefined
  if (FINDS.has(name)) return words.includes('-delete') || findExecHides(words.slice(1), depth)
  if (RUNNERS.has(name)) return argsHideDestructive(words.slice(1), depth + 1)
  return false
}

const findExecHides = (args: readonly string[], depth: number): boolean => {
  const at = args.findIndex(a => FIND_EXEC.has(a))
  return at !== -1 && argsHideDestructive(args.slice(at + 1), depth + 1)
}

// Whether a runner's arguments hold a destructive command: as plain adjacent
// words from any of them on (`xargs -n1 rm -rf`, `timeout 5 rm x`), or in one
// word holding a command line (`ssh box "rm -rf x"`). Over-reach is taken on
// purpose: `xargs grep rm` is refused, because one suffix of it is `rm`.
function argsHideDestructive(args: readonly string[], depth: number): boolean {
  if (depth > 3) return args.some(a => a.trim() !== '')
  for (let i = 0; i < args.length; i++) if (commandIsDestructive(args.slice(i), depth)) return true
  return args.some(a => /\s/.test(a.trim()) && textHidesDestructive(a, depth + 1))
}

// Whether a piece of shell text runs a destructive command.
function textHidesDestructive(text: string, depth: number): boolean {
  if (text.trim() === '') return false
  if (depth > 3) return true
  const reading = parseShell(text)
  if ((reading.unknowns.length > 0 || reading.statements.some(s => !s.isPlaced)) && mentionsScopeSubject(text)) return true
  return reading.statements.some(
    s =>
      s.nameAt >= 0 &&
      (commandIsDestructive(s.words.slice(s.nameAt), depth) || s.heredocs.some(h => RUNNERS.has(s.name) && textHidesDestructive(h.body, depth + 1))),
  )
}

// ─── paths ───────────────────────────────────────────────────────────────────

type Placed = { path: string; isCapped: boolean }
type Unread = { why: string }

// Where an absolute path lands: its deepest existing folder, resolved
// physically, and the names below it. A name below it does not exist, so it
// cannot be a link. A `..` there is folded as text, and the delete is then
// never allowed: the kernel refuses to walk through a missing folder, so it
// deletes nothing, but this guard does not vouch for that.
//
// The last name is not followed, because `rm -rf link` removes the link and
// never what it points at. A trailing slash changes that: `rm -rf link/`
// empties the target, so the path is then resolved through it.
function placed(raw: string, get: FactGetter): Placed | Unread {
  const named = raw.split('/').filter(part => part !== '')
  const last = named.at(-1)
  if (last === '.' || last === '..') return { why: `"${raw}" names a folder by position with "${last}" rather than naming an entry to delete` }
  if (raw.endsWith('/')) {
    const through = get(dirKey(raw))
    if (through !== null && through !== '/') return { path: through, isCapped: false }
  }
  const parts = named.filter(part => part !== '.')
  if (parts.length === 0) return { why: 'the target is the filesystem root' }
  for (let k = parts.length - 1; k >= 0; k--) {
    const anchor = get(dirKey(`/${parts.slice(0, k).join('/')}`))
    if (anchor === null) continue
    const out = anchor === '/' ? [] : anchor.split('/').filter(Boolean)
    const tail = parts.slice(k)
    for (const part of tail) {
      if (part === '..') out.pop()
      else out.push(part)
    }
    return { path: `/${out.join('/')}`, isCapped: tail.includes('..') }
  }
  return { why: `no folder above "${raw}" exists` }
}

const beneath = (path: string, roots: readonly string[]): boolean => roots.some(root => path.startsWith(`${root}/`))
const isRootItself = (path: string, roots: readonly string[]): boolean => roots.some(root => root.toLowerCase() === path.toLowerCase())

const SCRATCH_FAMILY = /^claude-[^/]*scratch[^/]*$/
const MARKER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/

// A path in or under a leftover agent-scratch folder directly in /tmp: a real
// folder this account owns, named in the claude-*scratch* family on disk.
function isLeftoverScratch(path: string, ctx: ScopeContext, get: FactGetter): boolean {
  const tmp = ctx.tmp
  if (tmp === undefined || tmp === '/' || !path.startsWith(`${tmp}/`)) return false
  const first = path.slice(tmp.length + 1).split('/')[0] as string
  if (get(entryKey(`${tmp}/${first}`)) !== 'dir:1') return false
  const name = get(nameKey(tmp, first))
  return name !== null && SCRATCH_FAMILY.test(name)
}

// One session-summary marker, missing or a regular file this account owns,
// directly in the pending-summaries folder.
function isPendingMarker(path: string, ctx: ScopeContext, get: FactGetter): boolean {
  const cut = path.lastIndexOf('/')
  if (ctx.markers === undefined || path.slice(0, cut) !== ctx.markers || !MARKER_NAME.test(path.slice(cut + 1))) return false
  const entry = get(entryKey(path))
  return entry === 'missing' || entry === 'file:1'
}

// ─── where a statement runs ──────────────────────────────────────────────────

// Whether the statements of a line run one after another in this shell. The
// reader does not mark subshells, pipeline stages or `||`, so a line holding
// any `(`, `|`, a lone `&` or a backtick is not.
export const isLinearLine = (line: string): boolean => !/[()|&`]/.test(line.replaceAll('&&', ''))

// Every folder the statements after a cd, pushd or popd `s` may run in, given
// those they could run in before it. bash's own `cd` into a folder that
// exists, run whenever a linear line runs, moves the shell: the folder it
// lands in replaces the one before. Any other cd (one after `&&`, in an `if`
// or a loop, in a subshell, `CD`, `sudo cd`, a target that is not there) adds
// where it would land and keeps where the shell was. A target the text does
// not settle (a variable, `-`, popd) lands nowhere known. Nor does a bare
// relative target (`cd sub`, not ./ or ../), because CDPATH can send it out of
// the folder (`CDPATH=/etc cd ssl` lands in /etc/ssl), nor any target holding
// `..`, because bash folds `..` by the path as written and the file system by
// the path a link leads to. hooks/mods/commit-approval.ts reads cd the same
// way. `home` reads a `~` target; without it, `~` lands nowhere known.
// Whether a cd target may resolve through CDPATH: a relative path that does
// not start with /, ~, ./ or ../.
const isBareRelative = (target: string): boolean => !/^(\/|~|\.\.?(\/|$))/.test(target)

export function cwdsAfter(
  s: Statement,
  cwds: readonly (string | undefined)[],
  isLinear: boolean,
  get: FactGetter,
  home: string | undefined,
): (string | undefined)[] {
  const name = s.name
  const target = name === 'popd' ? undefined : s.args.find(a => !a.startsWith('-') || a === '-')
  const isExact = isLinear && s.isCertain && name !== 'popd' && s.words[s.nameAt] === name && s.source === 'line' && s.wrappers.every(w => w === 'command' || w === 'builtin')
  const next: (string | undefined)[] = []
  for (const cwd of cwds) {
    let moved: string | undefined
    if (target === undefined || target === '-' || !isReadable(target) || isBareRelative(target) || target.split('/').includes('..')) moved = undefined
    else if (target === '~' || target.startsWith('~/')) moved = home === undefined || !home.startsWith('/') ? undefined : home + target.slice(1)
    else if (target.startsWith('~')) moved = undefined
    else moved = target.startsWith('/') ? target : cwd === undefined ? undefined : join(cwd, target)
    const real = isExact && moved !== undefined ? get(dirKey(moved)) : null
    if (real !== null) next.push(real)
    else next.push(cwd, moved)
  }
  const out = [...new Set(next)]
  return out.length > 16 ? [undefined] : out
}

// ─── the judgment ────────────────────────────────────────────────────────────

const HEAD = 'Destructive-scope guard (workbench-core): '
const SCRATCH_NOTE =
  'Scratch cleanup is never Mike\'s job: if the target is scratch you made, spell its path out as a literal absolute path and retry, or leave it and name the path in your report. Make new scratch only in the session scratchpad or ~/Developer/scratchpad.'
const UNREAD_ADVICE =
  'Spell each target out as a literal absolute path, with no variable, glob, tilde or substitution, and run the delete as a command of its own, not through a shell, xargs or find. If it must stay as it is, stop and ask Mike to run it himself with the ! prefix.'

export const scopeDeny = (what: string): string => `${HEAD}${what}. This guard cannot tell what it would destroy, so the call is refused. ${UNREAD_ADVICE} ${SCRATCH_NOTE}`

const rootsNote = (roots: readonly string[]): string =>
  roots.length === 0 ? 'No scope root resolved at all.' : `The roots right now are ${roots.join(', ')}.`

const ASK_ADVICE =
  'Approve it only if the task calls for destroying this target. If it is denied, the agent goes on without it and says so in its report.'

const askFor = (what: string, roots: readonly string[]): string =>
  `${HEAD}${what}, which is outside this project and every scratch root. ${rootsNote(roots)} ${ASK_ADVICE}`

// What one destructive target came to.
type Outcome = { kind: 'deny' | 'ask'; reason: string } | { kind: 'in' } | { kind: 'spoil' }

// A delete written as itself: no escape in it, and nothing before its name but
// assignments, keywords and option-free prefixes such as `sudo`.
const isPlainShape = (s: Statement): boolean =>
  s.escaped.length === 0 && s.words.slice(0, s.nameAt).every(word => ASSIGNMENT.test(word) || KEYWORDS.has(word) || CLOSERS.has(word) || PLAIN_PREFIXES.has(word))

// A wrapper before the command that changes its directory (`env -C dir`,
// `sudo -D dir`).
const changesDirectory = (s: Statement): boolean =>
  s.wrappers.length > 0 && s.words.slice(0, Math.max(s.nameAt, 0)).some(word => /^(-[A-Za-z]*[CD]|--ch)/.test(word))

// The operands of rm and rmdir: every word after `--`, and every word before
// it that does not start with `-`. Neither takes an option with a separate
// value.
function operandsOf(args: readonly string[]): string[] {
  const out: string[] = []
  let isLiteral = false
  for (const arg of args) {
    if (!isLiteral && arg === '--') isLiteral = true
    else if (isLiteral || !arg.startsWith('-') || arg === '-') out.push(arg)
  }
  return out
}

function deleteOutcomes(s: Statement, cwds: readonly (string | undefined)[], ctx: ScopeContext, get: FactGetter, isPlain: boolean, homeMoved: boolean): Outcome[] {
  const outcomes: Outcome[] = []
  const verb = s.name
  for (const operand of operandsOf(s.args)) {
    if (operand === '') {
      outcomes.push({ kind: 'deny', reason: scopeDeny(`\`${verb}\` is given an empty operand`) })
      continue
    }
    let isTilde = false
    let raws: (string | undefined)[]
    if (operand === '~' || operand.startsWith('~/')) {
      if (ctx.home === undefined || !ctx.home.startsWith('/') || homeMoved || !isReadable(operand.slice(1))) {
        outcomes.push({ kind: 'deny', reason: scopeDeny(`\`${verb} ${operand}\` starts with a tilde whose home this line may change`) })
        continue
      }
      isTilde = true
      raws = [ctx.home + operand.slice(1)]
    } else if (!isReadable(operand) || operand.startsWith('~')) {
      outcomes.push({ kind: 'deny', reason: scopeDeny(`\`${verb}\` is given "${operand}", which holds a variable, a glob, a substitution or another user's tilde, so the text does not say which paths it removes`) })
      continue
    } else if (operand.startsWith('/')) raws = [operand]
    else if (changesDirectory(s)) raws = [undefined]
    else raws = cwds.map(cwd => (cwd === undefined ? undefined : join(cwd, operand)))
    for (const raw of raws) {
      if (raw === undefined) {
        outcomes.push({ kind: 'deny', reason: scopeDeny(`\`${verb} ${operand}\` is relative, and the folder it runs in is not settled by the line (a cd this guard cannot follow). A \`cd ./sub\` or an absolute \`cd\` is followed, so use one of those`) })
        continue
      }
      const where = placed(raw, get)
      if ('why' in where) {
        outcomes.push({ kind: 'deny', reason: scopeDeny(`\`${verb}\`: ${where.why}`) })
        continue
      }
      if (isRootItself(where.path, ctx.roots)) {
        outcomes.push({
          kind: 'deny',
          reason: `${HEAD}\`${verb} ${operand}\` would delete ${where.path}, which is a scope root itself, holding live state that is not this session's to destroy. Delete what is inside it instead.`,
        })
        continue
      }
      const isIn = beneath(where.path, ctx.roots) || isLeftoverScratch(where.path, ctx, get) || isPendingMarker(where.path, ctx, get)
      if (!isIn) {
        outcomes.push({ kind: 'ask', reason: askFor(`\`${verb}\` would delete ${where.path}`, ctx.roots) })
      } else if (where.isCapped) {
        outcomes.push({
          kind: 'ask',
          reason: `${HEAD}\`${verb} ${operand}\` walks through a folder that does not exist on its way to ${where.path}, so this guard does not vouch for where it lands. ${ASK_ADVICE}`,
        })
      } else if (isTilde || !isPlain) {
        outcomes.push({
          kind: 'ask',
          reason: `${HEAD}\`${verb}\` would delete ${where.path}, inside a root, but ${isTilde ? 'through a tilde, whose home the shell reads from its own environment' : 'behind a wrapper option this guard does not read'}. ${ASK_ADVICE} Agents: spell the path out absolutely, with no wrapper option, and it runs without a prompt.`,
        })
      } else outcomes.push({ kind: 'in' })
    }
  }
  return outcomes
}

function gitOutcomes(s: Statement, cwds: readonly (string | undefined)[], ctx: ScopeContext, get: FactGetter, isPlain: boolean, envMoved: boolean): Outcome[] | undefined {
  const outcomes: Outcome[] = []
  let isDestructive = false
  const args = envMoved ? ['--work-tree=(environment)', ...s.args] : s.args
  for (const cwd of changesDirectory(s) ? [undefined] : cwds) {
    const { op, args: expanded } = gitOperation(args, cwd, get)
    if (op === undefined) continue
    isDestructive = true
    if (REFUSED_ANYWHERE.has(op)) {
      outcomes.push({
        kind: 'deny',
        reason: `${HEAD}\`${op}\` acts outside the worktree it runs in: it runs a shell command, or writes wherever its prefix points, so no root check can clear it. Spell the discard out as a command of its own. If it must stay as it is, stop and ask Mike to run it himself with the ! prefix.`,
      })
      continue
    }
    const found = gitDirectory(expanded, cwd)
    if ('why' in found) {
      outcomes.push({ kind: 'deny', reason: scopeDeny(`\`${op}\`: this guard cannot tell which repository it acts on, because ${found.why}`) })
      continue
    }
    const top = get(gitKey('top', found.dir))
    const worktree = top === null || top === '' ? null : get(dirKey(top))
    if (worktree === null) {
      outcomes.push({ kind: 'deny', reason: scopeDeny(`\`${op}\`: "${found.dir}" is not inside a git worktree this guard can read`) })
      continue
    }
    const isIn = worktree !== '/' && (isRootItself(worktree, ctx.roots) || beneath(worktree, ctx.roots))
    if (!isIn) outcomes.push({ kind: 'ask', reason: askFor(`\`${op}\` would discard uncommitted work in the worktree at ${worktree}`, ctx.roots) })
    else if (op === UNRESOLVED_ALIAS) outcomes.push({ kind: 'spoil' })
    else if (!isPlain) {
      outcomes.push({
        kind: 'ask',
        reason: `${HEAD}\`${op}\` runs in the worktree at ${worktree}, inside a root, but behind a wrapper option this guard does not read. ${ASK_ADVICE}`,
      })
    } else outcomes.push({ kind: 'in' })
  }
  return isDestructive ? outcomes : undefined
}

// The verdict on one Bash line. `get` answers the facts (getterOf in a
// settled judgment); one it lacks throws a NeedFact.
export function scopeVerdict(line: string, parse: ShellParse, ctx: ScopeContext, get: FactGetter): ScopeVerdict {
  const isSubject = mentionsScopeSubject(line)
  if (isSubject && line.length > MAX_INPUT) return { kind: 'deny', reason: scopeDeny('this command is longer than 200,000 characters and names a destructive verb, so it was not read whole. Split it into smaller commands') }
  if (isSubject && (parse.unknowns.length > 0 || parse.statements.some(s => !s.isPlaced))) {
    return { kind: 'deny', reason: scopeDeny('the shell reader could not read all of this command (an unclosed quote, an escape it does not decode, or a script nested too deep), and the command names a destructive verb') }
  }
  // An assignment anywhere, as a prefix, an export or a statement of its
  // own, reaches every git command after it.
  const assigned = parse.statements.flatMap(s => [...s.assignments, ...(s.name === 'export' || s.name === 'declare' || s.name === 'typeset' ? s.args : [])])
  const assignedNames = new Set(assigned.map(word => word.split(/\+?=/)[0] as string))
  const envMoved = [...GIT_ENV_MOVES].some(name => assignedNames.has(name))
  const homeMoved = assignedNames.has('HOME')

  const denies: string[] = []
  const asks: string[] = []
  let targets = 0
  let isSpoiled = false
  // Every folder a statement may run in (cwdsAfter): a relative path must be
  // in scope from each of them.
  const isLinear = isLinearLine(line)
  let cwds: (string | undefined)[] = [ctx.cwd]
  const record = (outcomes: readonly Outcome[]) => {
    for (const o of outcomes) {
      if (o.kind === 'deny') denies.push(o.reason)
      else if (o.kind === 'ask') asks.push(o.reason)
      else if (o.kind === 'spoil') isSpoiled = true
      else targets++
    }
  }
  for (const s of parse.statements) {
    if (s.nameAt === -1) {
      if (s.words.some(word => !ASSIGNMENT.test(word)) || s.redirects.some(r => r.isReal)) isSpoiled = true
      continue
    }
    const name = s.name
    // The reader decodes a $'...' name, and keeps an escape it does not know
    // (\u, \c) as written: such a name may be any program.
    if (s.escaped.includes(s.nameAt) && (s.words[s.nameAt] ?? '').includes('\\')) {
      denies.push(scopeDeny(`the command name "${s.words[s.nameAt]}" is spelled with a $'...' escape this guard does not decode, so it may be any program`))
      continue
    }
    // A glob or an expansion in the command word runs whatever it expands to,
    // such as the first file in the folder: on a line that names a destructive
    // verb, that may be rm.
    if (isSubject && !isReadable(s.words[s.nameAt] ?? '')) {
      denies.push(scopeDeny(`the command name "${s.words[s.nameAt]}" holds a glob, a variable or a substitution, so it may be any program`))
      continue
    }
    if (CD_NAMES.has(name)) {
      cwds = cwdsAfter(s, cwds, isLinear, get, undefined)
      if (s.redirects.some(r => r.isReal) || s.source !== 'line') isSpoiled = true
      continue
    }
    if (FINDS.has(name) && s.args.includes('-delete')) {
      denies.push(scopeDeny('`find -delete` removes whatever its expression matches, which is decided by walking the tree, not by the command text'))
      continue
    }
    // A runner by name, or one the reader placed as a wrapper (`xargs -n1
    // grep rm`, `timeout 5 ...`): the words it runs are read from each of
    // them on, as the bash guard read them.
    const runner = s.wrappers.find(w => RUNNER_WRAPPERS.has(w))
    if (runner !== undefined && argsHideDestructive(s.words.slice(s.nameAt), 1)) {
      denies.push(scopeDeny(`\`${runner}\` runs a destructive command, whose targets come from its input or are run again and again`))
      continue
    }
    if (RUNNERS.has(name) || FINDS.has(name)) {
      const hides = FINDS.has(name) ? findExecHides(s.args, 0) : argsHideDestructive(s.args, 1)
      const fed = s.heredocs.some(h => textHidesDestructive(h.body, 1))
      if (hides || fed) {
        denies.push(scopeDeny(`\`${name}\` runs a destructive command it was handed${fed ? ' in a heredoc' : ''}, whose targets live in a string, on its input or on another host`))
        continue
      }
    }
    const isDelete = DELETE_VERBS.has(name)
    if (!isDelete && name !== 'git') {
      isSpoiled = true
      continue
    }
    const hasRedirect = s.redirects.some(r => r.isReal)
    // Read before the facts are asked, so a refused shape costs no git run.
    const isDestructive = isDelete || gitOperation(s.args, undefined, noFacts).op !== undefined
    if (isDestructive && s.source !== 'line') {
      denies.push(scopeDeny(`\`${name}\` runs inside a ${s.source === 'substitution' ? 'command substitution' : s.source === 'script' ? 'script handed to a shell, eval or trap' : 'heredoc fed to a shell'}, which this guard does not follow`))
      continue
    }
    // Under xargs, the operands come from its input, so a git verb that may
    // discard given a path (`xargs git checkout`) is read as one that does.
    const isFed = s.wrappers.some(w => INPUT_WRAPPERS.has(w))
    if (isFed && (isDestructive || (name === 'git' && !GIT_SAFE_VERBS.has(gitParts(s.args).rest[0] ?? 'status')))) {
      denies.push(scopeDeny(`\`${name}\` runs under xargs or parallel, which supply its targets from their input`))
      continue
    }
    const isPlain = isPlainShape(s)
    if (isDelete) {
      if (hasRedirect || s.heredocs.length > 0) isSpoiled = true
      record(deleteOutcomes(s, cwds, ctx, get, isPlain, homeMoved))
      continue
    }
    if (!isDestructive) {
      isSpoiled = true
      continue
    }
    const outcomes = gitOutcomes(s, cwds, ctx, get, isPlain, envMoved)
    if (outcomes === undefined) {
      isSpoiled = true
      continue
    }
    // Output thrown away, or one descriptor copied onto another, writes no
    // file. Any other redirect writes one, which is more than a discard.
    if (s.redirects.some(r => r.isReal && !(r.target === '/dev/null' || ((r.op === '>&' || r.op === '<&') && /^(\d+|-)$/.test(r.target))))) isSpoiled = true
    record(outcomes)
  }
  if (denies.length > 0) return { kind: 'deny', reason: denies[0] as string }
  if (asks.length > 0) return { kind: 'ask', reason: asks.length === 1 ? (asks[0] as string) : `${asks[0]} (and ${asks.length - 1} more target${asks.length > 2 ? 's' : ''} outside the roots)` }
  return targets > 0 && !isSpoiled ? { kind: 'allow' } : { kind: 'none' }
}

// Whether a line can reach a verdict at all, read with no fact: the gate in
// front of the facts, so an ordinary line costs no process.
export const needsScope = (line: string, parse: ShellParse): boolean =>
  mentionsScopeSubject(line) || parse.statements.some(s => DELETE_VERBS.has(s.name) || s.name === 'git' || FINDS.has(s.name))

// The words an unattended lane gets in place of a prompt nobody can answer.
export const NO_ONE_TO_ASK =
  'Nobody can answer a permission prompt in this run (a headless, scheduled or pipeline session), so the call is refused instead. Leave the target alone and name it in your report, so Mike can decide.'
