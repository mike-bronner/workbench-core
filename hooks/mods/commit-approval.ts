// The check never decides which tool the model uses: it governs what a commit
// needs, and a command that only mentions git is let through.
//
// THE SHELL READER is hooks/mods/shell.ts, the one reader core and
// workbench-dev-team share through $.workbench.parseShell. This check reads a
// line through its commandsOf(): quotes, backslashes, separators, redirects
// dropped with their targets, $( ), backticks and <( ), and heredoc bodies
// taken out as bash takes them out. The rules here err toward finding a
// commit, so a doubt costs a "Commit it" question and never a commit nobody
// approved. A command is read past assignments, wrappers (env, sudo, nice,
// timeout, xargs, ...) up to the first word named git, `bash -c` and `eval`
// scripts, and git's global options, and `git` and its subcommand are matched
// without regard to case, as macOS finds `GIT` on its case-insensitive disk.
// A `-c alias.<name>=<value>` that names commit or push counts as that.
//
// A heredoc body is read as a script only when it feeds a shell or eval
// (`bash <<EOF`), and the $( ) and backticks of a body with an unquoted
// delimiter are read, as bash runs them.
//
// A word with any $'…' backslash escape is marked ESCAPED by the reader. Such
// a word as a command name, or among git's options and subcommand, counts as
// a commit and a push: `$'\x67it' push` is git push, and an escape the reader
// does not decode (\u, \U, \c) could spell anything.
//
// Where the line commits, it also says where: the `cd` and `pushd` targets
// before it, then git's -C values. hooks/register.ts reads HEAD there before
// and after the line, so the approval follows what the repository shows.
// A cd or pushd is recorded only in the one certain shape: the first word of a
// command before any && or || on a line with no pipe, no lone &, no ( or
// backtick and no heredoc, outside any shell -c script (eval keeps it), with a
// target that is absolute, under ~, or starts with ./ or ../, and dirOf then
// leaves any target holding `..` unknown. A bare relative
// target (`cd sub`) is always unknown, because CDPATH can redirect it, and a
// line can set CDPATH under a name built at run time. The cost is one new pick
// when a `cd sub; git commit` line also fails. A pushd counts only as
// `pushd <dir>`. The directory is UNKNOWN, which uses the approval up, when
// the line holds:
//   - any other cd or pushd, or any popd, source or . command word: behind
//     if, {, !, command or an assignment, in a pipeline (bash runs the stages
//     in children, zsh runs the last here), behind &, in a subshell, a
//     substitution, a heredoc, or a shell -c script
//   - GIT_DIR or GIT_WORK_TREE, --git-dir, --work-tree, env -C or --chdir
//   - a cd or -C target with a variable, a substitution, `-`, or an escape
//   - any `..` in a cd or -C target, which the shell and git resolve apart
//     when the directory before it is a symlink (dirOf)
//   - an escaped command word
//
// WHAT IT CANNOT SEE, by design, because the line does not say:
//   - an alias in a git config file (`git ci` with alias.ci = commit)
//   - commands that make commits without the word: merge, revert,
//     cherry-pick, am, rebase, pull, stash
//   - text piped into a shell (`echo git push | sh`, `cat <<EOF | sh`)
//   - a here-string's text (`sh <<< 'git push'`)
//   - a script file, an interpreter (`python -c`), or a shell function
// Those stay with the permission rules, dev-team's commit guard, and review.
//
// Pure functions only: the engine follows `$` into no imported function.

import type { WorkbenchShellStatement as ShellStatement } from '../../types'
import { hiddenCommandRefusal, isPartlyRead } from './guards'
import { ASSIGNMENT, GIT_VALUE_OPTIONS, KEYWORDS, SHELLS, WRAPPERS, commandsOf, decodedOf, expandingOf, isEscaped, isExpanded, nameOf, parseShell, shellScriptOf } from './shell'

export { commandsOf }

export const COMMIT_REFUSAL =
  'This git commit was refused: Mike has not approved it. A prompt of his own ' +
  'that asks for a commit or a release approves the commits of the turn it ' +
  'opened. Ask first for work he did not ask to commit. Once he says his ' +
  'review is done, ask the commit question through AskUserQuestion, alone, ' +
  'with the branch and the proposed message, and run the commit again after ' +
  'he picks "Commit it". One pick approves one commit and the push of that ' +
  'commit. Any prompt ends a pick not yet used for its commit.'

export const PUSH_REFUSAL =
  'This git push was refused: Mike has not approved it. A prompt of his own ' +
  'that asks for a push or a release approves the pushes of the turn it ' +
  'opened. Ask first for any other push. A "Commit it" pick approves one ' +
  'commit and the push of that commit, in that order. Mike\'s next prompt ends a push ' +
  'left by an approved commit.'

export const RELEASE_REFUSAL =
  'This release was refused: Mike has not asked for a release in this turn. ' +
  'Only a prompt of his own that asks for a release approves one, for the turn ' +
  'it opened. A "Commit it" pick approves no release. Ask first.'

export const AGENT_RELEASE_REFUSAL =
  'This release was refused: a sub-agent or a pipeline run does not publish a ' +
  'release. Only a prompt Mike types in his own session approves one. So no ' +
  'gh release command, releases endpoint or GraphQL Release mutation runs here. ' +
  'A gh line whose command or subcommand is not written as plain text, and a ' +
  'line the shell reader cannot read whole, are refused the same way, because ' +
  'either may spell one. If the work needs a release, report that it is ready, ' +
  'and leave it to the session that dispatched you. For any other gh command, ' +
  'write gh and its subcommand as plain words.'

export const ONE_REFUSAL =
  'This line runs more than one git commit, more than one git push, or more ' +
  'than one release. Run each as a line of its own. One "Commit it" pick ' +
  'approves one commit and the push of that commit, so ask first for each ' +
  'further commit that no request of Mike\'s covers.'

export const UNREAD_TREE_REFUSAL =
  'This git commit was refused: the gate cannot read which files it leaves ' +
  'out, because it cannot tell which repository the line commits in, or how ' +
  'the commit is spelled. Run the commit as a plain line of its own, such as ' +
  '`git -C <absolute repository path> commit -F <message file>`.'

export const PATHSPEC_REFUSAL =
  'This git commit was refused: it names paths or picks hunks, so it leaves ' +
  'the rest of the tree out. A commit takes every uncommitted file. Stage the ' +
  'whole tree with `git add -A` on a line of its own, then commit with no paths.'

export const SHARED_LINE_REFUSAL =
  'This git commit was refused: another git command on its line may change ' +
  'what is staged after the gate reads the tree, such as `git reset`, ' +
  '`git restore --staged` or `git rm --cached`. Run the commit on a line of ' +
  'its own, after the staging is done.'

export const leftOutRefusal =(paths: readonly string[]): string =>
  `This git commit was refused: it leaves these files out of the commit: ${paths.join(', ')}. ` +
  'A commit takes every uncommitted file in the tree, tracked changes and ' +
  'untracked files alike. Stage the whole tree with `git add -A` on a line of ' +
  'its own, then run the commit again. The one exception is content that must ' +
  'never ship, such as a secret or a stray build artifact. To leave such a ' +
  'file out, name its path to Mike in your reply, with the reason, before you ' +
  'run the commit again.'

export const BUNDLE_REFUSAL =
  'AskUserQuestion was refused: it offers a commit option beside another ' +
  'question. Ask the commit question alone, in an AskUserQuestion call of its ' +
  'own, and ask the other questions in a separate call.'

// The label that approves, as the git-commit skill prescribes it.
const APPROVAL = 'commit it'

// An option that offers a commit: its label leads with the word.
const COMMIT_OPTION = /^\s*commit\b/i

// Words that stand before the command they run: the shell reader's wrappers
// and keywords. After one, the command is the first later word named git, or
// a shell or eval to read again, so a wrapper's options and their values never
// hide it.
const WRAPPER_WORDS: ReadonlySet<string> = new Set([...Object.keys(WRAPPERS), ...KEYWORDS])

// How many commits and pushes a command or a line runs.
export type Writes = { commits: number; pushes: number }

const NONE: Writes = { commits: 0, pushes: 0 }
const sum = (a: Writes, b: Writes): Writes => ({ commits: a.commits + b.commits, pushes: a.pushes + b.pushes })

// Past this depth of nested scripts, a line is taken as a commit.
const MAX_DEPTH = 4

// What a line runs, as the reader walks it: the commits and pushes, the
// directories `cd` and `pushd` moved to so far, and where the first commit or
// push runs: the steps from the session's directory (`cd` targets, then git's
// -C values), null when a step is a substitution or a variable the reader
// cannot follow, and undefined until a commit or push is found.
export type Commit = { dir: readonly string[] | null; args: readonly string[] | null }
export type Line = { writes: Writes; dir: readonly string[] | null | undefined; commit?: Commit }
// `isUnfollowed` is set by any directory change the walk does not record.
// `isCompat` reads the line as the gate before the shared reader did (readLine).
type Walk = { writes: Writes; cds: string[]; dir: string[] | null | undefined; commit?: Commit; isUnfollowed: boolean; isCompat: boolean }

// The command words that move the shell or change its environment: a
// directory change, or a sourced file, which may set GIT_DIR.
const PLACE_WORDS: ReadonlySet<string> = new Set(['cd', 'pushd', 'popd', 'source', '.'])

// Whether words[i] is a command word: every word before it is an assignment,
// a wrapper or keyword (if, {, !, command, ...), or an option.
const isCommandWord = (words: readonly string[], i: number): boolean =>
  words.slice(0, i).every(word => ASSIGNMENT.test(word) || WRAPPER_WORDS.has(nameOf(word)) || word.startsWith('-'))

// Whether every command of a line runs in this shell, one after another: no
// pipe and no lone & (bash runs those stages in a child, and zsh runs the
// last one here), and no ( or backtick, which may open a subshell or a
// substitution, and no heredoc, whose body may feed a child shell. A | or &
// inside quotes counts too, which only costs a recorded cd.
const isSimpleLine = (line: string): boolean =>
  !/[(`]/.test(line) && !line.includes('<<') && !/[|&]/.test(line.replace(/\|\||&&|[<>]&|&>/g, ''))

const BOTH: Writes = { commits: 1, pushes: 1 }

// A step the reader cannot follow: the directory is then unknown, which counts
// as done.
const UNKNOWN = '$'

// What moves git to a repository the steps do not show.
const GIT_PLACE = /^GIT_(DIR|WORK_TREE)=/
const GIT_PLACE_OPTION = /^--(git-dir|work-tree)(=|$)/
const ENV_CHDIR = /^(-[A-Za-z]*C|--chdir(=|$))/

const stepsOf = (steps: string[]): string[] | null =>
  steps.some(step => step.includes('$') || step === '-' || isEscaped(step)) ? null : steps

function found(walk: Walk, writes: Writes, steps: string[], args: readonly string[] | null = null): void {
  walk.writes = sum(walk.writes, writes)
  if (walk.dir === undefined) walk.dir = stepsOf(steps)
  if (writes.commits > 0 && walk.commit === undefined) walk.commit = { dir: stepsOf(steps), args }
}

// One simple command, behind any wrapper, assignment, shell script or global
// option. `isHere` says the command surely runs in this shell, in order: its
// line is simple (isSimpleLine) and not inside a shell -c script. eval keeps
// it, as eval runs in this shell.
function walkCommand(words: readonly string[], depth: number, isHere: boolean, walk: Walk): void {
  // GIT_DIR or GIT_WORK_TREE, as a prefix, through env, or exported, points
  // git elsewhere for this command or for the rest of the line.
  if (words.some(word => GIT_PLACE.test(word))) walk.cds.push(UNKNOWN)
  // THE DIRECTORY RULE. A cd or pushd is recorded only as the first word of a
  // command that surely runs in this shell, before any && or || on its line,
  // with a target that is absolute, under ~, or starts with ./ or ../. A bare
  // relative target (`cd sub`) is always unknown, because CDPATH can redirect
  // it and the line can set CDPATH under a name built at run time. A pushd
  // that is not `pushd <dir>` (no target, +N, -N or an option rotates the
  // stack or stays put) is unknown too. Every other cd, pushd, popd, source or . in a
  // command-word place leaves the directory unknown: behind if, {, !, command
  // or an assignment, in a pipeline, behind &, in a subshell, a substitution,
  // a heredoc or a shell -c script.
  const placeAt = words.findIndex((word, j) => PLACE_WORDS.has(nameOf(word)) && isCommandWord(words, j))
  const head = nameOf(words[0] ?? '')
  if (placeAt === 0 && isHere && !isEscaped(words[0] ?? '') && (head === 'cd' || head === 'pushd')) {
    const target = words.slice(1).find(word => !word.startsWith('-') || word === '-') ?? '~'
    const isPlainPushd = words.length === 2 && !/^[+-]/.test(words[1] ?? '')
    const isUnknown = isBareRelative(target) || (head === 'pushd' && !isPlainPushd)
    walk.cds.push(isUnknown ? UNKNOWN : target)
    return
  }
  if (placeAt !== -1) walk.isUnfollowed = true
  let i = 0
  while (i < words.length) {
    const word = words[i] as string
    const name = nameOf(word)
    if (ASSIGNMENT.test(word)) {
      i++
    } else if (isEscaped(word)) {
      // A command name with an escape may be git, a shell, or a cd.
      walk.isUnfollowed = true
      found(walk, BOTH, [...walk.cds])
      return
    } else if (name === 'eval') {
      walkLine(words.slice(i + 1).join(' '), depth + 1, isHere, walk)
      return
    } else if (SHELLS.has(name)) {
      // The script is the first operand after the options, when an option
      // cluster holds `c` (shellScriptOf, which `--` and -o values do not
      // fool). A shell with none runs a file. The script runs in a child
      // shell, so no cd in it moves this one. The compat reading takes the
      // word after the first option holding `c`, as the gate before did.
      const at = words.findIndex((option, j) => j > i && /^-[^-]*c/.test(option))
      // FROZEN compat branch: delete only, once the bash/zsh check retires compat.
      const script = walk.isCompat ? (at === -1 ? undefined : (words[at + 1] ?? '')) : shellScriptOf(words.slice(i + 1)).script
      if (script !== undefined) walkLine(script, depth + 1, false, walk)
      return
    } else if (WRAPPER_WORDS.has(name)) {
      const at = words.findIndex((later, j) => j > i && (isEscaped(later) || ['git', 'eval', ...SHELLS].includes(nameOf(later))))
      if (at === -1) return
      if (name === 'env' && words.slice(i + 1, at).some(option => ENV_CHDIR.test(option))) walk.cds.push(UNKNOWN)
      i = at
    } else {
      break
    }
  }
  if (nameOf(words[i] ?? '') !== 'git') return
  const steps = [...walk.cds]
  let aliased: Writes = NONE
  for (i++; i < words.length; i++) {
    const word = words[i] as string
    // An escaped option or subcommand may spell commit, push, or -C.
    if (isEscaped(word)) {
      found(walk, BOTH, steps)
      return
    }
    if (!word.startsWith('-')) {
      const sub = word.toLowerCase()
      if (sub === 'commit') found(walk, { commits: 1, pushes: 0 }, steps, words.slice(i + 1))
      else if (sub === 'push') found(walk, { commits: 0, pushes: 1 }, steps)
      else if (aliased !== NONE) found(walk, aliased, steps)
      return
    }
    if (word === '-C') steps.push(words[i + 1] ?? UNKNOWN)
    if (GIT_PLACE_OPTION.test(word)) steps.push(UNKNOWN)
    if (word === '-c') {
      // `-c alias.ci=commit` makes `ci` a commit. The alias's name is not
      // matched against the subcommand: naming commit or push is enough.
      const value = /^alias\.[^=]*=(.*)$/is.exec(words[i + 1] ?? '')?.[1] ?? ''
      if (/\bcommit\b/i.test(value)) aliased = sum(aliased, { commits: 1, pushes: 0 })
      if (/\bpush\b/i.test(value)) aliased = sum(aliased, { commits: 0, pushes: 1 })
    }
    if (GIT_VALUE_OPTIONS.has(word)) i++
  }
  if (aliased !== NONE) found(walk, aliased, steps)
}

// How many commands of a line come before its first && or ||: those surely
// run. A command after one may be skipped, so a cd there is not certain. The
// cut is read on the raw text, so a && inside quotes cuts early, which only
// costs a recorded cd: a cut text never holds more commands than the line.
// FROZEN compat branch: delete only, once the bash/zsh check retires compat.
function certainCount(line: string, isCompat: boolean): number {
  const cut = line.search(/&&|\|\|/)
  // FROZEN compat branch: delete only, once the bash/zsh check retires compat.
  return cut === -1 ? Infinity : commandsOf(line.slice(0, cut), isCompat).length
}

function walkLine(line: string, depth: number, isHere: boolean, walk: Walk): void {
  if (depth > MAX_DEPTH) {
    found(walk, { commits: 1, pushes: 0 }, [UNKNOWN])
    return
  }
  const isHereLine = isHere && isSimpleLine(line)
  // FROZEN compat branch: delete only, once the bash/zsh check retires compat.
  const certain = certainCount(line, walk.isCompat)
  // FROZEN compat branch: delete only, once the bash/zsh check retires compat.
  commandsOf(line, walk.isCompat).forEach((words, at) => walkCommand(words, depth, isHereLine && at < certain, walk))
}

// Whether a cd target may resolve through CDPATH: a relative path that does
// not start with /, ~, ./ or ../ (`-`, the previous directory, is unknown
// through stepsOf).
const isBareRelative = (target: string): boolean => !/^(\/|~|\.\.?(\/|$)|-$)/.test(target)

// What a Bash command line runs: its commits and pushes, and where. A
// directory change the walk did not record (walkCommand's directory rule)
// leaves the directory unknown, which uses the approval up.
//
// The line is read twice: as bash reads it, and as the gate of 77bb2f3 read
// it, before the shared reader read bash more exactly (commandsOf's
// isCompat). The larger count of each is kept, so the gate never finds fewer
// commits than that one did. When the two readings differ, the directory is
// unknown.
export function readLine(line: string): Line {
  // FROZEN compat branch: delete only, once the bash/zsh check retires compat.
  const [exact, compat] = [false, true].map(isCompat => {
    // FROZEN compat branch: delete only, once the bash/zsh check retires compat.
    const walk: Walk = { writes: NONE, cds: [], dir: undefined, isUnfollowed: false, isCompat }
    walkLine(line, 0, true, walk)
    const commit = walk.commit && (walk.isUnfollowed ? { ...walk.commit, dir: null } : walk.commit)
    return { writes: walk.writes, dir: walk.isUnfollowed && walk.dir !== undefined ? null : walk.dir, ...(commit ? { commit } : {}) }
  }) as [Line, Line]
  const writes = { commits: Math.max(exact.writes.commits, compat.writes.commits), pushes: Math.max(exact.writes.pushes, compat.writes.pushes) }
  const isSame = JSON.stringify(exact) === JSON.stringify(compat)
  const commit = writes.commits === 0 ? {} : { commit: isSame && exact.commit ? exact.commit : { dir: null, args: null } }
  return { writes, dir: isSame ? exact.dir : writes.commits + writes.pushes > 0 ? null : undefined, ...commit }
}

// How many commits and pushes a Bash command line runs.
export const writesOf = (line: string): Writes => readLine(line).writes

// The directory `steps` lead to from the session's `cwd`, or undefined when
// they cannot be followed: a substitution, a variable, `cd -`, a `~` with no
// home to expand it, or any `..`. The shell resolves `..` by the path as
// written (`./link/..` is `.`), while git -C, and so the refs read there,
// resolves it through the real path, so the two can land in different
// repositories whenever the directory before it is a symlink: a named step,
// the session's directory (a session in /tmp is in /private/tmp), or $HOME.
export function dirOf(steps: readonly string[] | null | undefined, cwd: string, home: string | undefined): string | undefined {
  if (steps === null) return undefined
  let dir = cwd
  for (const step of steps ?? []) {
    let path = step
    if (path === '~' || path.startsWith('~/')) {
      if (!home) return undefined
      path = `${home}${path.slice(1)}`
    } else if (path.startsWith('~')) {
      return undefined
    }
    if (step.split('/').includes('..')) return undefined
    dir = path.startsWith('/') ? path : `${dir.replace(/\/+$/, '')}/${path}`
  }
  return dir
}

// Where the approval stands: `none`, a pick not yet used (`commit`), or a
// commit made under the pick, whose push is still allowed (`push`).
export type Approval = 'none' | 'commit' | 'push'

// Why a line that commits or pushes is refused at this approval, or undefined
// when it may run.
export function refusalOf(writes: Writes, releases: number, approval: Approval, request: readonly Action[]): string | undefined {
  if (writes.commits > 1 || writes.pushes > 1 || releases > 1) return ONE_REFUSAL
  if (releases === 1 && !request.includes('release')) return RELEASE_REFUSAL
  if (writes.commits === 1 && approval !== 'commit' && !grants(request, 'commit')) return COMMIT_REFUSAL
  const isPickPush = approval === 'push' || (approval === 'commit' && writes.commits === 1)
  if (writes.pushes === 1 && !isPickPush && !grants(request, 'push')) return PUSH_REFUSAL
  return undefined
}

export type Action = 'commit' | 'push' | 'release'

const grants = (request: readonly Action[], action: 'commit' | 'push'): boolean => request.includes(action) || request.includes('release')

export const pickWritesOf = (writes: Writes, request: readonly Action[]): Writes => ({
  commits: grants(request, 'commit') ? 0 : writes.commits,
  pushes: grants(request, 'push') ? 0 : writes.pushes,
})

const RELEASE_API = /(^|\/)releases(\/|$|\?)/
const API_WRITE = /^(-x|--method|-f|--field|--raw-field|--input)(=|$)|^-[xf]\S/
const RELEASE_MUTATION = /createrelease/
const isExpansion = (word: string): boolean => /[$`]/.test(word)

const ghWordsOf = (st: ShellStatement): string[] | undefined => {
  const at = st.words.findIndex(word => nameOf(word) === 'gh')
  return at === -1 ? undefined : st.words.slice(at + 1).map(word => word.toLowerCase())
}

const isRelease = (rest: readonly string[], line: string): boolean => {
  const sub = rest.indexOf('release')
  if (sub !== -1 && rest.slice(sub + 1).includes('create')) return true
  if (!rest.includes('api')) return false
  if (rest.includes('graphql') && /createrelease/i.test(line)) return true
  return (rest.some(word => RELEASE_API.test(word)) && rest.some(word => API_WRITE.test(word))) || rest.some(word => RELEASE_MUTATION.test(word))
}

const GH_LONG_VALUES: ReadonlySet<string> = new Set([
  '--repo', '--hostname', '--method', '--field', '--raw-field', '--header', '--input', '--jq', '--template', '--cache', '--preview',
])
const GH_SHORT_VALUES: ReadonlySet<string> = new Set(['R', 'X', 'H', 'f', 'F', 'q', 't', 'p'])
const GH_FIELDS: ReadonlySet<string> = new Set(['-f', '-F', '--field', '--raw-field'])
const REFUSED_GROUPS: ReadonlySet<string> = new Set(['release', 'alias', 'extension', 'extensions', 'ext'])
const BRACE_EXPANSION = /\{[^{}]*(,|\.\.)[^{}]*\}/
const GLOB = /[*?[]/
const RELEASE_MUTATION_NAME = /[a-z_]release\s*[({]/i
const PLAIN_OPTION = /^--?[A-Za-z][A-Za-z0-9-]*$/

type GhOption = { name: string; value?: string; valueAt?: number }

function readGh(args: readonly string[]): { options: GhOption[]; positionals: number[] } {
  const options: GhOption[] = []
  const positionals: number[] = []
  for (let i = 0; i < args.length; i++) {
    const word = args[i] ?? ''
    if (word === '--') {
      for (let k = i + 1; k < args.length; k++) positionals.push(k)
      break
    }
    if (word.startsWith('--')) {
      const eq = word.indexOf('=')
      const name = (eq === -1 ? word : word.slice(0, eq)).toLowerCase()
      if (eq !== -1) options.push({ name, value: word.slice(eq + 1), valueAt: i })
      else if (GH_LONG_VALUES.has(name)) options.push({ name, value: args[i + 1] ?? '', valueAt: ++i })
      else options.push({ name })
      continue
    }
    if (!word.startsWith('-') || word === '-') {
      positionals.push(i)
      continue
    }
    for (let k = 1; k < word.length; k++) {
      const letter = word[k] as string
      if (!GH_SHORT_VALUES.has(letter)) {
        options.push({ name: `-${letter}` })
        continue
      }
      const rest = word.slice(k + 1)
      options.push(rest === '' ? { name: `-${letter}`, value: args[i + 1] ?? '', valueAt: ++i } : { name: `-${letter}`, value: rest, valueAt: i })
      break
    }
  }
  return { options, positionals }
}

const optionHeadOf = (word: string): string => {
  if (word.startsWith('--')) return word.split('=')[0] ?? ''
  for (let k = 1; k < word.length; k++) {
    if (!/[A-Za-z]/.test(word[k] as string) || GH_SHORT_VALUES.has(word[k] as string)) return word.slice(0, k + 1)
  }
  return word
}

const takesNextValue = (word: string): boolean => {
  if (word.startsWith('--')) return !word.includes('=') && GH_LONG_VALUES.has(word.toLowerCase())
  return GH_SHORT_VALUES.has(word.at(-1) ?? '') && optionHeadOf(word) === word
}

const plainOf = (st: ShellStatement): ((at: number) => boolean) => {
  const expanding = expandingOf(st)
  const decoded = decodedOf(st)
  return at => {
    const word = st.words[at] ?? ''
    const expands = expanding === undefined ? isExpansion(word) : expanding.includes(at)
    const isDecoded = decoded === undefined || decoded.includes(at)
    return !expands && !isDecoded && !st.escaped.includes(at) && !BRACE_EXPANSION.test(word) && !GLOB.test(word)
  }
}

const hasPlainCommand = (st: ShellStatement): boolean => {
  const isPlain = plainOf(st)
  if (!isPlain(st.nameAt)) return false
  const end = st.subcommandAt === -1 ? st.args.length - 1 : st.subcommandAt
  for (let j = 0; j <= end; j++) {
    const word = st.args[j] ?? ''
    if (!word.startsWith('-') || word === '-') {
      if (!isPlain(st.nameAt + 1 + j)) return false
      continue
    }
    if (st.escaped.includes(st.nameAt + 1 + j) || !PLAIN_OPTION.test(optionHeadOf(word))) return false
    if (takesNextValue(word)) j++
  }
  return true
}

const mayRunGh = (st: ShellStatement, isAgent: boolean): boolean => {
  if (st.nameAt === -1 || st.words[st.nameAt] === '[' || st.words[st.nameAt] === '[[') return false
  if (st.name === 'gh') return true
  const word = st.words[st.nameAt] ?? ''
  if (st.escaped.includes(st.nameAt) && word.includes('\\')) return true
  if (BRACE_EXPANSION.test(word)) return /g/i.test(word) && /h/i.test(word)
  return isAgent && GLOB.test(word)
}

const groupOf = (st: ShellStatement): string => (st.subcommandAt === -1 ? '' : (st.args[st.subcommandAt] ?? '').toLowerCase())

const apiOf = (st: ShellStatement) => {
  const { options, positionals } = readGh(st.args)
  const endpointAt = positionals[1]
  const methods = options.filter(option => option.name === '-X' || option.name === '--method')
  const fields = options.filter(option => GH_FIELDS.has(option.name))
  const canWrite = methods.some(method => (method.value ?? '').toUpperCase() !== 'GET') || fields.length > 0 || options.some(option => option.name === '--input')
  return { endpointAt, endpoint: endpointAt === undefined ? '' : (st.args[endpointAt] ?? ''), methods, fields, options, canWrite }
}

const isHiddenApiCall = (st: ShellStatement): boolean => {
  const isPlain = plainOf(st)
  const hidden = (j: number | undefined) => j !== undefined && !isPlain(st.nameAt + 1 + j)
  const api = apiOf(st)
  if (api.canWrite && hidden(api.endpointAt)) return true
  if (api.methods.some(method => hidden(method.valueAt))) return true
  const expanding = expandingOf(st)
  const expands = (j: number | undefined) => j !== undefined && (expanding === undefined ? isExpansion(st.args[j] ?? '') : expanding.includes(st.nameAt + 1 + j))
  return /graphql/i.test(api.endpoint) && api.fields.some(field => /^query=/i.test(field.value ?? '') && expands(field.valueAt))
}

const isAgentApiRelease = (st: ShellStatement, line: string): boolean => {
  const api = apiOf(st)
  if (RELEASE_API.test(api.endpoint.toLowerCase())) return true
  if (/\bmutation\b/i.test(line) && RELEASE_MUTATION_NAME.test(line)) return true
  if (!/graphql/i.test(api.endpoint)) return false
  if (/\\u[0-9a-f]{4}/i.test(line)) return true
  if (api.options.some(option => option.name === '--input') && st.heredocs.length === 0) return true
  return api.fields.some(field => /(^|=)@/.test(field.value ?? ''))
}

const isAgentRisk = (st: ShellStatement, line: string): boolean => {
  if (!mayRunGh(st, true)) return false
  if (st.name !== 'gh' || !hasPlainCommand(st)) return true
  const group = groupOf(st)
  if (REFUSED_GROUPS.has(group)) return true
  return group === 'api' && (isHiddenApiCall(st) || isAgentApiRelease(st, line))
}

const isPlainRelease = (st: ShellStatement, line: string): boolean => {
  const rest = ghWordsOf(st)
  return rest !== undefined && isRelease(rest, line)
}

const isUnreadRelease = (st: ShellStatement, line: string): boolean => {
  if (!mayRunGh(st, false)) return false
  if (st.name !== 'gh' || !hasPlainCommand(st)) return true
  if (isRelease(st.args.map(word => word.toLowerCase()), line)) return false
  const verbAt = st.subcommandAt + 1
  return groupOf(st) === 'release' && verbAt < st.args.length && !plainOf(st)(st.nameAt + 1 + verbAt)
}

const isPlainReleaseCreate = (st: ShellStatement): boolean => hasPlainCommand(st) && plainOf(st)(st.nameAt + 2)

export function releasesOf(line: string): number {
  return parseShell(line).statements.filter(st => isPlainRelease(st, line)).length
}

export function unreadReleasesOf(line: string): number {
  return parseShell(line).statements.filter(st => isUnreadRelease(st, line)).length
}

export function releaseCountOf(line: string): number {
  return parseShell(line).statements.filter(st => isPlainRelease(st, line) || isUnreadRelease(st, line)).length
}

export const UNREAD_LINE_REFUSAL =
  'Workbench guards (workbench-core): the shell reader cannot read all of this line, such as an escape it ' +
  'does not decode, a substitution left open, or scripts nested too deep, so no guard can tell what it runs. ' +
  'Write the line out plainly, with every escape, quote and substitution closed, and run it again.'

export function agentReleaseRefusalOf(line: string): string | undefined {
  const parse = parseShell(line)
  if (releasesOf(line) > 0 || parse.statements.some(st => isAgentRisk(st, line))) return AGENT_RELEASE_REFUSAL
  return isPartlyRead(parse) && hiddenCommandRefusal(parse) === undefined && parse.statements.some(st => mayRunGh(st, true)) ? AGENT_RELEASE_REFUSAL : undefined
}

export function agentUnreadRefusalOf(line: string): string | undefined {
  const parse = parseShell(line)
  return isPartlyRead(parse) && hiddenCommandRefusal(parse) === undefined ? UNREAD_LINE_REFUSAL : undefined
}

const LEAD_WORDS: ReadonlySet<string> = new Set([
  'please', 'pls', 'plz', 'ok', 'okay', 'yes', 'yep', 'yeah', 'sure', 'great', 'good', 'cool', 'nice', 'perfect',
  'awesome', 'excellent', 'thanks', 'thank', 'you', 'alright', 'all', 'right', 'now', 'so', 'and', 'then', 'also',
  'just', 'go', 'ahead', 'lgtm', 'looks', 'fine', 'done', 'finally', 'next',
])
const OBJECT_STARTS: ReadonlySet<string> = new Set(['it', 'this', 'that', 'these', 'those', 'them', 'everything', 'all', 'origin', 'main', 'master', 'again'])
const MAX_REQUEST_LINES = 5
const MAX_REQUEST_WORDS = 80
const CONNECTORS: ReadonlySet<string> = new Set(['and', 'then', '&', '+', 'also', 'finally', 'please', 'now'])
const RELEASE_VERBS: ReadonlySet<string> = new Set(['cut', 'create', 'make', 'do', 'publish', 'ship', 'tag'])
const ACTION_WORD = /\b(commit(s|ted|ting)?|push(es|ed|ing)?|releas(e|es|ed|ing))\b/i
const VETO_WORD =
  /\b(not|no|never|nothing|don't|dont|do not|doesn't|didn't|won't|wouldn't|shouldn't|can't|cannot|without|later|yet|after|afterwards|before|once|when|whenever|until|till|unless|if|whether|should|would|could|might|may|maybe|perhaps|wait|hold|tomorrow|soon|eventually|instead)\b/i

const verbAt = (words: readonly string[], i: number): [Action, number] | undefined => {
  const word = words[i]
  if (word === 'commit' || word === 'push' || word === 'release') return [word, i + 1]
  if (!RELEASE_VERBS.has(word ?? '')) return undefined
  let k = i + 1
  while (['a', 'the', 'new'].includes(words[k] ?? '')) k++
  return words[k] === 'release' ? ['release', k + 1] : undefined
}

const actionsOf = (words: readonly string[]): Action[] =>
  words.flatMap((word, i) => {
    const verb = verbAt(words, i)
    const before = words.slice(0, i)
    if (verb === undefined || !(before.every(lead => LEAD_WORDS.has(lead)) || CONNECTORS.has(words[i - 1] ?? ''))) return []
    const after = words[verb[1]]
    return after === undefined || CONNECTORS.has(after) || OBJECT_STARTS.has(after) || /^v?\d/.test(after) ? [verb[0]] : []
  })

export function requestedOf(prompt: string): Action[] {
  const text = prompt
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/<([a-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/[’‘]/g, "'")
    .replace(/"[^"\n]*"|“[^”\n]*”|`[^`\n]*`/g, ' ')
  if (text.split('\n').filter(line => line.trim() !== '').length > MAX_REQUEST_LINES) return []
  if (text.split(/\s+/).filter(Boolean).length > MAX_REQUEST_WORDS) return []
  const actions = new Set<Action>()
  for (const sentence of text.split(/\n|;|(?<=[.!?])\s/)) {
    for (const clause of sentence.split(/,|\b(?:but|however|though|although|except)\b/i)) {
      if (!ACTION_WORD.test(clause)) continue
      if (sentence.includes('?') || VETO_WORD.test(sentence)) return []
      for (const action of actionsOf(clause.toLowerCase().match(/[a-z0-9'_\-/]+(?:\.[a-z0-9]+)*|[&+]/g) ?? [])) actions.add(action)
    }
  }
  return [...actions]
}

export type RequestedCall = { action: 'commit'; dir?: string } | { action: 'push'; dir?: string; remote?: string; ref?: string } | { action: 'release' }

const PLAIN_COMMIT_VALUES: ReadonlySet<string> = new Set(['-m', '--message', '-F', '--file', '-am'])
const PLAIN_COMMIT_FLAGS: ReadonlySet<string> = new Set(['-a', '--all', '-q', '--quiet'])

const isPlainCommit = (args: readonly string[]): boolean => {
  for (let i = 0; i < args.length; i++) {
    const word = args[i] as string
    if (PLAIN_COMMIT_VALUES.has(word)) {
      if (args[++i] === undefined) return false
    } else if (!PLAIN_COMMIT_FLAGS.has(word) && !/^--(message|file)=./.test(word)) {
      return false
    }
  }
  return true
}

const isPlainRef = (word: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(word) && !word.split('/').includes('..')

const gitDirOf = (globals: readonly string[]): string | undefined | null => {
  if (globals.length === 0) return undefined
  const [option, dir = ''] = globals
  return globals.length === 2 && option === '-C' && dir.startsWith('/') && !hasDotStep(dir) ? dir : null
}

const hasDotStep = (path: string): boolean => path.split('/').some(part => part === '.' || part === '..')

const callOf = (st: ShellStatement): RequestedCall | undefined => {
  const isPlain =
    st.depth === 0 && st.nameAt === 0 && st.isPlaced && st.escaped.length === 0 && st.redirects.length === 0 && st.heredocs.length === 0 && !st.words.some(isExpanded)
  if (!isPlain) return undefined
  if (st.name === 'gh') {
    const [group, verb] = st.args
    const isOtherRepo = st.args.some(arg => /^(-R|--repo)/.test(arg))
    return st.subcommandAt === 0 && group === 'release' && verb === 'create' && !isOtherRepo && isPlainReleaseCreate(st) ? { action: 'release' } : undefined
  }
  if (st.name !== 'git' || st.subcommandAt < 0) return undefined
  const dir = gitDirOf(st.args.slice(0, st.subcommandAt))
  if (dir === null) return undefined
  const sub = st.args[st.subcommandAt]
  const rest = st.args.slice(st.subcommandAt + 1)
  const at = dir === undefined ? {} : { dir }
  if (sub === 'commit') return isPlainCommit(rest) ? { action: 'commit', ...at } : undefined
  if (sub !== 'push') return undefined
  if (rest.length === 0) return { action: 'push', ...at }
  const [remote = '', ref = ''] = rest
  return rest.length === 2 && isPlainRef(remote) && isPlainRef(ref) ? { action: 'push', ...at, remote, ref } : undefined
}

export function requestedCallsOf(line: string, request: readonly Action[]): RequestedCall[] | undefined {
  const parse = parseShell(line)
  if (parse.unknowns.length > 0 || parse.statements.length === 0) return undefined
  const calls = parse.statements.map(callOf)
  const isNamed = (call: RequestedCall | undefined): call is RequestedCall =>
    call !== undefined && (call.action === 'release' ? request.includes('release') : grants(request, call.action))
  return calls.every(isNamed) ? calls : undefined
}

const INDEX_SAFE: ReadonlySet<string> = new Set(['commit', 'add', 'push', 'status', 'diff', 'log', 'show', 'rev-parse'])

export function changesIndexBeside(line: string): boolean {
  return parseShell(line).statements.some(st => {
    const at = st.words.findIndex(word => nameOf(word) === 'git')
    if (at === -1) return false
    const sub = st.name === 'git' && st.subcommandAt >= 0 ? st.args[st.subcommandAt]?.toLowerCase() : undefined
    return sub === undefined || !INDEX_SAFE.has(sub)
  })
}

const COMMIT_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-m', '--message', '-F', '--file', '-C', '--reuse-message', '-c', '--reedit-message', '--author', '--date', '-t',
  '--template', '--cleanup', '--fixup', '--squash', '--trailer',
])
const PARTIAL_OPTIONS = ['--pathspec-from-file', '--patch', '--interactive', '--only', '--include']
const isPartialOption = (word: string): boolean => /^--[^=]/.test(word) && PARTIAL_OPTIONS.some(option => option.startsWith(word.split('=')[0] as string))

export function shapeOf(args: readonly string[]): { isAll: boolean; isPartial: boolean } {
  let isAll = false
  for (let i = 0; i < args.length; i++) {
    const word = args[i] as string
    if (word === '--') return { isAll, isPartial: i + 1 < args.length }
    if (!word.startsWith('-') || word === '-' || isPartialOption(word)) return { isAll, isPartial: true }
    if (word === '--all') isAll = true
    if (word.startsWith('--')) {
      if (COMMIT_VALUE_OPTIONS.has(word)) i++
      continue
    }
    for (let k = 1; k < word.length; k++) {
      const flag = word[k] as string
      if (flag === 'a') isAll = true
      if ('oip'.includes(flag)) return { isAll, isPartial: true }
      if ('mFCct'.includes(flag)) {
        if (k === word.length - 1) i++
        break
      }
      if ('Su'.includes(flag)) break
    }
  }
  return { isAll, isPartial: false }
}

export function leftOutOf(status: string, isAll: boolean): string[] {
  const fields = status.split('\0')
  const paths: string[] = []
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i] as string
    if (entry.length < 4) continue
    const [x, y, path] = [entry[0] as string, entry[1] as string, entry.slice(3)]
    if ('RC'.includes(x) || 'RC'.includes(y)) i++
    const isTaken = y === ' ' || (isAll && x !== '?' && 'MDT'.includes(y))
    if (!isTaken) paths.push(path)
  }
  return paths
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function unnamedOf(paths: readonly string[], shown: string): string[] {
  return paths.filter(path => {
    const parts = path.split('/')
    const names = [path, ...parts.slice(0, -1).map((_, k) => `${parts.slice(0, k + 1).join('/')}/`)]
    return !names.some(name => new RegExp(`(^|[\\s\`'"(\\[])${escapeRegExp(name)}(?=$|[\\s\`'",.;:!?)\\]])`).test(shown))
  })
}

// The repository's state around a line: HEAD, and what the branch's push
// target (@{push}) points at. A field is undefined when git could not say.
export type Refs = { head?: string; pushed?: string }

// Where the approval stands once an allowed line has run. Neither the exit
// status (`| tail`, `; echo`, `|| true` and a background run hide it) nor the
// refs (the commit may land in a repository the reader did not read) is
// enough alone, so the pick is kept only when both say the commit failed: HEAD
// did not move and the line reported an error. Otherwise the commit counts as
// landed, and its push is left, or used up too when the push target now holds
// HEAD. A push is done when the push target holds HEAD. What cannot be seen
// (no refs, a background run, a directory the reader could not follow, no
// push target) is taken as done, so a doubt uses the approval up and never
// stretches it.
export function approvalAfter(writes: Writes, before: Refs | undefined, after: Refs | undefined, isError: boolean): Approval {
  const isSeen = before?.head !== undefined && after?.head !== undefined
  if (writes.commits === 1 && isSeen && isError && after?.head === before?.head) return 'commit'
  if (writes.pushes === 0) return 'push'
  const isPushed = !isSeen || after?.pushed === undefined || after.pushed === after.head
  return isPushed ? 'none' : 'push'
}

type Question = { question?: unknown; options?: readonly { label?: unknown }[] }

// Whether one AskUserQuestion call offers a commit option beside another
// question.
export function bundlesCommit(questions: unknown): boolean {
  if (!Array.isArray(questions) || questions.length < 2) return false
  return (questions as Question[]).some(
    question => Array.isArray(question?.options) && question.options.some(option => typeof option?.label === 'string' && COMMIT_OPTION.test(option.label)),
  )
}

// Whether a resolved AskUserQuestion dialog carries Mike's "Commit it" pick.
// `questions` is the call's own input. The answer must be, character for
// character, the label of a "Commit it" option of the question it answers.
// Text typed under Other comes back as the answer too, so this is how a pick
// is told from typing: "commit it" typed in any other spelling is refused. Text
// typed to match the label exactly cannot be told from a pick. A dialog that
// resolved while Mike was away (afkTimeoutMs), and a reply typed instead of
// choosing (response), carry no pick.
export function isCommitPick(questions: unknown, result: unknown): boolean {
  if (!Array.isArray(questions) || typeof result !== 'object' || result === null) return false
  const { answers, afkTimeoutMs, response } = result as { answers?: unknown; afkTimeoutMs?: unknown; response?: unknown }
  if (afkTimeoutMs !== undefined || (typeof response === 'string' && response.trim() !== '')) return false
  if (typeof answers !== 'object' || answers === null) return false
  return (questions as Question[]).some(question => {
    const answer = typeof question?.question === 'string' ? (answers as Record<string, unknown>)[question.question] : undefined
    return (
      typeof answer === 'string' &&
      Array.isArray(question.options) &&
      question.options.some(option => option?.label === answer && answer.trim().toLowerCase() === APPROVAL)
    )
  })
}
