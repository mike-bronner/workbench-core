import type { WorkbenchCallerLane as CallerLane, WorkbenchShellParse as ShellParse, WorkbenchShellStatement as Statement, WorkbenchShellUnknown } from '../../types'
import { expandingOf } from './shell'

export type Caller = { lane: CallerLane | undefined; isUnattended: boolean }

type Op = 'commit' | 'push' | 'merge'

export type Refusal = { deny: string }

type Found = {
  ops: Set<Op>
  isForce: boolean
  isHidden: boolean
}

const W = '[^A-Za-z0-9_.-]'
const SEG = '[^;&|\\n]'
const GIT_OP = `git${W}(?:${SEG}*[^A-Za-z0-9_-])?(commit|push)(?:$|[^A-Za-z0-9_-])`
const MERGE_OP = `gh${W}(?:${SEG}*[^A-Za-z0-9_-])?(?:pr\\s+merge|api${W}${SEG}*pulls/[^\\s/]+/merge|api${W}${SEG}*repos/\\S+/merges)(?:$|[^A-Za-z0-9_/-])`
const MENTION = new RegExp(`(?:^|${W})(?:${GIT_OP}|${MERGE_OP})`, 'im')
const FORCE_TEXT = new RegExp(
  `(?:^|${W})git${W}(?:${SEG}*[^A-Za-z0-9_-])?push${SEG}*\\s(?:--(?:forc|m|de|pru)|-[A-Za-z0-9]*[fd]|[+:]\\S)`,
  'im',
)
const LOOSE = /commit|push|merge/i

const READERS: ReadonlySet<string> = new Set([
  'echo', 'printf', 'cat', 'head', 'tail', 'wc', 'ls', 'grep', 'egrep', 'fgrep', 'rg', 'jq', 'cd', 'pwd', 'true',
  'false', 'test', '[', '[[', '((', ':', 'printenv', 'basename', 'dirname', 'realpath', 'readlink', 'stat', 'file',
  'which', 'type', 'command', 'diff', 'cmp', 'comm', 'cut', 'tr', 'sort', 'uniq', 'column', 'nl', 'tee', 'mkdir',
  'touch', 'rm', 'rmdir', 'mv', 'cp', 'ln', 'chmod', 'date', 'sleep', 'export', 'local', 'declare', 'readonly',
  'unset', 'set',
])

const ASK_STRIPPED: ReadonlySet<string> = new Set(['timeout', 'time', 'nice', 'nohup', 'stdbuf', 'command', 'builtin', 'noglob'])

const BUILT_NAME = /[{}*?[\]]|^=/

const SEARCHERS: ReadonlySet<string> = new Set(['grep', 'egrep', 'fgrep', 'rg'])
const TEXT_TOOLS: ReadonlySet<string> = new Set(['grep', 'egrep', 'fgrep', 'cut', 'head', 'tail', 'wc', 'tr', 'cat'])
const SORT_ARG = /^(?:[^-].*|-|--|-[bcCdfghiMnrRsuVz]*(?:[kt].+)?)$/
const UNIQ_ARG = /^-[cdDiuz]+$/
const RG_ARG = /^(?:[^-].*|-|--|-[nioFwcHlLsSvxINU]+)$/

const isQuietTool = (s: Statement): boolean =>
  TEXT_TOOLS.has(s.name) ||
  (s.name === 'sort' && s.args.every(arg => SORT_ARG.test(arg))) ||
  (s.name === 'uniq' && s.args.every(arg => UNIQ_ARG.test(arg))) ||
  (s.name === 'rg' && s.args.every(arg => RG_ARG.test(arg)))

const SED_ADDRESS = String.raw`(?:\d+(?:~\d+)?|\$|/(?:[^/\\\n]|\\.)*/[IM]*)`
const SED_PRINTS = new RegExp(String.raw`^(?:\s*(?:${SED_ADDRESS}(?:\s*,\s*(?:${SED_ADDRESS}|[+~]\d+))?)?\s*!?\s*[p=l]\s*(?:;|\n|$))+\s*$`)
const SED_QUIET = /^(?:-[nEr]*n[nEr]*|--quiet|--silent)$/
const SED_READ_OPTION = /^(?:-[nEr]+|--quiet|--silent|--regexp-extended)$/

function isPrintingSed(s: Statement): boolean {
  if (s.name !== 'sed' || !s.args.some(arg => SED_QUIET.test(arg))) return false
  const scripts: string[] = []
  let hasExpression = false
  let operands = 0
  for (let i = 0; i < s.args.length; i++) {
    const arg = s.args[i] ?? ''
    if (arg === '-e' || arg === '--expression') {
      hasExpression = true
      const script = s.args[++i]
      if (script === undefined) return false
      scripts.push(script)
    } else if (arg.startsWith('--expression=')) {
      hasExpression = true
      scripts.push(arg.slice('--expression='.length))
    } else if (arg.startsWith('-') && arg !== '-') {
      if (!SED_READ_OPTION.test(arg)) return false
    } else if (!hasExpression && operands++ === 0) {
      scripts.push(arg)
    }
  }
  return scripts.length > 0 && scripts.every(script => SED_PRINTS.test(script))
}

const AWK_PRINT = /^\{\s*print(?:\s+\$[0-9]+(?:\s*,\s*\$[0-9]+)*)?\s*;?\s*\}$/

const awkProgramOf = (args: readonly string[]): string | undefined => {
  if (args.length === 1) return args[0]
  if (args.length === 2 && /^-F./.test(args[0] ?? '')) return args[1]
  return args.length === 3 && args[0] === '-F' ? args[2] : undefined
}

const runsOrWrites = (s: Statement): boolean =>
  (s.name === 'rg' && s.args.some(arg => arg.startsWith('--pre') || arg.startsWith('--hostname-bin'))) ||
  (s.name === 'sort' && !s.args.every(arg => SORT_ARG.test(arg))) ||
  (s.name === 'uniq' && s.args.filter(arg => !/^-./.test(arg)).length > 1)

const isLoopHead = (s: Statement): boolean =>
  s.name === 'for' && s.words[s.nameAt] === 'for' && s.assignments.length === 0 && s.wrappers.length === 0 &&
  /^[A-Za-z_]\w*$/.test(s.args[0] ?? '') && (s.args.length === 1 || s.args[1] === 'in')

const isReader = (s: Statement): boolean => (READERS.has(s.name) && !runsOrWrites(s)) || isEditOnly(s) || isLoopHead(s)

const runsNothing = (s: Statement): boolean =>
  s.nameAt >= 0 &&
  s.wrappers.length === 0 &&
  s.assignments.length === 0 &&
  s.isPlaced &&
  ((isQuietTool(s) && isReader(s)) || isPrintingSed(s) || (s.name === 'awk' && AWK_PRINT.test(awkProgramOf(s.args) ?? '')))

const PLAIN_TOOLS: ReadonlySet<string> = new Set(['grep', 'egrep', 'fgrep', 'column', 'head', 'tail', 'wc', 'cut', 'nl', 'tr', 'cat'])
const UNIQ_READ_ARG = /^(?:-[cdDiuz]+|-[fsw]\d+)$/

const isQuietRedirect = (s: Statement): boolean => s.redirects.every(r => !r.op.includes('>') || r.target === '/dev/null' || (r.op.endsWith('&') && /^(?:\d+|-)$/.test(r.target)))

function isReadOnlyStage(s: Statement): boolean {
  if (s.nameAt < 0 || s.wrappers.length > 0 || s.assignments.length > 0 || !s.isPlaced || s.heredocs.length > 0 || s.escaped.length > 0) return false
  if (s.words[s.nameAt] !== s.name || !isQuietRedirect(s)) return false
  if (PLAIN_TOOLS.has(s.name)) return true
  if (s.name === 'rg') return !runsOrWrites(s) && !s.args.some(arg => /^--search-zip|^-[A-Za-z]*z/.test(arg))
  if (s.name === 'sort') return s.args.every(arg => SORT_ARG.test(arg))
  if (s.name === 'uniq') return s.args.every(arg => UNIQ_READ_ARG.test(arg) || !arg.startsWith('-')) && s.args.filter(arg => !arg.startsWith('-')).length <= 1
  if (s.name === 'awk') return AWK_PRINT.test(awkProgramOf(s.args) ?? '')
  return isPrintingSed(s)
}

export const isReadOnlyPipeline = (parse: ShellParse): boolean =>
  parse.unknowns.length === 0 && parse.statements.length > 0 && parse.statements.every(isReadOnlyStage) && parse.statements.some(s => SEARCHERS.has(s.name))

const withoutComments = (text: string): string =>
  text
    .split('\n')
    .filter(line => !/^\s*(?:#|\/\/)/.test(line))
    .join('\n')

const opsIn = (text: string): Op[] => {
  const ops: Op[] = []
  const match = new RegExp(MENTION.source, 'gim')
  for (const m of text.matchAll(match)) ops.push(m[1] === undefined ? 'merge' : (m[1].toLowerCase() as Op))
  return ops
}

function configOf(args: readonly string[], end: number): { key: string; value: string }[] {
  const config: { key: string; value: string }[] = []
  for (let i = 0; i < end; i++) {
    const arg = args[i] ?? ''
    const pair = arg === '-c' ? args[++i] : arg.startsWith('-c') ? arg.slice(2) : undefined
    if (pair === undefined) continue
    const at = pair.indexOf('=')
    config.push({ key: (at < 0 ? pair : pair.slice(0, at)).toLowerCase(), value: at < 0 ? '' : pair.slice(at + 1) })
  }
  return config
}

const isBuilt = (word: string): boolean => word.includes('$')

const GLOBAL_VALUES: ReadonlySet<string> = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path', '-R', '--repo',
])

const carriesValue = (arg: string): boolean =>
  [...GLOBAL_VALUES].some(o => (o.startsWith('--') ? arg.startsWith(`${o}=`) : arg.startsWith(o) && arg.length > o.length))

function decidesBuilt(s: Statement): boolean {
  const at = s.subcommandAt
  const end = at < 0 ? s.args.length : Math.min(s.args.length, at + 1)
  for (let i = 0; i < end; i++) {
    const arg = s.args[i] ?? ''
    if (i < at && GLOBAL_VALUES.has(arg)) {
      i++
      continue
    }
    if (i < at && carriesValue(arg)) continue
    if (isBuilt(arg)) return true
  }
  return false
}

const GH_API_VALUES: ReadonlySet<string> = new Set([
  '-f', '--raw-field', '-F', '--field', '-H', '--header', '-X', '--method', '--input', '-q', '--jq', '-t', '--template',
  '--cache', '-p', '--preview', '--hostname',
])

function apiWordsOf(rest: readonly string[]): { methods: string[]; positionals: string[] } {
  const methods: string[] = []
  const positionals: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? ''
    if (arg === '--') {
      positionals.push(...rest.slice(i + 1))
      break
    }
    const cluster = /^-[A-Za-z]*X(.*)$/.exec(arg)
    if (arg === '--method') methods.push(rest[++i] ?? '')
    else if (arg.startsWith('--method=')) methods.push(arg.slice('--method='.length))
    else if (cluster && !arg.startsWith('--')) methods.push(cluster[1] === '' ? (rest[++i] ?? '') : (cluster[1] ?? '').replace(/^=/, ''))
    else if (GH_API_VALUES.has(arg)) i++
    else if (!arg.startsWith('-')) positionals.push(arg)
  }
  return { methods, positionals }
}

function builtMerge(rest: readonly string[]): boolean {
  const { methods, positionals } = apiWordsOf(rest)
  if (!positionals.some(isBuilt)) return false
  const isBuiltFlag = positionals.length > 1
  return isBuiltFlag || methods.some(m => isBuilt(m) || m.toUpperCase() === 'PUT')
}

export const MERGE_MUTATION = /mergePullRequest|enablePullRequestAutoMerge|mergeBranch/i

export function isUnreadGraphql(s: Statement, rest: readonly string[]): boolean {
  if (!rest.some(word => /graphql/i.test(word))) return false
  const isStdin = (word: string, next: string | undefined) => (word === '--input' && next === '-') || word === '--input=-' || /(^|=)@-$/.test(word)
  const isFile = (word: string, next: string | undefined) =>
    (word === '--input' && next !== '-') || (/^--input=/.test(word) && word !== '--input=-') || /(^|=)@(?!-$)/.test(word)
  if (rest.some((word, i) => isFile(word, rest[i + 1]))) return true
  const expanding = expandingOf(s)
  if (s.words.some((word, at) => at > s.nameAt && (expanding === undefined ? /[$`]/.test(word) : expanding.includes(at)))) return true
  return rest.some((word, i) => isStdin(word, rest[i + 1])) && s.heredocs.length === 0
}

const isForceArg = (arg: string): boolean => /^--(?:forc|m|de|pru)/i.test(arg) || /^-[A-Za-z0-9]*[fd]/.test(arg) || /^[+:]\S/.test(arg)

const SED_FLAGS = /^[gIipM0-9]*$/
const PERL_FLAGS = /^[gimsxonrcadlu]*$/
const PERL_RUNS_CODE = /\(\?\??\{|\(\*\{|`/
const PERL_SAFE_REPLACEMENT = /^(?:[^$@]|\$(?:\d+|&))*$/
const PERL_PATTERN_VARIABLE = /[$@][A-Za-z_{:#$[]/
const unescaped = (text: string): string => text.replace(/\\[\s\S]/g, '')

function substitutionsOnly(script: string, program: 'sed' | 'perl'): boolean {
  let i = 0
  let count = 0
  const skip = () => {
    while (i < script.length && /[\s;]/.test(script[i] ?? '')) i++
  }
  const part = (delimiter: string): string | undefined => {
    let text = ''
    while (i < script.length) {
      const c = script[i] ?? ''
      if (c === '\\') {
        text += c + (script[i + 1] ?? '')
        i += 2
        continue
      }
      i++
      if (c === delimiter) return text
      text += c
    }
    return undefined
  }
  skip()
  while (i < script.length) {
    const command = program === 'perl' && script.startsWith('tr', i) ? 'tr' : (script[i] ?? '')
    if (command !== 's' && command !== 'y' && command !== 'tr') return false
    i += command.length
    const delimiter = script[i] ?? ''
    if (delimiter === '' || /[A-Za-z0-9\s\\(){}[\]<>]/.test(delimiter)) return false
    i++
    const pattern = part(delimiter)
    const replacement = pattern === undefined ? undefined : part(delimiter)
    if (pattern === undefined || replacement === undefined) return false
    const flags = /^[A-Za-z]*/.exec(script.slice(i))?.[0] ?? ''
    i += flags.length
    if (!(program === 'sed' ? SED_FLAGS : PERL_FLAGS).test(flags)) return false
    if (program === 'perl' && command === 's' && PERL_RUNS_CODE.test(pattern + replacement)) return false
    if (program === 'perl' && command === 's' && !PERL_SAFE_REPLACEMENT.test(unescaped(replacement))) return false
    if (program === 'perl' && command === 's' && PERL_PATTERN_VARIABLE.test(unescaped(pattern))) return false
    count++
    skip()
  }
  return count > 0
}

const SED_OPTION = /^(?:-[EnrsuzI]+|-i.*|--in-place(?:=.*)?|--regexp-extended|--quiet|--silent|--)$/
const PERL_OPTION = /^(?:-[pinlaw0-9]*[eE]?|-i[^-]*|--)$/

function isEditOnly(s: Statement): boolean {
  if (s.name !== 'sed' && s.name !== 'perl') return false
  const program = s.name
  const scripts: string[] = []
  let pending = false
  for (let i = 0; i < s.args.length; i++) {
    const arg = s.args[i] ?? ''
    if (pending) {
      scripts.push(arg)
      pending = false
      continue
    }
    if (program === 'sed' && (arg === '-e' || arg === '--expression')) pending = true
    else if (program === 'sed' && arg.startsWith('--expression=')) scripts.push(arg.slice('--expression='.length))
    else if (program === 'sed' && arg === '-i' && s.args[i + 1] === '') i++
    else if (arg.startsWith('-')) {
      if (!(program === 'sed' ? SED_OPTION : PERL_OPTION).test(arg)) return false
      if (program === 'perl' && /[eE]$/.test(arg)) pending = true
    } else if (program === 'sed' && scripts.length === 0 && !s.args.slice(0, i).some(a => a === '-e' || a.startsWith('--expression'))) {
      scripts.push(arg)
    }
  }
  return !pending && scripts.length > 0 && scripts.every(script => substitutionsOnly(script, program))
}

type Read = { ops: Op[]; isForce: boolean; isHidden: boolean; code: string[]; isUnread: boolean }

function readGit(s: Statement): Read {
  const read: Read = { ops: [], isForce: false, isHidden: false, code: [], isUnread: false }
  const args = s.args
  if (s.name === 'git-commit' || s.name === 'git-push') {
    read.ops.push(s.name === 'git-commit' ? 'commit' : 'push')
    read.isForce = s.name === 'git-push' && args.some(isForceArg)
    return read
  }
  const at = s.subcommandAt
  const config = configOf(args, at < 0 ? args.length : at)
  read.code.push(...config.map(c => c.value))
  if (decidesBuilt(s) || config.some(c => isBuilt(c.key))) read.isUnread = true
  if (config.some(c => /^remote\..*\.(?:mirror|push)$/.test(c.key))) read.isForce = true
  if (args.some(arg => arg.startsWith('--config-env'))) read.isUnread = true
  if (at < 0) {
    if (s.wrappers.includes('xargs')) read.isUnread = true
    return read
  }
  let sub = (args[at] ?? '').toLowerCase()
  let rest = args.slice(at + 1)
  const alias = config.find(c => c.key === `alias.${sub}`)
  if (alias !== undefined) {
    read.isHidden = true
    if (isBuilt(alias.value)) read.isUnread = true
    if (alias.value.trimStart().startsWith('!')) {
      read.code.push(alias.value)
      return read
    }
    const words = alias.value.trim().split(/\s+/)
    sub = (words[0] ?? '').toLowerCase()
    rest = [...words.slice(1), ...rest]
  }
  if (sub === 'grep' && rest.some(arg => arg.startsWith('-O') || arg.startsWith('--open-files'))) {
    read.code.push(...rest.map(arg => arg.replace(/^(?:-O|--open-files[a-z-]*=?)/, ' ')))
  }
  if (sub === 'commit' || sub === 'push') read.ops.push(sub)
  if (sub === 'push' && rest.some(isForceArg)) read.isForce = true
  return read
}

function readGh(s: Statement): Read {
  const read: Read = { ops: [], isForce: false, isHidden: false, code: [], isUnread: false }
  const at = s.subcommandAt
  if (decidesBuilt(s)) read.isUnread = true
  if (at < 0) return read
  const sub = (s.args[at] ?? '').toLowerCase()
  const rest = s.args.slice(at + 1)
  if (sub === 'pr' && isBuilt(rest[0] ?? '')) read.isUnread = true
  if (sub === 'pr' && rest.some(arg => arg.toLowerCase() === 'merge')) read.ops.push('merge')
  const isLiteralMerge = sub === 'api' && rest.some(arg => /pulls\/[^\s/]+\/merge(?![A-Za-z0-9_/-])/i.test(arg) || /(?:^|\/)repos\/\S+\/merges(?:\?|$)/i.test(arg))
  if (sub === 'api' && isUnreadGraphql(s, rest)) read.ops.push('merge')
  if (sub === 'api' && [...rest, ...s.heredocs.map(h => h.body)].some(word => MERGE_MUTATION.test(word))) {
    read.ops.push('merge')
    read.isHidden = true
  }
  if (isLiteralMerge) read.ops.push('merge')
  if (sub === 'api' && !isLiteralMerge && builtMerge(rest)) {
    read.ops.push('merge')
    read.isHidden = true
  }
  return read
}

function isPlain(s: Statement): boolean {
  const named = s.words[s.nameAt] ?? ''
  const escapedAt = new Set(s.escaped)
  const lastRead = s.nameAt + 1 + Math.max(s.subcommandAt, 0)
  for (let i = s.nameAt; i <= lastRead; i++) if (escapedAt.has(i)) return false
  return s.assignments.length === 0 && s.wrappers.every(w => ASK_STRIPPED.has(w)) && s.source === 'line' && s.depth === 0 && named === s.name
}

export function findOps(parse: ShellParse, line: string): Found {
  const found: Found = { ops: new Set(), isForce: false, isHidden: false }
  const add = (ops: Iterable<Op>, isHidden: boolean) => {
    for (const op of ops) {
      found.ops.add(op)
      if (isHidden) found.isHidden = true
    }
  }
  const all: Op[] = ['commit', 'push', 'merge']
  if (isReadOnlyPipeline(parse)) return found

  const isUnread = parse.unknowns.length > 0 || parse.statements.some(s => !s.isPlaced)
  if (isUnread && LOOSE.test(line)) {
    add(all.filter(op => new RegExp(op, 'i').test(line)), true)
    if (FORCE_TEXT.test(line.replace(/\\\n/g, '').replace(/["'\\]/g, ''))) found.isForce = true
  }

  const readerText: string[] = []
  let hasRunner = false
  const isSearchOnly = parse.statements.every(runsNothing)
  for (const s of parse.statements) {
    const heredocs = s.heredocs.filter(h => !h.feedsShell).map(h => h.body)
    const code = (texts: readonly string[]) => {
      const text = withoutComments(texts.join('\n'))
      add(opsIn(text), true)
      if (FORCE_TEXT.test(text)) found.isForce = true
    }
    if (s.nameAt < 0) {
      readerText.push(...s.assignments, ...heredocs)
      continue
    }
    if (s.name === 'git' || s.name === 'git-commit' || s.name === 'git-push' || s.name === 'gh') {
      const read = s.name === 'gh' ? readGh(s) : readGit(s)
      add(read.ops, read.isHidden || !isPlain(s))
      if (read.isForce) found.isForce = true
      if (read.isUnread) add(all, true)
      if (read.code.length > 0) {
        hasRunner = true
        code(read.code)
      }
      readerText.push(...s.assignments, ...heredocs)
      continue
    }
    if (BUILT_NAME.test(s.name) || s.escaped.includes(s.nameAt)) {
      hasRunner = true
      code([s.words.slice(s.nameAt).join(' '), ...heredocs])
      if (LOOSE.test(s.words.join(' '))) add(all.filter(op => new RegExp(op, 'i').test(s.words.join(' '))), true)
      continue
    }
    if (isReader(s)) {
      readerText.push(...(SEARCHERS.has(s.name) && isSearchOnly ? [] : s.args), ...s.assignments, ...heredocs)
    } else if (isPrintingSed(s)) {
      hasRunner = true
      readerText.push(...(isSearchOnly ? [] : s.args), ...s.assignments, ...heredocs)
    } else {
      hasRunner = true
      code([...s.args, ...heredocs])
      readerText.push(...s.assignments)
    }
  }
  if (hasRunner) {
    const text = withoutComments(readerText.join('\n'))
    add(opsIn(text), false)
    if (FORCE_TEXT.test(text)) found.isForce = true
  }
  return found
}

const READS =
  'A command that only reads or quotes these words, such as git log --grep, a grep, rg or sed -n for them, or a heredoc of notes, is not refused here. The code of a program such as node -e or python3 -c is refused when it names them, even in a quote, because the guard cannot tell a quote there from a call. Read or count that text with grep or the Read tool. If any other read was refused, report it as a guard defect, and use the Read tool for the file meanwhile.'

const refusal = (line: string, why: string): Refusal => ({ deny: `🛑 Blocked: ${line}\n\nCommit guard (workbench-core). ${why}` })

export const FORCE_REFUSAL = refusal(
  'a push that forces or deletes.',
  'Pushes that force or delete remote refs are refused outright, and no approval changes that. Push without the force or delete, or ask Mike to do it.',
)

export const MERGE_REFUSAL = refusal(
  'a sub-agent or the pipeline does not merge a pull request.',
  `Merging is Mike's own step, after review. Report that the pull request is ready to merge, and stop. Do not look for another route to a merge. ${READS}`,
)

export const SUBAGENT_REFUSAL = refusal(
  'a sub-agent does not commit or push.',
  `Leave the working tree uncommitted. Report the diff and a proposed commit message to the session that dispatched you. Do not ask to commit. Do not look for another route to a commit or push. ${READS}`,
)

export const PLAIN_REFUSAL = refusal(
  'run the commit, push, or merge as a plain line, so you are asked.',
  'The permission rules that prompt Mike match a plain git or gh line, and they miss one behind a wrapper such as env or sudo, a leading NAME=value, bash -c, eval, a substitution, a path, an escape, or an alias, and one inside a program or a line the guard cannot read. Run it as git commit …, git push …, or gh pr merge …, with git -C <dir> for a directory and git -c <key>=<value> for configuration. Drop a variable prefix such as HUSKY=0. If the line only quotes these words in the code of a program such as node -e, the guard cannot tell that from a call either. Read or count that text with grep or the Read tool.',
)

export const BUILT_REFUSAL = refusal(
  'a command name the guard cannot read, from a sub-agent or an unattended run.',
  'The command this line runs is named by a variable or a substitution, or the guard cannot read the whole line: a wrapper option it cannot place, a quote, substitution, heredoc, array or case it cannot close, an escape it cannot decode, a script piped into a shell, or scripts nested past four levels. So the guard cannot tell whether it commits, pushes, or merges. Name the program in plain words, such as python3 script.py rather than "$PY" script.py, and write the line so every quote, substitution, heredoc, array and case closes plainly. Do not look for another spelling.',
)

export const FAILED_REFUSAL = refusal(
  'a call the commit guard could not judge.',
  'The guard failed while reading this command, so it refuses it rather than let a commit, push, or merge through unread. Report this to Mike as a guard defect. Do not try another spelling.',
)

const EVERY_UNKNOWN: Record<WorkbenchShellUnknown, true> = {
  quote: true, substitution: true, heredoc: true, escape: true, wrapper: true, expansion: true, stdin: true, depth: true, compound: true,
}
export const HIDES_NAME = Object.keys(EVERY_UNKNOWN) as readonly WorkbenchShellUnknown[]
const hasBuiltName = (parse: ShellParse): boolean =>
  parse.unknowns.some(u => HIDES_NAME.includes(u)) || parse.statements.some(s => !s.isPlaced)

export function commitVerdict(parse: ShellParse, line: string, caller: Caller): Refusal | undefined {
  const found = findOps(parse, line)
  const isUnwatched = caller.lane === 'sub-agent' || caller.lane === undefined || caller.isUnattended
  if (found.isForce) return FORCE_REFUSAL
  if (found.ops.has('merge') && (caller.lane !== 'main' || caller.isUnattended)) return MERGE_REFUSAL
  const writes = found.ops.has('commit') || found.ops.has('push')
  if (writes && caller.lane !== 'main' && caller.lane !== 'top-level-agent') return SUBAGENT_REFUSAL
  if (found.ops.size > 0 && found.isHidden) return PLAIN_REFUSAL
  if (isUnwatched && hasBuiltName(parse)) return BUILT_REFUSAL
  return undefined
}
