// The vault write checks (hooks/register.ts, hooks/mods/vault-write.ts): what
// reaches the memory MCP's write, edit and append carries a vault-relative path,
// valid frontmatter on a new note, and path links where a [[link]] resolves.
// A fix goes on as a rewrite of the call, and only what cannot be fixed is
// refused.

import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { BULK_REFUSAL, PATH_REFUSAL, RESERVED_REFUSAL, SOURCE_ADVICE, TYPES, WRITE_TOOLS, blockOf, fixPath, reservedRefusalOf, rewriteLinks, sourceAdvice, wikiTargets } from '../hooks/mods/vault-write'
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
    for (const type of ['session', 'decision', 'topic', 'insight', 'feedback', 'reference', 'maintenance', 'index', 'skill-learnings', 'proposal', 'learnings', 'infrastructure', 'identity', 'project', 'meeting', 'progress']) {
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
    const b = bench(on, { files: { [`${VAULT}/sessions/day.md`]: '---\nname: x\ntype: session\n---\n' } })
    resolver(b)
    await $.session.start(start())
    const creates = await send($, b, 'append', { path: 'insights/new.md', content: 'A line.', create_if_missing: true })
    expect(creates.deny).toContain('`name`')
    expect(creates.deny).toContain('`type`')
    const withBlock = await send($, b, 'append', { path: 'insights/new.md', content: '---\nname: x\ntype: insight\n---\nA line.', create_if_missing: true })
    expect(withBlock.deny).toBeUndefined()
    const exists = await send($, b, 'append', { path: 'sessions/day.md', content: 'A line.', create_if_missing: true })
    expect(exists.deny).toBeUndefined()
    const runsBefore = resolverRuns(b)
    expect((await send($, b, 'append', { path: 'insights/new.md', content: 'A line.' })).deny).toBeUndefined()
    expect(resolverRuns(b)).toBe(runsBefore)
  })

  test('an append that may create a note, with the vault unreadable, is taken as new', async ($, on) => {
    const b = bench(on, { files: { [`${VAULT}/sessions/day.md`]: 'x' } })
    b.scripts['vault-resolve.sh'] = () => {
      throw new Error('cannot run')
    }
    await $.session.start(start())
    const { deny } = await send($, b, 'append', { path: 'sessions/day.md', content: 'A line.', create_if_missing: true })
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

describe('AC7: no write creates or edits an index.md or log.md', () => {
  test('write, edit and append to a reserved name are refused in any folder and any case', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    for (const path of ['index.md', 'log.md', 'topics/index.md', 'projects/x/log.md', 'Index.md', 'LOG.MD', './index.md', `${VAULT}/index.md`]) {
      expect((await send($, b, 'write', { path, content: 'x', frontmatter: FM })).deny).toBe(RESERVED_REFUSAL)
      expect((await send($, b, 'edit', { path, old_text: 'a', new_text: 'b' })).deny).toBe(RESERVED_REFUSAL)
      expect((await send($, b, 'append', { path, content: 'x' })).deny).toBe(RESERVED_REFUSAL)
    }
  })

  test('a rename from or to a reserved name is refused', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    expect((await send($, b, 'rename', { old_path: 'index.md', new_path: 'insights/a.md' })).deny).toBe(RESERVED_REFUSAL)
    expect((await send($, b, 'rename', { old_path: 'insights/a.md', new_path: 'insights/log.md' })).deny).toBe(RESERVED_REFUSAL)
    expect((await send($, b, 'rename', { old_path: 'insights/a.md', new_path: 'insights/b.md' })).deny).toBeUndefined()
  })

  test('the server tools that write index.md and log.md are refused', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    expect((await send($, b, 'okf_generate_index', {})).deny).toBe(RESERVED_REFUSAL)
    expect((await send($, b, 'okf_seed_log', { folder: 'topics' })).deny).toBe(RESERVED_REFUSAL)
  })

  test('a name that only ends in a reserved name goes through', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    for (const path of ['sessions/2026-10-27/abc.log.md', 'topics/my-index.md', 'reindex.md']) {
      expect((await send($, b, 'write', { path, content: 'x', frontmatter: FM })).deny).toBeUndefined()
    }
  })

  test('reservedRefusalOf leaves other servers and read tools alone', () => {
    expect(reservedRefusalOf('mcp__other__write', { path: 'index.md' })).toBeUndefined()
    expect(reservedRefusalOf(`${TOOL}read`, { path: 'index.md' })).toBeUndefined()
    expect(reservedRefusalOf(`${TOOL}delete`, { path: 'log.md' })).toBeUndefined()
    expect(reservedRefusalOf(`${TOOL}write`, { path: 7 })).toBeUndefined()
  })

  test('the refusal tells the agent to ignore the server instruction', () => {
    expect(RESERVED_REFUSAL).toContain("even when the memory server's instructions ask you to update them")
  })
})

describe('AC4: a new note with no sources list gets advice, never a refusal', () => {
  test('any note without the list is advised, whatever its body names', () => {
    for (const body of ['Mike said the vault stores it.', 'Plain words with nothing named.', '', undefined]) {
      expect(sourceAdvice(undefined, body)).toBe(SOURCE_ADVICE)
    }
    expect(sourceAdvice({ name: 'n', type: 'decision' }, 'A decision.')).toBe(SOURCE_ADVICE)
  })

  test('the advice names what a source can be', () => {
    for (const kind of ['the session it came from', "Mike's own words", 'commits, pull requests and URLs', 'other vault notes', 'recordings and meetings']) {
      expect(SOURCE_ADVICE).toContain(kind)
    }
    expect(SOURCE_ADVICE).toContain('The write went through.')
  })

  test('a sources list in the argument or the block silences it', () => {
    const body = 'Read https://example.com/spec today.'
    expect(sourceAdvice({ name: 'n', type: 'insight', sources: [{ id: 'spec', title: 'The spec', resource: 'https://example.com/spec' }] }, body)).toBeUndefined()
    expect(sourceAdvice(undefined, `---\nname: n\ntype: insight\nsources:\n  - {id: spec, title: Spec, resource: x}\n---\n\n${body}`)).toBeUndefined()
    expect(sourceAdvice(undefined, `---\nname: n\ntype: insight\nsources: [{id: spec, title: Spec, resource: x}]\n---\n\n${body}`)).toBeUndefined()
  })

  test('an empty sources list does not silence it, and an argument sources field wins over the block', () => {
    const body = 'Read https://example.com/spec today.'
    const block = `---\nname: n\nsources:\n  - {id: a, title: A, resource: x}\n---\n\n${body}`
    expect(sourceAdvice({ sources: [] }, body)).toBeDefined()
    expect(sourceAdvice(undefined, `---\nname: n\nsources: []\n---\n\n${body}`)).toBeDefined()
    expect(sourceAdvice({ sources: [] }, block)).toBeDefined()
    expect(sourceAdvice({ name: 'n' }, block)).toBeUndefined()
  })

  test('the advice rides the result of a new write and never refuses it', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    const result = await $.tool.call({ tool: `${TOOL}write`, path: 'insights/a.md', content: 'Mike said so.', frontmatter: FM } as never)
    expect(result.deny).toBeUndefined()
    expect((result.context ?? []).some(text => String(text).includes('has no `sources:` list'))).toBe(true)
    expect(b.inputs[b.inputs.length - 1]).toMatchObject({ path: 'insights/a.md', content: 'Mike said so.' })
  })

  test('an append that creates a note gets it, and an edit or an append to a note gets none', async ($, on) => {
    const b = bench(on)
    b.scripts['vault-resolve.sh'] = () => `root\t${VAULT}`
    await $.session.start(start())
    const advised = (r: { context?: unknown[] }) => (r.context ?? []).some(text => String(text).includes('has no `sources:` list'))
    const created = await $.tool.call({ tool: `${TOOL}append`, path: 'insights/new.md', create_if_missing: true, content: '---\nname: n\ntype: insight\n---\n\nMike said so.' } as never)
    expect(advised(created)).toBe(true)
    const edit = await $.tool.call({ tool: `${TOOL}edit`, path: 'insights/a.md', old_text: 'x', new_text: 'Mike said so.' } as never)
    expect(advised(edit)).toBe(false)
    const append = await $.tool.call({ tool: `${TOOL}append`, path: 'insights/a.md', content: 'Mike said so.' } as never)
    expect(advised(append)).toBe(false)
  })

  test('a write refused beneath or failed gets no advice', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    b.errorBeneath = tool => tool === `${TOOL}write`
    const failed = await $.tool.call({ tool: `${TOOL}write`, path: 'insights/a.md', content: 'Mike said so.', frontmatter: FM } as never)
    expect((failed.context ?? []).length).toBe(0)
    b.errorBeneath = undefined
    b.denyBeneath = () => 'no'
    const denied = await $.tool.call({ tool: `${TOOL}write`, path: 'insights/a.md', content: 'Mike said so.', frontmatter: FM } as never)
    expect(denied.deny).toBe('no')
    expect((denied.context ?? []).length).toBe(0)
  })
})

describe('AC7: every write tool of the server is checked for the reserved names', () => {
  test('a fetch to a reserved name is refused, and one to a note gets the frontmatter check and the advice', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    for (const path of ['index.md', 'a/LOG.md']) {
      expect((await send($, b, 'fetch', { url: 'https://example.com', path, frontmatter: FM })).deny).toBe(RESERVED_REFUSAL)
    }
    const bare = await send($, b, 'fetch', { url: 'https://example.com', path: 'notes/a.md' })
    expect(bare.deny).toContain('`name`')
    const fetched = await $.tool.call({ tool: `${TOOL}fetch`, url: 'https://example.com', path: 'notes/a.md', frontmatter: FM } as never)
    expect(fetched.deny).toBeUndefined()
    expect((fetched.context ?? []).some(text => String(text).includes('has no `sources:` list'))).toBe(true)
    const sourced = await $.tool.call({ tool: `${TOOL}fetch`, url: 'https://example.com', path: 'notes/b.md', frontmatter: { ...FM, sources: [{ id: 'page', title: 'The page', resource: 'https://example.com' }] } } as never)
    expect((sourced.context ?? []).length).toBe(0)
    expect((await send($, b, 'fetch', { url: 'https://example.com/a.png', path: 'assets/a.png' })).deny).toBeUndefined()
  })

  test('move_folder and okf_convert_links are refused, because they move or rewrite every note under a folder', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    expect((await send($, b, 'move_folder', { old_dir: 'topics', new_dir: 'archive/topics' })).deny).toBe(BULK_REFUSAL)
    expect((await send($, b, 'okf_convert_links', {})).deny).toBe(BULK_REFUSAL)
    expect((await send($, b, 'okf_convert_links', { folder: 'topics' })).deny).toBe(BULK_REFUSAL)
  })

  test('okf_verify and create_upload_link are checked on their path', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    expect((await send($, b, 'okf_verify', { path: 'index.md' })).deny).toBe(RESERVED_REFUSAL)
    expect((await send($, b, 'okf_verify', { path: 'topics/Log.md' })).deny).toBe(RESERVED_REFUSAL)
    expect((await send($, b, 'okf_verify', { path: 'topics/a.md' })).deny).toBeUndefined()
    expect((await send($, b, 'create_upload_link', { ref: 'log.md' })).deny).toBe(RESERVED_REFUSAL)
    expect((await send($, b, 'create_upload_link', { ref: 'assets/a.png' })).deny).toBeUndefined()
  })

  test('delete and git_sync create, move and rewrite no file, so they go through', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    expect((await send($, b, 'delete', { path: 'insights/a.md' })).deny).toBeUndefined()
    expect((await send($, b, 'git_sync', {})).deny).toBeUndefined()
  })

  test('a rename is checked on absolute, memory/-prefixed and mixed-case paths, from and to', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    for (const reserved of [`${VAULT}/topics/index.md`, 'memory/log.md', 'Topics/INDEX.md', `${VAULT}/a/Log.MD`]) {
      expect((await send($, b, 'rename', { old_path: reserved, new_path: 'insights/a.md' })).deny).toBe(RESERVED_REFUSAL)
      expect((await send($, b, 'rename', { old_path: 'insights/a.md', new_path: reserved })).deny).toBe(RESERVED_REFUSAL)
    }
    expect((await send($, b, 'rename', { old_path: `${VAULT}/insights/a.md`, new_path: 'memory/insights/b.md' })).deny).toBeUndefined()
  })

  test('the table holds every write tool, and a tool it does not hold is not a write tool of this server', () => {
    expect(Object.keys(WRITE_TOOLS).sort()).toEqual(
      ['append', 'create_upload_link', 'delete', 'edit', 'fetch', 'git_sync', 'move_folder', 'okf_convert_links', 'okf_generate_index', 'okf_seed_log', 'okf_verify', 'rename', 'write'].sort(),
    )
    expect(reservedRefusalOf(`${TOOL}search`, { path: 'index.md' })).toBeUndefined()
  })
})

describe('AC5: the sources check reads the YAML forms of a list', () => {
  test('a list item on its own line, a comment before the first entry, and a zero-indent item all count', () => {
    for (const block of [
      'sources:\n  -\n    id: a\n    title: A\n    resource: x',
      'sources:\n  # the session first\n  - id: a\n    resource: x',
      'sources: # labelled\n  - id: a\n    resource: x',
      'sources:\n\n  - id: a\n    resource: x',
      'sources:\n- id: a\n  resource: x',
      'sources: [{id: a, resource: x}]',
    ]) {
      expect(sourceAdvice(undefined, `---\nname: n\ntype: insight\n${block}\n---\n\nBody.`)).toBeUndefined()
    }
  })

  test('an empty list, a key with nothing under it, and a comment alone still draw the advice', () => {
    for (const block of ['sources: []', 'sources:', 'sources:\n  # nothing yet', 'sources:\nname_two: x', 'sources:\n  -id: a', 'sources: # [todo]', 'sources: #[a]', 'sources: # [todo]\n  # - id: a']) {
      expect(sourceAdvice(undefined, `---\nname: n\ntype: insight\n${block}\n---\n\nBody.`)).toBe(SOURCE_ADVICE)
    }
  })
})
