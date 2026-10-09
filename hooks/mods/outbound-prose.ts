// The outbound prose guard's checks, as pure functions: a port of
// hooks/lib/prose-check.py, frozen with its bash guard under
// tests/oracle/outbound-prose-guard/. It reads prose that leaves this machine
// (a gh body or a board-MCP argument) and returns one finding per broken rule
// of the Clear output style, each saying how to fix the prose. It reads what a
// body says, never which tool sent it.
//
//   em-dash       no em dash in prose (rule 8)
//   semicolon     no semicolon in prose (rule 8)
//   file-pointer  no path to a plan, a scratchpad file, or a vault note, which
//                 the reader cannot open (rule 11)
//
// The README section "Outbound prose guard" states what each check skips and
// why. Pure functions only: the engine follows `$` into no imported function.

const BOT_REGION = /<!--[^>]*auto-generated comment[\s\S]*?-->[\s\S]*?<!--[^>]*end of auto-generated comment[^>]*-->/gi
const FENCED = /^[ \t]*(```|~~~)[\s\S]*?^[ \t]*\1[ \t]*$/gm
const HTML_COMMENT = /<!--[\s\S]*?-->/g
const INLINE_CODE = /`[^`\n]*`/g
const MD_LINK = /\[([^\]]*)\]\([^)]*\)/g
const CHECKLIST = /^\s*[-*+]\s*\[[ xX]\]/
const URL = /\bhttps?:\/\/\S+/gi

// The first character of a path component after the root.
const NEXT = `[^\\s/\`'")\\]>.,;:!?]`
const W = '[\\p{L}\\p{N}_]'
export const DEFAULT_VAULT = 'Documents/Claude/Memory'
const PLAN_FAMILY = `\\.claude/plans/${NEXT}`
const SCRATCH_FAMILIES = [`(?:Developer/|(?<![\\p{L}\\p{N}_./-]))scratchpad/${NEXT}`, `/tmp/claude-[^\\s/]*/${NEXT}`]
const WRITE_COMMANDS: ReadonlySet<string> = new Set(['mktemp', 'mkdir', 'touch', 'tee', 'cp', 'mv', 'ln', 'cd', 'ls'])
const SHELL_NAMES: ReadonlySet<string> = new Set(['bash', 'sh', 'zsh'])
const VAULT_PROSE = new RegExp(`\\bvault(?:[ -]notes?(?:\\s+(?:at|in|under))?\\s*:?|\\s+(?:at|under)|\\s*:)\\s*[\`'"(]*((?:${W}|[.-])+)/${NEXT}`, 'giu')
export const KNOWN_VAULT_FOLDERS: ReadonlySet<string> = new Set(['decisions', 'dev-team', 'feedback', 'identity', 'insights', 'learnings', 'sessions', 'topics'])

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
const families = (list: readonly string[]): RegExp => new RegExp(list.map(f => `(?:${f})`).join('|'), 'iu')
const words = (text: string): string[] => text.split(/\s+/).filter(Boolean)

// Where the vault lives, as the two roots a pointer may name below home.
export type VaultView = { root?: string; home?: string; folders?: ReadonlySet<string> }

function vaultFamilies(vault: VaultView): string[] {
  const roots = new Set([DEFAULT_VAULT])
  let root = vault.root?.replace(/\/+$/, '').replace(/\/{2,}/g, '/')
  if (root !== undefined && vault.home !== undefined && root.startsWith(`${vault.home}/`)) root = root.slice(vault.home.length + 1)
  const trimmed = root?.replace(/^\/+|\/+$/g, '')
  if (trimmed) roots.add(trimmed)
  return [...roots].sort().map(r => `${escape(r)}/${NEXT}`)
}

// Whether an inline-code span is a command that creates or writes the place
// it names, so the reader can act on it.
function isCommandSpan(code: string, vault: VaultView): boolean {
  const parts = words(code)
  const scratch = families(SCRATCH_FAMILIES)
  const [head = '', second = ''] = parts
  if (parts.length < 2) return false
  if (SHELL_NAMES.has(head)) {
    const script = parts.slice(1).find(w => !w.startsWith('-'))
    if (script === undefined || scratch.test(script)) return false
  } else if (head === 'git') {
    if (second !== '-C') return false
  } else if (!WRITE_COMMANDS.has(head)) return false
  if (families([PLAN_FAMILY, ...vaultFamilies(vault)]).test(code)) return false
  return !parts.some(w => scratch.test(w) && /\.(md|markdown)$/i.test(w.replace(/^["'),;:.]+|["'),;:.]+$/g, '')))
}

const excerpt = (text: string, width = 90): string => {
  const flat = words(text).join(' ')
  return [...flat].length <= width ? flat : `${[...flat].slice(0, width - 1).join('')}…`
}

const unseen = (text: string): string => text.replace(BOT_REGION, '').replace(FENCED, '').replace(HTML_COMMENT, '')

function charFindings(text: string): string[] {
  const lines = unseen(text).replace(INLINE_CODE, 'code').replace(MD_LINK, '$1').split('\n').filter(l => !CHECKLIST.test(l))
  const rules: [string, string, string][] = [
    ['em-dash', '—', 'Use a colon, a parenthesis, or a full stop.'],
    ['semicolon', ';', 'A semicolon means you have two sentences. Split it.'],
  ]
  return rules.flatMap(([kind, char, fix]) => {
    const hits = lines.filter(l => l.includes(char))
    return hits.length === 0 ? [] : [`${kind}: ${hits.length} line(s) contain ${char} (rule 8). ${fix}\n    first: ${excerpt(hits[0] as string)}`]
  })
}

function pointerFindings(text: string, vault: VaultView): string[] {
  const lines = unseen(text)
    .replace(INLINE_CODE, span => (isCommandSpan(span.slice(1, -1), vault) ? 'code' : span))
    .replace(URL, 'url')
    .split('\n')
  const pattern = families([PLAN_FAMILY, ...SCRATCH_FAMILIES, ...vaultFamilies(vault)])
  const folders = vault.folders !== undefined && vault.folders.size > 0 ? vault.folders : KNOWN_VAULT_FOLDERS
  const hits = lines.filter(l => pattern.test(l) || [...l.matchAll(VAULT_PROSE)].some(m => folders.has((m[1] ?? '').toLowerCase())))
  return hits.length === 0
    ? []
    : [
        `file-pointer: ${hits.length} line(s) point at a plan, scratchpad, or vault file the reader cannot open (rule 11). ` +
          'Restate the substance in the body itself. A path may stay only as a location the reader acts on, such as a file the change edits.' +
          `\n    first: ${excerpt(hits[0] as string)}`,
      ]
}

// Every rule the prose breaks, each with how to fix it. Empty when it is clean.
export const proseFindings = (text: string, vault: VaultView = {}): string[] => [...charFindings(text), ...pointerFindings(text, vault)]

// The refusal the model reads as its revision brief.
export const proseRefusal = (findings: readonly string[]): string =>
  [
    'Outbound prose guard (workbench-core): this text breaks the Clear standard, and other people read it.',
    '',
    ...findings,
    '',
    'Rewrite the body, then send it again. The rules are in your output style: verdict first, reasons next, short plain paragraphs a tired reader follows.',
    'Re-read the WHOLE document after editing. Length is a property of the finished text, not of the paragraph you just appended.',
  ].join('\n')

// ─── where the body comes from ───────────────────────────────────────────────

// The board-MCP tools that carry prose, by the end of their name.
export const PROSE_TOOL_SUFFIXES = ['add_comment', 'submit_review', 'create_issue', 'set_acceptance_criteria']
export const isProseTool = (tool: string): boolean => tool.startsWith('mcp__') && PROSE_TOOL_SUFFIXES.some(s => tool.endsWith(s))

// Identifiers, not prose. Every other string argument of an MCP call is read.
const SKIP_KEYS: ReadonlySet<string> = new Set(['id', 'item_id', 'issue_id', 'pr_id', 'node_id', 'url', 'html_url', 'owner', 'repo', 'repository', 'number', 'sha', 'ref', 'branch', 'state', 'status', 'slug', 'event', 'login', 'assignee'])

export const mcpBody = (input: Record<string, unknown>): string =>
  Object.entries(input)
    .filter(([key, value]) => typeof value === 'string' && !SKIP_KEYS.has(key.toLowerCase()) && value.trim() !== '')
    .map(([, value]) => value as string)
    .join('\n\n')

// One piece of a body: text from the command, or a file the guard must read.
// A JSON file is a `gh api --input`, whose prose is its body and title keys.
// A query file is a graphql `-F query=@file`, which is prose only when it
// holds a mutation.
export type BodyPart = { text: string } | { file: string; isJson: boolean; isQuery?: boolean }

// The bodies a Bash line posts, or `unread` when a prose command's body
// cannot be read from the text: a substitution or an unknown in the line, or
// standard input that is not a heredoc or a here-string in the line.
export type BodyReading = { parts: BodyPart[] } | { unread: string }

const PROSE_COMMANDS: ReadonlySet<string> = new Set(['pr create', 'pr edit', 'pr comment', 'pr review', 'issue create', 'issue edit', 'issue comment', 'release create', 'release edit'])
const INLINE_FLAGS: ReadonlySet<string> = new Set(['--body', '-b', '--notes', '-n', '--message', '-m'])
const FILE_FLAGS: ReadonlySet<string> = new Set(['--body-file', '-F', '--notes-file'])
const API_FIELD_FLAGS: ReadonlySet<string> = new Set(['-f', '--raw-field', '-F', '--field'])
const API_PROSE_KEYS: ReadonlySet<string> = new Set(['body', 'title'])

const base = (word: string): string => (word.split('/').pop() ?? '').toLowerCase()
const SUBSTITUTED = '$_'
const SHORT_INLINE = ['-b', '-n', '-m']
const MOVERS: ReadonlySet<string> = new Set(['cd', 'pushd', 'popd'])

// What the shell may expand in a word: a `$`. The parse drops quote marks and
// keeps a parameter expansion as its text, so a word that holds a `$` is
// refused whatever its quoting was. A live backtick or `$(...)` in a word
// becomes the parse's substitution mark, which holds a `$` too, so a backtick
// left in a word is literal.
const WORD_EXPANDS = /\$/

// What the shell may expand in an unquoted heredoc body, which the parse keeps
// as raw text: a `$` or a backtick.
const BODY_EXPANDS = /[$`]/

// The standard input a statement reads from its own text, and what in it the
// shell expands: a here-string is a word, an unquoted heredoc a raw body, and
// a quoted heredoc is free text.
type Stdin = { text: string; expands?: RegExp }

// The last heredoc or here-string, as in bash. Undefined when it reads none.
function stdinOf(st: Statement): Stdin | undefined {
  let stdin: Stdin | undefined
  let heredoc = 0
  for (const r of st.redirects) {
    if (!r.isReal) continue
    if (r.op === '<<<') stdin = { text: r.target, expands: WORD_EXPANDS }
    else if (r.op === '<<' || r.op === '<<-') {
      const d = st.heredocs[heredoc++]
      stdin = d === undefined ? undefined : { text: d.body, ...(d.isQuoted ? {} : { expands: BODY_EXPANDS }) }
    } else if (r.op === '<' || r.op === '<>') stdin = undefined
  }
  return stdin
}

// A body or title word, or a body-file path, read from the command line.
const fromWord = (part: BodyPart): BodyPart | string => {
  const word = 'text' in part ? part.text : part.file
  return word.includes(SUBSTITUTED) ? UNREAD_BODY : WORD_EXPANDS.test(word) ? EXPANDED_BODY : part
}

// A body read from standard input.
const fromStdin = (stdin: Stdin | undefined): BodyPart | string =>
  stdin === undefined ? UNREAD_BODY : stdin.expands?.test(stdin.text) === true ? EXPANDED_BODY : { text: stdin.text }

// Whether the words after `gh` name a prose command, read two ways: past the
// global options as the reader places them, and as the first two words that
// are not options, which is how the bash guard read them.
function isProseCommand(args: readonly string[], subAt: number): 'api' | 'prose' | undefined {
  const crude = args.filter(a => !a.startsWith('-')).slice(0, 2)
  const placed = subAt >= 0 ? [args[subAt] ?? '', args.slice(subAt + 1).find(a => !a.startsWith('-')) ?? ''] : []
  for (const verbs of [placed, crude]) {
    if (verbs[0]?.toLowerCase() === 'api') return 'api'
    if (verbs.length === 2 && PROSE_COMMANDS.has(verbs.map(v => v.toLowerCase()).join(' '))) return 'prose'
  }
  return undefined
}

export const UNREAD_BODY =
  'Outbound prose guard (workbench-core): this gh call posts a body the guard cannot read from the command, so it is refused. ' +
  "Pass the body as literal text in single quotes, or as a quoted heredoc: --body-file - <<'EOF' ... EOF. " +
  'A body from a command substitution, a variable, a pipe or a redirect cannot be checked. ' +
  'Nor can a gh call in a heredoc fed to a shell (bash <<EOF): run the gh command directly, with its body in a quoted heredoc or a file.'

export const EXPANDED_BODY =
  'Outbound prose guard (workbench-core): this gh body or body-file name holds a $ the shell may expand, or a heredoc body without quotes holds a $ or a backtick, so the guard cannot read what gets posted, and it is refused. ' +
  "A body that needs a literal $ goes in a quoted heredoc (--body-file - <<'EOF' ... EOF) or in a file the command names. " +
  'The guard cannot see quote marks, so a $ in single quotes on the command line is refused too.'

export const MOVED_BODY =
  'Outbound prose guard (workbench-core): this line changes directory before the gh call, so the guard cannot tell which relative body file gets posted, and it is refused. ' +
  'Name the body file by its absolute path, or pass the body in a quoted heredoc.'

function apiParts(args: readonly string[], stdin: Stdin | undefined): BodyPart[] | string {
  const parts: BodyPart[] = []
  let method = ''
  for (let i = 0; i < args.length; ) {
    const token = args[i] as string
    const following = args[i + 1]
    let name: string
    let value: string | undefined
    let step = 2
    if (token.startsWith('--')) {
      const eq = token.indexOf('=')
      ;[name, value, step] = eq >= 0 ? [token.slice(0, eq), token.slice(eq + 1), 1] : [token, following, 2]
    } else if (['-f', '-F', '-X'].includes(token.slice(0, 2)) && token.length > 2) {
      ;[name, value, step] = [token.slice(0, 2), token.slice(2), 1]
    } else [name, value] = [token, following]
    let part: BodyPart | string | undefined
    if (name === '-X' || name === '--method') method = (value ?? '').toUpperCase()
    else if (API_FIELD_FLAGS.has(name) && value !== undefined) {
      const eq = value.indexOf('=')
      const key = eq >= 0 ? value.slice(0, eq) : value
      const field = eq >= 0 ? value.slice(eq + 1) : ''
      const leaf = key.match(/[A-Za-z_]+/g)?.pop() ?? ''
      const isTyped = name === '-F' || name === '--field'
      // A typed field's file or standard input is read before the mutation
      // test, as the bash guard read it.
      const isMutation = (text: string): boolean => leaf === 'query' && text.trimStart().startsWith('mutation')
      const isProse = API_PROSE_KEYS.has(leaf)
      if ((isProse || leaf === 'query') && isTyped && field === '@-') {
        part = fromStdin(stdin)
        if (typeof part !== 'string' && 'text' in part && !isProse && !isMutation(part.text)) part = undefined
      } else if ((isProse || leaf === 'query') && isTyped && field.startsWith('@')) part = fromWord({ file: field.slice(1), isJson: false, ...(isProse ? {} : { isQuery: true }) })
      else if (isProse || isMutation(field)) part = fromWord({ text: field })
    } else if (name === '--input' && value !== undefined) {
      if (value !== '-') part = fromWord({ file: value, isJson: true })
      else {
        part = fromStdin(stdin)
        if (typeof part !== 'string' && 'text' in part) part = { text: proseOfJson(part.text) }
      }
    } else step = 1
    if (typeof part === 'string') return part
    if (part !== undefined) parts.push(part)
    i += step
  }
  return method === 'GET' ? [] : parts
}

// Every string under a body or title key, at any depth of a JSON text. Text
// that is not JSON is refused by the caller, as the guard cannot read it.
export function proseOfJson(text: string): string {
  const out: string[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk)
    else if (node !== null && typeof node === 'object')
      for (const [key, value] of Object.entries(node)) {
        if (API_PROSE_KEYS.has(key) && typeof value === 'string') out.push(value)
        else walk(value)
      }
  }
  walk(JSON.parse(text))
  return out.join('\n\n')
}

function ghParts(args: readonly string[], subAt: number, stdin: Stdin | undefined): BodyPart[] | string | undefined {
  const kind = isProseCommand(args, subAt)
  if (kind === undefined) return undefined
  if (kind === 'api') {
    const at = args.findIndex(a => a.toLowerCase() === 'api')
    try {
      return apiParts(args.slice(at + 1), stdin)
    } catch {
      return UNREAD_BODY
    }
  }
  const parts: BodyPart[] = []
  const fileOrStdin = (val: string): BodyPart | string => (val === '-' ? fromStdin(stdin) : fromWord({ file: val, isJson: false }))
  for (let i = 0; i < args.length; i++) {
    const token = args[i] as string
    const value = args[i + 1] ?? ''
    let part: BodyPart | string | undefined
    if (INLINE_FLAGS.has(token) && value !== '') part = fromWord({ text: value })
    else if (FILE_FLAGS.has(token) && value !== '') part = fileOrStdin(value)
    else if (token.includes('=') && (INLINE_FLAGS.has(token.split('=')[0] as string) || FILE_FLAGS.has(token.split('=')[0] as string))) {
      const [flag = '', ...rest] = token.split('=')
      const val = rest.join('=')
      if (INLINE_FLAGS.has(flag)) part = fromWord({ text: val })
      else if (val !== '') part = fileOrStdin(val)
    } else if (!token.startsWith('--') && token.length > 2 && SHORT_INLINE.includes(token.slice(0, 2))) part = fromWord({ text: token.slice(2) })
    else if (!token.startsWith('--') && token.length > 2 && token.startsWith('-F')) part = fileOrStdin(token.slice(2))
    if (typeof part === 'string') return part
    if (part !== undefined) parts.push(part)
  }
  return parts
}

// The bodies a Bash line posts through gh. A gh word anywhere in a statement
// counts, as the bash guard read it: a retry that merged two lines puts the
// call after the first.
// A body word or an unquoted heredoc body that holds a `$` or a backtick is
// refused unread: the guard reads the line only through the parse.
// A gh call nested in a line that feeds a heredoc to a shell is refused
// unread, quoted heredoc or not: an unquoted one is expanded by the outer
// shell before the inner shell reads it, so the parse sees other text than
// what gets posted.
export function bashBodies(parse: ShellParse): BodyReading {
  const parts: BodyPart[] = []
  let isProse = false
  let hasMoved = false
  const feedsShell = parse.statements.some(st => st.heredocs.some(doc => doc.feedsShell))
  for (const st of parse.statements) {
    if (MOVERS.has(st.name)) hasMoved = true
    const at = st.name === 'gh' ? st.nameAt : st.words.findIndex(w => base(w) === 'gh')
    if (at < 0) continue
    const args = st.name === 'gh' ? st.args : st.words.slice(at + 1)
    const found = ghParts(args, st.name === 'gh' ? st.subcommandAt : -1, stdinOf(st))
    if (found === undefined) continue
    isProse = true
    if (feedsShell && st.depth > 0) return { unread: UNREAD_BODY }
    if (typeof found === 'string') return { unread: found }
    if (hasMoved && found.some(p => 'file' in p && !/^[/~]/.test(p.file))) return { unread: MOVED_BODY }
    parts.push(...found)
  }
  if (isProse && parse.unknowns.length > 0) return { unread: UNREAD_BODY }
  return { parts }
}
