import { mkdirSync, writeFileSync } from 'node:fs'

import { repromptFileOf } from '../mods/fallback.ts'
import { isScheduledFire } from '../mods/lane.ts'
import { activeSession, hookInput, isAttended, readIfAny } from './gate.ts'

type Line = { type?: unknown; uuid?: unknown; message?: { content?: unknown } }

const promptTextOf = (content: unknown): string | undefined => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content) || content.some(part => (part as { type?: unknown })?.type === 'tool_result')) return undefined
  return content.map(part => ((part as { text?: unknown })?.text === undefined ? '' : String((part as { text?: unknown }).text))).join('\n')
}

function lastPromptOf(transcript: string): { uuid: string; text: string } | undefined {
  const rows = transcript.split('\n')
  for (let i = rows.length - 1; i >= 0; i--) {
    let line: Line
    try {
      line = JSON.parse(rows[i] ?? '') as Line
    } catch {
      continue
    }
    if (line?.type !== 'user' || typeof line.uuid !== 'string') continue
    const text = promptTextOf(line.message?.content)
    if (text !== undefined) return { uuid: line.uuid, text }
  }
  return undefined
}

const input = await hookInput()
const sessionId = activeSession(process.env, input)
const file = sessionId === undefined ? undefined : repromptFileOf(process.env.HOME, sessionId)
const isOurs = file !== undefined && isAttended(process.env) && !input.agent_id && !input.agent_type && input.stop_hook_active !== true
const transcript = isOurs && typeof input.transcript_path === 'string' ? readIfAny(input.transcript_path) : undefined
const turn = transcript === undefined ? undefined : lastPromptOf(transcript)
if (file !== undefined && turn !== undefined && !isScheduledFire(turn.text) && readIfAny(file) !== turn.uuid) {
  const { REPROMPT_REASON, endsOnQuestion, hasCandidate, proseOf } = await import('../mods/question-rule.ts')
  const prose = proseOf(typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '')
  if (hasCandidate(prose) && endsOnQuestion(prose)) {
    mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true })
    writeFileSync(file, turn.uuid)
    process.stdout.write(JSON.stringify({ decision: 'block', reason: REPROMPT_REASON }))
  }
}
