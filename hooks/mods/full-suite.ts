import type { WorkbenchShellStatement as Statement } from '../../types'
import { isPartlyRead, resolvePath, statementsAt, textsOf } from './guards.ts'
import { SHELLS, nameOf, parseShell, shellScriptOf } from './shell.ts'

export type Script = { kind: 'text'; text: string } | { kind: 'program' }
export type ScriptReader = (path: string) => Promise<Script | undefined>
type Scope = { cwd: string | undefined; home: string | undefined; pluginRoots: readonly string[]; read: ScriptReader; depth: number; isStrict: boolean; isRunnerOnly: boolean; scriptDir?: string; namesTests?: boolean }

export const HEAD = 'Full-suite gate (workbench-core): '
const ASK = 'whether he runs the suite himself or Holmes runs it, in a dispatch whose brief Goal begins "Final suite run:"'
const NARROW = 'A narrow run stays open to you: name one test file, a filter or one case, or write a script\'s path out in full so this gate can read it.'
const MAIN_ADVICE = `The orchestrator never runs the full suite. Before any Holmes final run, ask Mike ${ASK}. ${NARROW}`
const SUB_AGENT_ADVICE = `A sub-agent never runs the full suite, because only Mike decides who runs it. Stop, and hand back to your orchestrator. The orchestrator asks Mike ${ASK}. ${NARROW}`
const FINAL_RUN_TYPE = /^workbench-dev-team:holmes(?:-(?:local|index))?$/
const GOAL = /^[ \t]*Goal:[ \t]*/i

export function isFinalRunDispatch(type: unknown, prompt: unknown): boolean {
  if (typeof type !== 'string' || !FINAL_RUN_TYPE.test(type) || typeof prompt !== 'string') return false
  const goal = prompt.split('\n').find(line => GOAL.test(line))
  return goal?.replace(GOAL, '').startsWith('Final suite run:') ?? false
}

const MAX_DEPTH = 4
const DIRECT: ReadonlySet<string> = new Set(['pest', 'phpunit', 'paratest', 'pytest', 'py.test', 'vitest', 'jest', 'mocha', 'ava', 'phpspec'])
const FILTERS: ReadonlySet<string> = new Set(['--filter', '-t', '--testNamePattern', '--test-name-pattern', '-k', '-run', '--grep', '-g', '--testPathPattern', '--testPathPatterns'])
const NO_RUN: ReadonlySet<string> = new Set(['--version', '-V', '--help', '-h', '--list-tests', '--collect-only', '--init'])
const CONTAINERS: ReadonlySet<string> = new Set(['docker', 'podman', 'docker-compose', 'podman-compose'])
const DIRECT_RUNNERS: ReadonlySet<string> = new Set(['sail', 'lando'])
const LAUNCHERS: ReadonlySet<string> = new Set(['uv', 'poetry', 'pipenv', 'hatch', 'pdm'])
const CONTAINER_VALUES: ReadonlySet<string> = new Set(['-e', '--env', '--env-file', '-w', '--workdir', '-u', '--user', '-v', '--volume', '--name', '-p', '--publish', '--entrypoint', '--network', '--platform', '-l', '--label', '--mount', '-f', '--file', '--project-name', '--profile', '-c', '--container', '-n', '--namespace'])
const SSH_VALUES: ReadonlySet<string> = new Set(['-p', '-i', '-o', '-l', '-J', '-F', '-b', '-c', '-D', '-E', '-L', '-R', '-S', '-W', '-w', '-m', '-O', '-Q', '-B', '-e', '-I'])
const LAUNCH_VALUES: ReadonlySet<string> = new Set(['-p', '--package', '--with', '--python', '--group', '--extra', '--env-file', '--directory', '--project', '-e', '--env', '--from'])
const OPTION_VALUES: ReadonlySet<string> = new Set(['-c', '--config', '--configuration', '--ignore', '--ignore-glob', '--deselect', '--bootstrap', '--root', '--dir', '-r', '--require', '--rootdir', '--confcutdir', '--testsuite', '--group', '--exclude-group', '--reporter', '--project', '--cov', '--basetemp', '-o', '--override-ini', '--log-junit', '--cache-directory', '--setupFiles', '--environment'])
const PACKAGERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'composer'])
const MAKERS: ReadonlySet<string> = new Set(['make', 'gmake', 'just', 'task'])
const INTERPRETERS: ReadonlySet<string> = new Set(['python', 'node', 'php', 'ruby', 'perl', 'tsx', 'ts-node', 'deno', 'bun'])
const INLINE: Readonly<Record<string, readonly string[]>> = {
  python: ['-c'],
  node: ['-e', '--eval', '-p', '--print'],
  tsx: ['-e', '--eval', '-p', '--print'],
  'ts-node': ['-e', '--eval', '-p', '--print'],
  bun: ['-e', '--eval', '-p', '--print'],
  deno: [],
  php: ['-r'],
  ruby: ['-e'],
  perl: ['-e', '-E'],
}
const NODE_VALUES = ['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--env-file']
const INTERPRETER_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  python: new Set(['-W', '-X']),
  node: new Set(NODE_VALUES),
  tsx: new Set(NODE_VALUES),
  'ts-node': new Set(NODE_VALUES),
  bun: new Set(NODE_VALUES),
  deno: new Set(['-c', '--config', '--import-map', '--lock', '-L', '--log-level', '--location', '--cert']),
  php: new Set(['-c', '-d', '-z', '-S', '-t']),
  ruby: new Set(['-I', '-r', '-C']),
  perl: new Set(),
}
const CLUSTERED_INLINE: Readonly<Record<string, RegExp>> = { perl: /^-[A-Za-z]*[eE]$/, ruby: /^-[A-Za-z]*e$/ }
const PACKAGE_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: new Set(['--prefix', '-w', '--workspace', '-C']),
  pnpm: new Set(['--filter', '-F', '-C', '--dir', '--workspace-concurrency']),
  yarn: new Set(['--cwd']),
  composer: new Set(['-d', '--working-dir']),
}
const EXEC_VERBS: ReadonlySet<string> = new Set(['exec', 'x', 'dlx'])
const RUN_VERBS: ReadonlySet<string> = new Set(['run', 'run-script', 'rum', 'urn'])
const TEST_VERBS: ReadonlySet<string> = new Set(['test', 't', 'tst'])
const TEST_FILE = /(^|\/)(test[-_][^/]*|[^/]*[-_]test|[^/]*\.(test|spec)|[^/]*Test|lint-[^/]*)\.[A-Za-z0-9]+$/
const TEST_WORD = /test|spec|lint/i
const GLOB = /[*?[]/
const SUITE_SCRIPT = /^(test|tests|ci)(:.*)?$/
const MAKE_TARGET = /^(test|check|ci)$/
const BARE_SCRIPT = /^tests?(:.*)?$/
const VERSIONED = /^(python|php|ruby|perl|node)\d[\d.]*$/
const SHELL_SHEBANG = /^#![^\n]*\b(ba|z|da|k)?sh\b/
const RUNNER_MENTION = /\b(pest|phpunit|paratest|pytest|vitest|jest|mocha|artisan test|plugin test|run-tests|npm test|composer test|go test|cargo test)\b|test-\*|lint-\*/i
const HELPER_TAIL = /(\/[^$`*?[\]{}()]+)$/
const KNOWN_PATH = /^\$(?:\{(HOME|CLAUDE_PLUGIN_ROOT)\}|(HOME|CLAUDE_PLUGIN_ROOT))(\/.*)$/

const isTestFile = (word: string): boolean => TEST_FILE.test(word.replace(/::.*$/, '').replace(/(:\d+)+$/, ''))

function isNarrow(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    const at = arg.startsWith('-') ? arg.indexOf('=') : -1
    const flag = at === -1 ? arg : arg.slice(0, at)
    if (FILTERS.has(flag) && (at === -1 ? (args[i + 1] ?? '') : arg.slice(at + 1)) !== '') return true
    if (at === -1 && (FILTERS.has(flag) || OPTION_VALUES.has(flag))) {
      i++
      continue
    }
    if (!arg.startsWith('-') && !GLOB.test(arg) && isTestFile(arg)) return true
  }
  return false
}

function operandAt(args: readonly string[], values: ReadonlySet<string>, from = 0): number {
  for (let i = from; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--') return i + 1 < args.length ? i + 1 : -1
    if (!arg.startsWith('-') || arg === '-') return i
    if (values.has(arg)) i++
  }
  return -1
}

const codeOf = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)(#|\/\/).*$/gm, '$1')
    .replace(/\b(import|export)\b[^;\n]*?\bfrom\s*(['"`])[^'"`\n]*\2/g, ' ')
    .replace(/\bimport\s*(['"`])[^'"`\n]*\1/g, ' ')
    .replace(/\b(require|import)\s*\(\s*(['"`])[^'"`\n]*\2\s*\)/g, ' ')
    .replace(/(^|;)\s*(from\s+\S+\s+)?import\s+[^;\n]*/gm, '$1')

const namesRunner = (text: string): boolean => RUNNER_MENTION.test(codeOf(text))

const bare = (label: string, rest: readonly string[]): string | undefined =>
  isNarrow(rest) || rest.some(arg => NO_RUN.has(arg)) ? undefined : `runs ${label} with no test file, filter or case, which is the whole suite`
const whole = (label: string): string => `runs ${label}, which runs the whole suite`
const dropDashes = (args: readonly string[]): string[] => args.filter(arg => arg !== '--')

function packageFinding(name: string, all: readonly string[], scope: Scope): Promise<string | undefined> | string | undefined {
  const at = operandAt(all, PACKAGE_VALUES[name] ?? new Set())
  const args = at === -1 ? [] : name === 'yarn' && all[at] === 'workspace' ? all.slice(at + 2) : all.slice(at)
  const verb = args[0] ?? ''
  if (EXEC_VERBS.has(verb)) return commandFinding(dropDashes(args.slice(1)), scope)
  const isRun = RUN_VERBS.has(verb)
  const script = isRun ? (args[1] ?? '') : TEST_VERBS.has(verb) ? 'test' : name !== 'npm' && BARE_SCRIPT.test(verb) ? verb : ''
  if (SUITE_SCRIPT.test(script)) return bare(`${name} ${isRun ? `${verb} ${script}` : verb}`, dropDashes(args.slice(isRun ? 2 : 1)))
  if (!isRun && name !== 'npm' && DIRECT.has(nameOf(verb))) return commandFinding(args, scope)
  return undefined
}

function launcherArgs(args: readonly string[]): string[] {
  const at = operandAt(args, LAUNCH_VALUES)
  return at === -1 ? [] : args.slice(at)
}

function interpreterFinding(name: string, label: string, args: readonly string[], scope: Scope, statement?: Statement): Promise<string | undefined> | string | undefined {
  const inline = args.findIndex(arg => INLINE[name]?.includes(arg) || CLUSTERED_INLINE[name]?.test(arg))
  const first = operandAt(args, INTERPRETER_VALUES[name] ?? new Set())
  if (inline !== -1 && (first === -1 || inline < first)) return mentionFinding(`${label} ${args[inline]}`, args[inline + 1] ?? '')
  if (name === 'python') {
    const module = args.indexOf('-m')
    if (module !== -1 && (first === -1 || module < first)) {
      const target = args[module + 1] ?? ''
      return target === 'pytest' || target === 'unittest' ? bare(`${label} -m ${target}`, args.slice(module + 2)) : undefined
    }
  }
  const stdin = [...(statement?.heredocs.map(doc => doc.body) ?? []), ...(statement?.redirects.filter(r => r.isReal && r.op === '<<<').map(r => r.target) ?? [])].join('\n')
  if (first === -1 || args[first] === '-') return mentionFinding(`${label} -`, stdin)
  const target = args[first] as string
  const runner = nameOf(target)
  if (DIRECT.has(runner)) return bare(`${label} ${target}`, args.slice(first + 1))
  if (runner === 'artisan') return args[first + 1] === 'test' ? bare(`${label} ${target} test`, args.slice(first + 2)) : undefined
  if (name === 'node' && args.slice(0, first).includes('--test')) return bare('node --test', args.filter(arg => arg !== '--test'))
  if ((name === 'deno' || name === 'bun') && target === 'run') {
    const at = operandAt(args, INTERPRETER_VALUES[name] ?? new Set(), first + 1)
    const file = at === -1 ? '' : (args[at] as string)
    if (name === 'bun' && !file.includes('/') && !/\.[A-Za-z0-9]+$/.test(file)) return SUITE_SCRIPT.test(file) ? bare(`bun run ${file}`, dropDashes(args.slice(at + 1))) : undefined
    return file === '' || scope.isRunnerOnly ? undefined : scriptFinding(file, 'other', scope)
  }
  if (name === 'deno' || name === 'bun' || scope.isRunnerOnly) return undefined
  return scriptFinding(target, 'other', scope)
}

function containerCommand(name: string, args: readonly string[]): readonly string[] | undefined {
  const rest = CONTAINERS.has(name) && args[0] === 'compose' ? args.slice(1) : args
  const verb = operandAt(rest, CONTAINER_VALUES)
  if (verb === -1 || (rest[verb] !== 'exec' && rest[verb] !== 'run')) return undefined
  const target = operandAt(rest, CONTAINER_VALUES, verb + 1)
  return target === -1 ? undefined : rest.slice(target + 1)
}

function wrappedCommand(name: string, args: readonly string[]): readonly string[] | undefined {
  if (CONTAINERS.has(name)) return containerCommand(name, args)
  if (DIRECT_RUNNERS.has(name)) return args
  if (name === 'ddev') return args[0] === 'exec' ? args.slice(1) : args
  if (name === 'wp-env') return args[0] === 'run' ? args.slice(2) : undefined
  if (name === 'kubectl') return args.includes('--') ? args.slice(args.indexOf('--') + 1) : undefined
  if (name === 'ssh') {
    const host = operandAt(args, SSH_VALUES)
    return host === -1 ? undefined : args.slice(host + 1)
  }
  if (name === 'watch') {
    const at = operandAt(args, new Set(['-n', '--interval', '-d']))
    return at === -1 ? undefined : args.slice(at)
  }
  if (name === 'parallel') {
    const at = operandAt(args, new Set(['-j', '--jobs']))
    const end = args.indexOf(':::')
    return at === -1 ? undefined : args.slice(at, end === -1 ? undefined : end)
  }
  if (name === 'find') {
    const at = args.findIndex(arg => arg === '-exec' || arg === '-execdir' || arg === '-ok' || arg === '-okdir')
    if (at === -1) return undefined
    const end = args.findIndex((arg, i) => i > at && (arg === ';' || arg === '+'))
    return args.slice(at + 1, end === -1 ? undefined : end)
  }
  return undefined
}

function runnerFinding(words: readonly string[], scope: Scope): Promise<string | undefined> | string | undefined {
  const inner = { ...scope, isRunnerOnly: true }
  if (words.length === 1 && /\s/.test(words[0] as string)) return lineFinding(words[0] as string, inner)
  return words.length === 0 ? undefined : commandFinding(words, inner)
}

async function commandFinding(words: readonly string[], scope: Scope, statement?: Statement): Promise<string | undefined> {
  const word = words[0] ?? ''
  const name = nameOf(word).replace(VERSIONED, '$1')
  const args = words.slice(1)
  if (DIRECT.has(name)) return bare(word, args)
  if (name === 'artisan') return args[0] === 'test' ? bare(`${word} test`, args.slice(1)) : undefined
  if (name === 'node' && args.includes('--test') && operandAt(args, INTERPRETER_VALUES.node as ReadonlySet<string>) === -1) return bare('node --test', args.filter(arg => arg !== '--test'))
  if ((name === 'bun' || name === 'deno' || name === 'go') && args[0] === 'test') return bare(`${name} test`, args.slice(1))
  if (name === 'cargo' && args[0] === 'test') {
    const rest = args.slice(1, args.includes('--') ? args.indexOf('--') : undefined)
    return rest.some(arg => !arg.startsWith('-')) ? undefined : whole('cargo test')
  }
  if (name === 'claude' && args.includes('plugin') && args[args.indexOf('plugin') + 1] === 'test') return whole('claude plugin test')
  if (name === 'sail' && args[0] === 'test') return bare('sail test', args.slice(1))
  if (MAKERS.has(name)) {
    const target = args.find(arg => !arg.startsWith('-') && !arg.includes('=') && MAKE_TARGET.test(arg))
    return target === undefined ? undefined : whole(`${name} ${target}`)
  }
  if (PACKAGERS.has(name)) return packageFinding(name, args, scope)
  if (name === 'npx' || name === 'bunx' || name === 'pnpx') return commandFinding(launcherArgs(args), scope)
  if (LAUNCHERS.has(name) && args[0] === 'run') return commandFinding(launcherArgs(args.slice(1)), scope)
  if (name === 'eval') return lineFinding(args.join(' '), { ...scope, isRunnerOnly: true })
  const wrapped = wrappedCommand(name, args)
  if (wrapped !== undefined) return runnerFinding(wrapped, scope)
  const shell = SHELLS.has(name) ? shellScriptOf(args) : undefined
  if (shell?.script !== undefined) return lineFinding(shell.script, { ...scope, depth: scope.depth + 1 })
  if (INTERPRETERS.has(name)) return interpreterFinding(name, word, args, scope, statement)
  if (scope.isRunnerOnly) return undefined
  if (shell !== undefined) {
    const file = args.findIndex((arg, i) => !arg.startsWith('-') && !arg.startsWith('+') && !['-o', '+o', '-O', '+O'].includes(args[i - 1] ?? ''))
    if (file !== -1) return scriptFinding(args[file] as string, 'shell', scope)
    if (statement?.heredocs.some(doc => doc.feedsShell) || statement?.redirects.some(r => r.isReal && r.op === '<<<')) return undefined
    const input = statement?.redirects.findLast(r => r.isReal && r.op === '<')
    if (input !== undefined) return scriptFinding(input.target, 'shell', scope)
    if (args.length > 0 && !(shell.readsStdin && args.some(arg => /^-[A-Za-z]*[si][A-Za-z]*$/.test(arg)))) return undefined
    return scope.isStrict ? `runs ${name} on a script from its standard input, which this gate cannot read, so it may run the whole suite` : undefined
  }
  if (name === 'source' || name === '.') return args[0] === undefined ? undefined : scriptFinding(args[0], 'shell', scope)
  if (word.includes('/')) return scriptFinding(word, 'auto', scope)
  return undefined
}

function mentionFinding(label: string, text: string): string | undefined {
  return namesRunner(text) ? `runs ${label} code that names a test runner, which this gate cannot follow, so it may run the whole suite` : undefined
}

function pathsOf(word: string, scope: Scope): string[] {
  const variable = scope.depth === 0 ? KNOWN_PATH.exec(word) : null
  const roots = variable === null ? [''] : (variable[1] ?? variable[2]) === 'HOME' ? [scope.home ?? ''] : scope.pluginRoots
  const paths = roots.flatMap(root => (variable === null ? [word] : root.startsWith('/') ? [root.replace(/\/+$/, '') + variable[3]] : []))
  return [...new Set(paths.flatMap(path => resolvePath(path, scope.cwd, scope.home) ?? []))]
}

export function installPathsOf(registry: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(registry)
  } catch {
    return []
  }
  const plugins = (parsed as { plugins?: unknown } | null)?.plugins
  if (typeof plugins !== 'object' || plugins === null) return []
  return Object.values(plugins).flatMap(installs =>
    Array.isArray(installs) ? installs.flatMap(install => (typeof install?.installPath === 'string' && install.installPath.startsWith('/') ? [install.installPath] : [])) : [],
  )
}

const ancestors = (dir: string | undefined): string[] => {
  const found: string[] = []
  for (let at = dir; at !== undefined && at !== '' && at !== '/' && found.length < 4; at = at.slice(0, at.lastIndexOf('/'))) found.push(at)
  return found
}

async function scriptVerdict(word: string, path: string, script: Script, kind: 'shell' | 'other' | 'auto', scope: Scope): Promise<string | undefined> {
  if (script.kind === 'program') return undefined
  const isShell = kind === 'shell' || (kind === 'auto' && (/\.(sh|bash|zsh)$/.test(path) || !script.text.startsWith('#!') || SHELL_SHEBANG.test(script.text)))
  const inner = { ...scope, depth: scope.depth + 1, isStrict: scope.isStrict && !isTestFile(path), scriptDir: path.slice(0, path.lastIndexOf('/')) }
  const found = isShell ? await lineFinding(script.text, inner) : namesRunner(script.text) ? 'names a test runner, which this gate cannot follow, so it may run the whole suite' : undefined
  return found === undefined ? undefined : `runs ${word}, which ${found}`
}

async function scriptFinding(word: string, kind: 'shell' | 'other' | 'auto', scope: Scope): Promise<string | undefined> {
  const unread = (why: string): string | undefined => (scope.isStrict ? `runs ${word}, ${why}, so it may run the whole suite` : undefined)
  if (scope.depth >= MAX_DEPTH) return unread('a script nested too deep for this gate to follow')
  const paths = pathsOf(word, scope)
  if (paths.length > 0) {
    let isRead = false
    for (const path of paths) {
      const script = await scope.read(path).catch(() => undefined)
      if (script === undefined) continue
      isRead = true
      const found = await scriptVerdict(word, path, script, kind, scope)
      if (found !== undefined) return found
    }
    return isRead ? undefined : unread('a script this gate cannot read')
  }
  const tail = scope.depth === 0 ? undefined : HELPER_TAIL.exec(word)?.[1]
  if (tail === undefined || isTestFile(tail)) return scope.depth === 0 || scope.namesTests ? unread('a script whose path this gate cannot resolve') : undefined
  for (const base of [...ancestors(scope.scriptDir), ...ancestors(scope.cwd)]) {
    const script = await scope.read(base + tail).catch(() => undefined)
    if (script !== undefined) return scriptVerdict(word, base + tail, script, kind, scope)
  }
  return undefined
}

function runsEach(statements: readonly Statement[], loop: Statement): boolean {
  const item = loop.args[0] ?? ''
  const isItem = (word: string): boolean => word === `$${item}` || word === `\${${item}}`
  return statements.slice(statements.indexOf(loop) + 1).some(s => {
    const words = s.words.slice(Math.max(s.nameAt, 0))
    const name = nameOf(words[0] ?? '').replace(VERSIONED, '$1')
    const runs = SHELLS.has(name) || INTERPRETERS.has(name) || name === 'source' || name === '.'
    return isItem(words[0] ?? '') || (runs && words.slice(1).some(isItem))
  })
}

async function lineFinding(line: string, scope: Scope): Promise<string | undefined> {
  const parse = parseShell(line)
  const namesTests = textsOf(parse).some(text => TEST_WORD.test(text))
  for (const { statement, dir } of statementsAt(parse, scope.cwd as string, scope.home)) {
    if (statement.nameAt === -1) continue
    if (statement.name === 'for' || statement.name === 'select') {
      const glob = statement.args.find(arg => GLOB.test(arg) && isTestFile((arg.replace(/\/+$/, '').split('/').pop() ?? '').replace(/[*?]|\[[^\]]*\]/g, 'x')))
      if (glob !== undefined && runsEach(parse.statements, statement)) return `loops over every file ${glob} matches, which is the whole suite`
      continue
    }
    const found = await commandFinding(statement.words.slice(statement.nameAt), { ...scope, cwd: dir, namesTests }, statement)
    if (found !== undefined) return found
  }
  return scope.depth > 0 && scope.isStrict && isPartlyRead(parse) && textsOf(parse).some(text => RUNNER_MENTION.test(text))
    ? 'holds a line this gate cannot read whole and names a test runner, so it may run the whole suite'
    : undefined
}

const PLACE_OPTIONS = /^(-C|-d|-w|--chdir|--prefix|--working-dir|--cwd|--dir|--directory|--rootdir|--root|--project|--workdir|--workspace)(=|$)/

const SELECTION_OPTIONS =
  /^(--(group|exclude-group|testsuite|test-suite|suite|shard|filter|only|grep|invert|testNamePattern|test-name-pattern|testPathPattern|testPathPatterns|testPathIgnorePatterns|exclude|deselect|ignore|ignore-glob|lf|last-failed|ff|failed-first|changed|onlyChanged|only-changed|since|related|findRelatedTests|project|selectProjects|tags?|markers?|keyword|skip|bail|dirty|retry-failed)(=|$)|-[tkg])/
const SCRIPT_VERBS: ReadonlySet<string> = new Set(['test', 'tests', 'run', 'run-script', 't', 'tst', 'ci', 'check', 'artisan'])

const isInsideTop = (path: string, top: string): boolean =>
  !path.startsWith('~') && !path.split('/').includes('..') && (!path.startsWith('/') || path.startsWith(`${top.replace(/\/+$/, '')}/`))

function isWholeShape(st: Statement, top: string): boolean {
  const { args } = st
  const isTop = (word: string): boolean => word === '.' || word === './' || word.replace(/\/+$/, '') === top.replace(/\/+$/, '')
  if (st.name === 'claude') return args.length === 3 && args[0] === 'plugin' && args[1] === 'test' && isTop(args[2] as string)
  const name = st.name.replace(VERSIONED, '$1')
  const isShell = SHELLS.has(name)
  const scriptAt = isShell || INTERPRETERS.has(name) ? args.findIndex(arg => !arg.startsWith('-')) : -1
  if (isShell && (scriptAt !== 0 || args.length !== 1)) return false
  return args.every((arg, at) => {
    if (arg.startsWith('-')) return !SELECTION_OPTIONS.test(arg) && !PLACE_OPTIONS.test(arg) && !arg.includes('/')
    if (at === scriptAt) return isInsideTop(arg, top)
    return !DIRECT.has(name) && SCRIPT_VERBS.has(arg)
  })
}

function plainRunOf(line: string, top: string): Statement | undefined {
  const parse = parseShell(line)
  const [only] = parse.statements
  if (parse.statements.length !== 1 || only === undefined || parse.unknowns.length > 0 || parse.hasSubshell || parse.feeds.length > 0 || only.heredocs.length > 0) return undefined
  if (only.nameAt !== 0 || only.assignments.length > 0 || only.wrappers.length > 0 || only.escaped.length > 0 || !only.isPlaced) return undefined
  if (only.words.some(word => word.includes('$')) || only.redirects.some(redirect => redirect.op.startsWith('<'))) return undefined
  if (/[|&;`]/.test(line.replace(/[0-9]?[<>]&[0-9-]?|&>>?/g, ''))) return undefined
  return isWholeShape(only, top) ? only : undefined
}

export async function isWholeRun(line: string, top: string, home: string | undefined, pluginRoots: readonly string[], read: ScriptReader): Promise<boolean> {
  if (plainRunOf(line, top) === undefined) return false
  return (await lineFinding(line, { cwd: top, home, pluginRoots, read, depth: 0, isStrict: false, isRunnerOnly: false })) !== undefined
}

export const SUITE_PARTS_FILE = '.workbench/suite-parts.json'

export type SuiteParts = { parts: string[]; whole?: string; files: string[] }

const relativeOf = (path: string, top: string): string | undefined => {
  const base = `${top.replace(/\/+$/, '')}/`
  const relative = (path.startsWith('/') ? (path.startsWith(base) ? path.slice(base.length) : undefined) : path)?.replace(/^(\.\/)+/, '')
  return relative === undefined || relative === '' || relative.split('/').some(step => step === '..' || step === '.' || step === '') ? undefined : relative
}

function scriptOf(st: Statement, top: string): string | undefined | null {
  const name = st.name.replace(VERSIONED, '$1')
  if (SHELLS.has(name) || INTERPRETERS.has(name)) return relativeOf(st.args.find(arg => !arg.startsWith('-')) ?? '', top) ?? null
  const word = st.words[st.nameAt] ?? ''
  return word.includes('/') ? (relativeOf(word, top) ?? null) : undefined
}

export function suitePartsOf(text: string, top: string): SuiteParts | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const { parts, whole, files = [] } = (parsed ?? {}) as { parts?: unknown; whole?: unknown; files?: unknown }
  if (!Array.isArray(parts) || parts.length === 0 || !parts.every(part => typeof part === 'string')) return undefined
  if (!Array.isArray(files) || !files.every(file => typeof file === 'string')) return undefined
  if (whole !== undefined && typeof whole !== 'string') return undefined
  const runs = parts.map(part => plainRunOf(part, top))
  const keys = runs.map(run => run?.words.join('\0'))
  if (!keys.every(key => key !== undefined) || new Set(keys).size !== keys.length) return undefined
  const wholeRun = whole === undefined ? undefined : plainRunOf(whole, top)
  if (whole !== undefined && (wholeRun === undefined || keys.includes(wholeRun.words.join('\0')))) return undefined
  const scripts = [...runs, ...(wholeRun === undefined ? [] : [wholeRun])].map(run => (run === undefined ? null : scriptOf(run, top)))
  const named = files.map(file => relativeOf(file, top))
  if (scripts.includes(null) || named.includes(undefined)) return undefined
  const paths = [SUITE_PARTS_FILE, ...named, ...scripts].filter((path): path is string => typeof path === 'string')
  return { parts: keys as string[], ...(wholeRun === undefined ? {} : { whole: wholeRun.words.join('\0') }), files: [...new Set(paths)] }
}

export function partOf(line: string, top: string, parts: readonly string[]): string | undefined {
  const key = plainRunOf(line, top)?.words.join('\0')
  return key !== undefined && parts.includes(key) ? key : undefined
}

export async function suiteRefusal(line: string, cwd: string, home: string | undefined, pluginRoots: readonly string[], read: ScriptReader, isSubAgent = false): Promise<string | undefined> {
  const found = await lineFinding(line, { cwd, home, pluginRoots, read, depth: 0, isStrict: true, isRunnerOnly: false })
  return found === undefined ? undefined : `${HEAD}this call ${found}. ${isSubAgent ? SUB_AGENT_ADVICE : MAIN_ADVICE}`
}
