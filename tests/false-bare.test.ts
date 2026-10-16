import { describe, expect, test } from 'claude-code/testing'

import { bareSetRefusal, repairedNotice, setsBareTrue } from '../hooks/mods/false-bare'
import { parseShell } from '../hooks/mods/shell'
import { bench, start } from './bench'

const SETTLE = 3000
const REPAIR = '/hooks/lib/false-bare.sh'

const repairs = (runs: readonly (readonly string[])[]) => runs.filter(argv => argv[0] === 'bash' && argv[1]?.endsWith(REPAIR))

describe('AC1: a false bare is repaired where a session starts', () => {
  test('the repair runs on the session folder, and Mike gets a one-line notice naming the repo', async ($, on) => {
    const b = bench(on)
    b.scripts['false-bare.sh'] = () => '/repo\n'
    await $.session.start(start())
    expect(repairs(b.runs)).toEqual([['bash', expect.stringMatching(/\/hooks\/lib\/false-bare\.sh$/), '/repo']])
    await b.clock.advance(SETTLE)
    expect(b.toasts).toContain(repairedNotice('/repo'))
    expect(repairedNotice('/repo')).not.toContain('\n')
    expect(repairedNotice('/repo')).toContain('/repo')
  })

  test('a session in a worktree repairs the main checkout the worktree shares its config with', async ($, on) => {
    const b = bench(on)
    b.cwd = '/worktrees/repo/feat'
    b.scripts['false-bare.sh'] = argv => (argv[2] === '/worktrees/repo/feat' ? '/repo\n' : '')
    await $.session.start(start())
    await b.clock.advance(SETTLE)
    expect(b.toasts).toContain(repairedNotice('/repo'))
  })

  test('a repo with nothing to repair raises no notice', async ($, on) => {
    const b = bench(on)
    b.scripts['false-bare.sh'] = () => ''
    await $.session.start(start())
    await b.clock.advance(SETTLE)
    expect(repairs(b.runs)).toHaveLength(1)
    expect(b.toasts.filter(text => text.startsWith('False-bare'))).toEqual([])
  })

  test('an unattended session is repaired too, and shows no toast', async ($, on) => {
    const b = bench(on)
    b.scripts['false-bare.sh'] = () => '/repo\n'
    await $.session.start(start(false))
    await b.clock.advance(SETTLE + 60_000)
    expect(repairs(b.runs)).toHaveLength(1)
    expect(b.toasts).toEqual([])
  })

  test('a repair that cannot run does not stop the session start', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    expect(b.registered).toContain('orchestrator')
    await b.clock.advance(SETTLE)
    expect(b.toasts).toEqual([])
  })
})

describe('AC1: a false bare is repaired before a git command runs', () => {
  test('a Bash line that runs git repairs the session folder first, and the notice names the repo', async ($, on) => {
    const b = bench(on)
    const order: string[] = []
    b.scripts['false-bare.sh'] = () => {
      order.push('repair')
      return order.length === 1 ? '' : '/repo\n'
    }
    b.onBash = () => {
      order.push('bash')
      return undefined
    }
    await $.session.start(start())
    const result = await $.tool.call({ tool: 'Bash', command: 'git status' })
    expect(result.deny).toBeUndefined()
    expect(order).toEqual(['repair', 'repair', 'bash'])
    expect(b.toasts).toContain(repairedNotice('/repo'))
  })

  test('an unattended session repairs before a git line too, and shows no toast', async ($, on) => {
    const b = bench(on)
    b.scripts['false-bare.sh'] = () => '/repo\n'
    await $.session.start(start(false))
    const result = await $.tool.call({ tool: 'Bash', command: 'git status' })
    await b.clock.advance(SETTLE + 60_000)
    expect(result.deny).toBeUndefined()
    expect(repairs(b.runs)).toHaveLength(2)
    expect(b.toasts).toEqual([])
  })

  test('script output that is not an absolute path raises no notice', async ($, on) => {
    const b = bench(on)
    b.scripts['false-bare.sh'] = () => 'error: could not lock config file .git/config\n'
    await $.session.start(start())
    await $.tool.call({ tool: 'Bash', command: 'git status' })
    await b.clock.advance(SETTLE)
    expect(repairs(b.runs)).toHaveLength(2)
    expect(b.toasts.filter(text => text.startsWith('False-bare'))).toEqual([])
  })

  test('a git line nested in a shell is seen too', async ($, on) => {
    const b = bench(on)
    b.scripts['false-bare.sh'] = () => ''
    await $.session.start(start())
    await $.tool.call({ tool: 'Bash', command: 'bash -c "git log -1"' })
    expect(repairs(b.runs)).toHaveLength(2)
  })

  test('a line that runs no git runs no repair', async ($, on) => {
    const b = bench(on)
    b.scripts['false-bare.sh'] = () => ''
    await $.session.start(start())
    await $.tool.call({ tool: 'Bash', command: 'ls -la' })
    await $.tool.call({ tool: 'Bash', command: 'grep -rn git .' })
    expect(repairs(b.runs)).toHaveLength(1)
  })

  test('a repair that fails still lets the git command run', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    const result = await $.tool.call({ tool: 'Bash', command: 'git status' })
    expect(result.deny).toBeUndefined()
    await b.clock.advance(SETTLE)
    expect(b.toasts).toEqual([])
  })
})

describe('AC3: an agent may not set core.bare to true', () => {
  const REFUSED = [
    'git config core.bare true',
    'git -C /repo config core.bare true',
    'git config --bool core.bare yes',
    'git config --type=bool core.bare on',
    'git config --type bool core.bare 1',
    'git config --local core.bare TRUE',
    'git config --global core.bare true',
    'git config --file .git/config core.bare true',
    'git config -f /srv/app/.git/config core.Bare true',
    'git config --replace-all core.bare true',
    'git config --add core.bare true',
    'git config set core.bare true',
    'git config set --type=bool core.bare true',
    'git config core.bare "$VALUE"',
    'cd /repo && git config core.bare true',
    'bash -c "git config core.bare true"',
    'sudo git config core.bare true',
    'env GIT_DIR=/repo/.git git config core.bare true',
    'ssh box "git -C /srv/app config core.bare true"',
    'docker compose exec app git config core.bare true',
    'find . -name .git -execdir git config core.bare true \\;',
    'git config core."bare" true',
    "git config 'core.ba're true",
    'git config core.ba\\re true',
    'git -C config config core.bare true',
    'git -c x=y config core.bare true',
    'git --git-dir=/repo/.git config core.bare true',
    'git config --global core.bare true',
    'git init --bare .git',
    'git init --bare /repo/.git/',
    'git -C /repo init --bare .git',
    'git -C /repo/.git init --bare',
    'git -C /repo/.git init --bare .',
    'git --git-dir=.git init --bare',
    'git --bare --git-dir=/repo/.git init',
    'git init --bare --template /t .git',
    'cd /repo && git init --bare .git',
    'GIT_DIR=.git git init --bare',
    'env GIT_DIR=/repo/.git git init --bare',
    'sudo env GIT_DIR=/repo/.git/ git init --bare',
    'bash -c "GIT_DIR=.git git init --bare"',
  ]
  const ALLOWED = [
    'git config core.bare false',
    'git config --bool core.bare no',
    'git config core.bare off',
    'git config core.bare 0',
    'git config core.bare',
    'git config --get core.bare',
    'git config --type=bool --get core.bare',
    'git config get core.bare',
    'git config --unset core.bare',
    'git config --list',
    'git config --get core.bare true',
    'git config core.editor true',
    'git init --bare /srv/new.git',
    'git init --bare',
    'git init .git',
    'git --git-dir .git init',
    'git -C /repo init',
    'git init --bare --template .git /srv/new.git',
    'grep -rn "core.bare = true" .',
    'echo core.bare true',
    'echo git init --bare .git',
    'GIT_DIR=/srv/new.git git init --bare',
    'GIT_DIR=.git git --git-dir=/srv/new.git init --bare',
    'GIT_DIR=.git git init',
    'GIT_DIR=.git echo init --bare',
  ]
  for (const line of REFUSED) {
    test(`refuses ${JSON.stringify(line)}`, () => {
      expect(bareSetRefusal(line)).toContain('False-bare guard (workbench-core)')
    })
  }

  test('the refusal runs in the Bash guard chain, before the command reaches the engine', async ($, on) => {
    const b = bench(on)
    await $.session.start(start())
    const result = await $.tool.call({ tool: 'Bash', command: 'git config core.bare true' })
    expect(result.deny).toBe(bareSetRefusal('git config core.bare true'))
    expect(b.inputs).toEqual([])
  })

  test('the init refusal says what the command would write', () => {
    expect(bareSetRefusal('git init --bare .git')).toContain('git init --bare on a .git folder, which writes core.bare = true into it')
  })
  for (const line of ALLOWED) {
    test(`allows ${JSON.stringify(line)}`, () => {
      expect(bareSetRefusal(line)).toBeUndefined()
    })
  }

  test('the deny says why core.bare is refused, and what to do instead', () => {
    const deny = bareSetRefusal('git config core.bare true') ?? ''
    expect(deny).toContain('this command sets core.bare to true')
    expect(deny).toContain('this operation must be run in a work tree')
    expect(deny).toContain('2026-10-16')
    expect(deny).toContain('ask Mike')
  })

  test('a command past the read ceiling that names core.bare is refused, and one that does not is left alone', () => {
    expect(bareSetRefusal(`echo ${'x'.repeat(200_000)}; echo core.bare`)).toContain('longer than 200,000')
    expect(bareSetRefusal(`echo ${'x'.repeat(200_000)}; echo ok`)).toBeUndefined()
  })

  test('a line the reader cannot read whole that names core.bare is refused', () => {
    expect(bareSetRefusal('git config core.bare "true')).toContain('False-bare guard (workbench-core)')
    expect(bareSetRefusal('echo "core.bare')).toContain('could not read all of this command')
  })

  test('the config reader keys on the value, the key and the read forms', () => {
    expect(setsBareTrue(['core.bare', 'true'])).toBe(true)
    expect(setsBareTrue(['core.bare', 'false'])).toBe(false)
    expect(setsBareTrue(['core.bare', ''])).toBe(false)
    expect(setsBareTrue(['--file', 'core.bare', 'core.bare', 'true'])).toBe(true)
    expect(setsBareTrue(['--', 'core.bare', 'true'])).toBe(true)
    expect(setsBareTrue(['--unset-all', 'core.bare', 'true'])).toBe(false)
    expect(setsBareTrue(['unset', 'core.bare', 'true'])).toBe(false)
    expect(setsBareTrue(['core.barely', 'true'])).toBe(false)
  })
})

describe('AC3: a line that runs no git skips the scan', () => {
  test('a long runner line with no git in it is not refused, and is judged in linear time', () => {
    const line = `find . ${'-a -o '.repeat(10_000)}-name x -exec printf init --bare x ;`
    const parse = parseShell(line)
    const started = Date.now()
    expect(bareSetRefusal(line, parse)).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(200)
  })

  test('the same runner line that does run git is still read', () => {
    expect(bareSetRefusal(`find . ${'-name x -o '.repeat(50)}-name y -execdir git config core.bare true ;`)).toContain('sets core.bare to true')
    expect(bareSetRefusal('xargs -n1 /usr/bin/GIT config core.bare true')).toContain('sets core.bare to true')
  })

  const QUOTED = [
    `ssh box 'g""it config core.bare true'`,
    `find . -exec sh -c "g''it config core.bare true" \\;`,
    `docker exec c sh -c "g''it config core.bare true"`,
    `ssh box 'g\\it config core.bare true'`,
  ]
  for (const line of QUOTED) {
    test(`a quoted or backslashed git name inside a runner is still refused: ${JSON.stringify(line)}`, () => {
      expect(bareSetRefusal(line)).toContain('False-bare guard (workbench-core)')
    })
  }
})
