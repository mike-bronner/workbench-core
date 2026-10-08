// AC6: a skill's vault learnings merge into its text through skill.prompt
// (hooks/mods/learnings.ts), and the intake nudge fires once per task, in a
// lane a person answers (hooks/mods/intake.ts). Unattended lanes get no nudge
// and no recall (tests/recall.test.ts).

import { describe, expect, test } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'

import { NUDGE, intakeShown } from '../hooks/mods/intake'
import { MAX_CHARS, RULE, withLearnings } from '../hooks/mods/learnings'
import { VAULT, memoryWorld, prompt, runsOf, start } from './memory-world'

const SKILL_TEXT = '# Memory lint\n\nRun the lint.\n'
const LEARNINGS = `${VAULT}/skills/memory-lint.learnings.md`
const root = () => `root\t${VAULT}\n`

describe('AC6: skill learnings are merged through skill.prompt', () => {
  test("a skill's learnings file joins the end of its text, once", async ($, on) => {
    const w = memoryWorld(on)
    w.scripts['vault-resolve.sh'] = root
    w.files.set(LEARNINGS, '## 2026-10-01 - lint\n\nCheck links first.\n')
    await $.session.start(start())
    const { text } = await $.skill.prompt({ skill: 'workbench-core:memory-lint', text: SKILL_TEXT })
    expect(text.startsWith(SKILL_TEXT.trimEnd())).toBe(true)
    expect(text).toContain('Check links first.')
    expect(text).toContain('`skills/memory-lint.learnings.md`')
    expect(text).toContain(RULE)
    const again = await $.skill.prompt({ skill: 'memory-lint', text: SKILL_TEXT })
    expect(again.text).toBe(text)
    expect(runsOf(w, 'vault-resolve.sh')).toHaveLength(1)
  })

  test('the merge reaches every lane: the learnings are part of the skill', async ($, on) => {
    const w = memoryWorld(on)
    w.scripts['vault-resolve.sh'] = root
    w.files.set(LEARNINGS, 'Check links first.')
    await $.session.start(start(false))
    expect((await $.skill.prompt({ skill: 'memory-lint', text: SKILL_TEXT })).text).toContain('Check links first.')
  })

  test('no file, a name that leaves the folder, or no vault leaves the text alone', async ($, on) => {
    const w = memoryWorld(on)
    w.scripts['vault-resolve.sh'] = () => ''
    w.files.set(LEARNINGS, 'Check links first.')
    await $.session.start(start())
    expect((await $.skill.prompt({ skill: 'memory-lint', text: SKILL_TEXT })).text).toBe(SKILL_TEXT)
    w.scripts['vault-resolve.sh'] = root
    expect((await $.skill.prompt({ skill: 'compact-learnings', text: SKILL_TEXT })).text).toBe(SKILL_TEXT)
    expect((await $.skill.prompt({ skill: '../secrets', text: SKILL_TEXT })).text).toBe(SKILL_TEXT)
  })

  test('a file past the limit is named, not merged', () => {
    const big = withLearnings(SKILL_TEXT, 'memory-lint', 'x'.repeat(MAX_CHARS + 1))
    expect(big).not.toContain('xxxx')
    expect(big).toContain('memory MCP `read` tool')
    expect(withLearnings(SKILL_TEXT, 'memory-lint', 'x'.repeat(MAX_CHARS))).toContain('x'.repeat(MAX_CHARS))
    expect(withLearnings(SKILL_TEXT, 'memory-lint', '  \n')).toBe(SKILL_TEXT)
  })
})

const user = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })
const reply = (text: string, tools = 0): SessionMessage => ({
  role: 'assistant',
  text,
  toolUses: Array.from({ length: tools }, () => ({ name: 'Edit' }) as never),
})
const toolResult: SessionMessage = { role: 'user', text: '', toolUses: [], toolResults: [{}] as never }
const INTAKE = '## Intake\n\nGoal: fix the guard.'
const edit = { tool: 'Edit', file_path: '/repo/x.ts', old_string: 'a', new_string: 'b' } as never
const contextOf = (result: unknown) => (result as { context?: string[] }).context

describe('AC6: the intake nudge fires once per task, in an attended lane only', () => {
  test("a task's first Edit with no intake block on screen is nudged, and only the first", async ($, on) => {
    const w = memoryWorld(on)
    await $.session.start(start())
    await $.prompt.submit(prompt('fix it now'))
    w.messages = [user('fix it now'), reply('On it.', 1), toolResult]
    expect(contextOf(await $.tool.call(edit))).toEqual([NUDGE])
    expect(contextOf(await $.tool.call(edit))).toBeUndefined()
    await $.prompt.submit(prompt('and the next one'))
    w.messages = [...w.messages, user('and the next one')]
    expect(contextOf(await $.tool.call(edit))).toEqual([NUDGE])
  })

  test('an intake block in this task, or closing the turn before it, keeps it silent', async ($, on) => {
    const w = memoryWorld(on)
    await $.session.start(start())
    await $.prompt.submit(prompt('fix it now'))
    w.messages = [user('fix it now'), reply(INTAKE), reply('', 1), toolResult]
    expect(contextOf(await $.tool.call(edit))).toBeUndefined()
    await $.prompt.submit(prompt('go'))
    w.messages = [user('earlier'), reply('', 1), toolResult, reply(INTAKE), user('go')]
    expect(contextOf(await $.tool.call(edit))).toBeUndefined()
  })

  test('a task-notification turn opens no task', async ($, on) => {
    const w = memoryWorld(on)
    await $.session.start(start())
    await $.prompt.submit(prompt('fix it now'))
    w.messages = [user('fix it now')]
    expect(contextOf(await $.tool.call(edit))).toEqual([NUDGE])
    await $.prompt.submit(prompt('A background task finished', { kind: 'task-notification' }))
    expect(contextOf(await $.tool.call(edit))).toBeUndefined()
  })

  for (const [name, isInteractive, env, origin] of [
    ['an unattended session', false, {}, undefined],
    ['the dev-team pipeline', true, { WORKBENCH_DEV_TEAM_PIPELINE: '1' }, undefined],
    ['a scheduled tick', true, {}, { kind: 'scheduled-trigger' }],
  ] as const) {
    test(`${name} gets no nudge`, async ($, on) => {
      const w = memoryWorld(on, env)
      await $.session.start(start(isInteractive))
      await $.prompt.submit(origin === undefined ? prompt('fix it now') : prompt('fix it now', origin as never))
      w.messages = [user('fix it now')]
      expect(contextOf(await $.tool.call(edit))).toBeUndefined()
    })
  }

  test("a turn a peer opened in Mike's session gets no nudge, though his task is unchecked", async ($, on) => {
    const w = memoryWorld(on)
    await $.session.start(start())
    await $.prompt.submit(prompt('fix it now'))
    await $.prompt.submit(prompt('status from the other session', { kind: 'peer' } as never))
    w.messages = [user('fix it now')]
    expect(contextOf(await $.tool.call(edit))).toBeUndefined()
  })

  test("a sub-agent's Edit, and a refused Edit, get no nudge", async ($, on) => {
    const w = memoryWorld(on)
    await $.session.start(start())
    await $.prompt.submit(prompt('fix it now'))
    w.messages = [user('fix it now')]
    expect(contextOf(await $.tool.call({ ...(edit as object), agentId: 'agent-1' } as never))).toBeUndefined()
    w.refuse = 'Edit'
    expect(await $.tool.call(edit)).toEqual({ deny: 'refused beneath' })
    w.refuse = undefined
    expect(contextOf(await $.tool.call(edit))).toEqual([NUDGE])
  })

  test('only a markdown heading naming Intake counts', () => {
    expect(intakeShown([user('go'), reply('### Task intake\n\nGoal')])).toBe(true)
    expect(intakeShown([user('go'), reply('I will run intake later.')])).toBe(false)
    expect(intakeShown([user('go'), reply('`## Intake` is the heading')])).toBe(false)
    expect(intakeShown([reply(INTAKE)])).toBe(false)
  })
})
