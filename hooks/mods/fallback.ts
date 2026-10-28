export type ModHook = 'session-start' | 'subagent-start' | 'prompt-compose'

const isSessionId = (sessionId: string): boolean => /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(sessionId)

export function sessionDirOf(home: string | undefined, sessionId: string): string | undefined {
  if (!home || !home.startsWith('/') || !isSessionId(sessionId)) return undefined
  return `${home.replace(/\/+$/, '')}/.claude-workbench/mod-ran/${sessionId}`
}

export function markerOf(home: string | undefined, sessionId: string, hook: ModHook): string | undefined {
  const dir = sessionDirOf(home, sessionId)
  return dir === undefined ? undefined : `${dir}/${hook}`
}

export function transcriptFileOf(home: string | undefined, sessionId: string): string | undefined {
  if (!home || !home.startsWith('/') || !isSessionId(sessionId)) return undefined
  return `${home.replace(/\/+$/, '')}/.claude-workbench/fallback-transcripts/${sessionId}`
}

const workbenchFileOf = (home: string | undefined, folder: string, name: string): string | undefined =>
  !home || !home.startsWith('/') ? undefined : `${home.replace(/\/+$/, '')}/.claude-workbench/${folder}/${name}`

export const repromptFileOf = (home: string | undefined, sessionId: string): string | undefined =>
  isSessionId(sessionId) ? workbenchFileOf(home, 'fallback-reprompted', sessionId) : undefined

export const doorbellFileOf = (home: string | undefined): string | undefined => workbenchFileOf(home, 'fallback-doorbell', 'rung')
