// The destructive-scope, destructive-database and vault-git guards in the hooks
// module (hooks/mods/destructive-scope.ts, destructive-database.ts and
// vault-git.ts), driven through the engine's tool.call and tool.check in a
// modeled world (tests/world.ts). tests/guard-differential.test.ts holds each
// one to its frozen bash guard; this file pins each behaviour in both
// directions, and what each refusal and each prompt tells the reader to do.

import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { checkSql } from '../hooks/mods/destructive-database'
import { NO_ONE_TO_ASK, cwdsAfter, getterOf, isLinearLine, scopeVerdict, stepOf } from '../hooks/mods/destructive-scope'
import { parseShell } from '../hooks/mods/shell'
import type { Bench } from './bench'
import { bench, start } from './bench'
import { install, model, rootsOf } from './world'

const HOME = '/Users/tester'
const PAD = `${HOME}/Developer/scratchpad`
const SESSION_PAD = '/private/tmp/claude-501/-repo/0f3c/scratchpad'
const TEMP = '/private/var/folders/xy/T'
const MARKERS = '/cache/pending-summaries'

// The project is /repo, a git worktree. /victim and /victim-repo lie outside
// every root. /repo/escape is a link out to /victim. /tmp is a link to
// /private/tmp, which holds a leftover scratch folder of this account's, one
// of another account's, and the session tree.
const WORLD = model({
  dirs: [
    '/repo', '/repo/sub', '/repo/build', '/victim', '/victim-repo', '/vault', '/vault/insights', '/Users', HOME, `${HOME}/Developer`, PAD, `${PAD}/old`,
    '/private', '/private/tmp', '/private/tmp/claude-501', '/private/tmp/claude-501/-repo', '/private/tmp/claude-501/-repo/0f3c', SESSION_PAD,
    `${SESSION_PAD}/probe`, '/private/var', '/private/var/folders', '/private/var/folders/xy', TEMP, `${TEMP}/tmp.abc`, '/private/tmp/claude-scratch-left',
    '/private/tmp/claude-scratch-theirs', '/cache', MARKERS, '/db',
  ],
  files: ['/repo/file.txt', '/victim/keep.txt', `${MARKERS}/sid-1.json`, '/db/reset.sql', '/db/seed.sql'],
  links: { '/tmp': '/private/tmp', '/repo/escape': '/victim' },
  foreign: ['/private/tmp/claude-scratch-theirs'],
  repos: {
    '/repo': { branches: ['main', 'feature'], tracked: ['file.txt'], aliases: { co: 'checkout', lg: 'log --oneline', nuke: '!rm -rf build', hop: 'co' } },
    '/victim-repo': { branches: ['main'], tracked: ['file.txt'], aliases: { co: 'checkout' } },
    '/vault': { branches: ['main'], tracked: ['insights/a.md'] },
  },
  sql: { '/db/reset.sql': 'DROP TABLE users;', '/db/seed.sql': "INSERT INTO users VALUES ('drop table');" },
})
const ROOTS = rootsOf([PAD, SESSION_PAD, TEMP], '/private/tmp', MARKERS)

type Verdict = { decision: 'allow' | 'ask' | 'deny' | 'beneath'; reason: string }

// A session in /repo. Attended: a person answers permission prompts.
async function session($: Engine, on: Parameters<typeof bench>[0], isAttended = true): Promise<Bench> {
  const b = bench(on, { env: { HOME } })
  b.scripts['scratch-roots.sh'] = () => ''
  install(b, WORLD, { roots: ROOTS, vault: '/vault' })
  await $.session.start(start(isAttended))
  return b
}

// What the module makes of a Bash line: tool.call's refusal, or else
// tool.check's verdict. `beneath` is the engine's own, unchanged.
async function verdict($: Engine, b: Bench, command: string): Promise<Verdict> {
  const result = await $.tool.call({ tool: 'Bash', command } as never)
  if (result.deny !== undefined) return { decision: 'deny', reason: result.deny }
  b.decision = 'ask'
  const check = await $.tool.check({ tool: 'Bash', input: { command } })
  const isBeneath = check.decision === 'ask' && check.reason === undefined
  return { decision: isBeneath ? 'beneath' : check.decision, reason: check.reason ?? '' }
}

const decisions = async ($: Engine, b: Bench, lines: readonly string[]) => {
  const out: Record<string, string> = {}
  for (const line of lines) out[line] = (await verdict($, b, line)).decision
  return out
}
const all = (lines: readonly string[], decision: string) => Object.fromEntries(lines.map(line => [line, decision]))

describe('AC5: in-scope deletes, ordinary git and read-only SQL still run', () => {
  test('a delete inside the project or a scratch root runs without a prompt', async ($, on) => {
    const b = await session($, on)
    const lines = [
      'rm -rf /repo/build',
      'rm -rf build',
      'rm -f /repo/file.txt /repo/sub/x',
      'rmdir /repo/sub',
      `rm -rf ${PAD}/old`,
      `rm -rf ${SESSION_PAD}/probe`,
      `rm -rf ${TEMP}/tmp.abc`,
      'rm -rf /tmp/claude-scratch-left',
      `rm -f ${MARKERS}/sid-1.json`,
      'sudo rm -rf /repo/build',
      'cd /repo/sub && rm -rf x',
      'git reset --hard',
      'git clean -fd',
      'git stash drop',
      'git -C /repo checkout -- file.txt',
      'git co -- file.txt',
      'git checkout -- file.txt 2>/dev/null',
      'rm -rf /repo/escape',
    ]
    expect(await decisions($, b, lines)).toEqual(all(lines, 'allow'))
  })

  test('a cd into the project runs a relative delete there, from a session outside it', async ($, on) => {
    const b = await session($, on)
    b.cwd = '/victim'
    expect((await verdict($, b, 'cd /repo && rm -rf build')).decision).toBe('allow')
    // The same cd in a subshell moves nothing, so the delete lands in /victim.
    expect((await verdict($, b, '(cd /repo); rm -rf build')).decision).toBe('ask')
    // A cd into a folder that does not exist fails, and the shell stays.
    expect((await verdict($, b, 'cd /repo/none; rm -rf build')).decision).toBe('ask')
  })

  test('a cd that CDPATH can redirect, or that holds .., leaves a relative delete nowhere known', async ($, on) => {
    const b = await session($, on)
    // bash deletes /etc/ssl/certs here, not /repo/ssl/certs.
    const unknown = ['CDPATH=/etc cd ssl; rm -rf certs', 'cd sub; rm -rf x', 'cd ./escape/..; rm -rf keep.txt', 'cd /repo/escape/..; rm -rf keep.txt']
    expect(await decisions($, b, unknown)).toEqual(all(unknown, 'deny'))
    // A ./ target cannot go through CDPATH, so the shell lands where it reads.
    expect((await verdict($, b, 'cd ./sub; rm -rf x')).decision).toBe('allow')
  })

  test('ordinary git, read-only SQL and text that only quotes a verb are left to the engine', async ($, on) => {
    const b = await session($, on)
    const lines = [
      'git status',
      'git log --oneline -5',
      'git checkout feature',
      'git checkout -b fresh',
      'git log --grep="rm -rf the old build"',
      'git lg',
      'git -C /vault log --oneline',
      'git -C /vault status',
      'grep -rn "rm -rf" .',
      "cat <<'EOF' > notes.txt\ngit stash drop\nEOF",
      "echo 'probe text >out'",
      'psql -d app -c "SELECT 1"',
      "psql -c \"SELECT * FROM logs WHERE msg = 'drop table'\"",
      'psql -f /db/seed.sql',
      'grep -rn "DROP TABLE" app/',
      'php artisan migrate:fresh --env=testing',
      'docker compose down',
      'rm -rf build && mkdir build',
    ]
    expect(await decisions($, b, lines)).toEqual(all(lines, 'beneath'))
  })

  test('an in-scope delete keeps a prompt that a settings rule or a hook asked for, and never overrides a deny', async ($, on) => {
    const b = await session($, on)
    // The bench's tool.check answers like a settings rule: an ask under a rule.
    b.decision = 'deny'
    expect((await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf /repo/build' } })).decision).toBe('deny')
    b.decision = 'allow'
    expect((await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf /repo/build' } })).decision).toBe('allow')
  })
})

describe('AC3: an out-of-root target asks, and an unreadable one is refused', () => {
  test('a readable target outside every root is put to Mike, naming it and why', async ($, on) => {
    const b = await session($, on)
    const rm = await verdict($, b, 'rm -rf /victim/keep.txt')
    expect(rm.decision).toBe('ask')
    expect(rm.reason).toContain('/victim/keep.txt')
    expect(rm.reason).toContain('outside this project and every scratch root')
    expect(rm.reason).toContain(PAD)
    const git = await verdict($, b, 'git -C /victim-repo reset --hard')
    expect(git.decision).toBe('ask')
    expect(git.reason).toContain('git reset --hard')
    expect(git.reason).toContain('/victim-repo')
    const lines = [
      'rm -rf /victim',
      'rm -rf ../victim/keep.txt',
      'rm -rf /repo/escape/keep.txt',
      'rm -rf /repo/escape/',
      'rm -rf /tmp/claude-scratch-theirs',
      'rm -rf /tmp/claude-501',
      'rmdir /victim',
      'git -C /victim-repo clean -fd',
      'git -C /victim-repo stash clear',
      'git -C /victim-repo restore file.txt',
      'git -C /victim-repo switch -f main',
      'git -C /victim-repo rm -f file.txt',
      `rm -rf ~/Developer/scratchpad/old`,
      'timeout 5 git status && rm -rf /victim/keep.txt',
    ]
    expect(await decisions($, b, lines)).toEqual(all(lines, 'ask'))
  })

  test('where nobody can answer a prompt, an out-of-root target is refused instead', async ($, on) => {
    const b = await session($, on, false)
    const rm = await verdict($, b, 'rm -rf /victim/keep.txt')
    expect(rm.decision).toBe('deny')
    expect(rm.reason).toContain('/victim/keep.txt')
    expect(rm.reason).toContain(NO_ONE_TO_ASK)
    // An in-scope delete still runs there.
    expect((await verdict($, b, 'rm -rf /repo/build')).decision).toBe('allow')
  })

  test('a target nobody can read is refused, with a reason', async ($, on) => {
    const b = await session($, on)
    const lines = [
      'rm -rf $X',
      'rm -rf "$HOME/x"',
      'rm -rf /repo/*',
      'rm -rf /repo/{a,b}',
      'rm -rf ~other/x',
      'rm -rf $(pwd)/x',
      'for f in *; do rm -rf "$f"; done',
      'find . -name x -delete',
      'find . -exec rm -rf {} \\;',
      'ls | xargs rm -rf',
      'parallel rm ::: a b',
      'bash -c "rm -rf /repo/build"',
      "bash <<'EOF'\nrm -rf /repo/build\nEOF",
      'echo $(rm -rf /repo/build)',
      'ssh box "rm -rf /var/x"',
      'cd "$D" && rm -rf build',
      'rm -rf /',
      'rm -rf /repo',
      `rm -rf ${PAD}`,
      'rm -rf /repo/sub/..',
      'GIT_DIR=/x git reset --hard',
      'git --work-tree=/x reset --hard',
      'git -C "$R" reset --hard',
      'git submodule foreach --recursive git checkout -- .',
      'git -c alias.x=\'!rm -rf /victim\' x',
      'git nuke',
      'git -C /nowhere reset --hard',
    ]
    const got = await decisions($, b, lines)
    expect(got).toEqual(all(lines, 'deny'))
    for (const line of lines) {
      const { reason } = await verdict($, b, line)
      expect([line, /guard \(workbench-core\)|Workbench guards/.test(reason)]).toEqual([line, true])
    }
  })
})

describe('AC4: runners, aliases, case and collapsed paths', () => {
  test('a git alias is judged by what it expands to, set on the line or in config', async ($, on) => {
    const b = await session($, on)
    expect(
      await decisions($, b, [
        "git -c alias.x='reset --hard' x",
        "git -C /victim-repo -c alias.x='reset --hard' x",
        'git -C /victim-repo co -- file.txt',
        'git hop -- file.txt',
        "git -c alias.x='log --oneline' x",
        'git -c alias.x= x reset --hard',
      ]),
    ).toEqual({
      "git -c alias.x='reset --hard' x": 'allow',
      "git -C /victim-repo -c alias.x='reset --hard' x": 'ask',
      'git -C /victim-repo co -- file.txt': 'ask',
      'git hop -- file.txt': 'allow',
      "git -c alias.x='log --oneline' x": 'beneath',
      'git -c alias.x= x reset --hard': 'beneath',
    })
  })

  test('a runner that hides a destructive command is refused, and one that hides none is not', async ($, on) => {
    const b = await session($, on)
    const refused = [
      'find /repo -exec rm {} +',
      'xargs -0 git checkout',
      'xargs grep rm',
      'timeout 5 rm -rf /repo/build',
      'watch rm -rf /repo/build',
      'find . -exec dropdb {} \\;',
      'ls | xargs dropdb',
      'parallel dropdb ::: a b',
      'find . -name x -exec psql -c "DROP TABLE t" \\;',
      'sh -c "dropdb app"',
      "ssh box 'php artisan db:wipe'",
      'docker compose exec db psql -c "TRUNCATE users"',
      'kubectl exec pod -- dropdb app',
      'find /vault -name a.md -execdir git rm {} \\;',
      'git -C /vault -c alias.x=rm x insights/a.md',
      'parallel git -C /vault rm ::: insights/a.md',
    ]
    expect(await decisions($, b, refused)).toEqual(all(refused, 'deny'))
    const ran = ['find . -name x -print', 'xargs grep pattern', 'timeout 5 git status', 'find . -exec grep -l x {} +', 'parallel echo ::: a b']
    expect(await decisions($, b, ran)).toEqual(all(ran, 'beneath'))
  })

  test('a path is matched as the disk reads it: without regard to case, with //, /./ and .. folded', async ($, on) => {
    const b = await session($, on)
    expect(
      await decisions($, b, [
        'rm -rf /REPO/BUILD',
        'rm -rf /Repo//sub/./x',
        `rm -rf /users/tester/developer/SCRATCHPAD/old`,
        'rm -rf /VICTIM/keep.txt',
        'rm -rf /repo/sub/../../victim/keep.txt',
        'rm -rf /repo//escape//keep.txt',
        'rm -rf /TMP/Claude-Scratch-Left',
        'rm -rf /repo/none/../build',
        'rm -rf /REPO',
      ]),
    ).toEqual({
      'rm -rf /REPO/BUILD': 'allow',
      'rm -rf /Repo//sub/./x': 'allow',
      'rm -rf /users/tester/developer/SCRATCHPAD/old': 'allow',
      'rm -rf /VICTIM/keep.txt': 'ask',
      'rm -rf /repo/sub/../../victim/keep.txt': 'ask',
      'rm -rf /repo//escape//keep.txt': 'ask',
      'rm -rf /TMP/Claude-Scratch-Left': 'allow',
      // Through a folder that does not exist: never vouched for.
      'rm -rf /repo/none/../build': 'ask',
      'rm -rf /REPO': 'deny',
    })
  })
})

describe('the database and vault-git guards', () => {
  test('database resets, drops and destructive SQL are refused, inline, in a heredoc and in a file', async ($, on) => {
    const b = await session($, on)
    const lines = [
      'php artisan db:wipe --database=pgsql --force',
      'cd /repo && php artisan migrate:fresh',
      'php artisan db:w --force',
      'sail artisan migrate:refresh',
      'dropdb app',
      'DROPDB app',
      'env -i dropdb app',
      'mysqladmin -u root DROP app',
      'docker compose down -v',
      'docker volume prune',
      'ddev delete',
      'psql -c "DROP DATABASE app"',
      'echo "TRUNCATE users" | psql app',
      'psql -d app <<SQL\nDELETE FROM users;\nSQL',
      'psql -d app <<SQL\nDROP \\\nTABLE users;\nSQL',
      'psql -f /db/reset.sql',
      'cd /db && psql -f reset.sql',
      'cat /db/reset.sql | psql',
      'psql -f "$F"',
    ]
    expect(await decisions($, b, lines)).toEqual(all(lines, 'deny'))
    expect(checkSql('DELETE FROM users WHERE id = 1')).toBeUndefined()
  })

  test('a git write in the vault is refused, and read-only git there runs', async ($, on) => {
    const b = await session($, on)
    const refused = ['git -C /vault rm insights/a.md', 'cd /vault && git add .', 'git --git-dir=/vault/.git commit -m x', 'git -C /VAULT stash', 'git -C /vault branch -D x']
    expect(await decisions($, b, refused)).toEqual(all(refused, 'deny'))
    b.cwd = '/vault'
    expect((await verdict($, b, 'git commit -m x')).decision).toBe('deny')
    expect((await verdict($, b, 'cd /repo && git add file.txt')).decision).toBe('beneath')
    const ran = ['git stash list', 'git tag -l', 'git branch', 'git diff', 'git log']
    expect(await decisions($, b, ran)).toEqual(all(ran, 'beneath'))
  })

  test('the same git writes aimed at a repository outside the vault run', async ($, on) => {
    // A commit or a push is left out: the commit approval rule judges those
    // in every repository (tests/commit-approval.test.ts).
    const b = await session($, on)
    const ran = ['git -C /repo add file.txt', 'cd /repo && git add .', 'git --git-dir=/repo/.git add file.txt', 'git -C /repo tag v1', 'git -C /repo branch topic']
    expect(await decisions($, b, ran)).toEqual(all(ran, 'beneath'))
    b.cwd = '/repo'
    const here = ['git add file.txt', 'git tag v1', 'git branch topic']
    expect(await decisions($, b, here)).toEqual(all(here, 'beneath'))
  })
})

describe('AC6: every refusal and every prompt says how to proceed', () => {
  test('each names its guard and gives an instruction in plain words', async ($, on) => {
    const b = await session($, on)
    const cases: [string, RegExp][] = [
      ['rm -rf $X', /Spell each target out as a literal absolute path/],
      ['rm -rf /repo', /Delete what is inside it instead/],
      ['git submodule foreach rm -rf x', /Spell the discard out as a command of its own/],
      ['rm -rf /victim/keep.txt', /Approve it only if the task calls for destroying this target/],
      ['dropdb app', /stop and ask Mike/],
      ['git -C /vault rm insights/a.md', /Use the memory MCP instead/],
    ]
    for (const [line, advice] of cases) {
      const { reason } = await verdict($, b, line)
      expect([line, advice.test(reason), /\(workbench-core\)/.test(reason)]).toEqual([line, true, true])
    }
  })
})

describe('the scope judge, read directly', () => {
  const ctx = { cwd: '/repo', home: HOME, roots: ['/repo'], tmp: '/private/tmp', markers: undefined }
  const judge = (line: string, facts: Record<string, string | null>) => stepOf(() => scopeVerdict(line, parseShell(line), ctx, getterOf(new Map(Object.entries(facts)))))

  test('a line with no destructive command, or one nobody can read, needs no fact', () => {
    expect(judge('git status && ls', {})).toEqual({ value: { kind: 'none' } })
    expect(judge('rm -rf $X', {})).toMatchObject({ value: { kind: 'deny' } })
    expect(judge('rm -rf /repo/build', {})).toEqual({ need: 'dir\t/repo' })
  })

  test('a line the reader cannot read whole that names a destructive verb is refused', () => {
    expect(judge('rm -rf "/repo/build', {})).toMatchObject({ value: { kind: 'deny' } })
    expect(judge('echo "unclosed', {})).toEqual({ value: { kind: 'none' } })
  })

  test('a command word that is a glob or an expansion is refused on a line that names a destructive verb', () => {
    // `*` runs the first file in the folder, which may be rm.
    expect(judge('* rmdir clean -n', {})).toMatchObject({ value: { kind: 'deny', reason: expect.stringContaining('the command name "*"') } })
    expect(judge('./b?n/x rm -rf build', {})).toMatchObject({ value: { kind: 'deny', reason: expect.stringContaining('the command name "./b?n/x"') } })
    // With no destructive verb on the line, the word is not the guard's concern.
    expect(judge('* --version', {})).toEqual({ value: { kind: 'none' } })
  })

  test('only a line with no subshell, pipe, background or || follows a cd exactly', () => {
    expect(['cd a && rm b', 'cd a; rm b'].map(isLinearLine)).toEqual([true, true])
    expect(['(cd a); rm b', 'cd a | rm b', 'cd a & rm b', 'cd a || rm b', 'cd `x`; rm b', 'rm $(cd a)'].map(isLinearLine)).toEqual([false, false, false, false, false, false])
    const [cd] = parseShell('cd ./sub').statements
    // The ./ target is joined as written, and the file system folds it.
    const get = getterOf(new Map([['dir\t/repo/./sub', '/repo/sub']]))
    expect(cwdsAfter(cd as never, ['/repo'], true, get, undefined)).toEqual(['/repo/sub'])
    expect(cwdsAfter(cd as never, ['/repo'], false, get, undefined)).toEqual(['/repo', '/repo/./sub'])
    // A bare name may go through CDPATH, and a .. may fold across a link.
    for (const line of ['cd sub', 'cd ./sub/..', 'cd /repo/sub/..']) {
      const [step] = parseShell(line).statements
      expect([line, cwdsAfter(step as never, ['/repo'], true, get, undefined)]).toEqual([line, ['/repo', undefined]])
    }
  })
})
