// The memory capture checkpoint: the live session's durable findings, written
// to the vault while the session still holds the context that formed them.
//
// It replaces hooks/memory-capture-stop.sh, an asyncRewake Stop hook that woke
// the model with a new turn Mike saw ("Memory capture checkpoint"). Vault work
// must be invisible to him (vault: feedback/memory-vault-activity-fully-
// transparent), so the question now goes to $.model.fork: one tool-less
// completion over the session's own transcript, served from the prompt cache,
// whose answer no one sees. hooks/register.ts writes each note it returns
// through $.mcp.call, never as a turn.
//
// The fire policy is the old hook's, measured over 467 transcripts of this
// project: the first capture on the 5th main-loop turn (88% of sessions reach
// it), then every 40th, for findings that form late in a long session. Both
// are overridable as before. The reply may hold nothing, and usually should:
// a manufactured memory is worse than none.
//
// Pure functions only: the engine follows `$` into no imported function.

import { TITLE_MAX_CHARS, lineOf } from './recall'

export const FIRST = 5
export const REPEAT = 40
// At most this many notes per capture, so one confused reply cannot flood the
// vault.
export const MAX_NOTES = 3

// A capture threshold from its environment variable: a positive integer, else
// the default, as the bash hook clamped it.
export function thresholdOf(value: string | undefined, fallback: number): number {
  const n = value !== undefined && /^[0-9]+$/.test(value) ? Number(value) : NaN
  return Number.isInteger(n) && n >= 1 ? n : fallback
}

// Whether the turn just counted fires a capture. `count` includes this turn
// and restarts at each fire, so the threshold is REPEAT once one has fired.
export const isCaptureDue = (count: number, hasFired: boolean, first: number, repeat: number): boolean =>
  count >= (hasFired ? repeat : first)

// The note types a capture may write, and the folder each one goes in
// (references/vault-conventions.md, "Vault structure").
export const FOLDERS: Readonly<Record<string, string>> = {
  decision: 'decisions',
  insight: 'insights',
  feedback: 'feedback',
  project: 'projects',
}

// The question the fork answers. Written for a reply nobody reads but this
// module: JSON or the word NONE.
export function capturePrompt(written: readonly string[]): string {
  const already =
    written.length > 0 ? `\nThese notes were already written by an earlier checkpoint of this session, so leave out what they hold:\n${written.map(path => `- ${path}`).join('\n')}\n` : ''
  return `Memory capture checkpoint. This is an automatic background question from the workbench-core plugin, not from the user, and your answer is never shown to anyone.

List the durable knowledge from this session so far that the memory vault does not hold yet: a decision and its rationale, a root cause, a non-obvious insight or gotcha, a correction to how to work, or a project outcome. Leave out anything this session already wrote to the vault, routine code edits, facts the repo or git already holds, and chatter.
${already}
Link another vault note by its path, as [display text](/folder/file-stem.md), never as [[name]].

If nothing qualifies, answer with the single word NONE. That is the expected answer for most checkpoints: a manufactured memory is worse than none.

Otherwise answer with a JSON array and nothing else, at most ${MAX_NOTES} items, each:
{"type": "decision" | "insight" | "feedback" | "project", "slug": "kebab-case-file-name", "name": "Short title", "summary": "One sentence.", "tags": ["tag"], "body": "The note in Markdown: what, why, and how to apply it."}`
}

export type CaptureNote = {
  path: string
  content: string
  frontmatter: { name: string; type: string; date: string; summary: string; tags: string[] }
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

// The notes in a fork's reply, each checked field by field, with the path
// built here from the type, the date and the slug: the reply is model output,
// so it never names a path, a folder or a frontmatter field of its own. An
// item that fails any check is left out. NONE, an empty reply, and anything
// that is not a JSON array give no notes.
export function notesOf(reply: string, date: string): CaptureNote[] {
  const text = reply.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  if (!text.startsWith('[')) return []
  let items: unknown
  try {
    items = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(items)) return []
  const notes: CaptureNote[] = []
  const paths = new Set<string>()
  for (const item of items) {
    if (notes.length >= MAX_NOTES) break
    if (typeof item !== 'object' || item === null) continue
    const { type, slug, name, summary, tags, body } = item as Record<string, unknown>
    if (typeof type !== 'string' || !Object.hasOwn(FOLDERS, type)) continue
    if (typeof slug !== 'string' || !SLUG.test(slug) || slug.length > 80) continue
    if (!isLine(name, 120) || !isLine(summary, 400) || !isText(body, 20_000)) continue
    const tagList = Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string' && SLUG.test(tag)).slice(0, 8) : []
    const path = `${FOLDERS[type]}/${date}-${slug}.md`
    if (paths.has(path)) continue
    paths.add(path)
    notes.push({
      path,
      content: (body as string).trim(),
      frontmatter: { name: (name as string).trim(), type, date, summary: (summary as string).trim(), tags: tagList },
    })
  }
  return notes
}

const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= max
// A frontmatter value on one line: a newline in a name or summary would break
// the note's frontmatter and every listing that shows it.
const isLine = (value: unknown, max: number): value is string => isText(value, max) && !/[\r\n]/.test(value)

// Whether the server's answer to a `read` is a definite "no note there", the
// one answer a capture writes after. The server words it "Document not found:
// '<path>'", a prefix its own docs say callers match on, and only that prefix
// counts. Any other error (the server down, a refusal) leaves the note
// unwritten.
export const isNotFound = (result: { isError: boolean; content: readonly { type: string; text?: string }[] }): boolean =>
  result.isError && result.content.some(block => typeof block.text === 'string' && /^Document not found:/.test(block.text.trimStart()))

// A score at or above this is a note both retrievers rank first, close to the
// most a hybrid search scores (2/61). Measured on the live vault 2026-10-07: a
// note both rank near the top scores 0.02 to 0.035, one retriever alone at most
// about 0.016.
//
// It reads only hybrid-search scores. The search passes no mode, so a vault
// with no embeddings (a fresh install, or a failed embeddings build) answers
// with keyword search, whose BM25 scores are well above 1: the rule would then
// call every note a duplicate. Such hits are labelled `keyword`. A hybrid
// search labels its hits `semantic` or `hybrid`, and on this server every hit
// is labelled `semantic` whichever retrievers ranked it (measured 2026-10-07),
// so a gate on the `hybrid` label alone would never apply the rule. A hit with
// no label is not scored either.
//
// The label alone cannot tell a fused score from a raw one: a vault configured
// with DEFAULT_SEARCH_MODE=semantic answers with cosine-like similarities,
// labelled `semantic` too, and most notes score far above 0.032 there. So the
// score counts only inside the fusion range, below RRF_CEILING. A fused score
// cannot reach it: two first ranks give 2/61, about 0.033, and folder weights
// measured on the live vault lift that to 0.035 at most. A higher score is
// read as not fused, and the note is matched by name and slug alone.
export const DUPLICATE_SCORE = 0.032
export const RRF_CEILING = 0.1
const FUSED: ReadonlySet<string> = new Set(['hybrid', 'semantic'])

export type DuplicateHit = { path: string; title: string; score: number; searchType?: string }

// Why the vault already holds the note a capture would write, by a search on
// its name: a note with the same name, the same slug, or one both retrievers
// rank first for that name (another session may have saved it). Undefined when
// it holds none. The name is cut to one line and capped as recall caps a hit's
// title, so a long name still matches its own note.
export function duplicateOf(note: CaptureNote, hits: readonly DuplicateHit[]): string | undefined {
  const name = lineOf(note.frontmatter.name, TITLE_MAX_CHARS).toLowerCase()
  const slug = note.path.replace(/^.*\/\d{4}-\d{2}-\d{2}-|\.md$/g, '')
  for (const hit of hits) {
    const stem = hit.path.replace(/^.*\//, '').replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '')
    if (lineOf(hit.title, TITLE_MAX_CHARS).toLowerCase() === name) return `same name as ${hit.path}`
    if (stem === slug) return `same slug as ${hit.path}`
    const isFused = hit.searchType !== undefined && FUSED.has(hit.searchType) && hit.score < RRF_CEILING
    if (isFused && hit.score >= DUPLICATE_SCORE) return `ranked first by both retrievers: ${hit.path}`
  }
  return undefined
}

// The one line that tells Mike notes were saved: a toast, never a turn.
export const savedText = (paths: readonly string[]): string =>
  `Memory checkpoint saved ${paths.length === 1 ? 'a note' : `${paths.length} notes`} to the vault: ${paths.join(', ')}.`
