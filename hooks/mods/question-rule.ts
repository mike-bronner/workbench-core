// The question rule: every question to Mike goes through AskUserQuestion, with
// its context written in prose immediately above the call.
//
// Mike reads replies in an 80x50 terminal. A question left in prose scrolls
// away, and a dialog with no context right above it cannot be answered without
// scrolling back. The output style states the rule (rule 4).
//
// Pure functions only: the engine follows `$` into no imported function.

export const REPROMPT_REASON =
  'Your reply leaves a question for Mike in prose. Ask it again through ' +
  'AskUserQuestion. Write the context the question needs in prose immediately ' +
  'above the call, in the same message, and do not repeat the rest of the ' +
  'reply. A question with no fixed choices still fits the tool, because the ' +
  'dialog always offers Other.'

export const REFUSAL_REASON =
  'AskUserQuestion was refused: this turn forwards a question a sub-agent ' +
  'handed back, and no prose comes immediately before this call in the same ' +
  'reply. Ask that sub-agent through SendMessage for the context Mike needs ' +
  'to answer. Then write that context in prose directly above the call, and ' +
  'call AskUserQuestion again. He reads in an 80x50 terminal, and a dialog ' +
  'with no context right above it cannot be answered without scrolling back.'

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

export function hasContextBefore(messages: readonly ApiMessage[], id: string | undefined): boolean | undefined {
  if (id === undefined) return undefined
  const blocksOf = (message: ApiMessage | undefined) => (Array.isArray(message?.content) ? message.content : [])
  for (let m = messages.length - 1; m >= 0; m--) {
    const content = blocksOf(messages[m])
    const at = content.findIndex(block => block.type === 'tool_use' && block.id === id)
    if (at === -1) continue
    let before = content.slice(0, at)
    for (let k = m - 1; k >= 0 && messages[k]?.role === 'assistant'; k--) before = [...blocksOf(messages[k]), ...before]
    const shown = before.filter(block => !/thinking$/.test(block.type))
    const last = shown[shown.length - 1]
    return last?.type === 'text' && String(last.text ?? '').trim() !== ''
  }
  return undefined
}

export function shownTextOf(messages: readonly ApiMessage[], id: string | undefined): string | undefined {
  if (id === undefined) return undefined
  const blocksOf = (message: ApiMessage | undefined) => (Array.isArray(message?.content) ? message.content : undefined)
  const textOf = (blocks: readonly ApiBlock[]) => blocks.filter(block => block.type === 'text').map(block => String(block.text ?? ''))
  for (let m = messages.length - 1; m >= 0; m--) {
    const content = blocksOf(messages[m]) ?? []
    const at = content.findIndex(block => block.type === 'tool_use' && block.id === id)
    if (at === -1) continue
    const texts = textOf(content.slice(0, at))
    for (let k = m - 1; k >= 0; k--) {
      const blocks = blocksOf(messages[k])
      if (messages[k]?.role === 'assistant') texts.unshift(...textOf(blocks ?? []))
      else if (blocks === undefined || blocks.some(block => block.type !== 'tool_result')) break
    }
    return texts.join('\n')
  }
  return undefined
}

export const LABEL_REFUSAL =
  'AskUserQuestion was refused: an option label is only a letter, a number, or ' +
  '"Option N". The dialog can cover the reply, so Mike reads each label on its ' +
  'own. Name what each option does in plain words, such as "Keep the current ' +
  'fan rule", and call AskUserQuestion again.'

export const FORWARD_REFUSAL =
  'AskUserQuestion was refused: this turn forwards a decision a sub-agent ' +
  'handed back, and this reply does not render its options. Mike cannot see ' +
  'the hand-back. Render the options in prose above the call first: one table ' +
  'with the columns Option, Pros, Cons, and Grade, with one row per option, ' +
  'then the sentence that names the recommendation and its grade. Then call ' +
  'AskUserQuestion again.'

export const unshownReason = (refs: readonly string[]): string =>
  `AskUserQuestion was refused: the question refers to ${refs.join(', ')}, which ` +
  'the visible text of this reply does not show. Mike sees only that text, ' +
  "never a sub-agent's hand-back. Render it in prose above the call first: the " +
  'options table with the columns Option, Pros, Cons, and Grade, with one row ' +
  'per option, then the sentence that names the recommendation. Then call ' +
  'AskUserQuestion again, with labels that say what each option does.'

type AskOption = { label?: unknown; description?: unknown }
type AskQuestion = { question?: unknown; options?: unknown }

const BARE_LABEL = /^\s*(?:option\s+)?(?:[a-z]|\d+)\s*[.):]?\s*(?:\(recommended\))?\s*$/i
const OPTION_IDS = /\b[Oo]ptions?\s+((?:[A-Z]|\d+)(?:\s*(?:,|\/|\+|&|or|and)\s*(?:[A-Z]|\d+)\b)*)(?![\w'’])/g
const LETTER_IDS = /(?<![\w'’])[A-E](?:\s*(?:\+|\/|&|,|or|and)\s*[A-E](?![\w'’]))+/g
const TABLE_REF = /\b(?:the|that|this|its|his|their)\s+(?:options\s+)?table\b|\btable\s+(?:above|below)\b/i
const GRADE_REF = /\b(?:the|those|its|his|their)\s+grades\b|\bas\s+graded\b/i
const AGENT_REF =
  /\b(?:Watson|Holmes|Lestrade|sub-?agent|agent|reviewer)(?:['’]s)?\s+(?:own\s+)?(?:options?|proposals?|alternatives|choices)\b|\boptions?\s+(?:that\s+)?(?:Watson|Holmes|Lestrade|the\s+sub-?agent|the\s+agent)\s+(?:proposed|gave|suggested|returned|handed\s+back|graded)\b/i
const GRADE = /\b(?:all|partly|not)\s+met\b/i

const optionsOf = (question: AskQuestion): AskOption[] => (Array.isArray(question?.options) ? (question.options as AskOption[]) : [])

const textsOf = (question: AskQuestion): string[] =>
  [question?.question, ...optionsOf(question).flatMap(option => [option?.label, option?.description])].filter(
    (text): text is string => typeof text === 'string',
  )

const isItemFor = (shown: string, id: string): boolean =>
  new RegExp(`^[ \\t]*(?:\\|[ \\t]*)?(?:[-*+][ \\t]+|#{1,6}[ \\t]+)?(?:\\*\\*|__)?(?:[Oo]ption[ \\t]+)?${id}(?:\\*\\*|__)?[ \\t]*(?:[:.)|]|\\*\\*|[ \\t]+[-–—])`, 'm').test(shown)

function tableRowsOf(shown: string, isGraded: boolean): number {
  const lines = shown.split('\n').map(line => line.trim())
  let best = 0
  lines.forEach((line, at) => {
    if (!/^\|.*\|$/.test(line) || !/^\|?\s*:?-{3,}/.test(lines[at + 1] ?? '')) return
    if (isGraded && !/\|\s*Grade\s*\|/i.test(line)) return
    let rows = 0
    while (/^\|.*\|$/.test(lines[at + 2 + rows] ?? '')) rows++
    best = Math.max(best, rows)
  })
  return best
}

export function unshownOf(questions: unknown, shown: string, isForwarding: boolean): string | undefined {
  if (!Array.isArray(questions)) return undefined
  const asked = questions as AskQuestion[]
  if (asked.some(question => optionsOf(question).some(option => typeof option?.label === 'string' && BARE_LABEL.test(option.label)))) return LABEL_REFUSAL
  const text = asked.flatMap(textsOf).join('\n')
  const ids = [...text.matchAll(OPTION_IDS)].flatMap(match => (match[1] ?? '').match(/[A-Z]|\d+/g) ?? [])
  const letters = [...text.matchAll(LETTER_IDS)].flatMap(match => match[0].match(/[A-E]/g) ?? [])
  const refs = [...new Set([...ids, ...letters])].filter(id => !isItemFor(shown, id)).map(id => `option ${id}`)
  if (TABLE_REF.test(text) && tableRowsOf(shown, false) === 0) refs.push('a table')
  if ((GRADE_REF.test(text) || AGENT_REF.test(text)) && tableRowsOf(shown, true) === 0) refs.push("a sub-agent's graded options")
  if (refs.length > 0) return unshownReason(refs)
  const isDecision = (question: AskQuestion) => {
    const options = optionsOf(question)
    return options.length >= 3 || options.some(option => typeof option?.description === 'string' && GRADE.test(option.description))
  }
  const decisions = asked.filter(isDecision)
  if (!isForwarding || decisions.length === 0) return undefined
  const isRendered = decisions.every(question => tableRowsOf(shown, true) >= optionsOf(question).length) && /\brecommend/i.test(shown)
  return isRendered ? undefined : FORWARD_REFUSAL
}

const DECISION = /\b(decide|decision|decisions|choose|must pick|blocked on|needs? (your|mike's|his) (call|answer|input|pick))\b/i

const asksMike = (handBack: string): boolean => {
  const text = handBack.replace(/(```|~~~)[\s\S]*?(\1|$)/g, '').replace(/`[^`\n]*`/g, '')
  return hasCandidate(text) || DECISION.test(text) || tableRowsOf(handBack, true) > 0
}

export function notificationForwards(text: string): boolean {
  const start = text.indexOf('<result>')
  if (start === -1) return false
  const end = text.lastIndexOf('</result>')
  return asksMike(text.slice(start + '<result>'.length, end > start ? end : undefined))
}

export function agentResultForwards(result: unknown): boolean {
  const content = (result as { content?: unknown } | null | undefined)?.content
  if (!Array.isArray(content)) return true
  const texts = (content as ApiBlock[]).filter(block => block?.type === 'text').map(block => String(block.text ?? ''))
  return asksMike(texts.join('\n'))
}
