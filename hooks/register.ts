// workbench-core's hooks module, beside the command hooks in hooks.json. The
// command hooks stay registered: the guards move here only after parity.
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
//
// The logic is pure and lives in mods/. Every hook that touches `$` lives in
// this file, because the engine follows `$` into no imported function, and a
// plugin registers each event once: so each event below has one hook, and the
// hook branches where several features share the event.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, Register, RenderElement, TurnUsage } from 'claude-code'

import type { CacheState, ChurnEvent, PaneContent, WorkbenchCallerLane, WorkbenchShellParse } from '../types'
import { BRIEF_SLOTS, checkBrief } from './mods/brief'
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
import {
  NAME as PENDING,
  OVERWRITE,
  REFUSAL as PENDING_REFUSAL,
  SKIP,
  USAGE as PENDING_USAGE,
  askOverwrite,
  outcomeOf,
  reportOf as pendingReportOf,
  requestOf,
} from './mods/pending-summaries'
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

// /process-pending-summaries: the script's outcome, asking Mike before a
// summary that exists is replaced, and reported in a toast.
async function processPendingSummaries($: EngineInterface, args: string): Promise<void> {
  const request = requestOf(args)
  if (request === undefined) {
    $.ui.toast(PENDING_USAGE)
    return
  }
  const run = async (argv: readonly string[]) =>
    outcomeOf(
      await $.process
        .run(['bash', `${$.plugin.root}/scripts/process-pending-summaries.sh`, ...argv], { timeoutMs: 60_000 })
        .then(({ stdout }) => stdout, () => ''),
    )
  const { sid } = request
  let outcome = await run(sid === undefined ? [] : request.overwrite ? [sid, '--overwrite'] : [sid])
  if (outcome.result === 'exists' && sid !== undefined) {
    // A dismissed dialog, or a run with nobody to ask, keeps the summary.
    const answer = await $.ui.ask(askOverwrite(sid), { options: [SKIP, OVERWRITE], header: 'Summary' }).catch(() => SKIP)
    if (answer !== OVERWRITE) {
      $.ui.toast(`Kept the existing summary for session ${sid}.`)
      return
    }
    outcome = await run([sid, '--overwrite'])
  }
  $.ui.toast(pendingReportOf(outcome, sid), { timeoutMs: 10_000 })
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
  on('prompt.submit', async ($, e, next) => {
    await update($, commitApproval, approval => (isPersonOrigin(e.origin) || approval === 'commit' ? 'none' : approval))
    if (e.turnId === undefined) {
      await update($, turnAttended, () => isAttendedPrompt(e.origin, e.text))
      await update($, turnScheduled, () => e.origin.kind === 'scheduled-trigger' || isScheduledFire(e.text))
      await update($, reprompted, () => false)
    }
    return next(e)
  })

  // One correction turn at most: the engine's stop_hook_active flag, and the
  // per-turn flag the next prompt clears. A synchronous block from a Stop hook
  // beneath, such as another plugin's, stands alone, so two re-prompts never
  // stack. The memory checkpoint is not one: hooks.json registers it with
  // asyncRewake, so it runs in the background after this chain has settled and
  // never shows here as a block. A turn this hook re-prompts can therefore
  // also get a checkpoint wake later. That wake arrives with stop_hook_active
  // set, so its own stop is never re-prompted.
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
    if (e.tool === 'Bash') {
      const { writes, dir: steps } = readLine(e.command)
      if (writes.commits + writes.pushes === 0 || !(await isCommitGated($, sessionAttended, e.agentId))) return next(e)
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
    // A learnings file past the limit goes on the status line, after the
    // skill has its learnings: hooks/skill-learnings.sh hands them over.
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
  })

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

  // T counts completed main-loop turns, and rows measures the reply that
  // ended the turn.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      await update($, meter, countTurn)
      if (e.reason !== 'refusal') await update($, replyRows, () => rowsOf(e.answer))
      await drawStatus($)
    }
    return result
  })

  // A /clear starts the conversation over, so the meters, the reply rows and a
  // "Commit it" pick start over with it.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, meter, () => EMPTY)
      await update($, cache, () => EMPTY_CACHE)
      await update($, replyRows, () => null)
      await update($, commitApproval, () => 'none')
      await drawStatus($)
    }
    return next(e)
  })
}
