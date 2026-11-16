import type { WorkbenchShellStatement as Statement } from '../../types'
import { nameOf, parseShell } from './shell'

const awkLike = (program: string): string => `awk with fflush(), such as \`awk '${program}'\``
const use = (replacement: string): string => `use ${replacement} instead`
const atEnd = (name: string, program: string): string => `${name} prints nothing until its input ends, so drop it and do the per-line work in ${awkLike(program)}`

const AT_END: Readonly<Record<string, string>> = {
  sort: atEnd('sort', '{ print; fflush() }'),
  tac: atEnd('tac', '{ print; fflush() }'),
  wc: atEnd('wc', '{ print NR; fflush() }'),
}

const ALWAYS: Readonly<Record<string, string>> = {
  cut: use(awkLike('{ print substr($0, 1, 400); fflush() }')),
  tr: use(awkLike('{ gsub(/a/, "b"); print; fflush() }')),
  uniq: `${use(awkLike('NR == 1 || $0 != last { print; fflush() } { last = $0 }'))}. Like uniq, it drops only adjacent repeats. With -c or -u, uniq prints each line only when a different line arrives, so each line arrives one line late`,
  head: use(awkLike('NR <= 10 { print; fflush() }')),
}

const AWKS: ReadonlySet<string> = new Set(['awk', 'gawk', 'mawk', 'nawk'])

const isPython = (name: string): boolean => /^python[\d.]*$/.test(name)

const hasShortFlag = (arg: string, letter: string, valued: string): boolean => {
  if (!/^-[A-Za-z]/.test(arg)) return false
  for (const c of arg.slice(1)) {
    if (c === letter) return true
    if (valued.includes(c)) return false
  }
  return false
}

const optionsOf = (args: readonly string[]): readonly string[] => {
  const end = args.findIndex(arg => !arg.startsWith('-') || arg === '--')
  return end === -1 ? args : args.slice(0, end)
}

const wrapperWordsOf = (statement: Statement, wrapper: string): readonly string[] => {
  const at = statement.words.findIndex((word, i) => i < statement.nameAt && nameOf(word) === wrapper)
  return at === -1 ? [] : statement.words.slice(at + 1, statement.nameAt)
}

const isFlushedByWrapper = (statement: Statement): boolean =>
  statement.wrappers.includes('unbuffer') ||
  (statement.wrappers.includes('stdbuf') && !isPython(statement.name) && /(^| )(-o ?|--output[= ])[L0]( |$)/.test(wrapperWordsOf(statement, 'stdbuf').join(' ')))

const SED_WRAP = `in GNU sed, -l sets the line-wrap length and does not flush, although -l in BSD sed, which macOS ships, flushes each line. So ${use('sed -u')}`

function sedAdviceOf(args: readonly string[]): string | undefined {
  let wraps = false
  for (const [i, arg] of args.entries()) {
    if (arg === '--unbuffered') return undefined
    if (!/^-[A-Za-z]/.test(arg)) continue
    for (const [at, c] of [...arg.slice(1)].entries()) {
      if (c === 'u') return undefined
      if ('efiI'.includes(c)) break
      if (c !== 'l') continue
      if (!/^\d+$/.test(arg.slice(at + 2) || (args[i + 1] ?? ''))) return undefined
      wraps = true
      break
    }
  }
  return wraps ? SED_WRAP : use('sed -u')
}

const isInteractiveAwk = (args: readonly string[]): boolean =>
  args.some((arg, i) => /^-W/.test(arg) && (arg.slice(2) || (args[i + 1] ?? '')).split(',').some(option => option !== '' && 'interactive'.startsWith(option)))

function awkAdviceOf(args: readonly string[]): string | undefined {
  if (args.some(arg => arg.includes('fflush')) || isInteractiveAwk(args)) return undefined
  if (args.some(arg => /^(-f|--file(=|$))/.test(arg))) return 'awk reads its program from a file this check does not read, so check that the program calls fflush() after each print'
  return use(awkLike('{ print; fflush() }'))
}

const lacksPipeInput = (statement: Statement): boolean =>
  statement.wrappers.includes('unbuffer') && !wrapperWordsOf(statement, 'unbuffer').some(word => hasShortFlag(word, 'p', ''))

function adviceOf(statement: Statement): string | undefined {
  const { name, args } = statement
  if (Object.hasOwn(AT_END, name)) return AT_END[name]
  if (isFlushedByWrapper(statement)) return undefined
  if (Object.hasOwn(ALWAYS, name)) return ALWAYS[name]
  if (name === 'grep') return args.includes('--line-buffered') ? undefined : use('grep --line-buffered')
  if (name === 'sed') return sedAdviceOf(args)
  if (name === 'jq') return args.includes('--unbuffered') ? undefined : use('jq --unbuffered')
  if (AWKS.has(name)) return awkAdviceOf(args)
  if (isPython(name)) {
    const isUnbuffered = statement.assignments.some(word => /^PYTHONUNBUFFERED=./.test(word)) || optionsOf(args).some(arg => hasShortFlag(arg, 'u', 'cmWX'))
    return isUnbuffered ? undefined : use(`${name} -u`)
  }
  return undefined
}

function closerOf(text: string, at: number): number {
  const open = text[at]
  if (open === "'") {
    const end = text.indexOf("'", at + 1)
    return end === -1 ? text.length : end
  }
  const close = open === '"' || open === '`' ? open : ')'
  for (let i = at + 1; i < text.length; i++) {
    const c = text[i] as string
    if (c === '\\') i++
    else if (c === close) return i
    else if (close === ')' && `'"\`(`.includes(c)) i = closerOf(text, i)
    else if (close === '"' && c === '$' && text[i + 1] === '(') i = closerOf(text, i + 1)
  }
  return text.length
}

function regionsOf(text: string): { readers: string[]; written: string[] } {
  const readers: string[] = []
  const written: string[] = []
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string
    const next = text[i + 1]
    if (c === '\\') i++
    else if (`'"\``.includes(c)) i = closerOf(text, i)
    else if (c === '#' && (i === 0 || /\s/.test(text[i - 1] as string))) i = text.includes('\n', i) ? text.indexOf('\n', i) : text.length
    else if (c === '>' && next === '(') {
      const end = closerOf(text, i + 1)
      written.push(text.slice(i + 2, end))
      i = end
    } else if ((c === '$' || c === '<') && next === '(') i = closerOf(text, i + 1)
    else if (c === '|' && next === '|') i++
    else if (c === '|') {
      if (next === '&') i++
      readers.push(text.slice(i + 1))
    }
  }
  return { readers, written }
}

const UNBUFFER = `without -p, unbuffer does not read the pipe, so ${use('unbuffer -p')}`

function advicesOf(command: string): [string, string][] | undefined {
  const parse = parseShell(command)
  if (parse.unknowns.length > 0) return undefined
  const { readers, written } = regionsOf(command)
  const nested = written.map(advicesOf)
  if (nested.some(advices => advices === undefined)) return undefined
  return [
    ...parse.statements.filter(statement => statement.source !== 'substitution').flatMap((statement): [string, string][] => {
      const advice = adviceOf(statement)
      return advice === undefined ? [] : [[statement.name, advice]]
    }),
    ...readers.flatMap((reader): [string, string][] => {
      const first = parseShell(reader).statements.find(statement => statement.source === 'line')
      return first !== undefined && lacksPipeInput(first) ? [['unbuffer', UNBUFFER]] : []
    }),
    ...nested.flatMap(advices => advices ?? []),
  ]
}

export function bufferWarningOf(command: string): string | undefined {
  const found = new Map(advicesOf(command))
  if (found.size === 0) return undefined
  return [
    'Monitor buffer check (workbench-core): this Monitor command runs a stage that can buffer its output when a pipe reads it. ' +
      'Monitor reads the command through a pipe too, so lines can wait in the buffer and the watch delivers no events.',
    ...[...found].map(([name, advice]) => `- \`${name}\`: ${advice}.`),
    'If the watch must deliver each line as it arrives, stop it with TaskStop and start it again with the fix.',
  ].join('\n')
}
