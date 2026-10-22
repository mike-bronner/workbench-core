import type { WorkbenchShellParse as ShellParse, WorkbenchShellStatement as Statement } from '../../types'

export const TYPES: readonly string[] = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore']

export const GITMOJI: readonly string[] = [
  '🎨', '⚡️', '🔥', '🐛', '🚑️', '✨', '📝', '🚀', '💄', '🎉', '✅', '🔒️', '🔐', '🔖', '🚨', '🚧', '💚', '⬇️', '⬆️', '📌',
  '👷', '📈', '♻️', '➕', '➖', '🔧', '🔨', '🌐', '✏️', '💩', '⏪️', '🔀', '📦️', '👽️', '🚚', '📄', '💥', '🍱', '♿️', '💡',
  '🍻', '💬', '🗃️', '🔊', '🔇', '👥', '🚸', '🏗️', '📱', '🤡', '🥚', '🙈', '📸', '⚗️', '🔍️', '🏷️', '🌱', '🚩', '🥅', '💫',
  '🗑️', '🛂', '🩹', '🧐', '⚰️', '🧪', '👔', '🩺', '🧱', '🧑‍💻', '💸', '🧵', '🦺', '✈️', '🦖',
]

const bare = (emoji: string): string => emoji.replace(/\uFE0F/g, '')
const KNOWN: ReadonlySet<string> = new Set(GITMOJI.map(bare))

const NOT_ON_LINE = /^(-F|--file|-C|-c|--reuse-message|--reedit-message|--fixup|--squash)(=|$)/
const SHORT_VALUED = 'mFCct'
const SHORT_ATTACHED = 'uS'

type Message = { text: string } | 'not-judged'

function messageOf(statement: Statement, parse: ShellParse): Message | undefined {
  const args = statement.args
  let message: string | undefined
  for (let i = statement.subcommandAt + 1; i < args.length; i++) {
    const arg = args[i] ?? ''
    if (arg === '--') break
    if (NOT_ON_LINE.test(arg)) return 'not-judged'
    let value: string | undefined
    if (arg === '--message' || arg === '--message=') value = args[++i]
    else if (arg.startsWith('--message=')) value = arg.slice('--message='.length)
    else if (/^-[^-]/.test(arg)) {
      for (let c = 1; c < arg.length; c++) {
        const flag = arg[c] ?? ''
        if (SHORT_ATTACHED.includes(flag)) break
        if (!SHORT_VALUED.includes(flag)) continue
        if (flag === 'F' || flag === 'C' || flag === 'c') return 'not-judged'
        const attached = arg.slice(c + 1)
        const taken = attached === '' ? args[++i] : attached
        if (flag === 'm') value = taken
        break
      }
    }
    if (value !== undefined && message === undefined) message = value
  }
  if (message === undefined) return undefined
  if (message === '$_') {
    const bodies = parse.statements.filter(s => s.source === 'substitution')
    const only = bodies.length === 1 ? bodies[0] : undefined
    if (only?.name === 'cat' && only.args.length === 0 && only.heredocs.length === 1) return { text: only.heredocs[0]?.body ?? '' }
    return 'not-judged'
  }
  return message.includes('$') ? 'not-judged' : { text: message }
}

export function subjectFault(subject: string): string | undefined {
  const head = /^([A-Za-z]+)(\([^)]*\))?(!)?:/.exec(subject)
  if (head === null) return 'it does not start with a type and a colon'
  if (head[2] !== undefined) return `it has a scope, ${head[2]}`
  if (!TYPES.includes(head[1] ?? '')) return `"${head[1]}" is not a type`
  const rest = subject.slice(head[0].length)
  if (!rest.startsWith(' ') || rest.startsWith('  ')) return 'the colon is not followed by exactly one space'
  const [emoji = '', ...words] = rest.slice(1).split(' ')
  if (!KNOWN.has(bare(emoji))) return `"${emoji}" is not a gitmoji from the skill's list`
  const description = words.join(' ')
  if (!/[^.\s]/.test(description) || description.startsWith(' ')) return 'the gitmoji is not followed by one space and a description'
  if (!description.endsWith('.')) return 'the description does not end with a period'
  return undefined
}

export function subjectVerdict(parse: ShellParse): { deny: string } | undefined {
  for (const statement of parse.statements) {
    if (statement.name !== 'git' || statement.subcommandAt < 0 || statement.args[statement.subcommandAt] !== 'commit') continue
    const message = messageOf(statement, parse)
    if (message === undefined || message === 'not-judged') continue
    const subject = message.text.split('\n').find(line => line.trim() !== '')?.replace(/\s+$/, '') ?? ''
    const fault = subjectFault(subject)
    if (fault !== undefined) return { deny: subjectDeny(subject, fault) }
  }
  return undefined
}

export function subjectDeny(subject: string, fault: string): string {
  return [
    `🛑 Blocked: a commit subject that breaks the git-commit format, because ${fault}.`,
    '',
    `Commit guard (workbench-core). The subject was: ${JSON.stringify(subject)}. ` +
      'The expected shape is "<type>: <gitmoji> <Description>.", for example "feat: ✨ Add email validation endpoint.". ' +
      `The type is one of ${TYPES.join(', ')}, with ! after it for a breaking change, and never a scope. ` +
      'The gitmoji comes from the git-commit skill\'s references/gitmoji.md, and the description ends with a period. ' +
      'Fix the message with the /workbench-dev-team:git-commit skill, and commit again.',
  ].join('\n')
}
