// A file system and a git for the destructive-scope, database and vault-git
// guards, beneath the module in `claude plugin test`. The guards ask their
// facts through hooks/lib/scope-facts.sh, git, head, $.fs.stat and $.fs.list
// (answerFact in hooks/register.ts). install() answers each of those calls
// from one function of the fact key (the keys in hooks/mods/destructive-scope.ts),
// so a test describes the world as facts and never as process output.
//
// Two worlds feed it:
//   model()     a small world a test writes out: folders, files, links, and
//               repositories with their branches, tracked files and aliases
//   recorded()  the facts the port asked about in a real sandbox, recorded
//               while a retired bash guard's suite ran
//               (tests/guard-corpus/world-cases.ts)

import type { Bench } from './bench'

export type Fact = string | null

// What the module asks beside the facts: the scope roots and the vault root.
export type WorldScripts = { roots: string; vault: string | null }

export function install(b: Bench, answer: (key: string) => Fact, scripts: WorldScripts, peek: (key: string) => Fact = answer): void {
  const reply = (stdout: string, exitCode = 0) => ({ exitCode, stdout })
  b.run = argv => {
    const [program = '', a = '', c = '', d = ''] = argv
    if (program === 'bash' && a.endsWith('/scope-facts.sh')) {
      if (c === 'roots') return reply(scripts.roots)
      if (c === 'dir') {
        const found = answer(`dir\t${d}`)
        return reply(found === null ? '' : `${found}\n`)
      }
      if (c === 'entry') return reply(`${answer(`entry\t${d}`) ?? 'missing'}\n`)
      if (c === 'name') {
        const found = answer(`name\t${d}\t${argv[4] ?? ''}`)
        return reply(found === null ? '' : `${found}\n`)
      }
      return reply('')
    }
    if (program === 'bash' && a.endsWith('/vault-resolve.sh')) return reply(scripts.vault === null ? '' : `root\t${scripts.vault}\n`)
    if (program === 'head') {
      const content = answer(`file\t${argv.at(-1)}`)
      return content === null ? reply('', 1) : reply(content)
    }
    if (program !== 'git') return undefined
    if (a === '--list-cmds=builtins') {
      const names = answer('git\tbuiltins\t\t')
      return names === null ? reply('', 1) : reply(`${names.split(' ').join('\n')}\n`)
    }
    const dir = c
    const rest = argv.slice(3)
    const ask = (question: string, arg: string): Fact => answer(`git\t${question}\t${dir}\t${arg}`)
    if (rest[0] === 'rev-parse' && rest[1] === '--show-toplevel') {
      const top = ask('top', '')
      return top === null || top === '' ? reply('', 128) : reply(`${top}\n`)
    }
    if (rest[0] === 'ls-files') {
      const tracked = ask('tracked', rest.at(-1) ?? '')
      return reply('', tracked === 'yes' ? 0 : tracked === 'no' ? 1 : 128)
    }
    if (rest[0] === 'rev-parse' && rest[1] === '--verify' && rest[3] === '--end-of-options') {
      return reply('', ask('commit', (rest[4] ?? '').replace(/\^\{commit\}$/, '')) === 'yes' ? 0 : 1)
    }
    if (rest[0] === 'for-each-ref') {
      const count = ask('remotes', (rest.at(-1) ?? '').replace(/^refs\/remotes\/\*\//, ''))
      return count === null ? reply('', 128) : reply(Array.from({ length: Number(count) }, (_, i) => `refs/remotes/r${i}/x\n`).join(''))
    }
    if (rest[0] === 'config' && rest[1] === '--get') {
      const value = ask('alias', (rest[2] ?? '').replace(/^alias\./, ''))
      return value === null ? reply('', 3) : value === 'none' ? reply('', 1) : reply(`${value.slice(1)}\n`)
    }
    return undefined
  }
  // A SQL file the guard reads is stat'ed first: a file when the facts hold
  // its contents. Any other path, such as one another guard stats, passes on
  // to the bench, and is not asked as a fact.
  b.stat = path => (peek(`file\t${path}`) === null ? undefined : { kind: 'file', isLink: false })
}

// ─── a modeled world ─────────────────────────────────────────────────────────

export type Repo = { branches?: readonly string[]; remote?: Readonly<Record<string, number>>; tracked?: readonly string[]; aliases?: Readonly<Record<string, string>> }

export type ModelSpec = {
  // Every folder and file, absolute and spelled as on disk. A folder's
  // parents are folders too.
  dirs: readonly string[]
  files?: readonly string[]
  // Symbolic links: the link's path to the absolute path it points at.
  links?: Readonly<Record<string, string>>
  // Entries another account owns.
  foreign?: readonly string[]
  // Repositories by their worktree root.
  repos?: Readonly<Record<string, Repo>>
  // The contents of files a SQL client may be fed.
  sql?: Readonly<Record<string, string>>
  // Whether names are matched without regard to case, as on APFS.
  foldsCase?: boolean
}

export const GIT_BUILTINS = [
  'add', 'branch', 'checkout', 'checkout-index', 'clean', 'commit', 'config', 'diff', 'fetch', 'log', 'merge', 'mv', 'pull', 'push', 'read-tree', 'rebase',
  'reset', 'restore', 'rev-parse', 'rm', 'show', 'stash', 'status', 'submodule', 'switch', 'tag', 'worktree',
]

// The fact answerer of a modeled world.
export function model(spec: ModelSpec): (key: string) => Fact {
  const fold = (p: string) => (spec.foldsCase === false ? p : p.toLowerCase())
  const entries = new Map<string, { path: string; kind: 'dir' | 'file' | 'link' }>()
  const add = (path: string, kind: 'dir' | 'file' | 'link') => entries.set(fold(path), { path, kind })
  for (const dir of ['/', ...spec.dirs]) add(dir, 'dir')
  for (const file of spec.files ?? []) add(file, 'file')
  for (const link of Object.keys(spec.links ?? {})) add(link, 'link')
  const linkTarget = (path: string) => Object.entries(spec.links ?? {}).find(([link]) => fold(link) === fold(path))?.[1]

  // Where a path lands, its links followed: the canonical path, or undefined.
  const resolve = (path: string, depth = 0): string | undefined => {
    if (depth > 20) return undefined
    let at = '/'
    for (const part of path.split('/').filter(p => p !== '' && p !== '.')) {
      if (part === '..') {
        at = at === '/' ? '/' : at.slice(0, at.lastIndexOf('/')) || '/'
        continue
      }
      const next = entries.get(fold(at === '/' ? `/${part}` : `${at}/${part}`))
      if (next === undefined) return undefined
      if (next.kind === 'link') {
        const target = resolve(linkTarget(next.path) as string, depth + 1)
        if (target === undefined) return undefined
        at = target
      } else at = next.path
    }
    return at
  }
  const isDir = (path: string | undefined) => path !== undefined && entries.get(fold(path))?.kind === 'dir'
  const repoOf = (dir: string): [string, Repo] | undefined => {
    const real = resolve(dir)
    if (real === undefined) return undefined
    return Object.entries(spec.repos ?? {})
      .filter(([root]) => real === root || real.startsWith(`${root}/`))
      .sort(([a], [b]) => b.length - a.length)[0]
  }
  return key => {
    const [kind = '', a = '', b = '', c = ''] = key.split('\t')
    if (kind === 'dir') {
      const real = resolve(a)
      return isDir(real) ? (real as string) : null
    }
    if (kind === 'entry') {
      const cut = a.lastIndexOf('/')
      const parent = resolve(a.slice(0, cut) || '/')
      if (parent === undefined) return 'missing'
      const found = entries.get(fold(`${parent === '/' ? '' : parent}/${a.slice(cut + 1)}`))
      if (found === undefined) return 'missing'
      const owned = found.kind !== 'link' && !(spec.foreign ?? []).some(p => fold(p) === fold(found.path)) ? 1 : 0
      return `${found.kind}:${owned}`
    }
    if (kind === 'name') {
      const exact = entries.get(fold(`${a === '/' ? '' : a}/${b}`))
      return exact === undefined ? null : (exact.path.split('/').pop() as string)
    }
    if (kind === 'file') {
      const real = resolve(a)
      return real === undefined ? null : (spec.sql ?? {})[real] ?? null
    }
    if (kind !== 'git') return null
    if (a === 'builtins') return GIT_BUILTINS.join(' ')
    const repo = repoOf(b)
    if (a === 'top') return repo === undefined ? '' : repo[0]
    if (repo === undefined) return null
    const [, r] = repo
    if (a === 'tracked') return (r.tracked ?? []).includes(c) ? 'yes' : 'no'
    if (a === 'commit') return c === 'HEAD' || (r.branches ?? []).includes(c) ? 'yes' : 'no'
    if (a === 'remotes') return String((r.remote ?? {})[c] ?? 0)
    if (a === 'alias') return (r.aliases ?? {})[c] === undefined ? 'none' : `=${(r.aliases ?? {})[c]}`
    return null
  }
}

// The roots line scope-facts.sh prints.
export const rootsOf = (roots: readonly string[], tmp?: string, markers?: string): string =>
  [...roots.map(root => `root\t${root}`), ...(tmp === undefined ? [] : [`tmp\t${tmp}`]), ...(markers === undefined ? [] : [`markers\t${markers}`])].join('\n')

// ─── a recorded world ────────────────────────────────────────────────────────

// The answerer of recorded facts. A fact the port did not ask about when it
// was recorded goes in `misses`, and is answered null.
export function recorded(facts: Readonly<Record<string, Fact>>, misses: string[]): (key: string) => Fact {
  return key => {
    if (Object.hasOwn(facts, key)) return facts[key] ?? null
    misses.push(key)
    return null
  }
}

// The same, read without counting a miss.
export const peekOf =
  (facts: Readonly<Record<string, Fact>>) =>
  (key: string): Fact =>
    facts[key] ?? null
