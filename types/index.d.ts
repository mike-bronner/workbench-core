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
// isUnattended, callerLane, parseShell.

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

// What parseShell could not read. Each names the construct, and any of them
// means the statements may be missing a command bash runs, or may name one
// wrongly. A caller that must not let an unread command through refuses a
// line with any unknown.
//   quote         a quote with no closing quote
//   substitution  a $( ), backtick, <( ), $(( )), $[ ] or (( )) with no close
//   heredoc       a heredoc with no terminator line: bash reads the rest of
//                 the text as its body, and so does the reader
//   escape        a $'…' escape the reader does not decode (\u, \U, \c, ...)
//   wrapper       a wrapper option the reader cannot place (isPlaced),
//                 including one that hands its command to a shell (`sudo -s`,
//                 `flock <file> -c`)
//   expansion     a command name from a variable or a substitution (`$X a`)
//   stdin         a shell with no script reads one from a pipe or a
//                 here-string (`echo x | sh`, `cat <<EOF | bash`). A heredoc
//                 piped in, or the here-string, is still read as a script.
//   depth         scripts nested past four levels, which are not read
export type WorkbenchShellUnknown = 'quote' | 'substitution' | 'heredoc' | 'escape' | 'wrapper' | 'expansion' | 'stdin' | 'depth'

// One redirect of a statement. A real one is an operator bash reads: `op` is
// the operator as written (`>`, `>>`, `<`, `<>`, `>|`, `&>`, `&>>`, `>&`,
// `<&`, `<<<`, `<<`, `<<-`), `fd` the file descriptor written before it, and
// `target` its target word, quotes removed (a heredoc's delimiter for `<<`).
// A redirect that is not real is a `>` or `<` that bash reads as text: inside
// quotes (an awk or sed program), after a backslash, in a heredoc body, in
// arithmetic, or in a [[ ]] test.
// Its `op` is that one character, and its `fd` and `target` are empty. A
// comment is never read at all.
export type WorkbenchShellRedirect = {
  op: string
  fd: string
  target: string
  isReal: boolean
}

// One heredoc of a statement. `body` is its text, as written. `isQuoted` is
// true when any part of the delimiter was quoted, so bash does not expand the
// body. `feedsShell` is true when a shell or eval reads the body as a script,
// directly or through a pipe (`cat <<EOF | bash`): its statements are then in
// the list, with source `heredoc`. `isTerminated`
// is false when no line ends the body, and the `heredoc` unknown is set.
export type WorkbenchShellHeredoc = {
  delimiter: string
  body: string
  isQuoted: boolean
  stripsTabs: boolean
  feedsShell: boolean
  isTerminated: boolean
}

// Where a statement was read. `line` is the text itself. `substitution` is a
// $( ), backtick or <( ), or one inside arithmetic. `script` is the script of
// a shell -c, eval's words, a trap's handler, or a here-string fed to a shell.
// `heredoc` is a heredoc body that feeds a shell, or a substitution in a body
// bash expands.
export type WorkbenchShellSource = 'line' | 'substitution' | 'script' | 'heredoc'

// One simple command of the line. An arithmetic command `(( … ))` is a
// statement named `((` whose expression is not read as words, when the text
// reads as arithmetic, and a word after it is a statement of its own. Text
// that does not read as arithmetic is read as commands. In a `[[ … ]]` test,
// < and > are words, never redirects. A && || | ( ) there still splits the
// statement, so no command is hidden in a test, and the test goes on to its
// ]]. Only a bare `[[` in command position, with no redirect or assignment
// before it, opens a test, and a ]] right before an operator closes it. A
// case pattern is read as words, so it may show as arguments or a
// statement, and its substitutions are statements.
export type WorkbenchShellStatement = {
  // Every word, quotes removed, redirects and their targets taken out. `$_`
  // stands where a substitution stood.
  words: readonly string[]
  // The index in words of the command name, past the assignments, keywords
  // (if then else elif do while until ! { coproc, and the closers } fi done
  // esac) and wrappers in front of it. -1 when there is none (`x=1`,
  // `> file`).
  nameAt: number
  // The command name: its last path part, lowercased, as macOS finds GIT on
  // its case-insensitive disk (`/usr/bin/GIT` is `git`). Empty when nameAt is
  // -1. A name holding `$` is only known at run time, and sets the
  // `expansion` unknown.
  name: string
  // The words after the name, exactly as bash passes them: no flag is joined,
  // split, normalized or dropped (`-fu`, `+main`, `:old` stay as written).
  args: readonly string[]
  // The NAME=value words in front of the name, env's included.
  assignments: readonly string[]
  // The wrappers in front of the name, lowercased, in order (`sudo`, `env`).
  wrappers: readonly string[]
  // For git and gh, the index in args of the subcommand, past the global
  // options and their values (`git -C x push` is 2, `gh -R o/r pr merge` is
  // 2). -1 for any other command, and when there is no subcommand.
  subcommandAt: number
  // False when a wrapper option could not be placed, so the name may be an
  // option's value and the real command later in args. The `wrapper` unknown
  // is set too.
  isPlaced: boolean
  // The indexes in words of every word that holds a $'…' backslash escape.
  // Bash may decode such a word to any name (`$'\x67it'` is git), so an
  // escaped name, option or subcommand is possibly anything.
  escaped: readonly number[]
  // True when the statement runs whenever the line runs: no && or ||, and no
  // if, while, until, case, for, select, function or `name()` came before it
  // in the line. A nested statement takes the value of the one that holds it,
  // and a trap's handler is never certain.
  // False is the safe side for a caller that needs certainty.
  isCertain: boolean
  redirects: readonly WorkbenchShellRedirect[]
  heredocs: readonly WorkbenchShellHeredoc[]
  source: WorkbenchShellSource
  // How many substitutions, scripts and heredoc bodies hold the statement.
  depth: number
}

// The reading of one Bash command line.
export type WorkbenchShellParse = {
  // In reading order. A substitution's statements come before the statement
  // it stands in, a script's right after the statement that runs it, and a
  // body's after the line of its heredoc.
  statements: readonly WorkbenchShellStatement[]
  // What could not be read, sorted, each once. Empty when the reading is
  // whole.
  unknowns: readonly WorkbenchShellUnknown[]
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
  // The reading of a Bash command line by hooks/mods/shell.ts, the one shell
  // reader core's commit gate reads lines through. It reads, and decides
  // nothing: every rule stays with its caller. What it cannot read is named in
  // `unknowns`, never left out silently. REJECTS when `line` is not a string.
  parseShell: (line: string) => Promise<WorkbenchShellParse>
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
