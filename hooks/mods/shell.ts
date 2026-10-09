// The shell reader: one reading of a Bash command line, shared by every check
// that reads one. $.workbench.parseShell answers with it, so workbench-dev-team's
// guard ports read lines the way core's commit gate does. hooks/mods/
// commit-approval.ts reads its lines through commandsOf() below.
//
// It is a reading of a line, not a shell. Where it is unsure it says so: the
// result's `unknowns` names every part it could not read, and a statement's
// `isPlaced` is false when its command name is a guess. A caller that must not
// let an unread command through refuses a line with any unknown. The vault
// lessons behind it: insights/2026-10-07-commit-gate-shell-reading-lessons.md
// and insights/2026-09-26-shell-parsing-guards-lose-arms-race-use-allowlist.md.
//
// WHAT IT READS:
//   - blanks: a word ends only at a space, a tab or a newline, as in bash. Any
//     other space, such as U+00A0, is part of the word
//   - quotes: '…', "…", $'…' with its escapes, and $"…", read as "…"
//   - backslashes, and a backslash-newline, which bash deletes
//   - the separators ; & | && || newline ( ), and comments
//   - redirects anywhere in a command (`>out`, `2>&1`, `&>x`, `<in`), which
//     are taken out of the words with their targets
//   - $( ), backticks and <( ) >( ): their commands are statements of their
//     own, and the outer word goes on with `$_` where the substitution stood
//   - heredocs: one scanner over the whole text takes each body out as bash
//     does (heredocBodiesOut). A body is text, not commands. It is read as a
//     script only when it feeds a shell or eval, and the substitutions of a
//     body with an unquoted delimiter are read, as bash runs them.
//   - arithmetic ($(( )), $[ ], (( ))) and [[ ]] tests, whose < > are text
//   - case…esac, whose patterns are text and whose `)` closes no $( ). A
//     pattern that starts a line, or follows `;;`, is no statement
//   - array assignments, `x=(a b)` and `x+=(c)`: one assignment word, whose
//     substitutions alone run
//   - prefixes: assignments, the keywords if then else elif do while until
//     ! { coproc, and the wrappers in WRAPPERS with their own options
//   - nested scripts: `bash -c`, `sh -c` and the other shells, `eval`, a trap
//     handler, and a heredoc or here-string a shell reads as its script
//
// A $'…' string with any backslash escape marks its word ESCAPED. Bash may
// decode such a word to any name (`$'\x67it'` is git), so a caller treats an
// escaped command name as possibly anything.
//
// WHAT IT CANNOT SEE, because the line does not say: an alias or a function,
// text piped into a shell (`echo x | sh`, flagged as the `stdin` unknown), a
// script file, an interpreter (`python -c`), and what a variable holds (a
// command name from one is the `expansion` unknown). A `watch` without -x, a
// `sudo -s` and a `flock <file> -c` hand their words to a shell, so their
// statements are not placed.
//
// Pure functions only: the engine follows `$` into no imported function.

import type {
  WorkbenchShellHeredoc as ShellHeredoc,
  WorkbenchShellParse as ShellParse,
  WorkbenchShellRedirect as ShellRedirect,
  WorkbenchShellSource as ShellSource,
  WorkbenchShellStatement as ShellStatement,
  WorkbenchShellUnknown as ShellUnknown,
} from '../../types'

// The mark a word carries when a $'…' string in it held any backslash escape.
const ESCAPED = '\uE000'

// The mark the lexer puts before a `$` written outside any quote. Such an
// expansion is split into words by bash, so `$P/x` may run any command,
// where `"$P"/x` names one path.
const UNQUOTED = '\uE002'

// What a substitution leaves in the word it stood in. It carries the
// UNQUOTED mark, quoted or not, so `$(cmd)x/y` is never read as the plain
// variable `$_x` before a path: what a substitution prints is known only at
// run time.
const SUBSTITUTED = UNQUOTED + '$_'

// The heredoc a `<` redirect target stands for: the mark, then its index.
const HEREDOC = '\uE001'

export const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/

export const SHELLS: ReadonlySet<string> = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'])

// Reserved words that stand before a command and run nothing themselves.
export const KEYWORDS: ReadonlySet<string> = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', 'coproc'])

// Reserved words that close a compound command. They run nothing, and a
// redirect after one (`{ x; } >out`) is the group's.
const CLOSERS: ReadonlySet<string> = new Set(['}', 'fi', 'done', 'esac'])

// Reserved words after which a statement may not run.
const BRANCHES: ReadonlySet<string> = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', 'case', 'for', 'select', 'function'])

// How a wrapper's own options are read, so the command after them is placed.
// Short letters: `value` takes the next word (or the rest of its cluster),
// `flags` take none, and `stops` mean the wrapper runs no command, so the
// wrapper is the name (`command -v git`). Long names the same, without the
// dashes. `positional` counts the words the wrapper takes before the command
// (timeout's duration, flock's lock file). An option not listed cannot be
// placed: the statement is not placed, and the reader goes on as though the
// option took no value.
//
// commit-approval.ts reads the names as its wrapper words too, so a wrapper
// added here is one more word the commit gate looks past for a git.
type WrapperOptions = {
  value?: string
  flags?: string
  stops?: string
  longValue?: readonly string[]
  longFlags?: readonly string[]
  longStops?: readonly string[]
  positional?: number
  // nice takes `-5` as its adjustment.
  numeric?: boolean
}

const TIMEOUT: WrapperOptions = { value: 'sk', flags: 'fpv', longValue: ['signal', 'kill-after'], longFlags: ['preserve-status', 'foreground', 'verbose'], positional: 1 }

export const WRAPPERS: Readonly<Record<string, WrapperOptions>> = {
  env: { value: 'uCP', flags: 'iv0', longValue: ['unset', 'chdir'], longFlags: ['ignore-environment', 'null', 'debug'] },
  exec: { value: 'a', flags: 'cl' },
  command: { flags: 'p', stops: 'vV' },
  builtin: {},
  nohup: {},
  sudo: {
    value: 'CDgpRrTtUu',
    // -s and -i hand the command to a shell's -c, so they are left out: the
    // statement is then not placed.
    flags: 'ABbEHknPS',
    stops: 'eKlVv',
    longValue: ['user', 'group', 'prompt', 'chdir', 'chroot', 'close-from', 'host', 'other-user', 'role', 'type', 'command-timeout'],
    longFlags: [
      'askpass', 'background', 'bell', 'preserve-env', 'set-home', 'non-interactive', 'preserve-groups', 'stdin', 'remove-timestamp',
      'reset-timestamp',
    ],
    longStops: ['edit', 'list', 'validate', 'version', 'help'],
  },
  doas: { value: 'Cu', flags: 'ns', stops: 'L' },
  time: { value: 'fo', flags: 'ahlpqv', longValue: ['format', 'output'], longFlags: ['portability', 'verbose', 'append', 'quiet'] },
  nice: { value: 'n', longValue: ['adjustment'], numeric: true },
  ionice: { value: 'cn', flags: 't', stops: 'pPu' },
  xargs: {
    value: 'EILJRSPdnsa',
    flags: '0oprtx',
    longValue: ['max-args', 'max-procs', 'max-chars', 'max-lines', 'delimiter', 'arg-file', 'process-slot-var', 'eof'],
    longFlags: ['null', 'no-run-if-empty', 'verbose', 'interactive', 'exit', 'open-tty'],
  },
  timeout: TIMEOUT,
  gtimeout: TIMEOUT,
  stdbuf: { value: 'ioe', longValue: ['input', 'output', 'error'] },
  caffeinate: { value: 'tw', flags: 'dimsu' },
  chronic: { flags: 'ev' },
  unbuffer: { flags: 'p' },
  flock: {
    value: 'wE',
    flags: 'sxunoF',
    longValue: ['timeout', 'wait', 'conflict-exit-code'],
    longFlags: ['shared', 'exclusive', 'unlock', 'nonblock', 'nb', 'close', 'no-fork', 'verbose'],
    positional: 1,
  },
  setsid: { flags: 'cfw', longFlags: ['ctty', 'fork', 'wait'] },
  watch: {
    value: 'n',
    flags: 'bcdegprtwx',
    longValue: ['interval'],
    longFlags: ['beep', 'color', 'no-color', 'differences', 'errexit', 'chgexit', 'precise', 'no-title', 'no-wrap', 'exec'],
  },
}

// git's and gh's global options that take their value as the next word.
export const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path',
])
const GLOBAL_VALUE_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  git: GIT_VALUE_OPTIONS,
  gh: new Set(['-R', '--repo']),
}

// A script in a statement this deep (substitutions, scripts and heredoc
// bodies counted) is not read, and the `depth` unknown is set.
const MAX_DEPTH = 4

// A word's command name: its last path part, lowercased, the escape mark
// removed.
export const nameOf = (word: string): string => {
  const plain = word.replaceAll(ESCAPED, '').replaceAll(UNQUOTED, '')
  return plain.slice(plain.lastIndexOf('/') + 1).toLowerCase()
}

export const isEscaped = (word: string): boolean => word.includes(ESCAPED)

// Whether a command word's text comes, even in part, from an expansion or a
// substitution, other than a plain variable prefix before a literal path,
// written inside double quotes. `$_` is where a substitution stood, so it is
// never a plain prefix. `word` carries the lexer's UNQUOTED marks: an
// unquoted expansion is split into words, and a substitution's text is known
// only at run time, so neither is ever plain.
const PLAIN_PREFIX = /^(\$(?!_\/)[A-Za-z_][A-Za-z0-9_]*|\$\{[A-Za-z_][A-Za-z0-9_]*\})\/[^$`]*$/
export const isExpanded = (word: string): boolean => /[$`]/.test(word) && (word.includes(UNQUOTED) || !PLAIN_PREFIX.test(word))

// What one read of a line collects: every heredoc, by index, and every unknown.
// `isCompat` reads as the commit gate of 77bb2f3 did (commandsOf).
type Reading = { heredocs: ShellHeredoc[]; unknowns: Set<ShellUnknown>; isCompat?: boolean }

const ANSI_CONTROLS: Record<string, string> = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' }

// The text of a $'…' string, its \xHH, \NNN and one-letter escapes decoded,
// and any other escape (\u, \U, \c, ...) kept as written, which `onKept`
// hears. Decoding is only for matching: a word with any escape is marked
// ESCAPED anyway.
function decodeAnsi(raw: string, onKept: () => void = () => undefined): string {
  return raw.replace(/\\(x[0-9A-Fa-f]{1,2}|[0-7]{1,3}|.)/gs, (whole, escape: string) => {
    if (escape.startsWith('x')) {
      if (escape === 'x') onKept()
      return String.fromCharCode(parseInt(escape.slice(1), 16))
    }
    if (/^[0-7]/.test(escape)) return String.fromCharCode(parseInt(escape, 8))
    if (escape in ANSI_CONTROLS) return ANSI_CONTROLS[escape] as string
    if (/^['"\\?]$/.test(escape)) return escape
    onKept()
    return whole
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
//
// Inside case…esac a `)` ends a pattern, not the substitution, so the case
// words are counted (`$(case x in x) cmd;; esac)`).
// FROZEN compat branch: delete only, once the bash/zsh check retires compat.
function closingParen(line: string, from: number, countsCases = true): number {
  let depth = 1
  let cases = 0
  for (let i = from; i < line.length; i++) {
    const c = line[i]
    const isWord = (name: string) => line.startsWith(name, i) && isWordStart(line, i) && /[ \t\n;&|()]/.test(line[i + name.length] ?? ' ')
    // A case counts only where a command starts, as `case WORD in`.
    const isCase = () => /^case[ \t\n]+[^ \t\n]+[ \t\n]+in([ \t\n]|$)/.test(line.slice(i)) && /(^|[;&|(\n])[ \t\n]*$/.test(line.slice(from, i))
    // The compat reading (commandsOf) counts no case.
    // FROZEN compat branch: delete only, once the bash/zsh check retires compat.
    if (countsCases && isWord('case') && isCase()) cases++
    // FROZEN compat branch: delete only, once the bash/zsh check retires compat.
    else if (countsCases && isWord('esac') && cases > 0) cases--
    if (c === '\\') i++
    else if (c === '$' && line[i + 1] === "'") i = closingAnsiQuote(line, i + 2)
    else if (c === "'") i = line.indexOf("'", i + 1) === -1 ? line.length : line.indexOf("'", i + 1)
    else if (c === '"') {
      for (i++; i < line.length && line[i] !== '"'; i++) if (line[i] === '\\') i++
    } else if (c === '(') depth++
    else if (c === ')' && !(depth === 1 && cases > 0) && --depth === 0) return i
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

// The text of a backtick substitution as bash reads it: a backslash before
// ` \ or $ is removed first, so ``echo `echo \`cmd\``` runs cmd.
const backtickText = (raw: string): string => raw.replace(/\\([\\`$])/g, '$1')

// The commands of every $( ) and backtick in `text`, as lines of their own.
// FROZEN compat branch: delete only, once the bash/zsh check retires compat.
function substitutionsOf(text: string, isCompat = false): string[] {
  const inner: string[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === '$' && text[i + 1] === '(') {
      // FROZEN compat branch: delete only, once the bash/zsh check retires compat.
      const end = closingParen(text, i + 2, !isCompat)
      inner.push(text.slice(i + 2, end))
      i = end
    } else if (text[i] === '`') {
      const end = closingTick(text, i + 1)
      // FROZEN compat branch: delete only, once the bash/zsh check retires compat.
      inner.push(isCompat ? text.slice(i + 1, end) : backtickText(text.slice(i + 1, end)))
      i = end
    }
  }
  return inner
}

// What the heredoc scanner is inside: unquoted text (the line itself, a $( ),
// or a backtick), a quoted string ('' or ""), or arithmetic, where << is a
// shift. A $'…' string is skipped whole, through closingAnsiQuote.
type Context = 'top' | '$(' | '`' | "'" | '"' | '(('

// Whether a word starts at `i`: a `#` there opens a comment, and `((` there
// opens arithmetic.
const isWordStart = (text: string, i: number): boolean => i === 0 || /[ \t\n;&|()]/.test(text[i - 1] as string)

// The delimiter of a heredoc whose word starts at `from`, built as bash builds
// it: every part of the word joined, quoted or not, with the quotes and
// backslashes removed (`E'OF'` is EOF), and a $'…' part decoded ($'EOF' is
// EOF). Any quoting at all means the body is not expanded. A $'…' part with an
// escape the reader keeps undecoded gets a NUL, which no row matches, so the
// heredoc stays open and the line is refused.
function delimiterAt(text: string, from: number, isCompat = false): { delimiter: string; isQuoted: boolean; end: number } {
  let delimiter = ''
  let isQuoted = false
  let i = from
  while (i < text.length && !/[ \t\n;&|<>()]/.test(text[i] as string)) {
    const c = text[i] as string
    // FROZEN compat branch: the gate of 77bb2f3 read $'…' here as a `$` and a
    // '…' string, so compat skips this decode.
    if (c === '$' && text[i + 1] === "'" && !isCompat) {
      const close = closingAnsiQuote(text, i + 2)
      let isKept = false
      delimiter += decodeAnsi(text.slice(i + 2, close), () => (isKept = true)) + (isKept ? '\0' : '')
      isQuoted = true
      i = close + 1
    } else if (c === "'") {
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

// The paths `source` and `.` read stdin through.
const STDIN_PATHS: ReadonlySet<string> = new Set(['/dev/stdin', '/dev/fd/0', '/proc/self/fd/0', '-'])

// Whether a heredoc feeds a shell or eval, so its body is a script: a shell or
// eval word in the text before its operator, back to the last ; & | or line
// end. A substitution does not end that text, because `eval "$(cat <<EOF`
// runs the body too. `source` or `.` with a path that reads stdin runs it as
// well. Quotes and backslashes go before the compare, so `b\ash` is bash.
function feedsShell(before: string): boolean {
  const segment = before.split(/;|&|\||\n/).pop() ?? ''
  const words = segment.replace(/["'\\]/g, '').split(/[ \t\n]+/)
  return words.some(
    (word, k) =>
      SHELLS.has(nameOf(word)) ||
      nameOf(word) === 'eval' ||
      ((word === 'source' || word === '.') && STDIN_PATHS.has(words[k + 1] ?? '')),
  )
}

// The text kept from one heredoc body, and where the body stood in the line.
type Body = { at: number; script: string }

// `text` with each heredoc body taken out before it is read as shell, and the
// text kept from bodies. A body is the text of a file or a
// message, not commands: an apostrophe in it would open a quote that swallows
// the commands after it, and a line in it that starts with `git push` is not
// a push. So the body and its delimiter line go, and the operator becomes a
// `<` redirect whose target marks the heredoc, which the reader takes out.
// Bash still runs what a body feeds a shell, and the $( ) and backticks of a
// body whose delimiter is unquoted, so those are kept as a script of their
// own, with `at`, where the body stood in the line. The lexer reads each
// script apart, so a quote, substitution, array or case left open in a body
// never reaches the line after it.
//
// It scans the whole text as one command, as bash does, so an operator counts
// only where bash would read one: never inside a quoted string, on any line it
// spans; never in a comment; and never in arithmetic ($(( )), (( )) or let),
// where << is a shift. A here-string (<<<) is not a heredoc. The bodies start
// after the next unquoted line end, in the operators' order.
function heredocBodiesOut(text: string, reading: Reading): { line: string; bodies: Body[] } {
  let out = ''
  const bodies: Body[] = []
  const stack: Context[] = ['top']
  // How deep each open arithmetic is in its own parentheses.
  const depths: number[] = []
  let pending: ShellHeredoc[] = []
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
    // $[ ] is old arithmetic, where << is a shift.
    if (c === '$' && next === '[' && closingBracket(text, i + 2) < text.length && isArithmetic(text.slice(i + 2, closingBracket(text, i + 2)))) {
      const end = closingBracket(text, i + 2)
      out += text.slice(i, end + 1)
      i = end
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
    } else if (c === '<' && next === '<' && !/^[ \t\n]*let([ \t\n]|$)/.test(out.split(/[;&|\n(]/).pop() ?? '')) {
      let from = i + 2
      const stripsTabs = text[from] === '-'
      if (stripsTabs) from++
      while (text[from] === ' ' || text[from] === '\t') from++
      const { delimiter, isQuoted, end } = delimiterAt(text, from, reading.isCompat)
      if (delimiter === '') {
        out += '<<'
        i++
      } else {
        const doc: ShellHeredoc = { delimiter, body: '', isQuoted, stripsTabs, feedsShell: feedsShell(out), isTerminated: false }
        reading.heredocs.push(doc)
        pending.push(doc)
        out += `<${HEREDOC}${reading.heredocs.length - 1}`
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
          if ((doc.stripsTabs ? row.replace(/^\t+/, '') : row) === doc.delimiter) {
            doc.isTerminated = true
            break
          }
          body.push(row)
        }
        doc.body = body.join('\n')
        // FROZEN compat branch: delete only, once the bash/zsh check retires compat.
        const expanded = doc.isQuoted ? [] : substitutionsOf(doc.body, reading.isCompat)
        // The outer shell runs the $( ) and backticks of an unquoted body it
        // feeds a shell before the inner shell reads it, inside '…' too, so
        // the exact reading keeps them beside the body.
        const kept = doc.feedsShell ? (reading.isCompat ? body : [...body, ...expanded]) : expanded
        // The outer shell changes an unquoted body in exactly three ways (bash
        // manual, Here Documents): it expands every $ (parameters, $( ) and
        // $(( ))), it runs backticks, and it removes a backslash before \, $,
        // a backtick or a newline. So $, ` and \ are the complete set of
        // characters it processes, and a body without them reaches the inner
        // shell byte for byte. With any of them, the exact reading cannot name
        // the commands: a `;` in a $X value becomes code, $((X)) can run a
        // $( ) through an array subscript, and `re\set` reaches the inner
        // shell as `reset`. The $( ) and backticks are still read above.
        if (doc.feedsShell && !doc.isQuoted && !reading.isCompat && /[$`\\]/.test(doc.body)) reading.unknowns.add('expansion')
        const script = kept.map(row => `${row}\n`).join('')
        // FROZEN compat branch: delete only, once the bash/zsh check retires compat.
        // The gate of 77bb2f3 read a kept body inline, as part of the line.
        if (reading.isCompat) out += script
        else if (kept.length > 0) bodies.push({ at: out.length, script })
      }
      pending = []
      i = at - 1
    } else {
      out += c
    }
  }
  // A heredoc whose line ends the text has no body yet.
  if (reading.heredocs.some(doc => !doc.isTerminated)) reading.unknowns.add('heredoc')
  return { line: out, bodies }
}

// One simple command as the lexer reads it: its words, each escaped word
// carrying the ESCAPED mark, its redirects and heredocs, and where it was read.
// `pipedFrom` is the command whose output it reads through a pipe.
type Raw = {
  words: string[]
  redirects: ShellRedirect[]
  heredocs: ShellHeredoc[]
  source: ShellSource
  depth: number
  isCertain: boolean
  pipedFrom?: Raw
}

// The redirect operators, longest first. Only these shapes are read, so a
// following `|`, `&` or `-` is never taken into an operator (`>&-|cmd`).
const OPERATORS = ['&>>', '&>', '<<<', '<<-', '<<', '<>', '<&', '<', '>>', '>&', '>|', '>']

// The index of the first `)` of the `))` that closes arithmetic whose text
// starts at `from`, or -1 when a lone `)` closes it first, which makes it a
// subshell rather than arithmetic.
function closingArithmetic(line: string, from: number): number {
  let depth = 0
  for (let i = from; i < line.length; i++) {
    const c = line[i]
    if (c === '\\') i++
    else if (c === '(') depth++
    else if (c === ')' && depth > 0) depth--
    else if (c === ')') return line[i + 1] === ')' ? i : -1
  }
  return line.length
}

// Whether text reads as arithmetic: no ; newline quote backslash or
// backtick, and no two words side by side. Anything else is read as the old
// reader read it, as commands, so text bash may run is never hidden as
// arithmetic.
// The text of each $( ) and backtick in it is read on its own (substitutionsOf),
// so it is left out of the test.
const isArithmetic = (body: string): boolean => {
  let plain = body
  for (const inner of substitutionsOf(body)) plain = plain.replace(inner, '')
  return !/[;\n'"\\`]/.test(plain) && !/[\w$}\]][ \t\n]+[\w$]/.test(plain)
}

// closingArithmetic, or -1 when the text there does not read as arithmetic.
function arithmeticEnd(line: string, from: number): number {
  const end = closingArithmetic(line, from)
  return end !== -1 && isArithmetic(line.slice(from, end)) ? end : -1
}

// The index of the `]` that closes a $[ ] whose text starts at `from`.
function closingBracket(line: string, from: number): number {
  let depth = 0
  for (let i = from; i < line.length; i++) {
    if (line[i] === '[') depth++
    else if (line[i] === ']' && depth-- === 0) return i
  }
  return line.length
}

// `>` and `<` that bash reads as text in `text`, as redirects that are not real.
const textual = (text: string): ShellRedirect[] => [...text.matchAll(/[<>]/g)].map(m => ({ op: m[0], fd: '', target: '', isReal: false }))

// The simple commands of `text` in reading order, a substitution's before the
// command it stands in. Heredoc bodies are taken out first (heredocBodiesOut).
//
// `isBody` is true for the text of a heredoc body, so a substitution read in
// it keeps the `heredoc` source.
function lex(text: string, reading: Reading, source: ShellSource, depth: number, isCertain: boolean, isBody = false, carried: Body[] = []): Raw[] {
  const own = heredocBodiesOut(text, reading)
  // The bodies still to read, in the order they stood.
  const bodies = [...own.bodies, ...carried].sort((a, b) => a.at - b.at)
  // Off in the compat reading, which reads as the gate of 77bb2f3 did.
  const exact = !reading.isCompat
  const line = own.line
  const nestedSource: ShellSource = isBody ? 'heredoc' : 'substitution'
  const commands: Raw[] = []
  let words: string[] = []
  let redirects: ShellRedirect[] = []
  let heredocs: ShellHeredoc[] = []
  let word = ''
  let hasWord = false
  // Where the command's first character stands in `line`, or -1.
  let start = -1
  // Once a && or || or a branch keyword is read, no later command is certain.
  let isUncertain = !isCertain
  // The redirect whose target is the next word, which is taken out.
  let target: ShellRedirect | undefined
  // Whether the word was written with no quote or backslash, as a reserved
  // word must be.
  let isBare = true
  // Inside [[ ]], < and > are words of the test, not redirects. A && || | ( )
  // there still splits the statement, as the old reader did, so a command
  // is never hidden in a test, and the test goes on to its ]].
  let isTest = false
  // Whether every word so far is a bare reserved word with no redirect before
  // it, so the next bare word stands where bash reads a reserved word.
  let isHead = true
  // The last command read at this level, and whether the next reads its output.
  let last: Raw | undefined
  let isPiped = false
  // Inside `name=( … )` the items are one assignment word: bash runs no
  // command there, only the substitutions in it.
  let isArray = false
  // How many case…esac are open, and whether a case pattern comes next, as
  // after `case x in` and each `;;`. A pattern is text, never a command.
  let cases = 0
  let isPattern = false
  // Where in the command's words a reserved `case` stands, or -1. A quoted
  // or escaped `case` is an ordinary command name, and opens no case.
  let caseAt = -1
  const endWord = () => {
    if (isPattern && hasWord && isBare && word === 'esac' && words.length === 0) {
      isPattern = false
      cases--
    }
    if (hasWord && target === undefined) {
      const isReserved = isHead && isBare
      words.push(word)
      // FROZEN compat branch: delete only, once the bash/zsh check retires compat.
      if (exact && isReserved && word === 'case') caseAt = words.length - 1
      if (exact && isReserved && word === '[[') isTest = true
      else if (isTest && isBare && word === ']]') isTest = false
      isHead = isReserved && (KEYWORDS.has(word) || word === 'time' || (word === '-p' && words.at(-2) === 'time'))
    }
    if (hasWord && target !== undefined) {
      const plain = word.replaceAll(ESCAPED, '').replaceAll(UNQUOTED, '')
      const doc = plain.startsWith(HEREDOC) ? reading.heredocs[Number(plain.slice(1))] : undefined
      if (doc !== undefined && target.op === '<') {
        target.op = doc.stripsTabs ? '<<-' : '<<'
        target.target = doc.delimiter
        heredocs.push(doc)
        redirects.push(...textual(doc.body))
      } else {
        target.target = plain
      }
      target = undefined
    }
    word = ''
    hasWord = false
    isBare = true
  }
  const endCommand = () => {
    endWord()
    target = undefined
    isTest = false
    isHead = true
    if (words.length > 0 || redirects.length > 0) {
      const head = nameOf(words.find(w => !ASSIGNMENT.test(w)) ?? '')
      const command: Raw = {
        words,
        redirects,
        heredocs,
        source,
        depth,
        isCertain: !isUncertain && !['then', 'else', 'elif', 'do', 'case', 'for', 'select', 'function'].includes(head),
        ...(isPiped && last !== undefined ? { pipedFrom: last } : {}),
      }
      commands.push(command)
      last = command
      if (BRANCHES.has(head)) isUncertain = true
      // `case x in` ended here, so its first pattern is still to come. A
      // pattern on the same line, as in `case x in y)`, is read with it.
      if (caseAt !== -1 && words[caseAt + 2] === 'in') {
        cases++
        isPattern = words.length === caseAt + 3
      }
    }
    caseAt = -1
    isPiped = false
    words = []
    redirects = []
    heredocs = []
    start = -1
  }
  // A substitution's commands go in the list, and the outer word goes on.
  // A body that stood inside the substitution, as in `eval "$(cat <<E`, is
  // read there. `from` is where the inner text starts in `line`.
  const substitute = (inner: string, from: number) => {
    const moved = bodies.filter(b => b.at >= from && b.at <= from + inner.length)
    bodies.splice(0, bodies.length, ...bodies.filter(b => !moved.includes(b)))
    const shifted = moved.map(b => ({ at: b.at - from, script: b.script }))
    commands.push(...lex(inner, reading, nestedSource, depth + 1, !isUncertain, isBody, shifted))
    word += SUBSTITUTED
    hasWord = true
  }
  // Arithmetic is no command: its < > are text, and only its substitutions
  // run.
  const arithmetic = (body: string) => {
    for (const inner of substitutionsOf(body)) commands.push(...lex(inner, reading, nestedSource, depth + 1, !isUncertain, isBody))
    redirects.push(...textual(body))
  }
  // The heredoc bodies kept from the line, each read as a script of its own
  // once the lexer reaches where it stood.
  const readBodies = (upTo: number) => {
    while (bodies.length > 0 && (bodies[0] as Body).at <= upTo) {
      endCommand()
      commands.push(...lex((bodies.shift() as Body).script, reading, 'heredoc', depth + 1, !isUncertain, true))
    }
  }
  for (let i = 0; i < line.length; i++) {
    readBodies(i)
    const c = line[i] as string
    const next = line[i + 1]
    if (start === -1 && !/[ \t\n]/.test(c) && !';&|()'.includes(c)) start = i
    if (c === '\\') {
      isBare = false
      if (next !== '\n') {
        word += next ?? ''
        hasWord = true
        if (next === '>' || next === '<') redirects.push(...textual(next))
      }
      i++
    } else if (c === "'") {
      isBare = false
      const end = line.indexOf("'", i + 1)
      if (end === -1) reading.unknowns.add('quote')
      const quoted = line.slice(i + 1, end === -1 ? line.length : end)
      word += quoted
      redirects.push(...textual(quoted))
      hasWord = true
      i = end === -1 ? line.length : end
    } else if (c === '"') {
      hasWord = true
      isBare = false
      for (i++; i < line.length && line[i] !== '"'; i++) {
        const d = line[i] as string
        const close = d === '$' && line[i + 1] === '(' && line[i + 2] === '(' ? arithmeticEnd(line, i + 3) : -1
        if (d === '\\' && i + 1 < line.length && '"\\$`'.includes(line[i + 1] as string)) {
          word += line[++i]
        } else if (close !== -1) {
          if (close === line.length) reading.unknowns.add('substitution')
          arithmetic(line.slice(i + 3, close))
          word += SUBSTITUTED
          i = close + 1
        // FROZEN compat branch: delete only, once the bash/zsh check retires compat.
        } else if (exact && d === '$' && line[i + 1] === '[' && isArithmetic(line.slice(i + 2, closingBracket(line, i + 2)))) {
          const end = closingBracket(line, i + 2)
          if (end === line.length) reading.unknowns.add('substitution')
          arithmetic(line.slice(i + 2, end))
          word += SUBSTITUTED
          i = end
        } else if (d === '$' && line[i + 1] === '(') {
          // FROZEN compat branch: delete only, once the bash/zsh check retires compat.
          const end = closingParen(line, i + 2, exact)
          if (end === line.length) reading.unknowns.add('substitution')
          substitute(line.slice(i + 2, end), i + 2)
          i = end
        } else if (d === '`') {
          const end = closingTick(line, i + 1)
          if (end === line.length) reading.unknowns.add('substitution')
          // FROZEN compat branch: delete only, once the bash/zsh check retires compat.
          substitute(exact ? backtickText(line.slice(i + 1, end)) : line.slice(i + 1, end), i + 1)
          i = end
        } else {
          word += d
          redirects.push(...textual(d))
        }
      }
      if (i >= line.length) reading.unknowns.add('quote')
    } else if (c === '$' && next === '"') {
      // $"…" is bash's locale string: read as "…", which in practice it is.
      continue
    } else if (c === '$' && next === "'") {
      isBare = false
      const end = closingAnsiQuote(line, i + 2)
      if (end === line.length) reading.unknowns.add('quote')
      const raw = line.slice(i + 2, end)
      word += decodeAnsi(raw, () => reading.unknowns.add('escape')) + (raw.includes('\\') ? ESCAPED : '')
      redirects.push(...textual(raw))
      hasWord = true
      i = end
    } else if (c === '$' && next === '(' && line[i + 2] === '(' && arithmeticEnd(line, i + 3) !== -1) {
      const end = arithmeticEnd(line, i + 3)
      if (end === line.length) reading.unknowns.add('substitution')
      arithmetic(line.slice(i + 3, end))
      word += SUBSTITUTED
      hasWord = true
      i = end + 1
    // FROZEN compat branch: delete only, once the bash/zsh check retires compat.
    } else if (exact && c === '$' && next === '[' && isArithmetic(line.slice(i + 2, closingBracket(line, i + 2)))) {
      const end = closingBracket(line, i + 2)
      if (end === line.length) reading.unknowns.add('substitution')
      arithmetic(line.slice(i + 2, end))
      word += SUBSTITUTED
      hasWord = true
      i = end
    // FROZEN compat branch: delete only, once the bash/zsh check retires compat.
    } else if (exact && c === '(' && next === '(' && !hasWord && !isTest && arithmeticEnd(line, i + 2) !== -1) {
      // An arithmetic command, `(( … ))`, is the word `((`.
      const end = arithmeticEnd(line, i + 2)
      if (end === line.length) reading.unknowns.add('substitution')
      words.push('((')
      arithmetic(line.slice(i + 2, end))
      i = end + 1
      // Bash allows nothing after it but a redirect or a separator, so a word
      // after it is read as a command of its own.
      if (/^[ \t]*[^ \t\n;&|()<>]/.test(line.slice(i + 1))) endCommand()
    } else if (isTest && (c === '<' || c === '>') && !(hasWord && isBare && word === ']]')) {
      // A < or > in a test compares strings. A ]] right before it ends the
      // test, so then it is a redirect.
      endWord()
      words.push(c)
      redirects.push(...textual(c))
    } else if ((c === '$' || c === '<' || c === '>') && next === '(') {
      // FROZEN compat branch: delete only, once the bash/zsh check retires compat.
      const end = closingParen(line, i + 2, exact)
      if (end === line.length) reading.unknowns.add('substitution')
      substitute(line.slice(i + 2, end), i + 2)
      i = end
    } else if (c === '`') {
      const end = closingTick(line, i + 1)
      if (end === line.length) reading.unknowns.add('substitution')
      // FROZEN compat branch: delete only, once the bash/zsh check retires compat.
      substitute(exact ? backtickText(line.slice(i + 1, end)) : line.slice(i + 1, end), i + 1)
      i = end
    } else if (c === '<' || c === '>' || (c === '&' && next === '>')) {
      // A word of digits before it is the file descriptor, not a word.
      let fd = ''
      if (/^\d+$/.test(word)) {
        fd = word
        word = ''
        hasWord = false
      }
      endWord()
      isHead = false
      let op = OPERATORS.find(shape => line.startsWith(shape, i)) as string
      // FROZEN compat branch: delete only, once the bash/zsh check retires compat.
      if (reading.isCompat) op = c + ((/^[<>&|-]*/.exec(line.slice(i + 1)) as RegExpExecArray)[0] ?? '')
      i += op.length - 1
      target = { op, fd, target: '', isReal: true }
      redirects.push(target)
    } else if (isArray && (c === ' ' || c === '\t' || c === '\n' || c === ')')) {
      word += c
      isArray = c !== ')'
    } else if (exact && c === '(' && hasWord && /^[A-Za-z_][A-Za-z0-9_]*\+?=$/.test(word) && words.every(w => ASSIGNMENT.test(w))) {
      // `x=(a b)` and `x+=(c)` assign an array.
      word += c
      isArray = true
    } else if (isPattern && (c === '|' || c === '(' || c === ')')) {
      // A pattern's words are dropped at its `)`, and the branch's commands
      // follow. Its substitutions were read where they stood.
      if (c === ')') {
        word = ''
        hasWord = false
        isBare = true
        words = []
        redirects = []
        start = -1
        isPattern = false
      } else {
        endWord()
      }
    } else if (cases > 0 && c === ';' && (next === ';' || next === '&')) {
      // `;;`, `;&` and `;;&` end a case branch, and a pattern comes next.
      endCommand()
      isPattern = true
      i += line.startsWith(';;&', i) ? 2 : 1
    } else if (c === '#' && !hasWord) {
      const end = line.indexOf('\n', i)
      i = end === -1 ? line.length : end - 1
    } else if (c === ' ' || c === '\t' || c === '\n') {
      // A pattern never spans a line, so its words are read as a command,
      // and the reading goes on as if no pattern had begun.
      // An `esac` there closes the case first.
      endWord()
      if (c === '\n' && isPattern && words.length > 0) isPattern = false
      if (c === '\n') endCommand()
      // `function f` ends the definition's own command: its body follows.
      if (words.length === 2 && words[0] === 'function') endCommand()
    } else if (c === '|' && next !== '|') {
      // `|` and `|&` pipe this command's output to the next.
      endWord()
      const keep: boolean = isTest
      endCommand()
      isTest = keep
      isPiped = true
      // FROZEN compat branch: delete only, once the bash/zsh check retires compat.
      if (exact && next === '&') i++
    } else if ((c === '&' || c === '|') && next === c) {
      endWord()
      const keep: boolean = isTest
      endCommand()
      isTest = keep
      isUncertain = true
      i++
    } else if (';&|()'.includes(c)) {
      // `name()` defines a function, whose body may never run.
      if (c === '(' && words.length + (hasWord ? 1 : 0) === 1 && /^[ \t\n]*\)/.test(line.slice(i + 1))) isUncertain = true
      // A | ( ) in a test splits the statement, and the test goes on.
      endWord()
      const keep: boolean = isTest && c !== ';' && c !== '&'
      endCommand()
      isTest = keep
    } else {
      word += exact && c === '$' ? UNQUOTED + c : c
      hasWord = true
    }
  }
  endCommand()
  readBodies(line.length)
  // An array or case still open where its script ends is a syntax error bash
  // runs nothing of, and the reader cannot tell where it was meant to end.
  if (isArray || cases > 0) reading.unknowns.add('compound')
  return commands
}

// The simple commands of a shell line, each as its words, quotes removed and
// escaped words marked, and the commands of every substitution in it, read on
// their own. A quoted word stays one word, so `echo "git push"` holds no git
// command. A command of redirects alone is left out.
//
// `isCompat` reads the line as the commit gate of 77bb2f3 did, before this
// reader read bash more exactly: a run of < > & | - after a redirect is one
// operator and the next word its target, a case `)` closes a $( ), backtick
// text keeps its backslashes, `|&` is a pipe then an `&`, and arithmetic and
// [[ ]] tests are read as plain commands. Each of those can find fewer
// commands than the old reading did. The `function f` split only adds a
// command, so both readings share it. parseShell never reads the compat way.
// The commit gate reads both ways and keeps the larger count, so it never
// finds fewer commits than that gate did (tests/shell-gate-differential.test.ts
// holds it to that).
//
// THE COMPAT READING IS FROZEN. Every branch that reads the flag is marked
// FROZEN, and the only change allowed at one is its deletion. It exists only
// because no check yet runs a line to see what bash really runs. Once an
// executable check runs each line the exact reading counts lower in bash and
// zsh, in a sandbox with a recording git shim, compat is deleted (README,
// "The shell reader").
export function commandsOf(text: string, isCompat = false): string[][] {
  return lex(text, { heredocs: [], unknowns: new Set(), isCompat }, 'line', 0, true)
    .filter(raw => raw.words.length > 0)
    .map(raw => raw.words.map(word => word.replaceAll(UNQUOTED, '')))
}

// Where the command a wrapper runs starts, in words, from `at` (the wrapper
// word). `words` carry their escape marks. `stops` is true when an option says
// the wrapper runs no command, and `isPlaced` false when an option is not in
// the wrapper's table.
function pastWrapper(words: readonly string[], at: number): { next: number; stops: boolean; isPlaced: boolean } {
  const options = WRAPPERS[nameOf(words[at] ?? '')] as WrapperOptions
  // A watch without -x runs its words through `sh -c`.
  let isPlaced = nameOf(words[at] ?? '') !== 'watch' || words.slice(at + 1).some(word => /^-[^-]*x/.test(word) || word === '--exec')
  let i = at + 1
  while (i < words.length) {
    // An escaped option may decode to any option, so it is read as written
    // and leaves the statement unplaced.
    if (isEscaped(words[i] as string)) isPlaced = false
    const word = (words[i] as string).replaceAll(ESCAPED, '').replaceAll(UNQUOTED, '')
    if (word === '--') {
      i++
      break
    }
    if (word.startsWith('--')) {
      const [name = '', value] = word.slice(2).split(/=(.*)/s)
      if (options.longStops?.includes(name)) return { next: i, stops: true, isPlaced }
      if (options.longValue?.includes(name) && value === undefined) i++
      // A long name the table does not list exactly is not placed, with or
      // without an `=value`. getopt_long takes any unambiguous prefix of a
      // name, so `--spl=…` is env's --split-string, which runs its value as
      // the command, and a prefix of a listed name may be another option.
      else if (!options.longValue?.includes(name) && !options.longFlags?.includes(name)) isPlaced = false
      i++
      continue
    }
    if (!word.startsWith('-') || word === '-') {
      if (word === '-' && nameOf(words[at] ?? '') === 'env') {
        i++
        continue
      }
      break
    }
    if (options.numeric && /^-\d+$/.test(word)) {
      i++
      continue
    }
    for (let j = 1; j < word.length; j++) {
      const letter = word[j] as string
      if (options.stops?.includes(letter)) return { next: i, stops: true, isPlaced }
      if (options.value?.includes(letter)) {
        // The rest of the cluster is the value, or else the next word is.
        if (j === word.length - 1) i++
        break
      }
      if (!options.flags?.includes(letter)) isPlaced = false
    }
    i++
  }
  i = Math.min(i + (options.positional ?? 0), words.length)
  // An option after the positional words, such as flock's `-c <script>`
  // after its lock file, is not read.
  if ((options.positional ?? 0) > 0 && (words[i] ?? '').replaceAll(ESCAPED, '').startsWith('-')) isPlaced = false
  return { next: i, stops: false, isPlaced }
}

// The index in args of a git or gh subcommand, past the global options.
function subcommandAt(name: string, args: readonly string[]): number {
  if (!Object.hasOwn(GLOBAL_VALUE_OPTIONS, name)) return -1
  const valueOptions = GLOBAL_VALUE_OPTIONS[name] as ReadonlySet<string>
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (!arg.startsWith('-')) return i
    if (valueOptions.has(arg)) i++
  }
  return -1
}

// A statement from one lexed command, or undefined for one that holds nothing
// but keywords.
function statementOf(raw: Raw, reading: Reading): ShellStatement | undefined {
  const marked = raw.words
  const words = marked.map(word => word.replaceAll(ESCAPED, '').replaceAll(UNQUOTED, ''))
  const assignments: string[] = []
  const wrappers: string[] = []
  let isPlaced = true
  let at = 0
  while (at < words.length) {
    const word = words[at] as string
    const name = nameOf(word)
    if (ASSIGNMENT.test(word)) {
      assignments.push(word)
      at++
    } else if (name === 'coproc' && words[at + 2] === '{') {
      // `coproc NAME { … }`: NAME names the coprocess, and the body runs.
      at += 2
    } else if (KEYWORDS.has(name) || CLOSERS.has(name)) {
      at++
    } else if (Object.hasOwn(WRAPPERS, name)) {
      const past = pastWrapper(marked, at)
      isPlaced &&= past.isPlaced
      // A wrapper that runs no command, or has none after it, is the command.
      if (past.stops || past.next >= words.length) break
      wrappers.push(name)
      at = past.next
    } else {
      break
    }
  }
  if (!isPlaced) reading.unknowns.add('wrapper')
  const nameAt = at < words.length ? at : -1
  const name = nameAt === -1 ? '' : nameOf(words[nameAt] as string)
  // A name from a variable or a substitution is only known at run time, and
  // so is a command word with an expansion anywhere in it: `${X:-/bin/rm}`
  // keeps a slash inside its braces, so its last path part reads as `rm}`.
  // The one shape allowed is a plain `$NAME/` or `${NAME}/`, inside double
  // quotes, in front of a literal path (`"$HOME"/bin/x`,
  // `"${CLAUDE_PLUGIN_ROOT}/scripts/x.sh"`).
  if (nameAt !== -1 && isExpanded((marked[nameAt] as string).replaceAll(ESCAPED, ''))) reading.unknowns.add('expansion')
  if (nameAt === -1 && assignments.length === 0 && raw.redirects.length === 0) return undefined
  const args = nameAt === -1 ? [] : words.slice(nameAt + 1)
  return {
    words,
    nameAt,
    name,
    args,
    assignments,
    wrappers,
    subcommandAt: subcommandAt(name, args),
    isPlaced,
    escaped: marked.flatMap((word, i) => (isEscaped(word) ? [i] : [])),
    isCertain: raw.isCertain,
    redirects: raw.redirects,
    heredocs: raw.heredocs,
    source: raw.source,
    depth: raw.depth,
  }
}

// What a shell's arguments run, read as the shell reads its options: with -c
// (in any cluster), the first operand after the options is the script, `--`
// and `-` end the options, and -o, -O, --rcfile and --init-file take a value.
// `readsStdin` is true when there is no script and no script file, or -s.
export function shellScriptOf(args: readonly string[]): { script?: string; readsStdin: boolean } {
  let hasScript = false
  let readsStdin = false
  let i = 0
  for (; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--' || arg === '-') {
      i++
      break
    }
    if (arg === '--rcfile' || arg === '--init-file') i++
    else if (/^[-+][^-]/.test(arg)) {
      if (arg.startsWith('-') && arg.includes('c')) hasScript = true
      if (arg.startsWith('-') && arg.includes('s')) readsStdin = true
      if (/[oO]/.test(arg)) i++
    } else if (!arg.startsWith('--')) break
  }
  if (hasScript) return { script: args[i] ?? '', readsStdin: false }
  return { readsStdin: readsStdin || i >= args.length }
}

// The script a statement runs, and whether it surely runs with the statement:
// a shell's -c script, eval's words joined, or a trap's handler, which runs
// later, if ever.
function scriptOf(statement: ShellStatement): { script: string; isCertain: boolean } | undefined {
  if (statement.name === 'eval') return { script: statement.args.join(' '), isCertain: statement.isCertain }
  if (statement.name === 'trap') {
    const args = statement.args[0] === '--' ? statement.args.slice(1) : statement.args
    return args.length >= 2 && !/^-[lp]$/.test(args[0] as string) && args[0] !== '-' ? { script: args[0] as string, isCertain: false } : undefined
  }
  if (!SHELLS.has(statement.name)) return undefined
  const { script } = shellScriptOf(statement.args)
  return script === undefined ? undefined : { script, isCertain: statement.isCertain }
}

function statementsOf(text: string, reading: Reading, source: ShellSource, depth: number, isCertain: boolean): ShellStatement[] {
  const statements: ShellStatement[] = []
  // Each lexed command's statement, so a pipe can find what feeds it.
  const of = new Map<Raw, ShellStatement>()
  const nested = (script: string, from: ShellStatement, nestedSource: ShellSource, nestedCertain: boolean) => {
    if (from.depth >= MAX_DEPTH) reading.unknowns.add('depth')
    else statements.push(...statementsOf(script, reading, nestedSource, from.depth + 1, nestedCertain))
  }
  for (const raw of lex(text, reading, source, depth, isCertain)) {
    const statement = statementOf(raw, reading)
    if (statement === undefined) continue
    of.set(raw, statement)
    statements.push(statement)
    const run = scriptOf(statement)
    if (run !== undefined) nested(run.script, statement, 'script', run.isCertain)
    else if (SHELLS.has(statement.name) && shellScriptOf(statement.args).readsStdin) {
      // A shell reading its script from stdin: a pipe or a here-string. A
      // heredoc of the command piped in feeds the shell, and is read as one.
      // What else a pipe carries is not seen, so it is unknown.
      const strings = statement.redirects.filter(r => r.isReal && r.op === '<<<')
      for (const string of strings) nested(string.target, statement, 'script', statement.isCertain)
      const feeder = raw.pipedFrom === undefined ? undefined : of.get(raw.pipedFrom)
      for (const doc of feeder?.heredocs ?? []) {
        doc.feedsShell = true
        nested(doc.body, statement, 'heredoc', statement.isCertain)
      }
      if (strings.length > 0 || raw.pipedFrom !== undefined) reading.unknowns.add('stdin')
    }
  }
  return statements
}

// The reading of a Bash command line: its statements, and what could not be
// read.
export function parseShell(text: string): ShellParse {
  const reading: Reading = { heredocs: [], unknowns: new Set() }
  const statements = statementsOf(text, reading, 'line', 0, true)
  return { statements, unknowns: [...reading.unknowns].sort() }
}
