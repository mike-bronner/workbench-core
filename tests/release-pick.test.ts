import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { PromptOrigin } from 'claude-code'

import { AGENT_RELEASE_REFUSAL, EARLY_RELEASE_REFUSAL, LINES_BUNDLE_REFUSAL, NAMED_BUNDLE_REFUSAL, RELEASE_REFUSAL, askRefusalOf, releaseIdOf, releasesNamedOf } from '../hooks/mods/commit-approval'
import type { Bench } from './bench'
import { ASKS, HOME, PERSON, bench, start } from './bench'

const prompt = (text: string, origin: PromptOrigin = PERSON) => ({ text, wait: false, origin })

async function bash($: Engine, b: Bench, command: string, agentId?: string): Promise<string | undefined> {
  const before = b.calls.filter(call => call.tool === 'Bash').length
  const result = await $.tool.call({ tool: 'Bash', command, ...(agentId ? { agentId } : {}) } as never)
  expect([command, b.calls.filter(call => call.tool === 'Bash').length > before]).toEqual([command, result.deny === undefined])
  return result.deny
}

async function attended($: Engine, on: Parameters<typeof bench>[0], repo: Partial<Bench['repos'][string]> = {}, env: Record<string, string> = {}): Promise<Bench> {
  const b = bench(on, { env: { HOME, ...env } })
  b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'main', originHead: 'main', originUrl: 'git@github.com:mike-bronner/workbench-core.git', ...repo }
  b.trees['/repo'] = ''
  b.files.set('/tmp/notes-0.59.0.md', 'Unit commits need no question.\n')
  await $.session.start(start())
  await $.prompt.submit(prompt('look this over'))
  return b
}

async function ask($: Engine, b: Bench, question: string, label = 'Run it', labels: readonly string[] = ['Run it', 'Not now'], header = 'Approve'): Promise<string | undefined> {
  b.pick = label
  const call = { tool: 'AskUserQuestion', questions: [{ question, header, options: labels.map(each => ({ label: each, description: 'x' })), multiSelect: false }] }
  return (await $.tool.call(call as never)).deny
}

const permission = ($: Engine, command: string) =>
  $.classic
    .PermissionRequest({ hook_event_name: 'PermissionRequest', session_id: 's', transcript_path: '/t.jsonl', cwd: '/repo', tool_name: 'Bash', tool_input: { command } } as never)
    .then(result => (result as { decision?: unknown }).decision)

const SLUG_MAIN = 'Release 0.59.0 of mike-bronner/workbench-core, targeting main?'

const HEREDOC = [
  'gh release create 0.59.0 --target main --title "0.59.0: The orchestrator provisions its own unit worktrees" --notes-file - <<\'EOF\'',
  '## ✨ Features',
  '',
  '- **Unit commits need no question.** A plain `git -C <tree> commit` runs with no question.',
  '',
  '## ⚠️ Action needed',
  '',
  '- **Run `/reload-plugins`** after updating.',
  'EOF',
].join('\n')
const NOTES_FILE = 'gh release create 0.59.0 --target main --title "0.59.0: The orchestrator provisions its own unit worktrees" --notes-file /tmp/notes-0.59.0.md'
const ASKED = (line: string) => `Run this release (gh release create) in /Users/mike/Developer/workbench-core on branch main?\n\n\`${line}\``

describe('AC1: the three refused picks of 2026-11-10, replayed', () => {
  test('the heredoc release, asked about as the orchestrator asked, and then rerun from a notes file, runs once', async ($, on) => {
    const b = await attended($, on)
    b.cwd = '/Users/mike/Developer/workbench-core'
    b.repos['/Users/mike/Developer/workbench-core'] = b.repos['/repo'] ?? {}
    expect(await bash($, b, HEREDOC)).toMatch(ASKS.release)
    expect(await ask($, b, ASKED(HEREDOC))).toBeUndefined()
    expect(await bash($, b, NOTES_FILE)).toBeUndefined()
    expect(await bash($, b, NOTES_FILE)).toMatch(ASKS.release)
  })
})

describe('AC2: a "Run it" pick on a question that names the tag and the repository approves that release once', () => {
  test('the deny names the tag, the repository and the target, and no line to copy', async ($, on) => {
    const b = await attended($, on)
    const deny = await bash($, b, HEREDOC)
    expect(deny).toContain('say that it is a release, name its tag 0.59.0 and its repository mike-bronner/workbench-core, and say that it targets main.')
    expect(deny).toContain('whatever its title, notes, flags or quoting')
    expect(deny).not.toContain('Features')
  })

  for (const [name, question] of [
    ['the repository slug', 'Publish release 0.59.0 of mike-bronner/workbench-core, targeting main?'],
    ['the local checkout', 'Publish release 0.59.0 from /repo on main to GitHub?'],
    ['the GitHub URL', 'Publish release `0.59.0` to https://github.com/mike-bronner/workbench-core from `main`?'],
    ['the slug in another case', 'Publish RELEASE 0.59.0 of Mike-Bronner/Workbench-Core on main?'],
  ] as const) {
    test(`a question naming ${name} approves a rerun with other notes, another title and other quoting`, async ($, on) => {
      const b = await attended($, on)
      expect(await bash($, b, NOTES_FILE)).toMatch(ASKS.release)
      expect(await ask($, b, question)).toBeUndefined()
      expect(await bash($, b, "gh release create 0.59.0 --target=main -t 'Other title' --notes \"Other \\`notes\\`\"")).toBeUndefined()
    })
  }

  test('a release with no target, and one naming its repository with -R or GH_REPO, are approved by their own identity', async ($, on) => {
    const b = await attended($, on)
    for (const [line, rerun, question] of [
      ['gh release create v2.0.0 --notes x', 'gh release create v2.0.0 --generate-notes --latest', 'Release v2.0.0 of mike-bronner/workbench-core to the default branch?'],
      ['gh release create 1.0.0 -R x/y --notes n', 'gh release create 1.0.0 --repo=x/y -n other', 'Release 1.0.0 of x/y to its default branch?'],
      ['GH_REPO=x/y gh release create 3.0.0 --notes n', 'gh release create 3.0.0 -Rx/y -d', 'Release 3.0.0 of x/y to the default branch?'],
    ] as const) {
      expect([line, await bash($, b, line)]).toEqual([line, expect.stringMatching(ASKS.release)])
      expect(await ask($, b, question)).toBeUndefined()
      expect([rerun, await bash($, b, rerun)]).toEqual([rerun, undefined])
    }
  })
})

describe('AC3: the pick approves no other tag, no other repository, no other target, and no second run', () => {
  test('another tag, another repository and another target are refused, and the second run is refused', async ($, on) => {
    const b = await attended($, on)
    expect(await bash($, b, NOTES_FILE)).toMatch(ASKS.release)
    expect(await ask($, b, SLUG_MAIN)).toBeUndefined()
    expect(await bash($, b, 'gh release create 0.59.1 --target main --notes x')).toMatch(ASKS.release)
    expect(await bash($, b, 'gh release create 0.59.0 --target main -R other/workbench-core --notes x')).toMatch(ASKS.release)
    expect(await bash($, b, 'gh release create 0.59.0 --target feat --notes x')).toMatch(ASKS.release)
    expect(await bash($, b, 'gh release create 0.59.0 --notes x')).toMatch(ASKS.release)
    expect(await bash($, b, NOTES_FILE)).toBeUndefined()
    expect(await bash($, b, NOTES_FILE)).toMatch(ASKS.release)
  })

  for (const [name, question] of [
    ['the tag of another release', 'Release 0.59.1 of mike-bronner/workbench-core, targeting main?'],
    ['the tag inside a longer one', 'Release 10.59.0 or 0.59.0.1 of mike-bronner/workbench-core, targeting main?'],
    ['another repository', 'Release 0.59.0 of other/workbench-core, targeting main?'],
    ['the repository name alone', 'Release 0.59.0 of workbench-core, targeting main?'],
    ['no repository', 'Release 0.59.0, targeting main?'],
    ['no target', 'Release 0.59.0 of mike-bronner/workbench-core?'],
    ['another target', 'Release 0.59.0 of mike-bronner/workbench-core, targeting maintenance or feat/main-x?'],
    ['the default branch for a set target', 'Release 0.59.0 of mike-bronner/workbench-core to the default branch?'],
    ['no release', 'Delete tag 0.59.0 in mike-bronner/workbench-core on main first?'],
  ] as const) {
    test(`a question naming ${name} approves nothing`, async ($, on) => {
      const b = await attended($, on)
      expect(await bash($, b, NOTES_FILE)).toMatch(ASKS.release)
      expect(await ask($, b, question)).toBeUndefined()
      expect(await bash($, b, NOTES_FILE)).toMatch(ASKS.release)
    })
  }

  test('a "Not now" pick and a pick his next prompt ended approve nothing', async ($, on) => {
    const b = await attended($, on)
    const question = SLUG_MAIN
    expect(await bash($, b, NOTES_FILE)).toMatch(ASKS.release)
    expect(await ask($, b, question, 'Not now')).toBeUndefined()
    expect(await bash($, b, NOTES_FILE)).toMatch(ASKS.release)
    expect(await ask($, b, question)).toBeUndefined()
    await $.prompt.submit(prompt('wait'))
    expect(await bash($, b, NOTES_FILE)).toMatch(ASKS.release)
  })

  test('a question naming two waiting releases is refused, and one naming one of them approves only it', async ($, on) => {
    const b = await attended($, on)
    await bash($, b, 'gh release create 1.0.0 --notes x')
    await bash($, b, 'gh release create 1.0.1 --notes x')
    expect(await ask($, b, 'Release 1.0.0 and 1.0.1 of mike-bronner/workbench-core to the default branch?')).toBe(LINES_BUNDLE_REFUSAL)
    expect(await ask($, b, 'Release 1.0.1 of mike-bronner/workbench-core to the default branch?')).toBeUndefined()
    expect(await bash($, b, 'gh release create 1.0.0 --notes x')).toMatch(ASKS.release)
    expect(await bash($, b, 'gh release create 1.0.1 --notes y')).toBeUndefined()
  })

  test('gh pointed at another repository by GH_REPO in the environment keys the release to that repository', async ($, on) => {
    const b = await attended($, on, {}, { GH_REPO: 'x/y' })
    const deny = await bash($, b, 'gh release create 1.0.0 --notes x')
    expect(deny).toContain('its repository x/y,')
    expect(await ask($, b, 'Release 1.0.0 of mike-bronner/workbench-core from /repo to the default branch?')).toBeUndefined()
    expect(await bash($, b, 'gh release create 1.0.0 --notes x')).toMatch(ASKS.release)
  })

  test('gh repo set-default on another remote leaves the identity unread, so a question naming tag and repository approves nothing', async ($, on) => {
    const b = await attended($, on, { ghResolved: 'remote.upstream.gh-resolved base' })
    const deny = await bash($, b, 'gh release create 1.0.0 --notes x')
    expect(deny).toContain('name the exact line `gh release create 1.0.0 --notes x`')
    expect(await ask($, b, 'Release 1.0.0 of mike-bronner/workbench-core from /repo to the default branch?')).toBeUndefined()
    expect(await bash($, b, 'gh release create 1.0.0 --notes x')).toMatch(ASKS.release)
  })

  for (const [name, repo] of [
    ['an upstream remote beside origin, with no gh default', { remoteUrls: 'remote.origin.url git@github.com:mike-bronner/workbench-core.git\nremote.upstream.url https://github.com/up/workbench-core.git' }],
    ['a GitHub remote other than origin alone', { remoteUrls: 'remote.fork.url git@github.com:mike-bronner/workbench-core.git' }],
    ['a failed read of the remotes, even with a gh default on origin', { remoteUrls: null, ghResolved: 'remote.origin.gh-resolved base' }],
    ['a failed read of the gh default', { ghResolved: null }],
    ['an upstream written through an insteadOf alias that resolves to GitHub', { remoteUrls: 'remote.origin.url git@github.com:mike-bronner/workbench-core.git\nremote.upstream.url gl:x.git', remotesShown: 'origin\tgit@github.com:mike-bronner/workbench-core.git (fetch)\nupstream\tgit@github.com:GeneaLabs/x.git (fetch)\n' }],
  ] as const) {
    test(`${name} leaves the identity unread, so the deny asks for the exact line and a question naming tag and repository approves nothing`, async ($, on) => {
      const b = await attended($, on, repo)
      expect(await bash($, b, 'gh release create 1.0.0 --notes x')).toContain('name the exact line `gh release create 1.0.0 --notes x`')
      expect(await ask($, b, 'Release 1.0.0 of mike-bronner/workbench-core from /repo to the default branch?')).toBeUndefined()
      expect(await bash($, b, 'gh release create 1.0.0 --notes x')).toMatch(ASKS.release)
    })
  }

  for (const [name, repo] of [
    ['origin with a gh default on it, beside an upstream', { ghResolved: 'remote.origin.gh-resolved base', remoteUrls: 'remote.origin.url git@github.com:mike-bronner/workbench-core.git\nremote.upstream.url https://github.com/up/workbench-core.git' }],
    ['origin beside a remote that is not on GitHub', { remoteUrls: 'remote.origin.url git@github.com:mike-bronner/workbench-core.git\nremote.backup.url /srv/git/workbench-core.git' }],
    ['an origin written through an insteadOf alias', { originUrl: 'mb:workbench-core.git', remoteUrls: 'remote.origin.url mb:workbench-core.git', remotesShown: 'origin\tgit@github.com:mike-bronner/workbench-core.git (fetch)\norigin\tgit@github.com:mike-bronner/workbench-core.git (push)\n' }],
  ] as const) {
    test(`${name} keys the release on origin`, async ($, on) => {
      const b = await attended($, on, repo)
      expect(await bash($, b, 'gh release create 1.0.0 --notes x')).toContain('its tag 1.0.0 and its repository mike-bronner/workbench-core,')
      expect(await ask($, b, 'Release 1.0.0 of mike-bronner/workbench-core to the default branch?')).toBeUndefined()
      expect(await bash($, b, 'gh release create 1.0.0 --notes y')).toBeUndefined()
    })
  }

  test('a release line the identity reader cannot read whole still asks for its exact line', async ($, on) => {
    const b = await attended($, on)
    for (const line of ['gh release create "$TAG" --notes x', 'gh release create 1.0.0 -dp --notes x', 'gh release create 1.0.0 --unknown x', 'cd /x && gh release create 1.0.0']) {
      expect([line, await bash($, b, line)]).toEqual([line, expect.stringContaining('name the exact line')])
    }
  })
})

describe('AC9: a release question asked before the gate refused a release is refused, with advice to run the line first', () => {
  test('the early question is refused, its pick is never spent, and the same question after the deny approves', async ($, on) => {
    const b = await attended($, on)
    expect(await ask($, b, SLUG_MAIN)).toBe(EARLY_RELEASE_REFUSAL)
    expect(EARLY_RELEASE_REFUSAL).toContain('Run the gh release create line first.')
    expect(await bash($, b, NOTES_FILE)).toMatch(ASKS.release)
    expect(await ask($, b, SLUG_MAIN)).toBeUndefined()
    expect(await bash($, b, NOTES_FILE)).toBeUndefined()
  })

  test('his next prompt clears what waits, so a release question after it is early again', async ($, on) => {
    const b = await attended($, on)
    expect(await bash($, b, NOTES_FILE)).toMatch(ASKS.release)
    await $.prompt.submit(prompt('wait'))
    expect(await ask($, b, SLUG_MAIN)).toBe(EARLY_RELEASE_REFUSAL)
  })

  test('a release line waiting on its exact line counts as waiting', async ($, on) => {
    const b = await attended($, on)
    const line = 'gh release create "$TAG" --notes x'
    expect(await bash($, b, line)).toContain('name the exact line')
    expect(await ask($, b, `Run the release \`${line}\`?`)).toBeUndefined()
    expect(await bash($, b, line)).toBeUndefined()
  })

  for (const [name, question, label] of [
    ['a release line quoted as written', 'Run the release `gh release create 1.0.0` in o/r?', 'Run it'],
    ['a release with a release label', 'Release 0.59.0 of mike-bronner/workbench-core, targeting main?', 'Yes, release it'],
  ] as const) {
    test(`an early question about ${name} is still refused`, async ($, on) => {
      const b = await attended($, on)
      expect(await ask($, b, question, label, [label, 'Not now'])).toBe(EARLY_RELEASE_REFUSAL)
    })
  }

  test('a pending alias line with "release" in it is let through and its pick runs the alias', async ($, on) => {
    const b = await attended($, on, { originUrl: 'git@github.com:o/r.git' })
    const line = "gh alias set rc 'release create'"
    expect(await bash($, b, line)).toMatch(ASKS.alias)
    expect(await ask($, b, `Run \`${line}\` in /repo, on main?`)).toBeUndefined()
    expect(await bash($, b, line)).toBeUndefined()
  })

  test('a pending cherry-pick question naming a release branch is let through and its pick runs the cherry-pick', async ($, on) => {
    const b = await attended($, on)
    expect(await bash($, b, 'git cherry-pick abc1234')).toMatch(ASKS.rewrite)
    expect(await ask($, b, 'Run `git cherry-pick abc1234` in /repo, on main, to carry the fix from release/1.x?')).toBeUndefined()
    expect(await bash($, b, 'git cherry-pick abc1234')).toBeUndefined()
  })

  test('a push question about the release commit is let through and its pick runs the push', async ($, on) => {
    const b = await attended($, on)
    b.repos['/repo'] = { ...b.repos['/repo'], head: 'c2', pushed: 'c1' }
    expect(await bash($, b, 'git push')).toMatch(ASKS.push)
    expect(await ask($, b, 'Push the release commit to origin/main?', 'Yes, push it', ['Yes, push it', 'Not yet'])).toBeUndefined()
    expect(await bash($, b, 'git push')).toBeUndefined()
  })

  test('a commit question about the release notes is let through and its pick runs the commit', async ($, on) => {
    const b = await attended($, on)
    b.trees['/repo'] = 'A  notes.md\0'
    const line = 'git commit -m "docs: 📝 Add the release notes."'
    expect(await bash($, b, line)).toMatch(ASKS.commit)
    expect(await ask($, b, 'Commit the release notes?', 'Yes, commit', ['Yes, commit', 'Not yet'])).toBe(NAMED_BUNDLE_REFUSAL)
    expect(await ask($, b, 'Commit "docs: 📝 Add the release notes." with notes.md on main?', 'Yes, commit', ['Yes, commit', 'Not yet'])).toBeUndefined()
    expect(await bash($, b, line)).toBeUndefined()
  })

  for (const [name, question, labels] of [
    ['a release question with no option that reads as approval', 'Which notes should release 0.59.0 carry?', ['Short notes', 'Long notes']],
    ['an approval question that names no release', 'Run the cleanup in mike-bronner/workbench-core?', ['Run it', 'Not now']],
  ] as const) {
    test(`${name} is not refused`, async ($, on) => {
      const b = await attended($, on)
      expect(await ask($, b, question, labels[0], labels)).toBeUndefined()
    })
  }
})

describe('finding 5: the permission prompt is answered for the picked release only, while it can still run', () => {
  test('the same identity is allowed, and another tag, repository or target, and the line after its run, get no decision', async ($, on) => {
    const b = await attended($, on)
    expect(await bash($, b, NOTES_FILE)).toMatch(ASKS.release)
    expect(await permission($, NOTES_FILE)).toBeUndefined()
    expect(await ask($, b, SLUG_MAIN)).toBeUndefined()
    expect(await permission($, 'gh release create 0.59.0 --target main --notes other')).toEqual({ behavior: 'allow' })
    for (const other of ['gh release create 0.59.1 --target main', 'gh release create 0.59.0 --target main -R x/y', 'gh release create 0.59.0 --target feat']) {
      expect([other, await permission($, other)]).toEqual([other, undefined])
    }
    expect(await bash($, b, NOTES_FILE)).toBeUndefined()
    expect(await permission($, NOTES_FILE)).toBeUndefined()
  })
})

describe('the release identity reader', () => {
  test('reads the tag, the target and the repository, and nothing from the title or notes', () => {
    expect(releaseIdOf(HEREDOC, 'o/r')).toEqual({ repo: 'o/r', tag: '0.59.0', target: 'main' })
    expect(releaseIdOf('gh release create --title t 1.0.0', 'o/r')).toEqual({ repo: 'o/r', tag: '1.0.0', target: '' })
    expect(releaseIdOf('gh release create 1.0.0 -R https://github.com/X/Y.git', 'o/r')).toEqual({ repo: 'x/y', tag: '1.0.0', target: '' })
    expect(releaseIdOf('gh release create 1.0.0 --draft --prerelease --latest=false --generate-notes --verify-tag', 'o/r')).toEqual({ repo: 'o/r', tag: '1.0.0', target: '' })
  })

  test('notes or a title from a cat heredoc in a substitution keep the identity, and any other nested command loses it', () => {
    const notes = (body: string, quote = "'EOF'") => `gh release create 1.0.0 --target main --title "1.0.0: x?" --notes "$(cat <<${quote}\n${body}\nEOF\n)"`
    expect(releaseIdOf(notes('## Features\n\n- `x` and $y'), 'o/r')).toEqual({ repo: 'o/r', tag: '1.0.0', target: 'main' })
    expect(releaseIdOf('gh release create 1.0.0 -t "$(cat <<\'EOF\'\nT\nEOF\n)"', 'o/r')).toEqual({ repo: 'o/r', tag: '1.0.0', target: '' })
    for (const line of [
      notes('$(rm -rf x)', 'EOF'),
      'gh release create 1.0.0 --notes "$(rm -rf x)"',
      'gh release create 1.0.0 --notes "$(cat n.md)"',
      'gh release create 1.0.0 --notes-file "$(cat <<\'EOF\'\n/tmp/n\nEOF\n)"',
      'gh release create 1.0.0 --notes=$(cat <<\'EOF\'\nx\nEOF\n)',
    ]) {
      expect([line, releaseIdOf(line, 'o/r')]).toEqual([line, undefined])
    }
  })

  test('reads nothing it cannot be sure of', () => {
    for (const line of [
      'gh release create 1.0.0',
      'gh release create 1.0.0 a.zip --notes x',
      'gh release create 1.0.0 -R x/y --repo z/w',
      'gh release create 1.0.0 --target "$B"',
      'gh release create 1.0.0 -dp',
      'GH_TOKEN=t gh release create 1.0.0',
      'gh release create -- 1.0.0',
      'gh release create',
      'command gh release create 1.0.0',
      'gh release create 1.0.0; gh release create 1.0.1',
      'gh release edit 1.0.0',
      'gh release create 1.0.0 --target',
      'gh release create 1.0.0 --repo "$R"',
      'GH_REPO=$X gh release create 1.0.0',
      'gh release create 1.0.0 -R notaslug',
    ]) {
      expect([line, releaseIdOf(line, line === 'gh release create 1.0.0' ? undefined : 'o/r')]).toEqual([line, undefined])
    }
  })

  test('a question names a release only by the word release, a whole tag, a whole repository name and its target', () => {
    const pending = [{ repo: 'o/r', tag: '1.0.0', target: '', names: ['o/r', '/repo'] }]
    expect(releasesNamedOf({ question: 'Release `1.0.0` of o/r to the default branch.' }, pending)).toHaveLength(1)
    expect(releasesNamedOf({ question: 'Run `gh release create 1.0.0` from /repo on the default branch?' }, pending)).toHaveLength(1)
    for (const question of [
      'Release v1.0.0 of o/r to the default branch?',
      'Release 1.0.0-rc of o/r to the default branch?',
      'Release 1.0.0 of o/r2 to the default branch?',
      'Release 1.0.0 of xo/r to the default branch?',
      'Release 1.0.0 from /repo/sub to the default branch?',
      'Release 1.0.0 of o/r.git to the default branch?',
      'Release 1.0.0 of o/r on main?',
      'Releases 1.0.0 of o/r to the default branch?',
      'Publish 1.0.0 of o/r to the default branch?',
    ]) {
      expect([question, releasesNamedOf({ question }, pending)]).toEqual([question, []])
    }
  })

  test('the deny says "the default branch" for a release with no target', () => {
    expect(askRefusalOf(['release'], { command: 'x', release: { repo: 'o/r', tag: '1.0.0', target: '' } })).toContain('say that it targets the default branch.')
  })
})

type Lane = { name: string; env: Record<string, string>; isInteractive: boolean; agentId?: string; origin: PromptOrigin }
const AGENT_LANES: readonly Lane[] = [
  { name: 'a sub-agent', env: {}, isInteractive: true, agentId: 'a1', origin: PERSON },
  { name: 'a -p run', env: {}, isInteractive: false, origin: { kind: 'sdk' } },
  { name: 'the pipeline', env: { WORKBENCH_DEV_TEAM_PIPELINE: '1', CLAUDE_CODE_AGENT: 'watson' }, isInteractive: false, origin: { kind: 'sdk' } },
]

describe('AC4: an unapproved release is refused, and no lane that cannot ask releases in any spelling', () => {
  test('a release no request or pick approved is denied with the instruction to ask', async ($, on) => {
    const b = await attended($, on)
    expect(await bash($, b, NOTES_FILE)).toMatch(ASKS.release)
    expect(await bash($, b, 'gh release create 0.59.0 -R x/y')).toMatch(ASKS.release)
  })

  test('a sub-agent is refused a release that Mike picked for the main session, and the main session still runs it', async ($, on) => {
    const b = await attended($, on)
    expect(await bash($, b, NOTES_FILE)).toMatch(ASKS.release)
    expect(await ask($, b, SLUG_MAIN)).toBeUndefined()
    expect(await bash($, b, NOTES_FILE, 'a1')).toBe(AGENT_RELEASE_REFUSAL)
    expect(await bash($, b, NOTES_FILE)).toBeUndefined()
  })

  for (const lane of AGENT_LANES) {
    test(`${lane.name}: every spelling of a release is refused`, async ($, on) => {
      const b = bench(on, { env: { HOME, ...lane.env } })
      b.repos['/repo'] = { head: 'c1', pushed: 'c1', branch: 'main', originHead: 'main', originUrl: 'git@github.com:mike-bronner/workbench-core.git' }
      b.files.set('/tmp/notes-0.59.0.md', 'Unit commits need no question.\n')
      await $.session.start(start(lane.isInteractive))
      await $.prompt.submit(prompt('look this over', lane.origin))
      for (const line of [NOTES_FILE, HEREDOC, 'gh release create 0.59.0 -R x/y', 'GH_REPO=x/y gh release create 0.59.0', 'command gh release create 0.59.0', 'gh api -X POST repos/o/r/releases -f tag_name=0.59.0']) {
        const deny = await bash($, b, line, lane.agentId)
        expect([line, deny === AGENT_RELEASE_REFUSAL || deny === RELEASE_REFUSAL ? 'refused' : deny]).toEqual([line, 'refused'])
      }
    })
  }
})

describe('AC5: a "Run it" pick on a rewrite, an alias set or an API write keys on its own whole line', () => {
  for (const [name, line, other, asks] of [
    ['a rewrite', 'git cherry-pick abc1234', 'git cherry-pick abc1235', ASKS.rewrite],
    ['a gh alias set', "gh alias set co 'pr checkout'", "gh alias set co 'pr close'", ASKS.alias],
    ['an API write', 'gh api -X PUT repos/o/r/contents/f -f branch=main -f message=x', 'gh api -X PUT repos/o/r/contents/f -f branch=main -f message=y', ASKS.api],
    ['an API write with backticks and a newline', "gh api -X PUT repos/o/r/contents/f -f branch=main -f message='fix: `x`\nbody'", "gh api -X PUT repos/o/r/contents/f -f branch=main -f message='fix: `y`\nbody'", ASKS.api],
    ['an alias set with a backslash', "gh alias set co 'pr checkout \\\\ x'", "gh alias set co 'pr close'", ASKS.alias],
  ] as const) {
    test(`${name}: a pick on a question quoting the line as written runs that line once, and no other line`, async ($, on) => {
      const b = await attended($, on, { originUrl: 'git@github.com:o/r.git' })
      expect(await bash($, b, line)).toMatch(asks)
      expect(await ask($, b, `Run \`${line}\` in /repo, on main?`)).toBeUndefined()
      expect(await bash($, b, other)).toMatch(asks)
      expect(await bash($, b, line)).toBeUndefined()
      expect(await bash($, b, line)).toMatch(asks)
    })
  }
})
