// workbench-core's hooks module, beside the command hooks in hooks.json. A
// bash guard moves here once its port holds parity with its frozen copy under
// tests/oracle/, and its command hook is then removed.
//
//   $.workbench     the noun other plugins build on: the brief, the scratch
//                   roots, orchestrator mode, the lane, the shell reader
//                   (types/index.d.ts is its contract)
//   question rule   every question to Mike goes through AskUserQuestion, with
//                   its context in prose right above the call
//   request meter   turns, and each API request's cost, on the status line
//   cache meter     each request's cache read against its cache creation, and
//                   the system-prompt section that changed at a creation spike
//   status line     beside the meter: memory health, orchestrator mode, reply
//                   rows, learnings due for compaction, warmup notices
//   commands        /orchestrator, /memory-status, /notices and
//                   /process-pending-summaries, answered here with no model turn
//   commit approval in Mike's session, one "Commit it" pick in AskUserQuestion,
//                   asked alone, allows one commit and the push of that commit
//   vault writes    the memory MCP's write, edit and append get a vault-relative
//                   path, valid frontmatter on a new note, and path links
//   deferred start  the warmup's pending-summary drain and Chat-skill scan,
//                   started once the SessionStart hooks are done
//   log checkpoint  hooks/session-log.sh after each main-loop turn, interrupted
//                   ones included, and at session end, SIGHUP and SIGTERM too
//   memory capture  the live session's durable findings, asked of a fork and
//                   written to the vault, with no turn shown and no question
//   recall          vault hits for a prompt or a content search, filtered and
//                   injected at the tail, never into the system prompt
//   learnings       a skill's vault learnings, merged into its text
//   intake nudge    the first Edit of a task with no intake block on screen
//   guards          the peer message gate, the provisioning, summary-writer,
//                   credential and whole-disk search guards, judged before a
//                   tool call runs, and refusing when they cannot judge
//   prompt rules    the workbench rules as shared system-prompt sections, the
//                   same bytes in every session, and a sub-agent's copy at its
//                   start; the harness's memory section and the block an older
//                   warmup spliced into CLAUDE.md are left out
//
// The logic is pure and lives in mods/. Every hook that touches `$` lives in
// this file, because the engine follows `$` into no imported function, and a
// plugin registers each event once: so each event below has one hook, and the
// hook branches where several features share the event.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, InstructionFile, PromptComposeSection, Register, RenderElement, ToolCallResult, TurnUsage } from 'claude-code'

import type { CacheState, ChurnEvent, PaneContent, WorkbenchCallerLane, WorkbenchShellParse } from '../types'
import { BRIEF_SLOTS, checkBrief } from './mods/brief'
import type { CaptureNote } from './mods/capture'
import { FIRST, REPEAT, capturePrompt, duplicateOf, isCaptureDue, isNotFound, notesOf, savedText, thresholdOf } from './mods/capture'
import type { CheckpointMode } from './mods/checkpoint'
import { checkpointRequest, endTimeoutOf } from './mods/checkpoint'
import { NUDGE, intakeShown } from './mods/intake'
import { learningsPath, withLearnings } from './mods/learnings'
import {
  HARNESS_MEMORY,
  OMITS_CLAUDE_MD,
  contributionPathsOf,
  contributionsOf,
  promptLaneOf,
  sectionsFor,
  splicedBodiesOf,
  subagentContextOf,
  withShared,
  withoutSplice,
} from './mods/prompt-rules'
import type { Hit } from './mods/recall'
import {
  CLASSIFY_TIMEOUT_MS,
  FETCH_FACTOR,
  LABELS as RELEVANCE_LABELS,
  PROMPT_LIMIT,
  PROMPT_MIN_SCORE,
  SCAN_LIMIT,
  SCAN_MIN_SCORE,
  blockOf,
  candidatesOf,
  hitsOf,
  mayScan,
  promptQuery,
  relevanceText,
  relevantOf,
  scanQuery,
  tokensOf,
} from './mods/recall'
import {
  EMPTY_CACHE,
  cacheFactsOf,
  cacheRequestOf,
  changedSections,
  churnText,
  countCache,
  hashesOf,
  isSpike,
  recordFileOf,
  recordOf,
  withChurn,
} from './mods/cache-meter'
import type { Refs } from './mods/commit-approval'
import { BUNDLE_REFUSAL, approvalAfter, bundlesCommit, dirOf, isCommitPick, readLine, refusalOf } from './mods/commit-approval'
import { isAttendedPrompt, isAttendedSession, isScheduledFire, laneOf } from './mods/lane'
import { parseShell } from './mods/shell'
import {
  AGENT_WORKTREE_REFUSAL,
  ENTER_WORKTREE_REFUSAL,
  EXIT_WORKTREE_REFUSAL,
  GUARDED,
  PEER_ADVICE,
  PEER_REFUSAL,
  SEARCH_UNREAD,
  bodyTargets,
  credentialPathRefusal,
  credentialRefusal,
  hiddenCommandRefusal,
  isPartlyRead,
  mentionsSearch,
  peerVerdict,
  provisioningRefusal,
  resolvePath,
  searchRefusal,
  searchRoots,
  summaryWriterRefusal,
  toolSearchRoots,
} from './mods/guards'
import type { SearchRoot } from './mods/guards'
import {
  REFUSAL,
  STORE_KEY,
  USAGE,
  isPersonOrigin,
  legacyFileOf,
  offSessionsOf,
  reportOf,
  toggleOf,
  withMode,
} from './mods/orchestrator'
import {
  ASKS_NOTHING,
  ASKS_USER,
  LABELS,
  REFUSAL_REASON,
  REPROMPT_REASON,
  classifierText,
  endsOnQuestion,
  hasCandidate,
  hasContextBefore,
  proseOf,
} from './mods/question-rule'
import { NAME as PENDING, REFUSAL as PENDING_REFUSAL, USAGE as PENDING_USAGE, outcomeOf, reportOf as pendingReportOf, requestOf } from './mods/pending-summaries'
import { EMPTY, countRequest, countTurn, statusOf } from './mods/request-meter'
import { countOf, factsOf, healthOf, learningsAfter, lineOf, noticesOf, rowsOf, skillNameOf } from './mods/status-line'
import type { VaultTool } from './mods/vault-write'
import {
  TEXT_FIELD,
  fixPath,
  frontmatterProblems,
  frontmatterRefusal,
  isNote,
  needsRoot,
  resolvedOf,
  rewriteLinks,
  vaultToolOf,
  wikiTargets,
} from './mods/vault-write'

const meter = atom({ plugin: 'workbench-core', key: 'meter' } as const, EMPTY)
const cache = atom({ plugin: 'workbench-core', key: 'cache' } as const, EMPTY_CACHE)
// Whether a person opened the current turn, so the question rule applies.
const turnAttended = atom({ plugin: 'workbench-core', key: 'turnAttended' } as const, false)
// Whether the question rule already re-prompted in the current turn.
const reprompted = atom({ plugin: 'workbench-core', key: 'reprompted' } as const, false)
// Where Mike's last "Commit it" pick stands: unused, used by its commit with
// the push left, or used up. Any prompt ends an unused pick, and Mike's own
// prompt ends the push left too.
const commitApproval = atom({ plugin: 'workbench-core', key: 'commitApproval' } as const, 'none')
// Whether a schedule opened the current turn, so a commit in it is not gated.
const turnScheduled = atom({ plugin: 'workbench-core', key: 'turnScheduled' } as const, false)
const learnings = atom({ plugin: 'workbench-core', key: 'learnings' } as const, {})
const replyRows = atom({ plugin: 'workbench-core', key: 'replyRows' } as const, null)
const notices = atom({ plugin: 'workbench-core', key: 'notices' } as const, [])
const pane = atom({ plugin: 'workbench-core', key: 'pane' } as const, { title: '', text: '' })
const capture = atom({ plugin: 'workbench-core', key: 'capture' } as const, { turns: 0, hasFired: false, written: [] })
const recall = atom({ plugin: 'workbench-core', key: 'recall' } as const, { seen: [], queries: [] })
const intake = atom({ plugin: 'workbench-core', key: 'intake' } as const, { task: 0, checked: 0 })
const TRANSCRIPT = { plugin: 'workbench-core', key: 'transcriptPath' } as const
// Unset until known: a status entry for a fact not known yet is left out.
const ORCHESTRATOR_ON = { plugin: 'workbench-core', key: 'orchestratorOn' } as const
const MEMORY_HEALTH = { plugin: 'workbench-core', key: 'memoryHealth' } as const
const STARTED_AT = { plugin: 'workbench-core', key: 'startedAt' } as const
const NOTICES_MTIME = { plugin: 'workbench-core', key: 'noticesMtime' } as const

// The one pane: /memory-status and /notices each fill it.
const PANE = 'workbench-core'
const COMMANDS = [
  { name: 'orchestrator', description: 'Orchestrator mode for this session: on, off, or status', argumentHint: '[on|off|status]' },
  { name: 'memory-status', description: "The shared memory server's facts, in a pane" },
  { name: 'notices', description: 'The warmup notices from this session start, in a pane' },
  {
    name: PENDING,
    description: 'Dispatch summary-writers for the pending session summaries, or for one session by id',
    argumentHint: '[<session-id> [--overwrite]]',
  },
] as const
const OURS: ReadonlySet<string> = new Set(COMMANDS.map(command => command.name))
// How long after session start the first memory probe and the first notices
// read run, and the second read: memory-server-up.sh can hold SessionStart up to
// 15 s before session-warmup.sh writes the notices file. Each probe after that
// reads the file again when it changed.
const SETTLE_MS = 3000
const NOTICES_LATE_MS = 20_000
// Every session reads the one notices file, and every session start rewrites
// it. A rewrite later than this after this session's start is another
// session's, so it is not shown here.
const NOTICES_WINDOW_MS = 120_000
const PROBE_EVERY_MS = 60_000
// The warmup's deferred half starts as soon as the SessionStart hooks are done,
// and may take this long: a few detached spawns and a scan of the plugins.
// session-warmup.sh's DEFERRED_TIMEOUT_S states the same figure: a deferred
// run older than it is taken as dead.
const DEFERRED_MS = 0
const DEFERRED_TIMEOUT_MS = 120_000

// Whether a finished reply leaves a question for Mike in prose. A classifier
// that fails, or answers with neither label, falls back to the deterministic
// reading, so a question is never let through only because the classifier
// could not answer.
async function asksInProse($: EngineInterface, reply: string): Promise<boolean> {
  const prose = proseOf(reply)
  if (!hasCandidate(prose)) return false
  try {
    const label = await $.model.classify(classifierText(prose), LABELS)
    if (label === ASKS_USER) return true
    if (label === ASKS_NOTHING) return false
  } catch {
    // The deterministic reading below decides.
  }
  return endsOnQuestion(prose)
}

// Whether this load drew a status line yet. A clear with nothing drawn is
// skipped, so a session start with nothing to show draws nothing.
let hasDrawn = false

// The status line: the meter, then every workbench fact known so far.
async function drawStatus($: EngineInterface): Promise<void> {
  const figures = await read($, meter)
  const { value: isOn } = await $.state.get(ORCHESTRATOR_ON)
  const { value: health } = await $.state.get(MEMORY_HEALTH)
  const rows = await read($, replyRows)
  const facts = factsOf({
    memoryHealth: health,
    orchestratorOn: isOn,
    replyRows: rows ?? undefined,
    learnings: await read($, learnings),
    notices: await read($, notices),
  })
  const isMetered = figures.turns > 0 || figures.first !== null
  const line = lineOf(isMetered ? statusOf(figures) : undefined, [...cacheFactsOf(await read($, cache)), ...facts])
  if (line === undefined && !hasDrawn) return
  hasDrawn = true
  $.ui.status(line)
}

// The legacy file the bash gates read for this session, or undefined when the
// session id cannot name one.
async function legacyFile($: EngineInterface): Promise<string | undefined> {
  return legacyFileOf(await $.session.id(), await $.env.get('WORKBENCH_ORCHESTRATOR_STATE_DIR'), await $.env.get('HOME'))
}

// Orchestrator mode for this session. Seeded once, from the mode stored for
// this session id, else from the legacy file an older build may have left.
async function orchestratorOn($: EngineInterface): Promise<boolean> {
  const { value } = await $.state.get(ORCHESTRATOR_ON)
  if (value !== undefined) return value
  const id = await $.session.id()
  const stored = offSessionsOf(await $.store.get(STORE_KEY), await $.clock.now())
  const file = await legacyFile($)
  const isOn = !(id in stored) && !(file !== undefined && isOffFile(await legacyEntry($, file)))
  await $.state.set(ORCHESTRATOR_ON, isOn)
  return isOn
}

// The legacy file's directory entry as it stands, a symbolic link included and
// never followed, or undefined when there is none.
async function legacyEntry($: EngineInterface, file: string): Promise<FsEntry | undefined> {
  const cut = file.lastIndexOf('/')
  const entries = await $.fs.list(file.slice(0, cut)).catch(() => [])
  return entries.find(entry => entry.name === file.slice(cut + 1))
}

// What counts as off, here and in both bash gates (`[ -f ] && [ ! -L ]`): a
// regular file that is not a symbolic link. A directory or a link planted at
// the path is not a mode anyone chose.
const isOffFile = (entry: FsEntry | undefined): boolean => entry !== undefined && entry.kind === 'file' && !entry.isLink

// Puts the legacy path in line with the mode: a regular file when off, nothing
// when on. Anything else there, a directory or a symbolic link, is removed with
// `rm -rf -- <path>`, which removes that one entry and never follows a link,
// and is never written through. The entry is listed again before the write, so
// a link or directory planted after the removal is left unwritten: the gates
// then find no regular file and stay on. A link planted in the instant between
// that listing and the write is the one race left, as $.fs.write has no
// no-follow mode.
async function mirror($: EngineInterface, isOn: boolean): Promise<void> {
  const file = await legacyFile($)
  if (file === undefined) return
  const entry = await legacyEntry($, file)
  if (!isOn && isOffFile(entry)) return
  if (entry !== undefined) await $.process.run(['rm', '-rf', '--', file])
  if (isOn) return
  if ((await legacyEntry($, file)) === undefined) await $.fs.write(file, '')
}

async function setOrchestrator($: EngineInterface, isOn: boolean): Promise<void> {
  const id = await $.session.id()
  const now = await $.clock.now()
  await $.state.set(ORCHESTRATOR_ON, isOn)
  await $.store.set(STORE_KEY, withMode(offSessionsOf(await $.store.get(STORE_KEY), now), id, isOn, now))
  await mirror($, isOn)
}

async function probeMemory($: EngineInterface): Promise<void> {
  const { stdout } = await $.process.run(['bash', `${$.plugin.root}/scripts/memory-health.sh`], { timeoutMs: 15_000 })
  const health = healthOf(stdout)
  if (health !== undefined) await $.state.set(MEMORY_HEALTH, health)
  await drawStatus($)
}

const noticesFile = async ($: EngineInterface): Promise<string | undefined> => {
  const home = await $.env.get('HOME')
  return home ? `${home}/.claude-workbench/warmup-notices.md` : undefined
}

// The warmup notices reach Mike here, never through the model: a toast naming
// each one, a count on the status line, and the whole file behind /notices.
// A file older than the session is the previous session's, still waiting for
// session-warmup.sh to rewrite it, so it is left for a later read. A file read
// once is read again only when its mtime changes, and only within
// NOTICES_WINDOW_MS of the start: a later rewrite is another session's.
async function deliverNotices($: EngineInterface): Promise<void> {
  const file = await noticesFile($)
  if (file === undefined || !(await $.fs.exists(file))) return
  const { mtimeMs } = await $.fs.stat(file)
  const { value: startedAt = 0 } = await $.state.get(STARTED_AT)
  const { value: shown } = await $.state.get(NOTICES_MTIME)
  if (mtimeMs < startedAt || mtimeMs > startedAt + NOTICES_WINDOW_MS || mtimeMs === shown) return
  const headings = noticesOf(await $.fs.read(file))
  await $.state.set(NOTICES_MTIME, mtimeMs)
  await update($, notices, () => headings)
  await drawStatus($)
  if (headings.length > 0) $.ui.toast(`Warmup notices: ${headings.join('; ')}. Run /notices to read them.`, { timeoutMs: 10_000 })
}

async function showPane($: EngineInterface, content: PaneContent): Promise<void> {
  await update($, pane, () => content)
  await $.ui.open({ id: PANE, title: content.title })
}

// Whether the commit approval rule applies to a call: the main loop of an
// interactive session, in any turn but a scheduled one. It reads the session
// and the lane, never the question rule's turn reading: a peer, channel, SDK or
// plugin turn in Mike's session is gated, because it carries outside text and
// a deny, unlike a re-prompt, cannot loop. The exemptions are the lanes that
// commit unattended by design:
//   - a session nobody sits at (`claude -p`, the SDK, a top-level --agent run,
//     WORKBENCH_DEV_TEAM_PIPELINE=1), from session.start; unknown before it,
//     which is read as attended, the gate's side
//   - the pipeline's flag, read here as well, so no lane answer can gate it
//   - a sub-agent or top-level agent, from $.workbench.callerLane; a rejection
//     is read as `main`, the gate's side
//   - a turn a schedule opened (the origin, or the `<scheduled-task ` wrapper)
async function isCommitGated($: EngineInterface, sessionAttended: boolean | undefined, agentId: string | undefined): Promise<boolean> {
  if (sessionAttended === false || (await $.env.get('WORKBENCH_DEV_TEAM_PIPELINE')) === '1') return false
  const lane = await $.workbench.callerLane(agentId === undefined ? {} : { agentId }).catch((): WorkbenchCallerLane => 'main')
  if (lane !== 'main') return false
  return !(await read($, turnScheduled))
}

// HEAD and the push target of the repository at `dir`, each undefined when git
// cannot say. Read with $.process.run, which runs git with repo hooks off.
async function refsOf($: EngineInterface, dir: string): Promise<Refs> {
  const ref = (name: string) =>
    $.process
      .run(['git', '-C', dir, 'rev-parse', '--verify', '--quiet', name], { timeoutMs: 10_000 })
      .then(({ exitCode, stdout }) => (exitCode === 0 && stdout.trim() !== '' ? stdout.trim() : undefined), () => undefined)
  return { head: await ref('HEAD'), pushed: await ref('@{push}') }
}

type VaultCall = Record<string, unknown> & { path?: unknown }

// The vault write checks on one memory MCP call: the call to pass on, fixed
// where it needed fixing, or the refusal. scripts/vault-resolve.sh runs only
// when the call needs the vault root or holds a [[link]]. When it cannot run,
// an absolute path is refused and every link is left as written.
async function checkVaultWrite($: EngineInterface, e: VaultCall, tool: VaultTool): Promise<{ deny: string } | { call: VaultCall }> {
  const { path } = e
  if (typeof path !== 'string') return { call: e }
  const field = TEXT_FIELD[tool]
  const text = typeof e[field] === 'string' ? (e[field] as string) : undefined
  const targets = text !== undefined && isNote(path) ? wikiTargets(text) : []
  const createsNote = isNote(path) && (tool === 'write' || (tool === 'append' && e.create_if_missing === true))
  const facts =
    needsRoot(path) || targets.length > 0 || (tool === 'append' && createsNote)
      ? resolvedOf(
          await $.process
            .run(['bash', `${$.plugin.root}/scripts/vault-resolve.sh`, ...targets], { timeoutMs: 10_000 })
            .then(({ stdout }) => stdout, () => ''),
        )
      : resolvedOf('')
  const fixed = fixPath(path, facts.root, await $.env.get('HOME'))
  if ('refusal' in fixed) return { deny: fixed.refusal }
  // A write replaces the whole note, frontmatter included. An append creates
  // one only where none is, and a note it cannot see is taken as new.
  const isNew =
    tool === 'write' ||
    (createsNote && (facts.root === undefined || !(await $.fs.exists(`${facts.root}/${fixed.path}`).catch(() => false))))
  if (createsNote && isNew) {
    const problems = frontmatterProblems(tool === 'write' ? e.frontmatter : undefined, text)
    if (problems.length > 0) return { deny: frontmatterRefusal(problems) }
  }
  const linked = text !== undefined && facts.paths.size > 0 ? rewriteLinks(text, facts.paths) : text
  if (fixed.path === path && linked === text) return { call: e }
  return { call: { ...e, path: fixed.path, ...(linked !== text ? { [field]: linked } : {}) } }
}

// One main-loop request on the cache meter. The system prompt is read on the
// first request, for the baseline, and on every request that created cache:
// at a creation spike, to name the sections that changed since the last
// reading, and on any other, so a change that cost no spike is not blamed on a
// later one. A request that only read the cache could not follow a prompt
// change, so it is not read then. A prompt that cannot be read names none, and
// the next reading compares with the last one that could. Only
// a spike that names a section is shown, and only to a person at the session;
// the record file is kept for those sessions, for measuring a change.
async function meterCache($: EngineInterface, usage: TurnUsage, isAttended: boolean): Promise<void> {
  const before = await read($, cache)
  const request = cacheRequestOf(before.count + 1, usage)
  let state: CacheState = countCache(before, request)
  if (request.n === 1 || request.creation > 0) {
    const hashes = await $.prompt.compose().then(({ sections }) => hashesOf(sections), () => null)
    if (isSpike(request)) {
      const sections = hashes === null || before.hashes === null ? null : changedSections(before.hashes, hashes)
      const event: ChurnEvent = { n: request.n, read: request.read, creation: request.creation, sections }
      state = withChurn(state, event)
      if (isAttended && sections !== null && sections.length > 0) $.ui.toast(churnText(event), { timeoutMs: 10_000 })
    }
    if (hashes !== null) state = { ...state, hashes }
  }
  await update($, cache, () => state)
  if (!isAttended) return
  const home = await $.env.get('HOME')
  const file = home === undefined ? undefined : recordFileOf(home, await $.session.id())
  if (file !== undefined) await $.fs.write(file, recordOf(state)).catch(() => undefined)
}

// The warmup's deferred half (hooks/session-warmup.sh --deferred): the
// pending-summary drain and the Chat-skill scan. Its output reaches nobody.
async function deferredWarmup($: EngineInterface, payload: string): Promise<void> {
  await $.process.run(['bash', `${$.plugin.root}/hooks/session-warmup.sh`, '--deferred'], { stdin: payload, timeoutMs: DEFERRED_TIMEOUT_MS })
}

// /process-pending-summaries: the script's outcome, reported in a toast. It
// asks nothing: the script decides whether a summary is redone.
async function processPendingSummaries($: EngineInterface, args: string): Promise<void> {
  const request = requestOf(args)
  if (request === undefined) {
    $.ui.toast(PENDING_USAGE)
    return
  }
  const { sid } = request
  const argv = sid === undefined ? [] : request.overwrite ? [sid, '--overwrite'] : [sid]
  const outcome = outcomeOf(
    await $.process
      .run(['bash', `${$.plugin.root}/scripts/process-pending-summaries.sh`, ...argv], { timeoutMs: 60_000 })
      .then(({ stdout }) => stdout, () => ''),
  )
  $.ui.toast(pendingReportOf(outcome, sid), { timeoutMs: 10_000 })
}

// The memory server's name as $.mcp.call takes it: core's own manifest server,
// connected on first use. Kept for the module's life; a reload asks again.
let memoryServerName: string | undefined
async function memoryServer($: EngineInterface): Promise<string> {
  if (memoryServerName !== undefined) return memoryServerName
  const connected = await $.mcp.connect('memory')
  if (!connected.isConnected) throw new Error(`memory: ${connected.message}`)
  memoryServerName = connected.server
  return memoryServerName
}

// One log checkpoint through hooks/session-log.sh (hooks/mods/checkpoint.ts).
// A session whose transcript is unknown, or names another session, is left to
// the settings hooks and the start-up reconciler.
async function checkpointLog($: EngineInterface, sessionId: string, mode: CheckpointMode, reason: string | undefined, timeoutMs: number): Promise<void> {
  const { value: transcript } = await $.state.get(TRANSCRIPT)
  const request = checkpointRequest(sessionId, transcript, mode, reason)
  if (request === undefined) return
  await $.process.run(['bash', `${$.plugin.root}/hooks/session-log.sh`], { ...request, timeoutMs })
}

// The memory capture checkpoint (hooks/mods/capture.ts): a fork of the session
// lists what it learned, and each note that passes the checks is written
// through the memory MCP. No turn is shown and nothing is asked. Mike sees one
// toast when a note is saved, and nothing when none is.
//
// $.mcp.call passes no tool.call hook of this module, so each write goes
// through checkVaultWrite here: the vault write checks a model's write gets,
// [[link]] rewrite included. A note is written only when the vault holds
// nothing like it: a search on its name finds no duplicate (another session
// may have saved it), and a read of its path answers a definite "not found".
// Any other answer, an error included, skips the note.
async function captureNote($: EngineInterface, server: string, note: CaptureNote): Promise<boolean> {
  const found = await $.mcp.call(server, 'search', { query: note.frontmatter.name, limit: 3 })
  if (found.isError) return false
  const duplicate = duplicateOf(note, hitsOf(found.content))
  if (duplicate !== undefined) {
    // One line per skip, so the share of captures held back can be measured.
    $.ui.log(`workbench capture: skipped "${note.frontmatter.name}" (${duplicate})`, { to: 'debug' })
    return false
  }
  if (!isNotFound(await $.mcp.call(server, 'read', { path: note.path }))) return false
  const checked = await checkVaultWrite($, { path: note.path, content: note.content, frontmatter: note.frontmatter }, 'write')
  if ('deny' in checked) return false
  return !(await $.mcp.call(server, 'write', checked.call)).isError
}

async function captureMemory($: EngineInterface): Promise<void> {
  const reply = await $.model.fork({ prompt: capturePrompt((await read($, capture)).written) })
  if (!reply.isAnswered) return
  const date = new Date(await $.clock.now()).toISOString().slice(0, 10)
  const notes = notesOf(reply.text, date).filter(note => frontmatterProblems(note.frontmatter, note.content).length === 0)
  if (notes.length === 0) return
  const server = await memoryServer($)
  const written: string[] = []
  for (const note of notes) {
    if (await captureNote($, server, note).catch(() => false)) written.push(note.path)
  }
  if (written.length === 0) return
  await update($, capture, state => ({ ...state, written: [...state.written, ...written] }))
  $.ui.toast(savedText(written), { timeoutMs: 10_000 })
}

// Whether this session counts turns toward a capture: a session a person sits
// at, in a turn no schedule opened, with the old hook's switches honoured
// (WORKBENCH_CAPTURE_STOP=0 and WORKBENCH_MEMORY_NUDGE=0 turn it off), and
// never in a summary-writer.
async function isCaptureOn($: EngineInterface, sessionAttended: boolean | undefined): Promise<boolean> {
  if (sessionAttended !== true || (await read($, turnScheduled))) return false
  if ((await $.env.get('WORKBENCH_CAPTURE_STOP')) === '0' || (await $.env.get('WORKBENCH_MEMORY_NUDGE')) === '0') return false
  return (await $.env.get('WORKBENCH_SUMMARY_WRITER')) !== '1'
}

// The relevance labels for `hits`, one each, or undefined when the classifier
// failed or ran past CLASSIFY_TIMEOUT_MS: the caller then keeps every hit.
async function labelsOf($: EngineInterface, task: string, hits: readonly Hit[]): Promise<(string | undefined)[] | undefined> {
  const pass = Promise.all(hits.map(hit => $.model.classify(relevanceText(task, hit), RELEVANCE_LABELS))).catch(() => undefined)
  const timeout = $.clock.sleep(CLASSIFY_TIMEOUT_MS).then(
    () => undefined,
    () => undefined,
  )
  return Promise.race([pass, timeout])
}

// One recall (hooks/mods/recall.ts): the vault search through the memory MCP,
// the threshold, the types and the session's dedupe set, then the relevance
// pass. The hits it shows join the dedupe set. Its figures go to the debug log.
async function recallBlock($: EngineInterface, query: string, limit: number, minScore: number, scan?: string): Promise<string | undefined> {
  const started = await $.clock.now()
  const server = await memoryServer($)
  const found = await $.mcp.call(server, 'search', { query, limit: limit * FETCH_FACTOR })
  if (found.isError) return undefined
  const candidates = candidatesOf(hitsOf(found.content), (await read($, recall)).seen, limit, minScore)
  if (candidates.length === 0) return undefined
  const labels = await labelsOf($, scan ?? query, candidates)
  const kept = labels === undefined ? candidates : relevantOf(candidates, labels)
  if (kept.length === 0) return undefined
  await update($, recall, state => ({ ...state, seen: [...state.seen, ...kept.map(hit => hit.path)] }))
  const block = blockOf(kept, scan)
  const ms = (await $.clock.now()) - started
  const fallback = labels === undefined ? ', classifier fallback' : ''
  $.ui.log(`workbench recall: ${kept.length} of ${candidates.length} hits, about ${tokensOf(block)} tokens, ${ms} ms${fallback}`, { to: 'debug' })
  return block
}

// Whether recall and the nudges stay out: a lane nobody answers in, as
// $.workbench.isUnattended reads it, or a lane it cannot read.
const isQuiet = ($: EngineInterface): Promise<boolean> => $.workbench.isUnattended().catch(() => true)

// Recall on a prompt: a new turn a person opened, with a query worth a search.
// The search attempt is stamped where session-warmup.sh's recall liveness
// check reads it, as hooks/memory-recall.sh did.
async function promptRecall($: EngineInterface, text: string): Promise<string | undefined> {
  if ((await $.env.get('WORKBENCH_MEMORY_RECALL')) === '0' || (await isQuiet($))) return undefined
  const query = promptQuery(text)
  if (query === undefined) return undefined
  const home = await $.env.get('HOME')
  const stateDir = (await $.env.get('WORKBENCH_MEMORY_RECALL_STATE')) || (home ? `${home}/.claude-workbench/memory-recall` : undefined)
  const now = Math.floor((await $.clock.now()) / 1000)
  if (stateDir !== undefined) await $.fs.write(`${stateDir}/last-attempt`, `${now}\n`).catch(() => undefined)
  return recallBlock($, query, PROMPT_LIMIT, PROMPT_MIN_SCORE)
}

// Recall on a content search in the main loop (grep, rg, ag, ack, git grep in
// a Bash call; this CLI has no Grep tool): the search's own query, read by
// hooks/lib/scan-query.py, once per query per session.
async function scanRecall($: EngineInterface, tool: 'Bash', raw: string): Promise<string | undefined> {
  if ((await $.env.get('WORKBENCH_MEMORY_RECALL')) === '0' || (await $.env.get('WORKBENCH_MEMORY_SCAN_RECALL')) === '0') return undefined
  if (!mayScan(raw) || (await isQuiet($))) return undefined
  const { stdout } = await $.process.run(['python3', `${$.plugin.root}/hooks/lib/scan-query.py`, tool], { stdin: raw, timeoutMs: 5_000 })
  const query = scanQuery(stdout)
  if (query === undefined || (await read($, recall)).queries.includes(query)) return undefined
  await update($, recall, state => ({ ...state, queries: [...state.queries, query] }))
  return recallBlock($, query, SCAN_LIMIT, SCAN_MIN_SCORE, query)
}

// A tool's result with recall's block beside it, when the call was a main-loop
// content search with something to recall. A refused or failed call gets none.
async function withScanRecall<R extends ToolCallResult>($: EngineInterface, tool: 'Bash', raw: unknown, agentId: string | undefined, result: R): Promise<R> {
  if (agentId !== undefined || typeof raw !== 'string' || result.deny !== undefined || result.isError === true) return result
  const block = await scanRecall($, tool, raw).catch(() => undefined)
  return block === undefined ? result : { ...result, context: [...(result.context ?? []), block] }
}

// The intake nudge (hooks/mods/intake.ts): checked once per task, on the
// task's first Edit in the main loop, and only in a lane a person answers.
async function isIntakeDue($: EngineInterface, sessionAttended: boolean | undefined): Promise<boolean> {
  if (sessionAttended !== true || (await isQuiet($))) return false
  const { task, checked } = await read($, intake)
  if (task === 0 || checked === task) return false
  await update($, intake, state => ({ ...state, checked: task }))
  return !intakeShown(await $.session.messages())
}

// The vault root, from scripts/vault-resolve.sh: read once per load.
let vaultRootMemo: string | undefined
async function vaultRoot($: EngineInterface): Promise<string | undefined> {
  if (vaultRootMemo !== undefined) return vaultRootMemo
  const { stdout } = await $.process.run(['bash', `${$.plugin.root}/scripts/vault-resolve.sh`], { timeoutMs: 10_000 })
  vaultRootMemo = resolvedOf(stdout).root
  return vaultRootMemo
}

// The workbench sections for this load (hooks/mods/prompt-rules.ts), read once
// and kept: every prompt.compose and SubagentStart answers from the one
// reading, so the bytes cannot change within a load. session.start reads them
// again, as a reload does. A reading that fails gives the rules alone, the
// agent lane's set: losing the rules is the worse failure, and a lane that
// cannot be read may be an unattended one, which gets no memory routing.
let sectionsMemo: Promise<PromptComposeSection[]> | undefined
function workbenchSections($: EngineInterface): Promise<PromptComposeSection[]> {
  sectionsMemo ??= readSections($).catch(() => sectionsFor('agent', undefined))
  return sectionsMemo
}

// The lane from the environment, and each sibling plugin's session-warmup.md.
// A file that cannot be read is left out, and the rules stand without it.
async function readSections($: EngineInterface): Promise<PromptComposeSection[]> {
  const lane = promptLaneOf(await $.env.get('WORKBENCH_SKIP_WARMUP'), await $.env.get('CLAUDE_CODE_AGENT'))
  if (lane === 'none') return []
  const home = await $.env.get('HOME')
  const installed = home ? await readIfAny($, `${home}/.claude/plugins/installed_plugins.json`) : undefined
  const paths = installed === undefined ? [] : contributionPathsOf(installed)
  const texts: (string | undefined)[] = []
  for (const path of paths) texts.push(await readIfAny($, path))
  return sectionsFor(lane, contributionsOf(texts))
}

const readIfAny = async ($: EngineInterface, path: string): Promise<string | undefined> =>
  (await $.fs.exists(path).catch(() => false)) ? $.fs.read(path).catch(() => undefined) : undefined

// An instruction file of the user's tier with the block an older warmup
// spliced into it left out, read against the file on disk. Undefined when the
// file holds no such block, or the block is not found whole in its text.
async function unspliced($: EngineInterface, file: InstructionFile): Promise<InstructionFile | undefined> {
  if (file.kind !== 'user') return undefined
  const raw = await readIfAny($, file.path)
  const content = raw === undefined ? file.content : withoutSplice(file.content, splicedBodiesOf(raw))
  return content === file.content ? undefined : { ...file, content }
}

const GUARD_FAILED =
  'Workbench guards (workbench-core): the guards that judge this call could not finish, so the call is refused. Try the call again. If it is refused again, stop and tell Mike which call it was.'

type Guarded = Record<string, unknown> & { tool: string; agentId?: string }

// Each root with where it lands once its symbolic links are followed. A path
// that does not resolve keeps its spelling alone.
async function withRealPaths($: EngineInterface, roots: readonly SearchRoot[]): Promise<SearchRoot[]> {
  return Promise.all(
    roots.map(async root => {
      if (root.path === undefined) return root
      const stat = await $.fs.stat(root.path, { resolve: true }).catch(() => undefined)
      return stat?.realPath === undefined ? root : { ...root, real: stat.realPath }
    }),
  )
}

// The heredoc targets that are missing or regular files right now, followed
// through any symbolic link. A FIFO, a socket, a device, a folder, or a
// target the stat cannot answer for is left out, so its body is read.
async function regularFiles($: EngineInterface, targets: readonly string[], home: string | undefined): Promise<ReadonlySet<string>> {
  const regular = new Set<string>()
  for (const target of targets) {
    // A relative target lands in the Bash tool's live directory, not the engine's.
    const path = resolvePath(target, await $.session.cwd(), home)
    if (path === undefined) continue
    const kind = await $.fs.stat(path, { resolve: true }).then(
      stat => stat.kind,
      () => undefined,
    )
    // A stat that fails counts as missing only when nothing is at the path.
    const isMissing = kind === undefined && !(await $.fs.exists(path).catch(() => true))
    if (kind === 'file' || isMissing) regular.add(target)
  }
  return regular
}

// The guards' verdict on one tool call (hooks/mods/guards.ts): a refusal, an
// advisory to add to the result, or nothing. The facts each guard needs are
// read only when the call reaches it.
async function guardVerdict($: EngineInterface, e: Guarded): Promise<{ deny: string } | { advise: string } | undefined> {
  const text = (value: unknown): string => (typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value))
  switch (e.tool) {
    case 'SendMessage': {
      // A lane that cannot be read is taken as a sub-agent's, the gated side.
      const lane = await $.workbench.callerLane(e.agentId === undefined ? {} : { agentId: e.agentId }).catch((): WorkbenchCallerLane => 'sub-agent')
      if (lane !== 'sub-agent') return undefined
      const verdict = peerVerdict({ to: e.to, recipient: e.recipient })
      return verdict === 'deny' ? { deny: PEER_REFUSAL } : verdict === 'advise' ? { advise: PEER_ADVICE } : undefined
    }
    case 'EnterWorktree':
      return { deny: ENTER_WORKTREE_REFUSAL }
    case 'ExitWorktree':
      return e.action === 'remove' ? { deny: EXIT_WORKTREE_REFUSAL } : undefined
    case 'Agent':
      return e.isolation === 'worktree' ? { deny: AGENT_WORKTREE_REFUSAL } : undefined
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
    case 'Grep':
    case 'Glob': {
      const home = await $.env.get('HOME')
      const path = text(e.file_path ?? e.notebook_path ?? e.path)
      const refusal = path === '' ? undefined : credentialPathRefusal(path, home)
      if (refusal !== undefined) return { deny: refusal }
      if (e.tool !== 'Grep' && e.tool !== 'Glob') return undefined
      const roots = await withRealPaths($, toolSearchRoots(e.tool, { path: e.path, pattern: e.pattern }, await $.session.cwd(), home))
      const searched = searchRefusal(roots, home)
      return searched === undefined ? undefined : { deny: searched }
    }
    case 'Bash': {
      const line = text(e.command)
      const parse = parseShell(line)
      const home = await $.env.get('HOME')
      const refusal =
        hiddenCommandRefusal(parse) ??
        credentialRefusal(line, home, parse, await regularFiles($, bodyTargets(parse), home)) ??
        provisioningRefusal(line, parse) ??
        ((await $.env.get('WORKBENCH_SUMMARY_WRITER')) === '1' ? summaryWriterRefusal(parse) : undefined)
      if (refusal !== undefined) return { deny: refusal }
      if (!mentionsSearch(parse)) return undefined
      if (isPartlyRead(parse)) return { deny: SEARCH_UNREAD }
      const roots = searchRoots(parse, await $.session.cwd(), home)
      if (roots.length === 0) return undefined
      const searched = searchRefusal(await withRealPaths($, roots), home)
      return searched === undefined ? undefined : { deny: searched }
    }
    default:
      return undefined
  }
}

export const register: Register = on => {
  // Set at every load, because a reload runs session.start again. Undefined
  // until then: the question rule reads it as unattended, and the noun rejects.
  let sessionAttended: boolean | undefined
  // CLAUDE_CODE_AGENT, read at session start: a top-level --agent run's name.
  let agentName: string | undefined

  on('engine.create', async ($, e, next) => {
    const built = await next(e)
    return {
      ...built,
      workbench: {
        briefSlots: async () => BRIEF_SLOTS,
        briefCheck: async (prompt: string) => checkBrief(typeof prompt === 'string' ? prompt : ''),
        // Answered by the hooks below, which hold `$`. These bottoms answer
        // only when such a hook fails or passes the call on. Two answers are
        // safe for every caller: no scratch root, and the gates on. The lane
        // has no such answer, since `unattended` is the safe side for a nudge
        // and `attended` for a gate, so those two reject, and each caller's
        // .catch picks its own side.
        scratchRoots: async () => [],
        orchestratorIsOn: async () => true,
        isUnattended: async (): Promise<boolean> => {
          throw new Error('workbench: the lane is unknown')
        },
        callerLane: async (): Promise<WorkbenchCallerLane> => {
          throw new Error('workbench: the lane is unknown')
        },
        // Pure, like briefCheck. What the reader cannot read is in the
        // answer's unknowns, so only a line that is not a string rejects.
        parseShell: async (line: string): Promise<WorkbenchShellParse> => {
          if (typeof line !== 'string') throw new Error('workbench: parseShell reads a string')
          return parseShell(line)
        },
      },
    }
  })

  on('workbench.scratchRoots', async $ => {
    const { stdout } = await $.process.run(['bash', `${$.plugin.root}/hooks/lib/scratch-roots.sh`, await $.session.id()])
    return { value: stdout.split('\n').filter(root => root.startsWith('/')) }
  })

  on('workbench.orchestratorIsOn', async $ => {
    if ((await $.env.get('WORKBENCH_ORCHESTRATOR')) === '0') return { value: false }
    if ((await legacyFile($)) === undefined) return { value: false }
    return { value: await orchestratorOn($) }
  })

  // The question rule's own reading: a session a person sits at, and a turn a
  // person opened (turnAttended, from isAttendedPrompt). Before session start
  // the lane is unknown, and the call is passed to the bottom, which rejects.
  on('workbench.isUnattended', async ($, e, next) =>
    sessionAttended === undefined ? next(e) : { value: !sessionAttended || !(await read($, turnAttended)) },
  )

  // Before session start CLAUDE_CODE_AGENT is unread, and an agentId that is
  // not a string is no event's: both are passed to the bottom, which rejects.
  on('workbench.callerLane', async ($, e, next) =>
    sessionAttended === undefined || (e.agentId !== undefined && typeof e.agentId !== 'string')
      ? next(e)
      : { value: laneOf(e.agentId, agentName) },
  )

  on('session.start', async ($, e, next) => {
    sectionsMemo = undefined
    agentName = await $.env.get('CLAUDE_CODE_AGENT')
    sessionAttended = isAttendedSession(e.isInteractive, agentName, await $.env.get('WORKBENCH_DEV_TEAM_PIPELINE'))
    const { value: startedAt } = await $.state.get(STARTED_AT)
    if (startedAt === undefined) await $.state.set(STARTED_AT, await $.clock.now())
    for (const command of COMMANDS) await $.command.register(command)
    // A reload keeps $.state, so the line is drawn again from it.
    await orchestratorOn($).catch(() => undefined)
    await drawStatus($)
    // Nobody reads a status line or a toast in an unattended run.
    if (sessionAttended) {
      // Each read is caught on its own, so one that fails stops neither.
      $.clock.after(SETTLE_MS, () => {
        void probeMemory($).catch(() => undefined)
        void deliverNotices($).catch(() => undefined)
      })
      $.clock.after(NOTICES_LATE_MS, () => void deliverNotices($).catch(() => undefined))
      $.clock.every(PROBE_EVERY_MS, () => {
        void probeMemory($).catch(() => undefined)
        void deliverNotices($).catch(() => undefined)
      })
    }
    return next(e)
  })

  // The SessionStart settings hooks run beneath this one, so once next(e) is
  // back, session-warmup.sh --defer has reconciled dead sessions and written
  // this start's notices. The drain and the Chat-skill scan it left out then
  // run in the background, in every lane the warmup drains in, as it did.
  // Then a person's session reads the notices again, so a Chat-skill notice
  // reaches the status line without waiting for the next probe.
  on('classic.SessionStart', async ($, e, next) => {
    // The transcript the log checkpoint copies from. Every source sets it,
    // `clear` too, which starts a new transcript under a new session id.
    if (typeof e.transcript_path === 'string' && e.transcript_path !== '') await $.state.set(TRANSCRIPT, e.transcript_path)
    const result = await next(e)
    if (e.source === 'startup' || e.source === 'resume') {
      const payload = JSON.stringify({ source: e.source, session_id: e.session_id })
      $.clock.after(DEFERRED_MS, () => {
        void deferredWarmup($, payload)
          .then(() => (sessionAttended === true ? deliverNotices($) : undefined))
          .catch(() => undefined)
      })
    }
    return result
  })

  // A prompt folded into a running turn carries turnId and opens no turn. Any
  // prompt, of any origin and folded or not, ends a "Commit it" pick not yet
  // used for a commit: a peer, channel, plugin, SDK, schedule or task message
  // carries outside text that must not use it. Only Mike's own prompt ends the
  // push left by a commit he approved.
  //
  // A prompt Mike sends starts a task, for the intake nudge. A new turn a
  // person opened gets recall's block beside the prompt, at the tail.
  on('prompt.submit', async ($, e, next) => {
    await update($, commitApproval, approval => (isPersonOrigin(e.origin) || approval === 'commit' ? 'none' : approval))
    if (isPersonOrigin(e.origin) && !isScheduledFire(e.text)) await update($, intake, state => ({ ...state, task: state.task + 1 }))
    if (e.turnId !== undefined) return next(e)
    await update($, turnAttended, () => isAttendedPrompt(e.origin, e.text))
    await update($, turnScheduled, () => e.origin.kind === 'scheduled-trigger' || isScheduledFire(e.text))
    await update($, reprompted, () => false)
    const block = await promptRecall($, e.text).catch(() => undefined)
    return next(block === undefined ? e : { ...e, context: [...(e.context ?? []), block] })
  })

  // One correction turn at most: the engine's stop_hook_active flag, and the
  // per-turn flag the next prompt clears. A synchronous block from a Stop hook
  // beneath, such as another plugin's, stands alone, so two re-prompts never
  // stack. The memory capture checkpoint opens no turn and blocks no stop: it
  // is a fork in turn.complete below.
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    const isOurs =
      sessionAttended === true &&
      !e.agent_id &&
      !e.agent_type &&
      !e.stop_hook_active &&
      result.block === undefined &&
      (await read($, turnAttended)) &&
      !(await read($, reprompted))
    if (!isOurs || !(await asksInProse($, e.last_assistant_message ?? ''))) return result
    await update($, reprompted, () => true)
    return { ...result, block: REPROMPT_REASON }
  })

  on('tool.call', async ($, e, next) => {
    // The guards judge first, in every lane. One that throws refuses the call.
    const verdict = await guardVerdict($, e as Guarded).catch(() => ({ deny: GUARD_FAILED }))
    if (verdict !== undefined && 'deny' in verdict) return { deny: verdict.deny }
    if (verdict !== undefined) {
      const result = await next(e)
      return result.deny !== undefined ? result : { ...result, context: [...(result.context ?? []), verdict.advise] }
    }
    if (e.tool === 'AskUserQuestion') {
      // The commit approval rule: the commit question is asked alone, and a
      // "Commit it" pick is what approves the commit.
      const isGated = await isCommitGated($, sessionAttended, e.agentId)
      if (isGated && bundlesCommit(e.questions)) return { deny: BUNDLE_REFUSAL }
      // The question rule. A call no message holds (another plugin's
      // $.ui.ask) is let through: there is no message to read the context from.
      if (e.agentId === undefined && sessionAttended === true && (await read($, turnAttended))) {
        const messages = await $.session.messages({ as: 'api' })
        if (hasContextBefore(messages, e.tool_use_id) === false) return { deny: REFUSAL_REASON }
      }
      const result = await next(e)
      if (isGated && result.deny === undefined && isCommitPick(e.questions, result.result)) await update($, commitApproval, () => 'commit')
      return result
    }
    // The commit approval rule: one "Commit it" pick allows one commit, then
    // the push of that commit. A command that only mentions git, such as a grep
    // for the word, is not one. Whether the commit and the push landed is read
    // from the repository the line runs in, before and after it, and from its
    // exit status: the pick is kept only when HEAD did not move and the line
    // reported an error. A background run cannot be watched, so it is taken
    // as landed.
    // A content search in the main loop gets recall's block beside its result.
    if (e.tool === 'Bash') {
      const { writes, dir: steps } = readLine(e.command)
      if (writes.commits + writes.pushes === 0 || !(await isCommitGated($, sessionAttended, e.agentId))) {
        return withScanRecall($, 'Bash', e.command, e.agentId, await next(e))
      }
      const refusal = refusalOf(writes, await read($, commitApproval))
      if (refusal !== undefined) return { deny: refusal }
      const dir = dirOf(steps, await $.session.cwd(), await $.env.get('HOME'))
      const before = dir === undefined ? undefined : await refsOf($, dir)
      const result = await next(e)
      if (result.deny !== undefined) return result
      const output = result.result as { backgroundTaskId?: unknown } | undefined
      const isBackground = e.run_in_background === true || output?.backgroundTaskId !== undefined
      const after = dir === undefined || isBackground ? undefined : await refsOf($, dir)
      await update($, commitApproval, () => approvalAfter(writes, before, after, result.isError === true))
      return result
    }
    // The vault write checks, in every lane: a sub-agent or a summary-writer
    // writes the same vault.
    const vaultTool = vaultToolOf(e.tool)
    if (vaultTool !== undefined) {
      const checked = await checkVaultWrite($, e as VaultCall, vaultTool)
      return 'deny' in checked ? checked : next(checked.call as typeof e)
    }
    // The calls the bash gates judge read the legacy file next, so it is put
    // back in line with the mode Mike chose first. A file the model wrote to
    // stand the gates down is removed here.
    if (e.agentId === undefined && (e.tool === 'Write' || e.tool === 'NotebookEdit' || e.tool === 'Agent')) {
      // One caught expression: a rejected seed must not throw the hook, which
      // the engine would skip, leaving the gates an unmirrored file.
      // A mode that cannot be read is taken as on, the closed way.
      await orchestratorOn($)
        .catch(() => true)
        .then(isOn => mirror($, isOn))
        .catch(() => undefined)
      return next(e)
    }
    // The intake nudge rides the result of the task's first Edit. It never
    // denies.
    if (e.tool === 'Edit' && e.agentId === undefined) {
      const result = await next(e)
      if (result.deny !== undefined || !(await isIntakeDue($, sessionAttended).catch(() => false))) return result
      return { ...result, context: [...(result.context ?? []), NUDGE] }
    }
    // A learnings file past the limit goes on the status line, after the
    // skill has its learnings: the skill.prompt hook below merges them in.
    if (e.tool === 'Skill') {
      const result = await next(e)
      const name = skillNameOf(e.skill)
      if (name !== undefined) {
        try {
          const { stdout } = await $.process.run(['bash', `${$.plugin.root}/scripts/learnings-count.sh`, name])
          await update($, learnings, due => learningsAfter(due, name, countOf(stdout)))
          await drawStatus($)
        } catch {
          // The line keeps what it showed.
        }
      }
      return result
    }
    return next(e)
  }).catch(($, e, next) =>
    // A hook that failed or overran its budget before it passed a guarded call
    // on refuses it. Any other call goes on, as it did before the guards moved
    // here, and a call already passed on keeps its answer.
    next.called ? next(e) : GUARDED.has(e.tool) ? { deny: GUARD_FAILED } : next(e),
  )

  on('command.run', async ($, e, next) => {
    if (!OURS.has(e.command)) return next(e)
    if (e.command === 'orchestrator') {
      if (!isPersonOrigin(e.origin)) return { text: REFUSAL }
      const toggle = toggleOf(e.args)
      if (toggle === undefined) {
        $.ui.toast(USAGE)
        return {}
      }
      if (toggle !== 'status') await setOrchestrator($, toggle === 'on')
      const isOn = await orchestratorOn($)
      await drawStatus($)
      $.ui.toast(reportOf(isOn))
      return {}
    }
    if (e.command === PENDING) {
      if (!isPersonOrigin(e.origin)) return { text: PENDING_REFUSAL }
      await processPendingSummaries($, e.args)
      return {}
    }
    if (e.command === 'memory-status') {
      const { stdout, stderr } = await $.process.run(['bash', `${$.plugin.root}/scripts/memory-status.sh`], { timeoutMs: 30_000 })
      await showPane($, { title: 'Memory status', text: `\`\`\`\n${stdout || stderr}\n\`\`\`` })
      return {}
    }
    const file = await noticesFile($)
    const text = file !== undefined && (await $.fs.exists(file)) ? await $.fs.read(file) : 'No warmup notices file yet.'
    await showPane($, { title: 'Warmup notices', text })
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Markdown } = $.ui.resolve(e)
    // h() over an element constructor always builds an element.
    return h(Markdown, { text: (await read($, pane)).text }) as RenderElement
  })

  // Each main-loop API request, priced from its own usage once the response is
  // whole. A sub-agent's request carries agentId. A step with no usage got no
  // response, so the line keeps the last request.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const usage = result.usage
    if (e.agentId === undefined && usage !== null) {
      await update($, meter, state => countRequest(state, usage))
      await meterCache($, usage, sessionAttended === true).catch(() => undefined)
      await drawStatus($)
    }
    return result
  })

  // A skill's vault learnings, merged into the text it expands to (hooks/mods/
  // learnings.ts), in every lane: they are part of the skill's instructions.
  // The same file gives the same bytes. No file, or no vault, leaves the text
  // as it was.
  on('skill.prompt', async ($, e, next) => {
    const result = await next(e)
    const name = skillNameOf(e.skill)
    if (name === undefined) return result
    try {
      const root = await vaultRoot($)
      const file = root === undefined ? undefined : `${root}/${learningsPath(name)}`
      if (file === undefined || !(await $.fs.exists(file))) return result
      return { ...result, text: withLearnings(result.text, name, await $.fs.read(file)) }
    } catch {
      return result
    }
  })

  // The workbench rules (hooks/mods/prompt-rules.ts): shared sections after the
  // engine's own shared ones, so every shared section stays ahead of every
  // session one. The answer is the same bytes on every render of the load.
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    const ours = await workbenchSections($)
    return ours.length === 0 ? result : { sections: withShared(result.sections, ours) }
  })

  // The harness's memory section, which keeps memories in a per-project folder,
  // is left out in every lane: the vault is the one store, and the memory
  // section above routes to it.
  on('prompt.section', { name: HARNESS_MEMORY }, () => ({ text: null }))

  // The block an older warmup spliced into ~/.claude/CLAUDE.md stays in the
  // file until setup takes it out, so the first message leaves it out here,
  // for the main loop and every sub-agent alike. A file that held nothing but
  // the block is left out whole. The user's own text is never changed.
  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    const files = result.instructionFiles ?? e.instructionFiles
    if (files === undefined) return result
    const kept: InstructionFile[] = []
    let changed = false
    for (const file of files) {
      const stripped = await unspliced($, file).catch(() => undefined)
      if (stripped === undefined) kept.push(file)
      else {
        changed = true
        if (stripped.content.trim() !== '') kept.push(stripped)
      }
    }
    return changed ? { ...result, instructionFiles: kept } : result
  })

  // A sub-agent's system prompt is its own, so it gets the rules as context at
  // its start: its parent's sections, as the CLAUDE.md block and the router
  // stub reached it before. An agent that leaves CLAUDE.md out gets none.
  on('classic.SubagentStart', async ($, e, next) => {
    const result = await next(e)
    if (OMITS_CLAUDE_MD.has(e.agent_type)) return result
    const text = subagentContextOf(await workbenchSections($))
    return text === undefined ? result : { ...result, additionalContext: [...(result.additionalContext ?? []), text] }
  })

  // T counts completed main-loop turns, and rows measures the reply that
  // ended the turn. Each main-loop turn, answered or interrupted, checkpoints
  // the session log, in the background: an overlapping run waits on
  // session-log.sh's lock. A sub-agent's turn is in its parent's transcript.
  // It also counts toward the memory capture, which runs as a fork.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      await update($, meter, countTurn)
      if (e.reason !== 'refusal') await update($, replyRows, () => rowsOf(e.answer))
      await drawStatus($)
      void $.session
        .id()
        .then(id => checkpointLog($, id, 'turn', undefined, 30_000))
        .catch(() => undefined)
      if ((e.reason === 'answer' || e.reason === 'aborted') && (await isCaptureOn($, sessionAttended))) {
        const first = thresholdOf(await $.env.get('WORKBENCH_CAPTURE_STOP_FIRST'), FIRST)
        const repeat = thresholdOf(await $.env.get('WORKBENCH_CAPTURE_STOP_INTERVAL'), REPEAT)
        const { turns, hasFired } = await read($, capture)
        const isDue = isCaptureDue(turns + 1, hasFired, first, repeat)
        await update($, capture, state => (isDue ? { ...state, turns: 0, hasFired: true } : { ...state, turns: turns + 1 }))
        if (isDue) void captureMemory($).catch(() => undefined)
      }
    }
    return result
  })

  // Every exit checkpoints the session log, inside what is left of the exit
  // budget: SIGHUP and SIGTERM fire this, where the settings SessionEnd hook
  // may not run. When it did run, it ran first, and this finds nothing new.
  // A /clear starts the conversation over, so the meters, the reply rows, a
  // "Commit it" pick, the capture count, recall's dedupe set and the intake
  // task start over with it.
  on('session.end', async ($, e, next) => {
    const timeoutMs = endTimeoutOf(next.budget.remainingMs)
    if (timeoutMs !== undefined) await checkpointLog($, e.sessionId, 'final', e.reason, timeoutMs).catch(() => undefined)
    if (e.reason === 'clear') {
      await update($, meter, () => EMPTY)
      await update($, cache, () => EMPTY_CACHE)
      await update($, replyRows, () => null)
      await update($, commitApproval, () => 'none')
      await update($, capture, () => ({ turns: 0, hasFired: false, written: [] }))
      await update($, recall, () => ({ seen: [], queries: [] }))
      await update($, intake, () => ({ task: 0, checked: 0 }))
      await drawStatus($)
    }
    return next(e)
  })
}
