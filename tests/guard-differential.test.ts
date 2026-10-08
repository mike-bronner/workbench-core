// The class guard for the four bash guards' move into the hooks module. Each
// port (hooks/mods/guards.ts, judged in hooks/register.ts's tool.call hook)
// must refuse every call its frozen bash guard refused: the cases the guard's
// own suite fed it and seeded random ones, all in tests/oracle/guard-cases.ts,
// which hooks/test-guard-oracles.sh holds to the frozen guards under
// tests/oracle/. A port may let a refused call through only where a sandboxed
// run of the command under bash and under zsh did no harm (the fixture's
// SANDBOX half), and each such call is listed below.

import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Bench } from './bench'
import { bench, start } from './bench'
import { COUNTS, DENIED, HOME, SANDBOX } from './oracle/guard-cases'
import type { OracleCase } from './oracle/guard-cases'

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

describe('AC3: each port refuses everything its frozen bash guard refused', () => {
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
