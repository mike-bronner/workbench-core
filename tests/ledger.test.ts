import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { AGENT_WORKTREE_REFUSAL, ENTER_WORKTREE_REFUSAL, EXIT_WORKTREE_REFUSAL, provisioningRefusal } from '../hooks/mods/guards'
import type { LedgerEntry } from '../hooks/mods/ledger'
import { LEDGER_WRITE_REFUSAL, LOCK_TRIES, LOCK_WAIT_MS, MAX_DATABASE, NAME_FORM, PRUNE_AFTER_MS, ROOT_FORM, ledgerCommandOf, unitDatabaseOf } from '../hooks/mods/ledger'
import { SUBAGENT_REFUSAL } from '../hooks/mods/commit-guard'
import { parseShell } from '../hooks/mods/shell'
import type { Bench } from './bench'
import { ASKS, HOME, PERSON, SID, START, bench, start } from './bench'

const ROOT = `${HOME}/Developer/worktrees/repo`
const LEDGER = `${HOME}/.claude-workbench/provisioning/ledger.json`
const LOCK = `${LEDGER}.lock`
const SUB = 'a5a2f4470341f9233'
const TREE = `${ROOT}/unit-a`
const ADD = `git worktree add -b unit/a ${TREE} feat/x`
const DB = 'wt_repo_unit_a_testing'
const DROP = `psql -c 'DROP DATABASE "${DB}"'`
const UNIT_COMMIT = `git -C ${TREE} commit -m "fix: 🐛 X."`

type Answer = { deny: string | undefined; reached: boolean; context: readonly string[] }
type Run = (argv: readonly string[]) => { exitCode: number; stdout: string } | undefined
type World = Bench & { held: Set<string>; refusedTakes: string[] }

const isLockTake = (argv: readonly string[]): boolean => argv[0] === 'bash' && argv[1] === '-c' && (argv[2] ?? '').includes('dir_lock_take')

function world(on: Parameters<typeof bench>[0], git: Run = () => undefined): World {
  const b = Object.assign(bench(on, { env: { HOME } }), { held: new Set<string>(), refusedTakes: [] as string[] })
  b.run = argv => {
    const lock = argv.at(-1) ?? ''
    if (isLockTake(argv)) {
      if (b.held.has(lock)) {
        b.refusedTakes.push(lock)
        return { exitCode: 1, stdout: '' }
      }
      b.held.add(lock)
      return { exitCode: 0, stdout: '' }
    }
    if (argv[0] === 'rmdir') return { exitCode: b.held.delete(lock) ? 0 : 1, stdout: '' }
    return git(argv)
  }
  on('classic.SessionStart', () => ({ additionalContext: ['the rules'] }))
  for (const name of ['false-bare.sh', 'session-warmup.sh', 'scratch-roots.sh', 'memory-status.sh', 'vault-resolve.sh']) b.scripts[name] = () => ''
  b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'feat/x', originHead: 'main', originUrl: 'git@github.com:o/r.git' }
  b.trees['/repo'] = ''
  return b
}

async function attended($: Engine, on: Parameters<typeof bench>[0], git?: Run): Promise<World> {
  const b = world(on, git)
  await $.session.start(start())
  await $.prompt.submit({ text: 'run the units', wait: false, origin: PERSON })
  return b
}

async function bash($: Engine, b: Bench, command: string, extra: Record<string, unknown> = {}): Promise<Answer> {
  const before = b.inputs.length
  const result = await $.tool.call({ tool: 'Bash', command, ...extra } as never)
  return { deny: result.deny, reached: b.inputs.length > before, context: result.context ?? [] }
}

async function waited($: Engine, b: Bench, command: string, extra: Record<string, unknown> = {}): Promise<Answer> {
  const pending = bash($, b, command, extra)
  for (let i = 0; i <= LOCK_TRIES + 1; i++) await b.clock.advance(LOCK_WAIT_MS)
  return pending
}

const entries = (b: Bench): LedgerEntry[] => (b.files.has(LEDGER) ? (JSON.parse(b.files.get(LEDGER) as string) as { entries: LedgerEntry[] }).entries : [])

const entry = (overrides: Partial<LedgerEntry> = {}): LedgerEntry => ({
  project: '/repo',
  session: 'old-session',
  createdAt: 1,
  unit: 'unit-a',
  worktree: TREE,
  branch: 'unit/a',
  database: DB,
  connection: '',
  isDatabaseCreated: false,
  ...overrides,
})

const seed = (b: Bench, list: readonly LedgerEntry[]): void => void b.files.set(LEDGER, JSON.stringify({ version: 1, entries: list }))

function expectRefused(answer: Answer): void {
  expect(answer.reached).toBe(false)
  expect(answer.deny).toContain('Provisioning guard (workbench-core)')
  expect(answer.deny).toContain(ROOT_FORM)
  expect(answer.deny).toContain(NAME_FORM)
  expect(answer.deny).toContain('git worktree add -b <branch> <path> [<base>]')
}

describe('AC1: a worktree add', () => {
  for (const [line, path] of [
    [ADD, TREE],
    [`git -C /repo worktree add -b unit/a ${TREE}`, TREE],
    [`git worktree add -b unit/a ${TREE}/`, TREE],
    [`git worktree add -b unit/a ${HOME}//Developer//worktrees/repo/unit-a`, TREE],
  ]) {
    test(`the main lane runs ${JSON.stringify(line)}, and the ledger records the tree, the branch and the reserved database`, async ($, on) => {
      const b = await attended($, on)
      const answer = await bash($, b, line as string)
      expect([answer.deny, answer.reached]).toEqual([undefined, true])
      expect(entries(b).map(({ createdAt, ...rest }) => [typeof createdAt, rest])).toEqual([
        ['number', { project: '/repo', session: SID, unit: 'unit-a', worktree: path, branch: 'unit/a', database: DB, connection: '', isDatabaseCreated: false }],
      ])
      expect(answer.context.join('\n')).toContain(`Its unit test database name is ${DB}.`)
    })
  }

  for (const path of ['/tmp/unit-a', `${HOME}/Developer/worktrees/other/unit-a`, `${ROOT}/a/b`, '../unit-a', ROOT, `${ROOT}/../repo/unit-a`]) {
    test(`a main-lane add at ${path}, outside the root, is refused and recorded nowhere`, async ($, on) => {
      const b = await attended($, on)
      const answer = await bash($, b, `git worktree add -b unit/a ${path}`)
      expectRefused(answer)
      expect(answer.deny).toContain(`is not a unit folder directly under this project's worktree root ${ROOT}.`)
      expect(b.files.has(LEDGER)).toBe(false)
    })
  }

  test('a sub-agent add under the root is refused and recorded nowhere', async ($, on) => {
    const b = await attended($, on)
    const answer = await bash($, b, ADD, { agentId: SUB })
    expectRefused(answer)
    expect(answer.deny).toContain('a sub-agent may not create')
    expect(b.files.has(LEDGER)).toBe(false)
  })

  test('an add run from another repository is refused', async ($, on) => {
    const b = await attended($, on)
    expectRefused(await bash($, b, `git -C /other worktree add -b unit/a ${TREE}`))
    expect(b.files.has(LEDGER)).toBe(false)
  })

  test('an add onto a folder that already exists, such as a tree made by hand, is refused', async ($, on) => {
    const b = await attended($, on)
    b.kinds.set(TREE, 'dir')
    const answer = await bash($, b, ADD)
    expectRefused(answer)
    expect(answer.deny).toContain('already exists')
  })

  test('an add whose git run fails leaves no entry behind', async ($, on) => {
    const b = await attended($, on)
    b.onBash = () => ({ isError: true })
    const answer = await bash($, b, ADD)
    expect(answer.reached).toBe(true)
    expect(entries(b)).toEqual([])
  })

  test('an add the ledger already holds, or whose database name it holds, is refused', async ($, on) => {
    const b = await attended($, on)
    seed(b, [entry({ worktree: `${ROOT}/unit_a`, unit: 'unit_a' })])
    const answer = await bash($, b, ADD)
    expectRefused(answer)
    expect(answer.deny).toContain(`the database name ${DB}`)
  })

  test('a unit cleaned up in this session can be added again', async ($, on) => {
    const b = await attended($, on)
    await bash($, b, ADD)
    await bash($, b, `git worktree remove ${TREE}`)
    expect((await bash($, b, ADD)).reached).toBe(true)
    expect(entries(b).map(e => e.worktree)).toEqual([null, TREE])
  })

  test('an add in the background is refused, because the ledger could not record how it ended', async ($, on) => {
    const b = await attended($, on)
    expectRefused(await bash($, b, ADD, { run_in_background: true }))
    expect(entries(b)).toEqual([])
  })

  for (const line of [`git worktree add ${TREE}`, `git worktree add -B unit/a ${TREE}`, `cd /repo && ${ADD}`, `bash -c "${ADD}"`]) {
    test(`a provisioning line in another shape, ${JSON.stringify(line)}, is refused by the provisioning guard`, async ($, on) => {
      const b = await attended($, on)
      expectRefused(await bash($, b, line))
      expect(b.files.has(LEDGER)).toBe(false)
    })
  }
})

describe('AC2 and AC10: a unit test database', () => {
  for (const [line, connection] of [
    [`createdb ${DB}`, ''],
    [`createdb -h 127.0.0.1 -U root ${DB}`, '-U root -h 127.0.0.1'],
    [`psql --host 127.0.0.1 -U root -d postgres -c 'CREATE DATABASE "${DB}"'`, '-U root -h 127.0.0.1'],
  ]) {
    test(`after the add, the main lane runs ${JSON.stringify(line)}, and the ledger records it with its connection`, async ($, on) => {
      const b = await attended($, on)
      await bash($, b, ADD)
      const answer = await bash($, b, line as string)
      expect([answer.deny, answer.reached]).toEqual([undefined, true])
      expect(entries(b).map(e => [e.isDatabaseCreated, e.connection])).toEqual([[true, connection]])
    })
  }

  test('a create of a name the ledger did not reserve, a second create, and a create before the add are refused', async ($, on) => {
    const b = await attended($, on)
    expectRefused(await bash($, b, `createdb ${DB}`))
    await bash($, b, ADD)
    for (const line of ['createdb app', 'createdb wt_repo_unit_b_testing', `createdb -T template0 ${DB}`, `psql -c "CREATE DATABASE app"`]) expectRefused(await bash($, b, line))
    await bash($, b, `createdb ${DB}`)
    expectRefused(await bash($, b, `createdb ${DB}`))
  })

  test('a sub-agent create of the reserved name is refused', async ($, on) => {
    const b = await attended($, on)
    await bash($, b, ADD)
    const answer = await bash($, b, `createdb ${DB}`, { agentId: SUB })
    expectRefused(answer)
    expect(answer.deny).toContain('a sub-agent may not create')
    expect(entries(b).map(e => e.isDatabaseCreated)).toEqual([false])
  })

  test('the ledger marks a database created only after the create succeeds', async ($, on) => {
    const b = await attended($, on)
    await bash($, b, ADD)
    const during: boolean[] = []
    b.onBash = () => {
      during.push(entries(b)[0]?.isDatabaseCreated ?? true)
      return { isError: true }
    }
    await bash($, b, `createdb ${DB}`)
    expect([during, entries(b).map(e => e.isDatabaseCreated)]).toEqual([[false], [false]])
  })

  test('a main-lane create of a name over 55 characters is refused, and the refusal names the limit', async ($, on) => {
    const b = await attended($, on)
    const answer = await bash($, b, `createdb wt_${'x'.repeat(MAX_DATABASE - 2)}`)
    expectRefused(answer)
    expect(answer.deny).toContain('over the 55-character limit')
    expect((await bash($, b, `createdb wt_${'x'.repeat(MAX_DATABASE - 3)}`)).deny).not.toContain('55-character')
  })

  test('a short name is the form whole, and a long one is cut to 46 characters plus the first 8 hex digits of its SHA-256', async () => {
    expect(await unitDatabaseOf('/repo', 'Unit-A')).toBe(DB)
    expect(await unitDatabaseOf('/Users/tester/Code/a-very-long-repository-name-for-tests', 'unit-with-a-long-descriptive-name')).toBe('wt_a_very_long_repository_name_for_tests_unit__7d0c604f')
  })

  test('every name is at most 55 characters, and units that differ only past the cut get different names', async () => {
    const names = new Set<string>()
    for (let p = 1; p <= 70; p += 7) {
      for (let u = 1; u <= 70; u += 3) {
        const name = await unitDatabaseOf(`/code/${'p'.repeat(p)}`, `${'u'.repeat(u)}-1`)
        expect(name.length).toBeLessThanOrEqual(MAX_DATABASE)
        names.add(name)
      }
    }
    expect(names.size).toBe(10 * 24)
    expect(await unitDatabaseOf('/code/repo', `${'u'.repeat(60)}-1`)).not.toBe(await unitDatabaseOf('/code/repo', `${'u'.repeat(60)}-2`))
  })

  test('a long project and unit reserve a 55-character name, which the main lane may then create', async ($, on) => {
    const b = world(on)
    b.root = b.cwd = '/code/a-very-long-repository-name-for-tests'
    await $.session.start(start())
    const tree = `${HOME}/Developer/worktrees/a-very-long-repository-name-for-tests/unit-with-a-long-descriptive-name`
    expect((await bash($, b, `git worktree add -b unit/long ${tree}`)).reached).toBe(true)
    const [recorded] = entries(b)
    expect(recorded?.database.length).toBe(MAX_DATABASE)
    expect((await bash($, b, `createdb ${recorded?.database}`)).reached).toBe(true)
  })
})

describe('AC3: removal only for a ledger entry, from the main lane', () => {
  test('the main lane removes a recorded tree and drops its created database through psql, and the ledger notes both', async ($, on) => {
    const b = await attended($, on)
    await bash($, b, ADD)
    await bash($, b, `createdb -h 127.0.0.1 ${DB}`)
    expect(await bash($, b, `git worktree remove ${TREE}/`)).toEqual({ deny: undefined, reached: true, context: [] })
    expect((await bash($, b, `psql -h 127.0.0.1 -d postgres -c 'DROP DATABASE IF EXISTS "${DB}"'`)).reached).toBe(true)
    expect(entries(b).map(e => [e.worktree, e.isDatabaseCreated])).toEqual([[null, false]])
  })

  test('a drop with other connection options than the create is refused, so it reaches no other server', async ($, on) => {
    const b = await attended($, on)
    seed(b, [entry({ session: SID, isDatabaseCreated: true, connection: '-U root -h 127.0.0.1' })])
    for (const line of [DROP, `psql -h db.example.com -U root -c 'DROP DATABASE "${DB}"'`, `psql -h 127.0.0.1 -U root -p 6543 -c 'DROP DATABASE "${DB}"'`]) {
      const answer = await bash($, b, line)
      expectRefused(answer)
      expect(answer.deny).toContain('and the create used "-U root -h 127.0.0.1"')
    }
    expect((await bash($, b, `psql -U root --host 127.0.0.1 -c 'DROP DATABASE "${DB}"'`)).reached).toBe(true)
  })

  test('a hand-made tree inside the root, a database the ledger did not create, and dropdb in any form are refused', async ($, on) => {
    const b = await attended($, on)
    seed(b, [entry({ session: SID })])
    for (const line of [`git worktree remove ${ROOT}/handmade`, DROP, `psql -c 'DROP DATABASE "app"'`, `git worktree remove --force ${TREE}`, 'git worktree prune']) expectRefused(await bash($, b, line))
    for (const line of [`dropdb ${DB}`, 'dropdb app']) expect((await bash($, b, line)).reached).toBe(false)
    expect(entries(b)).toEqual([entry({ session: SID })])
  })

  test('a sub-agent may not remove a recorded tree or drop a recorded database', async ($, on) => {
    const b = await attended($, on)
    seed(b, [entry({ isDatabaseCreated: true })])
    for (const line of [`git worktree remove ${TREE}`, DROP]) {
      const answer = await bash($, b, line, { agentId: SUB })
      expectRefused(answer)
      expect(answer.deny).toContain('a sub-agent may not')
    }
    expect(entries(b)).toEqual([entry({ isDatabaseCreated: true })])
  })

  for (const line of ['git branch -D unit/a', 'git branch -d -f unit/a', 'git branch -fd unit/a', 'git branch -Dq unit/a', 'git branch --delete unit/a', 'git -C /repo branch -D unit/a', 'git update-ref -d refs/heads/unit/a', 'true && git branch -D unit/a']) {
    test(`a sub-agent may not delete a ledger branch with ${JSON.stringify(line)}`, async ($, on) => {
      const b = await attended($, on)
      seed(b, [entry()])
      expect((await bash($, b, line, { agentId: SUB })).reached).toBe(false)
    })
  }

  test("a removal that fails keeps the entry's tree", async ($, on) => {
    const b = await attended($, on)
    seed(b, [entry({ session: SID })])
    b.onBash = () => ({ isError: true })
    await bash($, b, `git worktree remove ${TREE}`)
    expect(entries(b).map(e => e.worktree)).toEqual([TREE])
  })
})

describe("a session removes only the units it recorded, and another session's units wait for Mike", () => {
  function expectForeign(answer: Answer, cleanup: string): void {
    expectRefused(answer)
    expect(answer.deny).toContain('belongs to a unit that session old-session recorded in the provisioning ledger, not this session')
    expect(answer.deny).toContain(`Remove nothing. Report it to Mike, who cleans it up himself with the ! prefix: ${cleanup}`)
  }

  test("a main-lane worktree remove of another session's unit is refused, names that session, and changes nothing", async ($, on) => {
    const b = await attended($, on)
    seed(b, [entry()])
    expectForeign(await bash($, b, `git worktree remove ${TREE}`), `! git -C /repo worktree remove ${TREE}`)
    expect(entries(b)).toEqual([entry()])
  })

  test('a main-lane worktree remove of a unit this session recorded runs, and the ledger notes it', async ($, on) => {
    const b = await attended($, on)
    seed(b, [entry({ session: SID })])
    expect(await bash($, b, `git worktree remove ${TREE}`)).toEqual({ deny: undefined, reached: true, context: [] })
    expect(entries(b)).toEqual([entry({ session: SID, worktree: null })])
  })

  test("a main-lane drop of another session's unit database is refused before the connection check, names that session, and changes nothing", async ($, on) => {
    const b = await attended($, on)
    const foreign = entry({ isDatabaseCreated: true, connection: '-h 127.0.0.1' })
    seed(b, [foreign])
    for (const line of [`psql -h 127.0.0.1 -c 'DROP DATABASE "${DB}"'`, DROP]) expectForeign(await bash($, b, line), `! psql -h 127.0.0.1 -c 'DROP DATABASE "${DB}"'`)
    expect(entries(b)).toEqual([foreign])
  })

  test('a main-lane drop of a unit database this session recorded runs, and the ledger notes it', async ($, on) => {
    const b = await attended($, on)
    seed(b, [entry({ session: SID, isDatabaseCreated: true, connection: '-h 127.0.0.1' })])
    expect((await bash($, b, `psql -h 127.0.0.1 -c 'DROP DATABASE "${DB}"'`)).reached).toBe(true)
    expect(entries(b)).toEqual([entry({ session: SID, connection: '-h 127.0.0.1' })])
  })

  test('the drop cleanup Mike runs carries no connection options when the create used none', async ($, on) => {
    const b = await attended($, on)
    seed(b, [entry({ isDatabaseCreated: true })])
    expectForeign(await bash($, b, DROP), `! psql -c 'DROP DATABASE "${DB}"'`)
  })

  test('the rules every provisioning refusal carries state the same-session rule', async ($, on) => {
    const b = await attended($, on)
    const answer = await bash($, b, `git worktree remove ${ROOT}/handmade`)
    expect(answer.deny).toContain('A session creates a unit database, removes a unit worktree or drops a unit database only for a unit it recorded itself in the provisioning ledger. Mike cleans up the units of other sessions.')
  })

  for (const line of [`createdb ${DB}`, `psql -c 'CREATE DATABASE "${DB}"'`]) {
    test(`a main-lane ${JSON.stringify(line)} of a name another session reserved is refused, names that session, and changes nothing`, async ($, on) => {
      const b = await attended($, on)
      seed(b, [entry()])
      const answer = await bash($, b, line)
      expectRefused(answer)
      expect(answer.deny).toContain(`the unit database name ${DB} belongs to a unit that session old-session recorded in the provisioning ledger, not this session`)
      expect(answer.deny).toContain('Create nothing. Report it to Mike, who decides what happens to that unit.')
      expect(entries(b)).toEqual([entry()])
    })
  }

  test('a main-lane create of a name this session reserved runs, and the ledger marks it created', async ($, on) => {
    const b = await attended($, on)
    seed(b, [entry({ session: SID })])
    expect((await bash($, b, `createdb ${DB}`)).reached).toBe(true)
    expect(entries(b)).toEqual([entry({ session: SID, isDatabaseCreated: true })])
  })
})

describe('AC4: the commit gate lets a unit branch be made, deleted and merged into a feature branch', () => {
  for (const line of ['git branch unit/b', 'git branch -d unit/a', 'git branch -D unit/a', 'git branch -D other/b', 'git merge --no-ff unit/a', 'git -C /repo merge --no-ff -m "Merge unit/a" unit/a']) {
    test(`on a feature branch, with unit/a in the ledger, ${JSON.stringify(line)} runs with no question`, async ($, on) => {
      const b = await attended($, on)
      await bash($, b, ADD)
      expect(await bash($, b, line)).toEqual({ deny: undefined, reached: true, context: [] })
    })
  }

  test('a merge of a unit branch into the default branch still asks Mike', async ($, on) => {
    const b = await attended($, on)
    b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'main', originHead: 'main', originUrl: 'git@github.com:o/r.git' }
    await bash($, b, ADD)
    const answer = await bash($, b, 'git merge --no-ff unit/a')
    expect(answer.reached).toBe(false)
    expect(answer.deny).toMatch(ASKS.merge)
  })
})

describe('AC5: leftovers are reported at session start', () => {
  async function started($: Engine, on: Parameters<typeof bench>[0], list: readonly LedgerEntry[], branches: readonly string[] = [], trees: readonly string[] = []) {
    const b = world(on, argv => (argv[3] === 'rev-parse' && argv[4] === '--verify' ? { exitCode: branches.some(name => argv.at(-1) === `refs/heads/${name}`) ? 0 : 1, stdout: '' } : undefined))
    seed(b, list)
    for (const tree of trees) b.kinds.set(tree, 'dir')
    await $.session.start(start())
    const result = await $.classic.SessionStart({ source: 'startup', session_id: SID, transcript_path: '/t.jsonl', cwd: '/repo' } as never)
    return { b, context: (result.additionalContext ?? []).join('\n') }
  }

  test("another session's entries whose tree, branch or database still exist are listed, and gone ones are dropped", async ($, on) => {
    const gone = entry({ worktree: `${ROOT}/gone`, unit: 'gone', branch: 'unit/gone', database: 'wt_repo_gone_testing', createdAt: 2 })
    const tree = entry({ worktree: `${ROOT}/tree`, unit: 'tree', branch: 'unit/tree', database: 'wt_repo_tree_testing', createdAt: 3 })
    const branch = entry({ worktree: null, unit: 'branch', branch: 'unit/branch', database: 'wt_repo_branch_testing', createdAt: 4 })
    const database = entry({ worktree: null, unit: 'db', branch: 'unit/db', database: 'wt_repo_db_testing', isDatabaseCreated: true, createdAt: 5 })
    const mine = entry({ session: SID, worktree: `${ROOT}/mine`, unit: 'mine', branch: 'unit/mine', database: 'wt_repo_mine_testing', createdAt: 6 })
    const { b, context } = await started($, on, [gone, tree, branch, database, mine], ['unit/branch'], [`${ROOT}/tree`, `${ROOT}/mine`])
    expect(context).toContain('# Provisioning ledger leftovers')
    expect(context).toContain('Each unit belongs to the session that recorded it, so remove nothing and run none of these commands. Report the list to Mike.')
    expect(context).toContain('cleans it up himself with the ! prefix.')
    expect(context).not.toContain('dropdb')
    expect(context).toContain(`- worktree ${ROOT}/tree (project /repo, recorded by session old-session at 1970-01-01T00:00:00.003Z). Mike runs:\n  - \`! git -C /repo worktree remove ${ROOT}/tree\`\n-`)
    expect(context).toContain('- branch unit/branch (project /repo, recorded by session old-session at 1970-01-01T00:00:00.004Z). Mike runs:\n  - `! git -C /repo branch -d unit/branch`\n-')
    expect(context).toContain(`- database wt_repo_db_testing (project /repo, recorded by session old-session at 1970-01-01T00:00:00.005Z). Mike runs:\n  - \`! psql -c 'DROP DATABASE "wt_repo_db_testing"'\``)
    expect(context).not.toContain('gone')
    expect(context).not.toContain('mine')
    expect(entries(b)).toEqual([tree, branch, database, mine])
  })

  test("a young entry of another session, whose add may still be running, is neither listed nor dropped", async ($, on) => {
    const young = entry({ worktree: `${ROOT}/young`, unit: 'young', createdAt: START - PRUNE_AFTER_MS + 1 })
    const { b, context } = await started($, on, [young])
    expect(context).toBe('the rules')
    expect(entries(b)).toEqual([young])
  })

  test('a ledger with no leftovers adds nothing', async ($, on) => {
    const { context } = await started($, on, [entry({ session: SID })])
    expect(context).toBe('the rules')
  })

  test('an unreadable ledger is reported at session start', async ($, on) => {
    const b = world(on)
    b.files.set(LEDGER, '{ not json')
    await $.session.start(start())
    const result = await $.classic.SessionStart({ source: 'startup', session_id: SID, transcript_path: '/t.jsonl', cwd: '/repo' } as never)
    expect((result.additionalContext ?? []).join('\n')).toContain('The provisioning ledger at /Users/tester/.claude-workbench/provisioning/ledger.json cannot be read (the file is not valid JSON)')
  })
})

describe('AC6: a ledger that does not read refuses creation and removal, and says why', () => {
  for (const [text, why] of [
    ['{ not json', 'the file is not valid JSON'],
    ['{"version":1,"entries":[{"project":"/repo"}]}', 'the file does not hold a version 1 ledger of entries'],
    ['[]', 'the file does not hold a version 1 ledger of entries'],
  ] as const) {
    test(`a ledger holding ${JSON.stringify(text)} refuses every provisioning line`, async ($, on) => {
      const b = await attended($, on)
      b.files.set(LEDGER, text)
      for (const line of [ADD, `git worktree remove ${TREE}`, `createdb ${DB}`, DROP]) {
        const answer = await bash($, b, line)
        expectRefused(answer)
        expect(answer.deny).toContain(`the provisioning ledger at ${LEDGER} cannot be read (${why})`)
      }
      expect(b.files.get(LEDGER)).toBe(text)
    })
  }

  test('a ledger that does not read leaves a main-lane branch delete alone, and refuses a sub-agent one', async ($, on) => {
    const b = await attended($, on)
    b.files.set(LEDGER, '{ not json')
    expect((await bash($, b, 'git branch -d unit/a')).reached).toBe(true)
    expectRefused(await bash($, b, 'git branch -d unit/a', { agentId: SUB }))
  })

  test('a ledger that cannot be written refuses the add before it runs', async ($, on) => {
    const b = await attended($, on)
    b.dirs.add(LEDGER)
    const answer = await bash($, b, ADD)
    expectRefused(answer)
    expect(answer.deny).toContain('could not be written')
  })

  test('a caller lane that cannot be read is taken as a sub-agent on each ledger line', async ($, on) => {
    const b = world(on)
    seed(b, [entry({ session: SID, isDatabaseCreated: true })])
    for (const line of [`git worktree add -b unit/b ${ROOT}/unit-b`, `git worktree remove ${TREE}`, `createdb ${DB}`, DROP]) {
      const answer = await bash($, b, line)
      expect([line, answer.reached, answer.deny?.includes('a sub-agent may not')]).toEqual([line, false, true])
    }
  })
})

describe('AC7: every provisioning refusal names the root, the naming form and what to do instead', () => {
  test('the tool refusals and a Bash refusal outside the ledger', () => {
    for (const text of [ENTER_WORKTREE_REFUSAL, EXIT_WORKTREE_REFUSAL, AGENT_WORKTREE_REFUSAL, provisioningRefusal('git worktree prune') as string, LEDGER_WRITE_REFUSAL.deny]) {
      expect([text.includes(ROOT_FORM), text.includes(NAME_FORM), text.includes('git worktree add -b <branch> <path> [<base>]'), text.includes('ask Mike')]).toEqual([true, true, true, true])
    }
  })
})

const NOT_APPROVED = /was refused: Mike has not approved it\./

async function inUnit($: Engine, on: Parameters<typeof bench>[0], branch: string | null = 'unit/a'): Promise<World> {
  const b = await attended($, on)
  seed(b, [entry({ session: SID })])
  b.repos[TREE] = { head: 'c2', pushed: 'c2', branch, originHead: 'main', originUrl: 'git@github.com:o/r.git' }
  b.trees[TREE] = 'M  a.ts\0'
  return b
}

async function permission($: Engine, command: string, agentId?: string): Promise<unknown> {
  const result = await $.classic.PermissionRequest({
    hook_event_name: 'PermissionRequest',
    session_id: 's',
    transcript_path: '/t.jsonl',
    cwd: '/repo',
    tool_name: 'Bash',
    tool_input: { command },
    ...(agentId ? { agent_id: agentId, agent_type: 'watson' } : {}),
  } as never)
  return (result as { decision?: unknown }).decision
}

describe('AC11: a plain commit in a ledger worktree on its unit branch runs with no question', () => {
  for (const line of [UNIT_COMMIT, `git -C ${TREE} commit -F /scratch/msg.txt`]) {
    test(`the main lane runs ${JSON.stringify(line)}, and the permission dialog is answered allow`, async ($, on) => {
      const b = await inUnit($, on)
      expect(await bash($, b, line)).toEqual({ deny: undefined, reached: true, context: [] })
      expect(await permission($, line)).toEqual({ behavior: 'allow' })
    })
  }

  test('the same commit on another branch in that tree asks Mike, and the dialog gets no answer', async ($, on) => {
    const b = await inUnit($, on, 'feat/x')
    const answer = await bash($, b, UNIT_COMMIT)
    expect([answer.reached, ASKS.commit.test(answer.deny ?? '')]).toEqual([false, true])
    expect(await permission($, UNIT_COMMIT)).toBeUndefined()
  })

  test('the same commit with a detached HEAD in that tree asks Mike', async ($, on) => {
    const b = await inUnit($, on, null)
    expect((await bash($, b, UNIT_COMMIT)).deny).toMatch(ASKS.commit)
  })

  test('the same commit in a tree the ledger did not record asks Mike, and the dialog gets no answer', async ($, on) => {
    const b = await inUnit($, on)
    const tree = `${ROOT}/handmade`
    b.repos[tree] = { head: 'c3', branch: 'unit/a', originHead: 'main' }
    b.trees[tree] = 'M  a.ts\0'
    const line = `git -C ${tree} commit -m "fix: 🐛 X."`
    const answer = await bash($, b, line)
    expect([answer.reached, ASKS.commit.test(answer.deny ?? '')]).toEqual([false, true])
    expect(await permission($, line)).toBeUndefined()
  })

  test("the same commit in a unit tree another session recorded asks Mike, and the dialog gets no answer", async ($, on) => {
    const b = await inUnit($, on)
    seed(b, [entry()])
    const answer = await bash($, b, UNIT_COMMIT)
    expect([answer.reached, ASKS.commit.test(answer.deny ?? '')]).toEqual([false, true])
    expect(await permission($, UNIT_COMMIT)).toBeUndefined()
  })

  for (const line of [`cd ${TREE} && git commit -m "fix: 🐛 X."`, `git -c core.hooksPath=/dev/null -C ${TREE} commit -m "fix: 🐛 X."`]) {
    test(`a commit in another form, ${JSON.stringify(line)}, gets no exemption`, async ($, on) => {
      const b = await inUnit($, on)
      expect((await bash($, b, line)).reached).toBe(false)
      expect(await permission($, line)).toBeUndefined()
    })
  }

  test('a ledger that does not read gives no exemption, and the commit asks Mike', async ($, on) => {
    const b = await inUnit($, on)
    b.files.set(LEDGER, '{ not json')
    expect((await bash($, b, UNIT_COMMIT)).deny).toMatch(ASKS.commit)
  })

  test('a sub-agent commit in the ledger worktree is refused as before, and the dialog gets no answer', async ($, on) => {
    const b = await inUnit($, on)
    const answer = await bash($, b, UNIT_COMMIT, { agentId: SUB })
    expect([answer.reached, answer.deny]).toEqual([false, SUBAGENT_REFUSAL.deny])
    expect(await permission($, UNIT_COMMIT, SUB)).toBeUndefined()
  })

  test('the commit must still take the whole tree, and the dialog gets no answer when it does not', async ($, on) => {
    const b = await inUnit($, on)
    b.trees[TREE] = 'M  a.ts\0?? b.ts\0'
    const answer = await bash($, b, UNIT_COMMIT)
    expect(answer.reached).toBe(false)
    expect(answer.deny).toContain('b.ts')
    expect(await permission($, UNIT_COMMIT)).toBeUndefined()
  })
})

describe('AC12: the unit-commit exemption reaches no push, merge into the default branch, release or rewrite', () => {
  test('each still asks Mike, from the ledger worktree on its unit branch, exactly as with no ledger', async ($, on) => {
    const b = await inUnit($, on)
    b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'main', originHead: 'main', originUrl: 'git@github.com:o/r.git' }
    const cases: [string, RegExp][] = [
      [`git -C ${TREE} push`, ASKS.push],
      [`${UNIT_COMMIT} && git -C ${TREE} push`, /refused/],
      [`${UNIT_COMMIT} && git -C /repo merge --no-ff unit/a`, /refused/],
      ['git -C /repo merge --no-ff unit/a', ASKS.merge],
      [`git -C ${TREE} commit --amend -m "fix: 🐛 X."`, NOT_APPROVED],
      [`git -C ${TREE} cherry-pick abc1234`, ASKS.rewrite],
      ['gh release create 1.0.0', ASKS.release],
    ]
    const withLedger: (string | undefined)[] = []
    for (const [line, asked] of cases) {
      const answer = await bash($, b, line)
      withLedger.push(answer.deny)
      expect([line, answer.reached, asked.test(answer.deny ?? '')]).toEqual([line, false, true])
    }
    b.files.delete(LEDGER)
    const without: (string | undefined)[] = []
    for (const [line] of cases) without.push((await bash($, b, line)).deny)
    expect(withLedger).toEqual(without)
  })
})

describe('AC14: ledger writes are serialized by a lock', () => {
  test('two adds at the same moment both land in the ledger, and the second waited for the lock', async ($, on) => {
    const b = await attended($, on)
    const both = Promise.all([bash($, b, ADD), bash($, b, `git worktree add -b unit/b ${ROOT}/unit-b`)])
    for (let i = 0; i < 10; i++) await b.clock.advance(LOCK_WAIT_MS)
    const answers = await both
    expect(answers.map(answer => answer.reached)).toEqual([true, true])
    expect(entries(b).map(e => e.worktree).sort()).toEqual([TREE, `${ROOT}/unit-b`])
    expect(b.refusedTakes.length).toBeGreaterThan(0)
  })

  test('a lock another session holds past the wait refuses the add with the reason, and records nothing', async ($, on) => {
    const b = world(on)
    b.held.add(LOCK)
    await $.session.start(start())
    const answer = await waited($, b, ADD)
    expectRefused(answer)
    expect(answer.deny).toContain(`another session held the provisioning ledger's lock at ${LOCK} for over 2 seconds`)
    expect(b.files.has(LEDGER)).toBe(false)
  })

  for (const [name, line, seeded, stale] of [
    ['a create', `createdb ${DB}`, entry({ session: SID }), `${DB} was created, so the ledger cannot free its drop`],
    ['a remove', `git worktree remove ${TREE}`, entry({ session: SID }), `${TREE} was removed`],
    ['a drop', DROP, entry({ session: SID, isDatabaseCreated: true }), `${DB} was dropped`],
  ] as const) {
    test(`a lock held across the record of ${name} leaves a context line that names the stale entry`, async ($, on) => {
      const b = await attended($, on)
      seed(b, [seeded])
      b.onBash = () => void b.held.add(LOCK)
      const answer = await waited($, b, line)
      expect(answer.reached).toBe(true)
      expect(answer.context.join('\n')).toContain(`could not record its result, because another session held its lock, so its entry is stale. ${stale}`)
      expect(entries(b)).toEqual([seeded])
    })
  }

  test('a lock held across the rollback of a failed add leaves a context line that names the stale entry', async ($, on) => {
    const b = await attended($, on)
    b.onBash = () => {
      b.held.add(LOCK)
      return { isError: true }
    }
    const answer = await waited($, b, ADD)
    expect(answer.context.join('\n')).toContain(`git failed, so ${TREE} does not exist, yet its entry stays in the ledger`)
    expect(entries(b).map(e => e.worktree)).toEqual([TREE])
  })
})

describe('AC15: only the guard writes the ledger, and a forged entry reaches nothing outside the unit form', () => {
  for (const lane of [{ name: 'the main lane' }, { name: 'a sub-agent', agentId: SUB }]) {
    test(`${lane.name}: a write, an edit or a Bash write of the ledger or its lock is refused`, async ($, on) => {
      const b = await attended($, on)
      const extra = lane.agentId === undefined ? {} : { agentId: lane.agentId }
      for (const call of [
        { tool: 'Write', file_path: LEDGER, content: '{}' },
        { tool: 'Edit', file_path: LEDGER, old_string: 'a', new_string: 'b' },
        { tool: 'NotebookEdit', notebook_path: LEDGER, new_source: 'x' },
        { tool: 'Write', file_path: `${LOCK}/x`, content: '' },
      ]) {
        const result = await $.tool.call({ ...call, ...extra } as never)
        expect([call.tool, result.deny]).toEqual([call.tool, LEDGER_WRITE_REFUSAL.deny])
      }
      for (const line of [
        `echo '{}' > ${LEDGER}`,
        `tee ${LEDGER} < /tmp/x`,
        `cp /tmp/x ${LEDGER}`,
        `mv /tmp/x ${LEDGER}`,
        `sed -i '' s/a/b/ ${LEDGER}`,
        `python3 -c "open('${LEDGER}', 'w')"`,
        `mkdir ${LOCK}`,
        `rmdir ${LOCK}`,
        `cp /tmp/x ${HOME}/.claude-workbench/prov*`,
        `cat /tmp/x > ~/.claude-workbench/PROVISIONING-LEDGER.json`,
      ]) {
        const answer = await bash($, b, line, extra)
        expect([line, answer.deny]).toEqual([line, LEDGER_WRITE_REFUSAL.deny])
      }
    })
  }

  test('the ledger can still be read', async ($, on) => {
    const b = await attended($, on)
    for (const line of [`cat ${LEDGER}`, `jq . ${LEDGER}`, `grep -c unit ${LEDGER} 2>/dev/null`]) expect((await bash($, b, line)).reached).toBe(true)
    expect((await $.tool.call({ tool: 'Read', file_path: LEDGER } as never)).deny).toBeUndefined()
  })

  test('a forged entry frees no create or drop of a name outside the unit form', async ($, on) => {
    const b = await attended($, on)
    seed(b, [
      entry({ session: SID, unit: 'unit-a', database: 'crossbible' }),
      entry({ session: SID, worktree: null, unit: 'x', database: 'crossbible_dev', isDatabaseCreated: true, createdAt: 2 }),
      entry({ session: SID, worktree: null, unit: 'unit-a', database: 'wt_repo_unit_b_testing', isDatabaseCreated: true, createdAt: 3 }),
    ])
    for (const line of ['createdb crossbible', `psql -c 'DROP DATABASE "crossbible_dev"'`, `psql -c 'DROP DATABASE "wt_repo_unit_b_testing"'`]) expectRefused(await bash($, b, line))
  })

  test('a forged entry frees no removal of a tree outside the root, and no unit commit there', async ($, on) => {
    const b = await attended($, on)
    seed(b, [entry({ session: SID, worktree: '/repo', unit: 'repo', branch: 'feat/x' }), entry({ session: SID, worktree: `${ROOT}/x`, unit: 'other', createdAt: 2 })])
    expectRefused(await bash($, b, 'git worktree remove /repo'))
    expectRefused(await bash($, b, `git worktree remove ${ROOT}/x`))
    expect((await bash($, b, 'git -C /repo commit -m "fix: 🐛 X."')).deny).toMatch(ASKS.commit)
  })

  test('a symbolic-link root into the shared worktrees folder is followed, and the unit runs through it', async ($, on) => {
    const real = `${HOME}/Developer/worktrees/elsewhere/repo`
    const b = await attended($, on)
    let hasTree = false
    b.stat = path => (path === ROOT ? { kind: 'dir', isLink: true, realPath: real } : path === TREE && hasTree ? { kind: 'dir', isLink: false, realPath: `${real}/unit-a` } : undefined)
    expect((await bash($, b, ADD)).reached).toBe(true)
    hasTree = true
    b.repos[TREE] = { head: 'c2', branch: 'unit/a', originHead: 'main' }
    b.trees[TREE] = 'M  a.ts\0'
    expect((await bash($, b, UNIT_COMMIT)).reached).toBe(true)
    expect((await bash($, b, `git worktree remove ${TREE}`)).reached).toBe(true)
  })

  test('a recorded tree swapped for a symbolic link is neither removed nor committed in with no question', async ($, on) => {
    const b = await inUnit($, on)
    b.stat = path => (path === TREE ? { kind: 'dir', isLink: true, realPath: '/repo' } : undefined)
    const answer = await bash($, b, `git worktree remove ${TREE}`)
    expectRefused(answer)
    expect(answer.deny).toContain('a symbolic link stands in its place or above it')
    expect((await bash($, b, UNIT_COMMIT)).deny).toMatch(ASKS.commit)
    expect(await permission($, UNIT_COMMIT)).toBeUndefined()
  })
})

describe('AC17 and AC21: every Bash spelling that reaches the ledger subfolder is refused, and a literal read still runs', () => {
  const WRITES = [
    'cd ~/.claude-workbench && cp /tmp/x provisioning/l*.json',
    'cd ~/.claude-workbench && cp /tmp/x p*/ledger.json',
    'cp /tmp/x ~/.claude-workbench/./provisioning/l*.json',
    'cp /tmp/x ~//.claude-workbench//provisioning//ledger.json',
    'tee ~/.claude-workbench/{provisioning,x}/ledger.json < /tmp/x',
    `cp /tmp/x ${HOME}/.claude-workbench/bin/../provisioning/ledger.json`,
    'cp /tmp/x ~/.claude-workbench/p*/ledger.json',
    'cp /tmp/x ~/.claude-workbench/[p]rovisioning/ledger.json',
    'ln -s ~/.claude-workbench /scratch/cw',
    'ln -s ~ /scratch/h',
    `ln -s ${HOME}/.claude-workbench/provisioning /scratch/l`,
    `ln -s ${LOCK} /scratch/l`,
    `rg --pre /scratch/w.sh unit ${LEDGER}`,
    `less ${LEDGER}`,
    `LESSOPEN='|/scratch/w.sh %s' cat ${LEDGER}`,
    'cat ~/.claude-workbench/provisioning/*',
    'mkdir ~/.claude-workbench/provisioning',
    `mkdir ${LOCK}`,
    `rmdir ${LOCK}`,
  ]
  for (const lane of [{ name: 'the main lane' }, { name: 'a sub-agent', agentId: SUB }]) {
    test(`${lane.name}: each spelling is refused`, async ($, on) => {
      const b = await attended($, on)
      const extra = lane.agentId === undefined ? {} : { agentId: lane.agentId }
      for (const line of WRITES) expect([line, (await bash($, b, line, extra)).deny]).toEqual([line, LEDGER_WRITE_REFUSAL.deny])
    })

    test(`${lane.name}: inside the ledger subfolder only a literal read runs, and inside the workbench folder only a glob is refused`, async ($, on) => {
      const b = await attended($, on)
      const extra = lane.agentId === undefined ? {} : { agentId: lane.agentId }
      b.cwd = `${HOME}/.claude-workbench/provisioning`
      expect((await bash($, b, 'cp /tmp/x ledger.json', extra)).deny).toBe(LEDGER_WRITE_REFUSAL.deny)
      expect((await bash($, b, 'cat ledger.json', extra)).reached).toBe(true)
      b.cwd = `${HOME}/.claude-workbench`
      expect((await bash($, b, 'cp /tmp/x p*', extra)).deny).toBe(LEDGER_WRITE_REFUSAL.deny)
      expect((await bash($, b, 'cp /tmp/x dev-team-config.json', extra)).reached).toBe(true)
    })

    test(`${lane.name}: a Write through a link into the ledger subfolder is refused, and one beside it runs`, async ($, on) => {
      const b = await attended($, on)
      b.stat = path => (path === '/scratch/cw' ? { kind: 'dir' as const, isLink: true, realPath: `${HOME}/.claude-workbench` } : undefined)
      const extra = lane.agentId === undefined ? {} : { agentId: lane.agentId }
      const into = await $.tool.call({ tool: 'Write', file_path: '/scratch/cw/provisioning/ledger.json', content: '{}', ...extra } as never)
      expect(into.deny).toBe(LEDGER_WRITE_REFUSAL.deny)
      const beside = await $.tool.call({ tool: 'Write', file_path: '/scratch/cw/dev-team-config.json', content: '{}', ...extra } as never)
      expect(beside.deny).toBeUndefined()
    })
  }

  test('a listed reader with literal paths runs', async ($, on) => {
    const b = await attended($, on)
    for (const line of [`cat ${LEDGER}`, `jq . ${LEDGER}`, `grep -c unit ${LEDGER} 2>/dev/null`, 'ls ~/.claude-workbench/provisioning', `head -n 5 ${LEDGER}`]) {
      expect([line, (await bash($, b, line)).reached]).toEqual([line, true])
    }
  })
})

describe('AC17 (amended): the cheap one-line bulk writes into the ledger subfolder are refused', () => {
  const BULK = [
    'find ~/.claude-workbench/provisioning -name ledger.json -exec cp /tmp/x {} ;',
    'find ~/.claude-workbench -execdir touch {} +',
    'find ~ -name "*.json" -ok rm {} ;',
    `find ${HOME} -okdir true {} ;`,
    'cp -R /tmp/forged/. ~/.claude-workbench/provisioning',
    'cp -r /tmp/forged ~/.claude-workbench',
    'cp -a /tmp/home-copy ~',
    'rsync -a /tmp/forged/ ~/.claude-workbench/',
    'ditto /tmp/forged ~/.claude-workbench/provisioning',
    'tar -xf /tmp/forged.tar -C ~/.claude-workbench',
    'tar xzf /tmp/forged.tgz --directory=~',
    'unzip /tmp/forged.zip -d ~',
    'mv /tmp/forged ~/.claude-workbench/provisioning',
    'mv ~/.claude-workbench /tmp/cw',
    'mv ~/.claude-workbench/provisioning /tmp/p',
    'rename s/a/b/ ~/.claude-workbench',
    'cd "$(dirname ~/.claude-workbench/x)" && cp /tmp/x l.json',
  ]
  for (const lane of [{ name: 'the main lane' }, { name: 'a sub-agent', agentId: SUB }]) {
    test(`${lane.name}: each bulk write is refused`, async ($, on) => {
      const b = await attended($, on)
      const extra = lane.agentId === undefined ? {} : { agentId: lane.agentId }
      for (const line of BULK) expect([line, (await bash($, b, line, extra)).deny]).toEqual([line, LEDGER_WRITE_REFUSAL.deny])
    })
  }
})

describe('AC24: a cd into a substitution counts as entering the subfolder only when the line names the workbench folder', () => {
  for (const lane of [{ name: 'the main lane' }, { name: 'a sub-agent', agentId: SUB }]) {
    test(`${lane.name}: the top-level idiom runs, and a substitution that names the folder is refused`, async ($, on) => {
      const b = await attended($, on)
      const extra = lane.agentId === undefined ? {} : { agentId: lane.agentId }
      for (const line of ['cd "$(git rev-parse --show-toplevel)" && make', 'pushd "$(git rev-parse --show-toplevel)" && make']) {
        expect([line, (await bash($, b, line, extra)).deny === LEDGER_WRITE_REFUSAL.deny]).toEqual([line, false])
      }
      for (const line of ['cd "$(echo ~/.claude-workbench/prov)isioning" && cp /tmp/x ledger.json', 'cd `echo ~/.claude-workbench/prov`isioning && cp /tmp/x ledger.json']) {
        expect([line, (await bash($, b, line, extra)).deny]).toEqual([line, LEDGER_WRITE_REFUSAL.deny])
      }
    })
  }
})

describe('AC23: an ordinary find and an ordinary recursive copy still run', () => {
  for (const lane of [{ name: 'the main lane' }, { name: 'a sub-agent', agentId: SUB }]) {
    test(`${lane.name}: finds under a project or ~/Developer, and copies inside a project, pass the ledger guard`, async ($, on) => {
      const b = await attended($, on)
      const extra = lane.agentId === undefined ? {} : { agentId: lane.agentId }
      for (const line of [
        'find /repo -name "*.ts" -exec grep -l ledger {} +',
        `find ${HOME}/Developer/repo -type f -execdir wc -l {} +`,
        'find . -name "*.log" -exec cat {} ;',
        'cp -R /repo/src /repo/backup',
        'cp -a /repo/fixtures /repo/tmp-fixtures',
        'rsync -a /repo/assets/ /repo/public/',
        'tar -xf /repo/vendor.tar -C /repo/vendor',
        'mv /repo/old /repo/new',
        'cp -r src lib',
        `cp -R /repo/x ${HOME}/.claude-workbench/dev-team-logs`,
      ]) {
        expect([line, (await bash($, b, line, extra)).deny === LEDGER_WRITE_REFUSAL.deny]).toEqual([line, false])
      }
    })
  }
})

describe('AC20: ordinary work on the other files in ~/.claude-workbench runs', () => {
  const LINES = [
    'bash "$HOME/.claude-workbench/bin/dispatch-agent.sh" watson 12',
    'bash "$HOME/.claude-workbench/bin/dispatch-agent.sh" --check watson 12',
    'bash "$HOME/.claude-workbench/bin/dispatch-agent.sh" --mark-escalated holmes 12',
    'mkdir -p "$HOME/.claude-workbench/dev-team-logs"',
    'PIN_CFG="${DEVTEAM_CONFIG:-$HOME/.claude-workbench/dev-team-config.json}"',
    `jq '.watson.model = "opus"' "$HOME/.claude-workbench/dev-team-config.json" > "$HOME/.claude-workbench/dev-team-config.json.tmp"`,
    'mv "$HOME/.claude-workbench/dev-team-config.json.tmp" "$HOME/.claude-workbench/dev-team-config.json"',
    'tail -n 50 ~/.claude-workbench/dev-team-logs/watson-12.log',
    'ls ~/.claude-workbench/dev-team-logs',
    'DP_OUT="$HOME/.claude-workbench/dispatch-prompt.md"',
    'DA_ABS="Bash(bash $HOME/.claude-workbench/bin/dispatch-agent.sh:*)"',
    `DA_HOME='Bash(bash "$HOME/.claude-workbench/bin/dispatch-agent.sh":*)'`,
    'DI_BIN="$HOME/.claude-workbench/bin"',
    'cat ~/.claude-workbench/chat-skills-state.json',
    'ls ~/.claude-workbench',
  ]
  for (const lane of [{ name: 'the main lane' }, { name: 'a sub-agent', agentId: SUB }]) {
    test(`${lane.name}: lines the skills run on the workbench folder pass the ledger guard`, async ($, on) => {
      const b = await attended($, on)
      b.files.set(`${HOME}/.claude-workbench/bin/dispatch-agent.sh`, '#!/bin/bash\necho dispatched\n')
      const extra = lane.agentId === undefined ? {} : { agentId: lane.agentId }
      for (const line of LINES) {
        const answer = await bash($, b, line, extra)
        expect([line, answer.deny === LEDGER_WRITE_REFUSAL.deny, answer.reached]).toEqual([line, false, true])
      }
    })
  }
})

describe('AC18: a root link is followed only into an allowed root', () => {
  test('a root linked outside the allowed roots is refused, and the refusal names them', async ($, on) => {
    const b = await attended($, on)
    b.stat = path => (path === ROOT ? { kind: 'dir' as const, isLink: true, realPath: `${HOME}/Developer` } : undefined)
    const answer = await bash($, b, ADD)
    expectRefused(answer)
    expect(answer.deny).toContain(`the worktree root ${ROOT} resolves to ${HOME}/Developer, outside the allowed roots: a folder inside ${HOME}/Developer/worktrees, or /worktrees/repo, the worktrees folder beside this repository`)
    seed(b, [entry({ session: SID })])
    b.repos[TREE] = { head: 'c2', branch: 'unit/a', originHead: 'main' }
    b.trees[TREE] = 'M  a.ts\0'
    expectRefused(await bash($, b, `git worktree remove ${TREE}`))
    expect((await bash($, b, UNIT_COMMIT)).deny).toMatch(ASKS.commit)
  })

  test('a root linked to the worktrees folder beside the repository, as Herdr groups it, is followed', async ($, on) => {
    const b = world(on)
    const project = `${HOME}/Developer/Org/repo`
    b.root = b.cwd = project
    b.stat = path => (path === ROOT ? { kind: 'dir' as const, isLink: true, realPath: `${HOME}/Developer/Org/worktrees/repo` } : undefined)
    await $.session.start(start())
    expect((await bash($, b, ADD)).reached).toBe(true)
    expect((await bash($, b, `git worktree remove ${TREE}`)).reached).toBe(true)
  })
})

describe('AC19: the commit switches the exemption accepts', () => {
  test('-a with an untracked file is refused by the whole-tree check, and the dialog gets no answer', async ($, on) => {
    const b = await inUnit($, on)
    b.trees[TREE] = ' M a.ts\0?? b.ts\0'
    const line = `git -C ${TREE} commit -a -m "fix: 🐛 X."`
    const answer = await bash($, b, line)
    expect([answer.reached, answer.deny?.includes('b.ts')]).toEqual([false, true])
    expect(await permission($, line)).toBeUndefined()
  })

  test('-a on a tree whose changes are all tracked runs, and the dialog is answered allow', async ($, on) => {
    const b = await inUnit($, on)
    b.trees[TREE] = ' M a.ts\0'
    const line = `git -C ${TREE} commit -a -q -m "fix: 🐛 X."`
    expect((await bash($, b, line)).reached).toBe(true)
    expect(await permission($, line)).toEqual({ behavior: 'allow' })
  })

  for (const line of [`git -C ${TREE} commit -am "fix: 🐛 X."`, `git -C ${TREE} commit --amend -m "fix: 🐛 X."`]) {
    test(`${JSON.stringify(line)} gets no exemption and no allow`, async ($, on) => {
      const b = await inUnit($, on)
      expect((await bash($, b, line)).reached).toBe(false)
      expect(await permission($, line)).toBeUndefined()
    })
  }
})

describe('the shapes the ledger reads', () => {
  test('only one plain statement of an accepted shape is a provisioning line, and any branch delete is read', () => {
    const kinds = (line: string) => ledgerCommandOf(parseShell(line))?.kind
    expect([ADD, `git worktree remove ${TREE}`, `createdb ${DB}`, DROP, 'git branch -Dq unit/a', 'true && git update-ref --delete refs/heads/unit/a'].map(kinds)).toEqual([
      'add',
      'remove',
      'create',
      'drop',
      'branch-delete',
      'branch-delete',
    ])
    for (const line of [`${ADD} && true`, `FOO=1 ${ADD}`, `git worktree add -b unit/a $T`, `createdb ${DB} > out`, `sudo createdb ${DB}`, 'psql -c "SELECT 1"', 'git branch unit/a', 'createdb a b', `dropdb ${DB}`]) {
      expect([line, kinds(line)]).toEqual([line, undefined])
    }
  })
})
