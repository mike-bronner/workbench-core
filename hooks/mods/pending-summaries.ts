// /process-pending-summaries: drain the pending session summaries, or summarize
// one session by id, with no model turn. scripts/process-pending-summaries.sh
// does the work through hooks/lib/summary-dispatch.sh, the helper the session
// warmup drains with, and prints one `result=` line. hooks/register.ts runs it
// and reports through a toast.
//
// It replaces the process-pending-summaries skill, which spent a model turn to
// run the same steps. It asks nothing: memory-vault work is never Mike's to
// answer (vault: feedback/memory-vault-activity-fully-transparent). The script
// redoes a summary only when the session's log is newer than it.
//
// Pure functions only: the engine follows `$` into no imported function.

export const NAME = 'process-pending-summaries'

export const REFUSAL = `/${NAME} runs only when Mike types it. A run from a plugin, a schedule or an agent dispatches nothing.`
export const USAGE = `Usage: /${NAME} [<session-id> [--overwrite]]`

export type Request = { sid?: string; overwrite: boolean }

// The command's arguments: nothing, or a session id and an optional
// --overwrite. Undefined for anything else.
export function requestOf(args: string): Request | undefined {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const overwrite = words.includes('--overwrite')
  const rest = words.filter(word => word !== '--overwrite')
  if (rest.length > 1 || (rest.length === 0 && overwrite)) return undefined
  return { sid: rest[0], overwrite }
}

// The script's `result=` line, as fields. A run that printed none answers
// `{ result: 'failed' }`.
export function outcomeOf(stdout: string): Record<string, string> {
  const line = stdout.split('\n').find(row => row.startsWith('result=')) ?? 'result=failed'
  const fields: Record<string, string> = {}
  for (const pair of line.trim().split(' ')) {
    const at = pair.indexOf('=')
    if (at > 0) fields[pair.slice(0, at)] = pair.slice(at + 1)
  }
  return fields
}

// What the toast says for an outcome. The drain reports all four numbers: a
// run that dispatched none must not read like one that dispatched ten, and the
// dead count is the backlog's health signal.
export function reportOf(outcome: Record<string, string>, sid?: string): string {
  switch (outcome.result) {
    case 'none':
      return 'No pending session summaries.'
    case 'drained': {
      const { dispatched = '0', live = '0', dead = '0', total = '0' } = outcome
      const rerun = live !== '0' ? ` Run /${NAME} again to continue.` : ''
      return `Dispatched ${dispatched} background summary-writers. ${live} live markers remaining, ${dead} unprocessable (log and transcript both gone), ${total} total.${rerun}`
    }
    case 'invalid-id':
      return 'A session id holds only letters, digits and -.'
    case 'unrecoverable':
      return `Session ${sid} has no log and no transcript left, so it cannot be summarized.`
    case 'dispatched':
      return `A summary-writer is running for session ${sid}.`
    case 'current':
      return `The summary for session ${sid} is newer than its log, so it was kept.`
    case 'busy':
      return `A summary-writer is already summarizing session ${sid}.`
    case 'unavailable':
      return `Summaries cannot be dispatched: ${outcome.reason ?? 'a prerequisite'} is not available.`
    default:
      return 'The summary dispatch failed. See summary-dispatch-errors.log in the memory cache.'
  }
}
