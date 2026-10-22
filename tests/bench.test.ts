import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Bench } from './bench'
import { SID, bench, start } from './bench'

const ALLOW = { behavior: 'allow' }
const LS = { command: 'ls /repo' }

async function opened($: Engine, on: Parameters<typeof bench>[0]): Promise<Bench> {
  const b = bench(on)
  for (const name of ['false-bare.sh', 'session-warmup.sh', 'scratch-roots.sh', 'memory-status.sh', 'vault-resolve.sh']) b.scripts[name] = () => ''
  await $.session.start(start())
  return b
}

const dialog = async ($: Engine, tool: string, input: Record<string, unknown>): Promise<unknown> =>
  (
    (await $.classic.PermissionRequest({
      hook_event_name: 'PermissionRequest',
      session_id: SID,
      transcript_path: '/t.jsonl',
      cwd: '/repo',
      permission_mode: 'default',
      tool_name: tool,
      tool_input: input,
    } as never)) as { decision?: unknown }
  ).decision

const checked = ($: Engine, tool: string, input: Record<string, unknown>, id: string) => $.tool.check({ tool, input, tool_use_id: id } as never)

describe("the bench answers a call's own permission dialog, once", () => {
  test('a dialog with no checked call behind it gets no answer', async ($, on) => {
    await opened($, on)
    expect(await dialog($, 'Bash', LS)).toBeUndefined()
  })

  test('the checked call gets one answer, and a second dialog for it gets none', async ($, on) => {
    await opened($, on)
    await checked($, 'Bash', LS, 'u1')
    expect(await dialog($, 'Bash', LS)).toEqual(ALLOW)
    expect(await dialog($, 'Bash', LS)).toBeUndefined()
  })

  test('another tool, or another input, gets no answer, and leaves the checked call its own', async ($, on) => {
    await opened($, on)
    await checked($, 'Bash', LS, 'u1')
    expect(await dialog($, 'Read', LS)).toBeUndefined()
    expect(await dialog($, 'Bash', { command: 'ls /other' })).toBeUndefined()
    expect(await dialog($, 'Bash', { ...LS, description: 'x' })).toBeUndefined()
    expect(await dialog($, 'Bash', LS)).toEqual(ALLOW)
  })

  test('a call that already ran leaves no dialog to answer', async ($, on) => {
    const b = await opened($, on)
    b.decision = 'allow'
    await checked($, 'Bash', LS, 'u1')
    await $.tool.call({ tool: 'Bash', ...LS, tool_use_id: 'u1' } as never)
    expect(await dialog($, 'Bash', LS)).toBeUndefined()
  })

  test('two checked calls with the same input get one answer each', async ($, on) => {
    await opened($, on)
    await checked($, 'Bash', LS, 'u1')
    await checked($, 'Bash', LS, 'u2')
    expect(await dialog($, 'Bash', LS)).toEqual(ALLOW)
    expect(await dialog($, 'Bash', LS)).toEqual(ALLOW)
    expect(await dialog($, 'Bash', LS)).toBeUndefined()
  })

  test('a decision from beneath stands, and is not replaced by the answer', async ($, on) => {
    const b = await opened($, on)
    b.permissionBeneath = { decision: { behavior: 'deny', message: 'no' } }
    await checked($, 'Bash', LS, 'u1')
    expect(await dialog($, 'Bash', LS)).toEqual({ behavior: 'deny', message: 'no' })
  })
})
