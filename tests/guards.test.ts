// The guards in the hooks module (hooks/mods/guards.ts, judged in
// hooks/register.ts's tool.call hook), driven through the engine: the peer
// message gate, and the provisioning, summary-writer, credential and
// whole-disk search guards. tests/guard-differential.test.ts holds the first
// four to their frozen bash guards; this file pins each one's behaviour in both
// directions, and what each refusal tells the agent to do.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'

import {
  AGENT_WORKTREE_REFUSAL,
  ENTER_WORKTREE_REFUSAL,
  EXIT_WORKTREE_REFUSAL,
  GUARDED,
  PEER_ADVICE,
  PEER_REFUSAL,
  SEARCH_UNREAD,
  credentialPathRefusal,
  credentialRefusal,
  hiddenCommandRefusal,
  isBroadRoot,
  provisioningRefusal,
  resolvePath,
  searchRefusal,
  summaryWriterRefusal,
  toolSearchRoots,
} from '../hooks/mods/guards'
import { parseShell } from '../hooks/mods/shell'
import type { Bench } from './bench'
import { bench, start } from './bench'
import { install, model, rootsOf } from './world'

const HOME = '/Users/tester'
const SCRATCH = '/scratch'
const SESSION_PAD = '/private/tmp/claude-501/-repo/0f3c/scratchpad'
const AGENT = 'a5a2f4470341f9233'

type Call = Record<string, unknown> & { tool: string }

// A session in /repo, under HOME.
async function session($: Engine, on: Parameters<typeof bench>[0], env: Record<string, string> = {}, isStarted = true): Promise<Bench> {
  const b = bench(on, { env: { HOME, ...env } })
  b.scripts['scratch-roots.sh'] = () => `${SCRATCH}\n${SESSION_PAD}\n`
  if (isStarted) await $.session.start(start(false))
  return b
}

// The call's refusal, or undefined when it reached the engine.
async function refusal($: Engine, b: Bench, call: Call): Promise<string | undefined> {
  const before = b.inputs.length
  const result = await $.tool.call(call as never)
  expect([call, b.inputs.length > before]).toEqual([call, result.deny === undefined])
  return result.deny
}

const bash = (command: string, agentId?: string): Call => ({ tool: 'Bash', command, ...(agentId ? { agentId } : {}) })

describe('the peer message gate', () => {
  test('a sub-agent may send to "main", and to an agent id with a note', async ($, on) => {
    const b = await session($, on)
    expect(await refusal($, b, { tool: 'SendMessage', to: 'main', message: 'done', agentId: AGENT })).toBeUndefined()
    const result = await $.tool.call({ tool: 'SendMessage', to: 'b5a2f4470341f9233', message: 'x', agentId: AGENT } as never)
    expect(result.deny).toBeUndefined()
    expect(result.context).toEqual([PEER_ADVICE])
  })

  test('a sub-agent may not send to a peer session, or to any form nobody measured', async ($, on) => {
    const b = await session($, on)
    for (const to of ['herdr-b5', 'herdr-b5 [72839a]', 'Main', ' main', 'A5A2F4470341F9233', 'a5a2f447', `${AGENT}\n`, 42, {}]) {
      expect(await refusal($, b, { tool: 'SendMessage', to, message: 'x', agentId: AGENT })).toBe(PEER_REFUSAL)
    }
    // Every destination field is read, and the strictest wins.
    expect(await refusal($, b, { tool: 'SendMessage', to: 'main', recipient: 'herdr-b5', message: 'x', agentId: AGENT })).toBe(PEER_REFUSAL)
    // A send that names nobody is refused, where the bash gate let it through.
    expect(await refusal($, b, { tool: 'SendMessage', message: 'x', agentId: AGENT })).toBe(PEER_REFUSAL)
  })

  test('the main loop sends anywhere', async ($, on) => {
    const b = await session($, on)
    expect(await refusal($, b, { tool: 'SendMessage', to: 'herdr-b5', message: 'x' })).toBeUndefined()
  })

  test('a top-level --agent run sends anywhere', async ($, on) => {
    const b = await session($, on, { CLAUDE_CODE_AGENT: 'watson' })
    expect(await refusal($, b, { tool: 'SendMessage', to: 'herdr-b5', message: 'x' })).toBeUndefined()
  })

  test('a lane that cannot be read is a sub-agent\'s', async ($, on) => {
    // Before session start, $.workbench.callerLane rejects.
    const b = await session($, on, {}, false)
    expect(await refusal($, b, { tool: 'SendMessage', to: 'herdr-b5', message: 'x' })).toBe(PEER_REFUSAL)
  })
})

describe('the provisioning guard', () => {
  test('the three tool surfaces', async ($, on) => {
    const b = await session($, on)
    expect(await refusal($, b, { tool: 'EnterWorktree', name: 'x' })).toBe(ENTER_WORKTREE_REFUSAL)
    expect(await refusal($, b, { tool: 'ExitWorktree', action: 'remove' })).toBe(EXIT_WORKTREE_REFUSAL)
    expect(await refusal($, b, { tool: 'ExitWorktree', action: 'keep' })).toBeUndefined()
    expect(await refusal($, b, { tool: 'Agent', prompt: 'x', description: 'x', isolation: 'worktree' })).toBe(AGENT_WORKTREE_REFUSAL)
    expect(await refusal($, b, { tool: 'Agent', prompt: 'x', description: 'x', isolation: 'remote' })).toBeUndefined()
    expect(await refusal($, b, { tool: 'Agent', prompt: 'x', description: 'x' })).toBeUndefined()
  })

  const REFUSED = [
    'git worktree add ../feat',
    'git -C /repo worktree remove ../feat',
    'git worktree prune',
    'createdb app',
    'CREATEDB app',
    'createuser app',
    'mysqladmin create app',
    'psql -c "CREATE DATABASE app"',
    "mysql -e 'create schema x'",
    'echo "CREATE DATABASE app" | psql',
    'psql <<SQL\nCREATE DATABASE app;\nSQL',
    'docker compose exec db createdb app',
    'ssh box "git worktree add x"',
    'bash -c "createdb app"',
    // The bash guard's known gap: env -i hid the command after it.
    'env -i createdb app',
    "git $'\\x77orktree' add x",
    // The rows hooks/test-parser-differential.sh pins for the frozen guard.
    'cat <<EOF > notes.txt\njust some text\nEOF\ncreatedb app',
    'cat <<EOF\ncreatedb app',
    '(true); createdb app',
    'create\\\ndb app',
  ]
  const ALLOWED = [
    'git worktree list',
    'git worktree lock ../feat',
    'psql -c "SELECT 1"',
    "psql -c \"SELECT * FROM t WHERE msg = 'create database'\"",
    'mysqladmin status',
    'grep -rn createdb .',
    'docker compose up -d',
    'sqlite3 db.sqlite "CREATE TABLE t (a)"',
    'echo "CREATE DATABASE app"',
    'git commit -m "create the worktree docs"',
  ]
  for (const line of REFUSED) {
    test(`refuses ${JSON.stringify(line)}`, async ($, on) => {
      const b = await session($, on)
      expect(await refusal($, b, bash(line))).toContain('Provisioning guard (workbench-core)')
    })
  }
  for (const line of ALLOWED) {
    test(`allows ${JSON.stringify(line)}`, async ($, on) => {
      const b = await session($, on)
      expect(await refusal($, b, bash(line))).toBeUndefined()
    })
  }

  test('a padded command past the 200,000-character ceiling that names a creation verb is refused', () => {
    expect(provisioningRefusal(`echo ${'x'.repeat(200_000)}; echo create`)).toContain('longer than 200,000')
    expect(provisioningRefusal(`echo ${'x'.repeat(200_000)}; echo ok`)).toBeUndefined()
    expect(provisioningRefusal(`echo ${'x'.repeat(199_000)}; git worktree add x`)).toContain('git worktree add')
  })
})

describe('the summary-writer guard', () => {
  const NBSP = '\u00a0'
  const REFUSED = [
    'cat > sessions/2026-07-01/abc.summary.md <<EOF\nx\nEOF',
    'echo hi >> notes.md',
    'echo x | tee out.md',
    'cp a.txt b.summary.md',
    'sed -i "s/a/b/" notes.md',
    'sed -Ei "s/a/b/" notes.md',
    'gsed --in-place=.bak "s/a/b/" notes.md',
    `> foo${NBSP}.md`,
    `echo hi >> a${NBSP}b.md`,
    'sudo tee x.md < a',
    'bash -c "echo x > a.md"',
  ]
  const ALLOWED = ['rm /cache/pending-summaries/abc.json', 'cat sessions/x.md > /dev/null', 'grep foo sessions/x.md', `tee${NBSP}out.md`, 'echo "a > b.md"']
  for (const line of REFUSED) {
    test(`with WORKBENCH_SUMMARY_WRITER=1, refuses ${JSON.stringify(line)}`, async ($, on) => {
      const b = await session($, on, { WORKBENCH_SUMMARY_WRITER: '1' })
      expect(await refusal($, b, bash(line))).toContain('Summary-writer guard (workbench-core)')
    })
  }
  for (const line of ALLOWED) {
    test(`with WORKBENCH_SUMMARY_WRITER=1, allows ${JSON.stringify(line)}`, async ($, on) => {
      const b = await session($, on, { WORKBENCH_SUMMARY_WRITER: '1' })
      // The writer deletes its own marker, which the destructive-scope guard
      // permits in the memory cache's pending-summaries folder.
      const markers = '/cache/pending-summaries'
      install(b, model({ dirs: ['/cache', markers], files: [`${markers}/abc.json`] }), { roots: rootsOf([], undefined, markers), vault: null })
      expect(await refusal($, b, bash(line))).toBeUndefined()
    })
  }
  test('outside the summary-writer, a Bash .md write goes on', async ($, on) => {
    const b = await session($, on)
    expect(await refusal($, b, bash('echo hi > notes.md'))).toBeUndefined()
  })
  test('a line the reader cannot read whole, naming a .md file, is refused', () => {
    expect(summaryWriterRefusal(parseShell('$W notes.md'))).toContain('could not read all')
    expect(summaryWriterRefusal(parseShell('$W notes.txt'))).toBeUndefined()
  })
})

describe('AC4: the credential guard', () => {
  test('text holding $.env.get is not a .env read', async ($, on) => {
    const b = await session($, on)
    for (const line of [
      "cat > hooks/x.ts <<'EOF'\nconst home = await $.env.get('HOME')\nEOF",
      'grep -n "$.env.get" hooks/register.ts',
      "grep -rn '$.env.get' hooks",
      "sed -n '1,9p' hooks/register.ts | grep $.env.get",
      "python3 - <<'PY'\ns = open('x.ts').read().replace('a', \"$.env.get('HOME')\")\nPY",
    ]) {
      expect(await refusal($, b, bash(line))).toBeUndefined()
    }
    // The file tools judge the path alone, never the text.
    expect(await refusal($, b, { tool: 'Edit', file_path: '/repo/hooks/x.ts', old_string: 'a', new_string: "$.env.get('HOME')" })).toBeUndefined()
    expect(await refusal($, b, { tool: 'Write', file_path: '/repo/hooks/x.ts', content: "await $.env.get('HOME')\ncat .env" })).toBeUndefined()
  })

  const REFUSED = [
    'cat ~/.ssh/id_rsa',
    'head $HOME/.aws/credentials',
    'gpg --list-keys ${HOME}/.gnupg',
    'python3 -c$HOME/.aws/credentials',
    `cat ${HOME}/.ssh/id_rsa`,
    `python3 -c "print(open('${HOME}/.ssh/id_rsa').read())"`,
    'cat .env',
    'grep DB_PASSWORD .env.production',
    "python3 <<PY\nprint(open('.env').read())\nPY",
    'cat .env.example .env',
    // Keychains: read, link and copy.
    `ln -s ${HOME}/Library/Keychains /scratch/home/Library/Keychains`,
    'ln -s ~/Library/Keychains "$SCRATCH_HOME/Library/Keychains"',
    'cp -R ~/Library/Keychains /scratch/k',
    'cat ~/Library/Keychains/login.keychain-db',
    'ditto /Users/mike/Library/Keychains /scratch/home/Library/Keychains',
    // Claude's credential store: the file, and the keychain item.
    'cat ~/.claude/.credentials.json',
    'cp "$CLAUDE_CONFIG_DIR/.credentials.json" /scratch/config/',
    'ln -s ~/.claude/.credentials.json /scratch/config/.credentials.json',
    'security find-generic-password -s "Claude Code-credentials" -w',
    'security dump-keychain',
    // A heredoc body any program but a plain cat or tee writing a file may read.
    'xargs cat <<EOF\n.env\nEOF',
    // A device target or another descriptor sends the body on to the pipe.
    'cat > /dev/stdout <<EOF | xargs cat\n.env\nEOF',
    'cat >/dev/fd/1 <<EOF | xargs cat\n.env\nEOF',
    'cat 2> err.txt <<EOF | xargs cat\n.env\nEOF',
    // The last redirect of fd 1 wins, and a duplicated or closed fd gives the
    // shape up.
    'cat > a.txt > /dev/stdout <<EOF | xargs cat\n.env\nEOF',
    'cat > a.txt 1>&2 <<EOF | xargs cat\n.env\nEOF',
    'cat >a.txt >&- <<EOF | xargs cat\n.env\nEOF',
    'cat >a.txt &>/dev/stdout <<EOF | xargs cat\n.env\nEOF',
    'cat >a.txt 1<>b.txt <<EOF | xargs cat\n.env\nEOF',
    // Only a literal file path keeps the body text: not a process
    // substitution, a variable, quoted or not, or a glob.
    'cat > >(xargs cat) <<EOF\n.env\nEOF',
    'X=/dev/stdout; cat > $X <<EOF | xargs cat\n.env\nEOF',
    'cat > "$X" <<EOF | xargs cat\n.env\nEOF',
    'cat > `echo /dev/stdout` <<EOF | xargs cat\n.env\nEOF',
    'cat > /dev/std* <<EOF | xargs cat\n.env\nEOF',
    // A line the reader could not read whole keeps no exemption.
    "echo $'\\u0041'; cat > notes.txt <<EOF\n.env\nEOF",
    'cat <<EOF | xargs cat\n.env\nEOF',
    'while read f; do cat "$f"; done <<EOF\n.env\nEOF',
    'tee <<EOF | xargs cat\n.env\nEOF',
    'sudo cat > x <<EOF\n.env\nEOF\ncat x | xargs cat',
    // tee writes the body to each file it names too, so it is never exempt.
    // `tee notes.txt > /dev/null` was allowed before round 6, and is refused
    // now; `cat > notes.txt <<EOF` covers that use.
    'tee >(xargs cat) > notes.txt <<EOF\n.env\nEOF',
    'tee notes.txt <<EOF | xargs cat\n.env\nEOF',
    'tee notes.txt > /dev/null <<EOF\n.env\nEOF',
    // A line that makes a FIFO, a node or a link may write into it.
    'mkfifo p; cat > p <<EOF\n.env\nEOF',
    'ln -s /dev/stdout out; cat > out <<EOF\n.env\nEOF',
    // A relative target after a cd lands where the reader does not follow.
    'cd sub && cat > notes.txt <<EOF\n.env\nEOF',
    // security reading its subcommands from its input.
    "printf 'find-generic-password -w -s x\\n' | security -i",
    'security -p "> " < cmds.txt',
    'security',
    // Case, doubled slashes, `.` and `..`: APFS reads them all as the same path.
    'cat ~/library/keychains/login.keychain-db',
    'cat ~/Library//Keychains/login.keychain-db',
    'cat ~/Library/./Keychains/login.keychain-db',
    'cat ~/.SSH/id_rsa',
    'cat ~/./.ssh/id_rsa',
    'cat ~/Developer/../.ssh/id_rsa',
    `cat ${HOME.toUpperCase()}/.aws/credentials`,
    'cat ~/.claude//.CREDENTIALS.json',
    'cat .ENV',
    'cat ./.env',
  ]
  const ALLOWED = [
    'ls ~/.ssh',
    'cat .env.example',
    'cat .envrc',
    'cat ~/Developer/x/.ssh/notes',
    'echo "a note about .env files" | cat',
    'ls ~/Library/Keychains',
    // A plain cat writing its body to a file reads nothing it names.
    'cat > notes.txt <<EOF\n.env\nEOF',
    'cat > /dev/stdout > notes.txt <<EOF\n.env\nEOF',
    'cat > /repo/notes.txt <<EOF\n.env\nEOF',
    'security find-certificate -a',
  ]
  for (const line of REFUSED) {
    test(`refuses ${JSON.stringify(line)}`, async ($, on) => {
      const b = await session($, on)
      expect(await refusal($, b, bash(line))).toContain('Credential guard (workbench-core)')
    })
  }

  // The cat's target is asked of the file system: only a missing path or a
  // regular file keeps the body text. A FIFO, a socket, a device, a folder,
  // and a symbolic link to any of them, do not.
  test('a heredoc target that is a FIFO, a link to a device, or a folder, keeps no exemption', async ($, on) => {
    const b = await session($, on)
    const line = (target: string) => bash(`cat > ${target} <<EOF\n.env\nEOF`)
    b.kinds.set('/repo/pipe', 'other')
    b.kinds.set('/repo/out', 'other')
    b.links.add('/repo/out')
    b.kinds.set('/repo/dir', 'dir')
    b.files.set('/repo/notes.txt', 'old')
    b.files.set(`${HOME}/notes.txt`, 'old')
    expect(await refusal($, b, line('/repo/pipe'))).toContain('Credential guard (workbench-core)')
    expect(await refusal($, b, line('/repo/out'))).toContain('Credential guard (workbench-core)')
    expect(await refusal($, b, line('/repo/dir'))).toContain('Credential guard (workbench-core)')
    expect(await refusal($, b, line('/repo/notes.txt'))).toBeUndefined()
    expect(await refusal($, b, line('~/notes.txt'))).toBeUndefined()
    expect(await refusal($, b, line('/repo/new.txt'))).toBeUndefined()
  })

  // The bench's session directory is /repo, which is not the engine's own
  // working directory, so a relative target stats the right file only when it
  // is resolved against the session's.
  test('a relative heredoc target is judged in the session\'s working directory', async ($, on) => {
    const b = await session($, on)
    b.kinds.set('/repo/pipe', 'other')
    b.files.set('/repo/notes.txt', 'old')
    expect(await refusal($, b, bash('cat > pipe <<EOF\n.env\nEOF'))).toContain('Credential guard (workbench-core)')
    expect(await refusal($, b, bash('cat > notes.txt <<EOF\n.env\nEOF'))).toBeUndefined()
  })
  for (const line of ALLOWED) {
    test(`allows ${JSON.stringify(line)}`, async ($, on) => {
      const b = await session($, on)
      expect(await refusal($, b, bash(line))).toBeUndefined()
    })
  }

  test('the file tools: the credential folders, keychains, Claude\'s store and .env files', async ($, on) => {
    const b = await session($, on)
    for (const [tool, key, path] of [
      ['Read', 'file_path', `${HOME}/.ssh/id_rsa`],
      ['Read', 'file_path', '~/.aws/credentials'],
      ['Edit', 'file_path', '/repo/.env'],
      ['NotebookEdit', 'notebook_path', '/repo/.env.local'],
      ['Read', 'file_path', `${HOME}/Library/Keychains/login.keychain-db`],
      ['Read', 'file_path', `${HOME}/.claude/.credentials.json`],
      ['Write', 'file_path', '/scratch/config/.credentials.json'],
      ['Grep', 'path', `${HOME}/.ssh`],
      ['Read', 'file_path', `${HOME}/library//KEYCHAINS/login.keychain-db`],
      ['Read', 'file_path', `${HOME}/Library/./Keychains/x`],
      ['Read', 'file_path', '/users/tester/.SSH/id_rsa'],
      ['Read', 'file_path', `${HOME}/x/../.aws/credentials`],
      ['Read', 'file_path', `${HOME}/.claude//.credentials.JSON`],
      ['Edit', 'file_path', '/repo/.ENV'],
    ] as const) {
      expect(await refusal($, b, { tool, [key]: path, ...(tool === 'Grep' ? { pattern: 'x' } : {}) })).toContain('Credential guard (workbench-core)')
    }
    for (const path of ['/repo/.env.example', '/repo/.envrc', '/repo/README.md', `${HOME}/Developer/x/.ssh-notes.md`]) {
      expect(await refusal($, b, { tool: 'Read', file_path: path })).toBeUndefined()
    }
  })

  // security and its secret-reading subcommands are the guard's subject too.
  test('security, or a secret-reading subcommand, in a line the reader cannot read whole is refused', () => {
    expect(credentialRefusal('echo find-generic-password -w "x', HOME)).toContain('could not read all')
    expect(credentialRefusal('echo security "x', HOME)).toContain('could not read all')
    expect(credentialRefusal('echo find-certificate "x', HOME)).toBeUndefined()
  })

  test('a credential path in a line the reader cannot read whole is refused', () => {
    expect(credentialRefusal('$R ~/.ssh/id_rsa', HOME)).toContain('could not read all')
    expect(credentialRefusal(`echo ${'x'.repeat(200_001)}; cat "a note about the .env file"`, HOME)).toContain('longer than 200,000')
    expect(credentialRefusal(`echo ${'x'.repeat(199_000)}; cat "a note about the .env file"`, HOME)).toBeUndefined()
    expect(credentialPathRefusal('/repo/src/main.ts', HOME)).toBeUndefined()
  })
})

describe('AC5: the whole-disk search guard', () => {
  const REFUSED = [
    'find / -name Rahlfs*',
    'bfs / -name x',
    'gfind / -name x',
    'find ~ -name x',
    'find $HOME -name x',
    'find ${HOME} -name x',
    `find ${HOME} -name x`,
    `find ${HOME}/ -name x`,
    'find ~/Library -name x',
    'find /Users -name x',
    'find /System -name x',
    'find /Library -name x',
    'find /Volumes -name x',
    'find /Volumes/Backup -name x',
    'find /private -name x',
    'find /opt -name x',
    'find /usr -name x',
    'find /Applications -name x',
    'find /private/var -name x',
    'find /var -name x',
    'find -L / -name x',
    // Case, doubled slashes, `.` and `..` do not change the root.
    'find /USERS -name x',
    'find /usr/ -name x',
    'find //usr -name x',
    'find /./opt -name x',
    'find /usr/local/.. -name x',
    `find ${HOME.toUpperCase()}/library -name x`,
    'fd foo /',
    'fd -e md foo ~',
    'rg --files /',
    'rg --files ~',
    'rg -g "*.md" needle /Users',
    'ag needle /',
    'ag -g x ~',
    'ack needle /usr',
    'grep -r foo /',
    'grep -rn foo ~',
    'grep -R foo /System',
    'grep --recursive foo /Users',
    'mdfind kMDItemDisplayName == x',
    'mdfind -onlyin / x',
    'mdfind -onlyin ~ x',
    // An unresolvable root: a variable, a glob, a substitution, another home.
    'find $DIR -name x',
    'find /*/lib -name x',
    'find $(pwd)/.. -name x',
    'find ~mike -name x',
    // Through a cd, a wrapper and a nested script.
    'cd / && find . -name x',
    'cd ~ && rg --files',
    'sudo find / -name x',
    'nice -n 5 find / -name x',
    'bash -c "find / -name x"',
    'cd /repo && find ../.. -name x',
  ]
  const ALLOWED = [
    'find . -name x',
    'find /repo/sub -name x',
    'find sub -type f',
    // Another repository, the plans folder, the plugin cache, a folder under
    // a broad root: narrow enough.
    `find ${HOME}/Developer/other -name x`,
    `rg --files ${HOME}/.claude/plans`,
    `grep -rn needle ${HOME}/.claude/plugins/cache`,
    'find /opt/homebrew/Cellar/jq -name x',
    'find /usr/local/lib -name x',
    'find /Volumes/Backup/photos -name x',
    `find ${HOME}/Library/Caches/x -name y`,
    'gfind sub -name x',
    'ag needle src',
    'ack needle hooks',
    'rg --files',
    'rg foo src',
    'rg -n "find /" .',
    'grep -r foo .',
    'grep foo /etc/hosts',
    'fd foo',
    'mdfind -onlyin /repo x',
    'echo find /',
  ]
  for (const line of REFUSED) {
    test(`refuses ${JSON.stringify(line)}`, async ($, on) => {
      const b = await session($, on)
      const reason = await refusal($, b, bash(line))
      expect(reason).toContain('Whole-disk search guard (workbench-core)')
      expect(reason).toContain('stop and ask Mike')
    })
  }
  for (const line of ALLOWED) {
    test(`allows ${JSON.stringify(line)}`, async ($, on) => {
      const b = await session($, on)
      expect(await refusal($, b, bash(line))).toBeUndefined()
    })
  }

  test('the Grep and Glob tools: their path, a Glob pattern from a root, and the cwd when no path is given', async ($, on) => {
    const b = await session($, on)
    for (const call of [
      { tool: 'Grep', pattern: 'x', path: '/' },
      { tool: 'Grep', pattern: 'x', path: HOME },
      { tool: 'Grep', pattern: 'x', path: '/USR' },
      { tool: 'Glob', pattern: '*.md', path: '~' },
      { tool: 'Glob', pattern: '/**/*.md' },
      { tool: 'Glob', pattern: '~/Library/**/x' },
      { tool: 'Glob', pattern: '*.md', path: '$HOME' },
      // A pattern that climbs out, or opens with a brace, is judged where it starts.
      { tool: 'Glob', pattern: '../../**/*.md' },
      { tool: 'Glob', pattern: '{/,src}/**/*.md' },
      { tool: 'Glob', pattern: '{$HOME,src}/**' },
      { tool: 'Glob', pattern: '{a,{b,c}}/**' },
      { tool: 'Glob', pattern: '{~,src}/x*' },
      { tool: 'Glob', pattern: 'x/{../../..}/**' },
      { tool: 'Glob', pattern: 'src/{a,../../..}/*' },
    ]) {
      expect(await refusal($, b, call)).toContain('Whole-disk search guard (workbench-core)')
    }
    for (const call of [
      { tool: 'Grep', pattern: 'x' },
      { tool: 'Grep', pattern: 'x', path: '/repo/hooks' },
      { tool: 'Glob', pattern: '**/*.ts' },
      { tool: 'Glob', pattern: `${HOME}/.claude/plans/*.md` },
      { tool: 'Grep', pattern: 'x', path: `${HOME}/.claude/plugins/cache` },
      { tool: 'Glob', pattern: '{src,hooks}/**/*.ts' },
      { tool: 'Glob', pattern: 'src/{a,b}/*.ts' },
      { tool: 'Glob', pattern: '../other/**' },
      { tool: 'Glob', pattern: '/usr/local/lib/*.dylib' },
    ]) {
      expect(await refusal($, b, call)).toBeUndefined()
    }
  })

  test('a Grep or Glob with no path in a broad working directory is judged by it', () => {
    expect(searchRefusal(toolSearchRoots('Grep', { pattern: 'x' }, '/', HOME), HOME)).toContain('searches /')
    expect(searchRefusal(toolSearchRoots('Glob', { pattern: '*' }, HOME, HOME), HOME)).toContain(`searches ${HOME}`)
    expect(searchRefusal(toolSearchRoots('Glob', { pattern: '*' }, '/repo', HOME), HOME)).toBeUndefined()
  })

  test('a root whose symbolic links land on a broad root is refused', () => {
    expect(searchRefusal([{ tool: 'find', word: 'disk', path: '/repo/disk', real: '/' }], HOME)).toContain('searches /')
    expect(searchRefusal([{ tool: 'find', word: 'h', path: '/repo/h', real: HOME }], HOME)).toContain(`searches ${HOME}`)
    expect(searchRefusal([{ tool: 'find', word: 'src', path: '/repo/src', real: '/repo/src' }], HOME)).toBeUndefined()
  })

  test('a search in a line the reader cannot read whole is refused', async ($, on) => {
    const b = await session($, on)
    expect(await refusal($, b, bash('find / -name "x'))).toBe(SEARCH_UNREAD)
  })

  test('paths resolve as the shell resolves them', () => {
    expect(resolvePath('~/x/../y', '/repo', HOME)).toBe(`${HOME}/y`)
    expect(resolvePath('../..', '/repo/a', HOME)).toBe('/')
    expect(resolvePath('$HOME', '/repo', HOME)).toBeUndefined()
    expect(resolvePath('a*', '/repo', HOME)).toBeUndefined()
    expect(resolvePath('x', undefined, HOME)).toBeUndefined()
    expect(isBroadRoot('/Users/', HOME)).toBe(true)
    expect(isBroadRoot('/users/tester/LIBRARY', HOME)).toBe(true)
    expect(isBroadRoot('/Users/tester/Developer', HOME)).toBe(false)
  })
})

describe('decision A: a line whose command the reader cannot name is refused by every guard', () => {
  const REFUSED = [
    '$(echo security) find-generic-password -w -s x',
    's=security; $s find-generic-password -w -s x',
    'cre${X}atedb app',
    'c$(true)reatedb app',
    'f=fi; ${f}nd / -name x',
    '$EDITOR notes.txt',
    'echo "ls" | sh',
    "env --split-string='ls -la'",
    'nice --adj 5 ls',
    '$CMD worktree add x',
    "env --split-string='createdb app'",
    // A slash inside the braces hides the command name.
    '${X:-/usr/bin/security} find-generic-password -w -s x',
    '${X:-/opt/homebrew/bin/createdb} app',
    '${X#a}/bin/createdb app',
    // An unquoted expansion is split into words, so its first word may be
    // any command.
    "P='/usr/bin/security dump-keychain login.keychain '; $P/x",
    '$HOME/bin/x',
    '${CLAUDE_PLUGIN_ROOT}/scripts/x.sh',
  ]
  for (const line of REFUSED) {
    test(`refuses ${JSON.stringify(line)}`, async ($, on) => {
      const b = await session($, on)
      const reason = await refusal($, b, bash(line))
      expect(reason).toContain('Workbench guards (workbench-core): the shell reader cannot tell which command this line runs')
      expect(reason).toContain('stop and ask Mike')
    })
  }
  for (const line of [
    'echo $HOME',
    'ls "$DIR"',
    'bash -c "ls"',
    'git log --format=%H',
    'echo $(date)',
    // The pipeline's paths: a plain variable before a literal path.
    '"${CLAUDE_PLUGIN_ROOT}/scripts/x.sh"',
    '"$HOME/bin/x"',
    '"$HOME"/bin/x',
    '"${CLAUDE_PLUGIN_ROOT}"/scripts/x.sh',
    '"$HOME/Developer/workbench-dev-team/bin/dispatch-agent.sh" 12',
    'bash "${CLAUDE_PLUGIN_ROOT}/hooks/session-log.sh"',
  ]) {
    test(`allows ${JSON.stringify(line)}`, async ($, on) => {
      const b = await session($, on)
      expect(await refusal($, b, bash(line))).toBeUndefined()
    })
  }
  test('an unclosed quote refuses only where the line names a guard\'s subject', () => {
    expect(hiddenCommandRefusal(parseShell('echo "open'))).toBeUndefined()
    expect(credentialRefusal('cat ~/.ssh/id_rsa "x', HOME)).toBeDefined()
  })
})

// Raises two guarded calls the first time $.session.cwd() is asked, and
// stores each answer under `inner`. An inline plugin runs in an environment of
// its own, so everything it uses is written inside it.
const REENTRANT: Plugin = {
  name: 'reentrant',
  tier: 'append',
  register: on => {
    let isInside = false
    on('session.cwd', async ($, e, next) => {
      if (!isInside) {
        isInside = true
        const calls = [
          { tool: 'Bash', command: 'ls' },
          { tool: 'SendMessage', to: 'main', message: 'x' },
        ]
        for (const call of calls) {
          const result = await $.tool.call(call as never)
          await $.store.set('inner', result.deny ?? 'reached')
        }
      }
      return next(e)
    })
  },
}

describe('the guards fail closed', () => {
  test('a guard that throws refuses the call', async ($, on) => {
    mock.env(on, { HOME })
    const reached: string[] = []
    on('session.cwd', () => {
      throw new Error('cwd unreadable')
    })
    on('tool.call', ($2, e) => {
      reached.push(e.tool)
      return { result: {} as never }
    })
    const result = await $.tool.call({ tool: 'Bash', command: 'find /repo -name x' } as never)
    expect(result.deny).toContain('could not finish')
    expect(reached).toEqual([])
  })

  // A tool call raised beneath the hook's own `$` call meets the hook's
  // .catch, with the hook not run: a guarded call is refused there too. A
  // plugin below this one raises two calls while the hook waits on
  // $.session.cwd(), and hands each answer over through the store. A plugin
  // may not raise an Agent call through $.tool.call, so Agent's place in the
  // guarded set is pinned on its own.
  test("the hook's .catch refuses a guarded call it could not judge, SendMessage included", { plugins: [REENTRANT] }, async ($, on) => {
    mock.env(on, { HOME })
    const inner: unknown[] = []
    on('session.cwd', () => ({ value: '/repo' }))
    on('store.set', ($2, e) => {
      if (e.key === 'inner') inner.push(e.value)
      return { value: undefined }
    })
    on('tool.call', () => ({ result: {} as never }))
    await $.tool.call({ tool: 'Bash', command: 'find /repo -name x' } as never)
    expect(inner).toHaveLength(2)
    for (const deny of inner) expect(deny).toContain('could not finish')
  })

  test('every tool a guard judges is in the set the .catch refuses', () => {
    expect([...GUARDED].sort()).toEqual(['Agent', 'Bash', 'Edit', 'EnterWorktree', 'ExitWorktree', 'Glob', 'Grep', 'NotebookEdit', 'Read', 'SendMessage', 'Write'])
  })
})

describe('AC6: every refusal says how to proceed', () => {
  test('each refusal names its guard and gives an instruction', async ($, on) => {
    const b = await session($, on, { WORKBENCH_SUMMARY_WRITER: '1' })
    const reasons = [
      PEER_REFUSAL,
      ENTER_WORKTREE_REFUSAL,
      EXIT_WORKTREE_REFUSAL,
      AGENT_WORKTREE_REFUSAL,
      SEARCH_UNREAD,
      await refusal($, b, bash('createdb app')),
      await refusal($, b, bash('$C worktree add x')),
      await refusal($, b, bash('echo x > a.md')),
      await refusal($, b, bash('cat ~/.ssh/id_rsa')),
      await refusal($, b, { tool: 'Read', file_path: '/repo/.env' }),
      await refusal($, b, bash('find / -name x')),
      await refusal($, b, bash('find $D -name x')),
    ]
    const INSTRUCTIONS = ['Send it to "main" instead', 'Do not call EnterWorktree', 'Exit with action "keep" instead', 'Dispatch without isolation', 'Write the', 'Do not create or delete', 'Write the file through the MCP tool', 'Work without it', 'stop and ask Mike', 'Search inside the project']
    for (const reason of reasons) {
      expect(typeof reason).toBe('string')
      expect([reason, INSTRUCTIONS.some(words => (reason as string).includes(words))]).toEqual([reason, true])
      expect(reason).toContain('(workbench-core)')
      // Plain words: no markdown emphasis, and no pointer to a file the
      // reader cannot open.
      expect(reason).not.toMatch(/\*\*|references\//)
    }
  })
})
