import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'

import { hiddenCommandRefusal } from '../hooks/mods/guards.ts'
import type { FactHost } from '../hooks/mods/scope-facts.ts'
import { scopeOf } from '../hooks/mods/scope-facts.ts'
import { parseShell } from '../hooks/mods/shell.ts'
import { WORLD_DENIED } from './guard-corpus/world-cases.ts'

const [root = '', fallback = '', home = '', project = '', sessionId = '', every = '1'] = process.argv.slice(2)

const run = async ([command = '', ...args]: readonly string[]): Promise<{ exitCode: number; stdout: string }> => {
  const { status, stdout } = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] })
  return { exitCode: status ?? -1, stdout: stdout ?? '' }
}

const host: FactHost = { run, isFile: async path => statSync(path).isFile(), root }

async function modAnswer(line: string): Promise<string> {
  const parse = parseShell(line)
  if (hiddenCommandRefusal(parse) !== undefined) return ''
  const scope = await scopeOf(host, line, parse, home, { cwd: async () => project, ids: async () => ({ sessionId, project }) })
  return scope.kind === 'ask' || scope.kind === 'deny' ? `${scope.kind}|${scope.reason}` : ''
}

function fallbackAnswer(line: string): string {
  const payload = JSON.stringify({ session_id: sessionId, cwd: project, tool_name: 'Bash', tool_input: { command: line }, hook_event_name: 'PreToolUse' })
  const env = { PATH: process.env.PATH, HOME: home, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PROJECT_DIR: project, CLAUDE_CODE_ENTRYPOINT: 'cli' }
  const { stdout } = spawnSync(process.execPath, [fallback], { input: payload, encoding: 'utf8', timeout: 30_000, env })
  if (!stdout) return ''
  const out = (JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput
  return `${out.permissionDecision}|${out.permissionDecisionReason}`
}

const corpus = WORLD_DENIED.filter(c => c.guard === 'destructive-scope-guard')
  .map(c => (JSON.parse(c.payload) as { tool_input: { command: string } }).tool_input.command)
  .filter((_, index) => index % Number(every) === 0)
const lines = [...corpus, `rm -rf ${home}/outside/keep.txt`, `rm -rf ${project}/build`, 'ls -la', 'git status', `git -C ${home}/outside reset --hard`]
const kinds = new Set<string>()
let failed = 0
for (const line of lines) {
  const expected = await modAnswer(line)
  const actual = fallbackAnswer(line)
  kinds.add(expected.split('|')[0] || 'none')
  if (actual !== expected) {
    failed++
    process.stdout.write(`MISMATCH ${JSON.stringify(line)}\n  mod: ${expected}\n  fallback: ${actual}\n`)
  }
}
process.stdout.write(`${lines.length} lines, kinds ${[...kinds].sort().join(',')}, ${failed} mismatched\n`)
