import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { UNREAD_BODY, proseRefusal } from '../hooks/mods/outbound-prose'
import { MOVED_TEMPLATE, OTHER_REPO_TEMPLATE, UNPLACED_TEMPLATE, headingsOf, missingHeadings, prCallsOf } from '../hooks/mods/pr-template'
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

  test('the target repository is read from the call, and from a GH_REPO set anywhere on the line', () => {
    const repos = (line: string) => {
      const reading = prCallsOf(parseShell(line))
      return 'calls' in reading ? reading.calls.map(c => c.repo) : reading.refusal
    }
    expect(repos("gh pr create --body 'x'")).toEqual([undefined])
    expect(repos("gh pr create -R o/r --body 'x'")).toEqual(['o/r'])
    expect(repos("gh pr create --repo=o/r --body 'x'")).toEqual(['o/r'])
    expect(repos("GH_REPO=o/r gh pr create --body 'x'")).toEqual(['o/r'])
    expect(repos("export GH_REPO=o/r; gh pr create --body 'x'")).toEqual(['o/r'])
    expect(repos("declare -x GH_REPO=o/r && gh pr create --body 'x'")).toEqual(['o/r'])
    expect(repos("GH_REPO=o/r; gh pr create --body 'x'")).toEqual(['o/r'])
    expect(repos("gh pr create --body 'x'; export GH_REPO=o/r")).toEqual(['o/r'])
    expect(repos("GH_REPO=o/r; export GH_REPO; gh pr create --body 'x'")).toEqual(['$GH_REPO'])
    expect(repos("export GH_REPO=a/b; gh pr create -R o/r --body 'x'")).toEqual(['o/r'])
    expect(repos("export GH_TOKEN=t; gh pr create --body 'x'")).toEqual([undefined])
  })

  test('AC1: a change of directory before the call is refused, in every spelling', () => {
    const reading = (line: string) => {
      const read = prCallsOf(parseShell(line))
      return 'calls' in read ? read.calls.length : read.refusal
    }
    for (const line of [
      "cd /nonexistent; gh pr create --body 'x'",
      "cd a && cd b && gh pr create --body 'x'",
      "(cd /tmp); gh pr create --body 'x'",
      "pushd /x && gh pr edit 1 --body 'x'",
      'popd; gh pr create --fill',
      "builtin cd /x; gh pr create --body 'x'",
      "chdir /x; gh pr create --body 'x'",
      "env -C /x gh pr create --body 'x'",
      "env --chdir=/x gh pr create --body 'x'",
      "sudo -D /x gh pr create --body 'x'",
    ])
      expect([line, reading(line)]).toEqual([line, MOVED_TEMPLATE])
    expect(reading("gh pr create --body 'x'; cd /x")).toBe(1)
    expect(reading('cd /x && gh pr view 1')).toBe(0)
    expect(reading('cd /x; gh pr edit 1 --title t')).toBe(0)
  })

  test('AC3: of repeated body flags, only the last is read, as gh posts it', () => {
    const bodies = (line: string) => {
      const reading = prCallsOf(parseShell(line))
      return 'calls' in reading ? reading.calls.map(c => c.body) : reading.refusal
    }
    expect(bodies("gh pr create --body 'a' --body 'b'")).toEqual([{ text: 'b' }])
    expect(bodies("gh pr edit 1 -b 'a' --body-file /b.md")).toEqual([{ file: '/b.md', isJson: false }])
    expect(bodies('gh pr create --fill')).toEqual([undefined])
  })

  test('AC6: a body the parse cannot read is refused unread', () => {
    expect(prCallsOf(parseShell('gh pr create --title t --body-file -'))).toEqual({ refusal: UNREAD_BODY })
  })

  test('AC4: a CRLF template and a CRLF body are matched by heading, both ways', () => {
    const crlf = (text: string): string => text.replaceAll('\n', '\r\n')
    expect(headingsOf(crlf(TEMPLATE))).toEqual(['## Summary', '## Test plan'])
    expect(missingHeadings(crlf(TEMPLATE), FULL)).toEqual([])
    expect(missingHeadings(TEMPLATE, crlf(FULL))).toEqual([])
    expect(missingHeadings(crlf(TEMPLATE), crlf(FULL))).toEqual([])
    expect(missingHeadings(crlf(TEMPLATE), crlf(HALF))).toEqual(['## Test plan'])
    expect(missingHeadings(crlf(TEMPLATE), FREE)).toEqual(['## Summary', '## Test plan'])
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

  test('AC2: outside a repository, a call runs only when git says so and no repository is named', async ($, on) => {
    const b = await session($, on)
    b.cwd = '/elsewhere'
    place(b, '/elsewhere/PULL_REQUEST_TEMPLATE.md')
    let stderr = 'fatal: not a git repository (or any of the parent directories): .git\n'
    b.run = argv => (argv[2] === '/elsewhere' && argv.includes('--show-toplevel') ? { stdout: '', exitCode: 128, stderr } : undefined)
    expect(await refusal($, b, bash(`gh pr create --title t --body '${FREE}'`))).toBeUndefined()
    expect(await refusal($, b, bash(`gh pr create -R o/r --title t --body '${FREE}'`))).toBe(OTHER_REPO_TEMPLATE)
    expect(await refusal($, b, bash(`export GH_REPO=o/r; gh pr create --title t --body '${FREE}'`))).toBe(OTHER_REPO_TEMPLATE)
    expect(await refusal($, b, bash(`gh pr create --title t --body '${FREE}'; export GH_REPO=o/r`))).toBe(OTHER_REPO_TEMPLATE)
    for (const failure of [
      "fatal: cannot change to '/elsewhere': No such file or directory\n",
      "fatal: detected dubious ownership in repository at '/elsewhere'\n",
      '',
    ]) {
      stderr = failure
      expect([failure, await refusal($, b, bash(`gh pr create --title t --body '${FREE}'`))]).toEqual([failure, UNPLACED_TEMPLATE])
    }
  })

  test('a GH_REPO exported on the line is judged like -R', async ($, on) => {
    const b = await session($, on)
    place(b, '/repo/.github/PULL_REQUEST_TEMPLATE.md')
    expect(await refusal($, b, bash(`export GH_REPO=other/repo; gh pr create --title t --body '${FULL}'`))).toBe(OTHER_REPO_TEMPLATE)
    expect(await refusal($, b, bash(`export GH_REPO=o/r; gh pr create --title t --body '${FREE}'`))).toContain('- ## Summary')
    expect(await refusal($, b, bash(`export GH_REPO=o/r; gh pr create --title t --body '${FULL}'`))).toBeUndefined()
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

  test('AC1: in a templated tree, a change of directory before the call is refused, with a full body too', async ($, on) => {
    const b = await session($, on)
    place(b, '/repo/.github/PULL_REQUEST_TEMPLATE.md')
    expect(await refusal($, b, bash(`gh pr create --title t --body '${FULL}'`))).toBeUndefined()
    for (const command of [
      `cd /nonexistent; gh pr create --title t --body '${FULL}'`,
      `cd a && cd b && gh pr create --title t --body '${FULL}'`,
      `(cd /tmp); gh pr create --title t --body '${FULL}'`,
      `pushd /repo && gh pr edit 1 --body '${FULL}'`,
      `env -C /repo gh pr create --title t --body '${FULL}'`,
    ]) {
      const deny = await refusal($, b, bash(command))
      expect([command, deny]).toEqual([command, MOVED_TEMPLATE])
    }
    expect(MOVED_TEMPLATE).toContain("Run the gh call from the repository's own folder")
    expect(await refusal($, b, bash(`gh pr create --title t --body '${FULL}'; cd /tmp`))).toBeUndefined()
  })

  test('a change of directory is refused in a tree with no template too, because the guard no longer follows it', async ($, on) => {
    const b = await session($, on)
    b.repos['/other'] = {}
    place(b, '/other/.github/PULL_REQUEST_TEMPLATE.md')
    expect(await refusal($, b, bash(`gh pr create --title t --body '${FREE}'`))).toBeUndefined()
    expect(await refusal($, b, bash(`cd /other && gh pr create --title t --body '${FULL}'`))).toBe(MOVED_TEMPLATE)
  })

  test('AC3: repeated body flags are judged by the last body, which gh posts', async ($, on) => {
    const b = await session($, on)
    place(b, '/repo/.github/PULL_REQUEST_TEMPLATE.md')
    expect(await refusal($, b, bash(`gh pr create --title t --body '${FULL}' --body '${FREE}'`))).toContain('- ## Summary')
    expect(await refusal($, b, bash(`gh pr create --title t --body '${FREE}' --body '${FULL}'`))).toBeUndefined()
  })

  test('AC4: a CRLF template and a CRLF body are matched by heading', async ($, on) => {
    const b = await session($, on)
    const crlf = (text: string): string => text.replaceAll('\n', '\r\n')
    place(b, '/repo/.github/PULL_REQUEST_TEMPLATE.md', crlf(TEMPLATE))
    b.files.set('/repo/full.md', FULL)
    b.files.set('/repo/full-crlf.md', crlf(FULL))
    b.files.set('/repo/free-crlf.md', crlf(FREE))
    expect(await refusal($, b, bash('gh pr create --title t --body-file /repo/full.md'))).toBeUndefined()
    expect(await refusal($, b, bash('gh pr create --title t --body-file /repo/full-crlf.md'))).toBeUndefined()
    const deny = await refusal($, b, bash('gh pr create --title t --body-file /repo/free-crlf.md'))
    expect(deny).toContain('- ## Summary\n- ## Test plan\n')
    place(b, '/repo/.github/PULL_REQUEST_TEMPLATE.md')
    expect(await refusal($, b, bash('gh pr create --title t --body-file /repo/full-crlf.md'))).toBeUndefined()
    expect(await refusal($, b, bash('gh pr create --title t --body-file /repo/free-crlf.md'))).toContain('- ## Summary')
  })

  test('AC6: every body spelling is judged', async ($, on) => {
    const b = await session($, on)
    place(b, '/repo/.github/PULL_REQUEST_TEMPLATE.md')
    b.files.set('/repo/full.md', FULL)
    b.files.set('/repo/half.md', HALF)
    const cases: [string, boolean][] = [
      [`gh pr edit 1 -b'${HALF}'`, true],
      [`gh pr edit 1 -b'${FULL}'`, false],
      [`gh pr create --title t --body='${HALF}'`, true],
      [`gh pr create --title t --body='${FULL}'`, false],
      ['gh pr create --title t --body-file=/repo/half.md', true],
      ['gh pr create --title t --body-file=/repo/full.md', false],
      [`gh pr create --title t -F - <<'EOF'\n${HALF}\nEOF`, true],
      [`gh pr create --title t -F - <<'EOF'\n${FULL}\nEOF`, false],
    ]
    for (const [command, isRefused] of cases) {
      const deny = await refusal($, b, bash(command))
      expect([command, deny?.includes('- ## Test plan') ?? false]).toEqual([command, isRefused])
    }
  })

  test('AC6: a missing body file and a body file - with no standard input are refused unread', async ($, on) => {
    const b = await session($, on)
    place(b, '/repo/.github/PULL_REQUEST_TEMPLATE.md')
    expect(await refusal($, b, bash('gh pr create --title t --body-file /repo/none.md'))).toBe(UNREAD_BODY)
    expect(await refusal($, b, bash('gh pr create --title t --body-file -'))).toBe(UNREAD_BODY)
  })

  test('AC6: a template the guard cannot read is refused', async ($, on) => {
    const b = await session($, on)
    const path = '/repo/.github/PULL_REQUEST_TEMPLATE.md'
    b.dirs.add('/repo/.github')
    b.links.add(path)
    b.stat = p => (p === path ? { kind: 'file', isLink: true } : undefined)
    expect(await refusal($, b, bash(`gh pr create --title t --body '${FULL}'`))).toBe(UNPLACED_TEMPLATE)
    b.links.delete(path)
    b.stat = undefined
    expect(await refusal($, b, bash(`gh pr create --title t --body '${FULL}'`))).toBeUndefined()
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
