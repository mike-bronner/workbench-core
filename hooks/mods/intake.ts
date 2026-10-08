// The intake nudge: on the first Edit of a task in Mike's session, a reminder
// to show the intake block (skills/intake/SKILL.md) when none is on screen.
// It never denies. It replaces hooks/intake-nudge.sh, which read the
// transcript file and kept its own state file per session.
//
// A task is what one prompt Mike sends starts. The nudge is checked once per
// task, tracked in $.state by hooks/register.ts, and fires only when no
// heading naming Intake is on screen: in this task's replies so far, or in the
// closing reply of the turn before the prompt, where an intake block shown
// for Mike's answer sits.
//
// Pure functions only: the engine follows `$` into no imported function.

import type { SessionMessage } from 'claude-code'

export const NUDGE =
  '📋 Intake nudge (advisory, nothing was blocked): this is the first Edit for the current task, and no intake block is on screen for it. Before more work, run /workbench-core:intake: show the goal, the context, and the acceptance criteria you are working to, under a heading that names Intake. If the task is trivial, carry on without it.'

const HEADING = /(^|\n)[ \t]*#{1,6}[ \t]+[^\n]*\bintake\b/i

const isPrompt = (message: SessionMessage): boolean =>
  message.role === 'user' && (message.toolResults === undefined || message.toolResults.length === 0) && message.text.trim() !== ''

// Whether an intake heading is on screen for the task the last prompt opened.
// It reads the replies after that prompt, and the replies before it back to
// the last message with a tool call or result, as far as the prompt before.
export function intakeShown(messages: readonly SessionMessage[]): boolean {
  let at = messages.length - 1
  while (at >= 0 && !isPrompt(messages[at] as SessionMessage)) at -= 1
  if (at < 0) return false
  const seen = messages.slice(at + 1).filter(message => message.role === 'assistant')
  const closing: SessionMessage[] = []
  for (let i = at - 1; i >= 0; i -= 1) {
    const message = messages[i] as SessionMessage
    if (isPrompt(message) || message.toolUses.length > 0 || (message.toolResults?.length ?? 0) > 0) break
    if (message.role === 'assistant') closing.push(message)
  }
  return [...closing, ...seen].some(message => HEADING.test(message.text))
}
