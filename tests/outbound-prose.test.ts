// The outbound prose guard in the hooks module (hooks/mods/outbound-prose.ts,
// judged in hooks/register.ts's tool.call hook). It reads a gh body by every
// route the bash guard read, and a board-MCP call's arguments, and refuses a
// body that breaks a mechanical rule of the Clear standard. Each refusal says
// how to fix the prose. A body it cannot read is refused with how to pass it.

import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { GUARDED } from '../hooks/mods/guards'
import { EXPANDED_BODY, MOVED_BODY, UNREAD_BODY, bashBodies, isProseTool, proseFindings } from '../hooks/mods/outbound-prose'
import { parseShell } from '../hooks/mods/shell'
import type { Bench } from './bench'
import { bench, start } from './bench'

const HOME = '/Users/tester'
const VAULT = `${HOME}/Documents/Claude/Memory`
const CLEAN = 'Fixed the list loader.\n\nThe form now reads stored values on edit. Saving keeps them.'
const DASH = 'Fixed the loader — it reads stored values now.'
const SEMI = 'Fixed the loader; it reads stored values now.'
const POINTER = 'The plan is in ~/.claude/plans/loader.md for details.'

type Call = Record<string, unknown> & { tool: string }

async function session($: Engine, on: Parameters<typeof bench>[0]): Promise<Bench> {
  const b = bench(on, { env: { HOME } })
  b.scripts['vault-resolve.sh'] = () => `root\t${VAULT}\n`
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

describe('the outbound prose checks', () => {
  test('each rule names its fix', () => {
    expect(proseFindings(CLEAN)).toEqual([])
    expect(proseFindings(DASH).join()).toContain('Use a colon, a parenthesis, or a full stop.')
    expect(proseFindings(SEMI).join()).toContain('A semicolon means you have two sentences. Split it.')
    expect(proseFindings(POINTER).join()).toContain('Restate the substance in the body itself.')
  })

  test('code, checklists, comments, URLs and write commands pass', () => {
    expect(proseFindings('Run `a; b` here.\n- [ ] Tests — pass\n<!-- x; y -->\n```\nz — w\n```')).toEqual([])
    expect(proseFindings('See https://github.com/o/r/blob/main/.claude/plans/x.md now.')).toEqual([])
    expect(proseFindings('Run `mktemp -d ~/Developer/scratchpad/x.XXXXXX` first.')).toEqual([])
    expect(proseFindings('Run `tail /private/tmp/claude-501/x/tasks/a.output` first.')).not.toEqual([])
    expect(proseFindings('The vault hooks/mods/vault-git.ts refuses git writes.')).toEqual([])
    expect(proseFindings('See vault note decisions/x.md for it.')).not.toEqual([])
    expect(proseFindings('See vault note custom/x.md for it.', { folders: new Set(['custom']) })).not.toEqual([])
  })

  test('a configured vault root counts as well as the default', () => {
    expect(proseFindings('See /Volumes/V/notes/x.md here.', { root: '/Volumes/V', home: HOME })).not.toEqual([])
    expect(proseFindings('See /Volumes/V/notes/x.md here.', { home: HOME })).toEqual([])
  })
})

describe('the outbound prose guard', () => {
  test('an ordinary body passes by every route', async ($, on) => {
    const b = await session($, on)
    b.files.set('/repo/body.md', CLEAN)
    for (const command of [
      `gh pr create --title t --body '${CLEAN}'`,
      `gh issue comment 3 -b '${CLEAN}'`,
      'gh pr edit 1 --body-file body.md',
      `gh pr comment 1 --body-file - <<'EOF'\n${CLEAN}\nEOF`,
      `gh pr comment 1 -F - <<< '${CLEAN}'`,
      `gh api repos/o/r/issues/1/comments -f body='${CLEAN}'`,
      'gh pr view 1',
      'gh api repos/o/r/pulls -X GET -f body=a;b',
      'git status',
    ]) {
      expect(await refusal($, b, bash(command))).toBeUndefined()
    }
    expect(await refusal($, b, { tool: 'mcp__the-index__add_comment', id: 3, body: CLEAN })).toBeUndefined()
  })

  test('a broken body is refused by every route, with its fix', async ($, on) => {
    const b = await session($, on)
    b.files.set('/repo/body.md', DASH)
    b.files.set('/repo/body.json', JSON.stringify({ comments: [{ body: SEMI }] }))
    const cases: [string, string][] = [
      [`gh pr create --title t --body '${DASH}'`, 'Use a colon'],
      [`gh release create v1 --notes '${SEMI}'`, 'Split it.'],
      ['gh pr edit 1 --body-file body.md', 'Use a colon'],
      [`gh pr comment 1 --body-file - <<'EOF'\n${POINTER}\nEOF`, 'Restate the substance'],
      [`gh issue create -t x -F - <<< '${SEMI}'`, 'Split it.'],
      [`gh api repos/o/r/issues/1/comments -f body='${DASH}'`, 'Use a colon'],
      ['gh api repos/o/r/issues/1/comments -F body=@body.md', 'Use a colon'],
      [`gh api repos/o/r/issues/1/comments -F body=@- <<'EOF'\n${SEMI}\nEOF`, 'Split it.'],
      ['gh api repos/o/r/pulls/1/reviews --input body.json', 'Split it.'],
      [`gh api graphql -f query='mutation { addComment(input: {body: "${SEMI}"}) { clientMutationId } }'`, 'Split it.'],
      [`cd /repo && gh pr comment 1 --body '${DASH}'`, 'Use a colon'],
    ]
    for (const [command, fix] of cases) {
      const deny = await refusal($, b, bash(command))
      expect([command, deny?.includes(fix)]).toEqual([command, true])
      expect(deny).toContain('Rewrite the body, then send it again.')
    }
  })

  test('a graphql query from a file or standard input is read before the mutation test', async ($, on) => {
    const b = await session($, on)
    const mutation = `mutation { addComment(input: {body: "${SEMI}"}) { clientMutationId } }`
    b.files.set('/repo/m.graphql', mutation)
    b.files.set('/repo/q.graphql', `query { viewer { login } } # ${SEMI}`)
    expect(await refusal($, b, bash('gh api graphql -F query=@m.graphql'))).toContain('Split it.')
    expect(await refusal($, b, bash(`gh api graphql -F query=@- <<'EOF'\n${mutation}\nEOF`))).toContain('Split it.')
    expect(await refusal($, b, bash('gh api graphql -F query=@q.graphql'))).toBeUndefined()
    expect(await refusal($, b, bash(`gh api graphql -F query=@- <<'EOF'\nquery { a } # ${SEMI}\nEOF`))).toBeUndefined()
  })

  test('a body the shell expands is refused, with how to write it out', async ($, on) => {
    const b = await session($, on)
    for (const command of [
      'gh pr comment 1 -b "$MSG"',
      'gh pr comment 1 --body "x $X"',
      'gh pr comment 1 --body "x ${X}"',
      'gh pr comment 1 --body $X',
      `gh api repos/o/r/issues/1/comments -f body="$X"`,
      'gh api repos/o/r/issues/1/comments -F body=@"$F"',
      'gh pr comment 1 --body-file "$F"',
      'gh pr comment 1 --body-file - <<< "Run `date` now."',
      'gh pr comment 1 --body-file=$F',
      'gh pr comment 1 --body-file - <<EOF\nFixed $X now.\nEOF',
      'gh pr comment 1 --body-file - <<EOF\nFixed `date` now.\nEOF',
      'gh api repos/o/r/issues/1/comments -F body=@- <<EOF\nFixed $X now.\nEOF',
      // An escaped space or semicolon does not start a comment: `#$X` is
      // part of the body word.
      'gh pr comment 1 --body x\\ #$X',
      'gh pr comment 1 --body x\\;#$X',
      // ANSI-C quoting ends where the parse ends it, so "$X" is not hidden.
      `gh pr comment 1 --body $'don\\'t'"$X"\\'`,
      'gh pr comment 1 --body-file - <<< "$BODY"',
      `gh pr comment 1 --body-file - <<< '${CLEAN}'\ngh pr comment 2 --body "$X"`,
      `# it's done\ngh pr comment 1 --body "$X"`,
      `gh pr comment 1 --body-file - <<\\EOF\n${CLEAN}\nEOF\ngh pr comment 2 --body "$X"`,
    ]) {
      expect([command, await refusal($, b, bash(command))]).toEqual([command, EXPANDED_BODY])
    }
    for (const command of [
      "gh pr comment 1 --body-file - <<'EOF'\nFixed $X now.\nEOF",
      'gh pr comment 1 --body-file - <<\\EOF\nFixed $X and `date` now.\nEOF',
      `gh pr comment 1 --body-file - <<EOF\n${CLEAN}\nEOF`,
      `# say "hi\ngh pr comment 1 --body '${CLEAN}'`,
      // A live backtick in a word is the parse's substitution mark, so one
      // left in the word is literal: a code span in single quotes.
      "gh pr comment 1 --body 'Run `make test` first.'",
    ]) {
      expect([command, await refusal($, b, bash(command))]).toEqual([command, undefined])
    }
    expect(EXPANDED_BODY).toContain("--body-file - <<'EOF'")
  })

  test('a literal $ on the command line is refused, as the parse drops its quote marks', async ($, on) => {
    // The parse gives the word `It costs $5.` for both '...' and "...", so the
    // guard cannot tell a literal $ from an expansion. This over-refusal is
    // accepted: the hint sends a literal $ to a quoted heredoc or a file.
    const b = await session($, on)
    for (const command of ["gh pr comment 1 --body 'It costs $5.'", 'gh pr comment 1 --body "It costs \\$5."']) {
      expect([command, await refusal($, b, bash(command))]).toEqual([command, EXPANDED_BODY])
    }
    expect(EXPANDED_BODY).toContain('a $ in single quotes on the command line is refused too')
  })

  test('a relative body file after a change of directory is refused', async ($, on) => {
    const b = await session($, on)
    b.files.set('/repo/body.md', CLEAN)
    b.files.set('/abs/body.md', CLEAN)
    expect(await refusal($, b, bash('gh issue comment 1 -F body.md'))).toBeUndefined()
    expect(await refusal($, b, bash('cd /other && gh issue comment 1 -F body.md'))).toBe(MOVED_BODY)
    expect(await refusal($, b, bash('pushd /other; gh api repos/o/r/issues/1/comments -F body=@body.md'))).toBe(MOVED_BODY)
    expect(await refusal($, b, bash('cd /other && gh issue comment 1 -F /abs/body.md'))).toBeUndefined()
  })

  test('every body flag route is read', async ($, on) => {
    const b = await session($, on)
    b.files.set('/repo/body.md', DASH)
    b.files.set('/repo/clean.md', CLEAN)
    b.files.set('/abs/file.md', CLEAN)
    const cases: [string, string][] = [
      ["gh issue comment 1 -b'a; b'", 'Split it.'],
      ['gh issue comment 1 -Fbody.md', 'Use a colon'],
      ['gh release create v1 --notes-file body.md', 'Use a colon'],
      [`gh release create v1 -n '${SEMI}'`, 'Split it.'],
      [`gh release create v1 -n'${SEMI}'`, 'Split it.'],
      [`gh release edit v1 -m '${SEMI}'`, 'Split it.'],
      [`gh release edit v1 --message '${DASH}'`, 'Use a colon'],
      [`gh pr comment 1 --body='${SEMI}'`, 'Split it.'],
      ['gh pr comment 1 --body-file=body.md', 'Use a colon'],
      [`gh api repos/o/r/issues/1/comments -fbody='${SEMI}'`, 'Split it.'],
      [`gh api repos/o/r/issues/1/comments --raw-field body='${SEMI}'`, 'Split it.'],
      ['gh api repos/o/r/issues/1/comments --field body=@body.md', 'Use a colon'],
    ]
    for (const [command, fix] of cases) {
      const deny = await refusal($, b, bash(command))
      expect([command, deny?.includes(fix)]).toEqual([command, true])
    }
    expect(await refusal($, b, bash('gh pr comment 1 --body-file /abs/file.md'))).toBeUndefined()
    expect(await refusal($, b, bash('gh issue comment 1 -Fclean.md'))).toBeUndefined()
    expect(await refusal($, b, bash("echo 'run gh pr comment'"))).toBeUndefined()
  })

  test('each board-MCP prose tool is read, and identifiers are not', async ($, on) => {
    const b = await session($, on)
    for (const tool of ['mcp__the-index__add_comment', 'mcp__x__submit_review', 'mcp__x__create_issue', 'mcp__x__set_acceptance_criteria']) {
      expect(await refusal($, b, { tool, id: 1, body: SEMI })).toContain('Split it.')
    }
    expect(await refusal($, b, { tool: 'mcp__x__add_comment', url: 'https://x/a;b', branch: 'a—b', body: CLEAN })).toBeUndefined()
    expect(await refusal($, b, { tool: 'mcp__x__list_items', body: SEMI })).toBeUndefined()
  })

  test('a body it cannot read is refused, with how to pass it', async ($, on) => {
    const b = await session($, on)
    for (const command of [
      'gh pr create --title t --body-file missing.md',
      'gh pr create --title t --body "$(cat notes.md)"',
      'cat notes.md | gh pr comment 1 --body-file -',
      'gh pr comment 1 --body-file - < notes.md',
      'gh api repos/o/r/pulls/1/reviews --input -',
    ]) {
      expect([command, await refusal($, b, bash(command))]).toEqual([command, UNREAD_BODY])
    }
    expect(UNREAD_BODY).toContain("--body-file - <<'EOF'")
  })

  test('a gh call in a heredoc fed to a shell is refused, quoted or not', async ($, on) => {
    const b = await session($, on)
    const tick = '`id`'
    const word = "'Fixed the list loader.'"
    for (const command of [
      `bash <<'EOF'\ngh pr comment 1 --body 'see ${tick}'\nEOF`,
      `sh <<'EOF'\ngh pr comment 1 --body ${word}\nEOF`,
      `zsh <<EOF\nbash -c "gh pr comment 1 --body ${word}"\nEOF`,
    ]) {
      expect([command, await refusal($, b, bash(command))]).toEqual([command, UNREAD_BODY])
    }
    // The shell reader refuses a pipe into a shell first. The prose guard
    // refuses it as well, on its own.
    const piped = `cat <<EOF | bash\ngh pr comment 1 --body ${word}\nEOF`
    expect(await refusal($, b, bash(piped))).toContain('piped or fed into a shell')
    expect(bashBodies(parseShell(piped))).toEqual({ unread: UNREAD_BODY })
    // So does a $, a backtick or a backslash in an unquoted body fed to a
    // shell.
    for (const expanded of [
      `bash <<EOF\ngh pr comment 1 --body 'see ${tick}'\nEOF`,
      `bash <<EOF\ngh pr comment 1 --body "${tick}"\nEOF`,
      `bash <<EOF\ngh pr comment 1 --body-file - <<'X'\n${tick}\nX\nEOF`,
      `bash <<EOF\ngh pr comment 1 --body-file - <<'X'\n$SECRET ${tick}\nX\nEOF`,
    ]) {
      expect(await refusal($, b, bash(expanded))).toContain("must be quoted (bash <<'EOF')")
      expect(bashBodies(parseShell(expanded))).toEqual({ unread: UNREAD_BODY })
    }
    expect(await refusal($, b, bash(`gh pr comment 1 --body-file - <<'EOF'\n${CLEAN}\nEOF`))).toBeUndefined()
    expect(await refusal($, b, bash(`bash <<'EOF'\necho hi\nEOF\ngh pr comment 1 --body ${word}`))).toBeUndefined()
  })

  test('a prose tool the guards cannot judge is refused', () => {
    expect(isProseTool('mcp__the-index__add_comment')).toBe(true)
    expect(isProseTool('add_comment')).toBe(false)
    expect(GUARDED.has('mcp__the-index__add_comment')).toBe(false)
  })
})
