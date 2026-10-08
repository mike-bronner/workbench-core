// The log checkpoint (hooks/register.ts, hooks/mods/checkpoint.ts): the module
// runs hooks/session-log.sh after each main-loop turn, answered or
// interrupted, and at session end, so a session's raw log is written as it
// runs. hooks/test-session-log.sh and hooks/test-session-reconcile.sh cover
// what the script does with the one checkpoint it shares with SessionEnd and
// the start-up reconciler.

import { describe, expect, test } from 'claude-code/testing'

import { END_MAX_MS, checkpointRequest, endTimeoutOf } from '../hooks/mods/checkpoint'
import { HOME, SID, TRANSCRIPT, memoryWorld, runsOf, sessionStart, start, turn } from './memory-world'

const LOG = 'session-log.sh'
const payloadOf = (stdin: string | undefined) => JSON.parse(stdin ?? '{}') as Record<string, unknown>

describe('AC1: each main-loop turn, and the session end, checkpoint the session log', () => {
  test('an answered turn appends through session-log.sh in mode turn', async ($, on) => {
    const w = memoryWorld(on)
    w.scripts[LOG] = () => ''
    await $.session.start(start())
    await $.classic.SessionStart(sessionStart())
    await $.turn.complete(turn('answer'))
    await w.clock.settle()
    const runs = runsOf(w, LOG)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.argv[0]).toBe('bash')
    expect(runs[0]?.argv[1]).toMatch(/\/hooks\/session-log\.sh$/)
    expect(runs[0]?.env).toEqual({ WORKBENCH_LOG_MODE: 'turn' })
    expect(payloadOf(runs[0]?.stdin)).toEqual({ session_id: SID, transcript_path: TRANSCRIPT, hook_event_name: 'TurnComplete' })
  })

  test('an interrupted turn checkpoints too: the Stop hook never fired for one', async ($, on) => {
    const w = memoryWorld(on)
    w.scripts[LOG] = () => ''
    await $.session.start(start())
    await $.classic.SessionStart(sessionStart())
    await $.turn.complete(turn('aborted'))
    await $.turn.complete(turn('error'))
    await w.clock.settle()
    expect(runsOf(w, LOG).map(run => run.env?.WORKBENCH_LOG_MODE)).toEqual(['turn', 'turn'])
  })

  test("a sub-agent's turn writes nothing: its lines are in its parent's transcript", async ($, on) => {
    const w = memoryWorld(on)
    w.scripts[LOG] = () => ''
    await $.session.start(start())
    await $.classic.SessionStart(sessionStart())
    await $.turn.complete(turn('answer', 'agent-1'))
    await w.clock.settle()
    expect(runsOf(w, LOG)).toEqual([])
  })

  test('a SIGHUP or SIGTERM exit (reason other) checkpoints in mode final, inside the exit budget', async ($, on) => {
    const w = memoryWorld(on)
    w.scripts[LOG] = () => ''
    await $.session.start(start())
    await $.classic.SessionStart(sessionStart())
    await $.session.end({ reason: 'other', sessionId: SID, resume: { id: SID } })
    const runs = runsOf(w, LOG)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.env).toEqual({ WORKBENCH_LOG_MODE: 'final' })
    expect(payloadOf(runs[0]?.stdin)).toEqual({ session_id: SID, transcript_path: TRANSCRIPT, hook_event_name: 'SessionEnd', reason: 'other' })
    expect(runs[0]?.timeoutMs).toBeLessThanOrEqual(END_MAX_MS)
  })

  test('an unattended session checkpoints as well: a killed -p run loses no more than a turn', async ($, on) => {
    const w = memoryWorld(on)
    w.scripts[LOG] = () => ''
    await $.session.start(start(false))
    await $.classic.SessionStart(sessionStart())
    await $.turn.complete(turn('answer'))
    await w.clock.settle()
    expect(runsOf(w, LOG)).toHaveLength(1)
  })

  test('with no transcript known, or one that names another session, nothing is copied', async ($, on) => {
    const w = memoryWorld(on)
    w.scripts[LOG] = () => ''
    await $.session.start(start())
    await $.turn.complete(turn('answer'))
    await $.classic.SessionStart(sessionStart(SID, 'startup', `${HOME}/.claude/projects/-repo/another-session.jsonl`))
    await $.turn.complete(turn('answer'))
    await $.session.end({ reason: 'other', sessionId: SID, resume: { id: SID } })
    await w.clock.settle()
    expect(runsOf(w, LOG)).toEqual([])
  })

  test('a checkpoint that fails never fails the turn or the exit', async ($, on) => {
    const w = memoryWorld(on)
    w.scripts[LOG] = () => new Error('bash is gone')
    await $.session.start(start())
    await $.classic.SessionStart(sessionStart())
    const done = await $.turn.complete(turn('answer'))
    await w.clock.settle()
    expect(done).toEqual({ text: 'done' })
    expect(await $.session.end({ reason: 'other', sessionId: SID, resume: { id: SID } })).toEqual({ sessionId: SID })
  })

  test('after a /clear the next turn checkpoints the new transcript under the new id', async ($, on) => {
    const w = memoryWorld(on)
    w.scripts[LOG] = () => ''
    await $.session.start(start())
    await $.classic.SessionStart(sessionStart())
    await $.session.end({ reason: 'clear', sessionId: SID, resume: { id: SID } })
    w.sid = 'b2c3d4e5-0000-4000-8000-000000000002'
    await $.classic.SessionStart(sessionStart(w.sid, 'clear'))
    await $.turn.complete(turn('answer'))
    await w.clock.settle()
    const payloads = runsOf(w, LOG).map(run => payloadOf(run.stdin))
    expect(payloads.map(payload => [payload.session_id, payload.hook_event_name])).toEqual([
      [SID, 'SessionEnd'],
      [w.sid, 'TurnComplete'],
    ])
    expect(payloads[1]?.transcript_path).toBe(`${HOME}/.claude/projects/-repo/${w.sid}.jsonl`)
  })

  test('the readers', () => {
    expect(checkpointRequest(SID, undefined, 'turn')).toBeUndefined()
    expect(checkpointRequest('', TRANSCRIPT, 'turn')).toBeUndefined()
    expect(checkpointRequest(SID, `/x/${SID}.jsonl.bak`, 'turn')).toBeUndefined()
    expect(checkpointRequest(SID, TRANSCRIPT, 'final', 'other')?.env).toEqual({ WORKBENCH_LOG_MODE: 'final' })
    expect(endTimeoutOf(1500)).toBe(END_MAX_MS)
    expect(endTimeoutOf(400)).toBe(250)
    expect(endTimeoutOf(200)).toBeUndefined()
  })
})
