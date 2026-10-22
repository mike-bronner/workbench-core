import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { DOORBELL_MS, FV_SERVE, meetingIdOf, meetingWriterPathRefusal, meetingWriterRefusal, meetingsDirOf } from '../hooks/mods/meetings'
import { parseShell } from '../hooks/mods/shell'
import type { Bench } from './bench'
import { HOME, SID, START, bench, caller, start } from './bench'

const MEETINGS = meetingsDirOf(HOME)
const SCRIPT = 'meeting-notes.sh'
const FV = `'${FV_SERVE}'`
const TOOL = 'mcp__plugin_workbench-core_memory__'
const VAULT = `${HOME}/Documents/Claude/Memory`
const SLOW_MS = 20_000

const SLOW = caller((on: On) => {
  on('process.run', async ($, e, next) => {
    if ((e.argv[1] ?? '').endsWith('/scripts/meeting-notes.sh')) await $.clock.sleep(20_000)
    return next(e)
  })
})

type World = { fv?: boolean; dir?: boolean; env?: Record<string, string> }

function world(on: Parameters<typeof bench>[0], { fv = true, dir = true, env = {} }: World = {}): Bench {
  const b = bench(on, { env: { HOME, ...env } })
  on('classic.SessionStart', () => ({ additionalContext: ['the rules'] }))
  on('classic.FileChanged', () => ({}))
  if (env.WORKBENCH_MEETING_WRITER === '1') b.decision = 'allow'
  if (fv) b.files.set(FV_SERVE, '')
  if (dir) b.kinds.set(MEETINGS, 'dir')
  for (const name of ['false-bare.sh', 'session-warmup.sh', 'scratch-roots.sh', 'memory-status.sh', 'vault-resolve.sh']) b.scripts[name] = () => ''
  b.scripts['vault-resolve.sh'] = () => `root\t${VAULT}\n`
  b.scripts[SCRIPT] = () => 'result=done dispatched=1 recorded=0 busy=0 left=0\n'
  return b
}

const scriptRuns = (b: Bench): number => b.runs.filter(argv => argv[0] === 'bash' && argv[1]?.endsWith(`/scripts/${SCRIPT}`)).length

const sessionStart = (source: 'startup' | 'resume' | 'clear' | 'compact') => ({ source, session_id: SID, transcript_path: '/t.jsonl', cwd: '/repo' })

async function opened($: Engine, b: Bench, source: 'startup' | 'resume' | 'clear' | 'compact' = 'startup') {
  await $.session.start(start())
  const result = await $.classic.SessionStart(sessionStart(source) as never)
  await b.clock.advance(0)
  return result
}

const changed = ($: Engine, file_path: string, event: 'add' | 'change' | 'unlink' = 'add') => $.classic.FileChanged({ file_path, event } as never)

const asked = (b: Bench): boolean => b.inputs.some(input => input.tool === 'AskUserQuestion')

describe('AC1: a change in the Meetings folder rings the doorbell', () => {
  test('session start watches the Meetings folder', async ($, on) => {
    const b = world(on)
    const result = await opened($, b)
    expect(result.watchPaths).toEqual([MEETINGS])
  })

  test('a change runs the check once, after the doorbell wait, with no prompt and no toast', async ($, on) => {
    const b = world(on)
    await opened($, b)
    const before = scriptRuns(b)
    await changed($, `${MEETINGS}/abc/transcript.json`)
    expect(scriptRuns(b)).toBe(before)
    await b.clock.advance(DOORBELL_MS)
    expect(scriptRuns(b)).toBe(before + 1)
    expect(asked(b)).toBe(false)
    expect(b.toasts).toEqual([])
  })

  test('a burst of add, change and unlink events runs the check once', async ($, on) => {
    const b = world(on)
    await opened($, b)
    const before = scriptRuns(b)
    for (const event of ['add', 'change', 'change', 'unlink', 'add'] as const) await changed($, `${MEETINGS}/abc/part-${event}`, event)
    await b.clock.advance(DOORBELL_MS)
    expect(scriptRuns(b)).toBe(before + 1)
    await changed($, `${MEETINGS}/def/audio.m4a`, 'change')
    await b.clock.advance(DOORBELL_MS)
    expect(scriptRuns(b)).toBe(before + 2)
  })

  test('a change while the check runs gets one more check after it, not a second one beside it', { plugins: [SLOW] }, async ($, on) => {
    const b = world(on)
    const ended: number[] = []
    b.scripts[SCRIPT] = () => {
      ended.push(b.clock.now() - START)
      return ''
    }
    await opened($, b)
    await changed($, `${MEETINGS}/abc`)
    await changed($, `${MEETINGS}/def`)
    for (let i = 0; i < 6; i++) await b.clock.advance(DOORBELL_MS)
    expect(ended).toEqual([SLOW_MS, 2 * SLOW_MS])
  })

  test('a change outside the Meetings folder runs nothing', async ($, on) => {
    const b = world(on)
    await opened($, b)
    const before = scriptRuns(b)
    for (const path of ['/repo/a.md', `${MEETINGS}-old/x`, `${HOME}/Library/Application Support/FluidVoice/settings.json`]) await changed($, path)
    await b.clock.advance(DOORBELL_MS)
    expect(scriptRuns(b)).toBe(before)
  })

  test('a check that fails shows nothing', async ($, on) => {
    const b = world(on)
    b.scripts[SCRIPT] = () => {
      throw new Error('no bash')
    }
    await opened($, b)
    await changed($, `${MEETINGS}/abc`)
    await b.clock.advance(DOORBELL_MS)
    expect(b.toasts).toEqual([])
    expect(asked(b)).toBe(false)
  })
})

describe('AC2: session start catches up', () => {
  for (const source of ['startup', 'resume'] as const) {
    test(`a ${source} runs the check`, async ($, on) => {
      const b = world(on)
      await opened($, b, source)
      expect(scriptRuns(b)).toBe(1)
    })
  }

  for (const source of ['clear', 'compact'] as const) {
    test(`a ${source} keeps the watch and runs no check`, async ($, on) => {
      const b = world(on)
      const result = await opened($, b, source)
      expect(result.watchPaths).toEqual([MEETINGS])
      expect(scriptRuns(b)).toBe(0)
    })
  }
})

describe('AC6: without FluidVoice the path does nothing', () => {
  const cases: [string, World][] = [
    ['fv-serve is absent', { fv: false }],
    ['the Meetings folder is absent', { dir: false }],
    ['the session is a dispatched writer', { env: { WORKBENCH_SKIP_WARMUP: '1' } }],
  ]
  for (const [name, setup] of cases) {
    test(`when ${name}: no watch, no check, nothing shown`, async ($, on) => {
      const b = world(on, setup)
      const result = await opened($, b)
      expect(result.watchPaths).toBeUndefined()
      await changed($, `${MEETINGS}/abc`)
      await b.clock.advance(DOORBELL_MS)
      expect(scriptRuns(b)).toBe(0)
      expect(b.toasts).toEqual([])
      expect(asked(b)).toBe(false)
    })
  }
})

describe('AC5: the meeting-writer reads FluidVoice and writes nothing else', () => {
  const ALLOWED = [
    `${FV} status`,
    `${FV} meet show abc-123 --json`,
    `${FV} meet show abc-123 --from 10:00 --to 20:00 --json`,
    `${FV} meet summary abc-123`,
    `${FV} meet list --json`,
    `${FV} meet search budget`,
    `${FV} status --json`,
  ]
  const REFUSED = [
    `${FV} meet show abc | tee notes.md`,
    `${FV} meet show abc > /tmp/t.txt`,
    `${FV} meet show abc; rm -rf ~/x`,
    `${FV} meet delete abc`,
    `${FV} skill`,
    `X=1 ${FV} status`,
    'fv-serve meet list',
    `cat "${MEETINGS}/abc/transcript.json"`,
    'curl https://example.com',
    `$(echo ${FV}) status`,
    'echo hi',
    '/tmp/x/fv-serve status',
    '/Applications/Other.app/Contents/Helpers/fv-serve meet list --json',
    `env ${FV} status`,
    `command ${FV} status`,
    `exec ${FV} status`,
    `nohup ${FV} status`,
    `${FV} status & ${FV} status`,
    `${FV} status && ${FV} status`,
    `${FV} status\n${FV} status`,
    `${FV} status --anything`,
    `${FV} status --json --anything`,
  ]

  for (const line of ALLOWED) {
    test(`allows ${JSON.stringify(line)}`, async ($, on) => {
      const b = world(on, { env: { WORKBENCH_MEETING_WRITER: '1' } })
      await $.session.start(start(false))
      expect(meetingWriterRefusal(parseShell(line))).toBeUndefined()
      expect((await $.tool.call({ tool: 'Bash', command: line } as never)).deny).toBeUndefined()
      expect(b.inputs.some(input => input.command === line)).toBe(true)
    })
  }

  for (const line of REFUSED) {
    test(`refuses ${JSON.stringify(line)}`, async ($, on) => {
      const b = world(on, { env: { WORKBENCH_MEETING_WRITER: '1' } })
      await $.session.start(start(false))
      expect(meetingWriterRefusal(parseShell(line))).toContain('Meeting-writer guard (workbench-core)')
      expect((await $.tool.call({ tool: 'Bash', command: line } as never)).deny).toMatch(/^(Meeting-writer guard|Workbench guards) \(workbench-core\)/)
      expect(b.inputs.some(input => input.command === line)).toBe(false)
    })
  }

  test('outside the meeting-writer, the same lines are not its to judge', async ($, on) => {
    const b = world(on)
    b.decision = 'allow'
    await $.session.start(start(false))
    expect((await $.tool.call({ tool: 'Bash', command: 'echo hi' } as never)).deny).toBeUndefined()
    expect(b.inputs.some(input => input.command === 'echo hi')).toBe(true)
  })

  const writer = (id?: string) => ({ env: { WORKBENCH_MEETING_WRITER: '1', ...(id === undefined ? {} : { WORKBENCH_MEETING_ID: id }) } })
  const writeAs = ($: Engine, path: string, meeting_id?: string) =>
    $.tool.call({ tool: `${TOOL}write`, path, content: 'Body.', frontmatter: { name: 'n', type: 'decision', ...(meeting_id === undefined ? {} : { meeting_id }) } } as never)

  test('its vault writes land only under meetings/ and decisions/', async ($, on) => {
    const b = world(on, writer('abc'))
    await $.session.start(start(false))
    expect((await writeAs($, 'meetings/2026-10-01/abc.md', 'abc')).deny).toBeUndefined()
    expect((await writeAs($, 'decisions/2026-10-01-postgres.md', 'abc')).deny).toBeUndefined()
    expect((await writeAs($, 'meetings/../feedback/x.md', 'abc')).deny).toBeDefined()
    for (const path of ['feedback/x.md', 'README.md', 'topics/meetings/x.md', 'meetingsx/a.md']) {
      expect((await writeAs($, path, 'abc')).deny).toContain('Meeting-writer guard (workbench-core)')
    }
    const edit = await $.tool.call({ tool: `${TOOL}edit`, path: 'identity/profile.md', old_text: 'a', new_text: 'b' } as never)
    expect(edit.deny).toContain('only under meetings/ and decisions/')
    expect(b.inputs.filter(input => String(input.tool).startsWith(TOOL)).map(input => input.path)).toEqual([
      'meetings/2026-10-01/abc.md',
      'decisions/2026-10-01-postgres.md',
    ])
  })

  test("AC1: a writer dispatched for another meeting cannot replace this meeting's note, whatever id it writes", async ($, on) => {
    const b = world(on, writer('xyz'))
    b.files.set(`${VAULT}/meetings/2026-10-01/abc.md`, '---\nname: "Meeting: Sync"\ntype: meeting\nmeeting_id: "abc"\n---\n')
    b.files.set(`${VAULT}/decisions/2026-10-01-postgres.md`, '---\nname: Postgres\ntype: decision\nmeeting_id: abc\n---\n')
    await $.session.start(start(false))
    expect((await writeAs($, 'meetings/2026-10-01/abc.md', 'abc')).deny).toContain('dispatched for meeting xyz')
    expect((await writeAs($, 'decisions/2026-10-01-postgres.md', 'abc')).deny).toContain('dispatched for meeting xyz')
    const inBlock = await $.tool.call({ tool: `${TOOL}write`, path: 'meetings/2026-10-01/abc.md', content: '---\nname: m\ntype: meeting\nmeeting_id: abc\n---\n' } as never)
    expect(inBlock.deny).toContain('dispatched for meeting xyz')
    expect((await writeAs($, 'meetings/2026-10-01/abc.md', 'xyz')).deny).toContain('already holds a note that is not this meeting')
    expect(b.inputs.filter(input => String(input.tool).startsWith(TOOL))).toEqual([])
  })

  test('AC2: a new note must carry the dispatched id, and the meeting may replace only its own note', async ($, on) => {
    const b = world(on, writer('abc'))
    b.files.set(`${VAULT}/decisions/2026-09-01-other.md`, '---\nname: Other\ntype: decision\n---\n\nBody.')
    b.files.set(`${VAULT}/meetings/2026-10-01/abc.md`, '---\nname: "Meeting: Sync"\ntype: meeting\nmeeting_id: "abc"\n---\n')
    await $.session.start(start(false))
    for (const id of ['xyz', undefined]) {
      expect((await writeAs($, 'decisions/2026-10-02-new.md', id)).deny).toContain('dispatched for meeting abc')
    }
    expect((await writeAs($, 'decisions/2026-09-01-other.md', 'abc')).deny).toContain('already holds a note that is not this meeting')
    expect((await writeAs($, 'decisions/2026-10-02-new.md', 'abc')).deny).toBeUndefined()
    expect((await writeAs($, 'meetings/2026-10-01/abc.md', 'abc')).deny).toBeUndefined()
    const inBlock = await $.tool.call({ tool: `${TOOL}write`, path: 'meetings/2026-10-01/abc.md', content: '---\nname: m\ntype: meeting\nmeeting_id: abc\n---\n' } as never)
    expect(inBlock.deny).toBeUndefined()
  })

  for (const [name, env] of [
    ['unset', writer()],
    ['empty', writer('')],
  ] as const) {
    test(`AC3: a writer whose dispatched id is ${name} writes nothing`, async ($, on) => {
      const b = world(on, env)
      await $.session.start(start(false))
      for (const path of ['meetings/2026-10-01/abc.md', 'decisions/2026-10-02-new.md']) {
        for (const id of ['abc', '', undefined]) expect((await writeAs($, path, id)).deny).toContain('no WORKBENCH_MEETING_ID')
      }
      expect(b.inputs.filter(input => String(input.tool).startsWith(TOOL))).toEqual([])
    })
  }

  test('it never edits or appends', async ($, on) => {
    const b = world(on, writer('abc'))
    b.files.set(`${VAULT}/decisions/2026-09-01-other.md`, '---\nname: Other\ntype: decision\n---\n')
    await $.session.start(start(false))
    const edit = await $.tool.call({ tool: `${TOOL}edit`, path: 'decisions/2026-09-01-other.md', old_text: 'Other', new_text: 'Mine' } as never)
    expect(edit.deny).toContain('never edits or appends')
    const append = await $.tool.call({ tool: `${TOOL}append`, path: 'meetings/2026-10-01/abc.md', content: 'more' } as never)
    expect(append.deny).toContain('never edits or appends')
  })

  test('a vault it cannot read refuses the write', async ($, on) => {
    const b = world(on, writer('abc'))
    b.scripts['vault-resolve.sh'] = () => ''
    await $.session.start(start(false))
    expect((await writeAs($, 'meetings/2026-10-01/abc.md', 'abc')).deny).toContain('the vault could not be read')
  })

  test('the meeting id reader', () => {
    expect(meetingIdOf('---\nname: x\nmeeting_id: "a-1"\n---\n')).toBe('a-1')
    expect(meetingIdOf("---\nmeeting_id: 'a-1'\n---\n")).toBe('a-1')
    expect(meetingIdOf('---\nmeeting_id: a-1 # note\n---\n')).toBe('a-1')
    expect(meetingIdOf('---\nname: x\n---\n\nmeeting_id: a-1\n')).toBeUndefined()
    expect(meetingIdOf('meeting_id: a-1\n')).toBeUndefined()
    expect(meetingIdOf('---\nmeeting_id:\n---\n')).toBeUndefined()
  })

  test('outside the meeting-writer, a vault write anywhere goes on', async ($, on) => {
    world(on)
    await $.session.start(start(false))
    const result = await $.tool.call({ tool: `${TOOL}write`, path: 'feedback/x.md', content: 'Body.', frontmatter: { name: 'x', type: 'feedback' } } as never)
    expect(result.deny).toBeUndefined()
  })

  test('the path rule on its own', () => {
    expect(meetingWriterPathRefusal('meetings/2026-10-01/abc.md')).toBeUndefined()
    expect(meetingWriterPathRefusal('decisions/x.md')).toBeUndefined()
    expect(meetingWriterPathRefusal('decisions/../x.md')).toBeDefined()
    expect(meetingWriterPathRefusal('meetingsx/a.md')).toBeDefined()
  })
})
