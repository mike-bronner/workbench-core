import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { HEAD } from '../hooks/mods/full-suite'
import type { Bench } from './bench'
import { bench, run, start } from './bench'

const HOME = '/Users/tester'
const AGENT = 'a5a2f4470341f9233'

const FILES: Record<string, string> = {
  '/repo/scripts/check.sh': 'set -u\nfor t in hooks/test-*.sh; do bash "$t"; done\n',
  '/repo/run.sh': '#!/bin/bash\nvendor/bin/pest --parallel\n',
  '/repo/scratch/wrap.sh': 'bash /repo/scripts/check.sh\n',
  '/repo/run-tests.sh': "git ls-files 'test-*.sh' | while read -r f; do bash \"$f\"; done\n",
  '/repo/run.py': 'import subprocess\nsubprocess.run(["pytest"])\n',
  '/repo/tool.py': 'print("hello")\n',
  '/repo/scripts/status.sh': '. "$DIR/lib/env.sh"\necho ok\n',
  '/repo/scripts/suite.sh': '. "$DIR/lib/runner.sh"\n',
  '/repo/scripts/lib/runner.sh': 'vendor/bin/pest\n',
  '/repo/hooks/test-one.sh': 'bash "$RESOLVER" x\necho test\n',
  '/repo/hooks/test-all.sh': 'vendor/bin/pest\n',
  '/repo/bin/tool': 'ELF\0\0\nvendor/bin/pest\n',
  '/repo/vitest.config.ts': "export { defineConfig } from 'vitest/config'\n// jest compatible\n",
  '/repo/hooks/test-latest.sh': 'for f in latest-*; do bash "$f"; done\n',
  '/repo/hooks/test-dirs.sh': 'for d in inspector*/; do bash "$d"; done\n',
  '/repo/hooks/test-loop.sh': 'for t in hooks/test-*.sh; do bash "$t"; done\n',
  '/repo/lint.py': '# runs before pytest in CI\nimport pytest\nprint("lint")\n',
  '/repo/suite.js': 'require("child_process").execSync("npx jest")\n',
  '/repo/server.js': 'console.log("serve")\n',
  '/repo/main.ts': 'console.log("main")\n',
  '/repo/server.ts': 'Deno.serve(() => new Response("ok"))\n',
  [`${HOME}/bin/ok.sh`]: 'echo hi\n',
  '/plugin/scripts/setup-config.sh': 'set -u\ncase "$1" in migrate) echo migrated ;; esac\n',
  '/plugin/skills/memory-lint/scripts/check-frontmatter-health.py': 'import sys\nprint(sys.argv[1])\n',
  '/plugin/hooks/session-log.sh': 'cat > /dev/null\n',
  '/plugin/scripts/check.sh': 'for t in hooks/test-*.sh; do bash "$t"; done\n',
}

async function session($: Engine, on: Parameters<typeof bench>[0], env: Record<string, string> = {}): Promise<Bench> {
  const b = bench(on, { env: { HOME, ...env }, files: FILES })
  b.scripts['scratch-roots.sh'] = () => '/scratch\n'
  await $.session.start(start(false))
  return b
}

async function refusal($: Engine, command: string, agentId?: string): Promise<string | undefined> {
  return (await $.tool.call({ tool: 'Bash', command, ...(agentId ? { agentId } : {}) } as never)).deny
}

const RUNNERS: [string, string][] = [
  ['vendor/bin/pest', 'runs vendor/bin/pest with no test file, filter or case'],
  ['./vendor/bin/pest --parallel', 'runs ./vendor/bin/pest with no test file, filter or case'],
  ['vendor/bin/pest tests/Unit', 'runs vendor/bin/pest with no test file, filter or case'],
  ['vendor/bin/pest tests/*Test.php', 'runs vendor/bin/pest with no test file, filter or case'],
  ['vendor/bin/pest --filter=', 'runs vendor/bin/pest with no test file, filter or case'],
  ['php artisan test', 'runs php artisan test with no test file, filter or case'],
  ['php artisan test --testsuite=Feature', 'runs php artisan test with no test file, filter or case'],
  ['php vendor/bin/phpunit', 'runs php vendor/bin/phpunit with no test file, filter or case'],
  ['phpunit', 'runs phpunit with no test file, filter or case'],
  ['npx vitest run', 'runs vitest with no test file, filter or case'],
  ['npx vitest --config vitest.config.ts', 'runs vitest with no test file, filter or case'],
  ['npm test', 'runs npm test with no test file, filter or case'],
  ['npm run test', 'runs npm run test with no test file, filter or case'],
  ['yarn test', 'runs yarn test with no test file, filter or case'],
  ['composer test', 'runs composer test with no test file, filter or case'],
  ['pytest', 'runs pytest with no test file, filter or case'],
  ['python3 -m pytest', 'runs python3 -m pytest with no test file, filter or case'],
  ['node --test', 'runs node --test with no test file, filter or case'],
  ['bun test', 'runs bun test with no test file, filter or case'],
  ['go test ./...', 'runs go test with no test file, filter or case'],
  ['cargo test', 'runs cargo test, which runs the whole suite'],
  ['make test', 'runs make test, which runs the whole suite'],
  ['claude plugin test .', 'runs claude plugin test, which runs the whole suite'],
  ['sail artisan test', 'runs artisan test with no test file, filter or case'],
  ['docker compose exec app php artisan test', 'runs php artisan test with no test file, filter or case'],
  ['cd /repo && timeout 600 vendor/bin/pest 2>&1 | tail -5', 'runs vendor/bin/pest with no test file, filter or case'],
  ['find tests -name "*Test.php" -exec vendor/bin/pest {} +', 'runs vendor/bin/pest with no test file, filter or case'],
  ['for t in hooks/test-*.sh; do bash "$t"; done', 'loops over every file hooks/test-*.sh matches'],
  ['for f in tests/*Test.php; do vendor/bin/pest "$f"; done', 'runs vendor/bin/pest with no test file, filter or case'],
  ['for f in tests/*Test.php; do php "$f"; done', 'loops over every file tests/*Test.php matches'],
  ['uv run pytest', 'runs pytest with no test file, filter or case'],
  ['uv run --python 3.12 pytest', 'runs pytest with no test file, filter or case'],
  ['poetry run pytest', 'runs pytest with no test file, filter or case'],
  ['pipenv run pytest', 'runs pytest with no test file, filter or case'],
  ['hatch run pytest', 'runs pytest with no test file, filter or case'],
  ['pdm run pytest', 'runs pytest with no test file, filter or case'],
  ['python3.12 -m pytest', 'runs python3.12 -m pytest with no test file, filter or case'],
  ['php8.3 vendor/bin/pest', 'runs php8.3 vendor/bin/pest with no test file, filter or case'],
  ['npm run ci', 'runs npm run ci with no test file, filter or case'],
  ['yarn test:unit', 'runs yarn test:unit with no test file, filter or case'],
  ['make check', 'runs make check, which runs the whole suite'],
  ['npx vitest --config vitest.config.test.ts', 'runs vitest with no test file, filter or case'],
  ['pytest --ignore x_test.py', 'runs pytest with no test file, filter or case'],
  ['docker run --rm -e A=1 img vendor/bin/pest', 'runs vendor/bin/pest with no test file, filter or case'],
  ['ssh -p 22 box "cd app && vendor/bin/pest"', 'runs vendor/bin/pest with no test file, filter or case'],
  ['docker compose exec app sh -c "php artisan test"', 'runs php artisan test with no test file, filter or case'],
  ['docker exec app bash -lc "vendor/bin/pest"', 'runs vendor/bin/pest with no test file, filter or case'],
  ["ssh box bash -c 'vendor/bin/pest'", 'runs vendor/bin/pest with no test file, filter or case'],
  ['docker exec app php vendor/bin/pest', 'runs php vendor/bin/pest with no test file, filter or case'],
  ['kubectl exec pod -- vendor/bin/pest', 'runs vendor/bin/pest with no test file, filter or case'],
  ['make ci', 'runs make ci, which runs the whole suite'],
  ['php -d x artisan test', 'runs php artisan test with no test file, filter or case'],
  ['node node_modules/.bin/jest', 'runs node node_modules/.bin/jest with no test file, filter or case'],
  ['pnpm -r test', 'runs pnpm test with no test file, filter or case'],
  ['pnpm --filter web test', 'runs pnpm test with no test file, filter or case'],
  ['npm --prefix web test', 'runs npm test with no test file, filter or case'],
  ['yarn workspace app test', 'runs yarn test with no test file, filter or case'],
]

const SCRIPTS: [string, string][] = [
  ['scripts/check.sh', 'runs scripts/check.sh, which loops over every file hooks/test-*.sh matches'],
  ['bash scripts/check.sh', 'runs scripts/check.sh, which loops over every file hooks/test-*.sh matches'],
  ['bash run.sh', 'runs run.sh, which runs vendor/bin/pest with no test file'],
  ['bash -o pipefail run.sh', 'runs run.sh, which runs vendor/bin/pest with no test file'],
  ['./run.sh', 'runs ./run.sh, which runs vendor/bin/pest with no test file'],
  ['bash scratch/wrap.sh', 'runs scratch/wrap.sh, which runs /repo/scripts/check.sh, which loops over every file hooks/test-*.sh matches'],
  ['bash run-tests.sh', 'runs run-tests.sh, which runs $f, a script whose path this gate cannot resolve'],
  ['python3 run.py', 'runs run.py, which names a test runner'],
  ['node -r dotenv/config suite.js', 'runs suite.js, which names a test runner'],
  ['node --require x suite.js', 'runs suite.js, which names a test runner'],
  ['python3 -I run.py', 'runs run.py, which names a test runner'],
  ['bash -O globstar run.sh', 'runs run.sh, which runs vendor/bin/pest with no test file'],
  [`python3 -c "import subprocess; subprocess.run(['pytest'])"`, 'runs python3 -c code that names a test runner'],
  ["python3 - <<'EOF'\nimport os; os.system('pytest')\nEOF", 'runs python3 - code that names a test runner'],
  [`node -e "require('child_process').execSync('npx jest')"`, 'runs node -e code that names a test runner'],
  ['bash -s', 'runs bash on a script from its standard input'],
  ['bash -es', 'runs bash on a script from its standard input'],
  ['bash hooks/test-loop.sh', 'runs hooks/test-loop.sh, which loops over every file hooks/test-*.sh matches'],
  ["python3 - <<'EOF'\nimport subprocess\nsubprocess.run(['pytest'])\nEOF", 'this call runs python3 - code that names a test runner'],
  ['bash scripts/suite.sh', 'runs scripts/suite.sh, which runs $DIR/lib/runner.sh, which runs vendor/bin/pest with no test file'],
  ['bash hooks/test-all.sh', 'runs hooks/test-all.sh, which runs vendor/bin/pest with no test file'],
  ['bash -c "vendor/bin/pest"', 'this call runs vendor/bin/pest with no test file'],
  ['bash <<EOF\nvendor/bin/pest\nEOF', 'this call runs vendor/bin/pest with no test file'],
  ['bash < run.sh', 'runs run.sh, which runs vendor/bin/pest with no test file'],
]

const UNREADABLE: [string, string][] = [
  ['bash missing.sh', 'a script this gate cannot read'],
  ['./missing.sh', 'a script this gate cannot read'],
  ['bash "$NOPE/x.sh"', 'a script whose path this gate cannot resolve'],
  ['bash "${CLAUDE_PLUGIN_ROOT}/scripts/x.sh"', 'a script this gate cannot read'],
  ['bash hooks/test-*.sh', 'a script whose path this gate cannot resolve'],
  ['python3 missing.py', 'a script this gate cannot read'],
  ['python3 -I missing.py', 'a script this gate cannot read'],
  ['deno run -A missing.ts', 'a script this gate cannot read'],
]

const NARROW = [
  'vendor/bin/pest tests/Unit/FooTest.php',
  'vendor/bin/pest tests/Unit/FooTest.php:12',
  'vendor/bin/pest --filter "it does x"',
  'php artisan test --filter=FooTest',
  'phpunit tests/FooTest.php',
  'npx vitest run src/a.test.ts',
  'npm test -- src/a.test.ts',
  'jest -t renders',
  'pytest tests/test_x.py::test_a',
  'pytest -k case',
  'node --test tests/a.test.mjs',
  'go test -run TestX ./pkg',
  'cargo test parses',
  'bash hooks/test-one.sh',
]

const ORDINARY = [
  'git status',
  'ls hooks/test-*.sh',
  'grep -n pest composer.json',
  'npm run build',
  'python3 tool.py',
  "python3 - <<'EOF'\nprint(1)\nEOF",
  'bin/tool --version',
  'bash scripts/status.sh',
  'bash <<EOF\necho hi\nEOF',
  'npm ci',
  'yarn ci',
  'pnpm ci',
  'composer install',
  'docker logs pytest',
  "find . -name '*.md' -exec grep -l pytest {} \\;",
  "docker run img grep 'npm test' f",
  'for f in latest-*; do ls "$f"; done',
  'bash hooks/test-latest.sh',
  'bash hooks/test-dirs.sh',
  'for d in inspector*/; do echo "$d"; done',
  'for f in tests/*Test.php; do echo "$f"; done',
  'make check-format',
  'make test-data',
  'make ci-lint',
  'bash --version',
  'sh --version',
  'node vitest.config.ts',
  'python3 lint.py',
  'uv run ruff check .',
  "perl -pe 's/a/b/' f.txt",
  "perl -lne 'print' f.txt",
  "ruby -ne 'puts 1' f.txt",
  'php -d memory_limit=-1 vendor/bin/phpunit --filter X',
  'vendor/bin/pest --version',
  'vendor/bin/phpunit --list-tests',
  'pytest --collect-only',
  'pytest -h',
  'npx jest --help',
  'vendor/bin/pest --init',
  'npx vitest -V',
  'npx jest --testPathPattern foo',
  'npx jest --testPathPatterns foo',
  'mocha -g renders',
  'node server.js --test',
  'php -S localhost:8000',
  'php -S 0.0.0.0:8000 -t public',
  'php -S localhost:8000 -t public',
  'deno run -A main.ts',
  'deno run --allow-net server.ts',
  `bash "$HOME/bin/ok.sh"`,
]

describe('the full-suite gate refuses the main agent a whole-suite run', () => {
  for (const [line, named] of RUNNERS) {
    test(`refuses ${JSON.stringify(line)}`, async ($, on) => {
      await session($, on)
      const reason = await refusal($, line)
      expect(reason?.startsWith(HEAD)).toBe(true)
      expect(reason).toContain(named)
    })
  }
})

describe('the full-suite gate reads the scripts the main agent runs', () => {
  for (const [line, named] of SCRIPTS) {
    test(`refuses ${JSON.stringify(line)}, a script that runs the suite`, async ($, on) => {
      await session($, on)
      const reason = await refusal($, line)
      expect(reason?.startsWith(HEAD)).toBe(true)
      expect(reason).toContain(named)
    })
  }
  for (const [line, why] of UNREADABLE) {
    test(`refuses ${JSON.stringify(line)}, a script it cannot read`, async ($, on) => {
      await session($, on)
      const reason = await refusal($, line)
      expect(reason?.startsWith(HEAD)).toBe(true)
      expect(reason).toContain(why)
    })
  }
})

describe('the full-suite gate lets a narrow run and an ordinary command through', () => {
  for (const line of [...NARROW, ...ORDINARY]) {
    test(`allows ${JSON.stringify(line)}`, async ($, on) => {
      await session($, on)
      expect(await refusal($, line)).toBeUndefined()
    })
  }
})

describe('the full-suite gate judges the main agent alone', () => {
  test('/orchestrator off stands the gate down, and on brings it back', async ($, on) => {
    const b = bench(on, { env: { HOME }, files: FILES })
    b.scripts['scratch-roots.sh'] = () => '/scratch\n'
    await $.session.start(start())
    expect(await refusal($, 'vendor/bin/pest')).toContain(HEAD)
    await $.command.run(run('orchestrator', 'off'))
    expect(await refusal($, 'vendor/bin/pest')).toBeUndefined()
    await $.command.run(run('orchestrator', 'on'))
    expect(await refusal($, 'vendor/bin/pest')).toContain(HEAD)
  })

  test('a lane it cannot read counts as the main agent', async ($, on) => {
    await session($, on)
    const result = await $.tool.call({ tool: 'Bash', command: 'vendor/bin/pest', agentId: 42 } as never)
    expect(result.deny).toContain(HEAD)
  })

  const lines = [...RUNNERS, ...SCRIPTS, ...UNREADABLE].map(([line]) => line)

  test('a sub-agent runs every line the main agent is refused', async ($, on) => {
    await session($, on)
    for (const line of lines) expect([line, await refusal($, line, AGENT)]).toEqual([line, undefined])
  })

  test('a top-level --agent run is not refused', async ($, on) => {
    await session($, on, { CLAUDE_CODE_AGENT: 'workbench-dev-team:watson' })
    expect(await refusal($, 'vendor/bin/pest')).toBeUndefined()
  })

  test('WORKBENCH_ORCHESTRATOR=0 stands the gate down', async ($, on) => {
    await session($, on, { WORKBENCH_ORCHESTRATOR: '0' })
    expect(await refusal($, 'vendor/bin/pest')).toBeUndefined()
  })
})

describe('the full-suite gate reads a script under the plugin root', () => {
  const PLUGIN = { CLAUDE_PLUGIN_ROOT: '/plugin' }
  const SKILL_LINES = [
    'bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup-config.sh" migrate',
    'bash "$CLAUDE_PLUGIN_ROOT/scripts/setup-config.sh" migrate',
    'python3 "${CLAUDE_PLUGIN_ROOT}/skills/memory-lint/scripts/check-frontmatter-health.py" "$MEMORY_PATH"',
    'WORKBENCH_LOG_MODE=manual bash "${CLAUDE_PLUGIN_ROOT}/hooks/session-log.sh" <<EOF\n{"session_id":"x"}\nEOF',
  ]
  for (const line of SKILL_LINES) {
    test(`allows the skill line ${JSON.stringify(line)}`, async ($, on) => {
      await session($, on, PLUGIN)
      expect(await refusal($, line)).toBeUndefined()
    })
  }

  test('a plugin-root script that does not exist is refused', async ($, on) => {
    await session($, on, PLUGIN)
    expect(await refusal($, 'bash "${CLAUDE_PLUGIN_ROOT}/scripts/missing.sh"')).toContain('runs ${CLAUDE_PLUGIN_ROOT}/scripts/missing.sh, a script this gate cannot read')
  })

  test('a plugin-root script that runs the suite is refused', async ($, on) => {
    await session($, on, PLUGIN)
    expect(await refusal($, 'bash "${CLAUDE_PLUGIN_ROOT}/scripts/check.sh"')).toContain('runs ${CLAUDE_PLUGIN_ROOT}/scripts/check.sh, which loops over every file hooks/test-*.sh matches')
  })

  test('with no CLAUDE_PLUGIN_ROOT in the environment, the plugin root is the module\'s own', async ($, on) => {
    const b = await session($, on)
    expect(await refusal($, 'git status')).toBeUndefined()
    const root = b.runs.map(argv => argv[1] ?? '').find(path => path.includes('/hooks/lib/'))?.split('/hooks/lib/')[0] ?? ''
    expect(root.startsWith('/')).toBe(true)
    expect(await refusal($, 'bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup-config.sh" migrate')).toContain('a script this gate cannot read')
    b.files.set(`${root}/scripts/setup-config.sh`, 'echo migrated\n')
    expect(await refusal($, 'bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup-config.sh" migrate')).toBeUndefined()
  })
})

describe('the full-suite gate finds a plugin-root script in another installed plugin', () => {
  const REGISTRY = JSON.stringify({ version: 2, plugins: { 'a@m': [{ installPath: '/plugins/a/1.0' }], 'b@m': [{ installPath: '/plugins/b/2.0' }] } })
  const PLUGINS: Record<string, string> = {
    '/config/plugins/installed_plugins.json': REGISTRY,
    '/plugins/a/1.0/bin/login.sh': 'echo login\n',
    '/plugins/a/1.0/bin/shared.sh': 'echo shared\n',
    '/plugins/b/2.0/bin/shared.sh': 'vendor/bin/pest\n',
    '/plugins/b/2.0/bin/suite.sh': 'for t in tests/test-*.sh; do bash "$t"; done\n',
  }
  const CONFIG = { CLAUDE_PLUGIN_ROOT: '/plugin', CLAUDE_CONFIG_DIR: '/config' }
  const withPlugins = async ($: Engine, on: Parameters<typeof bench>[0], env: Record<string, string>, files: Record<string, string>): Promise<Bench> => {
    const b = await session($, on, env)
    for (const [path, text] of Object.entries(files)) b.files.set(path, text)
    return b
  }

  test('a script only another plugin holds is judged by its contents and allowed', async ($, on) => {
    await withPlugins($, on, CONFIG, PLUGINS)
    expect(await refusal($, 'bash "${CLAUDE_PLUGIN_ROOT}/bin/login.sh"')).toBeUndefined()
  })

  test('a script another plugin holds that runs the suite is refused', async ($, on) => {
    await withPlugins($, on, CONFIG, PLUGINS)
    expect(await refusal($, 'bash "${CLAUDE_PLUGIN_ROOT}/bin/suite.sh"')).toContain('runs ${CLAUDE_PLUGIN_ROOT}/bin/suite.sh, which loops over every file tests/test-*.sh matches')
  })

  test('a script several plugins hold is refused when any of them runs the suite', async ($, on) => {
    await withPlugins($, on, CONFIG, PLUGINS)
    expect(await refusal($, 'bash "${CLAUDE_PLUGIN_ROOT}/bin/shared.sh"')).toContain('runs ${CLAUDE_PLUGIN_ROOT}/bin/shared.sh, which runs vendor/bin/pest with no test file')
  })

  test('a script no installed plugin holds is refused as unreadable', async ($, on) => {
    await withPlugins($, on, CONFIG, PLUGINS)
    expect(await refusal($, 'bash "${CLAUDE_PLUGIN_ROOT}/bin/nowhere.sh"')).toContain('runs ${CLAUDE_PLUGIN_ROOT}/bin/nowhere.sh, a script this gate cannot read')
  })

  test('the registry under the home folder counts when CLAUDE_CONFIG_DIR is unset', async ($, on) => {
    await withPlugins($, on, { CLAUDE_PLUGIN_ROOT: '/plugin' }, { ...PLUGINS, [`${HOME}/.claude/plugins/installed_plugins.json`]: REGISTRY })
    expect(await refusal($, 'bash "${CLAUDE_PLUGIN_ROOT}/bin/login.sh"')).toBeUndefined()
  })

  test('a registry that does not parse adds no plugin, so the script is refused as unreadable', async ($, on) => {
    await withPlugins($, on, CONFIG, { ...PLUGINS, '/config/plugins/installed_plugins.json': '{not json' })
    expect(await refusal($, 'bash "${CLAUDE_PLUGIN_ROOT}/bin/login.sh"')).toContain('a script this gate cannot read')
  })
})

describe('the full-suite deny says what it refused and the way through', () => {
  test('it names the run and sends the suite to Holmes', async ($, on) => {
    await session($, on)
    const reason = await refusal($, 'bash run.sh')
    expect(reason).toContain('this call runs run.sh, which runs vendor/bin/pest with no test file, filter or case, which is the whole suite.')
    expect(reason).toContain('Dispatch Holmes with a brief whose Goal begins "Final suite run:".')
    expect(reason).toContain('name one test file, a filter or one case')
  })
})
