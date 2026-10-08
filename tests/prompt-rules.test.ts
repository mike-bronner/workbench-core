// The workbench rules in the system prompt (hooks/mods/prompt-rules.ts,
// hooks/register.ts): shared prompt.compose sections whose bytes never change
// within a lane, the harness's memory section left out, a sub-agent's copy at
// SubagentStart, and the block an older warmup spliced into CLAUDE.md left out
// of the first message.
//
// The rule pins that hooks/test-session-warmup.sh held against the warmup's
// stdout, the managed CLAUDE.md block and the router stub are here, against the
// one copy they were moved into.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { InstructionFile, On, PromptComposeSection } from 'claude-code'

import {
  MEMORY,
  MEMORY_ID,
  OMITS_CLAUDE_MD,
  PLUGINS_ID,
  RULES,
  RULES_ID,
  SUBAGENT_MEMORY_NOTE,
  contributionPathsOf,
  contributionsOf,
  promptLaneOf,
  sectionsFor,
  splicedBodiesOf,
  withShared,
  withoutSplice,
} from '../hooks/mods/prompt-rules'
import { start } from './harness'

const HOME = '/Users/tester'
const SID = '0f3c2a1e-5b7d-4c9e-8a6f-1d2e3f4a5b6c'
const INSTALLED = `${HOME}/.claude/plugins/installed_plugins.json`
const NOTICES = `${HOME}/.claude-workbench/warmup-notices.md`
const DEV_TEAM = '/cache/workbench-dev-team/0.52.0'
const BUJO = '/cache/workbench-bujo/0.3.0'
const DEV_TEAM_TEXT = '## Dev-team delegation\n\nDevelopment goes to Dr. Watson.\n'
const BUJO_TEXT = '## BuJo routing\n\n- Daily log entries belong in the vault.\n'
// One minute before midnight UTC, so a two-minute move changes the date. A
// move of a whole day would fire the module's one-minute probe 1,440 times on
// the mock clock, which took seconds and timed out on CI's runner.
const BEFORE_MIDNIGHT = Date.UTC(2026, 8, 21, 23, 59)
const PAST_MIDNIGHT_MS = 120_000
// The facts a test composes the prompt for, as the engine would for a request.
const COMPOSE = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal' as const], tools: [], outputStyle: null, traits: [] }

const installed = (plugins: Record<string, { installPath: string }[]>): string => JSON.stringify({ version: 2, plugins })
const INSTALLED_JSON = installed({
  'workbench-core@claude-workbench': [{ installPath: '/cache/workbench-core/0.44.1' }],
  'workbench-dev-team@claude-workbench': [{ installPath: DEV_TEAM }],
  'other@elsewhere': [{ installPath: '/cache/other/1.0.0' }],
  'workbench-bujo@claude-workbench': [{ installPath: BUJO }],
})

type Engine = { files: Map<string, string>; clock: MockClock }

// The engine beneath the module. Its own prompt carries the date in a session
// section, as the engine's environment section does, so a date change moves a
// session section and never a shared one.
function engine(on: On, env: Record<string, string> = {}): Engine {
  const g: Engine = { files: new Map(), clock: mock.clock(on, { now: BEFORE_MIDNIGHT }) }
  g.files.set(INSTALLED, INSTALLED_JSON)
  g.files.set(`${DEV_TEAM}/session-warmup.md`, DEV_TEAM_TEXT)
  g.files.set(`${BUJO}/session-warmup.md`, BUJO_TEXT)
  g.files.set(`/cache/workbench-core/0.44.1/session-warmup.md`, 'CORE-OWN-CANARY')
  g.files.set(`/cache/other/1.0.0/session-warmup.md`, 'OTHER-MARKETPLACE-CANARY')
  g.files.set(NOTICES, '# Warmup notices\n\nNo outstanding notices.\n')
  mock.env(on, { HOME, ...env })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SID }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', ($, e) => ({ value: g.files.has(e.path) }))
  on('fs.read', ($, e) => {
    const text = g.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('ui.status', () => ({ value: undefined }))
  on('prompt.compose', () => ({
    sections: [
      { id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const },
      { id: 'tools', text: 'Use the tools.', scope: 'shared' as const },
      { id: 'env_info_simple', text: `Today's date is ${new Date(g.clock.now()).toISOString().slice(0, 10)}.`, scope: 'session' as const },
      { id: 'context_management', text: 'Context is managed.', scope: 'session' as const },
    ],
  }))
  on('prompt.section', ($, e) => ({ text: e.text }))
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  on('classic.SubagentStart', () => ({ additionalContext: ['BENEATH'] }))
  return g
}

const shared = (sections: readonly PromptComposeSection[]): PromptComposeSection[] => sections.filter(section => section.scope === 'shared')
const ids = (sections: readonly PromptComposeSection[]): string[] => sections.map(section => section.id)
const subagentStart = (agentType: string) => ({ hook_event_name: 'SubagentStart' as const, agent_id: 'a1', agent_type: agentType })

describe('AC1: the workbench rules are shared sections, byte-identical across a reload, a notices change and a date change', () => {
  test('every shared section keeps its bytes, and only a session section moves', { timeoutMs: 60_000 }, async ($, on) => {
    const g = engine(on)
    await $.session.start(start(true))
    const before = (await $.prompt.compose(COMPOSE)).sections
    // A simulated reload: register runs again, and session.start reads the
    // sections afresh.
    await $.session.start(start(true))
    // A notices change: another start rewrote the notices file.
    g.files.set(NOTICES, '# Warmup notices\n\n## ⚠ Pending session summaries (7)\n')
    // A date change: the clock moves past midnight.
    await g.clock.advance(PAST_MIDNIGHT_MS)
    const after = (await $.prompt.compose(COMPOSE)).sections
    expect(shared(after)).toEqual(shared(before))
    expect(ids(after)).toEqual(ids(before))
    // The comparison is not vacuous: the engine's session side did change.
    expect(after.find(section => section.id === 'env_info_simple')?.text).not.toBe(before.find(section => section.id === 'env_info_simple')?.text)
  })

  test('the sections sit after the engine shared ones and before every session one', async ($, on) => {
    engine(on)
    await $.session.start(start(true))
    const { sections } = await $.prompt.compose(COMPOSE)
    expect(ids(sections)).toEqual(['intro', 'tools', RULES_ID, MEMORY_ID, PLUGINS_ID, 'env_info_simple', 'context_management'])
    expect(sections.filter(section => section.id.startsWith('workbench-core:')).every(section => section.scope === 'shared')).toBe(true)
  })

  test('the same bytes in a plain claude -p run as in an interactive one', async ($, on) => {
    engine(on)
    await $.session.start(start(true))
    const interactive = shared((await $.prompt.compose(COMPOSE)).sections)
    await $.session.start(start(false))
    expect(shared((await $.prompt.compose(COMPOSE)).sections)).toEqual(interactive)
  })

  test('two renders in one load answer the same bytes, and add nothing twice', async ($, on) => {
    engine(on)
    await $.session.start(start(true))
    const first = await $.prompt.compose(COMPOSE)
    expect(await $.prompt.compose(COMPOSE)).toEqual(first)
    const ours = first.sections.filter(section => section.id.startsWith('workbench-core:'))
    expect(withShared(first.sections, ours)).toEqual(first.sections)
  })

  test('a list with no session section takes ours at its end', () => {
    const theirs: PromptComposeSection[] = [{ id: 'bare', text: 'x', scope: 'shared' }]
    expect(ids(withShared(theirs, sectionsFor('agent', undefined)))).toEqual(['bare', RULES_ID])
  })
})

describe('the lanes get what the copies they replace reached', () => {
  test('a top-level --agent run gets the rules and the contributions, and no memory routing', async ($, on) => {
    engine(on, { CLAUDE_CODE_AGENT: 'workbench-dev-team:watson' })
    await $.session.start(start(false))
    expect(ids((await $.prompt.compose(COMPOSE)).sections)).toEqual(['intro', 'tools', RULES_ID, PLUGINS_ID, 'env_info_simple', 'context_management'])
  })

  test('a summary-writer gets none of them', async ($, on) => {
    engine(on, { WORKBENCH_SKIP_WARMUP: '1' })
    await $.session.start(start(false))
    expect(ids((await $.prompt.compose(COMPOSE)).sections)).toEqual(['intro', 'tools', 'env_info_simple', 'context_management'])
  })

  // The rules alone: a lane that cannot be read may be an unattended one, so it
  // is not granted the memory routing.
  test('an environment that cannot be read still gets the rules, and only them', async ($, on) => {
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('session.id', () => ({ value: SID }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('store.get', () => ({ value: undefined }))
    on('fs.list', () => ({ value: [] }))
    on('ui.status', () => ({ value: undefined }))
    on('env.get', () => {
      throw new Error('env unavailable')
    })
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }] }))
    expect(ids((await $.prompt.compose(COMPOSE)).sections)).toEqual(['intro', RULES_ID])
  })

  test('the lane reads the same two variables the warmup skips on', () => {
    expect(promptLaneOf(undefined, undefined)).toBe('main')
    expect(promptLaneOf('0', undefined)).toBe('main')
    expect(promptLaneOf(undefined, '')).toBe('main')
    expect(promptLaneOf(undefined, 'x:y')).toBe('agent')
    expect(promptLaneOf('1', 'x:y')).toBe('none')
  })
})

describe('the plugin contributions: each sibling plugin session-warmup.md, once', () => {
  test('the claude-workbench plugins but core, in the file order, joined by a blank line', async ($, on) => {
    engine(on)
    await $.session.start(start(true))
    const plugins = (await $.prompt.compose(COMPOSE)).sections.find(section => section.id === PLUGINS_ID)
    expect(plugins?.text).toBe(`${DEV_TEAM_TEXT.trim()}\n\n${BUJO_TEXT.trim()}`)
    expect(plugins?.text).not.toContain('CORE-OWN-CANARY')
    expect(plugins?.text).not.toContain('OTHER-MARKETPLACE-CANARY')
  })

  test('a plugin with no file is left out, and no file at all leaves no section', async ($, on) => {
    const g = engine(on)
    g.files.delete(`${DEV_TEAM}/session-warmup.md`)
    await $.session.start(start(true))
    expect((await $.prompt.compose(COMPOSE)).sections.find(section => section.id === PLUGINS_ID)?.text).toBe(BUJO_TEXT.trim())
    g.files.delete(`${BUJO}/session-warmup.md`)
    await $.session.start(start(true))
    expect(ids((await $.prompt.compose(COMPOSE)).sections)).toEqual(['intro', 'tools', RULES_ID, MEMORY_ID, 'env_info_simple', 'context_management'])
  })

  test('an unreadable or missing plugin list leaves the rules standing', async ($, on) => {
    const g = engine(on)
    g.files.set(INSTALLED, '{not json')
    await $.session.start(start(true))
    expect(ids(shared((await $.prompt.compose(COMPOSE)).sections))).toEqual(['intro', 'tools', RULES_ID, MEMORY_ID])
    g.files.delete(INSTALLED)
    await $.session.start(start(true))
    expect(ids(shared((await $.prompt.compose(COMPOSE)).sections))).toEqual(['intro', 'tools', RULES_ID, MEMORY_ID])
  })

  test('the paths: absolute install paths only, a trailing slash dropped', () => {
    expect(contributionPathsOf(installed({ 'a@claude-workbench': [{ installPath: '/x/' }], 'b@claude-workbench': [{ installPath: 'rel' }] }))).toEqual([
      '/x/session-warmup.md',
    ])
    expect(contributionPathsOf('null')).toEqual([])
    expect(contributionPathsOf('{"plugins":{"c@claude-workbench":"no list"}}')).toEqual([])
    expect(contributionsOf([undefined, '  ', '\nA\n'])).toBe('A')
    expect(contributionsOf([])).toBeUndefined()
  })
})

describe('AC2: the harness memory section is dropped, and memory routing is stated once', () => {
  test('the memory section is left out, and every other section passes', async ($, on) => {
    engine(on)
    await $.session.start(start(true))
    expect(await $.prompt.section({ name: 'memory', text: 'Save memories under ~/.claude/projects/x/memory/.' })).toEqual({ text: null })
    expect(await $.prompt.section({ name: 'env_info_simple', text: 'env' })).toEqual({ text: 'env' })
  })

  test('the routing is in one section, and nowhere else in what the module adds', async ($, on) => {
    engine(on)
    await $.session.start(start(true))
    const { sections } = await $.prompt.compose(COMPOSE)
    const holding = sections.filter(section => section.text.includes('Memory routing'))
    expect(ids(holding)).toEqual([MEMORY_ID])
    expect(RULES).not.toContain('memory vault is the')
  })

  // The pins hooks/test-session-warmup.sh held against the warmup's stdout.
  test('the routing keeps every rule the warmup printed', () => {
    expect(MEMORY).toContain('a memory-capture write needs no options round and no confirmation')
    expect(MEMORY).toContain('Recall comes FIRST')
    expect(MEMORY).toContain('BEFORE you scan the repo')
    expect(MEMORY).toContain('Auto-recall searches only the wording of each prompt and the patterns of your file searches')
    expect(MEMORY).not.toContain('opening prompt')
    expect(MEMORY).toContain('Recall = vault `search`, not directory reads.')
    expect(MEMORY).toContain('Omit `mode`: the server picks hybrid when the vault has embeddings')
    expect(MEMORY).not.toContain('(mode hybrid)')
    expect(MEMORY).toContain('Build the recall QUERY from the TASK')
    expect(MEMORY).toContain('not from the prompt')
    expect(MEMORY).toContain('your advantage over it is asking the better question')
    expect(MEMORY).toContain('`mcp__plugin_workbench-core_memory__search`')
    expect(MEMORY).toContain('Before saving, `search` for an existing memory to UPDATE rather than duplicate.')
  })

  test('the bullets the harness section needed are gone with it', () => {
    expect(MEMORY).not.toContain("harness's memory instructions")
    expect(MEMORY).not.toContain('MEMORY.md')
  })

  test('the scratch roots are stated once', () => {
    const roots = 'the session scratchpad, `~/Developer/scratchpad`, or a `mktemp -d` sandbox'
    expect(RULES.split(roots)).toHaveLength(2)
    expect(MEMORY).not.toContain('scratchpad')
  })

  // The pins hooks/test-session-warmup.sh held against the CLAUDE.md block and
  // the destructive-commands stdout.
  test('the gates and the destructive commands keep every fact they carried', () => {
    expect(RULES).toContain('| Delegation gate |')
    expect(RULES).toContain('It never denies: a main-agent `Write` or `NotebookEdit` goes ahead with a reminder, once per session.')
    expect(RULES).toContain('Plans and scratch roots draw none.')
    expect(RULES).not.toContain('denied `Write`')
    expect(RULES).toContain("The user's `/orchestrator off` silences it.")
    expect(RULES).toContain('| Destructive scope guard |')
    expect(RULES).toContain('A deny is the system working. Report it, and do not route around it.')
    expect(RULES).toContain('Never create it anywhere under `/tmp` outside your session scratchpad')
    expect(RULES).toContain('Never hand the user a `!` command to delete your own scratch.')
    expect(RULES).toContain('a `$variable`, a glob, `bash -c`, `ssh`, `xargs`, `find -delete`, or a loop body')
    expect(RULES).toContain('`git stash clear`/`drop`')
    expect(RULES).toContain('they run it with the `!` prefix')
  })
})

describe('a sub-agent gets its parent rules at its start', () => {
  test('the sections of the lane, after what the hooks beneath added', async ($, on) => {
    engine(on)
    await $.session.start(start(true))
    const { additionalContext } = await $.classic.SubagentStart(subagentStart('general-purpose'))
    expect(additionalContext).toEqual([
      'BENEATH',
      `${RULES}\n\n${MEMORY}\n\n${SUBAGENT_MEMORY_NOTE}\n\n${DEV_TEAM_TEXT.trim()}\n\n${BUJO_TEXT.trim()}`,
    ])
  })

  // A sub-agent's system prompt may still carry the harness's memory section,
  // so its copy of the routing says the vault wins.
  test('its memory routing says the vault overrides a per-project memory folder', () => {
    expect(SUBAGENT_MEMORY_NOTE).toContain('overrides any instruction to keep memories in a per-project memory directory')
    expect(SUBAGENT_MEMORY_NOTE).not.toMatch(/\d/)
  })

  test('the same bytes on every spawn', async ($, on) => {
    engine(on)
    await $.session.start(start(true))
    const first = await $.classic.SubagentStart(subagentStart('workbench-dev-team:watson'))
    await $.session.start(start(true))
    expect(await $.classic.SubagentStart(subagentStart('general-purpose'))).toEqual(first)
  })

  // Explore and Plan never saw the CLAUDE.md block or the router stub: the CLI
  // defines them with omitClaudeMd. Giving them the rules would add text to
  // every read-only dispatch that it never carried.
  test('an agent that leaves CLAUDE.md out gets nothing: Explore, Plan, and the rest', async ($, on) => {
    engine(on)
    await $.session.start(start(true))
    for (const type of ['Explore', 'Plan', 'web-fetch', 'comment-thread-analyst', 'workbench-core:summary-writer', 'summary-writer']) {
      expect((await $.classic.SubagentStart(subagentStart(type))).additionalContext).toEqual(['BENEATH'])
    }
  })

  test('the list holds every built-in the CLI defines with omitClaudeMd, and only those and summary-writer', () => {
    expect([...OMITS_CLAUDE_MD].sort()).toEqual(['Explore', 'Plan', 'comment-thread-analyst', 'summary-writer', 'web-fetch', 'workbench-core:summary-writer'])
  })

  test("in an --agent run, a sub-agent gets that lane's set", async ($, on) => {
    engine(on, { CLAUDE_CODE_AGENT: 'workbench-dev-team:watson' })
    await $.session.start(start(false))
    const [, text] = (await $.classic.SubagentStart(subagentStart('general-purpose'))).additionalContext ?? []
    expect(text).toContain(RULES)
    expect(text).not.toContain(MEMORY)
    expect(text).not.toContain(SUBAGENT_MEMORY_NOTE)
  })

  test("in a summary-writer, a sub-agent gets nothing", async ($, on) => {
    engine(on, { WORKBENCH_SKIP_WARMUP: '1' })
    await $.session.start(start(false))
    expect((await $.classic.SubagentStart(subagentStart('general-purpose'))).additionalContext).toEqual(['BENEATH'])
  })
})

// What the engine hands prompt.context for a CLAUDE.md: its text with the HTML
// comments, the markers included, stripped.
const RAW = `<!-- workbench-identity:start -->
# Workbench gates and scratch roots

| Gate | What it protects |
<!-- workbench-identity:end -->

<!-- workbench-warmup:start -->
## Dev-team delegation

Development goes to Dr. Watson.
<!-- workbench-warmup:end -->

## Scratchpad directories

USER-PROSE-CANARY
`
const STRIPPED = RAW.split('\n')
  .filter(line => !line.startsWith('<!--'))
  .join('\n')
const USER_FILE: InstructionFile = { path: `${HOME}/.claude/CLAUDE.md`, kind: 'user', content: STRIPPED }
const PROJECT_FILE: InstructionFile = { path: '/repo/CLAUDE.md', kind: 'project', content: '# Repo\n\n| Gate | What it protects |\n' }
const BLOCKS = [{ name: 'claudeMd', text: 'rendered' }]

describe('AC3: the block an older warmup spliced into CLAUDE.md is left out of what the model reads', () => {
  test("the user's own text stays, and only it", async ($, on) => {
    const g = engine(on)
    g.files.set(USER_FILE.path, RAW)
    const result = await $.prompt.context({ blocks: BLOCKS, instructionFiles: [USER_FILE, PROJECT_FILE] })
    expect(result.instructionFiles).toEqual([{ ...USER_FILE, content: '## Scratchpad directories\n\nUSER-PROSE-CANARY\n' }, PROJECT_FILE])
    // The engine renders the claudeMd text again from the changed list.
    const text = result.blocks.find(block => block.name === 'claudeMd')?.text ?? ''
    expect(text).toContain('USER-PROSE-CANARY')
    expect(text).not.toContain('Workbench gates and scratch roots')
    expect(text).not.toContain('Development goes to Dr. Watson.')
    expect(text).toContain('# Repo')
  })

  test('a file with no block, or no file on disk, is passed on as it came', async ($, on) => {
    const g = engine(on)
    const plain = { ...USER_FILE, content: '## Mine\n' }
    g.files.set(plain.path, '## Mine\n')
    expect(await $.prompt.context({ blocks: BLOCKS, instructionFiles: [plain] })).toEqual({ blocks: BLOCKS, instructionFiles: [plain] })
    g.files.delete(plain.path)
    expect(await $.prompt.context({ blocks: BLOCKS, instructionFiles: [USER_FILE] })).toEqual({ blocks: BLOCKS, instructionFiles: [USER_FILE] })
  })

  test('a file that held only the block is left out whole', async ($, on) => {
    const g = engine(on)
    const raw = '<!-- workbench-identity:start -->\nGATES\n<!-- workbench-identity:end -->\n'
    g.files.set(USER_FILE.path, raw)
    const result = await $.prompt.context({ blocks: BLOCKS, instructionFiles: [{ ...USER_FILE, content: 'GATES\n' }, PROJECT_FILE] })
    expect(result.instructionFiles).toEqual([PROJECT_FILE])
  })

  test('only a user file is read for a block: a project file with the same text is left alone', async ($, on) => {
    const g = engine(on)
    g.files.set(PROJECT_FILE.path, '<!-- workbench-identity:start -->\n| Gate | What it protects |\n<!-- workbench-identity:end -->\n')
    expect(await $.prompt.context({ blocks: BLOCKS, instructionFiles: [PROJECT_FILE] })).toEqual({ blocks: BLOCKS, instructionFiles: [PROJECT_FILE] })
  })

  test('the files a hook above rewrote away are left to it', async ($, on) => {
    engine(on)
    expect(await $.prompt.context({ blocks: BLOCKS })).toEqual({ blocks: BLOCKS })
  })

  test('the bodies: between each marker pair, with no blank ends, and only a closed pair', () => {
    expect(splicedBodiesOf(RAW)).toEqual([
      '# Workbench gates and scratch roots\n\n| Gate | What it protects |',
      '## Dev-team delegation\n\nDevelopment goes to Dr. Watson.',
    ])
    expect(splicedBodiesOf('<!-- workbench-warmup:start -->\nopen\n')).toEqual([])
    expect(splicedBodiesOf('<!-- workbench-identity:start -->\n\n<!-- workbench-identity:end -->\n')).toEqual([])
    expect(splicedBodiesOf('<!-- workbench-identity:start -->\r\nX\r\n<!-- workbench-identity:end -->\r\n')).toEqual(['X'])
  })

  test('a body not found whole changes nothing', () => {
    expect(withoutSplice('## Mine\n| Gate |\n', ['| Gate | What it protects |'])).toBe('## Mine\n| Gate |\n')
  })

  test("only the line breaks at a cut change: the user's text before, between and after keeps every byte", () => {
    const fence = '```\nline\n\n\n\nline\n```'
    const raw = [
      '  INDENTED-FIRST',
      '',
      '<!-- workbench-identity:start -->',
      'GATES',
      '<!-- workbench-identity:end -->',
      '',
      'BETWEEN',
      '',
      '',
      '',
      'still between',
      '',
      '<!-- workbench-warmup:start -->',
      'DEV',
      '<!-- workbench-warmup:end -->',
      '',
      'AFTER',
      fence,
      '',
    ].join('\n')
    const stripped = raw
      .split('\n')
      .filter(line => !line.startsWith('<!--'))
      .join('\n')
    expect(withoutSplice(stripped, splicedBodiesOf(raw))).toBe(`  INDENTED-FIRST\n\nBETWEEN\n\n\n\nstill between\n\nAFTER\n${fence}\n`)
  })

  test('a block at the start or the end leaves no blank run behind', () => {
    expect(withoutSplice('GATES\n\nMINE\n', ['GATES'])).toBe('MINE\n')
    expect(withoutSplice('MINE\n\nGATES\n', ['GATES'])).toBe('MINE\n')
  })

  test('CRLF text is cut with CRLF, and keeps its line ends', () => {
    const raw = 'MINE\r\n\r\n<!-- workbench-identity:start -->\r\nA\r\nB\r\n<!-- workbench-identity:end -->\r\n\r\nMORE\r\n'
    expect(withoutSplice('MINE\r\n\r\nA\r\nB\r\n\r\nMORE\r\n', splicedBodiesOf(raw))).toBe('MINE\r\n\r\nMORE\r\n')
  })

  test('a body that stands twice in the text is left, since which one is the block is a guess', () => {
    expect(withoutSplice('GATES\n\nMINE\n\nGATES\n', ['GATES'])).toBe('GATES\n\nMINE\n\nGATES\n')
  })

  test('a marker line of the user own, as in a code fence, leaves that pair alone', () => {
    const quoted = '```\n<!-- workbench-identity:start -->\n```\n\nMINE\n\n<!-- workbench-identity:start -->\nGATES\n<!-- workbench-identity:end -->\n'
    expect(splicedBodiesOf(quoted)).toEqual([])
    const endFirst = '<!-- workbench-identity:end -->\nMINE\n<!-- workbench-identity:start -->\nGATES\n'
    expect(splicedBodiesOf(endFirst)).toEqual([])
    const twoEnds = '<!-- workbench-identity:start -->\nGATES\n<!-- workbench-identity:end -->\nMINE\n<!-- workbench-identity:end -->\n'
    expect(splicedBodiesOf(twoEnds)).toEqual([])
    // A marker quoted inside a line is not a marker line, and the block is cut.
    const inline = 'Mine names `<!-- workbench-identity:start -->` here.\n\n<!-- workbench-identity:start -->\nGATES\n<!-- workbench-identity:end -->\n'
    expect(splicedBodiesOf(inline)).toEqual(['GATES'])
  })
})

describe('AC4: no volatile bytes in what the module puts in the system prompt', () => {
  // No date, count, version, session id or pending number: the core texts hold
  // no digit at all, and the contributions are the plugins' own files, read
  // verbatim. What varies (the date, the notices) is the engine's session
  // side, or the status line's.
  test('the core texts hold no digit', () => {
    expect(RULES).not.toMatch(/\d/)
    expect(MEMORY).not.toMatch(/\d/)
  })

  test('the composed sections name neither the session nor the notices nor the date', async ($, on) => {
    const g = engine(on)
    g.files.set(NOTICES, '# Warmup notices\n\n## ⚠ Pending session summaries (7)\n')
    await $.session.start(start(true))
    const ours = (await $.prompt.compose(COMPOSE)).sections.filter(section => section.id.startsWith('workbench-core:'))
    const text = ours.map(section => section.text).join('\n')
    expect(text).not.toContain(SID)
    expect(text).not.toContain('Pending session summaries')
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(text).not.toContain('0.52.0')
  })
})
