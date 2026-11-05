#!/usr/bin/env node
import { createReadStream, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

const USAGE = `usage: timeline.mjs <file or folder>... [--files] [--since <time>] [--until <time>] [--width <n>]
       timeline.mjs --self-test
Reads Claude Code transcripts (sub-agent files included) and Codex rollout logs,
and prints one timeline in UTC. --files lists each log with its first and last
time instead. A time for --since or --until is a date, or a time with Z or an offset.`

const CODEX_TYPES = new Set(['session_meta', 'turn_context', 'response_item', 'event_msg', 'compacted'])
const CODEX_SKIPPED = new Set(['token_count', 'user_message', 'agent_message', 'agent_reasoning'])
const ZONED = /(Z|[+-]\d{2}:?\d{2})$/i
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

function utcOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return { iso: new Date(value > 1e12 ? value : value * 1000).toISOString(), isZoned: true }
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const text = value.trim()
  const isZoned = ZONED.test(text) || DATE_ONLY.test(text)
  const ms = Date.parse(isZoned ? text : `${text}Z`)
  return Number.isNaN(ms) ? undefined : { iso: new Date(ms).toISOString(), isZoned }
}

const flat = text => String(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\s]+/g, ' ').trim()
const cut = (text, width) => {
  const line = flat(text)
  return line.length <= width ? line : `${line.slice(0, width)}…[+${line.length - width}]`
}
const json = value => (typeof value === 'string' ? value : JSON.stringify(value ?? ''))

function blocksOf(content) {
  if (typeof content === 'string') return [['text', content]]
  if (!Array.isArray(content)) return []
  return content.flatMap(block => {
    if (block === null || typeof block !== 'object') return []
    if (['text', 'input_text', 'output_text'].includes(block.type)) return [['text', block.text ?? '']]
    if (block.type === 'thinking') return [['thinking', block.thinking ?? '']]
    if (block.type === 'tool_use') return [[`call ${block.name ?? ''}`.trim(), json(block.input)]]
    if (block.type === 'tool_result') {
      const inner = block.content
      return [['result', typeof inner === 'string' ? inner : Array.isArray(inner) ? inner.map(part => part?.text ?? '').join(' ') : json(inner)]]
    }
    return [[block.type ?? 'block', json(block)]]
  })
}

function codexEvents(record) {
  const payload = record.payload ?? {}
  const kind = payload.type
  if (record.type === 'session_meta') return [['session', `cwd ${payload.cwd ?? '?'}, ${payload.originator ?? ''} ${payload.cli_version ?? ''}`]]
  if (record.type === 'turn_context') return [['turn', `model ${payload.model ?? '?'}, cwd ${payload.cwd ?? '?'}`]]
  if (record.type === 'event_msg' && CODEX_SKIPPED.has(kind)) return []
  if (kind === 'message') return blocksOf(payload.content).map(([what, text]) => [`${payload.role ?? '?'}/${what}`, text])
  if (['function_call', 'custom_tool_call', 'local_shell_call'].includes(kind)) return [[`call ${payload.name ?? ''}`.trim(), json(payload.arguments ?? payload.input ?? payload.action)]]
  if (['function_call_output', 'custom_tool_call_output'].includes(kind)) return [['result', json(payload.output)]]
  if (kind === 'reasoning') return [['reasoning', (payload.summary ?? []).map(part => part?.text ?? '').join(' ')]]
  return [[kind ?? record.type, json(payload)]]
}

function claudeEvents(record) {
  if (record.message !== undefined) return blocksOf(record.message.content).map(([what, text]) => [`${record.message.role ?? record.type}/${what}`, text])
  return [[record.type ?? 'record', json(record)]]
}

function labelOf(path, record, meta) {
  if (CODEX_TYPES.has(record.type) && record.payload !== undefined) {
    const id = record.type === 'session_meta' ? record.payload.id : undefined
    const fromName = basename(path).match(/([0-9a-f]{8})-[0-9a-f-]{27,}\.jsonl$/i)?.[1]
    return `codex ${(id ?? fromName ?? basename(path)).slice(0, 8)}`
  }
  const session = String(record.sessionId ?? basename(path, '.jsonl')).slice(0, 8)
  const agent = path.match(/\/subagents\/agent-([^/]+)\.jsonl$/)?.[1] ?? (record.isSidechain ? record.agentId : undefined)
  if (agent === undefined) return `claude ${session}`
  return `claude ${session}/${meta?.agentType ?? `agent-${String(agent).slice(0, 8)}`}`
}

function eventsOf(path, line, meta, width) {
  let record
  try {
    record = JSON.parse(line)
  } catch {
    return { problem: 'unreadable' }
  }
  if (record === null || typeof record !== 'object') return { problem: 'unreadable' }
  const at = utcOf(record.timestamp)
  if (at === undefined) return { problem: 'untimed' }
  const isCodex = CODEX_TYPES.has(record.type) && record.payload !== undefined
  const label = labelOf(path, record, meta)
  const events = (isCodex ? codexEvents(record) : claudeEvents(record)).map(([what, text]) => ({ at: at.iso, isZoned: at.isZoned, label, line: `${what}: ${cut(text, width)}` }))
  return { events, label, problem: at.isZoned ? undefined : 'unzoned' }
}

function logsUnder(path) {
  const stat = lstatSync(path)
  if (stat.isFile()) return path.endsWith('.jsonl') ? [path] : []
  if (!stat.isDirectory()) return []
  return readdirSync(path)
    .sort()
    .flatMap(name => logsUnder(join(path, name)))
}

function metaOf(path) {
  const id = path.match(/\/subagents\/agent-([^/]+)\.jsonl$/)?.[1]
  if (id === undefined) return undefined
  try {
    return JSON.parse(readFileSync(join(dirname(path), `agent-${id}.meta.json`), 'utf8'))
  } catch {
    return undefined
  }
}

async function readLog(path, width) {
  const meta = metaOf(path)
  const events = []
  const problems = { unreadable: 0, untimed: 0, unzoned: 0 }
  let label
  let first
  let last
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })
  for await (const line of lines) {
    if (line.trim() === '') continue
    const read = eventsOf(path, line, meta, width)
    if (read.problem !== undefined) problems[read.problem]++
    if (read.events === undefined) continue
    label ??= read.label
    for (const event of read.events) {
      events.push(event)
      if (first === undefined || event.at < first) first = event.at
      if (last === undefined || event.at > last) last = event.at
    }
  }
  return { path, label: label ?? basename(path), events, problems, first, last }
}

function merged(logs, since, until) {
  return logs
    .flatMap((log, order) => log.events.map((event, index) => ({ ...event, order, index })))
    .filter(event => (since === undefined || event.at >= since) && (until === undefined || event.at <= until))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.order - b.order || a.index - b.index))
}

const lineOf = event => `${event.at}${event.isZoned ? '' : '?'} ${event.label} ${event.line}`

function selfTest() {
  const fail = message => {
    console.error(`self-test FAILED: ${message}`)
    process.exit(1)
  }
  const same = (got, want, what) => JSON.stringify(got) === JSON.stringify(want) || fail(`${what}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`)
  same(utcOf('2026-03-01T10:15:30+01:00'), { iso: '2026-03-01T09:15:30.000Z', isZoned: true }, 'an offset is turned into UTC')
  same(utcOf('2026-03-01T09:15:30Z'), { iso: '2026-03-01T09:15:30.000Z', isZoned: true }, 'a Z time stays')
  same(utcOf('2026-03-01T09:15:30'), { iso: '2026-03-01T09:15:30.000Z', isZoned: false }, 'a time with no zone is read as UTC and flagged')
  same(utcOf(1772356530000)?.iso, '2026-03-01T09:15:30.000Z', 'epoch milliseconds')
  same(utcOf(1772356530)?.iso, '2026-03-01T09:15:30.000Z', 'epoch seconds')
  same(utcOf(''), undefined, 'an empty time')
  const main = '/logs/.claude/projects/-work-app/0f3c2a1e-0000-4000-8000-000000000000.jsonl'
  const sub = '/logs/.claude/projects/-work-app/0f3c2a1e-0000-4000-8000-000000000000/subagents/agent-a1b2c3d4e5.jsonl'
  const codex = '/logs/.codex/sessions/2026/03/01/rollout-2026-03-01T10-15-30-6aab86ac-3a96-49de-a696-cfbbf066cea8.jsonl'
  const claudeLine = JSON.stringify({ type: 'assistant', sessionId: '0f3c2a1e-0000', timestamp: '2026-03-01T09:20:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Use port\n8080.' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } })
  const subLine = JSON.stringify({ type: 'user', sessionId: '0f3c2a1e-0000', isSidechain: true, agentId: 'a1b2c3d4e5', timestamp: '2026-03-01T09:18:00.000Z', message: { role: 'user', content: 'Check the config.' } })
  const codexLine = JSON.stringify({ timestamp: '2026-03-01T09:16:00.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"cat app.toml"}' } })
  const dupLine = JSON.stringify({ timestamp: '2026-03-01T09:16:01.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'dup' } })
  const a = eventsOf(main, claudeLine, undefined, 300)
  same(a.events.map(e => e.line), ['assistant/text: Use port 8080.', 'assistant/call Bash: {"command":"ls"}'], 'a transcript line gives one event per block, on one line')
  same(a.label, 'claude 0f3c2a1e', 'a main transcript is labeled by its session')
  same(eventsOf(sub, subLine, { agentType: 'reviewer' }, 300).label, 'claude 0f3c2a1e/reviewer', 'a sub-agent file is labeled by its agent type')
  same(eventsOf(sub, subLine, undefined, 300).label, 'claude 0f3c2a1e/agent-a1b2c3d4', 'a sub-agent file with no meta is labeled by its id')
  same(eventsOf(codex, codexLine, undefined, 300).label, 'codex 6aab86ac', 'a rollout is labeled by its id')
  same(eventsOf(codex, dupLine, undefined, 300).events, [], 'a rollout event that repeats a message is skipped')
  same(eventsOf(main, '{"type":"summary"}', undefined, 300).problem, 'untimed', 'a line with no time is counted, not placed')
  same(eventsOf(main, '{not json', undefined, 300).problem, 'unreadable', 'a broken line is counted')
  same(eventsOf(main, claudeLine, undefined, 5).events[0].line, 'assistant/text: Use p…[+9]', 'a long text is cut to the width')
  const logs = [a, eventsOf(sub, subLine, undefined, 300), eventsOf(codex, codexLine, undefined, 300)].map(read => ({ events: read.events }))
  same(merged(logs).map(e => e.at.slice(11, 16)), ['09:16', '09:18', '09:20', '09:20'], 'the logs merge into one timeline by UTC time')
  same(merged(logs, '2026-03-01T09:17:00.000Z').length, 3, '--since drops what came before')
  console.log('self-test ok')
}

function optionOf(args, name) {
  const at = args.indexOf(name)
  if (at === -1) return undefined
  const value = args[at + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`)
  args.splice(at, 2)
  return value
}

function boundOf(args, name) {
  const value = optionOf(args, name)
  if (value === undefined) return undefined
  const at = utcOf(value)
  if (at === undefined || !at.isZoned) throw new Error(`${name} takes a date, or a time with Z or an offset, such as 2026-03-01T09:00:00Z`)
  return at.iso
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--self-test')) return selfTest()
  if (args.length === 0 || args.includes('--help')) {
    console.log(USAGE)
    process.exit(args.length === 0 ? 1 : 0)
  }
  const isFiles = args.includes('--files')
  const rest = args.filter(arg => arg !== '--files')
  const since = boundOf(rest, '--since')
  const until = boundOf(rest, '--until')
  const widthText = optionOf(rest, '--width')
  const width = widthText === undefined ? 400 : Number(widthText)
  if (!Number.isInteger(width) || width < 1) throw new Error('--width takes a whole number above 0')
  const unknown = rest.find(arg => arg.startsWith('--'))
  if (unknown !== undefined) throw new Error(`unknown option ${unknown}\n${USAGE}`)
  const paths = [...new Set(rest.flatMap(path => logsUnder(path)))]
  if (paths.length === 0) throw new Error('no .jsonl log found under the paths given')
  const logs = []
  for (const path of paths) logs.push(await readLog(path, width))
  if (isFiles) {
    for (const log of [...logs].sort((a, b) => (a.first ?? '~').localeCompare(b.first ?? '~'))) {
      console.log(`${log.first ?? 'no time'}  ${log.last ?? 'no time'}  ${String(log.events.length).padStart(6)}  ${log.label}  ${log.path}`)
    }
  } else {
    for (const event of merged(logs, since, until)) console.log(lineOf(event))
  }
  for (const log of logs) {
    const notes = Object.entries(log.problems).filter(([, count]) => count > 0).map(([problem, count]) => `${count} ${problem}`)
    if (notes.length > 0) console.error(`note: ${log.path}: ${notes.join(', ')} line(s). Untimed and unreadable lines are left out. Unzoned times are read as UTC and marked with ?.`)
  }
}

main().catch(error => {
  console.error(`timeline: ${error.message}`)
  process.exit(1)
})
