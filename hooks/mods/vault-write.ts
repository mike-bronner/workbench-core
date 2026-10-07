// Write-time checks on the memory vault: what reaches the memory MCP's write,
// edit and append tools carries a vault-relative path, valid frontmatter on a
// new note, and path links rather than [[name]] links.
//
// Each rule is prose in the references (vault-conventions.md for the path and
// the frontmatter, linking-synthesis.md for the links, and
// agents/summary-writer.md for the path again), and each is broken often
// enough that memory-lint carries a repair step for it: a frontmatter rescue
// for notes without `name` or `type`, and 250 to 450 broken links a run.
// hooks/register.ts applies the functions below on tool.call:
//
//   path         A `memory/` prefix is dropped. An absolute path inside the
//                vault is made relative, and one outside it is refused.
//   frontmatter  A new note needs a non-empty `name` and a `type` from TYPES.
//                The refusal names the field.
//   links        [[target]] and [[target|text]] become [text](/folder/target.md)
//                when the target resolves to one note. One that does not is
//                left as written, and the write goes on.
//
// A fix goes through as a rewrite of the call, because a refusal costs a model
// turn. Only what cannot be fixed safely is refused. The checks govern what a
// vault note contains, never which tool writes it.
//
// Pure functions only: the engine follows `$` into no imported function.

// The memory MCP's tools, as the engine names them: plugin.json's `memory`
// server in the workbench-core plugin.
export const VAULT_TOOL_PREFIX = 'mcp__plugin_workbench-core_memory__'

export type VaultTool = 'write' | 'edit' | 'append'

export function vaultToolOf(tool: string): VaultTool | undefined {
  if (!tool.startsWith(VAULT_TOOL_PREFIX)) return undefined
  const name = tool.slice(VAULT_TOOL_PREFIX.length)
  return name === 'write' || name === 'edit' || name === 'append' ? name : undefined
}

// The argument each tool carries its markdown in.
export const TEXT_FIELD: Record<VaultTool, 'content' | 'new_text'> = { write: 'content', edit: 'new_text', append: 'content' }

// The vault's fixed list of note types (references/vault-conventions.md). It
// holds every type a workbench skill or agent writes.
export const TYPES: readonly string[] = [
  'session',
  'decision',
  'topic',
  'identity',
  'project',
  'insight',
  'skill-learnings',
  'index',
  'maintenance',
  'infrastructure',
  'feedback',
  'reference',
  'proposal',
  'learnings',
]

export const PATH_REFUSAL =
  'This vault write was refused: its path is absolute, or climbs out with ' +
  '`..`, and does not lie inside the memory vault. Pass a path relative to ' +
  'the vault root, such as ' +
  '`sessions/2026-04-09/<session-id>.summary.md`.'

export const isNote = (path: string): boolean => path.toLowerCase().endsWith('.md')

export type PathFix = { path: string } | { refusal: string }

// The vault-relative form of `path`. `root` is the vault root, or undefined
// when it could not be read: an absolute path is then refused, because it
// cannot be shown to lie inside the vault. `home` expands a leading `~/`.
export function fixPath(path: string, root: string | undefined, home: string | undefined): PathFix {
  let fixed = path.replace(/^(\.\/)+/, '')
  if (fixed.startsWith('~/') && home) fixed = `${home.replace(/\/+$/, '')}${fixed.slice(1)}`
  if (fixed.startsWith('/') || fixed.startsWith('~')) {
    const base = root?.replace(/\/+$/, '')
    if (!base || !fixed.startsWith(`${base}/`)) return { refusal: PATH_REFUSAL }
    fixed = fixed.slice(base.length + 1)
  }
  // The vault root is the folder named Memory, so a `memory/` prefix names a
  // folder inside the vault that is not meant.
  fixed = fixed.replace(/^memory\/+/i, '')
  if (fixed.split('/').includes('..')) return { refusal: PATH_REFUSAL }
  return { path: fixed }
}

// Whether a vault path needs the vault root to be fixed.
export const needsRoot = (path: string): boolean => /^(\.\/)*[/~]/.test(path)

type Fields = { name?: unknown; type?: unknown }

// The top-level `name` and `type` of a frontmatter block at the start of
// `content`, or undefined when there is no block. A block scalar (`name: >-`)
// counts as present when an indented line follows it.
export function blockOf(content: string): Fields | undefined {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/.exec(content)
  if (!match) return undefined
  const lines = (match[1] ?? '').split(/\r?\n/)
  const fields: Fields = {}
  lines.forEach((line, at) => {
    const field = /^(name|type):(.*)$/.exec(line)
    if (!field) return
    let value = (field[2] ?? '').trim()
    if (/^[|>][-+0-9]*$/.test(value)) {
      const next = lines[at + 1] ?? ''
      value = /^\s+\S/.test(next) ? next.trim() : ''
    }
    // A quoted value ends at its closing quote. An unquoted one ends before a
    // ` #` comment, as YAML reads it.
    const quoted = /^(["'])(.*?)\1(\s+#.*)?\s*$/.exec(value)
    value = quoted ? (quoted[2] ?? '') : value.replace(/(^|\s+)#.*$/, '')
    fields[field[1] as 'name' | 'type'] = value.trim()
  })
  return fields
}

// What is wrong with a new note's frontmatter, one sentence per field, or
// none. `frontmatter` is the write tool's argument, and wins over a block at
// the start of `content` field by field.
export function frontmatterProblems(frontmatter: unknown, content: unknown): string[] {
  const block = typeof content === 'string' ? blockOf(content) ?? {} : {}
  const given = typeof frontmatter === 'object' && frontmatter !== null ? (frontmatter as Fields) : {}
  const name = 'name' in given ? given.name : block.name
  const type = 'type' in given ? given.type : block.type
  const problems: string[] = []
  if (typeof name !== 'string' || name.trim() === '') {
    problems.push('the frontmatter has no `name`, or it is empty. Give the note a short descriptive title as `name`.')
  }
  if (typeof type !== 'string' || type.trim() === '') {
    problems.push(`the frontmatter has no \`type\`. Use one of: ${TYPES.join(', ')}.`)
  } else if (!TYPES.includes(type.trim())) {
    problems.push(`the frontmatter \`type\` is "${type.trim()}", which is not a vault type. Use one of: ${TYPES.join(', ')}.`)
  }
  return problems
}

export const frontmatterRefusal = (problems: readonly string[]): string =>
  `This vault write was refused: ${problems.join(' Also, ')} Pass \`name\` and \`type\` in the frontmatter argument (references/vault-conventions.md).`

// Code the reader is shown, which a link inside it never is: fenced blocks,
// to their end or the text's, and inline code. Then a [[link]], with an
// optional leading ! for an embed, which is left alone.
const LINK = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)|(!?)\[\[([^[\]\n|#]+)(?:\|([^[\]\n]+))?\]\]/g

// The targets of the [[links]] in `text` that a rewrite could replace.
export function wikiTargets(text: string): string[] {
  const targets = new Set<string>()
  for (const match of text.matchAll(LINK)) {
    if (match[1] === undefined && match[2] === '' && match[3]) targets.add(match[3].trim())
  }
  return [...targets]
}

// `text` with each [[link]] whose target `paths` resolves rewritten to a
// root-absolute path link. A path holding whitespace or a bracket is left as a
// [[link]]: in a markdown link it would need escaping the indexer may not read.
export function rewriteLinks(text: string, paths: ReadonlyMap<string, string>): string {
  return text.replace(LINK, (whole, code: string | undefined, bang: string, target: string | undefined, alias: string | undefined) => {
    if (code !== undefined || bang !== '' || target === undefined) return whole
    const path = paths.get(target.trim())
    if (path === undefined || /[\s()<>[\]]/.test(path)) return whole
    return `[${(alias ?? target).trim()}](${path})`
  })
}

// What scripts/vault-resolve.sh printed: the vault root, and the path of each
// target it resolved to one note.
export function resolvedOf(stdout: string): { root: string | undefined; paths: Map<string, string> } {
  let root: string | undefined
  const paths = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const [kind, first, second] = line.split('\t')
    if (kind === 'root' && first?.startsWith('/')) root = first
    if (kind === 'link' && first && second?.startsWith('/') && second.endsWith('.md')) paths.set(first, second)
  }
  return { root, paths }
}
