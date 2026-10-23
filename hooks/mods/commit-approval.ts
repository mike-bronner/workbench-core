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
// Pure functions only: the engine follows `$` into no imported function.

import type { WorkbenchShellStatement as ShellStatement } from '../../types'
import { MERGE_MUTATION, findOps } from './commit-guard'
import { hiddenCommandRefusal, isPartlyRead } from './guards'
import { ASSIGNMENT, GIT_VALUE_OPTIONS, KEYWORDS, SHELLS, WRAPPERS, commandsOf, decodedOf, expandingOf, isEscaped, isExpanded, nameOf, parseShell, shellScriptOf } from './shell'

export { commandsOf }

export const COMMIT_REFUSAL =
  'This git commit was refused: Mike has not approved it. A prompt of his own ' +
  'that asks for a commit or a release approves the commits of the turn it ' +
  'opened. Ask first for work he did not ask to commit. Once he says his ' +
  'review is done, ask the commit question through AskUserQuestion, alone, ' +
  'with the branch and the proposed message, and run the commit again after ' +
  'he picks "Commit it". One pick approves one commit on the branch HEAD held ' +
  'when he picked, and no push and no merge. Only his own next prompt ends a ' +
  'pick not yet used.'

export const PUSH_REFUSAL =
  'This git push was refused: Mike has not approved it. A prompt of his own ' +
  'that asks for a push or a release approves the pushes of the turn it ' +
  'opened. A commit approval, typed or picked, approves no push. Once the ' +
  'commit has landed, ask about the push in an AskUserQuestion call of its ' +
  'own, with the branch, the remote and the commits it sends, and push after ' +
  'he picks "Push". One pick approves one push of the branch HEAD held when ' +
  'he picked.'

export const MERGE_ASK_REFUSAL =
  'This merge was refused: Mike has not approved a merge into the default ' +
  'branch. How a branch lands, a pull request or a local merge, is his ' +
  'choice. A commit or push approval approves no merge. Ask him in an ' +
  'AskUserQuestion call of its own about the merge, once the commit and the ' +
  'push have landed, and recommend a pull request. A prompt of his own that ' +
  'asks for the merge approves it too, for the turn it opened.'

export const MERGE_TARGET_REFUSAL =
  'This merge was refused: it does not merge the pull request or branch Mike\'s ' +
  'merge pick named. A merge pick approves only the pull request number or the ' +
  'branch its question named, so write that number or branch on the line, such ' +
  'as `gh pr merge 12` or `git merge fix/x`. To merge anything else, ask him again.'

export const REWRITE_REFUSAL =
  'This history rewrite was refused: git cherry-pick, revert, am, rebase, update-ref, ' +
  'a reset that moves a branch, and a shell alias need Mike\'s pick in his own turn, ' +
  'and nobody can give one here. A sub-agent, a -p run and a turn ' +
  'nobody attends never rewrite history. The pipeline rewrites only its own ' +
  'feature branches, and never the default branch or a branch the gate cannot ' +
  'read. Report that the change is ready, and leave it to Mike\'s session.'

export const API_WRITE_REFUSAL =
  'This GitHub API write was refused: a gh api write to repos/<owner>/<repo>/contents ' +
  'or git/refs changes the default branch here, or a branch the gate cannot read, ' +
  'and that needs Mike\'s pick in his own turn. Nobody can give one ' +
  'here. Name a feature branch in its branch= field or its refs/heads/ path, or ' +
  'leave the change to Mike\'s session.'

export const ALIAS_REFUSAL =
  'This gh alias set was refused: a gh alias can run any command under a new ' +
  'name, so setting one needs Mike\'s pick in his own turn, and nobody can give ' +
  'one here. Run the gh command itself instead.'

export const AGENT_MERGE_REFUSAL =
  'This git merge or pull was refused: HEAD is on the default branch, or the ' +
  'gate cannot tell which branch it is on, and a sub-agent, an --agent run or a ' +
  'turn nobody attends does not merge into the default branch. How a branch ' +
  'lands is Mike\'s choice. Report that the branch is ready, and leave the merge ' +
  'to his session. Merging the default branch into a feature branch is not refused.'

export const RELEASE_REFUSAL =
  'This release was refused: nobody can approve it here. A prompt of Mike\'s own ' +
  'that asks for a release approves one, for the turn it opened, and so does his ' +
  'pick in his interactive session. Report that the release is ready.'

export const MOVE_REFUSAL =
  'This line was refused: it runs git checkout, switch, stash or reset while ' +
  'Mike\'s commit or push pick is not yet used. The pick is tied to the branch ' +
  'HEAD held when he picked, and to the tree he saw. Run the approved commit or ' +
  'push first, on that branch. If the work needs another branch, tell Mike, and ' +
  'ask the question again once he says how to go on.'

export const branchRefusal = (seen: string, now: string): string =>
  `This git commit or push was refused: Mike picked it while HEAD was on ${seen}, ` +
  `and HEAD is now on ${now}. A pick approves only the branch HEAD held when he ` +
  'picked, so this pick is used up. Ask the question again, and name the branch ' +
  'HEAD is on now.'

export const AGENT_RELEASE_REFUSAL =
  'This release was refused: a sub-agent, a -p run, the pipeline and an --agent ' +
  'run cannot ask Mike, so none of them releases. A gh release command, releases ' +
  'endpoint or GraphQL Release mutation is refused here in any spelling, as is a ' +
  'gh line whose command or subcommand is not written as plain text, and a line ' +
  'the shell reader cannot read whole, because either may spell one. If the work ' +
  'needs a release, report that it is ready, and leave it to the session that ' +
  'dispatched you. For any other gh command, write gh and its subcommand as plain words.'

export const ONE_REFUSAL =
  'This line runs more than one git commit, git push, merge or release. Run ' +
  'each as a line of its own. One pick approves one commit, one push or one ' +
  'merge, so ask first for each further one that no request of Mike\'s covers.'

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
  'AskUserQuestion was refused: it offers a commit, push, merge or gated-line option ' +
  'beside another question. Ask that question alone, in an AskUserQuestion ' +
  'call of its own, and ask the other questions in a separate call.'

export const NAMED_BUNDLE_REFUSAL =
  'AskUserQuestion was refused: its commit question also names a push, a merge ' +
  'or a release, and one pick approves one commit and nothing more. Ask the ' +
  'commit question alone, with words that name only the commit. Once the ' +
  'commit has landed, ask about the push, and then about how the branch lands, ' +
  'each in a question of its own.'

export const LINES_BUNDLE_REFUSAL =
  'AskUserQuestion was refused: its question names more than one gated line, and ' +
  'one pick approves one line. Ask about each line in an AskUserQuestion call of its own.'

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

export type PickAction = 'commit' | 'push' | 'merge'
export type LineKind = 'release' | 'rewrite' | 'alias' | 'api'
export type Head = { top: string; ref: string }
export type Pick = { action: PickAction | LineKind; heads: readonly Head[]; names?: MergeNames; line?: string }
export type Approval = 'none' | Pick
export type PendingLines = Readonly<Record<string, LineKind>>

const LINE_KINDS: ReadonlySet<string> = new Set<LineKind>(['release', 'rewrite', 'alias', 'api'])
const isLineKind = (kind: string): kind is LineKind => LINE_KINDS.has(kind)

export type Action = PickAction | 'release'

export type Gated = 'commit' | 'push' | 'merge' | 'release' | 'rewrite' | 'alias' | 'api'
export type Counts = { writes: Writes; releases: number; merges: number; rewrites: number; aliases: number; apiWrites: number }
export type Gate = { isOne: boolean; missing: readonly Gated[] }

export const GATED_REFUSALS: Readonly<Record<Gated, string>> = {
  commit: COMMIT_REFUSAL,
  push: PUSH_REFUSAL,
  merge: MERGE_ASK_REFUSAL,
  release: RELEASE_REFUSAL,
  rewrite: REWRITE_REFUSAL,
  alias: ALIAS_REFUSAL,
  api: API_WRITE_REFUSAL,
}

const GATED_NAMES: Readonly<Record<Gated, string>> = {
  commit: 'git commit',
  push: 'git push',
  merge: 'merge into the default branch',
  release: 'release',
  rewrite: 'history rewrite',
  alias: 'gh alias set',
  api: 'GitHub API write to the default branch',
}

export function gateOf(counts: Counts, approval: Approval, request: readonly Action[], line = ''): Gate {
  const { writes, releases, merges, rewrites, aliases, apiWrites } = counts
  const picked = approval === 'none' || approval.line !== undefined ? undefined : approval.action
  const missing: Gated[] = []
  if (releases === 1 && !request.includes('release')) missing.push('release')
  if (writes.commits === 1 && picked !== 'commit' && !grants(request, 'commit')) missing.push('commit')
  if (writes.pushes === 1 && picked !== 'push' && !grants(request, 'push')) missing.push('push')
  if (merges === 1 && picked !== 'merge' && !request.includes('merge')) missing.push('merge')
  if (rewrites > 0) missing.push('rewrite')
  if (aliases > 0) missing.push('alias')
  if (apiWrites > 0) missing.push('api')
  const isOne = writes.commits > 1 || writes.pushes > 1 || merges > 1 || releases > 1
  const many: Readonly<Record<Gated, boolean>> = { commit: false, push: false, merge: false, release: false, rewrite: rewrites > 1, alias: aliases > 1, api: apiWrites > 1 }
  const isLined = approval !== 'none' && approval.line !== undefined && approval.line === line && missing.includes(approval.action)
  return { isOne, missing: isLined ? missing.filter(kind => many[kind]) : missing }
}

export function lineKindOf(missing: readonly Gated[], command: string): LineKind | undefined {
  const kinds = missing.filter(isLineKind)
  if (missing.length === 1 || kinds.length === 0) return kinds[0]
  return parseShell(command).statements.length === 1 ? (kinds.includes('rewrite') ? 'rewrite' : kinds[0]) : undefined
}

export function refusalOf(counts: Counts, approval: Approval, request: readonly Action[]): string | undefined {
  const gate = gateOf(counts, approval, request)
  if (gate.isOne) return ONE_REFUSAL
  const [first] = gate.missing
  return first === undefined ? undefined : GATED_REFUSALS[first]
}

const namesOfGated = (missing: readonly Gated[]): string => missing.map(gated => GATED_NAMES[gated]).join(' and ')

const SHOWN_ESCAPES: Readonly<Record<string, string>> = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '`': '\\`', '\\': '\\\\' }

const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}\u034f\u115f\u1160\u180b-\u180d\u180f\u2800\u3164\ufe00-\ufe0f\uffa0\u{e0100}-\u{e01ef}`\\]/gu

const codeOf = (char: string): string => {
  const point = char.codePointAt(0) ?? 0
  return point > 0xffff ? `\\u{${point.toString(16)}}` : `\\u${point.toString(16).padStart(4, '0')}`
}

export const shownOf = (text: string): string => text.replace(HIDDEN, char => (char === ' ' ? char : (SHOWN_ESCAPES[char] ?? codeOf(char))))

export type AskFacts = { command: string; repo?: string; branch?: string; message?: string; files?: readonly string[] }

const LINE_HOW =
  'Write the line in the question in backticks, exactly as it stands here, and offer "Run it" and "Not now". ' +
  'A "Run it" pick approves this one line, once.'

const ASK_HOW: Readonly<Record<Gated, string>> = {
  commit:
    'Ask only once he says his review is done, and offer "Commit it" and "Not yet". ' +
    'A "Commit it" pick approves one commit on the branch HEAD holds when he picks, and no push and no merge.',
  push: 'Name the push in plain words, such as "Push main to origin?", and offer "Push" and "Not yet". A "Push" pick approves one push of the branch HEAD holds when he picks.',
  merge:
    'Name the pull request number or the branch it merges in plain words, such as "Merge PR 12 into main?", recommend a pull request, and offer "Merge it". ' +
    'A merge pick approves one merge of what its question names.',
  release: LINE_HOW,
  rewrite: LINE_HOW,
  alias: LINE_HOW,
  api: LINE_HOW,
}

export function askRefusalOf(missing: readonly Gated[], facts: AskFacts): string {
  const [kind] = missing
  if (kind === undefined || (missing.length > 1 && lineKindOf(missing, facts.command) === undefined)) {
    return (
      `This line was refused: it runs a ${namesOfGated(missing)}, and Mike has approved none of them. ` +
      'One pick approves one action, so run each as a line of its own, and ask him about each one through AskUserQuestion, alone.'
    )
  }
  const names = namesOfGated(missing)
  const repo = facts.repo === undefined ? 'a repository the gate cannot read' : shownOf(facts.repo)
  const branch = facts.branch === undefined ? 'a branch the gate cannot read' : shownOf(facts.branch.replace(/^refs\/heads\//, ''))
  const parts = [
    `This ${names} was refused: Mike has not approved it.`,
    'Ask him through AskUserQuestion, with this question alone in its call.',
    `In the question, name the exact line \`${shownOf(facts.command)}\`, the action (${names}), the repository ${repo}, and the branch ${branch}.`,
  ]
  if (missing.includes('commit')) {
    const files = facts.files?.map(shownOf)
    const listed = files === undefined ? 'every file git status lists' : files.length === 0 ? 'that git status lists no files' : `every file git status lists: ${files.join(', ')}`
    parts.push(`Name the message, ${facts.message === undefined ? 'as the line gives it' : shownOf(facts.message)}, and ${listed}.`)
  }
  parts.push(missing.length === 1 ? ASK_HOW[kind] : LINE_HOW, 'After he picks, run the line again, unchanged.')
  return parts.join(' ')
}

export function messageOf(args: readonly string[] | null): string | undefined {
  if (args === null) return undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    if (arg === '-m' || arg === '--message') return JSON.stringify(args[i + 1] ?? '')
    if (arg.startsWith('--message=')) return JSON.stringify(arg.slice('--message='.length))
    if (/^-[a-z]*m./.test(arg) && !arg.startsWith('--')) return JSON.stringify(arg.slice(arg.indexOf('m') + 1))
    if (arg === '-F' || arg === '--file') return `the text of ${args[i + 1] ?? 'a file'}`
    if (arg.startsWith('--file=')) return `the text of ${arg.slice('--file='.length)}`
  }
  return undefined
}

export function filesOf(status: string): string[] {
  const fields = status.split('\0')
  const paths: string[] = []
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i] as string
    if (entry.length < 4) continue
    if ('RC'.includes(entry[0] as string) || 'RC'.includes(entry[1] as string)) i++
    paths.push(entry.slice(3))
  }
  return paths
}

const grants = (request: readonly Action[], action: 'commit' | 'push'): boolean => request.includes(action) || request.includes('release')

export function isPaidByPick(writes: Writes, merges: number, approval: Approval, request: readonly Action[]): boolean {
  if (approval === 'none' || approval.line !== undefined) return false
  if (approval.action === 'commit') return writes.commits === 1 && !grants(request, 'commit')
  if (approval.action === 'push') return writes.pushes === 1 && !grants(request, 'push')
  return merges === 1 && !request.includes('merge')
}

const DETACHED = 'detached at '

export function headsOf(porcelain: string): Head[] {
  return porcelain.split(/\n\n+/).flatMap(block => {
    const lines = block.split('\n')
    const field = (name: string) => lines.find(line => line.startsWith(`${name} `))?.slice(name.length + 1)
    const top = field('worktree')
    const ref = refOf(field('branch'), field('HEAD'))
    return top === undefined || ref === undefined ? [] : [{ top, ref }]
  })
}

export const refOf = (branch: string | undefined, sha: string | undefined): string | undefined =>
  branch ?? (sha === undefined ? undefined : `${DETACHED}${sha}`)

const shownRef = (ref: string | undefined, what: string): string => (ref === undefined ? what : ref.replace(/^refs\/heads\//, ''))

export function bindingRefusalOf(pick: Pick, top: string | undefined, ref: string | undefined): string | undefined {
  const seen = top === undefined ? undefined : pick.heads.find(head => head.top === top)
  if (seen !== undefined && ref !== undefined && seen.ref === ref) return undefined
  return branchRefusal(shownRef(seen?.ref, 'a branch the gate could not read'), shownRef(ref, 'a branch the gate cannot read'))
}

const SHELL_ALIAS = '!'
const CONFIGURED = /(^|[^A-Za-z0-9_])GIT_CONFIG\w*=/

export function gitSubOf(st: ShellStatement, line = ''): string | undefined {
  if (st.name !== 'git' || st.subcommandAt < 0) return undefined
  if (CONFIGURED.test(line) || st.assignments.some(assignment => /^GIT_CONFIG\w*=/.test(assignment))) return SHELL_ALIAS
  const sub = (st.args[st.subcommandAt] ?? '').toLowerCase()
  const globals = st.args.slice(0, st.subcommandAt)
  for (let i = 0; i < globals.length; i++) {
    const word = globals[i] ?? ''
    const pair = word === '-c' ? globals[++i] : word.startsWith('-c') ? word.slice(2) : undefined
    const alias = pair === undefined ? null : /^alias\.([^=]*)=(.*)$/is.exec(pair)
    if (alias === null || (alias[1] ?? '').toLowerCase() !== sub) continue
    const value = (alias[2] ?? '').trim()
    return value.startsWith(SHELL_ALIAS) ? SHELL_ALIAS : (value.split(/\s+/)[0] ?? '').toLowerCase()
  }
  return sub
}

const restOf = (st: ShellStatement): readonly string[] => st.args.slice(st.subcommandAt + 1)

const positionalsOf = (args: readonly string[], values: ReadonlySet<string>): string[] => {
  const found: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    if (values.has(arg)) i++
    else if (!arg.startsWith('-')) found.push(arg)
  }
  return found
}

const HEAD_WRITERS: ReadonlySet<string> = new Set(['checkout', 'switch', 'update-ref', 'filter-branch', 'replace', 'bisect', SHELL_ALIAS])
const SYMREF_VALUES: ReadonlySet<string> = new Set(['-m'])
const REBASE_VALUES: ReadonlySet<string> = new Set(['--onto', '-s', '--strategy', '-X', '--strategy-option', '-x', '--exec'])
const UPDATE_REF_VALUES: ReadonlySet<string> = new Set(['-m'])
const BRANCH_VALUES: ReadonlySet<string> = new Set(['-u', '--set-upstream-to', '-t', '--track'])
const PUSH_VALUES: ReadonlySet<string> = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])
const REWRITE_STOPS: ReadonlySet<string> = new Set(['--abort', '--quit'])
const BISECT_READS: ReadonlySet<string> = new Set(['log', 'visualize', 'view', 'help', 'terms'])

const isLongFor = (arg: string, full: string): boolean => arg.length >= 3 && arg.startsWith('--') && !arg.includes('=') && full.startsWith(arg)
const longValuesOf = (rest: readonly string[], values: ReadonlySet<string>): Set<string> => {
  const longs = [...values].filter(value => value.startsWith('--'))
  return new Set([...values, ...rest.filter(arg => longs.some(full => isLongFor(arg, full)))])
}
const isBranchWrite = (arg: string): boolean => /^-[A-Za-z]*[mMfcC][A-Za-z]*$/.test(arg) || ['--move', '--force', '--copy'].some(full => isLongFor(arg, full))

const refspecsOf = (rest: readonly string[], values: ReadonlySet<string> = new Set()): string[] =>
  positionalsOf(rest, longValuesOf(rest, values)).filter(arg => arg.includes(':'))
const destinationOf = (refspec: string): string => refspec.slice(refspec.lastIndexOf(':') + 1).replace(/^\+/, '')
const isLocalRemote = (remote: string | undefined): boolean => remote === undefined || remote === '.' || /^(?:\/|\.\.?\/|~|file:)/.test(remote)
const pushRemoteOf = (rest: readonly string[]): string | undefined => {
  const at = rest.findIndex(arg => arg === '--repo' || isLongFor(arg, '--repo'))
  const attached = rest.map(arg => /^--rep?o?=(.*)$/.exec(arg)?.[1]).find(value => value !== undefined)
  if (attached !== undefined) return attached
  return at === -1 ? positionalsOf(rest, longValuesOf(rest, PUSH_VALUES))[0] : rest[at + 1]
}

const rebaseNamesBranch = (rest: readonly string[]): boolean => {
  if (rest.some(arg => REWRITE_STOPS.has(arg))) return false
  const count = positionalsOf(rest, longValuesOf(rest, REBASE_VALUES)).length
  const isRoot = rest.some(arg => arg === '--root' || isLongFor(arg, '--root'))
  return count >= 2 || (count >= 1 && isRoot) || rest.some(arg => isLongFor(arg, '--update-refs'))
}

function writesHead(st: ShellStatement, sub: string | undefined): boolean {
  if (sub === undefined) return false
  const rest = restOf(st)
  if (sub === 'replace') return !rest.some(arg => arg === '-l' || isLongFor(arg, '--list'))
  if (sub === 'bisect') return !BISECT_READS.has(rest[0] ?? '')
  if (HEAD_WRITERS.has(sub)) return true
  if (sub === 'symbolic-ref') return rest.some(arg => arg === '-d' || isLongFor(arg, '--delete')) || positionalsOf(rest, SYMREF_VALUES).length >= 2
  if (sub === 'branch') return rest.some(isBranchWrite)
  if (sub === 'rebase') return rebaseNamesBranch(rest)
  if (sub === 'fetch' || sub === 'pull') return refspecsOf(rest).length > 0
  if (sub === 'push') return refspecsOf(rest, PUSH_VALUES).length > 0 && isLocalRemote(pushRemoteOf(rest))
  return false
}

const breaksPlace = (st: ShellStatement, sub: string | undefined): boolean => sub !== 'update-ref' && writesHead(st, sub)

const MOVES: ReadonlySet<string> = new Set(['stash', 'reset'])

export function movesHead(line: string): boolean {
  return parseShell(line).statements.some(st => {
    const sub = gitSubOf(st, line)
    if (writesHead(st, sub)) return true
    return sub !== undefined && MOVES.has(sub) && !(sub === 'stash' && ['list', 'show'].includes(restOf(st)[0] ?? ''))
  })
}

const isPlacedLine = (line: string, statements: readonly ShellStatement[]): boolean =>
  !/(^|[^A-Za-z0-9_])GIT_(DIR|WORK_TREE)=/.test(line) && !statements.some(st => PLACE_WORDS.has(st.name) || breaksPlace(st, gitSubOf(st, line)))

const REWRITES: ReadonlySet<string> = new Set(['cherry-pick', 'revert', 'am', 'rebase', 'update-ref', 'filter-branch', SHELL_ALIAS])

const movesBranch = (rest: readonly string[]): boolean => {
  const cut = rest.indexOf('--')
  const targets = (cut === -1 ? rest : rest.slice(0, cut)).filter(arg => !arg.startsWith('-'))
  return targets.length > 0 && !(targets.length === 1 && targets[0] === 'HEAD')
}

const isRewrite = (st: ShellStatement, sub: string | undefined): boolean => {
  if (sub === undefined) return false
  const rest = restOf(st)
  if (sub === 'reset') return movesBranch(rest)
  if (sub === 'commit') return rest.some(arg => /^--am/.test(arg))
  if (sub === 'replace' || sub === 'fetch' || sub === 'push') return writesHead(st, sub)
  if (sub === 'branch') return rest.some(isBranchWrite)
  return REWRITES.has(sub) && !rest.some(arg => REWRITE_STOPS.has(arg))
}

export type Rewrite = { dir: string | null; refs?: readonly string[] }

const UNPLACED_REWRITES: ReadonlySet<string> = new Set([SHELL_ALIAS, 'filter-branch', 'replace'])

export function rewritesAt(line: string): Rewrite[] {
  const parse = parseShell(line)
  const isPlaced = isPlacedLine(line, parse.statements)
  return parse.statements
    .filter(st => isRewrite(st, gitSubOf(st, line)))
    .map(st => {
      const sub = gitSubOf(st, line)
      const rest = restOf(st)
      const placed = sub === 'branch' || sub === 'fetch' || sub === 'push' ? isPlacedLine(line, parse.statements.filter(other => other !== st)) : isPlaced
      const dir = UNPLACED_REWRITES.has(sub ?? '') || (sub === 'rebase' && rebaseNamesBranch(rest)) ? null : mergeDirOf(st, placed)
      if (sub === 'update-ref') return { dir, refs: [rest.includes('--stdin') ? '' : (positionalsOf(rest, UPDATE_REF_VALUES)[0] ?? '')] }
      if (sub === 'fetch') return { dir, refs: refspecsOf(rest).map(destinationOf) }
      if (sub === 'push') return { dir, refs: refspecsOf(rest, PUSH_VALUES).map(destinationOf) }
      if (sub === 'branch') {
        const names = positionalsOf(rest, longValuesOf(rest, BRANCH_VALUES))
        return { dir, refs: names.length === 0 ? [''] : names }
      }
      return { dir }
    })
}

export const rewritesOf = (line: string): number => rewritesAt(line).length

const defaultNameOf = (originHead: string): string => originHead.replace(/^refs\/remotes\/[^/]+\//, '').toLowerCase()

export const isDefaultRef = (ref: string, originHead: string | undefined): boolean => {
  if (originHead === undefined) return true
  const name = defaultNameOf(originHead)
  const plain = ref.toLowerCase()
  return plain === '' || plain === 'head' || plain === name || plain === `refs/heads/${name}` || plain === `heads/${name}`
}

export function aliasSetsOf(line: string): number {
  return parseShell(line).statements.filter(st => {
    if (st.name !== 'gh' || st.subcommandAt < 0 || (st.args[st.subcommandAt] ?? '').toLowerCase() !== 'alias') return false
    return ['set', 'import'].includes((st.args[st.subcommandAt + 1] ?? '').toLowerCase())
  }).length
}

export type ApiWrite = { branch: string | null; repo?: string | null | undefined }

const REPO = String.raw`(?:repos\/([^\s/]+\/[^\s/]+)|repositories\/[^\s/]+)`
const CONTENTS = new RegExp(String.raw`(?:^|\/)${REPO}\/contents(?:[/?]|$)`, 'i')
const GIT_REFS = new RegExp(String.raw`(?:^|\/)${REPO}\/git\/refs(?:\/([^\s?]*))?(?:\?|$)`, 'i')
const MERGE_UPSTREAM = new RegExp(String.raw`(?:^|\/)${REPO}\/merge-upstream(?:\?|$)`, 'i')
const BRANCH_RENAME = new RegExp(String.raw`(?:^|\/)${REPO}\/branches\/([^\s?]+)\/rename(?:\?|$)`, 'i')
const ANY_REPO = new RegExp(String.raw`(?:^|\/)${REPO}(?:\/|$)`, 'i')
const REF_MUTATION = /\b(?:createCommitOnBranch|updateRefs?|createRef|deleteRef|mergeBranch)\b/
const UNREAD_VALUE = /^@|[$`{}%#]|\/$/
const UNREAD_ENDPOINT = /[%#]|\/\/|(?:^|\/)\.\.?(?:\/|$)/
const BUILT_BRANCH_ENDPOINT = /[$`].*(?:contents|git\/refs|merge-upstream|branches|merges)|(?:contents|git\/refs|merge-upstream|branches|merges).*[$`]/i

const lastField = (fields: readonly string[], name: string): string | undefined =>
  [...fields].reverse().map(value => new RegExp(`^${name}=(.*)$`, 's').exec(value)?.[1]).find(value => value !== undefined)
const readBranch = (branch: string | undefined): string | null => (branch === undefined || branch === '' || UNREAD_VALUE.test(branch) ? null : branch)
const repoOf = (endpoint: string): string | null | undefined => {
  const match = ANY_REPO.exec(endpoint)
  const repo = match?.[1]?.toLowerCase()
  if (repo === '{owner}/{repo}') return undefined
  return repo === undefined || /[$`{}%#]/.test(repo) ? null : repo
}

const expandsAt = (st: ShellStatement, at: number): boolean => {
  const expanding = expandingOf(st)
  return expanding === undefined ? /[$`]/.test(st.words[at] ?? '') : expanding.includes(at)
}

export const hasExpandedField = (st: ShellStatement): boolean => st.words.some((_, at) => at > st.nameAt && expandsAt(st, at))

function apiWriteOf(st: ShellStatement): ApiWrite[] {
  const api = apiOf(st)
  const fields = api.fields.map(field => field.value ?? '')
  const words = [...restOf(st), ...st.heredocs.map(heredoc => heredoc.body)]
  if (/graphql/i.test(api.endpoint)) return words.some(word => REF_MUTATION.test(word)) || hasExpandedField(st) ? [{ branch: null }] : []
  const isWriteImplied = fields.length > 0 || api.options.some(option => option.name === '--input')
  const method = (api.methods.at(-1)?.value ?? (isWriteImplied ? 'POST' : 'GET')).toUpperCase()
  if (method === 'GET' || method === 'HEAD') return []
  const repo = repoOf(api.endpoint)
  const endpoint = api.endpoint.replace(/\{owner\}|\{repo\}/g, 'x')
  if (UNREAD_ENDPOINT.test(endpoint) || BUILT_BRANCH_ENDPOINT.test(endpoint)) return [{ branch: null, repo }]
  if (CONTENTS.test(api.endpoint) || MERGE_UPSTREAM.test(api.endpoint)) return [{ branch: readBranch(lastField(fields, 'branch')), repo }]
  const renamed = BRANCH_RENAME.exec(api.endpoint)
  if (renamed !== null) return [{ branch: readBranch(renamed[2]), repo }, { branch: readBranch(lastField(fields, 'new_name')), repo }]
  const refs = GIT_REFS.exec(api.endpoint)
  if (refs === null) return []
  const path = refs[2] !== undefined && refs[2] !== '' ? refs[2] : (lastField(fields, 'ref') ?? '').replace(/^refs\//, '')
  if (/^tags\//i.test(path) && !UNREAD_VALUE.test(path)) return []
  return [{ branch: readBranch(/^heads\/(.+)$/i.exec(path)?.[1]), repo }]
}

const SYNC_VALUES: ReadonlySet<string> = new Set(['-b', '--branch', '-s', '--source'])

function repoSyncOf(st: ShellStatement): ApiWrite[] {
  const rest = restOf(st)
  if ((rest[0] ?? '').toLowerCase() !== 'sync') return []
  const at = rest.findIndex(arg => arg === '-b' || arg === '--branch')
  const attached = rest.map(arg => /^--branch=(.+)$/.exec(arg)?.[1]).find(value => value !== undefined)
  const isElsewhere = rest.some(arg => /^(?:-R|--repo)/.test(arg)) || positionalsOf(rest.slice(1), SYNC_VALUES).length > 0
  return [{ branch: readBranch(at === -1 ? attached : rest[at + 1]), repo: isElsewhere ? null : undefined }]
}

export function apiWritesOf(line: string): ApiWrite[] {
  return parseShell(line).statements.flatMap(st => {
    if (st.name !== 'gh' || st.subcommandAt < 0) return []
    const group = (st.args[st.subcommandAt] ?? '').toLowerCase()
    if (group === 'api') return apiWriteOf(st)
    return group === 'repo' ? repoSyncOf(st) : []
  })
}

export const originRepoOf = (url: string | undefined): string | undefined =>
  url === undefined || !/github\.com[:/]/i.test(url) ? undefined : /[:/]([^/:\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1]?.toLowerCase()

export const isOtherRepo = (repo: string | null | undefined, origin: string | undefined): boolean =>
  repo !== undefined && (repo === null || origin === undefined || repo !== origin)

export type RemoteTarget = { repo: string; branch?: string }

const ghRepoOf = (st: ShellStatement): string | undefined => {
  const assigned = st.assignments.map(word => /^GH_REPO=(.+)$/.exec(word)?.[1]).find(value => value !== undefined)
  for (let i = 0; i < st.args.length; i++) {
    const arg = st.args[i] as string
    if (arg === '-R' || arg === '--repo') return st.args[i + 1]
    const attached = /^(?:-R|--repo=)(.+)$/.exec(arg)?.[1]
    if (attached !== undefined) return attached
  }
  return assigned
}

export function remoteTargetOf(line: string, origin: string | undefined): RemoteTarget | undefined {
  const write = apiWritesOf(line).find(each => typeof each.repo === 'string' && isOtherRepo(each.repo, origin))
  if (write !== undefined && typeof write.repo === 'string') return { repo: write.repo, ...(write.branch === null ? {} : { branch: write.branch }) }
  const release = parseShell(line).statements.find(st => st.name === 'gh' && st.args.includes('release'))
  const repo = release === undefined ? undefined : ghRepoOf(release)
  return repo === undefined || !isOtherRepo(repo.toLowerCase(), origin) ? undefined : { repo, branch: `the default branch of ${repo}` }
}

export type MergeTarget ={ pr?: string; refs: readonly string[]; bases?: readonly string[] }
export type Merges = { local: readonly (string | null)[]; pr: number; targets: readonly MergeTarget[] }

const MERGE_STOPS: ReadonlySet<string> = new Set(['--abort', '--quit'])
const PULL_MERGE = /pulls\/([^\s/]+)\/merge(?![A-Za-z0-9_/-])/i
const BRANCH_MERGE = /(?:^|\/)repos\/\S+\/merges(?:\?|$)/i
const GH_MERGE_VALUES: ReadonlySet<string> = new Set(['-b', '--body', '-F', '--body-file', '-t', '--subject', '-A', '--author-email', '--match-head-commit', '-R', '--repo'])
const GIT_MERGE_VALUES: ReadonlySet<string> = new Set(['-m', '-F', '--file', '-s', '--strategy', '-X', '--strategy-option', '--into-name', '--cleanup'])
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const REMOTE_CHANGES: ReadonlySet<string> = new Set(['set-url', 'add', 'rename'])

const fieldOf = (words: readonly string[], name: string): string | undefined =>
  [...words].reverse().map(word => new RegExp(`^(?:-[fF]|--(?:raw-)?field=)?${name}=(.+)$`).exec(word)?.[1]).find(value => value !== undefined)

const prTargetOf = (st: ShellStatement): MergeTarget | undefined => {
  if (st.name !== 'gh' || st.subcommandAt < 0) return undefined
  const sub = (st.args[st.subcommandAt] ?? '').toLowerCase()
  const rest = restOf(st)
  if (sub === 'pr') {
    const at = rest.findIndex(arg => arg.toLowerCase() === 'merge')
    if (at === -1) return undefined
    const [first] = positionalsOf(rest.slice(at + 1), GH_MERGE_VALUES)
    const pr = first === undefined ? undefined : (/^#?(\d+)$/.exec(first) ?? /\/pull\/(\d+)/.exec(first))?.[1]
    return pr !== undefined ? { pr, refs: [] } : { refs: first === undefined ? [] : [first] }
  }
  if (sub !== 'api') return undefined
  const words = [...rest, ...st.heredocs.map(heredoc => heredoc.body)]
  const pull = words.map(word => PULL_MERGE.exec(word)?.[1]).find(pr => pr !== undefined)
  if (pull !== undefined) return { pr: pull, refs: [] }
  if (rest.some(word => BRANCH_MERGE.test(word))) {
    const head = fieldOf(rest, 'head')
    const base = fieldOf(rest, 'base')
    return { refs: head === undefined ? [] : [head], bases: base === undefined ? [] : [base] }
  }
  return words.some(word => MERGE_MUTATION.test(word)) ? { refs: [] } : undefined
}

const localTargetOf = (st: ShellStatement, sub: string | undefined, isRemoteChanged: boolean): MergeTarget => {
  const found = positionalsOf(restOf(st), GIT_MERGE_VALUES)
  if (sub !== 'pull') return { refs: sub === SHELL_ALIAS ? [] : found }
  const [remote] = found
  return { refs: isRemoteChanged || remote === undefined || !REMOTE_NAME.test(remote) ? [] : found.slice(1) }
}

const mergeDirOf = (st: ShellStatement, isPlaced: boolean): string | null => {
  const globals = st.args.slice(0, st.subcommandAt)
  if (!isPlaced || globals.some(word => GIT_PLACE_OPTION.test(word))) return null
  const at = globals.lastIndexOf('-C')
  if (at === -1) return ''
  const dir = globals[at + 1] ?? ''
  return dir.startsWith('/') && !/[$`]/.test(dir) && !hasDotStep(dir) ? dir : null
}

export function mergesOf(line: string): Merges {
  const parse = parseShell(line)
  const isPlaced = isPlacedLine(line, parse.statements)
  const isRemoteChanged = parse.statements.some(st => gitSubOf(st, line) === 'remote' && REMOTE_CHANGES.has(restOf(st)[0] ?? ''))
  const merging = parse.statements
    .filter(st => ['merge', 'pull', SHELL_ALIAS].includes(gitSubOf(st, line) ?? ''))
    .filter(st => !restOf(st).some(arg => MERGE_STOPS.has(arg)))
  const prs = parse.statements.map(prTargetOf).filter((target): target is MergeTarget => target !== undefined)
  const hidden = prs.length === 0 && findOps(parse, line).ops.has('merge') ? [{ refs: [] }] : []
  return {
    local: merging.map(st => mergeDirOf(st, isPlaced)),
    pr: prs.length + hidden.length,
    targets: [...merging.map(st => localTargetOf(st, gitSubOf(st, line), isRemoteChanged)), ...prs, ...hidden],
  }
}

export const isDefaultBranch = (branch: string | undefined, originHead: string | undefined): boolean => {
  if (branch === undefined || originHead === undefined) return true
  return branch.replace(/^refs\/heads\//, '').toLowerCase() === defaultNameOf(originHead)
}

export type MergeNames = { prs: readonly string[]; words: readonly string[]; bases?: readonly string[] }

const DESTINATION = /\b(?:into|onto|to|on|in)\s+[`"']?([A-Za-z0-9._/-]+)/gi

export function mergeNamesOf(questions: unknown): MergeNames {
  const text = Array.isArray(questions) ? (questions as Question[]).map(question => `${textOf(question?.question)} ${textOf(question?.header)}`).join(' ') : ''
  const prs = [...text.matchAll(/(?:#|\b(?:pr|pull request|pull)\s*#?)(\d+)\b/gi)].map(match => match[1] as string)
  const bases = [...text.matchAll(DESTINATION)].map(match => (match[1] as string).replace(/[.]+$/, '').toLowerCase())
  const subject = text.replace(DESTINATION, ' ')
  const words = (subject.match(/[A-Za-z0-9._/-]+/g) ?? []).map(word => word.replace(/[.]+$/, '').toLowerCase())
  return { prs: [...new Set(prs)], words: [...new Set(words)], bases: [...new Set(bases)] }
}

const bare = (ref: string): string => ref.toLowerCase().replace(/^(?:origin|upstream)\//, '')

const isNamed = (target: MergeTarget, names: MergeNames): boolean => {
  if (target.pr !== undefined) return names.prs.includes(target.pr)
  if (target.bases !== undefined && !(target.bases.length > 0 && target.bases.every(base => (names.bases ?? []).includes(bare(base))))) return false
  return target.refs.length > 0 && target.refs.every(ref => names.words.includes(bare(ref)))
}

export function mergeTargetRefusalOf(names: MergeNames | undefined, targets: readonly MergeTarget[]): string | undefined {
  return names !== undefined && targets.length > 0 && targets.every(target => isNamed(target, names)) ? undefined : MERGE_TARGET_REFUSAL
}

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
  'just', 'go', 'ahead', 'lgtm', 'looks', 'fine', 'done', 'finally', 'next', "let's", 'lets', 'work', 'well',
])
const OBJECT_STARTS: ReadonlySet<string> = new Set(['it', 'this', 'that', 'these', 'those', 'them', 'everything', 'all', 'origin', 'main', 'master', 'again'])
const WORK_OBJECTS: ReadonlySet<string> = new Set([
  'the', 'my', 'our', 'your', 'its', 'both', 'what', 'changes', 'change', 'work', 'fix', 'fixes', 'files', 'tree', 'diff', 'code', 'edits',
  'branch', 'pr', 'up', 'locally', 'with', 'here', 'now', 'too', 'staged', 'current', 'latest', 'rest', 'please',
])
const VERB_OBJECTS: Readonly<Record<string, ReadonlySet<string>>> = { push: new Set(['to']), merge: new Set(['into', 'to']) }

const isObject = (verb: Action, after: string): boolean =>
  OBJECT_STARTS.has(after) || (verb !== 'release' && WORK_OBJECTS.has(after)) || (VERB_OBJECTS[verb]?.has(after) ?? false)
const MAX_REQUEST_LINES = 5
const MAX_REQUEST_WORDS = 80
const CONNECTORS: ReadonlySet<string> = new Set(['and', 'then', '&', '+', 'also', 'finally', 'please', 'now'])
const RELEASE_VERBS: ReadonlySet<string> = new Set(['cut', 'create', 'make', 'do', 'publish', 'ship', 'tag'])
const ACTION_WORD = /\b(commit(s|ted|ting)?|push(es|ed|ing)?|merg(e|es|ed|ing)|releas(e|es|ed|ing))\b/i
const VETO_WORD =
  /\b(not|no|never|nothing|don't|dont|do not|doesn't|didn't|won't|wouldn't|shouldn't|can't|cannot|without|later|yet|after|afterwards|before|once|when|whenever|until|till|unless|if|whether|should|would|could|might|may|maybe|perhaps|wait|hold|tomorrow|soon|eventually|instead|as long as|so long as|assuming|assume|provided|providing|given|pending|in case|supposing|depending|barring|isn't|isnt|hasn't|hasnt|haven't|aren't|wasn't|weren't|needn't|mustn't|must not|need not|only)\b/i

const verbAt = (words: readonly string[], i: number): [Action, number] | undefined => {
  const word = words[i]
  if (word === 'commit' || word === 'push' || word === 'merge' || word === 'release') return [word, i + 1]
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
    return after === undefined || CONNECTORS.has(after) || isObject(verb[0], after) || /^v?\d/.test(after) ? [verb[0]] : []
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

export type RequestedCall = { action: 'commit'; dir?: string } | { action: 'push'; dir?: string; remote?: string; ref?: string } | { action: 'release' } | { action: 'merge' }

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

const PR_MERGE_FLAGS = /^(--(merge|squash|rebase|delete-branch)|-[msrd])$/

const isPlainPrMerge = (args: readonly string[]): boolean =>
  args.filter(arg => /^\d+$/.test(arg)).length <= 1 && args.every(arg => /^\d+$/.test(arg) || PR_MERGE_FLAGS.test(arg))

const callOf = (st: ShellStatement): RequestedCall | undefined => {
  const isPlain =
    st.depth === 0 && st.nameAt === 0 && st.isPlaced && st.escaped.length === 0 && st.redirects.length === 0 && st.heredocs.length === 0 && !st.words.some(isExpanded)
  if (!isPlain) return undefined
  if (st.name === 'gh') {
    const [group, verb] = st.args
    const isOtherRepo = st.args.some(arg => /^(-R|--repo)/.test(arg))
    if (st.subcommandAt === 0 && group === 'pr' && verb === 'merge') return !isOtherRepo && isPlainPrMerge(st.args.slice(2)) ? { action: 'merge' } : undefined
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
    call !== undefined && (call.action === 'release' || call.action === 'merge' ? request.includes(call.action) : grants(request, call.action))
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

export function approvalAfter(pick: Pick, before: Refs | undefined, after: Refs | undefined, isError: boolean): Approval {
  const isSeen = before?.head !== undefined && after?.head !== undefined
  if (pick.action === 'commit') return isSeen && isError && after?.head === before?.head ? pick : 'none'
  if (pick.action === 'push') return isSeen && after?.pushed !== undefined && after.pushed !== after.head ? pick : 'none'
  return isError ? pick : 'none'
}

type Question = { question?: unknown; header?: unknown; options?: readonly { label?: unknown }[] }

const NAMED_ACTION = /^(push(es|ed|ing)?|merg(e|es|ed|ing)|releas(e|es|ed|ing))$/

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '')

const labelsOf = (question: Question): string[] =>
  Array.isArray(question?.options) ? question.options.map(option => option?.label).filter((label): label is string => typeof label === 'string') : []

export function namedActionsOf(question: Question): Set<'push' | 'merge' | 'release'> {
  const text = `${textOf(question?.question)} ${textOf(question?.header)}`
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/"[^"\n]*"|“[^”\n]*”|`[^`\n]*`/g, ' ')
    .toLowerCase()
  const words = (text.match(/[a-z0-9_./-]+/g) ?? []).map(word => word.replace(/\.+$/, '')).filter(word => NAMED_ACTION.test(word))
  return new Set(words.map(word => (word.startsWith('push') ? 'push' : word.startsWith('merg') ? 'merge' : 'release')))
}

const isCommitQuestion = (question: Question): boolean => labelsOf(question).some(label => COMMIT_OPTION.test(label) || requestedOf(label).includes('commit'))

export function approvalOf(question: Question, label: string): PickAction | undefined {
  const actions = requestedOf(label)
  if (isCommitQuestion(question)) return actions.includes('commit') ? 'commit' : undefined
  const named = namedActionsOf(question)
  if (actions.includes('merge') && named.has('merge')) return 'merge'
  return actions.includes('push') && named.has('push') ? 'push' : undefined
}

const offersApproval = (question: Question): boolean =>
  isCommitQuestion(question) || labelsOf(question).some(label => approvalOf(question, label) !== undefined)

export function linesNamedOf(question: Question, pending: PendingLines): string[] {
  const text = textOf(question?.question)
  return Object.keys(pending).filter(line => text.includes(`\`${shownOf(line)}\``))
}

export function bundleRefusalOf(questions: unknown, pending: PendingLines = {}): string | undefined {
  if (!Array.isArray(questions)) return undefined
  const asked = questions as Question[]
  if (asked.some(question => linesNamedOf(question, pending).length > 1)) return LINES_BUNDLE_REFUSAL
  if (asked.length > 1 && asked.some(question => offersApproval(question) || linesNamedOf(question, pending).length > 0)) return BUNDLE_REFUSAL
  return asked.some(question => isCommitQuestion(question) && namedActionsOf(question).size > 0) ? NAMED_BUNDLE_REFUSAL : undefined
}

const answersOf = (questions: unknown, result: unknown): Record<string, unknown> | undefined => {
  if (!Array.isArray(questions) || typeof result !== 'object' || result === null) return undefined
  const { answers, afkTimeoutMs, response } = result as { answers?: unknown; afkTimeoutMs?: unknown; response?: unknown }
  if (afkTimeoutMs !== undefined || (typeof response === 'string' && response.trim() !== '')) return undefined
  return typeof answers === 'object' && answers !== null ? (answers as Record<string, unknown>) : undefined
}

const pickedLabelOf = (question: Question, answers: Record<string, unknown>): string | undefined => {
  const answer = typeof question?.question === 'string' ? answers[question.question] : undefined
  return typeof answer === 'string' && labelsOf(question).includes(answer) ? answer : undefined
}

export function pickOf(questions: unknown, result: unknown): PickAction | undefined {
  const answers = answersOf(questions, result)
  if (answers === undefined) return undefined
  for (const question of questions as Question[]) {
    const label = pickedLabelOf(question, answers)
    const action = label === undefined ? undefined : approvalOf(question, label)
    if (action !== undefined) return action
  }
  return undefined
}

const RUN_LABEL = /^\s*(?:yes|run|approve|go ahead|release)\b/i

export const isRunLabel = (label: string): boolean => RUN_LABEL.test(label) && !VETO_WORD.test(label)

export function linePickOf(questions: unknown, result: unknown, pending: PendingLines): { line: string; kind: LineKind } | undefined {
  const answers = answersOf(questions, result)
  if (answers === undefined) return undefined
  for (const question of questions as Question[]) {
    const [line, ...others] = linesNamedOf(question, pending)
    const label = pickedLabelOf(question, answers)
    const kind = line === undefined ? undefined : pending[line]
    if (line !== undefined && kind !== undefined && others.length === 0 && label !== undefined && isRunLabel(label)) return { line, kind }
  }
  return undefined
}
