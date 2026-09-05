#!/usr/bin/env bash
#
# credential-guard: PreToolUse guard that blocks reads of credential paths —
# ~/.ssh, ~/.aws, ~/.gnupg, and .env files — before the call runs.
#
# This replaces four Read() deny rules that used to ship in
# assets/permissions/rails.json. They were removed for two reasons:
#
#   1. A Read deny rule is not enforcement. It applies to the built-in file
#      tools and to the file commands Claude Code recognises in Bash (cat,
#      head, tail, sed), and NOT to arbitrary subprocesses that open files
#      themselves — a Python or Node script walks straight through it.
#   2. Any Read() deny rule arms Claude Code's `xce()` circuit breaker, which
#      forces a permission prompt on every grep/rg/diff/git/cp/mv carrying a
#      relative path in a command that also contains `cd`. It is a plain
#      boolean over the deny list, registered bypassImmune with no classifier
#      route, so no allow rule and no permission mode overrides it, and
#      narrowing the rules does not help — only removing them all disarms it.
#
# A PreToolUse hook exiting 2 blocks the call BEFORE permission rules are
# evaluated, so no prompt appears and no allow rule can override it. It also
# covers strictly more than the deny rules did: `python3 -c
# "print(open('~/.ssh/id_rsa').read())"` is caught here and never was there.
#
# TWO STAGES, AND WHY THE DOTENV RULE NEEDED A SECOND ONE:
# Stage 1 is the jq filter below. It runs on every Bash call, so it has to stay
# cheap, and it tests the raw command TEXT. That is enough for DIR_RE, which is
# anchored on both sides and names an absolute location. It was never enough for
# ENV_RE: a command that merely DISCUSSES a dotenv file carries the same
# characters as one that reads it, and on 2026-09-04 stage 1 blocked three such
# commands in one day — a `gh pr merge` body about dotenv handling, this
# plugin's own setup snippet, and a python3 heredoc naming two dotenv files in
# prose. Not one of them opened a file.
#
# Stage 2 is hooks/lib/credential-check.py, and it runs only when the dotenv
# branch fires on a Bash call. It tokenises the command through
# hooks/lib/shell_parse.py and asks whether the `.env` sits in an argument SLOT
# or inside a string — the question stage 1 cannot ask. DIR_RE is deliberately
# NOT refined: it is anchored, it is not producing false positives, and stage
# 2's rule (a token with whitespace in it is prose) would start ALLOWING
# `python3 -c "x = open('$HOME/.ssh/id_rsa')"`.
#
# THIS GUARD FAILS CLOSED, unlike vault-git-guard.sh and
# destructive-database-guard.sh, and the difference is structural rather than a
# change of mind. Those two decide whether to block AT ALL, so a checker they
# cannot run has to allow — the alternative is a broken interpreter freezing
# ordinary work. Stage 2 here only ever NARROWS a block that stage 1 already
# decided on, so the same failure has the opposite meaning: a missing python3, a
# missing checker file, or a checker that raises leaves the block standing. A
# refinement that cannot run must not be able to disarm the rule it refines.
#
# Scope: this guards Claude's own tool calls. It is not an OS boundary — for
# that, enable the sandbox (`/sandbox`), which enforces in the kernel for every
# subprocess. So anything unparseable exits 0 rather than blocking the session.
#
# Exit codes: 0 = allow (default). 2 = block; stderr is surfaced to the model
# on a blocking PreToolUse hook.

set -u

PAYLOAD=""
if [ ! -t 0 ]; then
  PAYLOAD=$(cat)
fi
[ -n "$PAYLOAD" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
CHECKER="$HOOKS_DIR/lib/credential-check.py"

# $HOME goes into a regex, so escape whatever metacharacters a home path holds.
HOME_RE=$(printf '%s' "$HOME" | sed 's/[][\.^$*+?(){}|\\]/\\&/g')

# A protected directory reached via ~, $HOME, ${HOME}, or the literal home
# path. The leading and trailing groups keep `Developer/x/.ssh` — an unrelated
# tree that merely shares the name — from matching.
BEFORE='(^|[[:space:]"'\''=:(])'
AFTER='(/|$|[[:space:]"'\'';)])'
DIR_RE="${BEFORE}(~|\\\$HOME|\\\$\\{HOME\\}|${HOME_RE})/\\.(ssh|aws|gnupg)${AFTER}"

# `.env` and `.env.production`, but never `.envrc` — the same scope the removed
# Read(**/.env) rule had. A prefix test is not a name test: the trailing
# negative lookahead is what separates the two, and jq's Oniguruma engine is
# why this hook does not need `grep -P` (which macOS does not have).
#
# Stage 1 only. A hit here is a CANDIDATE, not a verdict: for Bash the
# tokeniser in stage 2 decides whether the characters are a path or a sentence.
ENV_RE="\\.env(?![A-Za-z0-9_-])"

# A committed template — `.env.example` and its siblings — holds placeholder
# values by convention, not secrets, so reading one exposes nothing. Anchored at
# the end of the path component, so `.env.example.bak` stays a hit: an
# unanchored suffix test would admit any path that merely contains the word.
# Applied here only to the file tools, whose file_path is a single path and
# needs no tokenising. hooks/lib/credential-check.py carries the same list for
# Bash tokens, and the two must stay in step.
TMPL_RE="\\.env[^/]*\\.(example|sample|template|dist|defaults?)\$"

# Programs that read file CONTENTS. For Bash, a protected path alone does not
# block: `ls ~/.ssh`, `stat ~/.ssh/id_rsa`, and `find . -name ".env*"` list
# names without exposing a secret, and blocking those costs more than it buys.
# This gate is what keeps the hook from becoming its own prompt-noise source.
READER_RE="\\b(cat|head|tail|less|more|strings|xxd|hexdump|od|base64|nl|tac|rev|\
grep|egrep|fgrep|rg|ag|ack|awk|gawk|sed|jq|yq|cut|paste|sort|uniq|diff|\
cp|mv|scp|rsync|tar|zip|gzip|curl|wget|nc|ncat|openssl|gpg|dd|tee|\
python|python3|node|bun|deno|php|ruby|perl|sqlite3|plutil|security|\
ssh-keygen|ssh-add|vim|nvim|nano|emacs|code|open)\\b"

# Stage 1. Emits the matched rule's kind on the first line and the human
# message on the lines after, or nothing at all when the call is allowed. The
# kind is what lets the shell below tell WHICH rule fired, since only the dotenv
# one is refined. A jq failure (malformed payload) yields nothing too, which is
# the allow path. Read/Edit/Write/NotebookEdit are given absolute paths by
# Claude Code, and DIR_RE accepts a leading `~` as well, so no path expansion is
# needed here.
RESULT=$(printf '%s' "$PAYLOAD" | jq -r \
  --arg dir "$DIR_RE" --arg env "$ENV_RE" --arg tmpl "$TMPL_RE" \
  --arg reader "$READER_RE" '
  def kind:
    if test($dir) then "dir"
    elif test($env) then "env"
    else "" end;

  def describe:
    if . == "dir" then "a protected credential directory (~/.ssh, ~/.aws, ~/.gnupg)"
    else "a .env file" end;

  (.tool_name // "") as $tool
  | (.tool_input // {}) as $in
  | if ["Read", "Edit", "Write", "NotebookEdit"] | index($tool) then
      (($in.file_path // $in.notebook_path // "") | tostring) as $path
      | ($path | kind) as $found
      # One path, so the template test is safe on the whole string here. It
      # would NOT be for a Bash command: `cat .env.example .env` contains a
      # template and a secret, and a whole-string test would clear both.
      | (if $found == "env" and ($path | test($tmpl; "i"))
         then "" else $found end) as $hit
      | if $hit == "" then empty
        else "\($hit)\nthis call touches \($hit | describe).\nPath: \($path)"
        end
    elif $tool == "Bash" then
      (($in.command // "") | tostring) as $cmd
      | ($cmd | kind) as $hit
      | if $hit == "" or ($cmd | test($reader) | not) then empty
        else "\($hit)\nthis call touches \($hit | describe).\nThe command also runs a file-reading program."
        end
    else empty
    end
  ' 2>/dev/null)

[ -n "$RESULT" ] || exit 0

KIND=${RESULT%%$'\n'*}
MESSAGE=${RESULT#*$'\n'}

# Stage 2. The dotenv rule only, and only for Bash: the file tools hand over a
# single path that stage 1 has already judged in full, and DIR_RE is never
# refined. Every failure here — no python3, no checker, a checker that raises —
# falls through to the block, because this pass may only narrow one.
if [ "$KIND" = "env" ]; then
  COMMAND=$(printf '%s' "$PAYLOAD" | jq -r '
    if (.tool_name // "") == "Bash"
    then ((.tool_input // {}).command // "") | tostring
    else "" end
    ' 2>/dev/null)

  if [ -n "$COMMAND" ] && command -v python3 >/dev/null 2>&1 && [ -f "$CHECKER" ]; then
    VERDICT=$(printf '%s' "$COMMAND" | python3 "$CHECKER" 2>/dev/null)
    STATUS=$?
    # Both halves are required, and the sentinel is the load-bearing one. A
    # Python traceback also exits 1, so the exit code alone would read a crashed
    # checker as permission to proceed; a crash leaves stdout empty and cannot
    # produce the word.
    if [ "$STATUS" = "1" ] && [ "$VERDICT" = "allow" ]; then
      exit 0
    fi
  fi
fi

printf '🛑 Blocked by credential-guard: %s\n' "$MESSAGE" >&2
printf 'If this is a false positive, run it yourself with the ! prefix.\n' >&2
exit 2
