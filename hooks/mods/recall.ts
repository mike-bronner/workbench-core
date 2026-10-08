// Vault recall: memories that bear on what the session is doing, injected at
// the tail of the conversation and never into the system prompt.
//
// Two triggers, as the bash hooks had (hooks/memory-recall.sh on each prompt,
// hooks/memory-scan-recall.sh on each Grep or Bash content search). Those cost
// about 850 tokens and 1.6 s per prompt, and in the Phase 0 sample none of
// their hits was used. So each hit now passes four filters before it is shown:
//
//   1. A score threshold. The server's hybrid score fuses a keyword rank and a
//      semantic rank (reciprocal rank fusion, k = 60): a note one retriever
//      ranks first scores just under 1/61 (0.0158 to 0.0164 measured), the
//      ones after it 0.015 and falling, and a note both retrievers rank near
//      the top scores 0.02 to 0.035. Measured on the live vault 2026-10-07, every hit is labelled
//      `semantic` whichever retrievers ranked it, so the label cannot tell
//      them apart and the score must. A prompt keeps the top hits of either
//      retriever (PROMPT_MIN_SCORE), and the classifier judges them. A scan
//      fires far more often, so it keeps only what both retrievers rank
//      (SCAN_MIN_SCORE), the agreement the bash hook's label gate meant to
//      require. A keyword-only vault scores in BM25 units, far above both,
//      and the classifier is its filter.
//   2. The note types worth recalling (TYPES).
//   3. A per-session dedupe set: a note is shown once per session.
//   4. A relevance pass through $.model.classify, one label per hit. A pass
//      that fails or runs past CLASSIFY_TIMEOUT_MS falls back to the hits the
//      first three filters kept, so a slow classifier never costs a recall.
//
// The search runs through $.mcp.call on the memory server in core's manifest,
// where the bash hooks started the markdown-vault-mcp CLI, about 1 s each.
//
// Pure functions only: the engine follows `$` into no imported function.

export const PROMPT_MIN_SCORE = 0.015
export const SCAN_MIN_SCORE = 0.02
export const PROMPT_LIMIT = 2
export const SCAN_LIMIT = 1
// Hits fetched per hit wanted: the filters drop most of them.
export const FETCH_FACTOR = 4
export const CLASSIFY_TIMEOUT_MS = 2500
export const RELEVANT = 'relevant'
export const UNRELATED = 'unrelated'
export const LABELS = [RELEVANT, UNRELATED] as const
export const TYPES: ReadonlySet<string> = new Set([
  'decision',
  'insight',
  'topic',
  'feedback',
  'reference',
  'project',
  'skill-learnings',
  'recurring-issue',
])

const PROMPT_MIN_CHARS = 16
const SCAN_MIN_CHARS = 6
const QUERY_MAX_CHARS = 500
const SUMMARY_MAX_CHARS = 160
export const TITLE_MAX_CHARS = 100
const PATH_MAX_CHARS = 200

// One line of at most `max` characters: a note's title or summary is the
// vault's text, so a newline in it must not open a line of its own in the
// block the model reads.
export const lineOf = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max)}…` : line
}
const ACKS = /^(y|n|ok|okay|yes|no|yep|nope|sure|thanks|thank you|ty|go|go ahead|do it|continue|proceed|next|done|stop|wait)[.!? ]*$/i

// The search query a prompt carries, or undefined when it carries none: a
// slash command, a scheduled tick, an acknowledgement, or under 16 characters.
// The same substance gate hooks/memory-recall.sh applied.
export function promptQuery(text: string): string | undefined {
  const trimmed = text.replace(/\n/g, ' ').trim()
  if (trimmed.startsWith('/') || trimmed.startsWith('<scheduled-task ')) return undefined
  if (trimmed.length < PROMPT_MIN_CHARS || ACKS.test(trimmed)) return undefined
  return trimmed.slice(0, QUERY_MAX_CHARS)
}

// Whether a Bash command can hold a content search at all, before the
// extractor (hooks/lib/scan-query.py) is started to read it.
export const mayScan = (command: string): boolean => command.includes('grep') || /(^|[^\w-])(rg|ripgrep|ag|ack)([^\w-]|$)/.test(command)

// The query scan-query.py read out of a search, or undefined when it is too
// thin to search on: under 6 characters without spaces, no letter, or one
// plain word. A camelCase identifier is a topic, and passes.
export function scanQuery(extracted: string): string | undefined {
  const query = extracted.trim()
  if (query.replace(/ /g, '').length < SCAN_MIN_CHARS || !/[A-Za-z]/.test(query)) return undefined
  if (!query.includes(' ') && !/[a-z][A-Z]/.test(query)) return undefined
  return query
}

// `searchType` is the server's label for how the hit was found: `keyword`
// when the vault has no embeddings and the search fell back to BM25, whose
// score is in its own units; `semantic` or `hybrid` from a hybrid search, whose
// score is a rank-fusion value. Absent when the server sent none.
export type Hit = { path: string; title: string; type: string; summary: string; score: number; searchType?: string }

// The hits in a memory MCP search result: the text block's JSON, either a list
// or `{ result: [...] }`. Anything else is no hits.
export function hitsOf(content: readonly { type: string; text?: string }[]): Hit[] {
  const text = content.find(block => block.type === 'text' && typeof block.text === 'string')?.text
  if (text === undefined) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const rows = Array.isArray(parsed) ? parsed : (parsed as { result?: unknown } | null)?.result
  if (!Array.isArray(rows)) return []
  const hits: Hit[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const { path, title, score, frontmatter, sections, search_type: searchType } = row as Record<string, unknown>
    if (typeof path !== 'string' || path === '' || typeof score !== 'number') continue
    const fm = (typeof frontmatter === 'object' && frontmatter !== null ? frontmatter : {}) as Record<string, unknown>
    const first = Array.isArray(sections) ? (sections[0] as { content?: unknown } | undefined) : undefined
    const summary = typeof fm.summary === 'string' ? fm.summary : typeof first?.content === 'string' ? first.content : ''
    hits.push({
      path,
      title: lineOf(typeof title === 'string' && title.trim() !== '' ? title : typeof fm.name === 'string' ? fm.name : path, TITLE_MAX_CHARS),
      type: typeof fm.type === 'string' ? fm.type : 'note',
      summary: lineOf(summary, 400),
      score,
      ...(typeof searchType === 'string' ? { searchType } : {}),
    })
  }
  return hits
}

// Filters 1 to 3: the threshold, the types, and the notes this session has
// seen, best first, at most `limit`.
export const candidatesOf = (hits: readonly Hit[], seen: readonly string[], limit: number, minScore: number): Hit[] =>
  hits
    .filter(hit => hit.score >= minScore && TYPES.has(hit.type) && !seen.includes(hit.path))
    .filter((hit, i, all) => all.findIndex(other => other.path === hit.path) === i)
    .slice(0, limit)

// What the classifier reads for one hit: the task, then the note.
export const relevanceText = (task: string, hit: Hit): string =>
  `Would this note from a memory vault help with the task? Answer ${RELEVANT} or ${UNRELATED}.\n\nTask: ${task}\n\nNote: ${hit.title} [${hit.type}] - ${hit.summary.slice(0, 400)}`

// Filter 4: the hits whose label is not UNRELATED. A label that is neither
// keeps its hit, as the fallback does: only a definite "unrelated" drops one.
export const relevantOf = (hits: readonly Hit[], labels: readonly (string | undefined)[]): Hit[] =>
  hits.filter((_, i) => labels[i] !== UNRELATED)

// The one compact block the model reads beside the prompt or the tool result.
export function blockOf(hits: readonly Hit[], scan?: string): string {
  const header =
    scan === undefined
      ? '🧠 Vault recall (verify against current code before acting; these reflect what was true when written):'
      : `🧠 Vault recall for this scan, "${scan.slice(0, 60)}" (verify against current code before acting):`
  const bullets = hits.map(hit => `• ${lineOf(hit.title, TITLE_MAX_CHARS)} [${lineOf(hit.type, 40)}] - ${lineOf(hit.summary, SUMMARY_MAX_CHARS)} (${lineOf(hit.path, PATH_MAX_CHARS)})`)
  return [header, ...bullets].join('\n')
}

// About four characters to a token: the measure the recall figures use.
export const tokensOf = (text: string): number => Math.ceil(text.length / 4)
