// The world beneath workbench-core's hooks module for the memory features: the
// log checkpoint, the capture checkpoint, recall, the learnings merge and the
// intake nudge. The test's hooks stand for the engine, so what they answer is
// the session, the scripts, the memory MCP server and the model.

import { mock } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { ModelForkResult, On, PromptOrigin, SessionMessage } from 'claude-code'

export const HOME = '/Users/tester'
export const SID = '0f3c2a1e-5b7d-4c9e-8a6f-1d2e3f4a5b6c'
export const TRANSCRIPT = `${HOME}/.claude/projects/-repo/${SID}.jsonl`
export const VAULT = `${HOME}/Documents/Claude/Memory`
export const SERVER = 'plugin:workbench-core:memory'
// 2026-10-07T12:00:00Z, so a capture is dated 2026-10-07.
export const NOW = Date.UTC(2026, 9, 7, 12)

export type Run = { argv: readonly string[]; stdin?: string; env?: Record<string, string>; timeoutMs?: number }

// One row of a memory MCP search result, as the server returns it.
export type Row = { path: string; title?: string; score: number; search_type?: string; frontmatter?: Record<string, unknown>; sections?: { content: string }[] }

export type World = {
  // The session id $.session.id() answers. A /clear moves it on.
  sid: string
  runs: Run[]
  // What a script prints, by its file name. An Error makes the run reject.
  scripts: Record<string, (run: Run) => string | Error>
  files: Map<string, string>
  toasts: string[]
  logs: string[]
  // The memory MCP calls the module made, in order.
  mcp: { tool: string; args: Record<string, unknown> }[]
  // The rows the next search answers with, or an error result.
  rows: Row[] | 'error'
  // The vault paths a `read` finds.
  existing: Set<string>
  // Whether the server connects.
  connects: boolean
  // What a fork answers, and each prompt it was asked.
  fork: ModelForkResult
  forks: string[]
  // The classifier's answer for each text it reads: a label, undefined for
  // neither, an Error to reject, or 'hang' to answer only after a minute.
  classify: (text: string) => string | undefined | Error | 'hang'
  classified: string[]
  messages: SessionMessage[]
  // Each prompt as it reached the engine, context included.
  prompts: { text: string; context?: readonly string[] }[]
  // A tool whose calls a hook beneath refuses.
  refuse?: string
  // What a `read` of a missing note answers instead of the server's "not
  // found": another error, or a rejection.
  readFails?: 'error' | 'reject'
  clock: MockClock
}

const ran = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

export function memoryWorld(on: On, env: Record<string, string> = {}): World {
  const w: World = {
    sid: SID,
    runs: [],
    scripts: {},
    files: new Map(),
    toasts: [],
    logs: [],
    mcp: [],
    rows: [],
    existing: new Set(),
    connects: true,
    fork: { isAnswered: false, reason: 'nothing-to-fork' },
    forks: [],
    classify: () => 'relevant',
    classified: [],
    messages: [],
    prompts: [],
    clock: mock.clock(on, { now: NOW }),
  }
  mock.env(on, { HOME, ...env })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: w.sid }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.messages', () => ({ value: w.messages }) as never)
  on('prompt.submit', ($, e) => {
    w.prompts.push({ text: e.text, context: e.context })
    return { text: e.text, context: e.context }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  // Every tool call the module passes on runs, unless the test refuses it.
  on('tool.call', ($, e) => (w.refuse === e.tool ? { deny: 'refused beneath' } : { result: {} as never }))
  on('classic.SessionStart', () => ({}))
  on('classic.Stop', () => ({}))
  on('skill.prompt', ($, e) => ({ text: e.text }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', ($, e) => ({ value: w.files.has(e.path) }))
  on('fs.read', ($, e) => {
    const text = w.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    const run: Run = { argv: e.argv, stdin: e.init?.stdin, env: e.init?.env, timeoutMs: e.init?.timeoutMs }
    w.runs.push(run)
    const name = (e.argv[1] ?? '').split('/').pop() ?? ''
    const script = w.scripts[name]
    if (script === undefined) throw new Error(`no script ${name}`)
    const out = script(run)
    if (out instanceof Error) throw out
    return { value: ran(out) }
  })
  on('mcp.connect', () => ({
    value: w.connects ? { isConnected: true as const, server: SERVER } : { isConnected: false as const, reason: 'not-found' as never, message: 'no memory server' },
  }))
  on('mcp.call', ($, e) => {
    w.mcp.push({ tool: e.tool, args: e.args })
    const text = (value: unknown) => [{ type: 'text', text: JSON.stringify(value) }]
    if (e.tool === 'search') {
      return { value: w.rows === 'error' ? { content: text('down'), isError: true } : { content: text({ result: w.rows }), isError: false } }
    }
    if (e.tool === 'read') {
      const path = String(e.args.path)
      if (w.existing.has(path)) return { value: { content: text({ path }), isError: false } }
      if (w.readFails === 'reject') throw new Error('connection reset')
      if (w.readFails === 'error') return { value: { content: [{ type: 'text', text: 'Internal error: index locked' }], isError: true } }
      return { value: { content: [{ type: 'text', text: `Document not found: '${path}'. Find the path with search or list_documents.` }], isError: true } }
    }
    if (e.tool === 'write') w.existing.add(String(e.args.path))
    return { value: { content: text({ created: true }), isError: false } }
  })
  on('model.fork', ($, e) => {
    w.forks.push(e.prompt)
    return { value: w.fork }
  })
  on('model.classify', async ($, e) => {
    w.classified.push(e.text)
    const label = w.classify(e.text)
    if (label instanceof Error) throw label
    if (label === 'hang') await w.clock.sleep(60_000)
    return { value: label === 'hang' ? 'relevant' : label }
  })
  return w
}

export const start = (isInteractive = true) => ({ cwd: '/repo', surface: isInteractive ? ('terminal' as const) : null, isInteractive })

export const sessionStart = (sid = SID, source: 'startup' | 'resume' | 'clear' = 'startup', transcript = `${HOME}/.claude/projects/-repo/${sid}.jsonl`) => ({
  hook_event_name: 'SessionStart' as const,
  source,
  session_id: sid,
  transcript_path: transcript,
  cwd: '/repo',
})

export const COMPOSER: PromptOrigin = { kind: 'composer' }
export const prompt = (text: string, origin: PromptOrigin = COMPOSER) => ({ text, wait: false, origin })

export const turn = (reason: 'answer' | 'aborted' | 'error' = 'answer', agentId?: string) => ({
  answer: 'done',
  durationMs: 1,
  isAborted: reason === 'aborted',
  turnId: 't',
  reason,
  agentId,
})

// The runs of one script, by its file name.
export const runsOf = (w: World, name: string): Run[] => w.runs.filter(run => (run.argv[1] ?? '').split('/').pop() === name)
