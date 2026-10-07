// The vault write checks (hooks/register.ts, hooks/mods/vault-write.ts): what
// reaches the memory MCP's write, edit and append carries a vault-relative path,
// valid frontmatter on a new note, and path links where a [[link]] resolves.
// A fix goes on as a rewrite of the call, and only what cannot be fixed is
// refused.

import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { PATH_REFUSAL, TYPES, blockOf, fixPath, rewriteLinks, wikiTargets } from '../hooks/mods/vault-write'
import type { Bench } from './bench'
import { HOME, bench, start } from './bench'

const VAULT = `${HOME}/Documents/Claude/Memory`
const TOOL = 'mcp__plugin_workbench-core_memory__'

const FM = { name: 'Gate design', type: 'insight' }

// What scripts/vault-resolve.sh prints for this vault: the root, and a line
// for each target given that the vault holds.
const NOTES: Record<string, string> = {
  'gate-design': '/insights/gate-design.md',
  'decisions/2026-10-06-x': '/decisions/2026-10-06-x.md',
  'spaced name': '/insights/spaced name.md',
}
function resolver(b: Bench, notes: Record<string, string> = NOTES): void {
  b.scripts['vault-resolve.sh'] = argv =>
    [`root\t${VAULT}`, ...argv.slice(2).filter(target => target in notes).map(target => `link\t${target}\t${notes[target]}`)].join('\n')
}

// One call of the memory tool `tool`, and what reached the engine: the input
// whole, or undefined when the call was refused.
async function send($: Engine, b: Bench, tool: string, input: Record<string, unknown>) {
  const before = b.inputs.length
  const result = await $.tool.call({ tool: `${TOOL}${tool}`, ...input } as never)
  const reached = b.inputs.length > before ? b.inputs[b.inputs.length - 1] : undefined
  expect(reached === undefined).toBe(result.deny !== undefined)
  return { deny: result.deny, reached }
}

const resolverRuns = (b: Bench): number => b.runs.filter(argv => argv[1]?.endsWith('/scripts/vault-resolve.sh')).length

describe('AC4: a new note needs a valid name and type', () => {
  test('a write with both, in the frontmatter argument or a block in the content, goes through untouched', async ($, on) => {
    const b = bench(on)
    resolver(b)
    await $.session.start(start())
    const asArgument = await send($, b, 'write', { path: 'insights/a.md', content: 'Body.', frontmatter: FM })
    expect(asArgument.reached).toMatchObject({ path: 'insights/a.md', content: 'Body.', frontmatter: FM })
    const asBlock = await send($, b, 'write', { path: 'insights/b.md', content: '---\nname: "Gate design"\ntype: insight\n---\n\nBody.' })
    expect(asBlock.deny).toBeUndefined()
    expect(resolverRuns(b)).toBe(0)
  })

  test('a missing or empty name is refused, and the reason names the field', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    for (const frontmatter of [{ type: 'insight' }, { name: '  ', type: 'insight' }, { name: 7, type: 'insight' }, undefined]) {
      const { deny } = await send($, b, 'write', { path: 'insights/a.md', content: 'Body.', frontmatter })
      expect(deny).toContain('`name`')
    }
  })

  test('a missing type is refused, naming the field and the list', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    const { deny } = await send($, b, 'write', { path: 'insights/a.md', content: 'Body.', frontmatter: { name: 'x' } })
    expect(deny).toContain('`type`')
    expect(deny).toContain(TYPES.join(', '))
    expect(deny).not.toContain('no `name`')
  })

  test('a type outside the vault\'s list is refused, naming the field and the value', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    for (const type of ['note', 'session-summary', 'Insight']) {
      const { deny } = await send($, b, 'write', { path: 'insights/a.md', content: 'Body.', frontmatter: { name: 'x', type } })
      expect(deny).toContain('`type`')
      expect(deny).toContain(`"${type}"`)
    }
  })

  test('both fields wrong are named in one refusal', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    const { deny } = await send($, b, 'write', { path: 'insights/a.md', content: '---\ntype: nope\n---\nBody.' })
    expect(deny).toContain('`name`')
    expect(deny).toContain('"nope"')
  })

  test('the frontmatter argument wins over a block in the content, field by field', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    const fixed = await send($, b, 'write', { path: 'a.md', content: '---\nname: x\ntype: bad\n---\n', frontmatter: { type: 'decision' } })
    expect(fixed.deny).toBeUndefined()
    const broken = await send($, b, 'write', { path: 'a.md', content: '---\nname: x\ntype: decision\n---\n', frontmatter: { type: 'bad' } })
    expect(broken.deny).toContain('"bad"')
  })

  test('every type a workbench skill or agent writes is on the list', () => {
    for (const type of ['session', 'decision', 'topic', 'insight', 'feedback', 'reference', 'maintenance', 'index', 'skill-learnings', 'proposal', 'learnings', 'infrastructure', 'identity', 'project']) {
      expect(TYPES).toContain(type)
    }
  })

  test('an attachment and an edit carry no frontmatter to check', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    expect((await send($, b, 'write', { path: 'assets/a.png', content_base64: 'AAAA' })).deny).toBeUndefined()
    expect((await send($, b, 'edit', { path: 'insights/a.md', old_text: 'x', new_text: 'y' })).deny).toBeUndefined()
  })

  test('an append that creates a note needs the frontmatter, and one to a note that exists does not', async ($, on) => {
    const b = bench(on, { files: { [`${VAULT}/sessions/log.md`]: '---\nname: x\ntype: session\n---\n' } })
    resolver(b)
    await $.session.start(start())
    const creates = await send($, b, 'append', { path: 'insights/new.md', content: 'A line.', create_if_missing: true })
    expect(creates.deny).toContain('`name`')
    expect(creates.deny).toContain('`type`')
    const withBlock = await send($, b, 'append', { path: 'insights/new.md', content: '---\nname: x\ntype: insight\n---\nA line.', create_if_missing: true })
    expect(withBlock.deny).toBeUndefined()
    const exists = await send($, b, 'append', { path: 'sessions/log.md', content: 'A line.', create_if_missing: true })
    expect(exists.deny).toBeUndefined()
    const runsBefore = resolverRuns(b)
    expect((await send($, b, 'append', { path: 'insights/new.md', content: 'A line.' })).deny).toBeUndefined()
    expect(resolverRuns(b)).toBe(runsBefore)
  })

  test('an append that may create a note, with the vault unreadable, is taken as new', async ($, on) => {
    const b = bench(on, { files: { [`${VAULT}/sessions/log.md`]: 'x' } })
    b.scripts['vault-resolve.sh'] = () => {
      throw new Error('cannot run')
    }
    await $.session.start(start())
    const { deny } = await send($, b, 'append', { path: 'sessions/log.md', content: 'A line.', create_if_missing: true })
    expect(deny).toContain('`name`')
  })

  test('a sub-agent\'s write is checked the same', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    const { deny } = await send($, b, 'write', { path: 'insights/a.md', content: 'Body.', agentId: 'a1' })
    expect(deny).toContain('`name`')
  })

  test('the frontmatter block reader takes quotes and block scalars', () => {
    expect(blockOf('---\nname: \'x\'\ntype: "insight"\n---\n')).toEqual({ name: 'x', type: 'insight' })
    expect(blockOf('---\nname: >-\n  A long title\ntype: topic\n---\n')).toEqual({ name: 'A long title', type: 'topic' })
    expect(blockOf('---\nname: |\ntype: topic\n---\n')).toEqual({ name: '', type: 'topic' })
    expect(blockOf('No block.\n---\nname: x\n---\n')).toBeUndefined()
    expect(blockOf('---\r\nname: x\r\ntype: topic\r\n---\r\n')).toEqual({ name: 'x', type: 'topic' })
  })

  test('a YAML comment after a value is not part of it, and a # inside quotes or a word is', async ($, on) => {
    expect(blockOf('---\nname: x # the title\ntype: session # x\n---\n')).toEqual({ name: 'x', type: 'session' })
    expect(blockOf('---\nname: "PR #336" # note\ntype: \'session\' #x\n---\n')).toEqual({ name: 'PR #336', type: 'session' })
    expect(blockOf('---\nname: C#\ntype: # nothing\n---\n')).toEqual({ name: 'C#', type: '' })
    const b = bench(on)
    await $.session.start(start())
    const { deny } = await send($, b, 'write', { path: 'sessions/a.md', content: '---\nname: x\ntype: session # x\n---\nBody.' })
    expect(deny).toBeUndefined()
  })
})

describe('AC5: [[links]] become path links where the target resolves', () => {
  test('a resolved link is rewritten, with its alias, and one that does not resolve is left with no refusal', async ($, on) => {
    const b = bench(on)
    resolver(b)
    await $.session.start(start())
    const content = 'See [[gate-design]], [[decisions/2026-10-06-x|the decision]] and [[missing-note]].'
    const { deny, reached } = await send($, b, 'write', { path: 'insights/a.md', content, frontmatter: FM })
    expect(deny).toBeUndefined()
    expect(reached?.content).toBe(
      'See [gate-design](/insights/gate-design.md), [the decision](/decisions/2026-10-06-x.md) and [[missing-note]].',
    )
    expect(reached?.frontmatter).toEqual(FM)
  })

  test('an edit\'s new text and an append\'s content are rewritten the same', async ($, on) => {
    const b = bench(on)
    resolver(b)
    await $.session.start(start())
    const edit = await send($, b, 'edit', { path: 'insights/a.md', old_text: 'x', new_text: 'See [[gate-design]].' })
    expect(edit.reached).toMatchObject({ old_text: 'x', new_text: 'See [gate-design](/insights/gate-design.md).' })
    const append = await send($, b, 'append', { path: 'insights/a.md', content: '- [[gate-design]]' })
    expect(append.reached?.content).toBe('- [gate-design](/insights/gate-design.md)')
  })

  test('a link in code, an embed, a heading link and a path with a space are left as written', async ($, on) => {
    const b = bench(on)
    resolver(b)
    await $.session.start(start())
    // The plain link at the end resolves the same target, so each one left
    // alone is left by the rule, not for want of a path.
    const kept = '`[[gate-design]]`\n\n```\n[[gate-design]]\n```\n\n![[gate-design]] [[gate-design#Why]] [[spaced name]]'
    const { reached } = await send($, b, 'write', { path: 'insights/a.md', content: `${kept} [[gate-design]]`, frontmatter: FM })
    expect(reached?.content).toBe(`${kept} [gate-design](/insights/gate-design.md)`)
  })

  test('when the resolver cannot run, every link is left and the write goes on', async ($, on) => {
    const b = bench(on)
    b.scripts['vault-resolve.sh'] = () => {
      throw new Error('cannot run')
    }
    await $.session.start(start())
    const { deny, reached } = await send($, b, 'write', { path: 'insights/a.md', content: '[[gate-design]]', frontmatter: FM })
    expect(deny).toBeUndefined()
    expect(reached?.content).toBe('[[gate-design]]')
  })

  test('the resolver is asked once, with each target once', async ($, on) => {
    const b = bench(on)
    resolver(b)
    await $.session.start(start())
    await send($, b, 'write', { path: 'insights/a.md', content: '[[gate-design]] [[gate-design]] [[missing-note]]', frontmatter: FM })
    const runs = b.runs.filter(argv => argv[1]?.endsWith('/scripts/vault-resolve.sh'))
    expect(runs).toHaveLength(1)
    expect(runs[0]?.slice(2)).toEqual(['gate-design', 'missing-note'])
  })

  test('a link in an attachment write is not read', async ($, on) => {
    const b = bench(on)
    resolver(b)
    await $.session.start(start())
    await send($, b, 'write', { path: 'assets/a.txt', content: '[[gate-design]]', content_base64: 'AAAA' })
    expect(resolverRuns(b)).toBe(0)
  })

  test('the link readers', () => {
    expect(wikiTargets('[[a]] [[ b |x]] ![[c]] `[[d]]` [[e#f]]')).toEqual(['a', 'b'])
    expect(rewriteLinks('[[a]]', new Map([['a', '/x/a.md']]))).toBe('[a](/x/a.md)')
    expect(rewriteLinks('[[a|A b]]', new Map([['a', '/x/a.md']]))).toBe('[A b](/x/a.md)')
    expect(rewriteLinks('[[a]]', new Map())).toBe('[[a]]')
  })
})

describe('AC6: a path with memory/ or an absolute path is fixed or refused before the server', () => {
  test('a memory/ prefix is dropped, with no resolver run', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    const { reached } = await send($, b, 'write', { path: 'memory/sessions/2026-10-06/x.summary.md', content: 'Body.', frontmatter: { name: 'x', type: 'session' } })
    expect(reached?.path).toBe('sessions/2026-10-06/x.summary.md')
    expect(resolverRuns(b)).toBe(0)
  })

  test('an absolute path inside the vault, or under ~, is made relative', async ($, on) => {
    const b = bench(on)
    resolver(b)
    await $.session.start(start())
    const absolute = await send($, b, 'edit', { path: `${VAULT}/insights/a.md`, old_text: 'x', new_text: 'y' })
    expect(absolute.reached?.path).toBe('insights/a.md')
    const tilde = await send($, b, 'append', { path: '~/Documents/Claude/Memory/memory/insights/a.md', content: 'y' })
    expect(tilde.reached?.path).toBe('insights/a.md')
  })

  test('an absolute path outside the vault, or one that climbs out, is refused', async ($, on) => {
    const b = bench(on)
    resolver(b)
    await $.session.start(start())
    for (const path of ['/Users/tester/Developer/repo/notes.md', `${VAULT}-old/a.md`, `${VAULT}/../a.md`, '../a.md', '~other/a.md']) {
      const { deny } = await send($, b, 'edit', { path, old_text: 'x', new_text: 'y' })
      expect(deny).toBe(PATH_REFUSAL)
    }
  })

  test('an absolute path is refused when the vault root cannot be read', async ($, on) => {
    const b = bench(on)
    b.scripts['vault-resolve.sh'] = () => ''
    await $.session.start(start())
    const { deny } = await send($, b, 'edit', { path: `${VAULT}/insights/a.md`, old_text: 'x', new_text: 'y' })
    expect(deny).toBe(PATH_REFUSAL)
  })

  test('a relative path with no prefix goes through untouched', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    const { reached } = await send($, b, 'edit', { path: 'insights/memory/a.md', old_text: 'x', new_text: 'y' })
    expect(reached?.path).toBe('insights/memory/a.md')
  })

  test('fixPath', () => {
    expect(fixPath('Memory/a.md', undefined, undefined)).toEqual({ path: 'a.md' })
    expect(fixPath('./memory/a.md', undefined, undefined)).toEqual({ path: 'a.md' })
    expect(fixPath('/v/a.md', '/v/', undefined)).toEqual({ path: 'a.md' })
    expect(fixPath('/v/a.md', undefined, undefined)).toEqual({ refusal: PATH_REFUSAL })
  })

  test('other memory tools and other servers are not touched', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    const read = await $.tool.call({ tool: `${TOOL}read`, path: '/abs/a.md' } as never)
    expect(read.deny).toBeUndefined()
    const other = await $.tool.call({ tool: 'mcp__other__write', path: '/abs/a.md', content: 'x' } as never)
    expect(other.deny).toBeUndefined()
  })
})
