// TEST ORACLE. NOT PART OF THE PLUGIN. NEVER IMPORT THIS FROM hooks/.
//
// A frozen copy of hooks/mods/commit-approval.ts as of 77bb2f3, the approval
// gate before it moved onto the shared shell reader (hooks/mods/shell.ts).
// tests/shell-gate-differential.test.ts holds the live gate to it: on every
// line, the live gate must find at least as many commits and pushes as this
// one. Do not edit it, and do not fix its misreadings: it is the floor.

// The commit approval rule: a main-session `git commit` or `git push` happens
// only after Mike picks "Commit it" in AskUserQuestion, the commit question is
// asked alone, and one pick approves one commit and the push of that commit.
//
// The output style states the rule (rule 6), and workbench-dev-team's
// git-commit skill holds the mechanics ("Committing and pushing"). Approval is
// per commit, never standing (vault: feedback/commit-approval-is-per-commit-
// never-standing). Claude Code's permission prompt for `git commit *` and
// `git push *` is the mechanical backstop, and a prompt that appears mid-flow
// gets answered without a review. hooks/register.ts enforces the checkable half
// with the functions below:
//
//   tool.call (Bash)             A commit needs an unused "Commit it" pick. A
//                                push needs the commit that pick approved,
//                                run before it. Any prompt ends an unused
//                                pick, and Mike's own ends the push too.
//   tool.call (AskUserQuestion)  A call that offers a commit option beside
//                                another question is refused. A "Commit it"
//                                pick is recorded.
//
// Whether Mike's review is done needs judgement, so that half stays prose.
// The check never decides which tool the model uses: it governs what a commit
// needs, and a command that only mentions git is let through.
//
// THE SHELL READER. commandsOf() is a reading of a shell line for this check,
// not a shell, and where it is unsure it errs toward finding a commit, so a
// doubt costs a "Commit it" question and never a commit nobody approved. It
// reads quotes and backslashes; the separators ; & | && || newline ( ) ;
// redirects anywhere in a command (`>out`, `2>&1`, `&>x`, `<in`), which are
// dropped with their target; and $( ), backticks and <( ) >( ), whose commands
// are read on their own while the outer word goes on. A command is read past
// assignments, wrappers (env, sudo, nice, timeout, xargs, ...) up to the first
// word named git, `bash -c` and `eval` scripts, and git's global options, and
// `git` and its subcommand are matched without regard to case, as macOS finds
// `GIT` on its case-insensitive disk. A `-c alias.<name>=<value>` that names
// commit or push counts as that.
//
// A heredoc body (<<WORD, <<-WORD, <<'WORD', <<"WORD") is text, not commands,
// and is taken out before the line is read: a commit message's apostrophe
// would otherwise open a quote that hides the commit after it, and a message
// line that starts with `git push` would count as a push. The body is read as
// a script only when it feeds a shell or eval (`bash <<EOF`), and the $( )
// and backticks of a body with an unquoted delimiter are read, as bash runs
// them. The scan reads the whole command, so a << counts only where bash reads
// one: not in a quoted string on any line it spans, not in a comment, not in
// arithmetic ($(( )), (( )), let). Its delimiter is joined as bash joins it,
// so E'OF' is EOF.
//
// A $'…' string with any backslash escape marks its word ESCAPED. Such a word
// as a command name, or among git's options and subcommand, counts as a
// commit and a push: `$'\x67it' push` is git push, and an escape the reader
// does not decode (\u, \U, \c) could spell anything.
//
// Where the line commits, it also says where: the `cd` and `pushd` targets
// before it, then git's -C values. hooks/register.ts reads HEAD there before
// and after the line, so the approval follows what the repository shows.
// A cd or pushd is recorded only in the one certain shape: the first word of a
// command before any && or || on a line with no pipe, no lone &, no ( or
// backtick and no heredoc, outside any shell -c script (eval keeps it), with a
// target that is absolute, under ~, or starts with ./ or ../, and dirOf then
// leaves any target holding `..` unknown. A bare relative
// target (`cd sub`) is always unknown, because CDPATH can redirect it, and a
// line can set CDPATH under a name built at run time. The cost is one new pick
// when a `cd sub; git commit` line also fails. A pushd counts only as
// `pushd <dir>`. The directory is UNKNOWN, which uses the approval up, when
// the line holds:
//   - any other cd or pushd, or any popd, source or . command word: behind
//     if, {, !, command or an assignment, in a pipeline (bash runs the stages
//     in children, zsh runs the last here), behind &, in a subshell, a
//     substitution, a heredoc, or a shell -c script
//   - GIT_DIR or GIT_WORK_TREE, --git-dir, --work-tree, env -C or --chdir
//   - a cd or -C target with a variable, a substitution, `-`, or an escape
//   - any `..` in a cd or -C target, which the shell and git resolve apart
//     when the directory before it is a symlink (dirOf)
//   - an escaped command word
//
// WHAT IT CANNOT SEE, by design, because the line does not say:
//   - an alias in a git config file (`git ci` with alias.ci = commit)
//   - commands that make commits without the word: merge, revert,
//     cherry-pick, am, rebase, pull, stash
//   - text piped into a shell (`echo git push | sh`, `cat <<EOF | sh`)
//   - a here-string's text (`sh <<< 'git push'`)
//   - a script file, an interpreter (`python -c`), or a shell function
// Those stay with the permission rules, dev-team's commit guard, and review.
//
// Pure functions only: the engine follows `$` into no imported function.

export const COMMIT_REFUSAL =
  'This git commit was refused: no unused "Commit it" pick from Mike approves ' +
  'it. Ask first. Once he says his review is done, ask the commit question ' +
  'through AskUserQuestion, alone, with the branch and the proposed message, ' +
  'and run the commit again after he picks "Commit it". One pick approves one ' +
  'commit and the push of that commit. Any prompt ends a pick not yet used ' +
  'for its commit. A typed ' +
  '"commit it" in chat does not count.'

export const PUSH_REFUSAL =
  'This git push was refused: it does not follow a commit Mike approved with ' +
  'a "Commit it" pick. Ask first. One pick approves one commit and the push of ' +
  'that commit, in that order. Mike\'s next prompt ends a push left by an ' +
  'approved commit.'

export const ONE_REFUSAL =
  'This line runs more than one git commit, or more than one git push. One ' +
  '"Commit it" pick approves one commit and the push of that commit. Run them ' +
  'as separate lines, and ask first for each further commit.'

export const BUNDLE_REFUSAL =
  'AskUserQuestion was refused: it offers a commit option beside another ' +
  'question. Ask the commit question alone, in an AskUserQuestion call of its ' +
  'own, and ask the other questions in a separate call.'

// The label that approves, as the git-commit skill prescribes it.
const APPROVAL = 'commit it'

// An option that offers a commit: its label leads with the word.
const COMMIT_OPTION = /^\s*commit\b/i

// Words that stand before the command they run. After one, the command is the
// first later word named git, or a shell or eval to read again, so a wrapper's
// options and their values never hide it.
const WRAPPERS: ReadonlySet<string> = new Set([
  'env', 'exec', 'command', 'builtin', 'nohup', 'sudo', 'doas', 'time', 'nice', 'ionice', 'xargs',
  'timeout', 'gtimeout', 'stdbuf', 'caffeinate', 'chronic', 'unbuffer', 'flock', 'watch',
  'if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{',
])
const SHELLS: ReadonlySet<string> = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'])

// git's global options that take their value as the next word.
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path',
])

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/

// What a substitution leaves in the word it stood in.
const SUBSTITUTED = '$_'

// The mark a word carries when a $'…' string in it held any backslash
// escape. Such a word may spell anything once bash decodes it (`$'\x67it'` is
// git), so the reader never trusts it: as a command name or among git's
// options and subcommand, it counts as a commit and a push.
const ESCAPED = '\uE000'

const ANSI_CONTROLS: Record<string, string> = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' }

// The text of a $'…' string, its \xHH, \NNN and one-letter escapes decoded,
// and any other escape (\u, \U, \c, ...) kept as written. Decoding is only for
// the reader's own matching: a word with any escape is marked ESCAPED anyway.
function decodeAnsi(raw: string): string {
  return raw.replace(/\\(x[0-9A-Fa-f]{1,2}|[0-7]{1,3}|.)/gs, (whole, escape: string) => {
    if (escape.startsWith('x')) return String.fromCharCode(parseInt(escape.slice(1), 16))
    if (/^[0-7]/.test(escape)) return String.fromCharCode(parseInt(escape, 8))
    if (escape in ANSI_CONTROLS) return ANSI_CONTROLS[escape] as string
    return /^['"\\?]$/.test(escape) ? escape : whole
  })
}

// The index of the `'` that closes a $'…' string whose text starts at `from`,
// or the end of the text. In $'…' a backslash escapes the character after it,
// \' included, unlike in '…'. Every reader here finds the close through this
// one function, so none can read `$'it\'s'` as ending at the backslash.
function closingAnsiQuote(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === "'") return i
  }
  return text.length
}

// The index of the `)` that closes a `(` opened just before `from`, quotes and
// backslashes read, or the end of the line when none does.
function closingParen(line: string, from: number): number {
  let depth = 1
  for (let i = from; i < line.length; i++) {
    const c = line[i]
    if (c === '\\') i++
    else if (c === '$' && line[i + 1] === "'") i = closingAnsiQuote(line, i + 2)
    else if (c === "'") i = line.indexOf("'", i + 1) === -1 ? line.length : line.indexOf("'", i + 1)
    else if (c === '"') {
      for (i++; i < line.length && line[i] !== '"'; i++) if (line[i] === '\\') i++
    } else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i
  }
  return line.length
}

// The index of the backtick that closes one opened just before `from`.
function closingTick(line: string, from: number): number {
  for (let i = from; i < line.length; i++) {
    if (line[i] === '\\') i++
    else if (line[i] === '`') return i
  }
  return line.length
}

// The commands of every $( ) and backtick in `text`, as lines of their own.
function substitutionsOf(text: string): string[] {
  const inner: string[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === '$' && text[i + 1] === '(') {
      const end = closingParen(text, i + 2)
      inner.push(text.slice(i + 2, end))
      i = end
    } else if (text[i] === '`') {
      const end = closingTick(text, i + 1)
      inner.push(text.slice(i + 1, end))
      i = end
    }
  }
  return inner
}

// What the heredoc scanner is inside: unquoted text (the line itself, a $( ),
// or a backtick), a quoted string ('' or ""), or arithmetic, where << is a
// shift. A $'…' string is skipped whole, through closingAnsiQuote.
type Context = 'top' | '$(' | '`' | "'" | '"' | '(('

type Heredoc = { delimiter: string; stripsTabs: boolean; expands: boolean; isScript: boolean }

// Whether a word starts at `i`: a `#` there opens a comment, and `((` there
// opens arithmetic.
const isWordStart = (text: string, i: number): boolean => i === 0 || /[\s;&|()]/.test(text[i - 1] as string)

// The delimiter of a heredoc whose word starts at `from`, built as bash builds
// it: every part of the word joined, quoted or not, with the quotes and
// backslashes removed (`E'OF'` is EOF). Any quoting at all means the body is
// not expanded.
function delimiterAt(text: string, from: number): { delimiter: string; isQuoted: boolean; end: number } {
  let delimiter = ''
  let isQuoted = false
  let i = from
  while (i < text.length && !/[\s;&|<>()]/.test(text[i] as string)) {
    const c = text[i] as string
    if (c === "'") {
      const close = text.indexOf("'", i + 1)
      const end = close === -1 ? text.length : close
      delimiter += text.slice(i + 1, end)
      isQuoted = true
      i = end + 1
    } else if (c === '"') {
      let j = i + 1
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === '\\' && j + 1 < text.length) j++
        delimiter += text[j]
      }
      isQuoted = true
      i = j + 1
    } else if (c === '\\') {
      delimiter += text[i + 1] ?? ''
      isQuoted = true
      i += 2
    } else {
      delimiter += c
      i++
    }
  }
  return { delimiter, isQuoted, end: i }
}

// Whether a heredoc feeds a shell or eval, so its body is a script: a shell or
// eval word in the text before its operator, back to the last ; & | or line
// end. A substitution does not end that text, because `eval "$(cat <<EOF`
// runs the body too.
function feedsShell(before: string): boolean {
  const segment = before.split(/;|&|\||\n/).pop() ?? ''
  return segment
    .replace(/["']/g, '')
    .split(/\s+/)
    .some(word => SHELLS.has(nameOf(word)) || nameOf(word) === 'eval')
}

// `line` with each heredoc body taken out before it is read as shell. A body
// is the text of a file or a message, not commands: an apostrophe in it would
// open a quote that swallows the commands after it, and a line in it that
// starts with `git push` is not a push. So the body and its delimiter line go,
// and the operator becomes a plain `<` redirect, which the reader drops.
// Bash still runs what a body feeds a shell, and the $( ) and backticks of a
// body whose delimiter is unquoted, so those are kept as lines to read.
//
// It scans the whole text as one command, as bash does, so an operator counts
// only where bash would read one: never inside a quoted string, on any line it
// spans; never in a comment; and never in arithmetic ($(( )), (( )) or let),
// where << is a shift. A here-string (<<<) is not a heredoc. The bodies start
// after the next unquoted line end, in the operators' order.
function withoutHeredocBodies(text: string): string {
  let out = ''
  const stack: Context[] = ['top']
  // How deep each open arithmetic is in its own parentheses.
  const depths: number[] = []
  let pending: Heredoc[] = []
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string
    const next = text[i + 1]
    const context = stack[stack.length - 1] as Context
    if (context === "'") {
      out += c
      if (c === "'") stack.pop()
      continue
    }
    if (context === '((') {
      out += c
      const top = depths.length - 1
      if (c === '(') depths[top] = (depths[top] ?? 0) + 1
      else if (c === ')' && (depths[top] ?? 0) > 0) depths[top] = (depths[top] ?? 0) - 1
      else if (c === ')' && next === ')') {
        out += next
        i++
        stack.pop()
        depths.pop()
      }
      continue
    }
    if (c === '\\') {
      out += c + (next ?? '')
      i++
      continue
    }
    if (c === '$' && next === '(' && text[i + 2] === '(') {
      out += '$(('
      i += 2
      stack.push('((')
      depths.push(0)
      continue
    }
    if (c === '$' && next === '(') {
      out += '$('
      i++
      stack.push('$(')
      continue
    }
    if (context === '"') {
      out += c
      if (c === '"') stack.pop()
      else if (c === '`') stack.push('`')
      continue
    }
    // Unquoted text: the line itself, a $( ), or a backtick.
    if (c === '#' && isWordStart(text, i)) {
      const end = text.indexOf('\n', i)
      const stop = end === -1 ? text.length : end
      out += text.slice(i, stop)
      i = stop - 1
    } else if (c === "'" || c === '"') {
      out += c
      stack.push(c)
    } else if (c === '$' && next === "'") {
      const end = closingAnsiQuote(text, i + 2)
      out += text.slice(i, end + 1)
      i = end
    } else if (c === '(' && next === '(' && isWordStart(text, i)) {
      out += '(('
      i++
      stack.push('((')
      depths.push(0)
    } else if (c === '`') {
      out += c
      if (context === '`') stack.pop()
      else stack.push('`')
    } else if (c === ')' && context === '$(') {
      out += c
      stack.pop()
    } else if (c === '<' && next === '<' && text[i + 2] === '<') {
      out += '<<<'
      i += 2
    } else if (c === '<' && next === '<' && !/^\s*let(\s|$)/.test(out.split(/[;&|\n(]/).pop() ?? '')) {
      let from = i + 2
      const stripsTabs = text[from] === '-'
      if (stripsTabs) from++
      while (text[from] === ' ' || text[from] === '\t') from++
      const { delimiter, isQuoted, end } = delimiterAt(text, from)
      if (delimiter === '') {
        out += '<<'
        i++
      } else {
        pending.push({ delimiter, stripsTabs, expands: !isQuoted, isScript: feedsShell(out) })
        out += '<_'
        i = end - 1
      }
    } else if (c === '\n' && pending.length > 0) {
      out += '\n'
      let at = i + 1
      for (const doc of pending) {
        const body: string[] = []
        while (at < text.length) {
          const stop = text.indexOf('\n', at)
          const rowEnd = stop === -1 ? text.length : stop
          const row = text.slice(at, rowEnd)
          at = rowEnd + 1
          if ((doc.stripsTabs ? row.replace(/^\t+/, '') : row) === doc.delimiter) break
          body.push(row)
        }
        const kept = doc.isScript ? body : doc.expands ? substitutionsOf(body.join('\n')) : []
        out += kept.map(row => `${row}\n`).join('')
      }
      pending = []
      i = at - 1
    } else {
      out += c
    }
  }
  return out
}

// The simple commands of a shell line, each as its words, quotes removed, and
// the commands of every substitution in it, read on their own. A quoted word
// stays one word, so `echo "git push"` holds no git command. Heredoc bodies
// are taken out first (withoutHeredocBodies).
export function commandsOf(text: string): string[][] {
  const line = withoutHeredocBodies(text)
  const commands: string[][] = []
  let words: string[] = []
  let word = ''
  let hasWord = false
  // A redirect's target is the next word, and is dropped.
  let isTarget = false
  const endWord = () => {
    if (hasWord && !isTarget) words.push(word)
    if (hasWord) isTarget = false
    word = ''
    hasWord = false
  }
  const endCommand = () => {
    endWord()
    isTarget = false
    if (words.length > 0) commands.push(words)
    words = []
  }
  // A substitution's commands go in the list, and the outer word goes on.
  const substitute = (inner: string) => {
    commands.push(...commandsOf(inner))
    word += SUBSTITUTED
    hasWord = true
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string
    const next = line[i + 1]
    if (c === '\\') {
      if (next !== '\n') {
        word += next ?? ''
        hasWord = true
      }
      i++
    } else if (c === "'") {
      const end = line.indexOf("'", i + 1)
      word += line.slice(i + 1, end === -1 ? line.length : end)
      hasWord = true
      i = end === -1 ? line.length : end
    } else if (c === '"') {
      hasWord = true
      for (i++; i < line.length && line[i] !== '"'; i++) {
        const d = line[i] as string
        if (d === '\\' && i + 1 < line.length && '"\\$`'.includes(line[i + 1] as string)) {
          word += line[++i]
        } else if (d === '$' && line[i + 1] === '(') {
          const end = closingParen(line, i + 2)
          substitute(line.slice(i + 2, end))
          i = end
        } else if (d === '`') {
          const end = closingTick(line, i + 1)
          substitute(line.slice(i + 1, end))
          i = end
        } else {
          word += d
        }
      }
    } else if (c === '$' && next === '"') {
      // $"…" is bash's locale string: read as "…", which in practice it is.
      continue
    } else if (c === '$' && next === "'") {
      const end = closingAnsiQuote(line, i + 2)
      const raw = line.slice(i + 2, end)
      word += decodeAnsi(raw) + (raw.includes('\\') ? ESCAPED : '')
      hasWord = true
      i = end
    } else if ((c === '$' || c === '<' || c === '>') && next === '(') {
      const end = closingParen(line, i + 2)
      substitute(line.slice(i + 2, end))
      i = end
    } else if (c === '`') {
      const end = closingTick(line, i + 1)
      substitute(line.slice(i + 1, end))
      i = end
    } else if (c === '<' || c === '>' || (c === '&' && next === '>')) {
      // A word of digits before it is the file descriptor, not a word.
      if (/^\d+$/.test(word)) {
        word = ''
        hasWord = false
      }
      endWord()
      while (i + 1 < line.length && '<>&|-'.includes(line[i + 1] as string)) i++
      isTarget = true
    } else if (c === '#' && !hasWord) {
      const end = line.indexOf('\n', i)
      i = end === -1 ? line.length : end - 1
    } else if (/\s/.test(c)) {
      if (c === '\n') endCommand()
      else endWord()
    } else if (';&|()'.includes(c)) {
      endCommand()
    } else {
      word += c
      hasWord = true
    }
  }
  endCommand()
  return commands
}

// How many commits and pushes a command or a line runs.
export type Writes = { commits: number; pushes: number }

const NONE: Writes = { commits: 0, pushes: 0 }
const sum = (a: Writes, b: Writes): Writes => ({ commits: a.commits + b.commits, pushes: a.pushes + b.pushes })

// A word's command name: its last path part, lowercased, the escape mark
// removed. The mark itself is read where it matters (isEscaped).
const nameOf = (word: string): string => {
  const plain = word.replaceAll(ESCAPED, '')
  return plain.slice(plain.lastIndexOf('/') + 1).toLowerCase()
}

const isEscaped = (word: string): boolean => word.includes(ESCAPED)

// Past this depth of nested scripts, a line is taken as a commit.
const MAX_DEPTH = 4

// What a line runs, as the reader walks it: the commits and pushes, the
// directories `cd` and `pushd` moved to so far, and where the first commit or
// push runs: the steps from the session's directory (`cd` targets, then git's
// -C values), null when a step is a substitution or a variable the reader
// cannot follow, and undefined until a commit or push is found.
export type Line = { writes: Writes; dir: readonly string[] | null | undefined }
// `isUnfollowed` is set by any directory change the walk does not record.
type Walk = { writes: Writes; cds: string[]; dir: string[] | null | undefined; isUnfollowed: boolean }

// The command words that move the shell or change its environment: a
// directory change, or a sourced file, which may set GIT_DIR.
const PLACE_WORDS: ReadonlySet<string> = new Set(['cd', 'pushd', 'popd', 'source', '.'])

// Whether words[i] is a command word: every word before it is an assignment,
// a wrapper or keyword (if, {, !, command, ...), or an option.
const isCommandWord = (words: readonly string[], i: number): boolean =>
  words.slice(0, i).every(word => ASSIGNMENT.test(word) || WRAPPERS.has(nameOf(word)) || word.startsWith('-'))

// Whether every command of a line runs in this shell, one after another: no
// pipe and no lone & (bash runs those stages in a child, and zsh runs the
// last one here), and no ( or backtick, which may open a subshell or a
// substitution, and no heredoc, whose body may feed a child shell. A | or &
// inside quotes counts too, which only costs a recorded cd.
const isSimpleLine = (line: string): boolean =>
  !/[(`]/.test(line) && !line.includes('<<') && !/[|&]/.test(line.replace(/\|\||&&|[<>]&|&>/g, ''))

const BOTH: Writes = { commits: 1, pushes: 1 }

// A step the reader cannot follow: the directory is then unknown, which counts
// as done.
const UNKNOWN = '$'

// What moves git to a repository the steps do not show.
const GIT_PLACE = /^GIT_(DIR|WORK_TREE)=/
const GIT_PLACE_OPTION = /^--(git-dir|work-tree)(=|$)/
const ENV_CHDIR = /^(-[A-Za-z]*C|--chdir(=|$))/

const stepsOf = (steps: string[]): string[] | null =>
  steps.some(step => step.includes('$') || step === '-' || isEscaped(step)) ? null : steps

function found(walk: Walk, writes: Writes, steps: string[]): void {
  walk.writes = sum(walk.writes, writes)
  if (walk.dir === undefined) walk.dir = stepsOf(steps)
}

// One simple command, behind any wrapper, assignment, shell script or global
// option. `isHere` says the command surely runs in this shell, in order: its
// line is simple (isSimpleLine) and not inside a shell -c script. eval keeps
// it, as eval runs in this shell.
function walkCommand(words: readonly string[], depth: number, isHere: boolean, walk: Walk): void {
  // GIT_DIR or GIT_WORK_TREE, as a prefix, through env, or exported, points
  // git elsewhere for this command or for the rest of the line.
  if (words.some(word => GIT_PLACE.test(word))) walk.cds.push(UNKNOWN)
  // THE DIRECTORY RULE. A cd or pushd is recorded only as the first word of a
  // command that surely runs in this shell, before any && or || on its line,
  // with a target that is absolute, under ~, or starts with ./ or ../. A bare
  // relative target (`cd sub`) is always unknown, because CDPATH can redirect
  // it and the line can set CDPATH under a name built at run time. A pushd
  // that is not `pushd <dir>` (no target, +N, -N or an option rotates the
  // stack or stays put) is unknown too. Every other cd, pushd, popd, source or . in a
  // command-word place leaves the directory unknown: behind if, {, !, command
  // or an assignment, in a pipeline, behind &, in a subshell, a substitution,
  // a heredoc or a shell -c script.
  const placeAt = words.findIndex((word, j) => PLACE_WORDS.has(nameOf(word)) && isCommandWord(words, j))
  const head = nameOf(words[0] ?? '')
  if (placeAt === 0 && isHere && !isEscaped(words[0] ?? '') && (head === 'cd' || head === 'pushd')) {
    const target = words.slice(1).find(word => !word.startsWith('-') || word === '-') ?? '~'
    const isPlainPushd = words.length === 2 && !/^[+-]/.test(words[1] ?? '')
    const isUnknown = isBareRelative(target) || (head === 'pushd' && !isPlainPushd)
    walk.cds.push(isUnknown ? UNKNOWN : target)
    return
  }
  if (placeAt !== -1) walk.isUnfollowed = true
  let i = 0
  while (i < words.length) {
    const word = words[i] as string
    const name = nameOf(word)
    if (ASSIGNMENT.test(word)) {
      i++
    } else if (isEscaped(word)) {
      // A command name with an escape may be git, a shell, or a cd.
      walk.isUnfollowed = true
      found(walk, BOTH, [...walk.cds])
      return
    } else if (name === 'eval') {
      walkLine(words.slice(i + 1).join(' '), depth + 1, isHere, walk)
      return
    } else if (SHELLS.has(name)) {
      // The script is the word after the first short option holding `c`,
      // whatever options come before it. A shell with none runs a file. The
      // script runs in a child shell, so no cd in it moves this one.
      const at = words.findIndex((option, j) => j > i && /^-[^-]*c/.test(option))
      if (at !== -1) walkLine(words[at + 1] ?? '', depth + 1, false, walk)
      return
    } else if (WRAPPERS.has(name)) {
      const at = words.findIndex((later, j) => j > i && (isEscaped(later) || ['git', 'eval', ...SHELLS].includes(nameOf(later))))
      if (at === -1) return
      if (name === 'env' && words.slice(i + 1, at).some(option => ENV_CHDIR.test(option))) walk.cds.push(UNKNOWN)
      i = at
    } else {
      break
    }
  }
  if (nameOf(words[i] ?? '') !== 'git') return
  const steps = [...walk.cds]
  let aliased: Writes = NONE
  for (i++; i < words.length; i++) {
    const word = words[i] as string
    // An escaped option or subcommand may spell commit, push, or -C.
    if (isEscaped(word)) {
      found(walk, BOTH, steps)
      return
    }
    if (!word.startsWith('-')) {
      const sub = word.toLowerCase()
      if (sub === 'commit') found(walk, { commits: 1, pushes: 0 }, steps)
      else if (sub === 'push') found(walk, { commits: 0, pushes: 1 }, steps)
      else if (aliased !== NONE) found(walk, aliased, steps)
      return
    }
    if (word === '-C') steps.push(words[i + 1] ?? UNKNOWN)
    if (GIT_PLACE_OPTION.test(word)) steps.push(UNKNOWN)
    if (word === '-c') {
      // `-c alias.ci=commit` makes `ci` a commit. The alias's name is not
      // matched against the subcommand: naming commit or push is enough.
      const value = /^alias\.[^=]*=(.*)$/is.exec(words[i + 1] ?? '')?.[1] ?? ''
      if (/\bcommit\b/i.test(value)) aliased = sum(aliased, { commits: 1, pushes: 0 })
      if (/\bpush\b/i.test(value)) aliased = sum(aliased, { commits: 0, pushes: 1 })
    }
    if (GIT_VALUE_OPTIONS.has(word)) i++
  }
  if (aliased !== NONE) found(walk, aliased, steps)
}

// How many commands of a line come before its first && or ||: those surely
// run. A command after one may be skipped, so a cd there is not certain. The
// cut is read on the raw text, so a && inside quotes cuts early, which only
// costs a recorded cd: a cut text never holds more commands than the line.
function certainCount(line: string): number {
  const cut = line.search(/&&|\|\|/)
  return cut === -1 ? Infinity : commandsOf(line.slice(0, cut)).length
}

function walkLine(line: string, depth: number, isHere: boolean, walk: Walk): void {
  if (depth > MAX_DEPTH) {
    found(walk, { commits: 1, pushes: 0 }, [UNKNOWN])
    return
  }
  const isHereLine = isHere && isSimpleLine(line)
  const certain = certainCount(line)
  commandsOf(line).forEach((words, at) => walkCommand(words, depth, isHereLine && at < certain, walk))
}

// Whether a cd target may resolve through CDPATH: a relative path that does
// not start with /, ~, ./ or ../ (`-`, the previous directory, is unknown
// through stepsOf).
const isBareRelative = (target: string): boolean => !/^(\/|~|\.\.?(\/|$)|-$)/.test(target)

// What a Bash command line runs: its commits and pushes, and where. A
// directory change the walk did not record (walkCommand's directory rule)
// leaves the directory unknown, which uses the approval up.
export function readLine(line: string): Line {
  const walk: Walk = { writes: NONE, cds: [], dir: undefined, isUnfollowed: false }
  walkLine(line, 0, true, walk)
  return { writes: walk.writes, dir: walk.isUnfollowed && walk.dir !== undefined ? null : walk.dir }
}

// How many commits and pushes a Bash command line runs.
export const writesOf = (line: string): Writes => readLine(line).writes

// The directory `steps` lead to from the session's `cwd`, or undefined when
// they cannot be followed: a substitution, a variable, `cd -`, a `~` with no
// home to expand it, or any `..`. The shell resolves `..` by the path as
// written (`./link/..` is `.`), while git -C, and so the refs read there,
// resolves it through the real path, so the two can land in different
// repositories whenever the directory before it is a symlink: a named step,
// the session's directory (a session in /tmp is in /private/tmp), or $HOME.
export function dirOf(steps: readonly string[] | null | undefined, cwd: string, home: string | undefined): string | undefined {
  if (steps === null) return undefined
  let dir = cwd
  for (const step of steps ?? []) {
    let path = step
    if (path === '~' || path.startsWith('~/')) {
      if (!home) return undefined
      path = `${home}${path.slice(1)}`
    } else if (path.startsWith('~')) {
      return undefined
    }
    if (step.split('/').includes('..')) return undefined
    dir = path.startsWith('/') ? path : `${dir.replace(/\/+$/, '')}/${path}`
  }
  return dir
}

// Where the approval stands: `none`, a pick not yet used (`commit`), or a
// commit made under the pick, whose push is still allowed (`push`).
export type Approval = 'none' | 'commit' | 'push'

// Why a line that commits or pushes is refused at this approval, or undefined
// when it may run.
export function refusalOf(writes: Writes, approval: Approval): string | undefined {
  if (writes.commits > 1 || writes.pushes > 1) return ONE_REFUSAL
  if (writes.commits === 1) return approval === 'commit' ? undefined : COMMIT_REFUSAL
  return approval === 'push' ? undefined : PUSH_REFUSAL
}

// The repository's state around a line: HEAD, and what the branch's push
// target (@{push}) points at. A field is undefined when git could not say.
export type Refs = { head?: string; pushed?: string }

// Where the approval stands once an allowed line has run. Neither the exit
// status (`| tail`, `; echo`, `|| true` and a background run hide it) nor the
// refs (the commit may land in a repository the reader did not read) is
// enough alone, so the pick is kept only when both say the commit failed: HEAD
// did not move and the line reported an error. Otherwise the commit counts as
// landed, and its push is left, or used up too when the push target now holds
// HEAD. A push is done when the push target holds HEAD. What cannot be seen
// (no refs, a background run, a directory the reader could not follow, no
// push target) is taken as done, so a doubt uses the approval up and never
// stretches it.
export function approvalAfter(writes: Writes, before: Refs | undefined, after: Refs | undefined, isError: boolean): Approval {
  const isSeen = before?.head !== undefined && after?.head !== undefined
  if (writes.commits === 1 && isSeen && isError && after?.head === before?.head) return 'commit'
  if (writes.pushes === 0) return 'push'
  const isPushed = !isSeen || after?.pushed === undefined || after.pushed === after.head
  return isPushed ? 'none' : 'push'
}

type Question = { question?: unknown; options?: readonly { label?: unknown }[] }

// Whether one AskUserQuestion call offers a commit option beside another
// question.
export function bundlesCommit(questions: unknown): boolean {
  if (!Array.isArray(questions) || questions.length < 2) return false
  return (questions as Question[]).some(
    question => Array.isArray(question?.options) && question.options.some(option => typeof option?.label === 'string' && COMMIT_OPTION.test(option.label)),
  )
}

// Whether a resolved AskUserQuestion dialog carries Mike's "Commit it" pick.
// `questions` is the call's own input. The answer must be, character for
// character, the label of a "Commit it" option of the question it answers.
// Text typed under Other comes back as the answer too, so this is how a pick
// is told from typing: "commit it" typed in any other spelling is refused. Text
// typed to match the label exactly cannot be told from a pick. A dialog that
// resolved while Mike was away (afkTimeoutMs), and a reply typed instead of
// choosing (response), carry no pick.
export function isCommitPick(questions: unknown, result: unknown): boolean {
  if (!Array.isArray(questions) || typeof result !== 'object' || result === null) return false
  const { answers, afkTimeoutMs, response } = result as { answers?: unknown; afkTimeoutMs?: unknown; response?: unknown }
  if (afkTimeoutMs !== undefined || (typeof response === 'string' && response.trim() !== '')) return false
  if (typeof answers !== 'object' || answers === null) return false
  return (questions as Question[]).some(question => {
    const answer = typeof question?.question === 'string' ? (answers as Record<string, unknown>)[question.question] : undefined
    return (
      typeof answer === 'string' &&
      Array.isArray(question.options) &&
      question.options.some(option => option?.label === answer && answer.trim().toLowerCase() === APPROVAL)
    )
  })
}
