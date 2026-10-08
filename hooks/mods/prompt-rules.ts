// The workbench rules in the system prompt, as prompt.compose sections.
//
// They used to reach a session three ways, each one paid for in every session:
//   - a block session-warmup.sh spliced into ~/.claude/CLAUDE.md on every start
//     (the gates, the scratch roots, and each sibling plugin's
//     session-warmup.md), which rewrote the user's own file
//   - the warmup's stdout (memory routing, and the destructive commands, which
//     stated the scratch roots a second time)
//   - a MEMORY.md router stub in the harness's per-project memory folder, which
//     restated the memory routing beside the harness's own memory section
// All three sat in the first message, which a session creates afresh. Here the
// rules are `shared` sections: the same bytes in every session of a lane, so
// the cache that holds them is read, not created, from the second session on.
// The harness's `memory` section, which told the model to keep memories in a
// per-project folder, is dropped: the vault is the one store.
//
// The rules are stated once. A section holds no date, count, version, session
// id or path read from the machine: the same lane always gets the same bytes,
// and the plugins' own files are the only input (their session-warmup.md,
// whose bytes change only when the plugin does).
//
// Who gets what, as the copies it replaces reached them:
//   main    the main loop of a session the warmup ran in: interactive or
//           `claude -p`. Rules, memory routing, plugin contributions.
//   agent   a top-level `claude -p --agent` run (CLAUDE_CODE_AGENT), which the
//           warmup skipped and the CLAUDE.md block reached. Rules and plugin
//           contributions.
//   none    a summary-writer (WORKBENCH_SKIP_WARMUP=1), which runs with no
//           CLAUDE.md and no warmup on purpose. Nothing.
// A sub-agent gets its parent's set through SubagentStart, as the CLAUDE.md
// block and the router stub reached the sub-agents that load CLAUDE.md. An
// agent that leaves CLAUDE.md out (OMITS_CLAUDE_MD: Explore, Plan and the
// rest) never saw either, and gets none.
//
// The block an older warmup left in ~/.claude/CLAUDE.md is left out of the
// first message at render time (splicedBodiesOf, withoutSplice), so the rules
// are not paid for twice before setup takes the block out of the file
// (scripts/setup-config.sh unsplice-claude-md).
//
// Pure functions only: the engine follows `$` into no imported function, so the
// hooks that read the files live in hooks/register.ts.

import type { PromptComposeSection } from 'claude-code'

export type PromptLane = 'main' | 'agent' | 'none'

export const RULES_ID = 'workbench-core:rules'
export const MEMORY_ID = 'workbench-core:memory'
export const PLUGINS_ID = 'workbench-core:plugins'

// The harness section this plugin drops.
export const HARNESS_MEMORY = 'memory'

export const RULES = `# Workbench gates and scratch roots

These PreToolUse hooks guard every session. Each deny explains its own way through, so read the deny and follow it. A deny is the system working. Report it, and do not route around it.

| Gate | What it protects |
|---|---|
| Delegation gate | Whole-file work belongs in a sub-agent. It never denies: a main-agent \`Write\` or \`NotebookEdit\` goes ahead with a reminder, once per session. Plans and scratch roots draw none. The user's \`/orchestrator off\` silences it. |
| Agent dispatch gate | A main-agent \`Agent\` dispatch must carry the six-slot brief. |
| Destructive scope guard | The destructive commands below run only when every target resolves inside the project or a scratch root. |
| Destructive database guard | Database resets, drops, and destructive SQL are refused. |
| Provisioning guard | Agents do not create worktrees or databases, and do not destroy a worktree they did not create. |
| Vault git guard | Git writes aimed at the memory vault are refused. |
| Credential guard | Reads of \`~/.ssh\`, \`~/.aws\`, \`~/.gnupg\`, and \`.env\` files are refused. |
| Outbound prose guard | \`gh\` and board-MCP prose must pass the output style's mechanical checks. |
| Peer message gate | A sub-agent messages only its orchestrator or the agents it spawned. |

## Scratch roots and destructive commands

- A scratch root is the session scratchpad, \`~/Developer/scratchpad\`, or a \`mktemp -d\` sandbox. Make new scratch in the session scratchpad or \`~/Developer/scratchpad\`. Never create it anywhere under \`/tmp\` outside your session scratchpad, and do not put new scratch in an old \`claude-*scratch*\` folder there either.
- \`rm\`, \`rmdir\`, \`git reset --hard\`, \`git clean\`, \`git stash clear\`/\`drop\`, and git commands that discard working-tree changes (such as \`git restore\`, \`git checkout -- <path>\`, or \`git mv -f\`, also through an alias) run with no prompt when every path they act on resolves inside the project or a scratch root. \`rm\` and \`rmdir\` may also remove a leftover \`/tmp/claude-*scratch*\` folder you own, the folder itself included. It is not a root, so \`git\` verbs there are still denied.
- Outside those roots the guard DENIES, and so does any target it cannot read: a \`$variable\`, a glob, \`bash -c\`, \`ssh\`, \`xargs\`, \`find -delete\`, or a loop body. Spell paths out literally and keep the delete its own command. Never hand the user a \`!\` command to delete your own scratch. A target outside every root that is not scratch is the user's call, and they run it with the \`!\` prefix.`

// The search mode is left to the server: its default picks hybrid when the
// vault has embeddings and keyword when it does not, and naming one broke that
// fallback once. The two recall bullets carry their reasons, because the
// hooks module's recall searches only a prompt's wording and the patterns of
// file searches, and the task's own words are the better query.
export const MEMORY = `## Memory routing

- The workbench memory vault is the CANONICAL durable memory store, served by the \`memory\` MCP (\`mcp__plugin_workbench-core_memory__search\` / \`write\` / etc.).
- Proactively CAPTURE durable knowledge without asking: a decision (+ rationale), a troubleshooting root-cause, a design choice and the options weighed, a non-obvious insight or gotcha, a project/plan outcome, or feedback on how to work — \`write\` it to the vault immediately with frontmatter \`name\` + \`type\` (decision | insight | project | feedback | reference) plus tags/summary/date per vault conventions, then note the save in one line. This is standing authorization: a memory-capture write needs no options round and no confirmation. Do NOT ask first.
- Before saving, \`search\` for an existing memory to UPDATE rather than duplicate. Skip the trivial: routine code edits, facts already in the repo or git, ephemeral chatter. Capture what would otherwise be a "by the way, should I remember this?".
- Recall = vault \`search\`, not directory reads. Omit \`mode\`: the server picks hybrid when the vault has embeddings and keyword when it does not.
- Recall comes FIRST: the moment a task turns up a topic — an error, a tool, a design choice, a repo or file you have worked before — \`search\` the vault BEFORE you scan the repo for the answer. Auto-recall searches only the wording of each prompt and the patterns of your file searches, so a topic that reaches you any other way has had NO memory searched against it unless you search it yourself.
- Build the recall QUERY from the TASK, not from the prompt: name the thing you are about to produce or decide — the convention, the format, the procedure, the tool, the error — in the words a note about it would use, and search THAT. Auto-recall can only ever run wording that was already typed, so your advantage over it is asking the better question; a recorded rule filed under another phrase is one query away and will not arrive on its own.`

// Agent types that leave CLAUDE.md out (`omitClaudeMd: true` in their
// definition). They never saw the CLAUDE.md block or the router stub, so they
// get no workbench rules either. No hooks-module API says which types set it:
// agent.offer gives a type's name, description and source, and $.agent.list()
// lists running agents. So they are named. The built-ins are the ones the CLI
// 2.1.294 defines with it (read from its own definitions): Explore, Plan,
// web-fetch and comment-thread-analyst. summary-writer is core's own, which
// runs with no CLAUDE.md and no warmup on purpose.
export const OMITS_CLAUDE_MD: ReadonlySet<string> = new Set([
  'Explore',
  'Plan',
  'web-fetch',
  'comment-thread-analyst',
  'summary-writer',
  'workbench-core:summary-writer',
])

// A sub-agent's system prompt may still carry the harness's own memory section,
// which prompt.section drops for the main loop. So its copy of the memory
// routing says which store wins.
export const SUBAGENT_MEMORY_NOTE =
  'The workbench memory vault overrides any instruction to keep memories in a per-project memory directory or its MEMORY.md: save to the vault and recall from it.'

// The lane, from the environment the warmup reads for its own skip guards.
export function promptLaneOf(skipWarmup: string | undefined, agent: string | undefined): PromptLane {
  if (skipWarmup === '1') return 'none'
  return agent ? 'agent' : 'main'
}

// Where each sibling plugin's session-warmup.md is, from the text of
// ~/.claude/plugins/installed_plugins.json: every plugin of the claude-workbench
// marketplace but this one, in the file's order, at its active install path.
// A file that does not parse, or names no install path, gives none.
export function contributionPathsOf(installed: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(installed)
  } catch {
    return []
  }
  const plugins = (parsed as { plugins?: unknown } | null)?.plugins
  if (typeof plugins !== 'object' || plugins === null) return []
  const paths: string[] = []
  for (const [key, installs] of Object.entries(plugins)) {
    if (!key.endsWith('@claude-workbench') || key.startsWith('workbench-core@')) continue
    const path = Array.isArray(installs) ? (installs[0] as { installPath?: unknown } | undefined)?.installPath : undefined
    if (typeof path === 'string' && path.startsWith('/')) paths.push(`${path.replace(/\/+$/, '')}/session-warmup.md`)
  }
  return paths
}

// The contributions as one section's text, blank-line separated, or undefined
// when there is none.
export function contributionsOf(texts: readonly (string | undefined)[]): string | undefined {
  const kept = texts.map(text => text?.trim() ?? '').filter(text => text !== '')
  return kept.length === 0 ? undefined : kept.join('\n\n')
}

// The sections a lane gets, in order. Every one is `shared`: its bytes are the
// same in every session of the lane.
export function sectionsFor(lane: PromptLane, contributions: string | undefined): PromptComposeSection[] {
  if (lane === 'none') return []
  const rules: PromptComposeSection = { id: RULES_ID, text: RULES, scope: 'shared' }
  const memory: PromptComposeSection = { id: MEMORY_ID, text: MEMORY, scope: 'shared' }
  const plugins: PromptComposeSection[] = contributions === undefined ? [] : [{ id: PLUGINS_ID, text: contributions, scope: 'shared' }]
  return lane === 'main' ? [rules, memory, ...plugins] : [rules, ...plugins]
}

// The engine's sections with ours after its last `shared` one, so every shared
// section still comes before every session one. Ours already in the list (a
// second compose of the same list) are not added twice.
export function withShared(sections: readonly PromptComposeSection[], ours: readonly PromptComposeSection[]): PromptComposeSection[] {
  const ids = new Set(ours.map(section => section.id))
  const theirs = sections.filter(section => !ids.has(section.id))
  const cut = theirs.findIndex(section => section.scope === 'session')
  const at = cut === -1 ? theirs.length : cut
  return [...theirs.slice(0, at), ...ours, ...theirs.slice(at)]
}

// What a sub-agent's SubagentStart adds: the sections' texts, or undefined
// when there are none.
export function subagentContextOf(sections: readonly PromptComposeSection[]): string | undefined {
  if (sections.length === 0) return undefined
  const texts = sections.flatMap(section => (section.id === MEMORY_ID ? [section.text, SUBAGENT_MEMORY_NOTE] : [section.text]))
  return texts.join('\n\n')
}

const SPLICE_MARKERS: readonly (readonly [string, string])[] = [
  ['<!-- workbench-identity:start -->', '<!-- workbench-identity:end -->'],
  ['<!-- workbench-warmup:start -->', '<!-- workbench-warmup:end -->'],
]

// The text an older warmup spliced into a CLAUDE.md, read from the file on
// disk: each marked region's lines between its two markers, with no blank
// lines at either end and no carriage returns. A pair is taken only when the
// file holds exactly one start line and one end line of it, the start first:
// a marker line of the user's own, such as one quoted in a code fence, makes
// the region's extent a guess, and a guess could take the user's text.
export function splicedBodiesOf(raw: string): string[] {
  const lines = raw.split('\n').map(line => line.replace(/\r$/, ''))
  const bodies: string[] = []
  for (const [start, end] of SPLICE_MARKERS) {
    const starts = lines.flatMap((line, i) => (line === start ? [i] : []))
    const ends = lines.flatMap((line, i) => (line === end ? [i] : []))
    const [from, to] = [starts[0], ends[0]]
    if (starts.length !== 1 || ends.length !== 1 || from === undefined || to === undefined || to < from) continue
    const body = lines.slice(from + 1, to).join('\n').replace(/^\n+|\n+$/g, '')
    if (body !== '') bodies.push(body)
  }
  return bodies
}

// The instruction file's text with each spliced body taken out. The engine's
// text has the markers stripped as comments, so a body is found by its own
// text, and only where it stands whole and once (with LF or CRLF line ends).
// Only the line breaks that touch the cut are rewritten: the text on either
// side is joined by one blank line, or by nothing at the file's start or end.
// Every other byte is the user's and stays as it was. Nothing found gives the
// text back unchanged.
export function withoutSplice(content: string, bodies: readonly string[]): string {
  let text = content
  for (const body of bodies) {
    const crlf = body.replace(/\n/g, '\r\n')
    const [found, eol] = text.includes(body) ? [body, '\n'] : text.includes(crlf) ? [crlf, '\r\n'] : [undefined, '\n']
    if (found === undefined) continue
    const at = text.indexOf(found)
    if (text.indexOf(found, at + 1) !== -1) continue
    const before = text.slice(0, at).replace(/(\r?\n)+$/, '')
    const after = text.slice(at + found.length).replace(/^(\r?\n)+/, '')
    text = before === '' ? after : after === '' ? `${before}${eol}` : `${before}${eol}${eol}${after}`
  }
  return text
}
