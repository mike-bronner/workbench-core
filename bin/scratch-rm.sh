#!/bin/bash
#
# scratch-rm.sh — delete ONE path beneath an approved scratchpad root, with no
# permission prompt.
#
#   bash "$HOME/.claude-workbench/bin/scratch-rm.sh" <absolute-path>
#
# Type that spelling exactly. The shipped `permissions.allow` entry names this
# command in the `"$HOME"` form and nothing else, so `sh <path>`, a `~/` path, or
# the absolute path spelled out is matched by no rule, reaches the classifier,
# and prompts — the behaviour this script exists to avoid, failing safe.
#
# WHY THIS COMMAND EXISTS, RATHER THAN A PERMISSION RULE.
# `Bash(rm -rf:*)` sits in permissions.ask and must stay there: it is the only
# `rm` guard the workbench ships, and assets/permissions/rails.json records at
# length why a deny rule would be worse. That ask rule fires on every scratchpad
# cleanup, which is the one `rm -rf` an agent runs constantly and which no human
# wants to read a prompt about.
#
# The exception cannot be written as a rule. Claude Code evaluates permission
# rules deny → ask → allow, first match wins, and specificity does not reorder
# them — so a narrow allow rule never suppresses a broader ask rule. Bash rules
# also support no negation operator. "Ask for `rm -rf`, except under a scratch
# root" is therefore not expressible in settings.json at all: adding
# `Bash(rm -rf /tmp/:*)` to `allow` does nothing, because the ask rule matches
# first, every time.
#
# What does work is giving the safe operation its own command at a stable path
# and allowing that command. This script's name does not begin with `rm`, so the
# ask rule is never tested against it and the allow entry resolves it outright.
# The real check then moves in here, where it can be logic instead of a glob —
# which matters, because a glob is precisely what cannot do this job correctly.
# Same shape as approve-commit.sh and dispatch-agent.sh, same install location.
#
# WHAT IT REFUSES, AND WHY EACH REFUSAL IS THERE.
#   * A path that is not strictly beneath one of the roots below.
#   * A scratch root itself. Every root holds live state this command has no
#     business destroying: the two scratchpads are shared across sessions, and
#     the global CLAUDE.md forbids deleting either one, while the temporary root
#     holds the working files of every process this account is running.
#   * A relative path, `.`, `..`, or a path whose parent does not exist. Each
#     one makes the verdict depend on something other than the path itself.
#   * More than one path. Sweeping a scratchpad by glob or age filter is
#     forbidden for the same reason the roots are: one argument means one
#     deliberate delete, never a wipe of another session's work.
#   * Any option-shaped argument, so nothing here can become a flag to `rm`.
# Every refusal deletes nothing and exits non-zero. There is no fallback to a
# plain delete: a silent fallback would reintroduce the unprompted `rm -rf` this
# whole design exists to prevent.
#
# THE CHECK RESOLVES THE PATH PHYSICALLY, AND A STRING PREFIX WOULD NOT DO.
# The parent directory is resolved with `cd -P` before the comparison, so `..`
# segments are collapsed and every symlink in the parent chain is followed. A
# path that merely STARTS with an approved prefix can still land outside it —
# `<root>/link/x` where `link` points at a repository, or `<root>/../../etc` —
# and a prefix comparison accepts both. That weakness is the same one that makes
# a settings.json rule impossible, so it is not repeated here.
#
# The final path component is deliberately NOT dereferenced. `rm -rf` on a
# symlink removes the link and never its target, so deleting a symlink that sits
# inside a scratchpad is safe and is ordinary cleanup.
#
# THE APPROVED ROOTS are the two the user's global CLAUDE.md names, plus the
# per-user temporary directory an agent's own sandboxes are made in:
#   1. <login home>/Developer/scratchpad — the persistent scratchpad. The home
#      directory is read from the password database, not from $HOME, and $HOME
#      is accepted only when it names that same directory. The next section is
#      why.
#   2. The per-session scratchpad the harness announces, found by matching
#      CLAUDE_CODE_SESSION_ID (set natively by Claude Code) under
#      /private/tmp/claude-*/ and /tmp/claude-*/. Matching the id pins this to
#      THIS session's scratchpad: a sibling session's directory sits under the
#      same prefix, and losing another session's work is the exact outcome the
#      CLAUDE.md rule is written against. With the variable unset or malformed,
#      no session root is approved and the delete falls back to prompting.
#   3. This account's per-user temporary directory on Darwin, read from
#      confstr(3) through `/usr/bin/getconf DARWIN_USER_TEMP_DIR`. That is where
#      `mktemp -d` lands, so tearing down a sandbox is the delete an agent asks
#      for most, and it is the one that kept prompting while roots 1 and 2 were
#      the whole list. The directory is mode 0700 and owned by this account, so
#      no file of another user's is reachable through it. It is NOT read from
#      $TMPDIR, for the reason two sections down.
#
#      Off Darwin nothing is approved for this, and the refusal says so. Linux
#      `mktemp -d` writes into $TMPDIR or, failing that, /tmp — and /tmp is
#      shared by every account on the machine, so approving it would let this
#      command delete another user's work unprompted, which is worse than the
#      prompt it removes. /run/user/<uid> is private and mode 0700, but it is
#      systemd's runtime directory rather than a temporary one, `mktemp -d`
#      never writes there, and approving it would remove no prompt anyone is
#      seeing.
#
# $HOME IS AN INPUT, AND THIS SCRIPT NO LONGER TRUSTS IT.
# A root the caller chooses is not a root. Point $HOME at a directory holding
# `Developer/scratchpad` — a real one, or a symlink to somewhere else entirely —
# and every check below passes while the wrong tree is deleted. The resolution
# worked exactly as designed; the root it resolved against was the attacker's.
# That was reproduced against an earlier version of this file.
#
# That is not reachable unprompted today, and the reason sits outside this file:
# a Claude Code allow rule does not match past an assignment of a variable
# outside a known-safe list, and `HOME` is not on it, so `HOME=… bash …` is
# matched by no rule, reaches the classifier, and prompts. That is a guarantee
# from a layer this script cannot see, cannot test, and never stated. Borrowing
# it left this script's own answer wrong. The check is here now, and it is this
# script's own:
# the login home is read from the password database through bash's `~name`
# expansion, which no environment variable and no PATH can redirect, and $HOME
# is accepted only when it resolves to that same directory. When it does not,
# the persistent root is not approved at all and the refusal prints the reason.
# The session root is unaffected either way — it never derives from $HOME.
#
# $TMPDIR IS AN INPUT TOO, AND IT NAMES NO ROOT HERE.
# On an ordinary login $TMPDIR holds the same path root 3 resolves to, and it is
# still an environment variable: a caller who sets it picks the root, which is
# the $HOME hole above under a new name. So the root is read from getconf and
# never from $TMPDIR. `getconf` is spelled by absolute path, and
# confstr(_CS_DARWIN_USER_TEMP_DIR) answers from this account's own directory
# rather than from the environment — measured on 2026-09-16 with $TMPDIR, $HOME
# and $PATH all pointed at /etc, which changed the answer not at all.
#
# A redirected $TMPDIR therefore approves nothing, and it does so out loud:
# every refusal says that $TMPDIR is not this account's temporary directory.
# `mktemp -d` does follow $TMPDIR, so a sandbox made under a redirected one
# lands outside every root and is refused — back to prompting, which is the safe
# direction to fail.
#
# `--check` IS THE SAME VERDICT WITHOUT THE DELETE, AND IT EXISTS FOR THE GUARD.
# hooks/scratch-delete-guard.sh intercepts an `rm` aimed at a scratchpad path,
# refuses it, and tells the agent to run this command instead. That guard has to
# reach the SAME verdict this script would. If it refuses an `rm` that this
# script then refuses as well, the agent is handed two closed doors and no way
# through — so a second implementation of "what counts as a scratch root" is not
# an option, however carefully it were written.
#
# So the guard does not have one. It runs `--check <path>`, which performs every
# refusal above and stops at the line immediately before the delete. Nothing is
# written, nothing is removed, and no message is printed: the exit status is the
# entire answer, and 0 means this script would accept that delete. The guard
# runs the INSTALLED copy — the one the sanctioned spelling above names — so the
# code answering the guard is the code that will run the delete, byte for byte.
#
# Exit codes: 0 ok/no-op (or, with --check, would be accepted) · 1 refused,
# nothing deleted · 2 usage error.

set -u
CDPATH=''

SANCTIONED='bash "$HOME/.claude-workbench/bin/scratch-rm.sh" <absolute-path>'
HOME_DIR="${HOME:-}"

usage() {
  [ "$#" -eq 0 ] || printf '%s\n' "$@" >&2
  printf '%s\n' "usage: $SANCTIONED" >&2
  printf '%s\n' "Deletes one path beneath an approved scratchpad root. One path, no options." >&2
  exit 2
}

# Every refusal ends here: nothing has been deleted, and the caller is told the
# one route that still works — the prompting one.
refuse() {
  printf '%s\n' "$@" >&2
  printf '%s\n' "   Nothing was deleted. If that path is really the one you want, delete it with \`rm -rf\`, which prompts." >&2
  exit 1
}

# Physical path of an existing directory, or a non-zero status when it is not
# one. `cd -P` follows every symlink in the chain and collapses `..` against the
# real tree, which is what makes the comparison below a fact rather than a guess.
resolve_dir() {
  (cd -P -- "$1" 2>/dev/null && pwd -P)
}

# This account's login home, read from the password database instead of the
# environment: bash expands `~name` through getpwnam(3), and `id` is spelled by
# absolute path, so no variable and no PATH the caller sets can redirect this
# answer. `set -f` keeps a home directory holding a glob character from
# expanding against the filesystem.
login_home() {
  local user
  user="$(/usr/bin/id -un 2>/dev/null)" || return 1
  case "$user" in
    "" | *[!A-Za-z0-9._-]*) return 1 ;;
  esac
  (set -f; eval "printf '%s\n' ~$user")
}

# This account's per-user temporary directory, read from confstr(3) rather than
# from $TMPDIR: `getconf` is spelled by absolute path so PATH cannot redirect it,
# and the value it prints comes from the account rather than the environment.
# Anything but an absolute path is not an answer — off Darwin the variable is
# unknown and getconf fails, which is the case that approves no temporary root.
darwin_temp_dir() {
  local dir
  dir="$(/usr/bin/getconf DARWIN_USER_TEMP_DIR 2>/dev/null)" || return 1
  case "$dir" in
    /*) printf '%s\n' "$dir" ;;
    *) return 1 ;;
  esac
}

# $HOME is judged HERE, before any root derives from it. A mismatch is not
# fatal — the persistent root is dropped, the session root is untouched, and
# every refusal prints HOME_NOTE, so a missing root is visible rather than
# inferred.
PERSISTENT_ROOT=''
HOME_NOTE=''
HOME_REAL=''
LOGIN_REAL=''
LOGIN_HOME="$(login_home)" || LOGIN_HOME=''
case "$LOGIN_HOME" in
  # An unknown user leaves `~name` unexpanded, which is not a path.
  /*) LOGIN_REAL="$(resolve_dir "$LOGIN_HOME")" || LOGIN_REAL='' ;;
esac
if [ -n "$HOME_DIR" ]; then
  HOME_REAL="$(resolve_dir "$HOME_DIR")" || HOME_REAL=''
fi

if [ -z "$LOGIN_REAL" ]; then
  HOME_NOTE="   No persistent root is approved: this account's home directory could not be read from the password database."
elif [ -z "$HOME_REAL" ]; then
  HOME_NOTE="   No persistent root is approved: \$HOME is empty, or names no directory that exists."
elif [ "$HOME_REAL" != "$LOGIN_REAL" ]; then
  HOME_NOTE="   No persistent root is approved: \$HOME (\"$HOME_DIR\") is not this account's home directory (\"$LOGIN_REAL\"), and a root the caller chooses is not a root."
else
  PERSISTENT_ROOT="$LOGIN_REAL/Developer/scratchpad"
fi

# The temporary root is judged the same way and in the same place: derived from
# a source the caller cannot redirect, and dropped with a printed reason when
# there is none. $TMPDIR is read HERE and only here, for the note — it never
# reaches a root.
TEMP_ROOT=''
TMP_NOTE=''
if TEMP_RAW="$(darwin_temp_dir)"; then
  TEMP_ROOT="$(resolve_dir "$TEMP_RAW")" || TEMP_ROOT=''
fi

if [ -z "$TEMP_ROOT" ]; then
  TMP_NOTE="   No temporary root is approved: this account has no per-user temporary directory that the environment cannot redirect. On Linux \`mktemp -d\` writes into /tmp, which every account on the machine shares."
elif [ -n "${TMPDIR:-}" ]; then
  TMPDIR_REAL="$(resolve_dir "${TMPDIR:-}")" || TMPDIR_REAL=''
  [ "$TMPDIR_REAL" = "$TEMP_ROOT" ] || TMP_NOTE="   \$TMPDIR (\"${TMPDIR:-}\") is not this account's temporary directory (\"$TEMP_ROOT\") and approves nothing of its own, because a root the caller chooses is not a root."
fi

# The approved roots, one per line, existing or not — the caller resolves them
# and skips what is absent, and a refusal prints the list so the reason is
# visible rather than inferred.
scratch_roots() {
  local session dir
  [ -z "$PERSISTENT_ROOT" ] || printf '%s\n' "$PERSISTENT_ROOT"

  session="${CLAUDE_CODE_SESSION_ID:-}"
  # A session id is hex and dashes. Anything else is not one, and must never
  # reach a glob as a path fragment. Dropping the id drops the session root and
  # nothing else — an early return here would silently take root 3 with it.
  case "$session" in
    "" | *[!A-Za-z0-9-]*) session='' ;;
  esac

  if [ -n "$session" ]; then
    for dir in "/private/tmp/claude-"*/*/"$session/scratchpad" \
               "/tmp/claude-"*/*/"$session/scratchpad"; do
      [ -d "$dir" ] && printf '%s\n' "$dir"
    done
  fi

  [ -z "$TEMP_ROOT" ] || printf '%s\n' "$TEMP_ROOT"
  return 0
}

# The approved roots as physical paths, one per line. Roots that name no
# directory drop out here, so both passes below read one identical list.
resolved_roots() {
  local root
  while IFS= read -r root; do
    resolve_dir "$root"
  done < <(scratch_roots)
}

# What a refusal prints: the roots that were actually checked, and — when the
# persistent one was dropped — the reason. An empty list with no explanation is
# the one refusal a caller cannot act on.
roots_report() {
  local roots
  roots="$(scratch_roots)"
  if [ -n "$roots" ]; then
    printf '%s\n' "$roots" | sed 's/^/     /'
  else
    printf '%s\n' "     (none)"
  fi
  [ -z "$HOME_NOTE" ] || printf '%s\n' "$HOME_NOTE"
  [ -z "$TMP_NOTE" ] || printf '%s\n' "$TMP_NOTE"
}

# `--check` is read here and nowhere else, so every line below it judges the
# path exactly as an ordinary run does. It is deliberately absent from the usage
# text: the spelling a person or an agent types is the one SANCTIONED names, and
# this flag is a hook's private call into the same verdict.
CHECK=0
case "${1:-}" in
  -h | --help) usage ;;
  --check) CHECK=1; shift ;;
esac

[ "$#" -eq 1 ] || usage "❌ scratch-rm.sh takes exactly one path, and was given $#."

TARGET="$1"

case "$TARGET" in
  -*) usage "❌ scratch-rm.sh takes no options — \"$TARGET\" looks like one." ;;
  "") usage "❌ scratch-rm.sh was given an empty path." ;;
  /*) ;;
  *) refuse "❌ scratch-rm.sh: \"$TARGET\" is a relative path, and this command resolves nothing against a working directory it cannot see. Pass the absolute path." ;;
esac

# Trailing slashes are stripped so `<root>/` is judged as `<root>` — the root
# refusal below has to catch that spelling too.
while [ "$TARGET" != "/" ] && [ "${TARGET%/}" != "$TARGET" ]; do
  TARGET="${TARGET%/}"
done
[ "$TARGET" != "/" ] || refuse "❌ scratch-rm.sh: \"/\" is not a scratchpad."

BASE="${TARGET##*/}"
PARENT="${TARGET%/*}"
[ -n "$PARENT" ] || PARENT="/"

case "$BASE" in
  . | ..) refuse "❌ scratch-rm.sh: \"$TARGET\" ends in \"$BASE\", which names a directory by position — itself, or the one above it — rather than naming an entry to delete." ;;
esac

PARENT_REAL="$(resolve_dir "$PARENT")" \
  || refuse "❌ scratch-rm.sh: \"$PARENT\" is not an existing directory, so \"$TARGET\" cannot be checked against the approved roots."

if [ "$PARENT_REAL" = "/" ]; then
  RESOLVED="/$BASE"
else
  RESOLVED="$PARENT_REAL/$BASE"
fi

# TWO QUESTIONS, TWO PASSES, AND THE ORDER BETWEEN THEM IS THE POINT.
# "Is the target a root?" is answered against EVERY root before "is the target
# beneath a root?" is asked of any. Answering both per root in turn instead —
# one loop, each root deciding both — makes the verdict depend on the order the
# roots happen to arrive in. Let one approved root sit inside another, and a
# target that IS the inner root matches the outer root's containment test on an
# earlier pass of the loop, before its own equality test is ever reached: the
# command accepts the delete and destroys a scratchpad root, which is the one
# outcome it exists to prevent.
#
# No root in today's list contains another, so a single interleaved loop gets
# the same answer and nothing here is reachable through them. Three disjoint
# subtrees: the persistent root under this account's home, the session root
# under /tmp (/private/tmp once resolved on Darwin), and the temporary root
# under this account's /private/var/folders entry — and the temporary root only
# exists on Darwin, where the other two are exactly where they are here. That
# was checked when the third root was added,
# and checking it again is exactly what nobody should have to do. The ordering
# is a property of these two passes, not of the current root list.
ROOTS_REAL="$(resolved_roots)"

while IFS= read -r ROOT_REAL; do
  # No roots at all is an empty line, not zero lines. Skipping it matters more
  # in the containment pass below, where an empty root would build the pattern
  # `/*` and match every absolute path on the system.
  [ -n "$ROOT_REAL" ] || continue
  [ "$RESOLVED" != "$ROOT_REAL" ] || refuse \
    "❌ scratch-rm.sh: \"$RESOLVED\" is a scratchpad root itself, and this command deletes only entries beneath one." \
    "   Every approved root holds live state — a scratchpad shared across sessions, or the working files of everything this account is running — so deleting one destroys work that is not yours to delete."
done <<< "$ROOTS_REAL"

INSIDE=0
while IFS= read -r ROOT_REAL; do
  [ -n "$ROOT_REAL" ] || continue
  case "$RESOLVED" in
    "$ROOT_REAL"/*) INSIDE=1; break ;;
  esac
done <<< "$ROOTS_REAL"

if [ "$INSIDE" -ne 1 ]; then
  refuse "❌ scratch-rm.sh: \"$TARGET\" resolves to \"$RESOLVED\", which is not beneath an approved scratchpad root." \
         "   Approved roots right now:" \
         "$(roots_report)"
fi

# The verdict is settled and nothing has been touched. A checking caller stops
# on this line, BEFORE the existence test below: a path that does not exist yet
# is still a path this command would accept, and the guard's question is whether
# the delete is sanctioned rather than whether there is anything there today.
[ "$CHECK" -eq 0 ] || exit 0

if [ ! -e "$RESOLVED" ] && [ ! -L "$RESOLVED" ]; then
  printf '%s\n' "✅ Nothing to delete — $RESOLVED does not exist."
  exit 0
fi

rm -rf -- "$RESOLVED" \
  || refuse "❌ scratch-rm.sh: rm failed on \"$RESOLVED\"."

printf '%s\n' "✅ Deleted $RESOLVED"
