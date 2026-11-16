import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { bufferWarningOf } from '../hooks/mods/monitor'
import type { Bench } from './bench'
import { bench, start } from './bench'

const HEAD = 'Monitor buffer check (workbench-core):'
const MEGA = "tail -n 0 -F events.log | grep --line-buffered -E 'x' | cut -c1-400"

const monitor = (command: string, agentId?: string) =>
  ({ tool: 'Monitor', tool_use_id: 'toolu_1', description: 'd', timeout_ms: 1000, command, ...(agentId === undefined ? {} : { agentId }) }) as never

async function warningsFor($: Engine, b: Bench, call: never): Promise<string[]> {
  const before = b.inputs.length
  const result = await $.tool.call(call)
  expect(result.deny).toBeUndefined()
  expect(b.inputs.length).toBe(before + 1)
  return (result.context ?? []).map(String).filter(text => text.startsWith(HEAD))
}

describe('the warning text', () => {
  test('the incident command names cut and suggests awk with fflush()', () => {
    const warning = bufferWarningOf(MEGA) ?? ''
    expect(warning.startsWith(HEAD)).toBe(true)
    expect(warning).toContain("- `cut`: use awk with fflush(), such as `awk '{ print substr($0, 1, 400); fflush() }'` instead.")
    expect(warning).not.toContain('`grep`')
    expect(warning).not.toContain('`tail`')
  })

  for (const [command, name, replacement] of [
    ['tail -F x | cut -c1-4', 'cut', 'awk with fflush()'],
    ['tail -F x | tr a b', 'tr', 'awk with fflush()'],
    ['tail -F x | sort', 'sort', 'awk with fflush()'],
    ['tail -F x | uniq', 'uniq', 'awk with fflush()'],
    ['tail -F x | head -n 5', 'head', 'awk with fflush()'],
    ["tail -F x | sed 's/a/b/'", 'sed', 'sed -u'],
    ["tail -F x | sed -n -e 's/u/b/p'", 'sed', 'sed -u'],
    ["tail -F x | sed -eu 's/a/b/'", 'sed', 'sed -u'],
    ['tail -F x | jq .', 'jq', 'jq --unbuffered'],
    ['tail -F x | python3 filter.py', 'python3', 'python3 -u'],
    ['tail -F x | python filter.py -u', 'python', 'python -u'],
    ["tail -F x | python3 -c 'import sys' -u", 'python3', 'python3 -u'],
    ["tail -F x | awk '{ print $1 }'", 'awk', 'awk with fflush()'],
    ["tail -F x | gawk '{ print $1 }'", 'gawk', 'awk with fflush()'],
    ['tail -F x | grep y', 'grep', 'grep --line-buffered'],
    ['stdbuf -eL cut -c1-4 x', 'cut', 'awk with fflush()'],
    ['tail -F x | cut -c1-4 | grep --line-buffered y', 'cut', 'awk with fflush()'],
    ["bash -c 'tail -F x | cut -c1-4'", 'cut', 'awk with fflush()'],
    ['tail -F x | tac', 'tac', 'awk with fflush()'],
    ['tail -F x | wc -l', 'wc', 'awk with fflush()'],
    ['tail -F x | stdbuf -oL sort', 'sort', 'awk with fflush()'],
    ['tail -F x | stdbuf -oL tac', 'tac', 'awk with fflush()'],
    ['tail -F x | stdbuf -o0 wc -l', 'wc', 'awk with fflush()'],
    ['tail -F x | unbuffer -p sort', 'sort', 'awk with fflush()'],
    ['tail -F x | unbuffer -p tac', 'tac', 'awk with fflush()'],
    ['tail -F x | unbuffer -p wc -l', 'wc', 'awk with fflush()'],
    ['tail -F x | stdbuf -oL python3 f.py', 'python3', 'python3 -u'],
    ['tail -F x | stdbuf --output=0 python f.py', 'python', 'python -u'],
    ['tail -F x | tee >(cut -c1-4)', 'cut', 'awk with fflush()'],
    ['tail -F x | tee >(grep y | sed s/a/b/) >/dev/null', 'sed', 'sed -u'],
    ['tail -F x | tee >(grep --line-buffered y | unbuffer cut -c1-4)', 'unbuffer', 'unbuffer -p'],
    ['tail -F x | unbuffer cut -c1-4', 'unbuffer', 'unbuffer -p'],
    ['tail -F x | unbuffer python3 f.py', 'unbuffer', 'unbuffer -p'],
    ['tail -F x |& unbuffer cut -c1-4', 'unbuffer', 'unbuffer -p'],
    ['tail -F x | sudo unbuffer cut -c1-4', 'unbuffer', 'unbuffer -p'],
  ] as const) {
    test(`${JSON.stringify(command)} names ${name} and ${replacement}`, () => {
      const warning = bufferWarningOf(command) ?? ''
      expect(warning.startsWith(HEAD)).toBe(true)
      const line = warning.split('\n').find(text => text.startsWith(`- \`${name}\`: `))
      expect(line).toContain(replacement)
    })
  }

  test('sort says why no flushing form of it exists', () => {
    expect(bufferWarningOf('tail -F x | sort')).toContain("- `sort`: sort prints nothing until its input ends, so drop it and do the per-line work in awk with fflush(), such as `awk '{ print; fflush() }'`.")
  })

  test('the unbuffer line says why -p is needed', () => {
    expect(bufferWarningOf('tail -F x | unbuffer cut -c1-4')).toContain('- `unbuffer`: without -p, unbuffer does not read the pipe, so use unbuffer -p instead.')
  })

  test('each flagged stage gets its own line, once', () => {
    const lines = (bufferWarningOf('tail -F x | cut -c1-4 | sed s/a/b/ | cut -c1-2') ?? '').split('\n').filter(text => text.startsWith('- '))
    expect(lines.map(text => text.slice(0, text.indexOf(':')))).toEqual(['- `cut`', '- `sed`'])
  })

  for (const command of [
    'tail -F x | grep --line-buffered y',
    'tail -F x',
    "tail -F x | awk '{ print $1; fflush() }'",
    "tail -F x | sed -u 's/a/b/'",
    "tail -F x | sed -nu 's/a/b/p'",
    "tail -F x | sed --unbuffered 's/a/b/'",
    'tail -F x | jq --unbuffered .',
    'tail -F x | python3 -u filter.py',
    'tail -F x | python3 -um filter',
    'tail -F x | PYTHONUNBUFFERED=1 python3 filter.py',
    'tail -F x | stdbuf -oL cut -c1-4',
    'tail -F x | stdbuf -o0 cut -c1-4',
    'tail -F x | stdbuf -o L cut -c1-4',
    'tail -F x | stdbuf --output=L tr a b',
    'tail -F x | unbuffer -p cut -c1-4',
    'tail -F x | unbuffer -p python3 f.py',
    'unbuffer python3 f.py | grep --line-buffered y',
    'cd x && unbuffer python3 f.py',
    'echo "$(date | cut -c1-4)"',
    'echo $(date | cut -c1-4)',
    'echo `date | cut -c1-4`',
    'echo "`date | cut -c1-4`"',
    'echo "$(tail -F x | tee >(cut -c1-4))"',
    "tail -F x | grep --line-buffered '>(cut -c1-4)'",
    'tail -F x | grep --line-buffered "| unbuffer cut"',
    'tail -F x | tee >(grep --line-buffered y)',
  ]) {
    test(`${JSON.stringify(command)} draws no warning`, () => {
      expect(bufferWarningOf(command)).toBeUndefined()
    })
  }

  for (const command of ['tail -F x | cut -c1-4 | $FILTER', 'tail -F x | cut -c1-4 | sh']) {
    test(`a line the parser cannot read draws no warning: ${JSON.stringify(command)}`, () => {
      expect(bufferWarningOf(command)).toBeUndefined()
    })
  }
})

describe('the Monitor hook', () => {
  test('a main-session Monitor call runs and carries the warning as context', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    const warnings = await warningsFor($, b, monitor(MEGA))
    expect(warnings).toEqual([bufferWarningOf(MEGA)])
  })

  test("a sub-agent's Monitor call runs and carries the warning as context", async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    const warnings = await warningsFor($, b, monitor(MEGA, 'a5a2f4470341f9233'))
    expect(warnings).toEqual([bufferWarningOf(MEGA)])
  })

  test('a flushing Monitor command runs with no warning', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    expect(await warningsFor($, b, monitor('tail -F x | grep --line-buffered y'))).toEqual([])
  })

  test('an unreadable Monitor command runs with no warning', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    expect(await warningsFor($, b, monitor('tail -F x | cut -c1-4 | $FILTER'))).toEqual([])
  })

  test('a WebSocket Monitor call runs with no warning', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    const call = { tool: 'Monitor', tool_use_id: 'toolu_1', description: 'd', timeout_ms: 1000, ws: { url: 'wss://example.test' } } as never
    expect(await warningsFor($, b, call)).toEqual([])
  })

  test('a Monitor call that failed to start carries no warning', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    b.errorBeneath = tool => tool === 'Monitor'
    const result = await $.tool.call(monitor(MEGA))
    expect(result.isError).toBe(true)
    expect((result.context ?? []).map(String).filter(text => text.startsWith(HEAD))).toEqual([])
  })
})
