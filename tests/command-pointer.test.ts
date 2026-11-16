import { describe, expect, test } from 'claude-code/testing'

import { COMMAND_POINTER_REMINDER, pointsAtUnshownCommand } from '../hooks/mods/command-pointer'
import { prompt, start, stop, world } from './harness'

const POINTER = 'Run the two commands listed above.'

describe('AC1: a reply that points at a command it does not show draws the reminder', () => {
  test('"Run the two commands listed above." with no code block is reminded', async ($, on) => {
    world(on, {})
    await $.session.start(start(true))
    await $.prompt.submit(prompt('clean up the scratch folders'))
    const result = await $.classic.Stop(stop(`The folders are left.\n\n${POINTER}`))
    expect(result.additionalContext).toEqual([COMMAND_POINTER_REMINDER])
    expect(result.block).toBeUndefined()
  })

  test('the reminder tells the agent to repeat the command in a bash block or in the dialog text', () => {
    expect(COMMAND_POINTER_REMINDER).toContain('bash')
    expect(COMMAND_POINTER_REMINDER).toContain('AskUserQuestion')
  })

  test('each position word pairs with each command word', () => {
    for (const position of ['above', 'earlier', 'previous', 'listed'])
      for (const command of ['command', 'commands', 'run', 'line']) expect(pointsAtUnshownCommand(`Use the ${command} ${position}.`)).toBe(true)
  })

  test('"the commands earlier" is a pointer', () => {
    expect(pointsAtUnshownCommand('Paste the commands earlier into a terminal.')).toBe(true)
  })

  test('context from a hook beneath is kept beside the reminder', async ($, on) => {
    const w = world(on, {})
    w.stopBeneath = { additionalContext: ['BENEATH'] }
    await $.session.start(start(true))
    await $.prompt.submit(prompt('clean up'))
    expect((await $.classic.Stop(stop(POINTER))).additionalContext).toEqual(['BENEATH', COMMAND_POINTER_REMINDER])
  })
})

describe('AC2: a reply that shows its command, or names no command, draws nothing', () => {
  test('a reply with a fenced code block is not reminded', async ($, on) => {
    world(on, {})
    await $.session.start(start(true))
    await $.prompt.submit(prompt('clean up'))
    const result = await $.classic.Stop(stop(`${POINTER}\n\n\`\`\`bash\nrm -rf /tmp/a\n\`\`\``))
    expect(result.additionalContext).toBeUndefined()
  })

  test('a tilde fence counts as a code block too', () => {
    expect(pointsAtUnshownCommand(`${POINTER}\n\n~~~\nrm -rf /tmp/a\n~~~`)).toBe(false)
  })

  test('"above" with no command word is not reminded', async ($, on) => {
    world(on, {})
    await $.session.start(start(true))
    await $.prompt.submit(prompt('fix the parser'))
    expect((await $.classic.Stop(stop('The fix is described above.'))).additionalContext).toBeUndefined()
  })

  test('a command word with no position word is not a pointer', () => {
    expect(pointsAtUnshownCommand('Run the tests again tomorrow.')).toBe(false)
  })

  test('the two words in separate sentences are not a pointer', () => {
    expect(pointsAtUnshownCommand('The fix is above. Run nothing else.')).toBe(false)
  })

  test('words inside inline code or quotes are not read', () => {
    expect(pointsAtUnshownCommand('The flag is `--line-above`. The hint "run earlier" is gone.')).toBe(false)
  })

  test('a longer word that holds a listed word is not a match', () => {
    expect(pointsAtUnshownCommand('The runner aboveground commanded nothing.')).toBe(false)
  })
})

describe('AC3: the reminder never blocks, and never reaches a sub-agent', () => {
  test('a reminded stop carries no block', async ($, on) => {
    world(on, {})
    await $.session.start(start(true))
    await $.prompt.submit(prompt('clean up'))
    const result = await $.classic.Stop(stop(POINTER))
    expect(result.block).toBeUndefined()
    expect(result.additionalContext).toEqual([COMMAND_POINTER_REMINDER])
  })

  test('a sub-agent stop through classic.Stop is not reminded', async ($, on) => {
    world(on, {})
    await $.session.start(start(true))
    await $.prompt.submit(prompt('clean up'))
    expect((await $.classic.Stop(stop(POINTER, { agent_id: 'a1', agent_type: 'watson' }))).additionalContext).toBeUndefined()
  })

  test('a sub-agent stop through classic.SubagentStop is not reminded', async ($, on) => {
    world(on, {})
    on('classic.SubagentStop', () => ({}))
    await $.session.start(start(true))
    await $.prompt.submit(prompt('clean up'))
    const result = await $.classic.SubagentStop({ stop_hook_active: false, last_assistant_message: POINTER, agent_id: 'a1', agent_type: 'watson' } as never)
    expect(result.additionalContext).toBeUndefined()
    expect(result.block).toBeUndefined()
  })

  test('a stop the engine already continued is not reminded again', async ($, on) => {
    world(on, {})
    await $.session.start(start(true))
    await $.prompt.submit(prompt('clean up'))
    expect((await $.classic.Stop(stop(POINTER, { stop_hook_active: true }))).additionalContext).toBeUndefined()
  })

  test('an unattended session is not reminded', async ($, on) => {
    world(on, {})
    await $.session.start(start(false))
    await $.prompt.submit(prompt('clean up'))
    expect((await $.classic.Stop(stop(POINTER))).additionalContext).toBeUndefined()
  })
})
