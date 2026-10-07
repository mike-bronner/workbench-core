// The shell reader (hooks/mods/shell.ts) and $.workbench.parseShell: the one
// reading of a Bash line that core's commit gate and workbench-dev-team's guard
// ports share. The noun is called from a second plugin, the way a dependent
// calls it. The reader is held to shell_parse.py on the differential corpus
// (tests/shell-cases.ts, from hooks/test-shell-parity.sh).

import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { WorkbenchShellStatement } from '../types'
import { commandsOf as commitCommandsOf } from '../hooks/mods/commit-approval'
import { commandsOf, parseShell, shellScriptOf } from '../hooks/mods/shell'
import { bench, caller, start } from './bench'
import { CAUGHT, LET_THROUGH, OVER_COUNTED } from './commit-corpus'
import { PARSER_CASES } from './shell-cases'

// The stand-in dependent reads the line after `shell:` through the noun, and
// writes the answer to /answers/shell. `shell#number` passes a number.
const DEPENDENT = caller((on: On) => {
  on('prompt.submit', async ($, e, next) => {
    if (e.text.startsWith('shell')) {
      const line = e.text === 'shell#number' ? (7 as never) : e.text.slice('shell:'.length)
      const answer = await $.workbench.parseShell(line).catch((error: unknown) => ({ rejected: String(error).replace(/^\w*Error: /, '') }))
      await $.fs.write('/answers/shell', JSON.stringify(answer))
    }
    return next(e)
  })
})

const ask = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

const statements = (line: string): readonly WorkbenchShellStatement[] => parseShell(line).statements
const only = (line: string): WorkbenchShellStatement => {
  const all = statements(line)
  expect(all).toHaveLength(1)
  return all[0] as WorkbenchShellStatement
}
const named = (line: string) => statements(line).map(s => ({ name: s.name, args: s.args }))
const real = (line: string) => statements(line).flatMap(s => s.redirects.filter(r => r.isReal))

describe('AC1: $.workbench.parseShell answers a dependent plugin', () => {
  test('it answers the reader\'s reading of the line', { plugins: [DEPENDENT] }, async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    const line = 'sudo -u mike git -C /repo status 2>/dev/null'
    await $.prompt.submit(ask(`shell:${line}`))
    const answer = JSON.parse(b.files.get('/answers/shell') ?? 'null')
    expect(answer).toEqual(JSON.parse(JSON.stringify(parseShell(line))))
    expect(answer.statements[0]).toMatchObject({ name: 'git', args: ['-C', '/repo', 'status'], wrappers: ['sudo'], subcommandAt: 2 })
    expect(answer.unknowns).toEqual([])
  })

  test('it rejects a line that is not a string, so the caller picks its side', { plugins: [DEPENDENT] }, async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    await $.prompt.submit(ask('shell#number'))
    expect(JSON.parse(b.files.get('/answers/shell') ?? 'null')).toEqual({ rejected: 'workbench: parseShell reads a string' })
  })

  test('it answers before the session starts, as it reads nothing but the line', { plugins: [DEPENDENT] }, async ($, on) => {
    const b = bench(on)
    await $.prompt.submit(ask('shell:git push'))
    expect(JSON.parse(b.files.get('/answers/shell') ?? 'null').statements[0].name).toBe('git')
  })
})

describe('AC2: each statement\'s name and arguments, with its prefix stripped', () => {
  const STRIPPED: readonly (readonly [string, string, string[], string[], string[]])[] = [
    // line, name, args, wrappers, assignments
    ['A=1 B+=2 git push', 'git', ['push'], [], ['A=1', 'B+=2']],
    ['sudo -u mike git push', 'git', ['push'], ['sudo'], []],
    ['sudo -nu root rm x', 'rm', ['x'], ['sudo'], []],
    ['sudo --user=mike rm x', 'rm', ['x'], ['sudo'], []],
    ['doas -u mike rm x', 'rm', ['x'], ['doas'], []],
    ['env -i PATH=/bin dropdb app', 'dropdb', ['app'], ['env'], ['PATH=/bin']],
    ['env -u HOME -C /x rm y', 'rm', ['y'], ['env'], []],
    ['env - rm y', 'rm', ['y'], ['env'], []],
    ['nice -n 5 rm x', 'rm', ['x'], ['nice'], []],
    ['nice -n5 rm x', 'rm', ['x'], ['nice'], []],
    ['nice -5 rm x', 'rm', ['x'], ['nice'], []],
    ['ionice -c 3 rm x', 'rm', ['x'], ['ionice'], []],
    ['timeout -s KILL 30 git push', 'git', ['push'], ['timeout'], []],
    ['gtimeout --kill-after 5 30 rm x', 'rm', ['x'], ['gtimeout'], []],
    ['xargs -I{} rm {}', 'rm', ['{}'], ['xargs'], []],
    ['xargs -0 -n 1 rm', 'rm', [], ['xargs'], []],
    ['stdbuf -oL git push', 'git', ['push'], ['stdbuf'], []],
    ['caffeinate -i rm x', 'rm', ['x'], ['caffeinate'], []],
    ['time -p rm x', 'rm', ['x'], ['time'], []],
    ['exec -a name rm x', 'rm', ['x'], ['exec'], []],
    ['flock -w 5 /tmp/lock rm x', 'rm', ['x'], ['flock'], []],
    ['nohup rm x', 'rm', ['x'], ['nohup'], []],
    ['command rm x', 'rm', ['x'], ['command'], []],
    ['builtin cd /x', 'cd', ['/x'], ['builtin'], []],
    ['chronic unbuffer rm x', 'rm', ['x'], ['chronic', 'unbuffer'], []],
    ['sudo -- rm x', 'rm', ['x'], ['sudo'], []],
    ['GIT_DIR=x env A=1 /usr/bin/git push', 'git', ['push'], ['env'], ['GIT_DIR=x', 'A=1']],
    ['! rm x', 'rm', ['x'], [], []],
    ['/usr/local/bin/GIT push', 'git', ['push'], [], []],
    ['./git push', 'git', ['push'], [], []],
    ['SUDO rm x', 'rm', ['x'], ['sudo'], []],
  ]
  for (const [line, name, args, wrappers, assignments] of STRIPPED) {
    test(`stripped: ${JSON.stringify(line)}`, () => {
      expect(only(line)).toMatchObject({ name, args, wrappers, assignments, isPlaced: true })
    })
  }

  test('a name that is also an object property is no wrapper and no git', () => {
    for (const name of ['constructor', '__proto__', 'tostring']) {
      expect(only(`${name} -C x rm y`)).toMatchObject({ name, nameAt: 0, wrappers: [], subcommandAt: -1, isPlaced: true })
    }
  })

  test('nameAt points at the name in the words, and every word stays in words', () => {
    expect(only('sudo -u mike env A=1 git push')).toMatchObject({ words: ['sudo', '-u', 'mike', 'env', 'A=1', 'git', 'push'], nameAt: 5 })
  })

  test('a wrapper that runs no command, or has none after it, is the command', () => {
    expect(only('command -v git')).toMatchObject({ name: 'command', args: ['-v', 'git'], wrappers: [] })
    expect(only('sudo -l')).toMatchObject({ name: 'sudo', args: ['-l'] })
    expect(only('sudo --list')).toMatchObject({ name: 'sudo', args: ['--list'], isPlaced: true })
    expect(only('nohup')).toMatchObject({ name: 'nohup', nameAt: 0 })
    expect(only('env -i')).toMatchObject({ name: 'env', args: ['-i'] })
  })

  test('keywords stand before the name, and a statement of keywords alone is left out', () => {
    expect(named('if git push; then rm x; else rm y; fi')).toEqual([
      { name: 'git', args: ['push'] },
      { name: 'rm', args: ['x'] },
      { name: 'rm', args: ['y'] },
    ])
    expect(named('while true; do rm x; done')).toEqual([
      { name: 'true', args: [] },
      { name: 'rm', args: ['x'] },
    ])
    expect(named('{ rm x; }')).toEqual([{ name: 'rm', args: ['x'] }])
  })

  test('a statement with no name keeps its assignments and redirects', () => {
    expect(only('x=1')).toMatchObject({ nameAt: -1, name: '', args: [], assignments: ['x=1'] })
    expect(only('> file')).toMatchObject({ nameAt: -1, name: '', redirects: [{ op: '>', fd: '', target: 'file', isReal: true }] })
    expect(statements('{ rm x; } 2>/dev/null')[1]).toMatchObject({ name: '', redirects: [{ op: '>', fd: '2', target: '/dev/null', isReal: true }] })
  })

  test('a wrapper option the reader cannot place leaves the statement unplaced', () => {
    for (const line of ['nice --adj 5 rm x', 'env -S "rm x"', 'sudo -h host rm x', 'xargs -i rm', 'flock -c "rm x" /tmp/l', 'watch rm x', "sudo $'-\\x75' mike rm x"]) {
      const reading = parseShell(line)
      expect(reading.statements[0]?.isPlaced).toBe(false)
      expect(reading.unknowns).toContain('wrapper')
    }
    expect(only("sudo $'-\\x75' mike rm x")).toMatchObject({ name: 'rm', escaped: [1] })
    // Any escape in a wrapper option leaves it unplaced, even where the escape
    // sits in the option's value.
    expect(only("sudo -u$'\\x75' rm x")).toMatchObject({ name: 'rm', isPlaced: false })
    expect(only('watch -x rm x')).toMatchObject({ name: 'rm', isPlaced: true })
    expect(parseShell('watch -x rm x').unknowns).toEqual([])
  })

  test('a statement is certain until a && or ||, or a branch keyword, comes before it', () => {
    const certain = (line: string) => statements(line).map(s => s.isCertain)
    expect(certain('a; b && c || d; e')).toEqual([true, true, false, false, false])
    expect(certain('a | b; c &')).toEqual([true, true, true])
    expect(certain('echo "a && b"; c')).toEqual([true, true])
    expect(certain("echo 'a || b'; c")).toEqual([true, true])
    expect(certain('if a; then b; else c; fi; d')).toEqual([true, false, false, false])
    expect(certain('while a; do b; done')).toEqual([true, false])
    expect(certain('case x in y) a;; esac')).toEqual([false, false])
    expect(certain('for x in y; do a; done')).toEqual([false, false])
    expect(certain('f() { a; }; b')).toEqual([false, false, false])
    expect(certain('a &&\nb')).toEqual([true, false])
  })

  test('a nested statement takes the certainty of the one that holds it', () => {
    expect(statements('bash -c "a && b"').map(s => [s.name, s.isCertain])).toEqual([['bash', true], ['a', true], ['b', false]])
    expect(statements('x && bash -c a').map(s => [s.name, s.isCertain])).toEqual([['x', true], ['bash', false], ['a', false]])
    expect(statements('x || echo $(a)').map(s => [s.name, s.isCertain])).toEqual([['x', true], ['a', false], ['echo', false]])
  })

  test('each real redirect carries its operator, file descriptor and target', () => {
    expect(only('cmd >out 2>&1 <in >>log &>all 3<>rw >|clobber 0<&3 <<<"word"').redirects).toEqual([
      { op: '>', fd: '', target: 'out', isReal: true },
      { op: '>&', fd: '2', target: '1', isReal: true },
      { op: '<', fd: '', target: 'in', isReal: true },
      { op: '>>', fd: '', target: 'log', isReal: true },
      { op: '&>', fd: '', target: 'all', isReal: true },
      { op: '<>', fd: '3', target: 'rw', isReal: true },
      { op: '>|', fd: '', target: 'clobber', isReal: true },
      { op: '<&', fd: '0', target: '3', isReal: true },
      { op: '<<<', fd: '', target: 'word', isReal: true },
    ])
    expect(only('2>/dev/null git push > "a b"')).toMatchObject({ name: 'git', args: ['push'], redirects: [{ target: '/dev/null' }, { target: 'a b' }] })
  })

  // workbench-dev-team's commit guard reads these, so no spelling may be
  // joined, split, normalized or dropped.
  test('push flags and refspecs reach args exactly as git sees them', () => {
    const PUSHES: readonly (readonly string[])[] = [
      ['push', '--force'],
      ['push', '-f', 'origin', 'main'],
      ['push', '--force-with-lease', 'origin'],
      ['push', '--force-with-lease=main:abc', 'origin'],
      ['push', '--mirror'],
      ['push', '--delete', 'origin', 'old'],
      ['push', '-d', 'origin', 'old'],
      ['push', '--prune', 'origin'],
      ['push', '-fu', 'origin', 'main'],
      ['push', '-uf', 'origin', 'main'],
      ['push', 'origin', '+main'],
      ['push', 'origin', ':old'],
      ['push', 'origin', '+refs/heads/a:refs/heads/b'],
      ['push', 'origin', 'main:refs/heads/main', '--no-verify'],
    ]
    for (const args of PUSHES) {
      expect(only(`git ${args.join(' ')}`)).toMatchObject({ name: 'git', args, subcommandAt: 0 })
      expect(only(`sudo -u mike /usr/bin/git -C /repo ${args.join(' ')}`)).toMatchObject({ name: 'git', args: ['-C', '/repo', ...args], subcommandAt: 2 })
    }
  })

  test('gh in any spelling is the command gh, with its subcommand placed', () => {
    const GH: readonly (readonly [string, string[], number])[] = [
      ['gh pr merge 5', ['pr', 'merge', '5'], 0],
      ['gh -R o/r pr merge 5 --squash', ['-R', 'o/r', 'pr', 'merge', '5', '--squash'], 2],
      ['gh --repo o/r pr merge', ['--repo', 'o/r', 'pr', 'merge'], 2],
      ['gh --repo=o/r pr merge', ['--repo=o/r', 'pr', 'merge'], 1],
      ['/opt/homebrew/bin/GH pr merge', ['pr', 'merge'], 0],
      ['"gh" pr merge', ['pr', 'merge'], 0],
      ['g\\h pr merge', ['pr', 'merge'], 0],
      ['env GH_TOKEN=x gh api repos/o/r/pulls/5/merge -X PUT', ['api', 'repos/o/r/pulls/5/merge', '-X', 'PUT'], 0],
      ['sudo gh api -X PUT /repos/o/r/pulls/5/merge', ['api', '-X', 'PUT', '/repos/o/r/pulls/5/merge'], 0],
    ]
    for (const [line, args, subcommandAt] of GH) expect(only(line)).toMatchObject({ name: 'gh', args, subcommandAt })
  })

  test('git\'s global options stay in args, and subcommandAt steps past them and their values', () => {
    const git = only('git -C /x -c a.b=c --git-dir=.git --work-tree w --namespace n --no-pager -p push -f')
    expect(git.args).toEqual(['-C', '/x', '-c', 'a.b=c', '--git-dir=.git', '--work-tree', 'w', '--namespace', 'n', '--no-pager', '-p', 'push', '-f'])
    expect(git.args[git.subcommandAt]).toBe('push')
    expect(only('git --exec-path /x --super-prefix p --config-env a=B commit').subcommandAt).toBe(6)
    expect(only('git').subcommandAt).toBe(-1)
    expect(only('git --version').subcommandAt).toBe(-1)
    expect(only('ls -la x').subcommandAt).toBe(-1)
  })

  test('a shell -c script, eval, a heredoc fed to a shell, and a substitution give statements of their own', () => {
    const shape = (line: string) => statements(line).map(s => [s.name, s.args, s.source, s.depth])
    expect(shape('bash -c "git push"')).toEqual([
      ['bash', ['-c', 'git push'], 'line', 0],
      ['git', ['push'], 'script', 1],
    ])
    expect(shape("sh -lc 'sudo -u x env A=1 /usr/bin/git push'")).toEqual([
      ['sh', ['-lc', 'sudo -u x env A=1 /usr/bin/git push'], 'line', 0],
      ['git', ['push'], 'script', 1],
    ])
    expect(shape('eval git push')).toEqual([
      ['eval', ['git', 'push'], 'line', 0],
      ['git', ['push'], 'script', 1],
    ])
    expect(shape('sudo bash -c "eval \\"gh pr merge\\""')).toEqual([
      ['bash', ['-c', 'eval "gh pr merge"'], 'line', 0],
      ['eval', ['gh pr merge'], 'script', 1],
      ['gh', ['pr', 'merge'], 'script', 2],
    ])
    expect(shape('bash <<EOF\nrm -rf /x\nEOF\nls')).toEqual([
      ['bash', [], 'line', 0],
      ['rm', ['-rf', '/x'], 'heredoc', 1],
      ['ls', [], 'line', 0],
    ])
    expect(shape('echo $(git push) `rm x` "$(ls)"; cat <(ls)')).toEqual([
      ['git', ['push'], 'substitution', 1],
      ['rm', ['x'], 'substitution', 1],
      ['ls', [], 'substitution', 1],
      ['echo', ['$_', '$_', '$_'], 'line', 0],
      ['ls', [], 'substitution', 1],
      ['cat', ['$_'], 'line', 0],
    ])
    expect(shape('eval "$(cat <<EOF\ngit push\nEOF\n)"').filter(([name]) => name === 'git')).toEqual([['git', ['push'], 'heredoc', 2]])
    // A shell with no -c runs a file, which the line does not show.
    expect(shape('bash script.sh')).toEqual([['bash', ['script.sh'], 'line', 0]])
  })
})

// workbench-dev-team ports its commit guard onto parseShell, and keeps the
// rules. This stand-in rule reads only the parse's facts: a git statement
// whose subcommand is commit or push, an escaped name, an escaped word among
// git's options or subcommand, or a -c alias naming commit or push.
const runsCommitOrPush = (line: string): boolean =>
  statements(line).some(s => {
    if (s.escaped.includes(s.nameAt)) return true
    if (s.name !== 'git') return false
    const last = s.subcommandAt === -1 ? s.args.length - 1 : s.subcommandAt
    if (s.escaped.some(i => i > s.nameAt && i - s.nameAt - 1 <= last)) return true
    if (/^(commit|push)$/i.test(s.args[s.subcommandAt] ?? '')) return true
    return s.args.some((arg, i) => s.args[i - 1] === '-c' && /^alias\.[^=]*=.*\b(commit|push)\b/is.test(arg))
  })

describe('AC2, AC3: the facts carry the commit corpus', () => {
  // OVER_COUNTED lines run nothing in bash, and the gate counts them anyway.
  for (const [line] of [...CAUGHT, ...OVER_COUNTED]) {
    test(`recognisable: ${JSON.stringify(line)}`, () => {
      expect(runsCommitOrPush(line)).toBe(true)
    })
  }
  for (const line of LET_THROUGH) {
    test(`not a commit: ${JSON.stringify(line)}`, () => {
      expect(runsCommitOrPush(line)).toBe(false)
    })
  }
})

describe('AC3: the escape facts and the heredoc facts', () => {
  test('a word with a $\'…\' escape is marked, wherever it stands', () => {
    expect(only("$'\\x67it' push")).toMatchObject({ name: 'git', escaped: [0] })
    expect(only("git $'\\x70ush'")).toMatchObject({ args: ['push'], escaped: [1] })
    expect(only("env $'\\x67it' push")).toMatchObject({ name: 'git', nameAt: 1, escaped: [1] })
    expect(only("echo $'a\\tb' $'it\\'s'")).toMatchObject({ args: ['a\tb', "it's"], escaped: [1, 2] })
    expect(only("echo $'plain' 'q' \"d\"").escaped).toEqual([])
  })

  test('a heredoc keeps its delimiter, its body, and how bash reads it', () => {
    expect(only("cat <<'EOF' > m\nit's\nEOF").heredocs).toEqual([
      { delimiter: 'EOF', body: "it's", isQuoted: true, stripsTabs: false, feedsShell: false, isTerminated: true },
    ])
    expect(only('cat <<-EOF\n\tx\n\tEOF').heredocs).toEqual([
      { delimiter: 'EOF', body: '\tx', isQuoted: false, stripsTabs: true, feedsShell: false, isTerminated: true },
    ])
    expect(only("cat <<E'OF'\nx\nEOF").heredocs[0]).toMatchObject({ delimiter: 'EOF', isQuoted: true })
    expect(statements('bash <<EOF\nrm -rf /x\nEOF')[0]?.heredocs[0]).toMatchObject({ feedsShell: true, body: 'rm -rf /x' })
    expect(statements('eval "$(cat <<EOF\ngit push\nEOF\n)"')[0]?.heredocs[0]).toMatchObject({ feedsShell: true })
  })

  test('the operator of a heredoc is a redirect whose target is the delimiter', () => {
    expect(only('cat <<EOF\nx\nEOF').redirects).toEqual([{ op: '<<', fd: '', target: 'EOF', isReal: true }])
    expect(only('cat <<-EOF\n\tx\n\tEOF').redirects).toEqual([{ op: '<<-', fd: '', target: 'EOF', isReal: true }])
  })

  test('a body is text: its lines are no statements unless a shell reads it', () => {
    expect(named('cat <<EOF\nrm -rf /\nEOF')).toEqual([{ name: 'cat', args: [] }])
    expect(named("cat <<'EOF'\n$(rm x)\nEOF")).toEqual([{ name: 'cat', args: [] }])
    // An unquoted delimiter expands the body, so its substitutions run.
    expect(statements('cat <<EOF\n$(rm x)\nEOF').map(s => [s.name, s.source])).toEqual([
      ['cat', 'line'],
      ['rm', 'heredoc'],
    ])
  })

  test('two heredocs on one line take their bodies in order, and the line after them is read', () => {
    const all = statements('cat <<A <<B\na\nA\nb\nB\nrm x')
    expect(all[0]?.heredocs.map(h => [h.delimiter, h.body])).toEqual([
      ['A', 'a'],
      ['B', 'b'],
    ])
    expect(all[1]).toMatchObject({ name: 'rm', args: ['x'] })
  })
})

describe('AC4: a > that bash reads as text is never a real redirect', () => {
  test('control: a real > is real', () => {
    expect(real('echo a > b')).toEqual([{ op: '>', fd: '', target: 'b', isReal: true }])
  })

  test('inside a quoted string', () => {
    for (const line of ['echo "a > b"', "echo 'a > b'", 'echo "x 2>&1"', "echo $'a > b'", 'grep -E "git (add|x) > y" f']) {
      expect(real(line)).toEqual([])
      expect(only(line).redirects.some(r => !r.isReal && r.op === '>')).toBe(true)
    }
  })

  test('inside an awk or sed program', () => {
    expect(real("awk '$1 > 2 {print}' f")).toEqual([])
    expect(real("awk 'NR>1 && $2 >= 3' f")).toEqual([])
    expect(real("awk '{ print $0 > \"/dev/stderr\" }' f")).toEqual([])
    expect(real("awk '{print}' f 2>&1 | sort")).toEqual([{ op: '>&', fd: '2', target: '1', isReal: true }])
    expect(real("sed 's/=>/->/' f")).toEqual([])
    expect(real("sed -e 's/a/b/' -e '/x/ { s/>/</ }' f")).toEqual([])
  })

  test('inside a heredoc body', () => {
    const line = 'cat <<EOF\na > b\nc 2>&1\n>- x\nEOF'
    expect(real(line).map(r => r.op)).toEqual(['<<'])
    expect(only(line).redirects.filter(r => !r.isReal).length).toBe(3)
    expect(real("cat <<'EOF' | tee m\n>out\nEOF").map(r => r.op)).toEqual(['<<'])
  })

  test('inside a comment, which is not read at all', () => {
    expect(only('ls # > out 2>&1').redirects).toEqual([])
    expect(real('# >out\nls')).toEqual([])
  })

  test('after a backslash', () => {
    expect(real('echo a\\>b')).toEqual([])
    expect(only('echo a\\>b')).toMatchObject({ args: ['a>b'], redirects: [{ op: '>', fd: '', target: '', isReal: false }] })
  })
})

// The cases where the TS reader and shell_parse.py differ on the differential
// corpus, keyed by command. Each gives the TS reading, and why it is the safer.
const UNTERMINATED =
  'Bash reads every line after an unterminated heredoc as its body and runs none of them. ' +
  'The TS reader reads it so, and sets the heredoc unknown, so a fail-closed caller refuses the whole line. ' +
  'shell_parse.py reads the lines as commands instead.'
const ENV_I =
  "shell_parse.py's strip_noop() leaves env's -i in the name slot (its known gap). The TS reader reads env's options, so the name is the command env runs."
const DIFFERENCES: Readonly<Record<string, { statements: { name: string; args: string[] }[]; bodies: string[]; unknowns: string[]; reason: string }>> = {
  'cat <<EOF\ndropdb app': { statements: [{ name: 'cat', args: [] }], bodies: ['dropdb app'], unknowns: ['heredoc'], reason: UNTERMINATED },
  'cat <<EOF\ncreatedb app': { statements: [{ name: 'cat', args: [] }], bodies: ['createdb app'], unknowns: ['heredoc'], reason: UNTERMINATED },
  'cat <<EOF\nrm -rf /sandbox/outside/keep.txt': {
    statements: [{ name: 'cat', args: [] }],
    bodies: ['rm -rf /sandbox/outside/keep.txt'],
    unknowns: ['heredoc'],
    reason: UNTERMINATED,
  },
  'env -i dropdb app': { statements: [{ name: 'dropdb', args: ['app'] }], bodies: [], unknowns: [], reason: ENV_I },
  'env -i createdb app': { statements: [{ name: 'createdb', args: ['app'] }], bodies: [], unknowns: [], reason: ENV_I },
  'env -i rm -rf /sandbox/outside/keep.txt': { statements: [{ name: 'rm', args: ['-rf', '/sandbox/outside/keep.txt'] }], bodies: [], unknowns: [], reason: ENV_I },
}

const tsReading = (command: string) => {
  const reading = parseShell(command)
  return {
    statements: reading.statements.filter(s => s.source === 'line').map(s => ({ name: s.name, args: [...s.args] })),
    bodies: reading.statements.flatMap(s => s.heredocs.map(h => h.body)).sort(),
    unknowns: [...reading.unknowns],
  }
}

describe('AC5: the TS reader agrees with shell_parse.py on the differential corpus', () => {
  test('the fixture holds the corpus', () => {
    expect(PARSER_CASES.length).toBeGreaterThanOrEqual(25)
  })

  for (const c of PARSER_CASES) {
    const difference = DIFFERENCES[c.command]
    test(`${difference ? 'differs, safer' : 'agrees'}: ${c.label}`, () => {
      const ts = tsReading(c.command)
      if (difference === undefined) {
        expect({ statements: ts.statements, bodies: ts.bodies }).toEqual({ statements: c.statements, bodies: c.bodies })
        // A case shell_parse.py read exactly is read whole here too.
        if (c.exact) expect(ts.unknowns).toEqual([])
      } else {
        expect(ts).toEqual({ statements: difference.statements, bodies: difference.bodies, unknowns: difference.unknowns })
        expect({ statements: ts.statements, bodies: ts.bodies }).not.toEqual({ statements: c.statements, bodies: c.bodies })
      }
    })
  }

  test('every listed difference names a command of the corpus', () => {
    const commands = new Set(PARSER_CASES.map(c => c.command))
    for (const command of Object.keys(DIFFERENCES)) expect(commands.has(command)).toBe(true)
  })
})

// Holmes's first review of batch P. Each test pins one finding or one class.
describe('AC2, AC3, AC7: the shapes the first review found misread', () => {
  const shape = (line: string) => statements(line).map(s => [s.name, s.args])

  test('1: a redirect takes only a real operator, so | and & after >&- still separate', () => {
    expect(shape('echo x >&-|zap now')).toEqual([['echo', ['x']], ['zap', ['now']]])
    expect(statements('echo x >&-|zap now')[0]?.redirects).toEqual([{ op: '>&', fd: '', target: '-', isReal: true }])
    expect(statements('true >&-&&zap now').map(s => [s.name, s.isCertain])).toEqual([['true', true], ['zap', false]])
    expect(statements('true 2>&-&zap now').map(s => [s.name, s.isCertain])).toEqual([['true', true], ['zap', true]])
    expect(only('cmd >&- arg')).toMatchObject({ args: ['arg'] })
  })

  test('2: a shell reads its options before the -c script, -- and -o values included', () => {
    for (const line of ["bash -c -- 'zap now'", "bash -o pipefail -c 'zap now'", "bash --norc -c 'zap now'", "sh -c -e 'zap now'", "bash -eo pipefail -c 'zap now'"]) {
      expect(statements(line).at(-1)).toMatchObject({ name: 'zap', args: ['now'], source: 'script' })
    }
    expect(shape('bash script.sh -c x')).toEqual([['bash', ['script.sh', '-c', 'x']]])
    expect(shellScriptOf(['-c', '--', 'a'])).toEqual({ script: 'a', readsStdin: false })
    expect(shellScriptOf(['-c', '-', 'a'])).toEqual({ script: 'a', readsStdin: false })
    expect(shellScriptOf(['-c', '--', '--a'])).toEqual({ script: '--a', readsStdin: false })
    expect(shellScriptOf(['-c'])).toEqual({ script: '', readsStdin: false })
    expect(shellScriptOf(['script.sh'])).toEqual({ readsStdin: false })
    expect(shellScriptOf([])).toEqual({ readsStdin: true })
    expect(shellScriptOf(['-s', 'arg'])).toEqual({ readsStdin: true })
    expect(shellScriptOf(['--rcfile', 'f', '-o', 'x'])).toEqual({ readsStdin: true })
  })

  test('3: bash removes \\` \\\\ and \\$ inside backticks before it reads them', () => {
    expect(statements('echo `echo \\`zap now\\``').map(s => [s.name, s.args, s.depth])).toEqual([
      ['zap', ['now'], 2],
      ['echo', ['$_'], 1],
      ['echo', ['$_'], 0],
    ])
    expect(statements('echo `echo \\$x`')[0]).toMatchObject({ name: 'echo', args: ['$x'] })
  })

  test('4: `function f {` ends the definition, and its body is read, not certain', () => {
    expect(statements('function f { zap now; }; f').map(s => [s.name, s.args, s.isCertain])).toEqual([
      ['function', ['f'], false],
      ['zap', ['now'], false],
      ['f', [], false],
    ])
    expect(shape('function f () { zap; }')).toEqual([['function', ['f']], ['zap', []]])
  })

  test('5: coproc is a keyword before the command', () => {
    expect(only('coproc zap now')).toMatchObject({ name: 'zap', args: ['now'], nameAt: 1, isPlaced: true })
  })

  test('6: a case pattern ) does not close a $( )', () => {
    expect(shape('echo $(case x in x) zap now;; esac)')).toEqual([['case', ['x', 'in', 'x']], ['zap', ['now']], ['echo', ['$_']]])
    expect(shape('echo $(case x in (x) zap;; esac; other)').map(([name]) => name)).toEqual(['case', 'x', 'zap', 'other', 'echo'])
    // A word that only looks like case opens nothing.
    expect(shape('echo $(echo case x) zap)')).toEqual([['echo', ['case', 'x']], ['echo', ['$_', 'zap']]])
  })

  // A pattern is read as words, as the gate of 77bb2f3 read it, so the gate
  // never finds less: a pattern may show as a statement, which errs toward
  // finding a command, and its substitutions are read.
  test('round 2: a case pattern is read as words, and its substitutions run', () => {
    for (const pattern of ['$(zap now)', '`zap now`', '${y:-$(zap now)}', 'y|$(zap now)', '"$(zap now)"']) {
      const zap = statements(`case x in ${pattern}) ;; esac`).find(s => s.name === 'zap')
      expect(zap).toMatchObject({ args: ['now'], source: 'substitution' })
    }
    expect(shape('case $1 in rm) zap a;; esac')).toEqual([['case', ['$1', 'in', 'rm']], ['zap', ['a']]])
  })

  test('round 2: a ]] right before an operator ends the test', () => {
    expect(statements('[[ a ]]&&zap now').map(s => [s.name, s.args, s.isCertain])).toEqual([
      ['[[', ['a', ']]'], true],
      ['zap', ['now'], false],
    ])
    expect(shape('[[ a ]]||zap now')).toEqual([['[[', ['a', ']]']], ['zap', ['now']]])
    expect(shape('[[ a ]]|zap now')).toEqual([['[[', ['a', ']]']], ['zap', ['now']]])
    expect(real('[[ a ]]>out')).toEqual([{ op: '>', fd: '', target: 'out', isReal: true }])
    expect(real('[[ a ]]<in')).toEqual([{ op: '<', fd: '', target: 'in', isReal: true }])
    expect(real('[[ a > b ]] && [[ c < d ]]')).toEqual([])
    expect(real('[[ a ]]&&zap > out')).toEqual([{ op: '>', fd: '', target: 'out', isReal: true }])
    expect(real('[[ a ]]||zap > out')).toEqual([{ op: '>', fd: '', target: 'out', isReal: true }])
  })

  test('round 2: text that is not arithmetic is read as commands', () => {
    expect(shape('((zap now))')).toEqual([['zap', ['now']]])
    expect(shape('(( a ; zap now ))').map(([name]) => name)).toContain('zap')
    expect(shape('echo $((zap now))').map(([name]) => name)).toContain('zap')
    expect(shape('echo $[ a ; zap now ]').map(([name]) => name)).toContain('zap')
  })

  test('round 2: only a bare word in command position, with no redirect before it, opens a test', () => {
    for (const line of ['\\[[ a > b', '"[[" a > b', '[\\[ a > b', '> f [[ a > b', '<<< x [[ a > b', 'x=1 [[ a > b', 'echo [[ a > b']) {
      expect(real(line).some(r => r.target === 'b')).toBe(true)
    }
    for (const line of ['if [[ a > b ]]', '! [[ a > b ]]', 'time [[ a > b ]]', 'time -p [[ a > b ]]', 'while [[ a > b ]]; do x; done']) {
      expect(real(line)).toEqual([])
    }
  })

  test('round 2: a word that only looks like case or [[ hides no command', () => {
    for (const line of ['\\case x in|zap now', '"case" x in|zap now', 'c\\ase x in|zap now', '> f case x in\nzap now', '<<< x [[ a || zap now']) {
      expect(statements(line).at(-1)).toMatchObject({ name: 'zap', args: ['now'] })
    }
  })

  test('round 2: coproc NAME { … } runs its body', () => {
    expect(shape('coproc NAME { zap now; }')).toEqual([['zap', ['now']]])
    expect(shape('coproc { zap now; }')).toEqual([['zap', ['now']]])
    expect(only('coproc zap now')).toMatchObject({ name: 'zap', args: ['now'] })
  })

  test('round 2: a regex in a test holds no real redirect', () => {
    expect(real('[[ x =~ (a|b > c) ]]')).toEqual([])
  })

  test('round 2: a word after (( )) is a command, and a redirect stays with it', () => {
    expect(shape('(()) zap now')).toEqual([['((', []], ['zap', ['now']]])
    expect(only('(( x )) > out')).toMatchObject({ name: '((', redirects: [{ op: '>', target: 'out', isReal: true }] })
  })

  test('7: a wrapper that hands its command to a shell is not placed', () => {
    for (const line of ["flock /l -c 'zap now'", "flock /l --command 'zap now'", "sudo -s 'zap now'", 'sudo -i zap', 'sudo --shell zap', 'sudo --login zap']) {
      expect(statements(line)[0]?.isPlaced).toBe(false)
      expect(parseShell(line).unknowns).toEqual(['wrapper'])
    }
    expect(only('flock /l zap now')).toMatchObject({ name: 'zap', isPlaced: true })
  })

  test('8: arithmetic and [[ ]] hold no real redirect and no command', () => {
    for (const line of ['[[ a > b ]]', '[[ a<b ]]', '(( a > b ))', 'echo $(( a > b ))', 'echo "$(( a > b ))"', 'echo $[1>2]', 'echo "$[1>2]"', 'x=$(( 1 << 2 ))']) {
      expect(real(line)).toEqual([])
      expect(parseShell(line).unknowns).toEqual([])
    }
    expect(shape('echo $((1))')).toEqual([['echo', ['$_']]])
    expect(shape('echo "$[1>2]" "$((1>2))"')).toEqual([['echo', ['$_', '$_']]])
    expect(parseShell('echo $((1<<2))').unknowns).toEqual([])
    expect(parseShell('echo $[1<<2]\nzap').unknowns).toEqual([])
    expect(shape('echo $(( $(zap now) + 1 ))')).toEqual([['zap', ['now']], ['echo', ['$_']]])
    expect(statements('(( i > 0 )) && zap').map(s => [s.name, s.isCertain])).toEqual([['((', true], ['zap', false]])
    // A && in a test splits the statement, as the old gate read it, and the
    // test goes on, so its < > stay text.
    expect(statements('if [[ a < b && c > d ]]; then zap; fi').map(s => [s.name, s.args, s.isCertain])).toEqual([
      ['[[', ['a', '<', 'b'], true],
      ['c', ['>', 'd', ']]'], false],
      ['zap', [], false],
    ])
    expect(real('if [[ a < b && c > d ]]; then zap; fi')).toEqual([])
    // A subshell that starts with two parentheses is no arithmetic.
    expect(shape('((cd x) )')).toEqual([['cd', ['x']]])
    // A quoted [[ is a command name, so its > is a redirect.
    expect(real('"[[" a > b')).toEqual([{ op: '>', fd: '', target: 'b', isReal: true }])
    expect(real('[[ a ]] > out')).toEqual([{ op: '>', fd: '', target: 'out', isReal: true }])
  })

  test('9: a shell that reads its script from a pipe or a here-string is flagged, and a heredoc piped in is read', () => {
    const piped = parseShell('cat <<EOF | bash\nzap now\nEOF')
    expect(piped.unknowns).toEqual(['stdin'])
    expect(piped.statements[0]?.heredocs[0]).toMatchObject({ feedsShell: true, body: 'zap now' })
    expect(piped.statements.map(s => [s.name, s.source])).toEqual([['cat', 'line'], ['bash', 'line'], ['zap', 'heredoc']])
    expect(parseShell('echo zap | sh').unknowns).toEqual(['stdin'])
    expect(parseShell('echo zap |& sh -x').unknowns).toEqual(['stdin'])
    const string = parseShell("bash <<< 'zap now'")
    expect(string.unknowns).toEqual(['stdin'])
    expect(string.statements.at(-1)).toMatchObject({ name: 'zap', args: ['now'], source: 'script' })
    for (const line of ['bash script.sh | cat', 'echo x | bash -c y', 'bash <<EOF\nzap\nEOF', 'cat <<EOF | tee x\nzap\nEOF', 'echo | sed s/a/b/']) {
      expect(parseShell(line).unknowns).toEqual([])
    }
    expect(statements('cat <<EOF | tee x\nzap\nEOF')[0]?.heredocs[0]?.feedsShell).toBe(false)
  })

  test('a command name from a variable or a substitution is unknown', () => {
    for (const line of ['$X args', '${X} args', '"$(which zap)" now', '`which zap` now', '/usr/bin/$X now', 'sudo $X now']) {
      expect(parseShell(line).unknowns).toContain('expansion')
    }
    expect(parseShell('zap $X "$(y)"').unknowns).toEqual([])
  })

  test('a trap handler is a nested script that may never run', () => {
    expect(statements("trap 'zap now' EXIT").map(s => [s.name, s.args, s.source, s.isCertain])).toEqual([
      ['trap', ['zap now', 'EXIT'], 'line', true],
      ['zap', ['now'], 'script', false],
    ])
    expect(statements("trap -- 'zap' INT TERM").at(-1)).toMatchObject({ name: 'zap', source: 'script' })
    for (const line of ['trap - INT', 'trap -p', 'trap -l', 'trap INT']) expect(statements(line)).toHaveLength(1)
  })

  test('setsid is a wrapper', () => {
    expect(only('setsid -f zap now')).toMatchObject({ name: 'zap', wrappers: ['setsid'], isPlaced: true })
  })
})

describe('AC6: the commit gate reads through the shared parser', () => {
  test('commit-approval\'s commandsOf is the shell reader\'s', () => {
    expect(commitCommandsOf).toBe(commandsOf)
  })

  test('commandsOf is the words of parseShell\'s lexer, escape marks kept', () => {
    expect(commandsOf("$'\\x67it' push")).toEqual([['git\uE000', 'push']])
    expect(commandsOf('> out; x')).toEqual([['x']])
  })
})

describe('AC7: what the reader cannot read is named, never left out', () => {
  const UNREAD: readonly (readonly [string, string[]])[] = [
    ['echo "open', ['quote']],
    ["echo 'open", ['quote']],
    ["echo $'open", ['quote']],
    ['echo $(open', ['substitution']],
    ['echo `open', ['substitution']],
    ['cat <(open', ['substitution']],
    ['cat <<EOF\nno end', ['heredoc']],
    ['cat <<EOF', ['heredoc']],
    ["$'\\u0067it' push", ['escape']],
    ["$'\\cG'it push", ['escape']],
    ["$'\\x' push", ['escape']],
    ['nice --adj 5 rm x', ['wrapper']],
    ['eval eval eval eval eval git push', ['depth']],
    ['$cmd x', ['expansion']],
    ['echo x | bash', ['stdin']],
    ['echo $((1', ['substitution']],
    ['echo $[1', ['substitution']],
    ['(( 1', ['substitution']],
    ['echo "$(open', ['quote', 'substitution']],
    ['echo "`open', ['quote', 'substitution']],
  ]
  for (const [line, unknowns] of UNREAD) {
    test(`unread: ${JSON.stringify(line)}`, () => {
      expect(parseShell(line).unknowns).toEqual(unknowns)
    })
  }

  test('a whole line has no unknown', () => {
    for (const line of [
      'git status && echo "ok" > out',
      "cat <<'EOF'\nit's\nEOF",
      "echo $'\\x67\\n\\101'",
      'eval eval eval eval git push',
      'bash -c "sudo -u x rm y"',
    ]) {
      expect(parseShell(line).unknowns).toEqual([])
    }
  })

  test('scripts are read to the depth limit, and not past it', () => {
    expect(statements('eval eval eval eval git push').at(-1)).toMatchObject({ name: 'git', depth: 4 })
    expect(statements('eval eval eval eval eval git push').some(s => s.name === 'git')).toBe(false)
  })

  test('an unterminated heredoc is reported unterminated', () => {
    expect(only('cat <<EOF\nno end').heredocs[0]).toMatchObject({ isTerminated: false, body: 'no end' })
    expect(only('cat <<EOF').heredocs[0]).toMatchObject({ isTerminated: false, body: '' })
  })
})
