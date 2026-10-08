// The session log checkpoint, written as the session runs instead of only when
// it ends.
//
// SessionEnd does not fire on a reboot or a kill, the Stop hook does not fire
// on an interrupted turn, and every SessionEnd hook shares one 1.5 s budget.
// So hooks/register.ts runs hooks/session-log.sh after each main-loop turn,
// answered or interrupted (turn.complete), and at session.end, which also
// fires on SIGHUP and SIGTERM. session-log.sh stays the one writer of the raw
// log, the log-checkpoints/<sid>.json `next_line`, and the pending-summary
// marker, so the turn checkpoint, the settings SessionEnd hook and the
// start-up reconciler read and advance one checkpoint and never log a line
// twice. Its per-session lock serializes the writers that overlap.
//
// Pure functions only: the engine follows `$` into no imported function.

export type CheckpointMode = 'turn' | 'final'

export type CheckpointRequest = { stdin: string; env: Record<string, string> }

// What session-log.sh is run with for one checkpoint: its payload on stdin,
// shaped like a hook's, and the mode in WORKBENCH_LOG_MODE. Undefined when the
// transcript is unknown or names another session: a checkpoint never copies a
// file it cannot tie to the session id.
export function checkpointRequest(
  sessionId: string,
  transcript: string | undefined,
  mode: CheckpointMode,
  reason?: string,
): CheckpointRequest | undefined {
  if (transcript === undefined || sessionId === '' || !transcript.endsWith(`/${sessionId}.jsonl`)) return undefined
  const payload = {
    session_id: sessionId,
    transcript_path: transcript,
    hook_event_name: mode === 'turn' ? 'TurnComplete' : 'SessionEnd',
    ...(reason === undefined ? {} : { reason }),
  }
  return { stdin: JSON.stringify(payload), env: { WORKBENCH_LOG_MODE: mode } }
}

// How long the session.end checkpoint may run: what the exit budget has left,
// less a margin for the hooks after it, and never past END_MAX_MS. Undefined
// when too little is left to start one.
export const END_MAX_MS = 1200
export function endTimeoutOf(remainingMs: number): number | undefined {
  const ms = Math.min(END_MAX_MS, Math.floor(remainingMs) - 150)
  return ms >= 100 ? ms : undefined
}
