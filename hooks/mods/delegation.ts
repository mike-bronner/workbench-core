// The delegation reminder: once per session, the main agent's first whole-file
// write draws a note to give whole-file work to a sub-agent, so the main
// conversation stays an orchestrator. Judged in hooks/register.ts's tool.call
// hook. It replaced the bash delegation gate.
//
// IT NEVER DENIES, SINCE 2026-10-05, AND IT NEVER ALLOWS. It used to deny every
// main-agent whole-file write outside the scratchpads. Plan mode lets the main
// agent write exactly one file, its plan under ~/.claude/plans/, and the deny
// refused that write, so plan mode was unusable while the gate was on. Mike
// decided the main agent may write a file when it needs to, and that
// delegation stays advice. So the reminder is context on the call's result and
// nothing else: the write goes through the normal permission flow exactly as it
// would without the module. An allow would skip the permission prompt, which
// this reminder has no business granting.
//
// THREE DEVIATIONS FROM THE BASH GATE, each on purpose:
//   - a write denied beneath the module draws no reminder and does not use up
//     the session's one reminder. The bash gate ran before the permission
//     flow, so a denied write used it up;
//   - a session id the engine never sends, an empty agentId, is not a case:
//     the bash pin for it guarded a field-splitting bug in its own parser;
//   - a final realPath stat that fails is silence, as every failure here is.
//     The bash gate reminded when physical_dir failed. A realPath that is
//     merely absent still settles nothing, and still draws the reminder.
//
// IT FAILS OPEN, TO SILENCE. Every guard in hooks/mods/guards.ts fails closed.
// This is advice, not a guard: a failure inside it must never block the write,
// so the only cost of a broken reminder is a missing reminder. register.ts
// judges it after the write has gone through the engine, and catches its
// rejection on the spot.
//
// ONCE PER SESSION. A reminder on every write spends tokens on every turn, and
// cutting tokens is the point of delegating. The engine's $.state holds the
// session id that drew the reminder, changed with `update`, which writes with
// ifVersion and retries on a miss: of two writes racing each other, only the
// one whose change saw another session's id wins the reminder. $.store keeps
// each reminded session id for REMIND_DAYS, as the bash gate's marker files
// were swept after 3 days, so a session resumed in a new process is not
// reminded again. A store that cannot be read or written leaves the reminder
// silent, never repeating.
//
// Silent, in the bash gate's order:
//   - a sub-agent (agentId) or a top-level `claude -p --agent` run: the lane
//     from $.workbench.callerLane is not `main`;
//   - WORKBENCH_ORCHESTRATOR=0, /orchestrator off, or a session id that cannot
//     name a file: $.workbench.orchestratorIsOn() answers false;
//   - any tool but Write and NotebookEdit. Edit is not gated, since
//     2026-09-27: a delegated one-line edit measured tens of thousands of
//     tokens against about 200 inline;
//   - a target in a scratch root ($.workbench.scratchRoots(), which includes
//     the plans folder), compared physically (physicalTarget in register.ts).
//
// THE REMINDER GOES TO THE MODEL ONLY, and carries no Markdown emphasis: the
// model receives the raw source, so asterisks would show up as asterisks.
//
// The gate table in hooks/mods/prompt-rules.ts names this module as the
// Delegation gate (workbench-core), and hooks/test-session-warmup.sh finds it
// here by that name.
//
// Pure functions only: the engine follows `$` into no imported function.

export const REMIND_STORE_KEY = 'delegation-reminded'
// Days a reminded session id is kept.
export const REMIND_DAYS = 3
const DAY_MS = 24 * 60 * 60 * 1000

export const REMINDER =
  'Delegation reminder (workbench-core, advisory, this write goes ahead). The main conversation orchestrates, and its context stays lean when whole-file work goes to a sub-agent dispatched with the Agent tool. Use Edit for a partial change.'
export const DEV_TEAM_LINE = 'For development work, dispatch Dr. Watson in Direct mode per /workbench-dev-team:orchestrate.'
export const ONCE_LINE = 'This reminder shows once per session.'

// A dev-team plugin gets named when one is installed: a runtime directory
// probe, never a build-time dependency, so core stays agnostic either way.
export const reminderOf = (hasDevTeam: boolean): string => [REMINDER, ...(hasDevTeam ? [DEV_TEAM_LINE] : []), ONCE_LINE].join(' ')

export const isWholeFileWrite = (tool: string): boolean => tool === 'Write' || tool === 'NotebookEdit'

// The call's target: NotebookEdit names it notebook_path, Write file_path.
export function targetOf(input: { file_path?: unknown; notebook_path?: unknown }): string {
  const path = input.file_path ?? input.notebook_path
  return typeof path === 'string' ? path : ''
}

// The reminded sessions, as $.store keeps them: when each was reminded.
// Entries older than REMIND_DAYS are dropped.
export type Reminded = Record<string, number>

export function remindedOf(value: unknown, now: number): Reminded {
  if (typeof value !== 'object' || value === null) return {}
  return Object.fromEntries(Object.entries(value).filter(([, at]) => typeof at === 'number' && now - at < REMIND_DAYS * DAY_MS))
}

// The target cut where the file system must answer: its folder and its name,
// or undefined for a target that cannot be placed by spelling (relative, or a
// name that is empty, `.` or `..`).
export function splitTarget(path: string): { dir: string; name: string } | undefined {
  if (!path.startsWith('/')) return undefined
  const cut = path.lastIndexOf('/')
  const name = path.slice(cut + 1)
  return name === '' || name === '.' || name === '..' ? undefined : { dir: path.slice(0, cut), name }
}

// Whether the part of a target below its deepest existing folder climbs or
// stays put: a `.` or `..` there is never folded, so it cannot pass a prefix.
export const hasDotPart = (rest: string): boolean => rest.split('/').some(part => part === '.' || part === '..')

// Whether a physical target lies inside one of the roots. The filesystem root
// is never a scratch root.
export const isInRoots = (target: string, roots: readonly string[]): boolean =>
  roots.some(root => root !== '/' && root !== '' && target.startsWith(`${root.replace(/\/+$/, '')}/`))
