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
  rulesOwnersOf,
  sectionsFor,
  splicedBodiesOf,
  withShared,
  withoutSplice,
} from '../hooks/mods/prompt-rules'
import { caller } from './bench'
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

type Engine = { files: Map<string, string>; clock: MockClock; beneath: PromptComposeSection[] }

// The engine beneath the module. Its own prompt carries the date in a session
// section, as the engine's environment section does, so a date change moves a
// session section and never a shared one.
function engine(on: On, env: Record<string, string> = {}): Engine {
  const g: Engine = { files: new Map(), clock: mock.clock(on, { now: BEFORE_MIDNIGHT }), beneath: [] }
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
  on('prompt.compose', () => ({
    sections: [
      { id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const },
      { id: 'tools', text: 'Use the tools.', scope: 'shared' as const },
      ...g.beneath,
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

  // The engine joins the sections of one side with a blank line and sends the
  // two sides as they are, so the text at the cache boundary needs its own.
  test('every section boundary in the composed text is a blank line', async ($, on) => {
    const g = engine(on)
    g.files.delete(`${DEV_TEAM}/session-warmup.md`)
    g.files.delete(`${BUJO}/session-warmup.md`)
    await $.session.start(start(true))
    const { sections } = await $.prompt.compose(COMPOSE)
    const side = (scope: string): string => sections.filter(section => section.scope === scope).map(section => section.text).join('\n\n')
    const rendered = side('shared') + side('session')
    for (const [i, section] of sections.slice(1).entries()) {
      const before = sections[i]?.text.replace(/\n+$/, '') ?? ''
      expect(rendered).toContain(`${before}\n\n${section.text}`)
    }
    // Core alone: the memory routing is the last shared section, and its last
    // sentence stands apart from the session side.
    expect(rendered).toContain("will not arrive on its own.\n\nToday's date")
    expect(MEMORY.endsWith('will not arrive on its own.')).toBe(true)
  })

  test('a list with no session section takes ours at its end', () => {
    const theirs: PromptComposeSection[] = [{ id: 'bare', text: 'x', scope: 'shared' }]
    expect(ids(withShared(theirs, sectionsFor('agent', undefined)))).toEqual(['bare', RULES_ID])
  })
})

// C3o. Two plugins each add shared sections from their own prompt.compose
// hook, one hook inside the other, in either order. The stand-in below is
// another plugin applying the same rule through withShared, as
// workbench-dev-team does by re-exporting it.
describe('another plugin\'s shared section beside ours, in either nesting', () => {
  const ENGINE: PromptComposeSection[] = [
    { id: 'intro', text: 'Intro.', scope: 'shared' },
    { id: 'env', text: "Today's date is 2026-10-12.", scope: 'session' },
    { id: 'ctx', text: 'Context.', scope: 'session' },
  ]
  const OTHER: PromptComposeSection[] = [{ id: 'workbench-dev-team:rules', text: 'Dev-team rules end here.', scope: 'shared' }]
  const CORE = sectionsFor('main', 'Plugin contributions end here.')
  // The text the engine sends: each side joined with a blank line, and the two
  // sides as they are.
  const rendered = (sections: readonly PromptComposeSection[]): string =>
    ['shared', 'session'].map(scope => sections.filter(section => section.scope === scope).map(section => section.text).join('\n\n')).join('')
  // Exactly one blank line at every boundary: the texts, each without the pad,
  // joined by one blank line.
  const oneBlankLine = (sections: readonly PromptComposeSection[]): string => sections.map(section => section.text.replace(/\s+$/, '')).join('\n\n')

  test('core outside: the other plugin\'s pad comes off, and core\'s last section, now the last shared one, carries it', () => {
    const inner = withShared(ENGINE, OTHER)
    expect(inner.find(section => section.id === OTHER[0]?.id)?.text).toBe('Dev-team rules end here.\n\n')
    const sections = withShared(inner, CORE)
    expect(ids(sections)).toEqual(['intro', 'workbench-dev-team:rules', RULES_ID, MEMORY_ID, PLUGINS_ID, 'env', 'ctx'])
    expect(rendered(sections)).toBe(oneBlankLine(sections))
    expect(rendered(sections)).toContain("Plugin contributions end here.\n\nToday's date")
    expect(rendered(sections)).toContain(`Dev-team rules end here.\n\n${RULES.slice(0, 20)}`)
  })

  test('core inside: the other plugin takes core\'s pad off, and its own section carries it', () => {
    const sections = withShared(withShared(ENGINE, CORE), OTHER)
    expect(ids(sections)).toEqual(['intro', RULES_ID, MEMORY_ID, PLUGINS_ID, 'workbench-dev-team:rules', 'env', 'ctx'])
    expect(rendered(sections)).toBe(oneBlankLine(sections))
    expect(rendered(sections)).toContain('Plugin contributions end here.\n\nDev-team rules end here.\n\nToday')
  })

  test('with no session section, neither nesting pads anything', () => {
    const shared = ENGINE.filter(section => section.scope === 'shared')
    for (const sections of [withShared(withShared(shared, OTHER), CORE), withShared(withShared(shared, CORE), OTHER)]) {
      expect(rendered(sections)).toBe(oneBlankLine(sections))
      expect(sections.every(section => !/\s$/.test(section.text))).toBe(true)
    }
  })

  test('an engine section that ends in a single newline is not taken for a pad', () => {
    const engineOwn: PromptComposeSection[] = [{ id: 'intro', text: 'Intro.\n', scope: 'shared' }, ...ENGINE.slice(1)]
    expect(withShared(engineOwn, CORE)[0]?.text).toBe('Intro.\n')
  })

  // The engine runs a plugin's hook with nothing imported, so the stand-in
  // spells withShared's rule out for its one section.
  const STAND_IN = caller((on: On) => {
    on('prompt.compose', async ($, e, next) => {
      const listed = (await next(e)).sections.filter(section => section.id !== 'workbench-dev-team:rules')
      const cut = listed.findIndex(section => section.scope === 'session')
      const at = cut === -1 ? listed.length : cut
      const before = listed
        .slice(0, at)
        .map((section, i) => (i === at - 1 && /\n[ \t]*\n\s*$/.test(section.text) ? { ...section, text: section.text.replace(/\s+$/, '') } : section))
      const text = 'Dev-team rules end here.'
      const mine = { id: 'workbench-dev-team:rules', text: cut === -1 ? text : `${text}\n\n`, scope: 'shared' as const }
      return { sections: [...before, mine, ...listed.slice(at)] }
    })
  })

  test('in the engine, with another plugin\'s hook beside core\'s, every boundary is one blank line', { plugins: [STAND_IN] }, async ($, on) => {
    const g = engine(on)
    g.files.delete(`${DEV_TEAM}/session-warmup.md`)
    g.files.delete(`${BUJO}/session-warmup.md`)
    await $.session.start(start(true))
    const { sections } = await $.prompt.compose(COMPOSE)
    expect(ids(sections)).toContain('workbench-dev-team:rules')
    expect(rendered(sections)).toBe(oneBlankLine(sections))
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
    expect(plugins?.text.trimEnd()).toBe(`${DEV_TEAM_TEXT.trim()}\n\n${BUJO_TEXT.trim()}`)
    expect(plugins?.text).not.toContain('CORE-OWN-CANARY')
    expect(plugins?.text).not.toContain('OTHER-MARKETPLACE-CANARY')
  })

  test('a plugin with no file is left out, and no file at all leaves no section', async ($, on) => {
    const g = engine(on)
    g.files.delete(`${DEV_TEAM}/session-warmup.md`)
    await $.session.start(start(true))
    expect((await $.prompt.compose(COMPOSE)).sections.find(section => section.id === PLUGINS_ID)?.text.trimEnd()).toBe(BUJO_TEXT.trim())
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

  // A plugin that sends its rules as a `<plugin>:rules` section of its own
  // would send them twice if its session-warmup.md went out as well. The
  // installed copy may be older than the one that runs, so the file is still
  // there to read.
  test('a plugin with its own rules section and a session-warmup.md contributes its rules once: the file is left out', async ($, on) => {
    const g = engine(on)
    g.beneath = [{ id: 'workbench-dev-team:rules', text: DEV_TEAM_TEXT.trim(), scope: 'shared' }]
    await $.session.start(start(true))
    const { sections } = await $.prompt.compose(COMPOSE)
    expect(sections.find(section => section.id === PLUGINS_ID)?.text.trimEnd()).toBe(BUJO_TEXT.trim())
    const rendered = sections.map(section => section.text).join('\n\n')
    expect(rendered.split(DEV_TEAM_TEXT.trim())).toHaveLength(2)
    // A sub-agent's copy leaves the file out too.
    const [, text] = (await $.classic.SubagentStart(subagentStart('general-purpose'))).additionalContext ?? []
    expect(text).not.toContain(DEV_TEAM_TEXT.trim())
    expect(text).toContain(BUJO_TEXT.trim())
  })

  test('a plugin with only a session-warmup.md is still included, and so is one whose rules section is gone', async ($, on) => {
    const g = engine(on)
    g.beneath = [{ id: 'workbench-bujo:notes', text: 'Not rules.', scope: 'shared' }]
    await $.session.start(start(true))
    expect((await $.prompt.compose(COMPOSE)).sections.find(section => section.id === PLUGINS_ID)?.text.trimEnd()).toBe(`${DEV_TEAM_TEXT.trim()}\n\n${BUJO_TEXT.trim()}`)
  })

  test("the owners: each <plugin>:rules id but core's own", () => {
    const section = (id: string): PromptComposeSection => ({ id, text: 'x', scope: 'shared' })
    expect([...rulesOwnersOf([section('workbench-dev-team:rules'), section(RULES_ID), section('a:rules-extra'), section('rules'), section('b:notes')])]).toEqual([
      'workbench-dev-team',
    ])
  })

  test('the paths: absolute install paths only, a trailing slash dropped', () => {
    expect(contributionPathsOf(installed({ 'a@claude-workbench': [{ installPath: '/x/' }], 'b@claude-workbench': [{ installPath: 'rel' }] }))).toEqual([
      { plugin: 'a', path: '/x/session-warmup.md' },
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

describe('the working rules on commits and code comments', () => {
  test('a commit takes everything uncommitted, in one commit', () => {
    expect(RULES).toContain('## Commits and code comments')
    expect(RULES).toContain('A commit takes every uncommitted file in the tree, in one commit with one message that covers the whole set.')
    expect(RULES).toContain('Stage tracked changes and untracked files alike, including files this session did not create and files that appeared during it.')
    expect(RULES).toContain('Never split the work into several commits, never leave a file out because it looks unrelated, and never ask which files to include.')
    expect(RULES).toContain('The one exception is content that must never ship, such as a secret or a stray build artifact. Leave it out, and tell the user about it in one sentence. Never leave a file out silently.')
    expect(RULES).toContain('Stage the whole tree with `git add -A` on a line of its own, then commit with no paths.')
    expect(RULES).toContain("It lets a never-ship file stay out only when the reply above the commit names that file's path to the user.")
    expect(RULES).not.toContain('It does not change who approves a commit or when.')
  })

  test('a prompt that asks for a commit, a push, a merge or a release approves those actions for its turn', () => {
    expect(RULES).toContain('A prompt in which the user asks for a commit, a push, a merge or a release, or any mix of them, approves exactly those actions for the turn that prompt opened, in the user\'s own words')
    expect(RULES).toContain('A commit approval approves no push and no merge.')
    expect(RULES).toContain("The user's next prompt ends the approval.")
    expect(RULES).toContain('A prompt that negates, defers, sets a condition or asks approves nothing')
    expect(RULES).toContain('never a peer, channel, scheduled, SDK or plugin turn, and never a sub-agent')
    expect(RULES).toContain('approves one commit on the branch HEAD held when the user picked, and no push and no merge.')
    expect(RULES).toContain('Run no checkout, switch, stash or reset between the pick and the commit.')
    expect(RULES).toContain('Once the commit has landed, ask about the push in a question of its own.')
    expect(RULES).toContain("How a branch lands, a pull request or a local merge into the default branch, is the user's choice")
    expect(RULES).toContain('A pick never approves a release. Only the user\'s own next prompt ends a pick not yet used.')
    expect(RULES).not.toContain('the push of that commit')
    expect(RULES).not.toMatch(/typed "commit it"[^.]*does not count/i)
    expect(RULES).toContain('Run each approved action as a plain line, and no permission prompt opens')
    expect(RULES).toContain('`git -C <path>` is fine when the path is inside this project or one of its worktrees.')
  })

  test('a plan file is written with no question and no prompt', () => {
    expect(RULES).toContain('## Plan files')
    expect(RULES).toContain('Create and edit plan files in `~/.claude/plans` without asking first, never in prose and never in a question.')
    expect(RULES).toContain("The user still approves a plan's content when you present it.")
  })

  test('code carries no comments, short of what a linter requires', () => {
    expect(RULES).toContain('Write no comments or docblocks in code, in any project, plugin code that agents maintain included.')
    expect(RULES).toContain("The only exception is a comment that the project's linter or config requires")
    expect(RULES).toContain('Functional lines such as a shebang or a directive that a tool reads are not comments, and they stay.')
    expect(RULES).toContain('Leave the existing comments in code you do not change as they are.')
    expect(RULES).toContain('When a change makes a comment wrong, delete the comment rather than rewrite it.')
  })
})

describe('the working rule on one project per session', () => {
  test('a session works only for its own project, and hands other work to its session', () => {
    expect(RULES).toContain('## One project per session')
    expect(RULES).toContain('A session works only for its own project, the repository it started in.')
    expect(RULES).toContain('Work for another project goes to that project\'s session. Do not dispatch an agent into it, and do not edit it.')
    expect(RULES).toContain('send it the finding and the acceptance criteria with `SendMessage`, as `/workbench-core:cross-session-messaging` describes. When no session for that project is live, ask the user.')
    expect(RULES).toContain('`Explore` and `Plan` only read, so they may still read other projects.')
  })

  test('the gates table lists the project scope guard', () => {
    const row = RULES.split('\n').find(line => line.startsWith('| Project scope guard |')) ?? ''
    expect(row).toContain('any type but `Explore` and `Plan`')
    expect(row).toContain('inside this project, a git worktree of its repository, or a scratch root')
  })
})

describe('the working rule on pull request reviews', () => {
  test('no review is requested, by any route', () => {
    expect(RULES).toContain('## Pull request reviews')
    expect(RULES).toContain('Never request a review on a pull request. The user requests every review themselves.')
    expect(RULES).toContain('Do not name a reviewer when you create a pull request, such as with `gh pr create --reviewer`.')
    expect(RULES).toContain('Do not add a reviewer to a pull request that already exists, such as with `gh pr edit --add-reviewer`.')
    expect(RULES).toContain('Do not call the requested-reviewers API, through `gh api` or a GitHub MCP tool.')
    expect(RULES).toContain('Do not post a comment that asks a bot or a person to review, such as `@coderabbitai review`.')
  })
})

describe('the working rules on secrets', () => {
  test('a secret is read for its own processes, kept only in the keychain, and never shown', () => {
    expect(RULES).toContain('## Secrets')
    expect(RULES).toContain('You may read the keychain entries that your own processes use')
    expect(RULES).toContain('Store a secret only in the macOS keychain. Never put one in your memory, the vault, a document, a file, a config, a commit message or any other store.')
    expect(RULES).toContain('Never show a secret. Do not print, echo, log or trace one, and do not paste one into the transcript or into a tool\'s output.')
    expect(RULES).toContain('Always pass a secret through a variable, straight to the program that needs it, and on its input rather than its arguments')
    expect(RULES).toContain(`printf 'Authorization: Bearer %s' "$X" | curl -H @- …`)
    expect(RULES).not.toContain('curl -H "Authorization: Bearer $X"')
  })

  test('the Credential guard row claims no keychain read', () => {
    const row = RULES.split('\n').find(line => line.startsWith('| Credential guard |')) ?? ''
    expect(row).toContain('a keychain folder such as `~/Library/Keychains`')
    expect(row).toContain('It judges no `security` subcommand, only the paths a line names')
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
    for (const type of ['Explore', 'Plan', 'web-fetch', 'comment-thread-analyst', 'workbench-core:summary-writer', 'summary-writer', 'workbench-core:meeting-writer', 'meeting-writer']) {
      expect((await $.classic.SubagentStart(subagentStart(type))).additionalContext).toEqual(['BENEATH'])
    }
  })

  // A fork inherits its parent's system prompt, which carries the rules.
  test('a fork gets nothing, and a plain sub-agent still gets the rules', async ($, on) => {
    engine(on)
    await $.session.start(start(true))
    expect((await $.classic.SubagentStart(subagentStart('fork'))).additionalContext).toEqual(['BENEATH'])
    const [, text] = (await $.classic.SubagentStart(subagentStart('general-purpose'))).additionalContext ?? []
    expect(text).toContain(RULES)
  })

  test("the list holds every built-in the CLI defines with omitClaudeMd, and only those and core's own writers", () => {
    expect([...OMITS_CLAUDE_MD].sort()).toEqual([
      'Explore',
      'Plan',
      'comment-thread-analyst',
      'meeting-writer',
      'summary-writer',
      'web-fetch',
      'workbench-core:meeting-writer',
      'workbench-core:summary-writer',
    ])
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
