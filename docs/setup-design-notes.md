# Setup design notes

Why `/workbench-core:setup` does what it does. The skill at
`skills/setup/SKILL.md` carries the steps, `scripts/setup-config.sh` runs its
fixed merges, and `skills/setup/references/git-sync.md` holds the opt-in git-sync
steps. This file carries the reasons and the
history behind them, so the skill stays short enough to follow and nobody
"improves" a step without knowing why it is shaped that way.

## Permission rails (setup Step 2c)

Claude Code evaluates permission rules **deny → ask → allow, before the
auto-mode classifier**, in every permission mode including `bypassPermissions`.
A boundary stated only in conversation ("don't push until I review") is re-read
from the transcript on every check and is **lost when context is compacted**. A
deny rule is not. Step 2c installs that durable half.

### What the merge writes besides the rules

`scripts/permissions.sh` also writes `permissions.additionalDirectories`: the two
scratchpad trees, so every session sees them as working directories. Both are
computed for the account running setup. One is the harness's session tree,
`claude-<uid>` under the physical `/tmp` (`/private/tmp` on macOS), which holds
every session's scratchpad. The other is `~/Developer/scratchpad`.

A bare `/tmp` or `/private/tmp` entry is **removed**. That is the one thing the
merge ever takes out, because such an entry advertised all of `/tmp` as a working
directory, and agents made scratch there by hand as a result. The session-tree
entry is broader than the scope guard's reach: the guard approves only each
session's own `…/claude-<uid>/<project>/<session>/scratchpad`, so a loose file
elsewhere in the tree is stranded. Every other directory the user listed stays.

The rails ship one `allow` entry: `mcp__plugin_workbench-core_memory__*`. It
keeps a classifier hold from swallowing a memory write. Nothing retries that
call, so a held write loses the note rather than delaying it. It grants no
command shape, since it is a single plugin's MCP server, and a `Bash(...)`
wildcard must never join it. No `Bash(...)` entry ships at all. Entries the user
put in `permissions.allow` themselves are never removed, reordered, or
rewritten.

### Why there is no `Read()` deny and no `rm` rule

Credential paths (`~/.ssh`, `~/.aws`, `~/.gnupg`, `.env`) are guarded by
the credential guard in the hooks module (`hooks/mods/guards.ts`) instead, a
refusal before the call runs, which no allow rule and no permission mode
overrides. A `Read` deny never applied to a subprocess that opens the file
itself, and any one of them arms a circuit breaker that prompts on every
relative-path `grep`/`rg`/`diff`/`git`/`cp`/`mv` in a command containing `cd`.
The `_comment` block in `assets/permissions/rails.json` has the full finding.

`rm` is gated by the destructive-scope guard (`hooks/mods/destructive-scope.ts`) and by nothing else. A deny on
`rm -rf /` would match every absolute-path delete: `*` is always a wildcard, and
deny beats allow regardless of specificity, so no `/tmp` exception is
expressible. Claude Code still gates the catastrophic case semantically
underneath: the classifier decides root and home removals in `auto` (including
inside `$(...)` and `<(...)` substitution), and they still prompt under
`bypassPermissions` as a circuit breaker.

### The five scope-able entries that left

`Bash(rm -rf:*)`, `Bash(git clean -fd:*)`, `Bash(git reset --hard:*)`,
`Bash(git stash clear:*)` and `Bash(git stash drop:*)` were the only ask entries
that act on a **filesystem path or on a repository**, which is what makes "inside
the project" a meaningful question about them. The ask entries that remain act on
published artifacts, system state, or the Keychain, where that question is
undefined, so they stay rules.

Those five encoded a **verb-based** policy: they prompted wherever the verb
acted, so an ordinary in-project delete cost the user a prompt. The policy this
machine runs is **scope-based**: work inside the project and the scratch roots is
permitted, and reaching outside them is the user's call. That cannot be layered
on an ask entry. Anthropic's permissions documentation states that hook decisions
do not bypass permission rules, and that a matching ask rule still prompts even
when a `PreToolUse` hook returned `"allow"`. So the five had to **leave** rather
than be narrowed. Narrowing one, or adding a scoped companion beside it, does
nothing: rules run deny → ask → allow, first match wins, specificity does not
reorder them, and Bash rules carry no negation operator.

The destructive-scope guard (`hooks/mods/destructive-scope.ts`) answers in their
place, and it ships in the plugin's hooks module. It permits a destructive command when
**every path it acts on** resolves inside the project or a scratch root. It asks when a target it can read
lies outside every root, and denies a target it cannot read. The roots are the project from `CLAUDE_PROJECT_DIR`, the login
home's `Developer/scratchpad`, this session's scratchpad, and on Darwin this
account's per-user temporary directory where `mktemp -d` writes. Two narrow
permits sit beyond the roots: a leftover `/tmp/claude-*scratch*` folder this
account owns (for `rm` and `rmdir` only), and a single session-summary marker
directly in `<cache>/pending-summaries/`. **No root comes from an environment
variable the caller can set.** Paths are resolved physically before comparison,
since a string prefix accepts a symlink pointing out of the tree.

It fails **closed**, which inverts every other guard in this plugin. A command
whose targets it cannot resolve (a `$variable`, a glob, `bash -c`, `ssh`,
`xargs`, `find -delete`) is denied rather than allowed through. The siblings fail
open because an unreadable command fell through to `Bash(rm -rf:*)` and cost one
prompt. With the five gone there is nothing underneath, so an unreadable command
waved through would be a command nothing checked.

Keeping the five in `rails.json` would not have been a safety net. The merge
only ever adds, so an entry left there is restored into a user's `settings.json`
the next time anybody runs setup, silently undoing the removal. For anyone who
ran setup before they were dropped, the reverse holds: they still have all five,
where they keep prompting and keep overriding the guard's permit. Step 2c.3
detects those leftovers.

### The headless constraint

An `ask` rule always forces a prompt, and a `claude -p` run has nobody to prompt,
so the call is denied unless a `PermissionRequest` hook answers it.
`workbench-dev-team` dispatches Watson unattended via `nohup claude -p --agent`,
and Watson commits, pushes branches, and opens PRs. Its own setup installs the
ask rules for `git commit` and `git push`, and its `pipeline-scope.sh` hook
answers those prompts for the pipeline, for `git`, `rm`, and `rmdir` only. So
the ask list here carries **no rule** for `git commit`, `git push`, or
`gh pr create`. A commit or push rule would duplicate the rules dev-team owns,
and a `gh pr create` rule would raise a prompt nothing answers.
`hooks/test-permissions.sh` asserts their absence.

### Why an `autoMode.allow` entry ships

The classifier's built-in **soft-deny** list includes *auto-mode bypass*. The
Dispatch task launches agents with `nohup claude -p --agent
workbench-dev-team:<name> --dangerously-skip-permissions`, which reads exactly
like Claude removing its own oversight, so the classifier blocks it. A soft deny
clears on explicit user intent, but a scheduled task has no user message to clear
it, so dispatch fails non-deterministically tick to tick.

`autoMode.allow` is the documented mechanism for an exception to a soft deny.
`permissions.allow` is the wrong lever: auto mode deliberately suspends broad
shell allow rules that grant arbitrary code execution, which is this command's
shape. `workbench-dev-team` allows its own `dispatch-agent.sh` wrapper by fixed
path, the narrow shape a `Bash(...)` allow entry may take, and the soft-deny
exception is still required because the wrapper performs the same spawn.

The literal string `"$defaults"` must stay in `autoMode.allow`. Without it,
Claude Code replaces the *entire* built-in soft-deny list: force push,
`curl | bash`, production deploys, auto-mode bypass, all of it.
`permissions.sh` prepends `"$defaults"` whenever it is missing. The classifier
reads `autoMode` only from `~/.claude/settings.json` and managed settings, never
from a repository's `.claude/settings.json`, so a checked-in repo cannot grant
itself exceptions.

## The stale-bundle guard (setup Step 2d)

The Claude **desktop app** serves plugin bundles from a server-ingested `rpm/`
cache (`api.anthropic.com`, keyed per `marketplaceId`), separate from the CLI's
local install. That ingest can freeze weeks behind: observed 2026-08-27 with
`workbench-core` pinned at 0.13.2 in the app while the CLI held 0.17.0, and
`workbench-dev-team` at 0.35.0 against 0.37.6. `claude plugin marketplace
update` refreshes only the CLI side.

A stale slash command can **overwrite state a newer version deployed**: the
0.35.0 `dev-team` setup would have rewritten a live scheduled task with a
month-old orchestrator body, stripping the per-item dispatch lock added in
0.37.x.

So the guard is deployed on three events, because staleness arrives three ways.
`UserPromptSubmit` catches a typed `/workbench-*` command. `PreToolUse(Skill)`
catches a skill invoked from prose ("run the memory lint"), which the first gate
never sees. `SessionStart` covers the case where nothing is invoked at all: a
frozen bundle also ships stale hooks and stale MCP servers. On 2026-08-29 a
frozen `workbench-core` 0.13.2 served a memory server whose venv layout predated
the installed fix, and every memory MCP in every session died with no warning
naming the cause. A marketplace update plus a relaunch is **not** sufficient to
evict a frozen bundle. Only a full reinstall is.

This cannot ship in `hooks/hooks.json`. The plugin is the thing that freezes, so
a plugin-declared hook never activates in the app it exists to protect, and
`${CLAUDE_PLUGIN_ROOT}` resolves *into* the frozen bundle. User settings are the
only layer outside the freeze, so the entries ship as data in
`assets/hooks/settings-hooks.json`. The guard makes the freeze visible and safe.
It does not unfreeze anything, and the freeze still needs escalating upstream
(`anthropics/claude-code#45810`).

## The MCP output cap (setup Step 2g)

`MAX_MCP_OUTPUT_TOKENS` replaced `hooks/mcp-output-cap.sh`, which truncated MCP
output in `PostToolUse`. The harness already persists an oversized response
before any `PostToolUse` hook sees it, so the hook only ever covered the band
between its own 60 KB cap and the harness limit.

## Retired: identity files (formerly setup field 7, Steps 3, 5 and 6)

Until 2026-09-27 setup collected `identity_files` paths (`soul_hot`,
`soul_core`, `profile`), re-templated soul and profile files from
`assets/templates/`, and launched the `define-profile` and `define-soul`
interviews. The session warmup injected those files, and pointed every session at
`identity/skills-protocol.md`.

All of it was retired together. No soul or profile file existed, and the only
shipped persona is the output style, so the warmup code and the setup fields had
no reader. `references/guardrails.md` survived only as the interview rubric, and
kept drifting from the output style. The skills protocol moved into
the hooks module, which merges each skill's own learnings file into the skill's
text (`hooks/mods/learnings.ts`). A file past 30 entries shows on the status line.

A config written before the retirement may still hold `identity_files`. Setup's
Step 2 merge deletes the key, and the warmup ignores it either way.
