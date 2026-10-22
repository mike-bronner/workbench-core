// The world beneath workbench-core's hooks module for the workbench tests:
// the noun, the toggle, the commands and the status line. The test's hooks
// stand for the engine, so what they answer is the session, the file system,
// the store, the clock and the scripts the module runs.

import { mock } from 'claude-code/testing'
import type { Engine, MockClock, Plugin } from 'claude-code/testing'
import type { On, PromptOrigin } from 'claude-code'

export const SID = '0f3c2a1e-5b7d-4c9e-8a6f-1d2e3f4a5b6c'
export const HOME = '/Users/tester'
export const STATE_DIR = `${HOME}/.claude-workbench/orchestrator-mode`
export const LEGACY = `${STATE_DIR}/${SID}`
export const NOTICES = `${HOME}/.claude-workbench/warmup-notices.md`
export const DAY = 24 * 60 * 60 * 1000
// When the bench's clock starts, and so when the session starts.
export const START = 100 * DAY

// What a script the module runs prints, by the script's file name.
type Script = (argv: readonly string[]) => string

export type Bench = {
  // Each status line drawn, whole. Undefined is a clear.
  lines: (string | undefined)[]
  toasts: string[]
  opened: { id: string; title?: string }[]
  registered: string[]
  files: Map<string, string>
  // Each file's mtime, in ms: a write stamps the clock's time.
  mtimes: Map<string, number>
  // Paths that are symbolic links. A link's target is never in files, so a
  // link here is a dangling one unless the test also puts its path in files.
  links: Set<string>
  // Each write that landed on a symbolic link, and so went wherever it points.
  wroteThrough: string[]
  // Paths that are directories.
  dirs: Set<string>
  // What $.fs.stat reports a path leads to, where that is no regular file:
  // `other` for a FIFO, a socket or a device, `dir` for a folder. A path in
  // `links` too is a symbolic link to such a thing.
  kinds: Map<string, 'dir' | 'other'>
  // Runs after each `rm`, as something racing the module would.
  afterRm?: () => void
  // The module's $.store.
  store: Map<string, unknown>
  // Each command the module ran, argv whole.
  runs: (readonly string[])[]
  scripts: Record<string, Script>
  // Each tool call that reached the engine, and whether the legacy toggle
  // file existed at that moment: what the bash gates beneath would read.
  calls: { tool: string; legacyExists: boolean }[]
  // Each tool call that reached the engine, its input whole.
  inputs: Record<string, unknown>[]
  // The label Mike picks in each AskUserQuestion dialog: every question of the
  // call is answered with it. Undefined dismisses the dialog.
  pick?: string
  // More fields of the dialog's result, such as afkTimeoutMs.
  dialog: Record<string, unknown>
  // The repository `git -C <dir> rev-parse` reads, by directory: HEAD, and
  // what @{push} points at. A directory not here, or a field left out, makes
  // git fail, as outside a repository or with no push target.
  repos: Record<string, { head?: string; pushed?: string; branch?: string | null; originHead?: string; originUrl?: string }>
  trees: Record<string, string | null>
  shown?: string
  permissionBeneath: Record<string, unknown>
  // What each Bash call that reaches the engine does, such as moving a repo's
  // HEAD as a commit would, and whether it reports an error.
  onBash?: (command: string) => { isError?: boolean } | void
  duringBash?: (command: string) => Promise<void>
  hangDialog?: boolean
  answerAfterMs?: number
  // A deny from beneath the module, as a settings rule or a person would give:
  // the reason for a call this refuses, else undefined.
  denyBeneath?: (tool: string) => string | undefined
  // What $.session.cwd and $.session.root answer (default /repo).
  cwd: string
  root: string
  // A file system and a git the test models (tests/world.ts), asked before
  // the bench's own: undefined passes the call on to the bench.
  run?: (argv: readonly string[]) => { exitCode: number; stdout: string } | undefined
  stat?: (path: string) => { kind: 'file' | 'dir' | 'other'; isLink: boolean; realPath?: string } | null | undefined
  // What the engine's own permission decision answers to tool.check, beneath
  // the module (default ask, as for a Bash call no rule allows).
  decision: 'allow' | 'ask' | 'deny'
  clock: MockClock
}

export type BenchOptions = {
  env?: Record<string, string>
  store?: Record<string, unknown>
  sessionId?: string
  files?: Record<string, string>
  // When the given files were last written (default: the clock's start).
  mtime?: number
  // Makes every $.store.get reject, as a store that cannot be read.
  storeFails?: boolean
  // Makes $.store.set reject for these keys, as a store that cannot be written.
  storeSetFails?: readonly string[]
}

const ran = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

export function bench(on: On, options: BenchOptions = {}): Bench {
  const sessionId = options.sessionId ?? SID
  mock.env(on, options.env ?? { HOME })
  const b: Bench = {
    lines: [],
    toasts: [],
    opened: [],
    registered: [],
    files: new Map(Object.entries(options.files ?? {})),
    mtimes: new Map(Object.keys(options.files ?? {}).map(path => [path, options.mtime ?? START])),
    links: new Set(),
    dirs: new Set(),
    kinds: new Map(),
    wroteThrough: [],
    store: new Map(Object.entries(options.store ?? {})),
    runs: [],
    scripts: {},
    calls: [],
    inputs: [],
    dialog: {},
    repos: {},
    trees: {},
    permissionBeneath: {},
    cwd: '/repo',
    root: '/repo',
    decision: 'ask',
    clock: mock.clock(on, { now: START }),
  }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: sessionId }))
  on('session.cwd', () => ({ value: b.cwd }))
  on('session.root', () => ({ value: b.root }))
  const dialogs = new Map<string, string>()
  on('tool.check', ($, e) => {
    if (e.tool_use_id !== undefined) dialogs.set(e.tool_use_id, JSON.stringify([e.tool, e.input]))
    return { decision: b.decision }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.register', ($, e) => {
    b.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('store.get', ($, e) => {
    if (options.storeFails) throw new Error('store unreadable')
    return { value: b.store.get(e.key) }
  })
  on('store.set', ($, e) => {
    if (options.storeSetFails?.includes(e.key)) throw new Error('store unwritable')
    b.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: b.files.has(e.path) }))
  on('fs.read', ($, e) => {
    const text = b.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    if (b.links.has(e.path)) {
      b.wroteThrough.push(e.path)
      return { value: undefined }
    }
    if (b.dirs.has(e.path)) throw new Error(`EISDIR: ${e.path}`)
    b.files.set(e.path, e.text)
    b.mtimes.set(e.path, b.clock.now())
    return { value: undefined }
  })
  on('fs.stat', ($, e) => {
    const modeled = b.stat?.(e.path)
    if (modeled === null) throw new Error(`ENOENT: ${e.path}`)
    if (modeled !== undefined) return { value: { ...modeled, size: 0, mtimeMs: 0 } }
    const kind = b.kinds.get(e.path)
    if (kind !== undefined) return { value: { kind, size: 0, mtimeMs: 0, isLink: b.links.has(e.path) } }
    if (!b.files.has(e.path)) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file' as const, size: (b.files.get(e.path) ?? '').length, mtimeMs: b.mtimes.get(e.path) ?? 0, isLink: b.links.has(e.path) } }
  })
  on('fs.list', ($, e) => {
    const dir = `${e.path.replace(/\/+$/, '')}/`
    const names = new Set([...b.files.keys(), ...b.links, ...b.dirs].filter(path => path.startsWith(dir) && !path.slice(dir.length).includes('/')))
    return {
      value: [...names].map(path => ({
        name: path.slice(dir.length),
        kind: b.links.has(path) ? ('other' as const) : b.dirs.has(path) ? ('dir' as const) : ('file' as const),
        size: 0,
        mtimeMs: b.mtimes.get(path) ?? 0,
        isLink: b.links.has(path),
      })),
    }
  })
  on('process.run', ($, e) => {
    b.runs.push(e.argv)
    const modeled = b.run?.(e.argv)
    if (modeled !== undefined) return { value: { ...ran(modeled.stdout), exitCode: modeled.exitCode } }
    if (e.argv[0] === 'git' && e.argv[1] === '-C' && e.argv[3] === 'status') {
      const tree = b.trees[e.argv[2] ?? '']
      return { value: tree === null ? { ...ran(''), exitCode: 128 } : ran(tree ?? '') }
    }
    // With no modeled world, the destructive-scope guard's facts say that
    // nothing but the filesystem root exists, and git answers nothing.
    if ((e.argv[1] ?? '').endsWith('/scope-facts.sh')) return { value: ran(e.argv[2] === 'dir' && e.argv[3] === '/' ? '/\n' : e.argv[2] === 'entry' ? 'missing\n' : '') }
    const gitAt = e.argv[0] === 'git' && e.argv[1] === '-C' ? b.repos[e.argv[2] ?? ''] : undefined
    const branchRef = (repo: Bench['repos'][string]) => (repo.branch === null ? undefined : `refs/heads/${repo.branch ?? 'main'}`)
    const verb = e.argv.slice(3).join(' ')
    const answer = (out: string | undefined) => ({ value: out === undefined ? { ...ran(''), exitCode: 1 } : ran(`${out}\n`) })
    if (gitAt !== undefined && verb === 'rev-parse --show-toplevel') return answer(e.argv[2])
    if (gitAt !== undefined && verb === 'config --get remote.origin.url') return answer(gitAt.originUrl)
    if (gitAt !== undefined && verb === 'symbolic-ref -q HEAD') return answer(branchRef(gitAt))
    if (gitAt !== undefined && verb === 'symbolic-ref -q refs/remotes/origin/HEAD') return answer(gitAt.originHead === undefined ? undefined : `refs/remotes/origin/${gitAt.originHead}`)
    if (gitAt !== undefined && verb === 'worktree list --porcelain') {
      const blocks = Object.entries(b.repos).map(([dir, repo]) => [`worktree ${dir}`, `HEAD ${repo.head ?? '0'}`, branchRef(repo) === undefined ? 'detached' : `branch ${branchRef(repo)}`].join('\n'))
      return answer(blocks.join('\n\n'))
    }
    if (e.argv[0] === 'git' && !(e.argv[1] === '-C' && e.argv[3] === 'rev-parse' && ['HEAD', '@{push}'].includes(e.argv.at(-1) ?? ''))) return { value: { ...ran(''), exitCode: 128 } }
    if (e.argv[0] === 'rm') {
      b.files.delete(e.argv[e.argv.length - 1] ?? '')
      b.links.delete(e.argv[e.argv.length - 1] ?? '')
      if (e.argv[1] === '-rf') b.dirs.delete(e.argv[e.argv.length - 1] ?? '')
      b.afterRm?.()
      return { value: ran('') }
    }
    if (e.argv[0] === 'git' && e.argv[1] === '-C' && e.argv[3] === 'rev-parse') {
      const repo = b.repos[e.argv[2] ?? '']
      const value = e.argv[e.argv.length - 1] === 'HEAD' ? repo?.head : repo?.pushed
      return { value: value === undefined ? { ...ran(''), exitCode: 1 } : ran(`${value}\n`) }
    }
    const name = (e.argv[1] ?? '').split('/').pop() ?? ''
    const script = b.scripts[name]
    if (script === undefined) throw new Error(`no script ${name}`)
    return { value: ran(script(e.argv)) }
  })
  on('state.set', ($, e, next) => {
    if (e.plugin === 'workbench-core' && e.key === 'statusLine') b.lines.push(e.value ?? undefined)
    return next(e)
  })
  on('ui.toast', ($, e) => {
    b.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    b.opened.push({ id: e.id, title: e.title })
    return { value: { isPlaced: true } }
  })
  on('tool.call', async ($, e) => {
    dialogs.delete(e.tool_use_id)
    // What the gates' `[ -f ] && [ ! -L ]` reads: a regular file, no link.
    b.calls.push({ tool: e.tool, legacyExists: b.files.has(LEGACY) && !b.links.has(LEGACY) })
    b.inputs.push({ ...e })
    if (e.tool === 'AskUserQuestion') {
      if (b.hangDialog === true) return new Promise<never>(() => undefined)
      if (b.answerAfterMs !== undefined) await b.clock.sleep(b.answerAfterMs)
      if (b.pick === undefined) throw new Error('dismissed')
      const pick = b.pick
      const answers = Object.fromEntries(e.questions.map(question => [question.question, pick]))
      return { result: { questions: e.questions, answers, ...b.dialog } as never }
    }
    const denied = b.denyBeneath?.(e.tool)
    if (denied !== undefined) return { deny: denied }
    if (e.tool === 'Bash') await b.duringBash?.(e.command)
    if (e.tool === 'Bash' && b.onBash?.(e.command)?.isError) return { isError: true, result: 'exit 1', text: 'exit 1' }
    return { result: {} as never }
  })
  // No message holds a call here, so the question rule lets every
  // AskUserQuestion through: tests/question-rule.test.ts covers the rule.
  on('session.messages', () => {
    if (b.shown === undefined) return { value: [] } as never
    const call = { type: 'tool_use', id: b.store.get('tool_use_id'), name: 'Bash', input: {} }
    return { value: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }, { role: 'assistant', content: [{ type: 'text', text: b.shown }, call] }] } as never
  })
  on('classic.PermissionRequest', ($, e) => {
    const id = [...dialogs].find(([, call]) => call === JSON.stringify([e.tool_name, e.tool_input]))?.[0]
    const isDialog = id !== undefined && dialogs.delete(id)
    const beneath = b.permissionBeneath as { decision?: unknown }
    return (isDialog && beneath.decision === undefined ? { ...beneath, decision: { behavior: 'allow' } } : beneath) as never
  })
  return b
}

// The last line drawn.
export const lastLine = (b: Bench): string | undefined => b.lines[b.lines.length - 1]

export const start = (isInteractive = true) => ({ cwd: '/repo', surface: isInteractive ? ('terminal' as const) : null, isInteractive })

export const PERSON: PromptOrigin = { kind: 'composer' }

// One run of `/<command> <args>`, as the engine raises it.
export const run = (command: string, args = '', origin: PromptOrigin = PERSON) => ({
  command,
  args,
  origin,
  presentation: { isFullscreen: false, columns: 80 },
})

export const turn = (answer: string, agentId?: string) => ({
  answer,
  durationMs: 1,
  isAborted: false,
  turnId: 't',
  reason: 'answer' as const,
  agentId,
})

// A plugin of another vendor, below this one, that calls $.workbench the way
// workbench-dev-team will, and hands each answer to the test through the
// store: an inline plugin runs in an environment of its own.
export function caller(calls: (on: On) => void): Plugin {
  return { name: 'dev-team-stand-in', tier: 'append', register: calls }
}

// The workbench pane as `surface` draws it: the module's ui.render hook on the
// pane /memory-status and /notices open. Undefined when the drawing holds no
// Markdown element showing `text`.
export async function paneShows($: Engine, surface: 'terminal' | 'desktop', text: string): Promise<boolean> {
  const drawn = await $.ui.mount({
    plugin: 'workbench-core',
    surface,
    component: 'Pane',
    requestId: 'workbench-core',
    props: { title: 'pane', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: {} } as never,
  })
  const isShown = (await drawn.find({ type: 'Markdown', text })) !== undefined
  await drawn.unmount()
  return isShown
}

export async function bandShows($: Engine, text: string, hasSurvey = false): Promise<boolean> {
  const drawn = await $.ui.mount({
    plugin: 'workbench-core',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey, isWorking: false, maxRows: 10, bodyColumns: 75, scroll: {}, view: {} } as never,
  })
  const isShown = (await drawn.find({ type: 'Text', text })) !== undefined
  await drawn.unmount()
  return isShown
}
