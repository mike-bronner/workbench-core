// TEST ORACLE PLUMBING. NOT PART OF THE PLUGIN.
//
// Records the facts the destructive-scope, destructive-database and vault-git
// ports ask about, answered by the real disk and the real git, for one
// PreToolUse payload. tests/oracle/record.sh runs it beside a frozen guard,
// under `hooks/test-guard-oracles.sh --write`, in the very environment the
// guard's suite gave the guard, so the facts are those of the sandbox the
// suite built. tests/guard-differential.test.ts replays them through the
// module (tests/world.ts), which needs no disk.
//
//   deno run -A --unstable-sloppy-imports tests/oracle/port-facts.js < payload
//
// It mirrors hooks/register.ts: answerFact for each fact, and scopeOf,
// databaseOf and vaultGitOf for the order the facts are asked in. A drift
// between the two shows in the replay as a fact nobody recorded, which the
// differential test refuses.
//
// It prints one JSON object: the port's verdict (deny, ask, allow or none, as
// in a session a person attends), and the world the replay needs: the facts,
// the roots line, the vault root, the folder the call ran in and the project.
// Written in JavaScript so tsc, which knows no Deno, leaves it alone.

import { parseShell } from '../../hooks/mods/shell.ts'
import { hiddenCommandRefusal } from '../../hooks/mods/guards.ts'
import { dirKey, getterOf, needsScope, scopeVerdict, stepOf } from '../../hooks/mods/destructive-scope.ts'
import { SQL_FILE_CAP, databaseRefusal } from '../../hooks/mods/destructive-database.ts'
import { needsVaultGit, vaultGitRefusal } from '../../hooks/mods/vault-git.ts'

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const FACTS = `${ROOT}/hooks/lib/scope-facts.sh`
// Where a payload names no folder, the call runs at the filesystem root.
export const NO_CWD = '/'
// Where no project is set, the session's root is a folder that is not there.
export const NO_PROJECT = '/nonexistent-project'

function run(argv) {
  try {
    const out = new Deno.Command(argv[0], { args: argv.slice(1), stdout: 'piped', stderr: 'null', stdin: 'null' }).outputSync()
    return { exitCode: out.code, stdout: new TextDecoder().decode(out.stdout) }
  } catch {
    return { exitCode: -1, stdout: '' }
  }
}

// answerFact in hooks/register.ts.
function answer(key) {
  const [kind = '', a = '', b = '', c = ''] = key.split('\t')
  if (kind === 'dir') {
    const path = run(['bash', FACTS, 'dir', a]).stdout.replace(/\n$/, '')
    return path.startsWith('/') ? path : null
  }
  if (kind === 'entry') return run(['bash', FACTS, 'entry', a]).stdout.trim() || null
  if (kind === 'name') {
    const name = run(['bash', FACTS, 'name', a, b]).stdout.replace(/\n$/, '')
    return name === '' || name.includes('\n') ? null : name
  }
  if (kind === 'file') {
    try {
      if (!Deno.statSync(a).isFile) return null
    } catch {
      return null
    }
    const read = run(['head', '-c', String(SQL_FILE_CAP), '--', a])
    return read.exitCode === 0 ? read.stdout : null
  }
  if (kind !== 'git') return null
  const git = argv => run(['git', ...argv])
  if (a === 'builtins') {
    const out = git(['--list-cmds=builtins'])
    const names = out.stdout.split(/\s+/).filter(Boolean)
    return out.exitCode === 0 && names.length > 0 ? names.join(' ') : null
  }
  if (a === 'top') {
    const out = git(['-C', b, 'rev-parse', '--show-toplevel'])
    return out.exitCode === 0 ? out.stdout.trim() : ''
  }
  if (a === 'tracked') {
    const { exitCode } = git(['-C', b, 'ls-files', '--error-unmatch', '--', c])
    return exitCode === 0 ? 'yes' : exitCode === 1 ? 'no' : null
  }
  if (a === 'commit') return git(['-C', b, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${c}^{commit}`]).exitCode === 0 ? 'yes' : 'no'
  if (a === 'remotes') {
    const out = git(['-C', b, 'for-each-ref', '--format=%(refname)', `refs/remotes/*/${c}`])
    return out.exitCode === 0 ? String(out.stdout.split(/\s+/).filter(Boolean).length) : null
  }
  if (a === 'alias') {
    const out = git(['-C', b, 'config', '--get', `alias.${c}`])
    return out.exitCode === 1 ? 'none' : out.exitCode === 0 ? `=${out.stdout.replace(/\n$/, '')}` : null
  }
  return null
}

const facts = {}
const ask = key => {
  if (!Object.hasOwn(facts, key)) facts[key] = answer(key)
  return facts[key]
}
function settled(judge) {
  const answers = new Map()
  for (let round = 0; round < 400; round++) {
    const step = stepOf(() => judge(getterOf(answers)))
    if ('value' in step) return step.value
    answers.set(step.need, ask(step.need))
  }
  throw new Error('too many facts')
}

const payload = JSON.parse(new TextDecoder().decode(await new Response(Deno.stdin.readable).arrayBuffer()) || '{}')
const line = typeof payload?.tool_input?.command === 'string' ? payload.tool_input.command : ''
const cwd = typeof payload.cwd === 'string' && payload.cwd !== '' ? payload.cwd : NO_CWD
const home = Deno.env.get('HOME')
const project = Deno.env.get('CLAUDE_PROJECT_DIR') || NO_PROJECT
const world = { facts, roots: '', vault: null, cwd, project }
let verdict = 'none'

if (payload.tool_name === 'Bash') {
  const parse = parseShell(line)
  if (hiddenCommandRefusal(parse) !== undefined) verdict = 'deny'
  else {
    // databaseOf
    if (settled(get => databaseRefusal(line, parse, cwd, home, get)) !== undefined) verdict = 'deny'
    // vaultGitOf
    if (verdict === 'none' && needsVaultGit(line, parse)) {
      const resolved = run(['bash', `${ROOT}/scripts/vault-resolve.sh`]).stdout.split('\n').find(row => row.startsWith('root\t'))
      world.vault = resolved === undefined ? null : resolved.slice(5)
      const vault = world.vault === null ? null : ask(dirKey(world.vault))
      if (vault !== null && settled(get => vaultGitRefusal(line, parse, { vault, cwd, home }, get)) !== undefined) verdict = 'deny'
    }
    // scopeOf
    if (verdict === 'none' && needsScope(line, parse)) {
      const bare = { cwd, home, roots: [], tmp: undefined, markers: undefined }
      const quick = stepOf(() => scopeVerdict(line, parse, bare, getterOf(new Map())))
      let scope
      if ('value' in quick) scope = quick.value
      else {
        world.roots = run(['bash', FACTS, 'roots', String(payload.session_id ?? '')]).stdout
        const fields = world.roots
          .split('\n')
          .map(row => row.split('\t'))
          .filter(([, path]) => path?.startsWith('/'))
        const real = ask(dirKey(project))
        const roots = [...new Set([...(real !== null && real !== '/' ? [real] : []), ...fields.filter(([kind]) => kind === 'root').map(([, path]) => path)])]
        const ctx = { cwd, home, roots, tmp: fields.find(([kind]) => kind === 'tmp')?.[1], markers: fields.find(([kind]) => kind === 'markers')?.[1] }
        scope = settled(get => scopeVerdict(line, parse, ctx, get))
      }
      verdict = scope.kind
    }
  }
}

console.log(JSON.stringify({ verdict, world }))
