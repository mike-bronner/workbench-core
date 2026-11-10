import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { FEEDBACK_FILTERS, FEEDBACK_MIN_SCORE, FEEDBACK_QUERY_MAX_CHARS, FEEDBACK_TIMEOUT_MS, dispatchQuery, feedbackOf, hitsOf, isDevTeamAgent, skillQuery } from '../hooks/mods/recall'
import type { Row, World } from './memory-world'
import { memoryWorld, prompt, start } from './memory-world'

const TASK = 'check out this pull request and do a full adversarial review'
const SKILL = 'team-plugin:orchestrate'
const DESCRIPTION = 'Run the dev team as background sub-agents, and route each review.'
const BRIEF = [
  'Workdir: /repo',
  'Goal: a full adversarial review of the committed range origin/main...HEAD returns a verdict.',
  'Context: the pull request is committed and pushed.',
  'Constraints: none',
  'Acceptance:',
  '- every changed file is read',
  'Done when: the verdict is handed back.',
].join('\n')

const note = (path: string, score: number, type = 'feedback'): Row => ({
  path,
  title: path.replace(/^.*\/|\.md$/g, ''),
  score,
  frontmatter: { type, summary: `The rule in ${path}.` },
})
const REVIEW = note('feedback/review-covers-committed-ranges.md', 0.03)
const OTHER = note('feedback/other-rule.md', 0.025)

const feedbackSearches = (w: World) => w.mcp.filter(call => call.tool === 'search' && JSON.stringify(call.args.filters) === JSON.stringify(FEEDBACK_FILTERS))
const feedbackIn = (context: readonly unknown[] | undefined) => (context?.find(text => typeof text === 'string' && text.startsWith('📎')) as string | undefined) ?? ''

function world(on: On, env: Record<string, string> = {}): World {
  const w = memoryWorld(on, env)
  on('session.root', () => ({ value: '/repo' }))
  w.scripts['false-bare.sh'] = () => ''
  w.scripts['scope-facts.sh'] = run => (run.argv[2] === 'dir' && run.argv[3] === '/' ? '/\n' : run.argv[2] === 'entry' ? 'missing\n' : '')
  return w
}

async function opened($: Engine, w: World, isInteractive = true): Promise<void> {
  await $.session.start(start(isInteractive))
  await $.prompt.submit(prompt(TASK))
  w.mcp.length = 0
  w.classified.length = 0
}

const loadSkill = async ($: Engine, extra: Record<string, unknown> = {}) => {
  await $.skill.prompt({ skill: SKILL, text: 'The skill.', frontmatter: { description: DESCRIPTION } })
  return $.tool.call({ tool: 'Skill', skill: SKILL, args: 'pull request 15', ...extra } as never)
}
const dispatch = ($: Engine, type: string, extra: Record<string, unknown> = {}) =>
  $.tool.call({ tool: 'Agent', subagent_type: type, description: 'Review the pull request', prompt: BRIEF, ...extra } as never)

describe('AC1: a skill load gets the feedback notes the relevance check accepts', () => {
  test('a feedback-only search with the prompt, the skill and its args, and a block beside the load', async ($, on) => {
    const w = world(on)
    await opened($, w)
    w.rows = [REVIEW]
    const result = await loadSkill($)
    expect(feedbackSearches(w)).toEqual([{ tool: 'search', args: { query: `${TASK}. orchestrate: ${DESCRIPTION}. pull request 15`, limit: 12, filters: { type: 'feedback' } } }])
    const block = feedbackIn(result.context)
    expect(block.split('\n')[0]).toBe(`📎 Feedback notes from the vault for the ${SKILL} skill. They reflect what was true when written, so verify them before acting. Read each one that bears on this step:`)
    expect(block).toContain('• review-covers-committed-ranges - The rule in feedback/review-covers-committed-ranges.md. (feedback/review-covers-committed-ranges.md)')
    expect(w.classified).toHaveLength(1)
    expect(w.classified[0]).toContain(`Task: ${TASK}. orchestrate: ${DESCRIPTION}`)
  })

  test('a note of another type, or one below the gate, is never injected, whatever the server returns', async ($, on) => {
    const w = world(on)
    await opened($, w)
    w.ignoresFilters = true
    w.rows = [note('insights/an-insight.md', 0.04, 'insight'), note('progress/a-task.md', 0.04, 'progress'), note('feedback/weak.md', FEEDBACK_MIN_SCORE - 0.0001), REVIEW]
    const block = feedbackIn((await loadSkill($)).context)
    expect(block).toContain('review-covers-committed-ranges')
    expect(block).not.toMatch(/an-insight|a-task|weak/)
    expect(w.classified).toHaveLength(1)
  })

  for (const [name, label] of [
    ['unrelated', 'unrelated'],
    ['no label', undefined],
  ] as const) {
    test(`a note the check answers with ${name} is not injected`, async ($, on) => {
      const w = world(on)
      await opened($, w)
      w.rows = [REVIEW, OTHER]
      w.classify = text => (text.includes('other-rule') ? 'relevant' : label)
      const block = feedbackIn((await loadSkill($)).context)
      expect(block).toContain('other-rule')
      expect(block).not.toContain('review-covers')
    })
  }

  test('at most three accepted notes ride the load, best first', async ($, on) => {
    const w = world(on)
    await opened($, w)
    w.rows = [0.05, 0.04, 0.03, 0.025].map((score, i) => note(`feedback/rule-${i}.md`, score))
    const lines = feedbackIn((await loadSkill($)).context).split('\n').slice(1)
    expect(lines.map(line => line.replace(/^.*\(|\)$/g, ''))).toEqual(['feedback/rule-0.md', 'feedback/rule-1.md', 'feedback/rule-2.md'])
  })

  for (const [name, env, isInteractive, agentId] of [
    ["a sub-agent's load", {}, true, 'agent-1'],
    ['an unattended session', {}, false, undefined],
    ['WORKBENCH_MEMORY_RECALL=0', { WORKBENCH_MEMORY_RECALL: '0' }, true, undefined],
  ] as const) {
    test(`${name} gets no feedback search`, async ($, on) => {
      const w = world(on, env)
      await opened($, w, isInteractive)
      w.rows = [REVIEW]
      const result = await loadSkill($, agentId === undefined ? {} : { agentId })
      expect(feedbackSearches(w)).toEqual([])
      expect(feedbackIn(result.context)).toBe('')
    })
  }
})

describe('AC2: a dev-team dispatch gets the feedback notes the check accepts for the brief', () => {
  for (const type of ['team-plugin:holmes', 'team-plugin:holmes-local', 'team-plugin:watson-direct', 'team-plugin:lestrade-item', 'watson']) {
    test(`a ${type} dispatch searches with the brief and gets the block beside its result`, async ($, on) => {
      const w = world(on)
      await opened($, w)
      w.rows = [REVIEW]
      const result = await dispatch($, type)
      expect(result.deny).toBeUndefined()
      expect(feedbackSearches(w).map(call => call.args.query)).toEqual([dispatchQuery(type, 'Review the pull request', BRIEF)])
      expect(String(feedbackSearches(w)[0]?.args.query)).toContain('origin/main...HEAD')
      expect(feedbackIn(result.context)).toContain(`for this ${type} dispatch`)
      expect(feedbackIn(result.context)).toContain('(feedback/review-covers-committed-ranges.md)')
    })
  }

  test("a sub-agent's dev-team dispatch gets no feedback search", async ($, on) => {
    const w = world(on)
    await opened($, w)
    w.rows = [REVIEW]
    const result = await dispatch($, 'team-plugin:holmes', { agentId: 'agent-1' })
    expect(feedbackSearches(w)).toEqual([])
    expect(feedbackIn(result.context)).toBe('')
  })

  test('another agent type gets no feedback search', async ($, on) => {
    const w = world(on)
    await opened($, w)
    w.rows = [REVIEW]
    const result = await dispatch($, 'general-purpose')
    expect(feedbackSearches(w)).toEqual([])
    expect(feedbackIn(result.context)).toBe('')
  })

  test('a note the check rejects for the brief is not injected', async ($, on) => {
    const w = world(on)
    await opened($, w)
    w.rows = [REVIEW]
    w.classify = () => 'unrelated'
    expect(feedbackIn((await dispatch($, 'team-plugin:holmes')).context)).toBe('')
  })
})

describe('AC3: a note is injected once per conversation', () => {
  test('a note shown at a skill load is not shown again at a later load or dispatch, and /clear starts over', async ($, on) => {
    const w = world(on)
    await opened($, w)
    w.rows = [REVIEW]
    expect(feedbackIn((await loadSkill($)).context)).toContain('review-covers')
    w.rows = [REVIEW, OTHER]
    const second = feedbackIn((await dispatch($, 'team-plugin:holmes')).context)
    expect(second).toContain('other-rule')
    expect(second).not.toContain('review-covers')
    expect(feedbackIn((await loadSkill($)).context)).toBe('')
    expect(w.classified.filter(text => text.includes('review-covers'))).toHaveLength(1)
    await $.session.end({ reason: 'clear', sessionId: w.sid, resume: { id: w.sid } })
    expect(feedbackIn((await dispatch($, 'team-plugin:holmes')).context)).toContain('review-covers')
  })

  test('two dispatches at once show a note once', async ($, on) => {
    const w = world(on)
    await opened($, w)
    w.rows = [REVIEW]
    const results = await Promise.all([dispatch($, 'team-plugin:holmes'), dispatch($, 'team-plugin:watson')])
    expect(results.map(result => feedbackIn(result.context).includes('review-covers'))).toEqual([true, false])
  })

  for (const [name, call, fail] of [
    ['a skill load refused beneath', ($: Engine) => loadSkill($), (w: World) => (w.refuse = 'Skill')],
    ['a skill load that errors', ($: Engine) => loadSkill($), (w: World) => (w.fails = 'Skill')],
    ['a dispatch that errors', ($: Engine) => dispatch($, 'team-plugin:holmes'), (w: World) => (w.fails = 'Agent')],
  ] as const) {
    test(`${name} shows no block and uses nothing up`, async ($, on) => {
      const w = world(on)
      await opened($, w)
      w.rows = [REVIEW]
      fail(w)
      expect(feedbackIn((await call($)).context)).toBe('')
      w.refuse = undefined
      w.fails = undefined
      expect(feedbackIn((await call($)).context)).toContain('review-covers')
    })
  }

  test('/clear forgets the last prompt, so a later load searches without it', async ($, on) => {
    const w = world(on)
    await opened($, w)
    await $.session.end({ reason: 'clear', sessionId: w.sid, resume: { id: w.sid } })
    await loadSkill($)
    expect(feedbackSearches(w).map(search => search.args.query)).toEqual([`orchestrate: ${DESCRIPTION}. pull request 15`])
  })

  test('a dispatch refused beneath uses nothing up, so the next dispatch still gets the note', async ($, on) => {
    const w = world(on)
    await opened($, w)
    w.rows = [REVIEW]
    w.refuse = 'Agent'
    expect(await dispatch($, 'team-plugin:holmes')).toEqual({ deny: 'refused beneath' })
    w.refuse = undefined
    expect(feedbackIn((await dispatch($, 'team-plugin:holmes')).context)).toContain('review-covers')
  })
})

describe('AC4: recall never blocks, denies or delays a load or a dispatch past the budget', () => {
  const calls: [string, ($: Engine) => Promise<{ deny?: string; context?: readonly unknown[] }>][] = [
    ['a skill load', $ => loadSkill($)],
    ['a dispatch', $ => dispatch($, 'team-plugin:holmes')],
  ]
  for (const [call, run] of calls) {
    for (const [name, fail] of [
      ['a search error', (w: World) => (w.rows = 'error')],
      ['a search that throws', (w: World) => (w.searchFails = () => true)],
      ['a check that throws', (w: World) => (w.classify = () => new Error('overloaded'))],
      ['a server that does not connect', (w: World) => (w.connects = false)],
    ] as const) {
      test(`${name} leaves ${call} as it was, with no error text`, async ($, on) => {
        const w = world(on)
        w.connects = !name.includes('connect')
        await opened($, w)
        w.rows = [REVIEW]
        fail(w)
        const result = await run($)
        expect(result.deny).toBeUndefined()
        expect(feedbackIn(result.context)).toBe('')
        expect(JSON.stringify(result.context ?? [])).not.toMatch(/error|overloaded|reset|connect/i)
      })
    }

    for (const [name, stall] of [
      ['a stalled search', (w: World) => (w.searchHangs = () => true)],
      ['a stalled check', (w: World) => (w.classify = () => 'hang')],
    ] as const) {
      test(`${name} lets ${call} go on at the budget, with nothing added`, async ($, on) => {
        const w = world(on)
        await opened($, w)
        w.rows = [REVIEW]
        stall(w)
        let done = false
        const pending = run($).then(result => {
          done = true
          return result
        })
        await w.clock.advance(FEEDBACK_TIMEOUT_MS - 1)
        expect(done).toBe(false)
        await w.clock.advance(1)
        const result = await pending
        expect(result.deny).toBeUndefined()
        expect(feedbackIn(result.context)).toBe('')
      })
    }
  }
})

describe('the readers', () => {
  test('dev-team agent types, any mode, with or without a plugin prefix', () => {
    for (const type of ['watson', 'holmes', 'lestrade', 'team-plugin:watson-index', 'team-plugin:holmes-lens', 'team-plugin:lestrade-sweep']) expect(isDevTeamAgent(type)).toBe(true)
    for (const type of ['Explore', 'general-purpose', 'team-plugin:sherlock', 'watsonish', undefined, 3]) expect(isDevTeamAgent(type)).toBe(false)
  })

  test('the queries', () => {
    expect(skillQuery('team-plugin:orchestrate', undefined, undefined, undefined)).toBe('team-plugin:orchestrate')
    expect(skillQuery('s', '  ', 'Does\nthings.', 'the task')).toBe('the task. s: Does things.')
    expect(dispatchQuery('holmes', 3, 'x'.repeat(2000))).toHaveLength(FEEDBACK_QUERY_MAX_CHARS)
    expect(dispatchQuery('holmes', 'Review it', undefined)).toBe('holmes. Review it')
  })

  test('feedbackOf keeps feedback above the gate, unseen, once each', () => {
    const hits = hitsOf([{ type: 'text', text: JSON.stringify({ result: [REVIEW, REVIEW, OTHER, note('insights/x.md', 0.04, 'insight')] }) }])
    expect(feedbackOf(hits, [], FEEDBACK_MIN_SCORE).map(hit => hit.path)).toEqual([REVIEW.path, OTHER.path])
    expect(feedbackOf(hits, [REVIEW.path], FEEDBACK_MIN_SCORE).map(hit => hit.path)).toEqual([OTHER.path])
  })
})
