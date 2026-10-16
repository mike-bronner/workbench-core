import type { WorkbenchShellParse as ShellParse } from '../../types'
import { MAX_INPUT, isPartlyRead, textsOf } from './guards'
import { SHELLS, nameOf, parseShell, shellScriptOf } from './shell'

const HEAD = 'False-bare guard (workbench-core): '
const REASON =
  'core.bare = true tells git that a repository has no working tree. Set on a repository that has one, every git command in it fails with "this operation must be run in a work tree", and no work there can be committed. ' +
  'On 2026-10-16 that flag, written into a checkout\'s shared .git/config, stopped all git work in it. ' +
  'Leave core.bare as it is. If a repository really must become bare, stop and ask Mike, who runs the command himself with the ! prefix.'

const CONFIG_VALUE_FLAGS: ReadonlySet<string> = new Set(['-f', '--file', '--blob', '--type', '--default', '--comment', '--value'])
const CONFIG_NON_SETS: ReadonlySet<string> = new Set([
  '--get', '--get-all', '--get-regexp', '--get-urlmatch', '--get-color', '--get-colorbool', '-l', '--list', '--unset', '--unset-all', '--remove-section', '--rename-section', '-e', '--edit',
])
const CONFIG_NON_SET_VERBS: ReadonlySet<string> = new Set(['get', 'list', 'unset', 'remove-section', 'rename-section', 'edit'])
const FALSE_VALUES: ReadonlySet<string> = new Set(['false', 'no', 'off', '0', ''])
const RUNNERS: ReadonlySet<string> = new Set([
  'docker', 'docker-compose', 'podman', 'podman-compose', 'kubectl', 'ssh', 'sail', 'lando', 'ddev', 'wp-env', 'xargs', 'find', 'parallel', 'watch', 'eval',
])
const SUBJECT = /core\.bare/i
const GIT_VALUE_FLAGS: ReadonlySet<string> = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source', '--super-prefix'])
const INIT_VALUE_FLAGS: ReadonlySet<string> = new Set(['--template', '--separate-git-dir', '-b', '--initial-branch', '--object-format', '--ref-format'])

export function setsBareTrue(configArgs: readonly string[]): boolean {
  const flags: string[] = []
  const words: string[] = []
  for (let i = 0; i < configArgs.length; i++) {
    const arg = configArgs[i] as string
    if (arg === '--') {
      words.push(...configArgs.slice(i + 1))
      break
    }
    if (!arg.startsWith('-')) {
      words.push(arg)
      continue
    }
    const name = arg.split('=')[0] as string
    flags.push(name)
    if (!arg.includes('=') && CONFIG_VALUE_FLAGS.has(name)) i++
  }
  if (flags.some(flag => CONFIG_NON_SETS.has(flag))) return false
  if (words[0] === 'set') words.shift()
  else if (CONFIG_NON_SET_VERBS.has(words[0] ?? '')) return false
  const [key, value] = words
  return key?.toLowerCase() === 'core.bare' && value !== undefined && !FALSE_VALUES.has(value.toLowerCase())
}

type GitCall = { chdirs: string[]; gitDir?: string; isBare: boolean; verb?: string; args: string[] }

function gitCallOf(args: readonly string[]): GitCall {
  const call: GitCall = { chdirs: [], isBare: false, args: [] }
  let i = 0
  for (; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--') {
      i++
      break
    }
    if (!arg.startsWith('-')) break
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg : arg.slice(0, eq)
    if (name === '--bare') call.isBare = true
    if (!GIT_VALUE_FLAGS.has(name)) continue
    const value = eq === -1 ? args[++i] : arg.slice(eq + 1)
    if (value === undefined) break
    if (name === '-C') call.chdirs.push(value)
    if (name === '--git-dir') call.gitDir = value
  }
  call.verb = args[i]
  call.args = args.slice(i + 1)
  return call
}

const GIT_WORD = /git/i

const gitDirOf = (assignments: readonly string[]): string | undefined =>
  assignments.filter(a => a.startsWith('GIT_DIR=')).at(-1)?.slice('GIT_DIR='.length)

const isGitFolder = (path: string | undefined): boolean => path?.replace(/\/+$/, '').split('/').pop() === '.git'

function initDirOf(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--') return args[i + 1]
    if (!arg.startsWith('-')) return arg.replace(/\/+$/, '') === '.' ? undefined : arg
    if (!arg.includes('=') && INIT_VALUE_FLAGS.has(arg)) i++
  }
  return undefined
}

function reinitsGitFolder(call: GitCall): boolean {
  if (call.verb !== 'init' || !(call.isBare || call.args.includes('--bare'))) return false
  const dir = initDirOf(call.args)
  return isGitFolder(call.gitDir) || isGitFolder(dir) || (dir === undefined && isGitFolder(call.chdirs.at(-1)))
}

function bareOf(words: readonly string[], assignments: readonly string[] = []): string | undefined {
  if (nameOf(words[0] ?? '') !== 'git') return undefined
  const call = gitCallOf(words.slice(1))
  call.gitDir ??= gitDirOf(assignments)
  if (call.verb === 'config' && setsBareTrue(call.args)) return 'this command sets core.bare to true'
  if (reinitsGitFolder(call)) return 'this command runs git init --bare on a .git folder, which writes core.bare = true into it'
  return undefined
}

function bareFinding(parse: ShellParse, depth: number): string | undefined {
  if (depth > 4) return undefined
  for (const statement of parse.statements) {
    if (statement.nameAt === -1) continue
    const words = statement.words.slice(statement.nameAt)
    if (!words.some(word => GIT_WORD.test(word.replace(/["'\\]/g, '')))) continue
    const found = bareOf(words, statement.assignments)
    if (found !== undefined) return found
    if (!RUNNERS.has(statement.name)) continue
    for (let i = 1; i < words.length; i++) {
      const rest = words.slice(i)
      const inner = bareOf(rest)
      if (inner !== undefined) return inner
      const first = rest[0] as string
      const script = SHELLS.has(nameOf(first)) ? shellScriptOf(rest.slice(1)).script : undefined
      const nested = script !== undefined ? bareFinding(parseShell(script), depth + 1) : undefined
      if (nested !== undefined) return nested
      const spaced = /\s/.test(first) ? bareFinding(parseShell(first), depth + 1) : undefined
      if (spaced !== undefined) return spaced
    }
  }
  return undefined
}

export function bareSetRefusal(line: string, parse: ShellParse = parseShell(line)): string | undefined {
  const isSubject = SUBJECT.test(line) || textsOf(parse).some(text => SUBJECT.test(text))
  if (isSubject && line.length > MAX_INPUT) return `${HEAD}this command is longer than 200,000 characters and names core.bare, so it could not be read whole. Split it into smaller commands. ${REASON}`
  const found = bareFinding(parse, 0)
  if (found !== undefined) return `${HEAD}${found}. ${REASON}`
  if (isSubject && isPartlyRead(parse)) return `${HEAD}the shell reader could not read all of this command, and it names core.bare. Write the command out plainly. ${REASON}`
  return undefined
}

export const repairedNotice = (repo: string): string =>
  `False-bare guard: ${repo} had core.bare = true in its git config, so git refused to work there. It is set back to false.`

export const runsGit = (parse: ShellParse): boolean => parse.statements.some(s => s.name === 'git')
