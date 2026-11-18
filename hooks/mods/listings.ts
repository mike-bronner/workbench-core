import type { WorkbenchShellParse as ShellParse } from '../../types'
import { resolvePath, statementsAt, toolSearchRoots } from './guards.ts'
import { cleanSourceOf } from './outward.ts'

export type Listing = { names: readonly string[]; at: number; bound?: string | null }
export type Listings = Readonly<Record<string, Readonly<Record<string, Listing>>>>
export type FolderChange = { folder: string; added: readonly string[]; removed: readonly string[] }

export const KEPT_FOLDERS = 20
export const KEPT_NAMES = 1000
export const LISTED_NAMES = 10

export function lsFoldersOf(parse: ShellParse, cwd: string, home: string | undefined): string[] {
  const folders: string[] = []
  for (const { statement, dir } of statementsAt(parse, cwd, home)) {
    if (statement.name !== 'ls') continue
    const ends = statement.args.indexOf('--')
    const options = ends === -1 ? statement.args : statement.args.slice(0, ends)
    if (options.some(arg => arg === '--directory' || /^-[A-Za-z0-9]*d/.test(arg))) continue
    const words = statement.args.filter((arg, i) => (ends !== -1 && i > ends) || (arg !== '--' && !arg.startsWith('-')))
    for (const word of words.length > 0 ? words : ['.']) {
      const path = resolvePath(word, dir, home)
      if (path !== undefined) folders.push(path)
    }
  }
  return [...new Set(folders)]
}

export function globFoldersOf(input: { path?: unknown; pattern?: unknown }, cwd: string, home: string | undefined): string[] {
  const [base, ...starts] = toolSearchRoots('Glob', input, cwd, home)
  const paths = (starts.length > 0 ? starts : [base]).map(root => root?.path)
  return [...new Set(paths.filter((path): path is string => path !== undefined))]
}

export const namesOf = (entries: readonly { name: string }[]): string[] => entries.map(entry => entry.name).sort()

export function listingsAfter(listings: Listings, caller: string, folder: string, names: readonly string[], at: number): Listings {
  const kept = names.slice(0, KEPT_NAMES)
  const folders = Object.entries({ ...listings[caller], [folder]: { names: kept, at, bound: names.length >= KEPT_NAMES ? (kept.at(-1) ?? null) : null } })
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, KEPT_FOLDERS)
  return { ...listings, [caller]: Object.fromEntries(folders) }
}

export const boundOf = (listing: Pick<Listing, 'names' | 'bound'>): string | null =>
  listing.bound !== undefined ? listing.bound : listing.names.length >= KEPT_NAMES ? (listing.names.at(-1) ?? null) : null

const isWithin = (name: string, bound: string | null): boolean => bound === null || name <= bound

const keptOf = (names: string[], bound: string | null): Pick<Listing, 'names' | 'bound'> =>
  bound === null && names.length > KEPT_NAMES ? { names: names.slice(0, KEPT_NAMES), bound: names[KEPT_NAMES - 1] ?? null } : { names, bound }

const nameBelow = (folder: string, path: string): string | undefined => {
  const below = folder === '/' ? path.slice(1) : path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : undefined
  const name = below?.split('/')[0]
  return name === '' ? undefined : name
}

export const takenBy = (listings: Listings, caller: string, path: string): [string, string][] =>
  Object.entries(listings[caller] ?? {}).flatMap(([folder, listing]): [string, string][] => {
    const name = nameBelow(folder, path)
    return name === undefined || listing.names.includes(name) || !isWithin(name, boundOf(listing)) ? [] : [[folder, name]]
  })

export function listingWith(listings: Listings, caller: string, path: string, held: ReadonlySet<string> = new Set()): Listings {
  const own = listings[caller]
  if (own === undefined) return listings
  const taken = new Map(takenBy(listings, caller, path).filter(([folder]) => !held.has(folder)))
  const updated = Object.entries(own).map(([folder, listing]): [string, Listing] => {
    const name = taken.get(folder)
    return name === undefined ? [folder, listing] : [folder, { ...listing, ...keptOf([...listing.names, name].sort(), boundOf(listing)) }]
  })
  return { ...listings, [caller]: Object.fromEntries(updated) }
}

export function listingsAfterOwn(listings: Listings, caller: string, folder: string, before: readonly string[], after: readonly string[]): Listings {
  const listing = listings[caller]?.[folder]
  if (listing === undefined) return listings
  const bound = boundOf(listing)
  const had = new Set(before)
  const has = new Set(after)
  const added = after.filter(name => !had.has(name) && isWithin(name, bound))
  const names = [...new Set([...listing.names, ...added])].filter(name => has.has(name) || !had.has(name)).sort()
  return { ...listings, [caller]: { ...listings[caller], [folder]: { ...listing, ...keptOf(names, bound) } } }
}

export function changeOf(folder: string, listing: Pick<Listing, 'names' | 'bound'>, after: readonly string[]): FolderChange | undefined {
  const bound = boundOf(listing)
  const had = new Set(listing.names)
  const has = new Set(after)
  const added = after.filter(name => !had.has(name) && isWithin(name, bound))
  const removed = listing.names.filter(name => !has.has(name))
  return added.length === 0 && removed.length === 0 ? undefined : { folder, added, removed }
}

const namesLine = (verb: string, names: readonly string[]): string[] => {
  if (names.length === 0) return []
  const shown = names.slice(0, LISTED_NAMES).map(cleanSourceOf).join(', ')
  const more = names.length > LISTED_NAMES ? `, and ${names.length - LISTED_NAMES} more` : ''
  return [`  ${verb}: ${shown}${more}`]
}

const WAYS = { call: ' Call it again and it goes through.', stop: ' Stop again and the stop goes through.', note: '' } as const

export function changeReportOf(changes: readonly FolderChange[], at: keyof typeof WAYS): string {
  return [
    `Workbench folder check (workbench-core): ${changes.length === 1 ? 'a folder' : 'folders'} listed in this session changed since the last listing.`,
    ...changes.flatMap(change => [`- ${cleanSourceOf(change.folder)}`, ...namesLine('added', change.added), ...namesLine('removed', change.removed)]),
    `Read each added entry this work depends on, and drop what rests on a removed one, as /workbench-core:recheck-before-done says. This change is now recorded as reported, so it does not block again.${WAYS[at]}`,
  ].join('\n')
}
