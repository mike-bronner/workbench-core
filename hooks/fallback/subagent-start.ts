import { OMITS_CLAUDE_MD } from '../mods/prompt-rules.ts'
import { activeSession, emit, hookInput, rulesContext } from './seated.ts'

const input = await hookInput()
const agentType = typeof input.agent_type === 'string' ? input.agent_type : ''
if (activeSession(process.env, input) !== undefined && !OMITS_CLAUDE_MD.has(agentType) && agentType !== 'fork') emit('SubagentStart', rulesContext(process.env))
