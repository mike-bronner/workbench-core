// The vault-git guard, as pure functions. It replaces hooks/vault-git-guard.sh,
// frozen under tests/oracle/ as a test oracle. hooks/register.ts calls it from
// tool.call, before the call runs.
//
// It exists because of a real loss of provenance. On 2026-09-04 an agent ran
// `git -C ~/Documents/Claude/Memory rm identity/profile.md`. The memory server
// owns that repository and commits on its own deferred queue, so it swept the
// staged deletion into commit 014f51b1, under a message about an unrelated
// note. The memory MCP's delete, edit, write, append, rename and git_sync are
// the way to change the vault.
//
// WHAT IT REFUSES: a git write verb whose repository resolves inside the
// vault, through `git -C`, a `cd` before it, --git-dir or --work-tree, or the
// Bash tool's own folder. Read-only git in the vault runs, and so do the read
// forms of `branch`, `stash` and `tag`. An alias is judged by what it expands
// to, from `-c alias.x=...` on the line or from the vault's config. A git
// write a runner hides (`find -exec git rm`, `parallel`) is judged too. It
// stops at ssh and the container commands: another machine's vault is not
// this vault.
//
// It FAILS CLOSED where the bash guard failed open: a git write whose folder
// this guard cannot tell (a `cd` to a variable) is refused when the line names
// the vault, and so is a line the reader could not read whole that names the
// vault and a git write.
//
// Pure functions only: the engine follows `$` into no imported function.

import type { WorkbenchShellParse as ShellParse, WorkbenchShellStatement as Statement } from '../../types'
import type { FactGetter } from './destructive-scope'
import { BUILTINS_KEY, GIT_SAFE_VERBS, cwdsAfter, dirKey, gitKey, isLinearLine } from './destructive-scope'
import { nameOf, parseShell } from './shell'

export const MAX_INPUT = 200_000

export const WRITE_VERBS: ReadonlySet<string> = new Set([
  'commit', 'add', 'rm', 'mv', 'push', 'pull', 'fetch', 'reset', 'checkout', 'switch', 'restore', 'stash', 'merge', 'rebase', 'cherry-pick', 'revert',
  'clean', 'apply', 'am', 'tag', 'branch', 'init', 'update-ref', 'gc', 'repack', 'prune', 'worktree', 'notes', 'symbolic-ref',
])
const BRANCH_WRITE_FLAGS: ReadonlySet<string> = new Set(['-d', '-D', '--delete'])
const STASH_READS: ReadonlySet<string> = new Set(['list', 'show'])
const TAG_READ_FLAGS: ReadonlySet<string> = new Set([
  '-l', '--list', '-i', '--ignore-case', '--column', '--no-column', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--omit-empty',
])
const TAG_READ_PREFIXES = ['-n', '--sort=', '--format=', '--contains=', '--points-at=', '--merged=', '--no-merged=']
const GIT_VALUE_FLAGS: ReadonlySet<string> = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source'])
// Commands that run a command they are given on this machine. Any suffix of
// their words is read as a command.
const RUNNERS: ReadonlySet<string> = new Set(['find', 'gfind', 'bfs', 'parallel', 'watch', 'su', 'eval', 'source', '.', 'chroot', 'script'])
const UNREADABLE = /[*?[\]{}$`\uE000-\uE002]/

type Git = { chdirs: string[]; gitDir?: string; workTree?: string; verb?: string; args: string[]; verbAt: number; aliases: Map<string, string | null> }

function parseGit(args: readonly string[]): Git {
  const out: Git = { chdirs: [], args: [], verbAt: args.length, aliases: new Map() }
  let i = 0
  while (i < args.length) {
    const token = args[i] as string
    if (!token.startsWith('-')) break
    if (token === '--') {
      i++
      break
    }
    const eq = token.indexOf('=')
    const name = eq === -1 ? token : token.slice(0, eq)
    let value: string
    if (eq !== -1) {
      value = token.slice(eq + 1)
      i++
    } else if (GIT_VALUE_FLAGS.has(name) && i + 1 < args.length) {
      value = args[i + 1] as string
      i += 2
    } else {
      i++
      continue
    }
    if (name === '-C') out.chdirs.push(value)
    else if (name === '--git-dir') out.gitDir = value
    else if (name === '--work-tree') out.workTree = value
    else if (name === '-c') {
      const split = value.indexOf('=')
      const key = split === -1 ? value : value.slice(0, split)
      if (key.toLowerCase().startsWith('alias.')) out.aliases.set(key.slice(6).toLowerCase(), split === -1 ? null : value.slice(split + 1))
    }
  }
  if (i < args.length) {
    out.verb = args[i] as string
    out.verbAt = i
  }
  out.args = args.slice(i + 1)
  return out
}

export function isWrite(verb: string, args: readonly string[]): boolean {
  if (!WRITE_VERBS.has(verb)) return false
  if (verb === 'branch') return args.some(a => BRANCH_WRITE_FLAGS.has(a))
  if (verb === 'stash') {
    const words = args.filter(a => !a.startsWith('-'))
    return !(words.length > 0 && STASH_READS.has(words[0] as string))
  }
  if (verb === 'tag') {
    if (args.some(a => TAG_READ_FLAGS.has(a) || TAG_READ_PREFIXES.some(p => a.startsWith(p)))) return false
    return args.some(a => !a.startsWith('-'))
  }
  return true
}

export type VaultContext = { vault: string; cwd: string | undefined; home: string | undefined }

// Where a path lands: its deepest existing folder resolved physically, and the
// names below it, a `..` among them folded as text.
function realOf(path: string, get: FactGetter): string {
  const parts = path.split('/').filter(p => p !== '' && p !== '.')
  for (let k = parts.length; k >= 0; k--) {
    const anchor = get(dirKey(`/${parts.slice(0, k).join('/')}`))
    if (anchor === null) continue
    const out = anchor === '/' ? [] : anchor.split('/').filter(Boolean)
    for (const part of parts.slice(k)) {
      if (part === '..') out.pop()
      else out.push(part)
    }
    return `/${out.join('/')}`
  }
  return path
}

const inside = (path: string, vault: string): boolean => {
  const p = path.toLowerCase()
  const v = vault.toLowerCase()
  return p === v || p.startsWith(`${v}/`)
}

// A path as written, made absolute, or undefined when the text does not say.
function absolute(path: string, base: string | undefined, home: string | undefined): string | undefined {
  if (path === '' || UNREADABLE.test(path)) return undefined
  if (path === '~' || path.startsWith('~/')) return home === undefined ? undefined : home + path.slice(1)
  if (path.startsWith('~')) return undefined
  if (path.startsWith('/')) return path
  return base === undefined ? undefined : `${base.replace(/\/+$/, '')}/${path}`
}

// The folders a git command may act on, undefined where the text does not say.
function targetDirs(git: Git, cwd: string | undefined, home: string | undefined): (string | undefined)[] {
  let here = cwd
  for (const chdir of git.chdirs) here = absolute(chdir, here, home)
  const found: (string | undefined)[] = []
  for (const explicit of [git.gitDir, git.workTree]) {
    if (explicit === undefined) continue
    const path = absolute(explicit, here, home)
    found.push(path)
    if (path !== undefined && path.replace(/\/+$/, '').endsWith('/.git')) found.push(path.replace(/\/+$/, '').slice(0, -5))
  }
  return found.length > 0 ? found : [here]
}

type Finding = { verb: string; target: string | undefined }

// The vault writes one git command makes from each folder it may run in. An
// alias is expanded from the line, or, when the verb is no builtin and the
// command acts on the vault, from the vault's config.
function gitFindings(args: readonly string[], cwds: readonly (string | undefined)[], ctx: VaultContext, get: FactGetter, seen: readonly string[] = []): Finding[] {
  const git = parseGit(args)
  if (git.verb === undefined) return []
  const out: Finding[] = []
  for (const cwd of cwds) {
    const dirs = targetDirs(git, cwd, ctx.home)
    const reals = dirs.map(dir => (dir === undefined ? undefined : realOf(dir, get)))
    const verb = git.verb
    if (isWrite(verb, git.args)) {
      for (const real of reals) if (real === undefined || inside(real, ctx.vault)) out.push({ verb, target: real })
      continue
    }
    if (WRITE_VERBS.has(verb) || seen.includes(verb.toLowerCase())) continue
    const aliased = git.aliases.has(verb.toLowerCase())
    if (!aliased && !reals.some(real => real !== undefined && inside(real, ctx.vault))) continue
    const builtins = get(BUILTINS_KEY)
    if (!aliased && builtins !== null && builtins.split(' ').includes(verb)) continue
    let value: string | null
    if (aliased) value = git.aliases.get(verb.toLowerCase()) ?? null
    else {
      const asked = reals.find(real => real !== undefined && inside(real, ctx.vault)) as string
      const found = get(gitKey('alias', asked, verb))
      if (found === 'none') continue
      value = found === null ? null : found.slice(1)
    }
    if (value === null || value.startsWith('!')) {
      // An alias nobody can read, run in the vault, may be any write.
      for (const real of reals) if (real === undefined || inside(real, ctx.vault)) out.push({ verb: `${verb} (an alias this guard cannot expand)`, target: real })
      continue
    }
    const words = parseShell(value).statements[0]?.words ?? []
    const expanded = [...args.slice(0, git.verbAt), ...words, ...args.slice(git.verbAt + 1)]
    out.push(...gitFindings(expanded, [cwd], ctx, get, [...seen, verb.toLowerCase()]))
  }
  return out
}

// Whether the line names the vault: its path, or the same under ~ or $HOME.
function namesVault(parse: ShellParse, ctx: VaultContext): boolean {
  const spellings = [ctx.vault.toLowerCase()]
  if (ctx.home !== undefined && ctx.vault.toLowerCase().startsWith(`${ctx.home.toLowerCase()}/`)) {
    const rest = ctx.vault.slice(ctx.home.length)
    spellings.push(`~${rest}`.toLowerCase(), `$home${rest}`.toLowerCase(), `\${home}${rest}`.toLowerCase())
  }
  const texts = parse.statements.flatMap(s => [...s.words, ...s.redirects.map(r => r.target)])
  return texts.some(text => spellings.some(spelling => text.toLowerCase().includes(spelling)))
}

const HEAD = 'Vault-git guard (workbench-core): '
const ADVICE =
  "The vault's git belongs to the memory server, which commits on its own deferred queue, so a staged change gets swept into the next unrelated write under that write's message. Use the memory MCP instead: delete, edit, write, append, rename, or git_sync to force a sync. Read-only git in the vault still runs."

const SUBJECT = /(^|[^A-Za-z0-9_.-])git([^A-Za-z0-9_-]|$)/i
const WRITE_WORD = new RegExp(`(^|[^A-Za-z0-9_-])(${[...WRITE_VERBS].join('|')})([^A-Za-z0-9_-]|$)`, 'i')
const mentionsGitWrite = (line: string): boolean => {
  const words = line.replaceAll('\\\n', '').replace(/["'\\]/g, '')
  return SUBJECT.test(words) && WRITE_WORD.test(words)
}

// Whether a line can reach a refusal: it names a git write, or a git verb
// that is no read-only builtin and may be an alias. Read with no fact, so an
// ordinary `git status` costs no process.
export const needsVaultGit = (line: string, parse: ShellParse): boolean =>
  mentionsGitWrite(line) ||
  parse.statements.some(s => {
    if (s.name !== 'git') return false
    const verb = parseGit(s.args).verb
    return verb !== undefined && !GIT_SAFE_VERBS.has(verb)
  })

// The refusal for a Bash line, or undefined. `ctx.vault` is the vault's
// physical path.
export function vaultGitRefusal(line: string, parse: ShellParse, ctx: VaultContext, get: FactGetter): string | undefined {
  const isSubject = mentionsGitWrite(line)
  if (isSubject && line.length > MAX_INPUT) return `${HEAD}this command is longer than 200,000 characters and names a git write, so it could not be read whole. Split it into smaller commands. ${ADVICE}`
  const isLinear = isLinearLine(line)
  let cwds: (string | undefined)[] = [ctx.cwd === undefined ? undefined : realOf(ctx.cwd, get)]
  const findings: Finding[] = []
  for (const s of parse.statements) {
    if (s.nameAt === -1) continue
    if (s.name === 'cd' || s.name === 'pushd' || s.name === 'popd') {
      cwds = cwdsAfter(s, cwds, isLinear, get, ctx.home)
      continue
    }
    if (s.name === 'git') findings.push(...gitFindings(s.args, cwds, ctx, get))
    else if (RUNNERS.has(s.name)) findings.push(...runnerFindings(s, cwds, ctx, get))
  }
  const named = namesVault(parse, ctx)
  const sure = findings.find(f => f.target !== undefined)
  if (sure !== undefined) return `${HEAD}\`git ${sure.verb}\` writes to the memory vault's git, at ${sure.target}. ${ADVICE}`
  const unsure = findings.find(f => f.target === undefined)
  if (unsure !== undefined && named) {
    return `${HEAD}\`git ${unsure.verb}\` writes to a repository this guard cannot place (a variable, a tilde it cannot read, or a cd it cannot follow), and the line names the memory vault. Write the folder out as a literal path. ${ADVICE}`
  }
  const cwdInVault = cwds.some(c => c !== undefined && inside(c, ctx.vault))
  if (isSubject && (named || cwdInVault) && (parse.unknowns.length > 0 || parse.statements.some(s => !s.isPlaced))) {
    return `${HEAD}the shell reader could not read all of this command (an unclosed quote, an escape it does not decode, or a script nested too deep), and it names a git write and the memory vault. Write the command out plainly. ${ADVICE}`
  }
  return undefined
}

// A git command a runner hides in its words.
function runnerFindings(s: Statement, cwds: readonly (string | undefined)[], ctx: VaultContext, get: FactGetter): Finding[] {
  const out: Finding[] = []
  // `find -execdir` runs in each found file's folder: the folders it searches.
  const execdir = s.args.includes('-execdir') || s.args.includes('-okdir')
  const firstOption = s.args.findIndex(a => a.startsWith('-'))
  const roots = execdir ? s.args.slice(0, firstOption === -1 ? s.args.length : firstOption) : []
  const where = execdir ? cwds.flatMap(c => (roots.length === 0 ? [c] : roots.map(r => absolute(r, c, ctx.home)))) : cwds
  for (let i = 0; i < s.args.length; i++) {
    if (nameOf(s.args[i] as string) === 'git') out.push(...gitFindings(s.args.slice(i + 1), where, ctx, get))
  }
  return out
}
