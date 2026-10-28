import type { WorkbenchShellParse as ShellParse } from '../../types'
import { SQL_FILE_CAP } from './destructive-database.ts'
import type { Fact, FactGetter, ScopeContext, ScopeVerdict } from './destructive-scope.ts'
import { dirKey, getterOf, needsScope, scopeVerdict, stepOf } from './destructive-scope.ts'

export type FactHost = {
  run: (argv: readonly string[]) => Promise<{ exitCode: number; stdout: string }>
  isFile: (path: string) => Promise<boolean>
  root: string
}

export type ScopeSession = { cwd: () => Promise<string>; ids: () => Promise<{ sessionId: string; project: string }> }

const MAX_FACT_ROUNDS = 400

async function gitFact(host: FactHost, question: string, dir: string, arg: string): Promise<Fact> {
  const git = (argv: readonly string[]) => host.run(['git', ...argv])
  switch (question) {
    case 'builtins': {
      const { exitCode, stdout } = await git(['--list-cmds=builtins'])
      const names = stdout.split(/\s+/).filter(Boolean)
      return exitCode === 0 && names.length > 0 ? names.join(' ') : null
    }
    case 'top': {
      const { exitCode, stdout } = await git(['-C', dir, 'rev-parse', '--show-toplevel'])
      return exitCode === 0 ? stdout.trim() : ''
    }
    case 'tracked': {
      const { exitCode } = await git(['-C', dir, 'ls-files', '--error-unmatch', '--', arg])
      return exitCode === 0 ? 'yes' : exitCode === 1 ? 'no' : null
    }
    case 'commit': {
      const { exitCode } = await git(['-C', dir, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${arg}^{commit}`])
      return exitCode === 0 ? 'yes' : 'no'
    }
    case 'remotes': {
      const { exitCode, stdout } = await git(['-C', dir, 'for-each-ref', '--format=%(refname)', `refs/remotes/*/${arg}`])
      return exitCode === 0 ? String(stdout.split(/\s+/).filter(Boolean).length) : null
    }
    case 'alias': {
      const { exitCode, stdout } = await git(['-C', dir, 'config', '--get', `alias.${arg}`])
      return exitCode === 1 ? 'none' : exitCode === 0 ? `=${stdout.replace(/\n$/, '')}` : null
    }
    default:
      return null
  }
}

export async function answerFact(host: FactHost, key: string): Promise<Fact> {
  const [kind = '', a = '', b = '', c = ''] = key.split('\t')
  const facts = (argv: readonly string[]) => host.run(['bash', `${host.root}/hooks/lib/scope-facts.sh`, ...argv])
  switch (kind) {
    case 'dir': {
      const { stdout } = await facts(['dir', a])
      const path = stdout.replace(/\n$/, '')
      return path.startsWith('/') ? path : null
    }
    case 'entry': {
      const { stdout } = await facts(['entry', a])
      return stdout.trim() === '' ? null : stdout.trim()
    }
    case 'name': {
      const { stdout } = await facts(['name', a, b])
      const name = stdout.replace(/\n$/, '')
      return name === '' || name.includes('\n') ? null : name
    }
    case 'file': {
      if (!(await host.isFile(a).catch(() => false))) return null
      const { exitCode, stdout } = await host.run(['head', '-c', String(SQL_FILE_CAP), '--', a])
      return exitCode === 0 ? stdout : null
    }
    case 'git':
      return gitFact(host, a, b, c)
    default:
      return null
  }
}

export async function settled<T>(host: FactHost, judge: (get: FactGetter) => T): Promise<T> {
  const answers = new Map<string, Fact>()
  for (let round = 0; round < MAX_FACT_ROUNDS; round++) {
    const step = stepOf(() => judge(getterOf(answers)))
    if ('value' in step) return step.value
    answers.set(step.need, await answerFact(host, step.need))
  }
  throw new Error('workbench guards: too many facts')
}

export async function scopeRootsOf(host: FactHost, sessionId: string, projectRoot: string): Promise<{ project: Fact; roots: string[]; fields: string[][] }> {
  const { stdout } = await host.run(['bash', `${host.root}/hooks/lib/scope-facts.sh`, 'roots', sessionId])
  const fields = stdout
    .split('\n')
    .map(row => row.split('\t'))
    .filter(([, path]) => path?.startsWith('/'))
  const project = await answerFact(host, dirKey(projectRoot))
  return { project, roots: fields.filter(([kind]) => kind === 'root').map(([, path]) => path as string), fields }
}

export async function scopeOf(host: FactHost, line: string, parse: ShellParse, home: string | undefined, session: ScopeSession): Promise<ScopeVerdict> {
  if (!needsScope(line, parse)) return { kind: 'none' }
  const cwd = await session.cwd()
  const bare: ScopeContext = { cwd, home, roots: [], tmp: undefined, markers: undefined }
  const quick = stepOf(() => scopeVerdict(line, parse, bare, getterOf(new Map())))
  if ('value' in quick) return quick.value
  const { sessionId, project: projectRoot } = await session.ids()
  const { project, roots, fields } = await scopeRootsOf(host, sessionId, projectRoot)
  const ctx: ScopeContext = {
    cwd,
    home,
    roots: [...new Set([...(project !== null && project !== '/' ? [project] : []), ...roots])],
    tmp: fields.find(([kind]) => kind === 'tmp')?.[1],
    markers: fields.find(([kind]) => kind === 'markers')?.[1],
  }
  return settled(host, get => scopeVerdict(line, parse, ctx, get))
}
