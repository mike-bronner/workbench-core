#!/usr/bin/env bash
#
# scratch-delete-guard: PreToolUse guard that refuses an `rm` aimed at a path
# beneath an approved scratchpad root, and hands back the sanctioned command
# that deletes it with no prompt.
#
# It exists because a helper nothing names is a helper nobody runs. bin/
# scratch-rm.sh has shipped for a while, /workbench-core:setup writes the
# matching permissions.allow entry, and the pair work: run that command and a
# scratchpad directory is gone with no prompt at all. But a grep for its name
# across this repo finds it in README.md, assets/permissions/rails.json,
# skills/setup/SKILL.md, the script, and its test — and not one of those loads
# into a session's context. So every agent reaches for `rm -rf` by reflex, hits
# the `Bash(rm -rf:*)` entry in permissions.ask, and a human reads a prompt.
# Once per cleanup, in every session and every sub-agent, indefinitely.
#
# WHY A HOOK, AND NOT ONLY THE INSTRUCTION THAT SHIPS BESIDE IT:
# scratch-rm.sh's own header argues that this exception could not be written as
# a permission rule and had to become logic inside a command. The same argument
# runs one layer up. "Reach for scratch-rm.sh instead of rm" is a sentence, and
# a sentence is advice: it competes with a reflex, it fades as a session fills,
# and nothing reports the turns where it lost. hooks/session-warmup.sh carries
# the instruction so an agent knows the command BEFORE it is ever denied one,
# and this hook is what makes the instruction hold when it does not land.
#
# THE DENIAL IS A ROUTE, NOT A WALL, and that is the whole contract. It carries
# the exact command to run instead, so the agent retries and succeeds on the
# next call. That round trip is the accepted cost.
#
# WHICH DELETES IT COVERS. `rm -rf` is the one people notice, because an ask
# rule prompts on it. `rm -r` without `-f`, plain `rm`, and `rmdir` match no
# permission rule at all today and fall through to the auto-mode classifier,
# which can prompt too — and no rule can be written for them without the same
# impossibility scratch-rm.sh documents. This guard is the only place that
# covers them, so it covers all four.
#
# IT AGREES WITH THE HELPER BY ASKING IT, NEVER BY MATCHING ITS LOGIC:
# a guard that refuses an `rm` the helper then refuses as well hands the agent
# two closed doors. So no root list, no prefix comparison and no symlink check
# lives here. Each candidate path is put to `scratch-rm.sh --check`, which runs
# every refusal in that script and stops immediately before the delete. The
# copy asked is the INSTALLED one at $HOME/.claude-workbench/bin, the one the
# sanctioned spelling names, so the code answering this guard is the code that
# will run the delete. Missing, or not executable, means the sanctioned command
# does not exist on this machine — nothing to route to, so this guard stands
# down entirely rather than denying into a void.
#
# THIS GUARD DELETES NOTHING, EVER. Its only outputs are silence and a refusal.
# `--check` is a verdict, not an action, and it is the only thing here that
# touches the helper at all. A delete performed from a hook would be a second
# unprompted delete path outside the reviewed one, which is the thing
# scratch-rm.sh exists to be the only instance of.
#
# THE SPELLING IN THE MESSAGE IS LOAD-BEARING. The shipped allow entry names
# this command in the `"$HOME"` form and nothing else, so `sh <path>`, a `~/`
# path, or the absolute path written out is matched by no rule, reaches the
# classifier, and prompts — which would leave the agent exactly where it
# started. The message therefore quotes the `$HOME` form literally.
#
# FAIL OPEN, matching every sibling guard, and for the vault-git-guard's reason
# rather than credential-guard.sh's: there is no adversary here. The threat is a
# reflex, not a crafted payload. Missing jq, missing python3, a missing checker,
# a command that will not parse, a helper that will not answer — every one of
# them exits 0, and the call goes on to the prompt it would have hit anyway.
# The cost of a miss is one prompt, which is the status quo.
#
# WHY THE JSON DENY RATHER THAN exit 2: measured on Claude Code 2.1.274
# (insights/2026-09-17-hook-message-channels-measured.md in the vault), exit 2
# prefixes the model's message with this script's absolute filesystem path and
# silently discards stdout. Here that would bury the command the agent has to
# retype. The JSON deny keeps both channels and is the only mechanism carrying
# additionalContext.
#
# THE REFUSAL IS SPLIT ACROSS THE TWO CHANNELS THAT MEASUREMENT FOUND.
# `permissionDecisionReason` becomes the tool_result and is what a PERSON reads,
# so it is ONE line naming the action that was gated. `additionalContext`
# survives a deny and reaches only the model, so the command to run — the part
# that makes this a route — lives there.
#
# NO MARKDOWN EMPHASIS, ANYWHERE. Whether a client renders the reason as
# Markdown is unsettled, and the model receives the raw source either way. So
# emphasis is carried by POSITION and by backticks, which read as a quoted
# command whether or not they are rendered.
#
# Exit 0 with no output = allow (default).
# Exit 0 with permissionDecision "deny" = the harness refuses the call.

set -u

PAYLOAD=""
if [ ! -t 0 ]; then
  PAYLOAD=$(cat)
fi
[ -n "$PAYLOAD" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
CHECKER="$HOOKS_DIR/lib/scratch-delete-check.py"
[ -f "$CHECKER" ] || exit 0

# The installed helper, named exactly as the sanctioned spelling names it. Not
# the plugin's own copy: the agent will run the installed one, and a guard that
# judged a different file could disagree with the command it recommends.
HELPER="${HOME:-}/.claude-workbench/bin/scratch-rm.sh"
[ -n "${HOME:-}" ] || exit 0
[ -r "$HELPER" ] || exit 0

COMMAND=$(printf '%s' "$PAYLOAD" | jq -r '
  if (.tool_name // "") == "Bash"
  then ((.tool_input // {}).command // "") | tostring
  else "" end
  ' 2>/dev/null)
[ -n "$COMMAND" ] || exit 0

# Cheap exit before anything expensive. This hook runs on EVERY Bash call, and
# everything below it costs a python start plus a helper run per path. A command
# with neither "rm" nor "rmdir" anywhere in its text cannot invoke either, so it
# should pay nothing. Substring rather than word match on purpose: `sudo rm`,
# `/bin/rm`, and `cd x && rm -rf y` all have to reach the checker.
case "$COMMAND" in
  *rm*) ;;
  *) exit 0 ;;
esac

# The call's working directory, which is what a relative operand resolves
# against. Absent, a relative path settles no file and the checker drops the
# command rather than guessing at one.
CWD=$(printf '%s' "$PAYLOAD" | jq -r '.cwd // ""' 2>/dev/null)

# The session scratchpad is one of the three roots the helper approves, and it
# finds that root by matching CLAUDE_CODE_SESSION_ID. The payload's session_id
# equals that variable in Bash tool calls (the delegation gate verified this
# empirically), and it is the id of the call being judged, so it is the right
# source. A malformed one is not exported at all — the helper would drop it
# anyway, and overwriting a good inherited value with rubbish would lose the
# session root for no reason.
SESSION_ID=$(printf '%s' "$PAYLOAD" | jq -r '.session_id // ""' 2>/dev/null)
case "$SESSION_ID" in
  '' | *[!A-Za-z0-9-]*) SESSION_ID="${CLAUDE_CODE_SESSION_ID:-}" ;;
esac

# The two halves of a POSIX single-quote escape, built here rather than inline
# because the backslash count is unreadable at the point of use. A path holding
# a quote is pathological, and a suggested command that breaks on one would
# still be this guard handing over something that cannot be typed.
QUOTE="'"
ESCAPED_QUOTE="'\\''"

# EVERY path must be one the helper accepts, not merely one of them. The
# recovery this guard offers is "run these commands instead", and that sentence
# is only true when it covers the whole call — `rm -rf /scratch/a /etc/b` has no
# scratch-rm spelling, so denying it would strand the agent. One refusal ends
# the run and the call goes through to its ordinary prompt.
#
# The checker's output is read straight off a file descriptor and never through
# `$(...)`, which discards NUL bytes — and NUL is the separator, chosen because
# a newline is a legal character in a path. Process substitution rather than a
# pipe keeps this loop in the current shell, so the `exit 0` inside it ends the
# hook rather than a subshell of it, which is the fail-open path.
COMMANDS=""
COUNT=0
while IFS= read -r -d '' TARGET; do
  [ -n "$TARGET" ] || exit 0
  CLAUDE_CODE_SESSION_ID="$SESSION_ID" bash "$HELPER" --check "$TARGET" \
    >/dev/null 2>&1 || exit 0
  COUNT=$((COUNT + 1))
  # An ordinary path is offered bare, which is the spelling scratch-rm.sh's own
  # header and the setup skill both document — a suggestion that matches the
  # documentation everywhere else is one less thing for a reader to reconcile.
  # Anything outside that character set is single-quoted instead, because a
  # command the agent cannot paste is not a route. The allow rule is unaffected
  # either way: it matches the prefix up to the script path, and every argument
  # falls inside its trailing wildcard.
  case "$TARGET" in
    *[!A-Za-z0-9/._-]*)
      SAFE="${TARGET//$QUOTE/$ESCAPED_QUOTE}"
      SAFE="'$SAFE'"
      ;;
    *) SAFE="$TARGET" ;;
  esac
  COMMANDS="${COMMANDS}bash \"\$HOME/.claude-workbench/bin/scratch-rm.sh\" $SAFE"$'\n'
done < <(printf '%s' "$COMMAND" | python3 "$CHECKER" "$CWD" 2>/dev/null)

[ "$COUNT" -gt 0 ] || exit 0

if [ "$COUNT" -eq 1 ]; then
  RUN="Run this instead, exactly as spelled:"
else
  RUN="Run these instead, one per path, exactly as spelled:"
fi

jq -nc \
  --arg reason '🛑 Blocked: deleting a scratchpad path with `rm`, which prompts. The sanctioned command does it unprompted — it is in the context block.' \
  --arg context "Scratch-delete guard (workbench-core). Every path this command deletes sits beneath an approved scratchpad root, where bin/scratch-rm.sh deletes it with no permission prompt at all. $RUN
${COMMANDS}That spelling is load-bearing: the shipped permissions.allow entry names the command in the \"\$HOME\" form and nothing else, so \`sh\` instead of \`bash\`, a \`~/\` path, or the absolute path written out is matched by no rule and prompts. Type it with the literal \$HOME and let the shell expand it. The helper takes one path per call, deletes nothing outside a scratch root, and refuses a root itself. This is not a dead end — retry with the command above and it goes through." '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason,
    additionalContext: $context
  }
}'

exit 0
