import type { WorkbenchShellParse as ShellParse } from '../../types'
import { ghRepoOf } from './commit-approval'
import type { BodyPart } from './outbound-prose'
import { flagParts, proseCommandOf, stdinOf, unseen } from './outbound-prose'

export type PrCall = { parts: BodyPart[]; repo?: string; dir?: string | null }
export type Template = { path: string; text: string }

export const TEMPLATE_NAME = 'pull_request_template.md'
export const TEMPLATE_FOLDER = 'pull_request_template'
export const TEMPLATE_PLACES = ['', '.github', 'docs'] as const

const BODY_FLAGS: ReadonlySet<string> = new Set(['--body', '-b', '--body-file', '-F'])
const MOVERS: ReadonlySet<string> = new Set(['cd', 'pushd', 'popd'])
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/

const setsBody = (args: readonly string[]): boolean => args.some(a => BODY_FLAGS.has(a) || /^--body(?:-file)?=/.test(a) || /^-[bF]./.test(a))

const moverDir = (args: readonly string[], name: string): string | null => {
  const target = args.find(a => !a.startsWith('-'))
  return name === 'popd' || target === undefined || target.includes('$') ? null : target
}

export function prCallsOf(parse: ShellParse): { calls: PrCall[] } | { unread: string } {
  const calls: PrCall[] = []
  let dir: string | null | undefined
  for (const st of parse.statements) {
    if (MOVERS.has(st.name)) dir = moverDir(st.args, st.name)
    const at = st.name === 'gh' ? st.nameAt : st.words.findIndex(w => (w.split('/').pop() ?? '') === 'gh')
    if (at < 0) continue
    const args = st.name === 'gh' ? st.args : st.words.slice(at + 1)
    const kind = proseCommandOf(args, st.name === 'gh' ? st.subcommandAt : -1)
    if (kind !== 'pr create' && !(kind === 'pr edit' && setsBody(args))) continue
    const parts = flagParts(args, new Set(['--body', '-b']), ['-b'], stdinOf(st))
    if (typeof parts === 'string') return { unread: parts }
    const repo = ghRepoOf(st)
    calls.push({ parts, ...(repo === undefined ? {} : { repo }), ...(dir === undefined ? {} : { dir }) })
  }
  return { calls }
}

const headingKey = (text: string): string => text.split(/\s+/).filter(Boolean).join(' ').toLowerCase()

export function headingsOf(text: string): string[] {
  return unseen(text).split('\n').flatMap(line => {
    const match = HEADING.exec(line)
    return match === null || (match[2] ?? '').trim() === '' ? [] : [`${match[1]} ${(match[2] as string).trim()}`]
  })
}

export function missingHeadings(template: string, body: string): string[] {
  const held = new Set(headingsOf(body).map(h => headingKey(h.replace(/^#+ /, ''))))
  return [...new Set(headingsOf(template))].filter(h => !held.has(headingKey(h.replace(/^#+ /, ''))))
}

const HEAD = 'Pull request template guard (workbench-core): '

const FILL =
  'Start the body from the template. Fill every section honestly. Leave unticked any checkbox that attests to something not done or not verified. ' +
  'Put any extra notes after the template, keep them short, and send the call again.'

export function templateRefusal(templates: readonly Template[], body: string): string | undefined {
  const misses = templates.map(t => ({ path: t.path, missing: missingHeadings(t.text, body) }))
  if (misses.length === 0 || misses.some(m => m.missing.length === 0)) return undefined
  const lead =
    misses.length === 1
      ? `${HEAD}this repository has a pull request template, and the body lacks its headings, so the call is refused.`
      : `${HEAD}this repository has ${misses.length} pull request templates, and the body lacks headings of each, so the call is refused. A body passes when it holds every heading of any one of them.`
  return [lead, '', ...misses.flatMap(m => [`Template: ${m.path}`, 'Missing headings:', ...m.missing.map(h => `- ${h}`), '']), FILL].join('\n')
}

export const UNPLACED_TEMPLATE =
  `${HEAD}the guard cannot tell which working tree this gh call runs against, or cannot read its pull request templates, so it is refused. ` +
  'Run the gh call from the repository\'s working tree, with no cd, pushd or popd to a folder named by a variable on the same line.'

export const OTHER_REPO_TEMPLATE =
  `${HEAD}this gh call names a repository with -R, --repo or GH_REPO that no remote of this working tree points at, so the guard cannot read that repository's pull request template, and it is refused. ` +
  'Run the gh call from a working tree of that repository, whose remotes name it.'
