// The type contract of workbench-core's hooks module: the $.workbench noun it
// adds to $, and the values it keeps in $.state for the session.
// `claude plugin validate` holds every $.state key the module names to this
// file, and checks the noun against it.
//
// $.workbench IS A CONTRACT OTHER PLUGINS BUILD ON. workbench-dev-team lists
// workbench-core under "dependencies" in its plugin.json, and the engine then
// lays this file into dev-team's .claude-plugin/types/workbench-core/, so the
// noun is typed on dev-team's $ with nothing copied. Keep it small: a member
// added here is a member every dependent may come to rely on, and a member
// renamed or removed breaks them. README.md, "The $.workbench noun", is the
// prose half of this contract.
//
// The engine takes a noun as an object of methods only, each method an event of
// its own (`workbench.briefCheck`) taking at most one argument. A member that is
// data, or an object of methods, is refused when the module loads ("an
// interface is an object of methods"). So the slots are a method, and the names
// are flat: briefSlots, briefCheck, scratchRoots, orchestratorIsOn,
// isUnattended, callerLane.

// One slot of the six-slot dispatch brief: the header a brief writes at the
// start of a line, and what the slot carries. hooks/lib/brief-template.sh holds
// the same records for the bash gate.
export type WorkbenchBriefSlot = {
  header: string
  description: string
}

// What kind of prompt briefCheck read. `brief` is every prompt that is not one
// of the others. `item-id` and `repo-sweep` are the two machine-built dispatch
// shapes (`Item ID: <n>`, `Repo sweep: <owner/repo>`) the gate lets through
// with no brief. `blank` is a prompt with nothing but ASCII whitespace in it.
export type WorkbenchBriefShape = 'brief' | 'item-id' | 'repo-sweep' | 'blank'

// The dispatch gate's verdict on one prompt. isComplete is true when the gate
// would let the dispatch through: every slot present, or a shape that needs no
// brief. missing names the absent slot headers in template order, and is empty
// whenever isComplete is true.
export type WorkbenchBriefCheck = {
  isComplete: boolean
  missing: readonly string[]
  shape: WorkbenchBriefShape
}

// Who makes a call. `main` is the main loop of a session a person may sit at.
// `sub-agent` is an agent the Agent tool spawned: its events carry agentId.
// `top-level-agent` is the main loop of a `claude -p --agent <name>` run, the
// scheduled dev-team pipeline among them: no agentId, and CLAUDE_CODE_AGENT set.
export type WorkbenchCallerLane = 'main' | 'sub-agent' | 'top-level-agent'

// What callerLane reads: the agentId of the event the caller is handling, or
// nothing for a main-loop event.
export type WorkbenchCallerLaneArgs = {
  agentId?: string
}

export type Workbench = {
  // The six slots, in template order.
  briefSlots: () => Promise<readonly WorkbenchBriefSlot[]>
  // The verdict hooks/agent-dispatch-gate.sh gives `prompt`. It reads the
  // prompt alone: who dispatched it, and the orchestrator toggle, are the
  // caller's to weigh (orchestratorIsOn).
  briefCheck: (prompt: string) => Promise<WorkbenchBriefCheck>
  // The physical scratch roots of this session, one absolute path each: the
  // session scratchpad, ~/Developer/scratchpad and ~/.claude/plans, from
  // hooks/lib/scratch-roots.sh. A root that does not exist is left out, so the
  // list may be empty. Never derived from $HOME or $TMPDIR.
  scratchRoots: () => Promise<readonly string[]>
  // Whether orchestrator mode is on for this session: the delegation reminder
  // and the agent dispatch gate are active. False when Mike ran /orchestrator
  // off, when WORKBENCH_ORCHESTRATOR=0, and when the session id cannot address
  // the toggle, which is when the bash gates stand down too.
  orchestratorIsOn: () => Promise<boolean>
  // Whether nobody is there to answer, as the question rule reads it
  // (hooks/mods/lane.ts, the one definition). True when the session is not
  // interactive (`claude -p`, the SDK), is a top-level `--agent` run, or runs
  // under WORKBENCH_DEV_TEAM_PIPELINE=1, and when no person opened the current
  // turn: a schedule (the scheduled-trigger origin or the `<scheduled-task `
  // wrapper), a peer session, the SDK, a channel, or a plugin. True too before
  // the first prompt of an interactive session.
  //
  // REJECTS when the lane is unknown: before the session has started, or when
  // the hook that answers fails. There is no answer safe for every caller, so
  // the caller picks its own side in its .catch: a nudge or a UI treats it as
  // unattended, a gate as attended.
  isUnattended: () => Promise<boolean>
  // The lane of the caller of an event: pass the event's agentId. REJECTS when
  // the lane is unknown (before session start, an agentId that is not a
  // string, or a failed hook), for the reason isUnattended does: a gate that
  // treats an unknown as `main` stays on, and a nudge treats it otherwise.
  callerLane: (args: WorkbenchCallerLaneArgs) => Promise<WorkbenchCallerLane>
}

// One main-loop API request: the model that answered, and its cost in US
// dollars. usd is null when that model has no price.
export type RequestCost = {
  model: string
  usd: number | null
}

// The request meter's figures: turns completed since session start, the
// session's first API request, and its latest. first never moves once set.
export type MeterState = {
  turns: number
  first: RequestCost | null
  last: RequestCost | null
}

// What the workbench pane shows: its title and its markdown.
export type PaneContent = {
  title: string
  text: string
}

declare module 'claude-code' {
  interface EngineInterface {
    workbench: Workbench
  }

  interface PluginState {
    'workbench-core': {
      meter: MeterState
      // Whether a person opened the current turn, so the question rule applies.
      turnAttended: boolean
      // Whether the question rule already re-prompted in the current turn.
      reprompted: boolean
      // Where Mike's last "Commit it" pick stands: `commit` while it is unused,
      // `push` once its commit ran and the push of that commit is left, `none`
      // once used up. Any prompt ends `commit`, and only Mike's own prompt
      // ends `push` (hooks/mods/commit-approval.ts).
      commitApproval: 'none' | 'commit' | 'push'
      // Whether a schedule opened the current turn: the scheduled-trigger
      // origin, or the `<scheduled-task ` wrapper. The commit rule skips it.
      turnScheduled: boolean
      // When this session first started, in ms. A reload keeps it.
      startedAt: number
      // The mtime of the warmup notices file last shown, in ms.
      noticesMtime: number
      // Orchestrator mode for this session. Unset until session.start seeds it.
      orchestratorOn: boolean
      // The memory server's health as the probe names it (UP, BUILDING,
      // DOWN, ...). Unset until the first probe answers.
      memoryHealth: string
      // Skills whose learnings file is past the 30-entry limit, with the count.
      learnings: Record<string, number>
      // The rows the last main-loop reply takes at 80 columns.
      replyRows: number | null
      // The headings of the warmup notices outstanding at session start.
      notices: string[]
      // What the workbench pane shows.
      pane: PaneContent
    }
  }
}
