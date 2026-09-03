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
ENV_RE="\\.env(?![A-Za-z0-9_-])"

# Programs that read file CONTENTS. For Bash, a protected path alone does not
# block: `ls ~/.ssh`, `stat ~/.ssh/id_rsa`, and `find . -name ".env*"` list
# names without exposing a secret, and blocking those costs more than it buys.
# This gate is what keeps the hook from becoming its own prompt-noise source.
READER_RE="\\b(cat|head|tail|less|more|strings|xxd|hexdump|od|base64|nl|tac|rev|\
grep|egrep|fgrep|rg|ag|ack|awk|gawk|sed|jq|yq|cut|paste|sort|uniq|diff|\
cp|mv|scp|rsync|tar|zip|gzip|curl|wget|nc|ncat|openssl|gpg|dd|tee|\
python|python3|node|bun|deno|php|ruby|perl|sqlite3|plutil|security|\
ssh-keygen|ssh-add|vim|nvim|nano|emacs|code|open)\\b"

# Emits the block message, or nothing at all when the call is allowed. A jq
# failure (malformed payload) yields nothing too, which is the allow path.
# Read/Edit/Write/NotebookEdit are given absolute paths by Claude Code, and
# DIR_RE accepts a leading `~` as well, so no path expansion is needed here.
MESSAGE=$(printf '%s' "$PAYLOAD" | jq -r \
  --arg dir "$DIR_RE" --arg env "$ENV_RE" --arg reader "$READER_RE" '
  def touches:
    if test($dir) then "a protected credential directory (~/.ssh, ~/.aws, ~/.gnupg)"
    elif test($env) then "a .env file"
    else "" end;

  (.tool_name // "") as $tool
  | (.tool_input // {}) as $in
  | if ["Read", "Edit", "Write", "NotebookEdit"] | index($tool) then
      (($in.file_path // $in.notebook_path // "") | tostring) as $path
      | ($path | touches) as $what
      | if $what == "" then empty
        else "this call touches \($what).\nPath: \($path)"
        end
    elif $tool == "Bash" then
      (($in.command // "") | tostring) as $cmd
      | ($cmd | touches) as $what
      | if $what == "" or ($cmd | test($reader) | not) then empty
        else "this call touches \($what).\nThe command also runs a file-reading program."
        end
    else empty
    end
  ' 2>/dev/null)

if [ -n "$MESSAGE" ]; then
  printf '🛑 Blocked by credential-guard: %s\n' "$MESSAGE" >&2
  printf 'If this is a false positive, run it yourself with the ! prefix.\n' >&2
  exit 2
fi

exit 0
