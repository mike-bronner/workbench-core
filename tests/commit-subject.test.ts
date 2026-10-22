import { describe, expect, test } from 'claude-code/testing'

import { GITMOJI, TYPES, subjectFault, subjectVerdict } from '../hooks/mods/commit-subject'
import { parseShell } from '../hooks/mods/shell'
import { HOME, PERSON, bench, start } from './bench'

const bash = (command: string, agentId?: string) =>
  ({ tool: 'Bash', tool_use_id: 'toolu_1', description: 'd', command, ...(agentId === undefined ? {} : { agentId }) }) as never

type Answer = { deny?: string }

const PIPELINE = { env: { HOME, WORKBENCH_DEV_TEAM_PIPELINE: '1', CLAUDE_CODE_AGENT: 'watson' } }

describe('commit subject: the hook holds a main or pipeline commit to the format', () => {
  for (const [line, why] of [
    ['git commit -m x', 'does not start with a type and a colon'],
    ['git commit -m "fix: 🐛 Fix x"', 'does not end with a period'],
  ] as const) {
    test(`refused in the pipeline: ${JSON.stringify(line)}`, async ($, on) => {
      const b = bench(on, PIPELINE)
      await $.session.start(start(false))
      const answer = (await $.tool.call(bash(line))) as Answer
      expect(answer.deny).toContain('a commit subject that breaks the git-commit format')
      expect(answer.deny).toContain(why)
      expect(answer.deny).toContain('"<type>: <gitmoji> <Description>."')
      expect(answer.deny).toContain('Commit guard (workbench-core)')
      expect(b.calls.some(call => call.tool === 'Bash')).toBe(false)
    })

    test(`refused in Mike's session under his typed request: ${JSON.stringify(line)}`, async ($, on) => {
      const b = bench(on)
      await $.session.start(start())
      await $.prompt.submit({ text: 'commit it', wait: false, origin: PERSON })
      b.trees['/repo'] = ''
      const answer = (await $.tool.call(bash(line))) as Answer
      expect(answer.deny).toContain(why)
      expect(b.calls.some(call => call.tool === 'Bash')).toBe(false)
    })
  }

  for (const line of ['git commit -m "fix: 🐛 Fix x."', 'git log -m --oneline']) {
    test(`passes in the pipeline: ${JSON.stringify(line)}`, async ($, on) => {
      const b = bench(on, PIPELINE)
      await $.session.start(start(false))
      expect(((await $.tool.call(bash(line))) as Answer).deny).toBeUndefined()
      expect(b.calls.filter(call => call.tool === 'Bash').length).toBe(1)
    })
  }

  test("a sub-agent's commit is refused as a commit, before its subject is read", async ($, on) => {
    bench(on)
    await $.session.start(start())
    const answer = (await $.tool.call(bash('git commit -m wip', 'agent-1'))) as Answer
    expect(answer.deny).toContain('a sub-agent does not commit or push')
    expect(answer.deny).not.toContain('git-commit format')
  })

  test('an unapproved commit with a broken subject in Mike\'s session is refused for its subject before any dialog opens', async ($, on) => {
    const b = bench(on)
    b.trees['/repo'] = ''
    await $.session.start(start())
    await $.prompt.submit({ text: 'look around', wait: false, origin: PERSON })
    const answer = (await $.tool.call(bash('git commit -m wip'))) as Answer
    expect(answer.deny).toContain('a commit subject that breaks the git-commit format')
    expect(b.calls.some(call => call.tool === 'AskUserQuestion')).toBe(false)
  })
})

describe('commit subject: the pure rules', () => {
  test('the types are the ten the skill lists', () => {
    expect(TYPES).toEqual(['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore'])
  })

  test('every gitmoji in the list passes, with or without its U+FE0F', () => {
    for (const emoji of GITMOJI) {
      expect(subjectFault(`chore: ${emoji} Do x.`)).toBeUndefined()
      expect(subjectFault(`chore: ${emoji.replace(/\uFE0F/g, '')} Do x.`)).toBeUndefined()
    }
  })

  for (const [subject, fault] of [
    ['feat(core): ✨ Add x.', 'it has a scope'],
    ['feature: ✨ Add x.', 'is not a type'],
    ['feat:✨ Add x.', 'exactly one space'],
    ['feat: x Add x.', 'is not a gitmoji'],
    ['feat: ✨', 'one space and a description'],
  ] as const) {
    test(`a broken subject names its fault: ${JSON.stringify(subject)}`, () => {
      expect(subjectFault(subject)).toContain(fault)
    })
  }

  test('only a message written on the line is judged', () => {
    expect(subjectVerdict(parseShell('git commit -F msg.txt'))).toBeUndefined()
    expect(subjectVerdict(parseShell('git commit -m "$MSG"'))).toBeUndefined()
    expect(subjectVerdict(parseShell("git commit -m \"$(cat <<'EOF'\nwip\nEOF\n)\""))?.deny).toContain('"wip"')
    expect(subjectVerdict(parseShell('git commit -m "feat!: 💥 Drop x."'))).toBeUndefined()
  })
})
