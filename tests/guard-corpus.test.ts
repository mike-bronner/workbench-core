// The class guard for the four bash guards' move into the hooks module. Each
// port (hooks/mods/guards.ts, judged in hooks/register.ts's tool.call hook)
// must refuse every call its retired bash guard refused: the cases the guard's
// own suite fed it and seeded random ones, all in the static corpus
// tests/guard-corpus/guard-cases.ts, recorded from the bash guards before they
// were retired. A port may let a refused call through only where a sandboxed
// run of the command under bash and under zsh did no harm (the fixture's
// SANDBOX half), and each such call is listed below.

import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { proseRefusal } from '../hooks/mods/outbound-prose'
import type { Bench } from './bench'
import { bench, start } from './bench'
import { COUNTS, DENIED, HOME, PROSE_SANDBOX, SANDBOX } from './guard-corpus/guard-cases'
import type { OracleCase } from './guard-corpus/guard-cases'
import { WORLD_COUNTS, WORLD_DENIED, WORLD_FACTS, WORLD_SANDBOX } from './guard-corpus/world-cases'
import type { WorldCase } from './guard-corpus/world-cases'
import { install, peekOf, recorded } from './world'

// The first line of a refusal that judged a body on its prose.
const PROSE_HEADER = proseRefusal([]).split('\n')[0] as string

type Payload = { tool_name?: unknown; tool_input?: unknown; agent_id?: unknown }

// The tool call the engine raises for a recorded hook payload, or undefined
// for a payload no tool call can carry (not JSON, or an input that is not an
// object): the engine hands a guard typed input only.
function callOf(c: OracleCase): Record<string, unknown> | undefined {
  let payload: Payload
  try {
    payload = JSON.parse(c.payload) as Payload
  } catch {
    return undefined
  }
  const input = payload.tool_input ?? {}
  if (typeof payload.tool_name !== 'string' || typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  const agentId = typeof payload.agent_id === 'string' && payload.agent_id !== '' ? { agentId: payload.agent_id } : {}
  return { ...(input as Record<string, unknown>), tool: payload.tool_name, ...agentId }
}

const commandOf = (call: Record<string, unknown>): string | undefined => (call.tool === 'Bash' && typeof call.command === 'string' ? call.command : undefined)

// The port's answer to one call: its refusal, or undefined when the call
// reached the engine.
async function portRefusal($: Engine, b: Bench, call: Record<string, unknown>): Promise<string | undefined> {
  const before = b.inputs.length
  const result = await $.tool.call(call as never)
  expect([call, result.deny === undefined]).toEqual([call, b.inputs.length > before])
  return result.deny
}

// Each command the port lets through that its oracle refused, all of them
// shown harmless by a sandboxed run under bash and zsh. Keyed by guard. The
// classes they fall in:
//   - a credential path, a .env word, `security` or a writer word only in a
//     comment, which runs nothing
//   - a heredoc body holding `$.env.get`, which is no file
//   - `$.env` in a word: the hooks module's own `$.env.get`, which is no file
//   - a word that only looks like a dotenv name (`.envln`, `.envrcx/...`)
//   - a creation verb that is an argument of a command that does not exist
//   - a line bash and zsh both refuse to parse, so nothing runs
const EXCEPTIONS: Readonly<Record<string, readonly string[]>> = {
  'credential-guard': [
    "\n;<<'EOF'\nconst h = await $.env.get('HOME')\nEOF\n cp",
    "# security env -i .envrc\n.env sudo ~/.ssh \n",
    ".envrcx/.ssh/id_rsa $.env.get;security }",
    "<<'EOF'\nconst h = await $.env.get('HOME')\nEOF\n \"a note about .env files\" grep x\n-s 'Claude Code-credentials'# Developer/.aws~/.ssh)",
    "cat security<<'EOF'\nconst h = await $.env.get('HOME')\nEOF\n",
    "env -i;# ${HOME}/.gnupg/pubring.kbx\nhead -c 10 .envln -s\necho",
    "x/.ssh/id_rsa security .env.example\ncp $.env.getDeveloper/.aws|sudo\nprintf %s",
    "~/.claude/.credentials.json app.env .envrc;# sudo node -e",
    "~/.ssh # grep x }",
  ],
  'provisioning-guard': [
    "\"SELECT 'create database'\" env -i { create\\\ndb",
  ],
  'summary-writer-guard': [
    "tee 2># $(;( evalecho hi # sessions/a.md",
  ],
  'peer-message-gate': [],
}

async function differential($: Engine, b: Bench, guard: string, writer: string): Promise<{ letThrough: string[]; unproven: string[] }> {
  await $.session.start(start(false))
  const letThrough: string[] = []
  const unproven: string[] = []
  for (const c of DENIED.filter(d => d.guard === guard && d.writer === writer)) {
    const call = callOf(c)
    if (call === undefined) continue
    const refusal = await portRefusal($, b, call)
    if (refusal !== undefined) {
      expect(refusal).not.toContain('could not finish')
      continue
    }
    const command = commandOf(call)
    const run = command === undefined ? undefined : SANDBOX[`${guard}\u0000${command}`]
    if (command !== undefined && run?.bash === true && run.zsh === true) letThrough.push(command)
    else unproven.push(c.payload)
  }
  return { letThrough, unproven }
}

const benchFor = (on: Parameters<typeof bench>[0], writer: string): Bench => {
  const b = bench(on, { env: { HOME, ...(writer === '1' ? { WORKBENCH_SUMMARY_WRITER: '1' } : {}) } })
  b.scripts['scratch-roots.sh'] = () => '/scratch\n'
  return b
}

describe('AC3: each port refuses everything its retired bash guard refused', () => {
  for (const guard of Object.keys(EXCEPTIONS)) {
    const writer = guard === 'summary-writer-guard' ? '1' : ''
    test(`${guard}: every refused case is refused, or sandbox-proven harmless and listed`, { timeoutMs: 60_000 }, async ($, on) => {
      const b = benchFor(on, writer)
      const { letThrough, unproven } = await differential($, b, guard, writer)
      expect(unproven).toEqual([])
      expect([...letThrough].sort()).toEqual([...(EXCEPTIONS[guard] ?? [])].sort())
    })
  }

  // A guard with no suite case, no random case, or no refusal would make the
  // test above pass with nothing to compare.
  test('the fixture reads cases of every guard, from its suite and at random', () => {
    for (const guard of Object.keys(EXCEPTIONS)) {
      const counts = COUNTS[guard]
      expect([guard, (counts?.suite ?? 0) > 0, (counts?.random ?? 0) > 0, (counts?.denied ?? 0) > 0]).toEqual([guard, true, true, true])
    }
  })

  // Every exception listed is a command the oracle refused and the sandbox
  // proved harmless in both shells, so the list cannot carry a stale entry.
  test('each listed exception is sandbox-proven', () => {
    for (const [guard, commands] of Object.entries(EXCEPTIONS)) {
      for (const command of commands) {
        expect([guard, command, SANDBOX[`${guard}\u0000${command}`]]).toEqual([guard, command, { bash: true, zsh: true }])
      }
    }
  })

  // The test must be able to fail: a port that refused nothing would leave
  // each of these unproven.
  test('control: the fixture holds many refused commands the sandbox found harmful', () => {
    const bashCases = DENIED.filter(d => callOf(d) !== undefined && commandOf(callOf(d) as Record<string, unknown>) !== undefined)
    expect(bashCases.length).toBeGreaterThan(300)
    const harmful = bashCases.filter(d => {
      const run = SANDBOX[`${d.guard}\u0000${commandOf(callOf(d) as Record<string, unknown>)}`]
      return run !== undefined && !(run.bash && run.zsh)
    })
    expect(harmful.length).toBeGreaterThan(100)
  })
})

// ─── the guards that read the disk ───────────────────────────────────────────
//
// The destructive-scope, destructive-database and vault-git ports judge where
// a path lands and what git says. Their cases (tests/guard-corpus/world-cases.ts)
// carry the facts the port asked about in the sandbox the oracle ran in, and
// each is replayed here through the module (tests/world.ts): its tool.call,
// and its tool.check, where an out-of-root target asks. A refusal or an ask
// counts as the port refusing. A fact the replay asks for that nobody recorded
// fails the test: the module now asks about a fact the corpus never recorded,
// so add the fact to the case by hand.

// Each command the port lets through that its oracle refused, all of them
// shown harmless by a sandboxed run under bash and zsh. The classes they fall
// in:
//   - a git verb after a real redirect the oracle misread as a quoted `>`
//     (`git checkout -b fresh 2>/dev/null` makes a branch and discards nothing)
//   - a destructive word the oracle found in a line, where the port reads no
//     destructive command: one with no operand (`rmdir`, `git` alone), a
//     word that is no git verb, and a verb that is only an argument
//     (`docker compose down -v` as words handed to a command named `db:wipe`,
//     on a line that opens with `;`, which neither shell runs)
//   - a line neither shell can parse (`&&;`, `;|`, `;||;`, a stray `)` or an
//     unclosed `(`), so no word of it runs as a command
//   - a destructive word that is only an argument of a command that is not
//     rm, rmdir, git or a runner: of a name that is no program (`-C`,
//     `file.txtfind`, `/`, `clean`, `stash`), of `echo`, or of `cd` under
//     `env -i`. A `-c alias.x='reset --hard'` there never reaches git
//   - `reset` run as the terminal's own reset command, not as a git verb
//     (`*;git;reset --hard`: `git` stands alone and prints its usage)
//   - `xargs` with no command, which runs echo
// A glob in the command word is no exception: the port refuses it, because it
// runs the first file in the folder.
const WORLD_EXCEPTIONS: Readonly<Record<string, readonly string[]>> = {
  'destructive-scope-guard': [
    // a git verb after a real redirect
    'git checkout -b fresh 2>/dev/null',
    // no operand
    '2>&1 rmdir',
    // no parse
    'env -i cd /tmp/wb-oracle/victim rm -rf parallel >clean -fd;-C /tmp/wb-oracle/victim-repo;|',
    '2>&1; clean -n ; git &&;cd /tmp/wb-oracle/victim',
    'build git;stash list;( env -i ( stash list',
    // only an argument, or the terminal's reset
    "-C /tmp/wb-oracle/project -c alias.x='reset --hard' x cd /tmp/wb-oracle/victim rmdir",
    '/tmp/wb-oracle//project/./build clean -n;stash liststash drop } find . -exec rm {} + sudo',
    "-C /tmp/wb-oracle/project -c alias.x='reset --hard' x echo rm rm -rf -C /tmp/wb-oracle/victim-repo stash drop {\ncheckout feature",
    "echo -c alias.x='reset --hard' x;cd /tmp/wb-oracle/victim;file.txtfind . -exec rm {} +;/\ncd /tmp/wb-oracle/project *",
    "/ buildstash list -c alias.x='reset --hard' xfind . -exec rm {} + ;",
    "xargs |\nclean -fdbuild\n-c alias.x='reset --hard' x restore rmdir",
    "reset --hard-c alias.x='reset --hard' x /tmp/wb-oracle/victim/keep.txt /tmp/wb-oracle/project/build\ngit;||;-C /tmp/wb-oracle/victim-repo timeout 5",
    'clean -fd\n2>&1 git build#;/ env -i',
    'file.txtrm\ngit /tmp/wb-oracle/victim/keep.txt rm -rf;/',
  ],
  'destructive-database-guard': [';db:wipe { docker compose down -v;eval'],
  'vault-git-guard': [],
}

type WorldRun = { letThrough: string[]; unproven: string[]; misses: string[] }

// The cases of one guard and source, in groups of one vault each: the module
// reads the vault root once per load.
const groupsOf = (cases: readonly WorldCase[]): Map<string, WorldCase[]> => {
  const groups = new Map<string, WorldCase[]>()
  for (const c of cases) groups.set(`${c.guard}\u0000${c.source}\u0000${c.vault ?? ''}`, [...(groups.get(`${c.guard}\u0000${c.source}\u0000${c.vault ?? ''}`) ?? []), c])
  return groups
}

async function worldDifferential($: Engine, b: Bench, cases: readonly WorldCase[]): Promise<WorldRun> {
  await $.session.start(start(true))
  const run: WorldRun = { letThrough: [], unproven: [], misses: [] }
  // The engine's own decision allows, so any ask or deny is the module's.
  b.decision = 'allow'
  for (const c of cases) {
    const call = callOf({ guard: c.guard, source: c.source, payload: c.payload, writer: '' })
    const command = call === undefined ? undefined : commandOf(call)
    if (call === undefined || command === undefined) continue
    const facts = { ...(WORLD_FACTS[`${c.guard}\u0000${c.source}`] ?? {}), ...c.facts }
    install(b, recorded(facts, run.misses), { roots: c.roots, vault: c.vault }, peekOf(facts))
    b.cwd = c.cwd
    b.root = c.project
    const result = await $.tool.call(call as never)
    if (result.deny !== undefined) {
      expect(result.deny).not.toContain('could not finish')
      continue
    }
    const check = await $.tool.check({ tool: 'Bash', input: { command } })
    if (check.decision !== 'allow') continue
    const sandbox = WORLD_SANDBOX[`${c.guard}\u0000${command}`]
    if (sandbox?.bash === true && sandbox.zsh === true) run.letThrough.push(command)
    else run.unproven.push(command)
  }
  return run
}

describe('AC2: each disk-reading port refuses or asks on everything its retired bash guard refused', () => {
  for (const [key, cases] of groupsOf(WORLD_DENIED)) {
    const [guard = '', source = '', vault = ''] = key.split('\u0000')
    test(`${guard}, ${source} cases${vault === '' ? '' : ' with a vault'}: each is refused or asked, or sandbox-proven harmless and listed`, { timeoutMs: 120_000 }, async ($, on) => {
      const b = bench(on, { env: { HOME } })
      b.scripts['scratch-roots.sh'] = () => ''
      const { letThrough, unproven, misses } = await worldDifferential($, b, cases)
      expect([...new Set(misses)]).toEqual([])
      expect(unproven).toEqual([])
      expect([guard, letThrough.filter(command => !(WORLD_EXCEPTIONS[guard] ?? []).includes(command))]).toEqual([guard, []])
    })
  }

  test('the fixture reads cases of every disk-reading guard, from its suite and at random', () => {
    for (const guard of Object.keys(WORLD_EXCEPTIONS)) {
      const counts = WORLD_COUNTS[guard]
      expect([guard, (counts?.suite ?? 0) > 0, (counts?.random ?? 0) > 0, (counts?.denied ?? 0) > 0]).toEqual([guard, true, true, true])
      expect([guard, WORLD_DENIED.filter(c => c.guard === guard).length]).toEqual([guard, counts?.denied])
    }
  })

  test('each listed exception is a refused case the sandbox proved harmless in both shells', () => {
    for (const [guard, commands] of Object.entries(WORLD_EXCEPTIONS)) {
      for (const command of commands) {
        expect([guard, command, WORLD_SANDBOX[`${guard}\u0000${command}`]]).toEqual([guard, command, { bash: true, zsh: true }])
        expect([guard, command, WORLD_DENIED.some(c => c.guard === guard && commandOf(callOf({ ...c, writer: '' }) ?? {}) === command)]).toEqual([guard, command, true])
      }
    }
  })

  // The test must be able to fail: the port's recorded verdicts hold many
  // refusals and asks.
  test('control: most recorded cases are refused or asked by the port', () => {
    const refused = WORLD_DENIED.filter(c => c.port === 'deny' || c.port === 'ask')
    expect(refused.length).toBeGreaterThan(WORLD_DENIED.length * 0.9)
    expect(WORLD_DENIED.filter(c => c.port === 'ask').length).toBeGreaterThan(100)
  })
})

// ─── the outbound prose guard ────────────────────────────────────────────────
//
// The port (hooks/mods/outbound-prose.ts) reads body files and lists the vault
// root. Each refused case in the fixture carries the files, folders and vault
// root of the sandbox its suite ran in, written as PROSE_SANDBOX, and is
// replayed here with those files in place. The guard posts prose and runs no
// command that can do harm, so no sandbox run can prove a let-through
// harmless, and none is listed: the port refuses every one.

type ProseWorld = { vault: string; files: Record<string, string>; dirs: string[] }

const PROSE = DENIED.filter(c => c.guard === 'outbound-prose-guard')
const worldOf = (c: OracleCase): ProseWorld => (c.world === undefined ? { vault: '', files: {}, dirs: [] } : (JSON.parse(c.world) as ProseWorld))

describe('AC2: the outbound prose port refuses every body its retired bash guard refused', () => {
  // One test per vault root: the module reads the root once per load.
  const vaults = [...new Set(PROSE.map(c => worldOf(c).vault))]
  let replayedTotal = 0
  for (const vault of vaults) {
    test(`outbound-prose-guard, ${vault === '' ? 'the default vault' : `the vault ${vault}`}: every refused body is refused`, { timeoutMs: 60_000 }, async ($, on) => {
      const b = bench(on, { env: { HOME } })
      b.scripts['vault-resolve.sh'] = () => `root\t${vault === '' ? `${HOME}/Documents/Claude/Memory` : vault}\n`
      await $.session.start(start(false))
      const letThrough: string[] = []
      const unjudged: string[] = []
      const cases = PROSE.filter(d => worldOf(d).vault === vault)
      let replayed = 0
      for (const c of cases) {
        const call = callOf(c)
        expect([c.payload, call !== undefined]).toEqual([c.payload, true])
        if (call === undefined) continue
        replayed++
        const world = worldOf(c)
        b.files.clear()
        b.dirs.clear()
        for (const [path, text] of Object.entries(world.files)) b.files.set(path, text)
        for (const dir of world.dirs) b.dirs.add(dir)
        b.cwd = PROSE_SANDBOX
        const refusal = await portRefusal($, b, call)
        if (refusal === undefined) letThrough.push(c.payload)
        else if (!refusal.startsWith(PROSE_HEADER)) unjudged.push(c.payload)
      }
      // Each body the bash guard refused is judged here too on its prose,
      // not refused unread, expanded or moved, and no case is skipped.
      expect(letThrough).toEqual([])
      expect(unjudged).toEqual([])
      expect(replayed).toBe(cases.length)
      replayedTotal += replayed
    })
  }

  test('the fixture holds refused suite cases of the prose guard, with their files', () => {
    expect((COUNTS['outbound-prose-guard']?.suite ?? 0) > 0).toBe(true)
    expect(PROSE.length).toBe(COUNTS['outbound-prose-guard']?.denied)
    // The cases the replay above judged, not the fixture's own count.
    expect(replayedTotal).toBe(PROSE.length)
    expect(PROSE.length).toBeGreaterThan(50)
    expect(PROSE.some(c => Object.keys(worldOf(c).files).length > 0)).toBe(true)
  })
})
