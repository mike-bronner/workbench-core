// workbench-core's hooks module, beside the command hooks in hooks.json. The
// command hooks stay registered: the guards move here only after parity.
//
//   question rule   every question to Mike goes through AskUserQuestion, with
//                   its context in prose right above the call
//   request meter   turns, and each API request's cost, on the status line
//
// The logic is pure and lives in mods/. Every hook that touches `$` lives in
// this file, because the engine follows `$` into no imported function, and a
// plugin registers each event once.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { isAttendedPrompt, isAttendedSession } from './mods/lane'
import {
  ASKS_NOTHING,
  ASKS_USER,
  LABELS,
  REFUSAL_REASON,
  REPROMPT_REASON,
  classifierText,
  endsOnQuestion,
  hasCandidate,
  hasContextBefore,
  proseOf,
} from './mods/question-rule'
import { EMPTY, countRequest, countTurn, statusOf } from './mods/request-meter'

const meter = atom({ plugin: 'workbench-core', key: 'meter' } as const, EMPTY)
// Whether a person opened the current turn, so the question rule applies.
const turnAttended = atom({ plugin: 'workbench-core', key: 'turnAttended' } as const, false)
// Whether the question rule already re-prompted in the current turn.
const reprompted = atom({ plugin: 'workbench-core', key: 'reprompted' } as const, false)

// Whether a finished reply leaves a question for Mike in prose. A classifier
// that fails, or answers with neither label, falls back to the deterministic
// reading, so a question is never let through only because the classifier
// could not answer.
async function asksInProse($: EngineInterface, reply: string): Promise<boolean> {
  const prose = proseOf(reply)
  if (!hasCandidate(prose)) return false
  try {
    const label = await $.model.classify(classifierText(prose), LABELS)
    if (label === ASKS_USER) return true
    if (label === ASKS_NOTHING) return false
  } catch {
    // The deterministic reading below decides.
  }
  return endsOnQuestion(prose)
}

export const register: Register = on => {
  // Set at every load, because a reload runs session.start again. Unknown
  // reads as unattended until then.
  let isSessionAttended = false

  on('session.start', async ($, e, next) => {
    isSessionAttended = isAttendedSession(
      e.isInteractive,
      await $.env.get('CLAUDE_CODE_AGENT'),
      await $.env.get('WORKBENCH_DEV_TEAM_PIPELINE'),
    )
    // A reload keeps $.state, so the meter is drawn again from it.
    const state = await read($, meter)
    if (state.turns > 0) $.ui.status(statusOf(state))
    return next(e)
  })

  // A prompt folded into a running turn carries turnId and opens no turn.
  on('prompt.submit', async ($, e, next) => {
    if (e.turnId === undefined) {
      await update($, turnAttended, () => isAttendedPrompt(e.origin, e.text))
      await update($, reprompted, () => false)
    }
    return next(e)
  })

  // One correction turn at most: the engine's stop_hook_active flag, and the
  // per-turn flag the next prompt clears. A synchronous block from a Stop hook
  // beneath, such as another plugin's, stands alone, so two re-prompts never
  // stack. The memory checkpoint is not one: hooks.json registers it with
  // asyncRewake, so it runs in the background after this chain has settled and
  // never shows here as a block. A turn this hook re-prompts can therefore
  // also get a checkpoint wake later. That wake arrives with stop_hook_active
  // set, so its own stop is never re-prompted.
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    const isOurs =
      isSessionAttended &&
      !e.agent_id &&
      !e.agent_type &&
      !e.stop_hook_active &&
      result.block === undefined &&
      (await read($, turnAttended)) &&
      !(await read($, reprompted))
    if (!isOurs || !(await asksInProse($, e.last_assistant_message ?? ''))) return result
    await update($, reprompted, () => true)
    return { ...result, block: REPROMPT_REASON }
  })

  // A call no message holds (another plugin's $.ui.ask) is let through: there
  // is no message to read the context from.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (e.agentId !== undefined || !isSessionAttended || !(await read($, turnAttended))) return next(e)
    const messages = await $.session.messages({ as: 'api' })
    return hasContextBefore(messages, e.tool_use_id) === false ? { deny: REFUSAL_REASON } : next(e)
  })

  // Each main-loop API request, priced from its own usage once the response is
  // whole. A sub-agent's request carries agentId. A step with no usage got no
  // response, so the line keeps the last request.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const usage = result.usage
    if (e.agentId === undefined && usage !== null) {
      $.ui.status(statusOf(await update($, meter, state => countRequest(state, usage))))
    }
    return result
  })

  // T counts completed main-loop turns.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) $.ui.status(statusOf(await update($, meter, countTurn)))
    return result
  })

  // A /clear starts the conversation over, so the meter starts over with it.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, meter, () => EMPTY)
      $.ui.status(undefined)
    }
    return next(e)
  })
}
