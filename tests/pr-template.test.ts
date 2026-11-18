import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { proseRefusal } from '../hooks/mods/outbound-prose'
import { OTHER_REPO_TEMPLATE, UNPLACED_TEMPLATE, headingsOf, missingHeadings, prCallsOf } from '../hooks/mods/pr-template'
import { parseShell } from '../hooks/mods/shell'
import type { Bench } from './bench'
import { bench, start } from './bench'

const HOME = '/Users/tester'
const TEMPLATE = '## Summary\n\n<!-- What changed, and why. -->\n\n## Test plan\n\n- [ ] Tests pass\n- [ ] Reviewed the diff\n'
const FULL = '## Summary\n\nFixed the list loader.\n\n## Test plan\n\n- [x] Tests pass\n- [ ] Reviewed the diff\n'
const HALF = '## Summary\n\nFixed the list loader.\n'
const FREE = 'Fixed the list loader. The form now reads stored values on edit.'
const PROSE_HEADER = proseRefusal([]).split('\n')[0] as string

type Call = Record<string, unknown> & { tool: string }

async function session($: Engine, on: Parameters<typeof bench>[0]): Promise<Bench> {
  const b = bench(on, { env: { HOME } })
  b.scripts['vault-resolve.sh'] = () => `root\t${HOME}/Documents/Claude/Memory\n`
  b.repos['/repo'] = { originUrl: 'git@github.com:o/r.git' }
  await $.session.start(start(false))
  return b
}

async function refusal($: Engine, b: Bench, call: Call): Promise<string | undefined> {
  const before = b.inputs.length
  const result = await $.tool.call(call as never)
  expect([call, b.inputs.length > before]).toEqual([call, result.deny === undefined])
  return result.deny
}

const bash = (command: string): Call => ({ tool: 'Bash', command })

function place(b: Bench, path: string, text = TEMPLATE): void {
  const parts = path.split('/')
  for (let k = 2; k < parts.length; k++) b.dirs.add(parts.slice(0, k).join('/'))
  b.files.set(path, text)
}

const routes = (body: string): string[] => [
  `gh pr create --title t --body '${body}'`,
  `gh pr edit 1 --body '${body}'`,
  'gh pr edit 1 --body-file /repo/body.md',
  `gh pr create --title t --body-file - <<'EOF'\n${body}\nEOF`,
]

describe('the pull request template checks', () => {
  test('a heading is read outside fenced code and comments, with its closing marks dropped', () => {
    expect(headingsOf('# One\n## Two ##\n<!-- ## Hidden -->\n```\n## Code\n```\n####### Seven\n#None\nText')).toEqual(['# One', '## Two'])
  })

  test('a heading counts at any level and in any letter case, and a missing one is named', () => {
    expect(missingHeadings(TEMPLATE, '### SUMMARY\n\n# test   plan')).toEqual([])
    expect(missingHeadings(TEMPLATE, HALF)).toEqual(['## Test plan'])
    expect(missingHeadings(TEMPLATE, 'Summary and Test plan, in prose.')).toEqual(['## Summary', '## Test plan'])
    expect(missingHeadings(TEMPLATE, '```\n## Summary\n## Test plan\n```')).toEqual(['## Summary', '## Test plan'])
  })

  test('only a create, and an edit that sets the body, are read', () => {
    const count = (line: string): number => {
      const reading = prCallsOf(parseShell(line))
      return 'calls' in reading ? reading.calls.length : -1
    }
    expect(count('gh pr create --fill')).toBe(1)
    expect(count("gh pr edit 1 -b 'x'")).toBe(1)
    expect(count('gh pr edit 1 -bx')).toBe(1)
    expect(count('gh pr edit 1 --body=x')).toBe(1)
    expect(count('gh pr edit 1 -F body.md')).toBe(1)
    expect(count('gh pr edit 1 --body-file=body.md')).toBe(1)
    expect(count('gh pr edit 1 --title x --add-label bug')).toBe(0)
    expect(count("gh pr comment 1 --body 'x'")).toBe(0)
    expect(count("gh issue create --title t --body 'x'")).toBe(0)
  })

  test('the target repository and a change of directory are read from the line', () => {
    const calls = (line: string) => {
      const reading = prCallsOf(parseShell(line))
      return 'calls' in reading ? reading.calls.map(c => [c.repo, c.dir]) : []
    }
    expect(calls("gh pr create -R o/r --body 'x'")).toEqual([['o/r', undefined]])
    expect(calls("gh pr create --repo=o/r --body 'x'")).toEqual([['o/r', undefined]])
    expect(calls("GH_REPO=o/r gh pr create --body 'x'")).toEqual([['o/r', undefined]])
    expect(calls("cd /other && gh pr create --body 'x'")).toEqual([[undefined, '/other']])
    expect(calls("cd $DIR && gh pr create --body 'x'")).toEqual([[undefined, null]])
    expect(calls("popd && gh pr create --body 'x'")).toEqual([[undefined, null]])
  })
})

describe('the pull request template guard', () => {
  test('AC1: a body that lacks the headings is refused at each place, in any letter case', async ($, on) => {
    const b = await session($, on)
    for (const path of [
      '/repo/.github/PULL_REQUEST_TEMPLATE.md',
      '/repo/.github/pull_request_template.md',
      '/repo/PULL_REQUEST_TEMPLATE.md',
      '/repo/Pull_Request_Template.md',
      '/repo/docs/PULL_REQUEST_TEMPLATE.md',
      '/repo/docs/pull_request_template.MD',
      '/repo/.github/PULL_REQUEST_TEMPLATE/feature.md',
      '/repo/.github/pull_request_template/feature.md',
    ]) {
      b.files.clear()
      b.dirs.clear()
      place(b, path)
      b.files.set('/repo/body.md', FREE)
      for (const command of [...routes(FREE), 'gh pr create --fill']) {
        const deny = await refusal($, b, bash(command))
        expect([path, command, deny?.includes(path.slice('/repo/'.length))]).toEqual([path, command, true])
      }
    }
  })

  test('AC2: the refusal names the template, each missing heading, and how to fill it', async ($, on) => {
    const b = await session($, on)
    place(b, '/repo/.github/PULL_REQUEST_TEMPLATE.md')
    const deny = await refusal($, b, bash(`gh pr create --title t --body '${HALF}'`))
    expect(deny).toContain('Pull request template guard (workbench-core)')
    expect(deny).toContain('Template: .github/PULL_REQUEST_TEMPLATE.md')
    expect(deny).toContain('- ## Test plan')
    expect(deny).not.toContain('- ## Summary')
    expect(deny).toContain('Fill every section honestly.')
    expect(deny).toContain('Leave unticked any checkbox that attests to something not done or not verified.')
    const both = await refusal($, b, bash(`gh pr create --title t --body '${FREE}'`))
    expect(both).toContain('- ## Summary\n- ## Test plan')
  })

  test('AC3: a body that holds every heading passes', async ($, on) => {
    const b = await session($, on)
    place(b, '/repo/docs/pull_request_template.md')
    b.files.set('/repo/body.md', FULL)
    for (const command of routes(FULL)) expect([command, await refusal($, b, bash(command))]).toEqual([command, undefined])
  })

  test('AC3: a body that holds every heading of any one template in the folder passes', async ($, on) => {
    const b = await session($, on)
    place(b, '/repo/.github/PULL_REQUEST_TEMPLATE/feature.md')
    place(b, '/repo/.github/PULL_REQUEST_TEMPLATE/bugfix.md', '## Cause\n\n## Fix\n')
    b.files.set('/repo/.github/PULL_REQUEST_TEMPLATE/notes.txt', '## Ignored\n')
    expect(await refusal($, b, bash(`gh pr create --title t --body '${FULL}'`))).toBeUndefined()
    expect(await refusal($, b, bash("gh pr create --title t --body '## Cause\n\nA race.\n\n## Fix\n\nA lock.'"))).toBeUndefined()
    const deny = await refusal($, b, bash("gh pr create --title t --body '## Cause\n\nA race.\n\n## Test plan\n\nRan it.'"))
    expect(deny).toContain('2 pull request templates')
    expect(deny).toContain('Template: .github/PULL_REQUEST_TEMPLATE/feature.md\nMissing headings:\n- ## Summary')
    expect(deny).toContain('Template: .github/PULL_REQUEST_TEMPLATE/bugfix.md\nMissing headings:\n- ## Fix')
    expect(deny).not.toContain('Ignored')
  })

  test('AC4: with no template, every such call runs', async ($, on) => {
    const b = await session($, on)
    b.files.set('/repo/body.md', FREE)
    b.files.set('/repo/src/PULL_REQUEST_TEMPLATE.md', TEMPLATE)
    b.dirs.add('/repo/src')
    for (const command of [...routes(FREE), 'gh pr create --fill']) expect([command, await refusal($, b, bash(command))]).toEqual([command, undefined])
  })

  test('outside a git repository, a call that names no repository runs', async ($, on) => {
    const b = await session($, on)
    b.cwd = '/elsewhere'
    place(b, '/elsewhere/PULL_REQUEST_TEMPLATE.md')
    expect(await refusal($, b, bash(`gh pr create --title t --body '${FREE}'`))).toBeUndefined()
    expect(await refusal($, b, bash(`gh pr create -R o/r --title t --body '${FREE}'`))).toBe(OTHER_REPO_TEMPLATE)
  })

  test('AC5: an inline body, a body file and a heredoc body are each judged', async ($, on) => {
    const b = await session($, on)
    place(b, '/repo/PULL_REQUEST_TEMPLATE.md')
    b.files.set('/repo/half.md', HALF)
    b.files.set('/repo/full.md', FULL)
    const cases: [string, boolean][] = [
      [`gh pr create --title t --body '${HALF}'`, true],
      [`gh pr create --title t --body '${FULL}'`, false],
      ['gh pr create --title t --body-file half.md', true],
      ['gh pr create --title t -F /repo/full.md', false],
      [`gh pr edit 1 --body-file - <<'EOF'\n${HALF}\nEOF`, true],
      [`gh pr edit 1 --body-file - <<'EOF'\n${FULL}\nEOF`, false],
    ]
    for (const [command, isRefused] of cases) {
      const deny = await refusal($, b, bash(command))
      expect([command, deny?.includes('- ## Test plan') ?? false]).toEqual([command, isRefused])
    }
  })

  test('AC6: an edit that sets no body is not judged', async ($, on) => {
    const b = await session($, on)
    place(b, '/repo/.github/PULL_REQUEST_TEMPLATE.md')
    for (const command of ['gh pr edit 1 --title "Fix the loader"', 'gh pr edit 1 --add-label bug', 'gh pr view 1']) {
      expect([command, await refusal($, b, bash(command))]).toEqual([command, undefined])
    }
  })

  test('the prose guard still answers first', async ($, on) => {
    const b = await session($, on)
    place(b, '/repo/.github/PULL_REQUEST_TEMPLATE.md')
    const deny = await refusal($, b, bash("gh pr create --title t --body 'Fixed it; at last.'"))
    expect(deny?.startsWith(PROSE_HEADER)).toBe(true)
  })

  test('a named repository is judged when a remote of the tree points at it, and refused when none does', async ($, on) => {
    const b = await session($, on)
    place(b, '/repo/.github/PULL_REQUEST_TEMPLATE.md')
    expect(await refusal($, b, bash(`gh pr create -R O/R --title t --body '${FREE}'`))).toContain('- ## Summary')
    expect(await refusal($, b, bash(`gh pr create --repo github.com/o/r --title t --body '${FULL}'`))).toBeUndefined()
    expect(await refusal($, b, bash(`gh pr create -R other/repo --title t --body '${FULL}'`))).toBe(OTHER_REPO_TEMPLATE)
    expect(await refusal($, b, bash(`GH_REPO=other/repo gh pr create --title t --body '${FULL}'`))).toBe(OTHER_REPO_TEMPLATE)
    expect(await refusal($, b, bash(`gh pr create -R ghe.example.com/o/r --title t --body '${FULL}'`))).toBe(OTHER_REPO_TEMPLATE)
  })

  test('a GH_REPO in the environment counts as a named repository', async ($, on) => {
    const b = bench(on, { env: { HOME, GH_REPO: 'other/repo' } })
    b.scripts['vault-resolve.sh'] = () => `root\t${HOME}/Documents/Claude/Memory\n`
    b.repos['/repo'] = { originUrl: 'git@github.com:o/r.git' }
    await $.session.start(start(false))
    place(b, '/repo/.github/PULL_REQUEST_TEMPLATE.md')
    expect(await refusal($, b, bash(`gh pr create --title t --body '${FULL}'`))).toBe(OTHER_REPO_TEMPLATE)
  })

  test('a change of directory is followed, and one the guard cannot place is refused', async ($, on) => {
    const b = await session($, on)
    b.repos['/other'] = {}
    place(b, '/other/.github/PULL_REQUEST_TEMPLATE.md')
    expect(await refusal($, b, bash(`gh pr create --title t --body '${FREE}'`))).toBeUndefined()
    expect(await refusal($, b, bash(`cd /other && gh pr create --title t --body '${FREE}'`))).toContain('Template: .github/PULL_REQUEST_TEMPLATE.md')
    expect(await refusal($, b, bash(`cd /other && gh pr create --title t --body '${FULL}'`))).toBeUndefined()
    expect(await refusal($, b, bash(`cd $DIR && gh pr create --title t --body '${FULL}'`))).toBe(UNPLACED_TEMPLATE)
  })

  test('a tree git cannot read, or templates the guard cannot list or read, are refused', async ($, on) => {
    const b = await session($, on)
    b.run = argv => (argv.includes('--show-toplevel') ? { stdout: '', exitCode: 1 } : undefined)
    expect(await refusal($, b, bash(`gh pr create --title t --body '${FULL}'`))).toBe(UNPLACED_TEMPLATE)
    b.run = undefined
    b.unlistable.add('/repo')
    expect(await refusal($, b, bash(`gh pr create --title t --body '${FULL}'`))).toBe(UNPLACED_TEMPLATE)
    b.unlistable.clear()
    place(b, '/repo/.github/PULL_REQUEST_TEMPLATE/feature.md')
    b.unlistable.add('/repo/.github/PULL_REQUEST_TEMPLATE')
    expect(await refusal($, b, bash(`gh pr create --title t --body '${FULL}'`))).toBe(UNPLACED_TEMPLATE)
  })

  test('the tree is read from its top level, not the folder the call runs in', async ($, on) => {
    const b = await session($, on)
    b.cwd = '/repo/src'
    b.run = argv => (argv[2] === '/repo/src' && argv.includes('--show-toplevel') ? { stdout: '/repo\n', exitCode: 0 } : undefined)
    place(b, '/repo/.github/PULL_REQUEST_TEMPLATE.md')
    expect(await refusal($, b, bash(`gh pr create --title t --body '${FREE}'`))).toContain('- ## Summary')
  })
})
