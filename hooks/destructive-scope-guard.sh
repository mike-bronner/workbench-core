#!/usr/bin/env bash
#
# destructive-scope-guard: PreToolUse guard that permits a destructive shell
# command when every path it acts on resolves inside the project or a scratch
# root, and refuses it when any path resolves outside — or when the guard
# cannot tell.
#
# THE POLICY IS SCOPE-BASED, AND IT USED TO BE VERB-BASED. `permissions.ask`
# listed the destructive verbs and prompted on every one of them regardless of
# where they acted, so an ordinary in-project delete cost a human a prompt.
# Five of those twenty-two entries acted on a filesystem path or on a
# repository, which is what makes "inside the project" a meaningful question
# about them: `rm -rf`, `git clean -fd`, `git reset --hard`, `git stash clear`,
# and `git stash drop`. Those five have been REMOVED from
# assets/permissions/rails.json, and this guard is what answers for them. The
# fifteen that remain act on published artifacts, system state, or the Keychain,
# where the question is undefined, and they stay rules.
#
# So nothing sits underneath this guard. That is not a temporary state to be
# careful around — it is the state the fail-closed rule below is written for.
#
# WHY THE RULES HAD TO LEAVE FOR THIS TO WORK AT ALL. Scope-awareness cannot be
# layered on top of an ask list. Anthropic's permissions documentation states
# that hook decisions do not bypass permission rules, and that a matching ask
# rule still prompts even when a PreToolUse hook returned "allow"; the
# sandboxing documentation says the same for sandboxed commands. So a
# content-scoped ask entry is overridden by nothing, and the scope-able entries
# had to come out for a guard to answer in their place.
#
# THE BASH SANDBOX IS NOT THE ALTERNATIVE, AND MUST NOT BE REINTRODUCED. It was
# tried on 2026-09-21 and reverted the same day. It enforced scope correctly at
# the syscall and broke two tools the dev-team pipeline runs on: `gh`, whose
# Go-based TLS goes through macOS trustd, and `git`, because the global config
# rewrites GitHub HTTPS to SSH and the egress proxy carries no SSH. Its
# `excludedCommands` workaround stops applying the moment a command appears in a
# pipeline beside anything non-excluded.
#
# THIS GUARD FAILS CLOSED, WHICH INVERTS THE CONVENTION EVERY SIBLING GUARD
# HERE FOLLOWS — READ THIS BEFORE CHANGING ANYTHING.
# credential-guard.sh, vault-git-guard.sh, destructive-database-guard.sh,
# provisioning-guard.sh and the retired scratch-delete-guard.sh all fail open,
# and they are right to: an unparseable command fell through to
# `Bash(rm -rf:*)` in permissions.ask and a human read a prompt, so the cost of
# a miss was one prompt. That entry is gone. A fail-open verdict here reaches
# the auto-mode classifier alone, so every shape the checker cannot read would
# be a hole rather than a prompt. hooks/lib/destructive-scope-check.py names in
# its own docstring exactly what it will not follow — `bash -c`, `ssh`, `xargs`,
# `find -delete`, globs, `$variables`, command substitution, a heredoc fed to a
# shell, a wrapper option sitting in the verb slot, a command past the read
# ceiling, and text that only tokenises through a lossy retry — and denies on
# every one of them.
#
# AND THE REAL PERIMETER IS THE TOKENISER, NOT THAT LIST. A shape the checker
# recognises and refuses is a documented limit; a shape that never reaches its
# dispatch loop is a bypass, and it looks like silence. A review on 2026-09-21
# found five of those at once — a `);` that swallowed the rest of the command, a
# subshell `cd` believed after the subshell ended, a trailing slash that turned
# a symlink into its target, a fabricated symlinked scratch root, and a read cut
# at 200,000 bytes. Every one was invisible rather than wrong. The audit in
# hooks/lib/shell_parse.py's own header is the record of that hunt, and it is
# where the next one starts.
#
# THE FAIL-CLOSED RULE BINDS THE VERDICT, NOT THE DEPLOYMENT, and the line
# between those is drawn deliberately. A command this guard reads and cannot
# resolve is denied. A guard that cannot RUN is a broken install rather than an
# undetermined command, and denying every Bash call because jq is missing takes
# the machine down instead of protecting it. So the payload-reading
# preconditions exit 0. Everything after the prefilter does not: by then the
# command is known to name a destructive verb, so a missing python3 or a missing
# checker is a destructive command nobody judged, and that denies.
#
# HARD BLOCK, NO PROMPT, NO OVERRIDE — AND THE DENIAL IS THE ROUTE.
# A PreToolUse hook returning permissionDecision "deny" refuses the call
# outright, and no allow rule or permission mode reaches it. It is also the only
# verdict that binds: a root-cause investigation on 2026-09-11, recorded in
# hooks/provisioning-guard.sh, measured that a hook returning "ask" is silently
# auto-approved by the auto-mode classifier, because a hook cannot set
# classifierApprovable. Of the three verdicts a hook can return, only "deny"
# does anything. So an out-of-scope or unreadable command is hard-blocked, and
# the way through is the human running it themselves with the ! shell-mode
# prefix. Every message below says so — for a target that is not scratch. The
# model-facing detail also says that scratch cleanup is never routed to the
# human, and that new scratch goes only into the scratchpads: an agent once made
# a probe root by hand under /tmp, and handed its cleanup to the user as a
# `! rm -rf` command, which spends the human's attention on the agent's
# leftovers. Those scratch sentences LEAD the detail, ahead of the checker's own
# text in $2: several of its refusals end "or run the command yourself with the
# ! prefix", and an agent that reads that first relays it to the user.
#
# THE ALLOW IS NARROW ON PURPOSE. A hook "allow" bypasses the permission system
# for the WHOLE call, so it is emitted only when the command does nothing but
# delete-or-git-destroy inside scope, plus `cd` and no-op prefixes. A command
# whose destructive half is in scope but which also runs something else gets
# silence — not a deny, since nothing about it is out of scope, and not an
# allow, since the grant would cover the other half too.
#
# WHY THE JSON DECISION RATHER THAN exit 2: measured on Claude Code 2.1.274
# (insights/2026-09-17-hook-message-channels-measured.md in the vault), exit 2
# prefixes the model's message with this script's absolute filesystem path and
# silently discards stdout. The JSON form keeps both channels, and it is the
# only mechanism that can carry additionalContext or an allow at all.
#
# THE REFUSAL IS SPLIT ACROSS THE TWO CHANNELS THAT MEASUREMENT FOUND.
# `permissionDecisionReason` becomes the tool_result and is what a PERSON reads,
# so it is ONE line naming the action that was gated, with no filesystem path in
# it. `additionalContext` survives a deny and reaches only the model, so the
# detail — which path, which roots were checked, what to do instead — lives
# there.
#
# NO MARKDOWN EMPHASIS, ANYWHERE. Whether a client renders the reason as
# Markdown is unsettled, and the model receives the raw source either way. So
# emphasis is carried by POSITION and by backticks, which read as a quoted
# command whether or not they are rendered.
#
# Exit 0 with no output = neutral; the ordinary permission flow applies.
# Exit 0 with permissionDecision "allow" = in scope, and the call goes through.
# Exit 0 with permissionDecision "deny" = the harness refuses the call.

set -u

PAYLOAD=""
if [ ! -t 0 ]; then
  PAYLOAD=$(cat)
fi
[ -n "$PAYLOAD" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

# One exit path per verdict, so the JSON shape can never drift between them.
deny() {
  jq -nc --arg reason "🛑 Blocked: $1. Run it yourself with the ! prefix if you meant it." \
         --arg context "Destructive-scope guard (workbench-core). Scratch cleanup is never the user's job, so never hand them a ! command to delete your scratch. If the target is scratch you made, spell its path out literally and retry, or leave it and name the path in your report. Make new scratch only in the session scratchpad or ~/Developer/scratchpad, never anywhere under /tmp outside your session scratchpad. $2 This guard permits a destructive command only when every path it acts on resolves inside the project or a scratch root: the session scratchpad, ~/Developer/scratchpad, or the mktemp -d temporary directory. rm and rmdir may also remove a leftover /tmp/claude-*scratch* folder this account owns, the folder itself included. That folder is not a root, so a git verb there is denied. It denies rather than guessing when it cannot resolve a path, because there is no permission rule underneath it. A target that is not your scratch and sits outside every root is the user's call, and they run it with the ! prefix." '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason,
      additionalContext: $context
    }
  }'
  exit 0
}

COMMAND=$(printf '%s' "$PAYLOAD" | jq -r '
  if (.tool_name // "") == "Bash"
  then ((.tool_input // {}).command // "") | tostring
  else "" end
  ' 2>/dev/null)
[ -n "$COMMAND" ] || exit 0

# Cheap exit before anything expensive. This hook runs on EVERY Bash call, and
# everything below costs a python start — measured at ~70ms against ~11ms for
# this early exit.
#
# THESE FIVE SUBSTRINGS ARE THE CHECKER'S VERB SET, AND THEY MUST STAY THAT WAY.
# A destructive verb the checker knows and this list does not is a command that
# never reaches the checker at all, which is the fail-open hole this guard
# exists to close — and nothing would report it. As of this writing:
#   rm      `rm` and `rmdir`, in every spelling
#   reset   `git reset --hard`
#   clean   `git clean`
#   stash   `git stash clear` and `git stash drop`
#   delete  `find -delete`, which spells its destruction in a flag, not a verb
# The git verbs are keyed on the SUBCOMMAND rather than on "git", because `git`
# alone matches every ordinary git call and made all of them pay the python
# start for nothing. A wrapper hiding one of these — `bash -c "git clean -fd"`,
# `ssh host "rm -rf /"` — carries the word in its argument text, so it matches
# here too. Substring rather than word match on purpose: `sudo rm`, `/bin/rm`,
# and `cd x && rm -rf y` all have to reach the checker.
#
# Every verb above is covered end-to-end by hooks/test-destructive-scope-guard.sh,
# which drives the whole guard rather than the checker alone — so a verb added
# to the checker without a case here fails its own test.
#
# MATCHED CASE-INSENSITIVELY, which is not tidiness. A command whose verb is
# held in a variable spells the verb in that variable's NAME, and the convention
# for a shell variable is upper case: `${RM} -rf /etc/x` runs `rm` and contains
# no lower-case `rm` anywhere. A case-sensitive prefilter dropped it here, so
# the checker's verdict about computed verb slots never ran. The bracket classes
# are what make this case-insensitive without a fork — bash 3.2 ships on macOS
# and has no ${var,,}, and `tr` or `grep -i` would each cost the fork this check
# exists to avoid. Same idiom as hooks/provisioning-guard.sh.
#
# THE FLOOR, STATED RATHER THAN IMPLIED: a verb held in a variable whose name
# gives no hint — `${TOOL} -rf /etc/x`, with TOOL set to rm in an earlier,
# separate call — matches nothing here and is not reachable by any text-based
# guard. That is the limit of this mechanism, not an oversight in it.
case "$COMMAND" in
  *[rR][mM]* | *[rR][eE][sS][eE][tT]* | *[cC][lL][eE][aA][nN]* \
  | *[sS][tT][aA][sS][hH]* | *[dD][eE][lL][eE][tT][eE]*) ;;
  *) exit 0 ;;
esac

# Past this line the command is known to name a destructive verb, so the
# fail-closed rule applies to the tooling as well: a checker that cannot run is
# a destructive command nobody judged.
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
CHECKER="$HOOKS_DIR/lib/destructive-scope-check.py"
if ! command -v python3 >/dev/null 2>&1; then
  deny "a destructive command this guard could not check" \
"python3 is not on this guard's PATH, so the command could not be read at all."
fi
if [ ! -f "$CHECKER" ]; then
  deny "a destructive command this guard could not check" \
"The checker at lib/destructive-scope-check.py is missing from this plugin, so the command could not be read at all. Re-install workbench-core."
fi

# The call's working directory, which is what a relative operand and a bare
# `git reset --hard` both resolve against.
CWD=$(printf '%s' "$PAYLOAD" | jq -r '.cwd // ""' 2>/dev/null)

# The session scratchpad is one of the four roots, and it is found by matching
# the session id. The payload's id is the id of the call being judged, so it is
# the right source; the environment is the fallback for a payload that carries
# none. A malformed id is dropped rather than pushed into a glob as a path
# fragment.
SESSION_ID=$(printf '%s' "$PAYLOAD" | jq -r '.session_id // ""' 2>/dev/null)
case "$SESSION_ID" in
  '' | *[!A-Za-z0-9-]*) SESSION_ID="${CLAUDE_CODE_SESSION_ID:-}" ;;
esac

FINDING=$(printf '%s' "$COMMAND" | python3 "$CHECKER" "$CWD" "$SESSION_ID" 2>/dev/null)
STATUS=$?

if [ "$STATUS" = "1" ] && [ -n "$FINDING" ]; then
  # Line 1 is the action the human line names, the rest is the model's detail.
  # See the checker's docstring for the contract.
  deny "${FINDING%%$'\n'*}" "${FINDING#*$'\n'}"
fi

# A status this contract does not define is the checker crashing, and the
# command that made it crash is one that named a destructive verb.
if [ "$STATUS" != "0" ]; then
  deny "a destructive command this guard could not check" \
"The checker exited with status $STATUS, so it reached no verdict about this command."
fi

if [ "$FINDING" = "allow" ]; then
  jq -nc --arg reason "✅ In scope: every path this command acts on resolves inside the project or a scratch root." '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: $reason
    }
  }'
fi

exit 0
