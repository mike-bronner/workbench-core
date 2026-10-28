import { describe, expect, test } from 'claude-code/testing'

import { markerOf, sessionDirOf, transcriptFileOf } from '../hooks/mods/fallback'
import { rulesContextOf, subagentContextOf } from '../hooks/mods/prompt-rules'
import { HOME, SID, TRANSCRIPT, memoryWorld, runsOf, sessionStart, start, turn } from './memory-world'

const LOG = 'session-log.sh'

const COMPOSE = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal' as const], tools: [], outputStyle: null, traits: [] }
const marker = (hook: string) => `${HOME}/.claude-workbench/mod-ran/${SID}/${hook}`
const subagent = { session_id: SID, agent_id: 'a1', agent_type: 'general-purpose' }

describe('AC2: each mod hook marks the session before next(e), and a failed mark changes nothing', () => {
  test('classic.SessionStart has written its marker when the hooks beneath run', async ($, on) => {
    const w = memoryWorld(on)
    const seen: boolean[] = []
    w.beneath = event => event === 'SessionStart' && seen.push(w.files.has(marker('session-start')))
    await $.session.start(start())
    await $.classic.SessionStart(sessionStart())
    expect(seen).toEqual([true])
  })

  test('classic.SubagentStart has written its marker when the hooks beneath run', async ($, on) => {
    const w = memoryWorld(on)
    const seen: boolean[] = []
    w.beneath = event => event === 'SubagentStart' && seen.push(w.files.has(marker('subagent-start')))
    await $.session.start(start())
    await $.classic.SubagentStart(subagent)
    expect(seen).toEqual([true])
  })

  test('prompt.compose has written its marker when the hooks beneath run', async ($, on) => {
    const w = memoryWorld(on)
    const seen: boolean[] = []
    w.beneath = event => event === 'compose' && seen.push(w.files.has(marker('prompt-compose')))
    await $.session.start(start())
    await $.prompt.compose(COMPOSE)
    expect(seen).toEqual([true])
  })

  test('a rejected marker write leaves each hook result as it is', async ($, on) => {
    const w = memoryWorld(on)
    await $.session.start(start())
    const kept = {
      start: await $.classic.SessionStart(sessionStart()),
      subagent: await $.classic.SubagentStart(subagent),
      compose: await $.prompt.compose(COMPOSE),
    }
    w.files.clear()
    w.writeRejects = path => path.includes('/mod-ran/')
    const failed = {
      start: await $.classic.SessionStart(sessionStart()),
      subagent: await $.classic.SubagentStart(subagent),
      compose: await $.prompt.compose(COMPOSE),
    }
    expect([...w.files.keys()].filter(path => path.includes('/mod-ran/'))).toEqual([])
    expect(failed).toEqual(kept)
    expect(kept.subagent.additionalContext?.length).toBe(2)
  })
})

describe('AC4: a failed prompt.compose marker write is tried again', () => {
  test('the next compose in the same session writes the marker', async ($, on) => {
    const w = memoryWorld(on)
    await $.session.start(start())
    w.writeRejects = () => true
    await $.prompt.compose(COMPOSE)
    expect(w.files.has(marker('prompt-compose'))).toBe(false)
    w.writeRejects = undefined
    await $.prompt.compose(COMPOSE)
    expect(w.files.has(marker('prompt-compose'))).toBe(true)
  })
})

describe('AC3: the fallback rules context matches the mod composition', () => {
  test('the same env and installed_plugins.json give the same rules, memory and sibling text', async ($, on) => {
    const w = memoryWorld(on)
    w.files.set(`${HOME}/.claude/plugins/installed_plugins.json`, JSON.stringify({ plugins: { 'workbench-dev-team@claude-workbench': [{ installPath: '/plugins/dev-team' }] } }))
    w.files.set('/plugins/dev-team/session-warmup.md', 'Sibling rules.\n')
    await $.session.start(start())
    const ours = (await $.prompt.compose(COMPOSE)).sections.filter(section => section.id.startsWith('workbench-core:'))
    expect(ours.map(section => section.id)).toEqual(['workbench-core:rules', 'workbench-core:memory', 'workbench-core:plugins'])
    expect(rulesContextOf({ HOME }, path => w.files.get(path))).toBe(subagentContextOf(ours))
  })
})

describe('the log checkpoint reads the transcript a fallback recorded', () => {
  test('with no mod SessionStart, a turn checkpoints the recorded transcript', async ($, on) => {
    const w = memoryWorld(on)
    w.scripts[LOG] = () => ''
    w.files.set(`${HOME}/.claude-workbench/fallback-transcripts/${SID}`, `${TRANSCRIPT}\n`)
    await $.session.start(start())
    await $.turn.complete(turn('answer'))
    await w.clock.settle()
    expect(runsOf(w, LOG).map(run => (JSON.parse(run.stdin ?? '{}') as { transcript_path?: string }).transcript_path)).toEqual([TRANSCRIPT])
  })

  test('with neither, no checkpoint runs', async ($, on) => {
    const w = memoryWorld(on)
    w.scripts[LOG] = () => ''
    await $.session.start(start())
    await $.turn.complete(turn('answer'))
    await w.clock.settle()
    expect(runsOf(w, LOG)).toHaveLength(0)
  })
})

describe('the readers', () => {
  test('paths stay under HOME and refuse a session id that is not one', () => {
    expect(markerOf(HOME, SID, 'session-start')).toBe(`${HOME}/.claude-workbench/mod-ran/${SID}/session-start`)
    expect(transcriptFileOf(HOME, SID)).toBe(`${HOME}/.claude-workbench/fallback-transcripts/${SID}`)
    expect(sessionDirOf(HOME, '../x')).toBeUndefined()
    expect(sessionDirOf('relative', SID)).toBeUndefined()
    expect(transcriptFileOf(undefined, SID)).toBeUndefined()
  })
})
