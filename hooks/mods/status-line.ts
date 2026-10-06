// The workbench's status line: the request meter, then the workbench facts
// Mike would otherwise learn only by reading a file or a model's reply.
//
//   T14 · $0.21/req · 3.4× first │ mem UP · orch on · rows 38/40 · learnings memory-lint 86 · 2 notices
//
//   mem        the memory server's health, from the identity-checked probe
//   orch       orchestrator mode for this session (/orchestrator)
//   rows       the rows the last reply takes at 80 columns, against the output
//              style's budget of about 40. A meter only: nothing re-prompts.
//   learnings  each skill whose learnings file is past the 30-entry limit,
//              which /workbench-core:compact-learnings compacts
//   notices    the warmup notices outstanding at session start (/notices)
//
// A fact not known yet is left out, so a line never shows a guess. Every figure
// here changes during a session, which is why it lives on the status line and
// never in the system prompt, where a change would re-bill the cached prefix.
//
// Pure functions only: the engine follows `$` into no imported function.

// The output style's reply budget: about 40 rows at 80 columns.
export const ROW_BUDGET = 40
export const COLUMNS = 80
// A learnings file past this many entries is due for compaction.
export const COMPACT_AT = 30

// The meter and the workbench facts, the meter first. Undefined when both are
// empty, which clears the line.
export function lineOf(meter: string | undefined, facts: readonly string[]): string | undefined {
  const workbench = facts.join(' · ')
  if (!meter) return workbench || undefined
  return workbench ? `${meter} │ ${workbench}` : meter
}

export type Facts = {
  memoryHealth?: string
  orchestratorOn?: boolean
  replyRows?: number
  learnings?: Readonly<Record<string, number>>
  notices?: readonly string[]
}

export function factsOf(facts: Facts): string[] {
  const out: string[] = []
  if (facts.memoryHealth) out.push(`mem ${facts.memoryHealth}`)
  if (facts.orchestratorOn !== undefined) out.push(`orch ${facts.orchestratorOn ? 'on' : 'off'}`)
  if (facts.replyRows !== undefined) out.push(`rows ${facts.replyRows}/${ROW_BUDGET}`)
  const due = Object.entries(facts.learnings ?? {}).sort(([a], [b]) => a.localeCompare(b))
  if (due.length > 0) out.push(`learnings ${due.map(([skill, count]) => `${skill} ${count}`).join(', ')}`)
  const notices = facts.notices?.length ?? 0
  if (notices > 0) out.push(notices === 1 ? '1 notice' : `${notices} notices`)
  return out
}

// The rows `text` takes at `columns`: each line one row, and a line longer than
// the width one more row for each width it runs past. Characters are counted
// by code point, so a wide character counts as one column: a floor, not a
// rendering.
export function rowsOf(text: string, columns = COLUMNS): number {
  if (text === '') return 0
  return text.split('\n').reduce((rows, line) => rows + Math.max(1, Math.ceil([...line].length / columns)), 0)
}

// The count scripts/learnings-count.sh printed, or undefined for anything
// that is not a whole number: no learnings file, or a script that failed.
export function countOf(stdout: string): number | undefined {
  const text = stdout.trim()
  return /^[0-9]+$/.test(text) ? Number(text) : undefined
}

// The skills due for compaction after `skill` was counted at `count`.
export function learningsAfter(learnings: Readonly<Record<string, number>>, skill: string, count: number | undefined): Record<string, number> {
  const { [skill]: _, ...rest } = learnings
  return count !== undefined && count > COMPACT_AT ? { ...rest, [skill]: count } : rest
}

// The bare skill name, as hooks/skill-learnings.sh keys the learnings file:
// `workbench-core:memory-lint` and `memory-lint` are one skill. Undefined for
// a name that could leave the vault's skills folder.
export function skillNameOf(skill: string): string | undefined {
  const name = skill.slice(skill.lastIndexOf(':') + 1)
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name) ? name : undefined
}

// The notices in ~/.claude-workbench/warmup-notices.md: the text of each `## `
// heading, which is how session-warmup.sh opens every notice.
export const noticesOf = (markdown: string): string[] =>
  markdown
    .split('\n')
    .filter(line => line.startsWith('## '))
    .map(line => line.slice(3).trim())
    .filter(Boolean)

// The probe's word for the server's health, or undefined for output that is
// not one word.
export function healthOf(stdout: string): string | undefined {
  const word = stdout.trim()
  return /^[A-Z_]+$/.test(word) ? word : undefined
}
