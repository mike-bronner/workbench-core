const WS = ' \\t\\r\\v\\f'
const WORKDIR = new RegExp(`^[${WS}]*Workdir:(.*)$`, 'i')
const PATH = /(?:^|[\s`'"(<[,])(~?\/[^\s`'"()<>[\],;]*|~(?=$|[\s`'")>\],;]))/g

export const READ_ONLY_TYPES: ReadonlySet<string> = new Set(['Explore', 'Plan'])

export const isWorkType = (type: unknown): boolean => !(typeof type === 'string' && READ_ONLY_TYPES.has(type))

export function workdirPathsOf(prompt: unknown, home: string | undefined): string[] | undefined {
  if (typeof prompt !== 'string') return undefined
  const values = prompt.split('\n').flatMap(line => {
    const match = WORKDIR.exec(line)
    return match ? [match[1] ?? ''] : []
  })
  if (values.length === 0) return undefined
  return values.flatMap(value =>
    [...value.matchAll(PATH)].flatMap(([, raw = '']) => {
      const path = raw.replace(/[.:]+$/, '')
      if (!path.startsWith('~')) return path === '' ? [] : [path]
      return home?.startsWith('/') ? [`${home.replace(/\/+$/, '')}${path.slice(1)}`] : []
    }),
  )
}

export const isInScope = (path: string, roots: readonly string[]): boolean =>
  roots.some(root => {
    const [p, r] = [path.toLowerCase(), root.replace(/\/+$/, '').toLowerCase()]
    return r !== '' && (p === r || p.startsWith(`${r}/`))
  })

const HEAD = '🛑 Blocked: a work dispatch into another project. Project scope guard (workbench-core).'

const HAND_OFF =
  'Run ListAgents and find the live session named after that project. Send it the finding and the acceptance criteria with SendMessage, as /workbench-core:cross-session-messaging describes, and let that session do the work. ' +
  'If no session for that project is live, stop and ask Mike. Explore and Plan dispatches may still read other projects.'

export function outsideDenyOf(project: string, workdir: string, target: string): string {
  return [
    HEAD,
    `This session works only for its own project, ${project}.`,
    `The brief's Workdir, ${workdir}, is outside it, outside every git worktree of its repository, and outside every scratch root. It belongs to ${target}.`,
    HAND_OFF,
  ].join(' ')
}

export function unreadableDenyOf(project: string): string {
  return [
    HEAD,
    `This session works only for its own project, ${project}, and the brief's Workdir line names no absolute path this guard can resolve.`,
    'Write the Workdir as an absolute path, with no `..` below a folder that does not exist yet, and dispatch again.',
    `If the work belongs to another project, do not dispatch it. ${HAND_OFF}`,
  ].join(' ')
}
