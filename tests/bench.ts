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
    wroteThrough: [],
    store: new Map(Object.entries(options.store ?? {})),
    runs: [],
    scripts: {},
    calls: [],
    clock: mock.clock(on, { now: START }),
  }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: sessionId }))
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
    if (e.argv[0] === 'rm') {
      b.files.delete(e.argv[e.argv.length - 1] ?? '')
      b.links.delete(e.argv[e.argv.length - 1] ?? '')
      if (e.argv[1] === '-rf') b.dirs.delete(e.argv[e.argv.length - 1] ?? '')
      b.afterRm?.()
      return { value: ran('') }
    }
    const name = (e.argv[1] ?? '').split('/').pop() ?? ''
    const script = b.scripts[name]
    if (script === undefined) throw new Error(`no script ${name}`)
    return { value: ran(script(e.argv)) }
  })
  on('ui.status', ($, e) => {
    b.lines.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    b.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    b.opened.push({ id: e.id, title: e.title })
    return { value: { isPlaced: true } }
  })
  on('tool.call', ($, e) => {
    // What the gates' `[ -f ] && [ ! -L ]` reads: a regular file, no link.
    b.calls.push({ tool: e.tool, legacyExists: b.files.has(LEGACY) && !b.links.has(LEGACY) })
    return { result: {} as never }
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
