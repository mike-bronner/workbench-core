// The question rule: every question to Mike goes through AskUserQuestion, with
// its context written in prose immediately above the call.
//
// Mike reads replies in an 80x50 terminal. A question left in prose scrolls
// away, and a dialog with no context right above it cannot be answered without
// scrolling back. The output style states the rule (rule 4). hooks/register.ts
// enforces its two halves with the functions below:
//
//   classic.Stop             A reply that leaves a question in prose gets one
//                            correction turn: the stop is blocked with a reason
//                            that tells the model to re-ask through the tool.
//   tool.call                An AskUserQuestion call with no prose immediately
//   (AskUserQuestion)        before it, in the same message, is refused.
//
// Pure functions only: the engine follows `$` into no imported function.

export const REPROMPT_REASON =
  'Your reply leaves a question for Mike in prose. Ask it again through ' +
  'AskUserQuestion. Write the context the question needs in prose immediately ' +
  'above the call, in the same message, and do not repeat the rest of the ' +
  'reply. A question with no fixed choices still fits the tool, because the ' +
  'dialog always offers Other.'

export const REFUSAL_REASON =
  'AskUserQuestion was refused: no prose comes immediately before this call ' +
  'in the same message. Write the context Mike needs to answer first, in ' +
  'prose directly above the call, then call AskUserQuestion again. He reads ' +
  'in an 80x50 terminal, and a dialog with no context right above it cannot ' +
  'be answered without scrolling back.'

// The labels the classifier picks from. Each one names its meaning, because
// the classifier reads the labels and the text, and nothing else.
export const ASKS_USER = 'asks-the-user-to-answer-or-decide'
export const ASKS_NOTHING = 'asks-the-user-nothing-or-only-rhetorically'
export const LABELS = [ASKS_USER, ASKS_NOTHING] as const

// Phrases that ask without a question mark. They only decide whether the
// classifier runs. The classifier decides whether the reply asks.
const REQUEST =
  /\b(let me know|tell me|do you want|would you like|should i|shall i|which (one|option)|your call|up to you|please (choose|pick|decide|confirm|advise))\b/i

// Text Mike did not get asked: fenced code, inline code, quoted lines, and
// double-quoted spans. A question inside them is shown, not asked. A fence
// left open runs to the end of the reply, as Markdown renders it.
export const proseOf = (reply: string): string =>
  reply
    .replace(/(```|~~~)[\s\S]*?(\1|$)/g, '')
    .replace(/`[^`\n]*`/g, '')
    .replace(/^ {0,3}>.*$/gm, '')
    .replace(/"[^"\n]*"|“[^”\n]*”/g, '')

export const hasCandidate = (prose: string): boolean => prose.includes('?') || REQUEST.test(prose)

// What the classifier reads: the reply's prose, its tail when it is long.
export const classifierText = (prose: string): string =>
  `The final message of an assistant's reply to its user:\n\n${prose.slice(-6000)}`

// The deterministic reading, used only when the classifier cannot answer: the
// last line of prose ends with a question mark.
export function endsOnQuestion(prose: string): boolean {
  const lines = prose.split('\n').map(line => line.trim()).filter(Boolean)
  return /\?[*_)\]\s]*$/.test(lines[lines.length - 1] ?? '')
}

type ApiBlock = { type: string; [field: string]: unknown }
type ApiMessage = { role: string; content: readonly ApiBlock[] }

// Whether prose comes immediately before the tool_use `id`, in the message
// that made it. Thinking blocks are skipped, because Mike never sees them.
// Undefined when no message holds the call, such as an AskUserQuestion another
// plugin raised through $.ui.ask.
export function hasContextBefore(messages: readonly ApiMessage[], id: string | undefined): boolean | undefined {
  if (id === undefined) return undefined
  for (let m = messages.length - 1; m >= 0; m--) {
    const content = messages[m]?.content ?? []
    const at = content.findIndex(block => block.type === 'tool_use' && block.id === id)
    if (at === -1) continue
    const before = content.slice(0, at).filter(block => !/thinking$/.test(block.type))
    const last = before[before.length - 1]
    return last?.type === 'text' && String(last.text ?? '').trim() !== ''
  }
  return undefined
}
