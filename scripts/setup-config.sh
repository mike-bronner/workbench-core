#!/usr/bin/env bash
#
# setup-config.sh — the steps of /workbench-core:setup that need no judgment:
# each one is a fixed merge into config.json or ~/.claude/settings.json. The
# skill collects the answers and runs these. It keeps the steps that ask the
# user, and the ones that read what they answer.
#
#   migrate              Step 0: move the pre-rename config directory
#   write-config ...     Step 2: merge the collected fields into config.json
#   provision-token ...  Step 2b: mint the memory server's bearer token, and
#                        put it (and a non-default port) in settings.json .env
#   leftover-asks        Step 2c.3: report the five ask rules an older setup
#                        installed, which the rails merge cannot remove
#   cap-mcp-output       Step 2g: set MAX_MCP_OUTPUT_TOKENS when it is unset
#   unsplice-claude-md   Step 2h: take the block an older warmup spliced into
#                        ~/.claude/CLAUDE.md out of it, and nothing else
#
# Every merge is a read-modify-write that keeps the keys it does not set, and a
# second run with the same answers writes the same bytes. A value that is not
# what the field takes is refused before anything is written.
#
# Test seams, as in the hooks: WORKBENCH_CONFIG_FILE (config.json),
# WORKBENCH_SETTINGS_FILE (settings.json) and WORKBENCH_CLAUDE_MD (CLAUDE.md). hooks/test-setup-config.sh drives
# every subcommand through them.
#
# Exit codes: 0 done, 1 refused or failed, 2 usage.

set -euo pipefail

DATA_DIR="$HOME/.claude/plugins/data/workbench-core-claude-workbench"
LEGACY_DIR="$HOME/.claude/plugins/data/workbench-claude-workbench"
CONFIG_FILE="${WORKBENCH_CONFIG_FILE:-$DATA_DIR/config.json}"
SETTINGS="${WORKBENCH_SETTINGS_FILE:-$HOME/.claude/settings.json}"
CLAUDE_MD="${WORKBENCH_CLAUDE_MD:-$HOME/.claude/CLAUDE.md}"
DEFAULT_PORT=8765

usage() {
  echo "usage: setup-config.sh migrate | write-config <field flags> | provision-token --memory-cache <dir> --memory-port <port> | leftover-asks | cap-mcp-output | unsplice-claude-md" >&2
  exit 2
}

fail() {
  echo "setup-config.sh: $*" >&2
  exit 1
}

require_jq() {
  command -v jq >/dev/null 2>&1 || fail "jq is not installed"
}

# A TCP port, 1 to 65535, written as JSON writes a number: no leading zero.
check_port() {
  [[ "$1" =~ ^[1-9][0-9]{0,4}$ ]] && [ "$1" -le 65535 ] || fail "not a port: '$1'"
}

# A JSON object file at $1, created as {} when absent. Anything else is refused,
# so a malformed file is never clobbered.
ensure_object() {
  mkdir -p "$(dirname "$1")"
  [ -f "$1" ] || echo '{}' > "$1"
  jq -e 'type == "object"' "$1" >/dev/null 2>&1 || fail "$1 is not a JSON object; left it alone"
}

# Writes jq's output over $1 through a temporary file beside it.
merge() {
  local file="$1" tmp
  shift
  tmp="$(mktemp "$file.XXXXXX")"
  if jq "$@" "$file" > "$tmp"; then
    mv "$tmp" "$file"
  else
    rm -f "$tmp"
    fail "could not merge into $file"
  fi
}

# Step 0. Both directories present: the new one wins, and the old one is
# archived so it is never read again.
cmd_migrate() {
  if [ -d "$LEGACY_DIR" ] && [ ! -d "$DATA_DIR" ]; then
    mv "$LEGACY_DIR" "$DATA_DIR"
    echo "migrated $LEGACY_DIR to $DATA_DIR"
  elif [ -d "$LEGACY_DIR" ] && [ -d "$DATA_DIR" ]; then
    local archive
    archive="${LEGACY_DIR}.legacy-$(date +%Y%m%d)"
    mv "$LEGACY_DIR" "$archive"
    echo "archived $LEGACY_DIR to $archive"
  fi
}

# Step 2. memory_port is written only when it is not the default, and
# identity_files, which configured the retired soul and profile files, is
# deleted. persona and output_style (Step 2f) and any other key are kept.
cmd_write_config() {
  local agent_name="" memory_path="" memory_cache="" mcp_name="" summary_model="" auto_summarize="" memory_port=""
  while [ $# -gt 0 ]; do
    [ $# -ge 2 ] || usage
    case "$1" in
      --agent-name) agent_name="$2" ;;
      --memory-path) memory_path="$2" ;;
      --memory-cache) memory_cache="$2" ;;
      --mcp-name) mcp_name="$2" ;;
      --summary-model) summary_model="$2" ;;
      --auto-summarize) auto_summarize="$2" ;;
      --memory-port) memory_port="$2" ;;
      *) usage ;;
    esac
    shift 2
  done
  local field
  for field in agent_name memory_path memory_cache mcp_name summary_model; do
    [ -n "${!field}" ] || fail "--${field//_/-} is required"
  done
  case "$auto_summarize" in true|false) ;; *) fail "--auto-summarize takes true or false, not '$auto_summarize'" ;; esac
  check_port "$memory_port"
  ensure_object "$CONFIG_FILE"
  merge "$CONFIG_FILE" \
    --arg agent_name "$agent_name" \
    --arg memory_path "$memory_path" \
    --arg memory_cache "$memory_cache" \
    --arg mcp_name "$mcp_name" \
    --arg summary_model "$summary_model" \
    --argjson auto_summarize "$auto_summarize" \
    --argjson memory_port "$memory_port" \
    --argjson default_port "$DEFAULT_PORT" \
    '
    .agent_name = $agent_name
    | .memory_path = $memory_path
    | .memory_cache = $memory_cache
    | .memory_mcp_server_name = $mcp_name
    | .summary_model = $summary_model
    | .auto_summarize = $auto_summarize
    | del(.identity_files)
    | if $memory_port == $default_port then del(.memory_port) else .memory_port = $memory_port end
    '
  echo "config written to $CONFIG_FILE"
}

# Step 2b. The token is minted once and reused, so a re-run never rotates a
# token the running server uses. settings.json holds a secret afterwards, so
# it is locked to its owner.
cmd_provision_token() {
  local cache="" port=""
  while [ $# -gt 0 ]; do
    [ $# -ge 2 ] || usage
    case "$1" in
      --memory-cache) cache="$2" ;;
      --memory-port) port="$2" ;;
      *) usage ;;
    esac
    shift 2
  done
  [ -n "$cache" ] || fail "--memory-cache is required"
  check_port "$port"
  local token_file="$cache/server.token"
  mkdir -p "$cache"
  chmod 700 "$cache" 2>/dev/null || true
  if [ ! -s "$token_file" ]; then
    command -v openssl >/dev/null 2>&1 || fail "openssl is not installed"
    ( umask 077; openssl rand -hex 32 > "$token_file" )
  fi
  chmod 600 "$token_file"
  ensure_object "$SETTINGS"
  merge "$SETTINGS" --rawfile token "$token_file" --arg port "$port" --arg default_port "$DEFAULT_PORT" '
    .env = (.env // {})
    | .env.WORKBENCH_MEMORY_TOKEN = ($token | rtrimstr("\n"))
    | if $port == $default_port then (.env | del(.WORKBENCH_MEMORY_PORT)) as $e | .env = $e
      else .env.WORKBENCH_MEMORY_PORT = $port end
    '
  chmod 600 "$SETTINGS"
  echo "token provisioned in $SETTINGS"
}

# Step 2c.3. The rails merge only adds, so these five, from a setup before they
# were dropped, stay until the user deletes them by hand.
cmd_leftover_asks() {
  local scoped
  scoped=$(jq -r '[.permissions.ask[]? | select(
    . == "Bash(rm -rf:*)" or . == "Bash(git clean -fd:*)" or
    . == "Bash(git reset --hard:*)" or . == "Bash(git stash clear:*)" or
    . == "Bash(git stash drop:*)")] | length' "$SETTINGS" 2>/dev/null || echo 0)
  if [ "$scoped" = "0" ]; then
    echo "✅ No leftover scope-able entries in permissions.ask."
    echo "   The destructive-scope guard (hooks/mods/destructive-scope.ts) is the only layer gating those verbs. It permits what resolves inside the project or a scratch root, asks about a target outside them, and denies what it cannot resolve."
  else
    echo "⚠  $scoped leftover scope-able entr(ies) in permissions.ask, from a setup run before they were dropped."
    echo "   They prompt regardless of where the command acts, and a matching ask rule still prompts even when a PreToolUse hook returned \"allow\" — so the guard's permit cannot show through while they are there."
    echo "   This merge cannot remove them: it only ever adds. Delete them BY HAND from permissions.ask in:"
    echo "     $SETTINGS"
  fi
}

# Step 2g. A value already there is the user's own choice, so it is kept.
cmd_cap_mcp_output() {
  mkdir -p "$(dirname "$SETTINGS")"
  [ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
  if ! jq -e 'type == "object"' "$SETTINGS" >/dev/null 2>&1; then
    echo "settings.json is not a JSON object; left it alone. Set env.MAX_MCP_OUTPUT_TOKENS by hand."
    return 1
  fi
  merge "$SETTINGS" '.env = (.env // {}) | .env.MAX_MCP_OUTPUT_TOKENS = (.env.MAX_MCP_OUTPUT_TOKENS // "15000")'
  chmod 600 "$SETTINGS"
  echo "MAX_MCP_OUTPUT_TOKENS is $(jq -r '.env.MAX_MCP_OUTPUT_TOKENS' "$SETTINGS")"
}

# Step 2h. Up to 0.44, every session start rewrote ~/.claude/CLAUDE.md with two
# marked regions: the gates and scratch roots, and each sibling plugin's
# session-warmup.md. Those now come from the hooks module as system-prompt
# sections, and the warmup no longer writes the file. This takes each region
# out, its two marker lines included, with the one blank line the warmup put
# after it. Every other line is the user's and stays byte for byte, its CRLF
# ending and the file's last line ending included.
#
# A marker is a whole line, read with any trailing carriage return dropped. The
# file is left alone, and the user told to take the block out by hand, when a
# pair is not one start line followed by one end line: a second start line (a
# marker of the user's own, quoted in a code fence), an end line with no start
# before it, or a start with no end. In those cases where a region ends is a
# guess, and a wrong guess deletes the user's lines.
#
# A regular file is replaced whole, through a temporary file beside it, with its
# mode kept. A symbolic link is written through, so the file it names is kept,
# and a link is never replaced by a file. A regular file that held nothing but
# the regions is removed. A second run finds no region and changes nothing.
UNSPLICE_TMP=""
cmd_unsplice_claude_md() {
  local file="$CLAUDE_MD" start end found=0 status nl=1 mode
  if [ ! -f "$file" ]; then
    echo "no $file; nothing to take out"
    return 0
  fi
  for start in '<!-- workbench-identity:start -->' '<!-- workbench-warmup:start -->'; do
    end="${start%:start -->}:end -->"
    status=$(awk -v s="$start" -v e="$end" '
      { line = $0; sub(/\r$/, "", line) }
      line == s { if (seen) bad = 1; seen = 1; open = 1 }
      line == e { if (!open) bad = 1; open = 0 }
      END { print (bad || open) ? "bad" : (seen ? "found" : "none") }
    ' "$file")
    case "$status" in
      bad) fail "$file has '$start' more than once, or its markers are not one start then one end; left it alone. Take the block out by hand." ;;
      found) found=1 ;;
    esac
  done
  if [ "$found" -eq 0 ]; then
    echo "no workbench block in $file; nothing to take out"
    return 0
  fi
  [ -n "$(tail -c 1 "$file")" ] && nl=0
  if [ -L "$file" ]; then
    UNSPLICE_TMP="$(mktemp "${TMPDIR:-/tmp}/claude-md.XXXXXX")"
  else
    UNSPLICE_TMP="$(mktemp "$(dirname "$file")/.claude-md.XXXXXX")"
  fi
  trap 'rm -f "$UNSPLICE_TMP"' EXIT
  awk -v nl="$nl" '
    { line = $0; sub(/\r$/, "", line) }
    line == "<!-- workbench-identity:start -->" || line == "<!-- workbench-warmup:start -->" { skip = 1; next }
    skip && (line == "<!-- workbench-identity:end -->" || line == "<!-- workbench-warmup:end -->") { skip = 0; ate = 1; next }
    skip { next }
    ate && line == "" { ate = 0; next }
    { ate = 0; if (have) printf "%s\n", prev; prev = $0; have = 1 }
    END { if (have) printf "%s%s", prev, (nl ? "\n" : "") }
  ' "$file" > "$UNSPLICE_TMP"
  if [ -L "$file" ]; then
    cat "$UNSPLICE_TMP" > "$file"
    echo "took the workbench block out of $file; the rest is unchanged"
  elif grep -q '[^[:space:]]' "$UNSPLICE_TMP"; then
    # GNU stat first: on Linux, `stat -f` reads the file system and succeeds.
    mode="$(stat -c '%a' "$file" 2>/dev/null || stat -f '%Lp' "$file")"
    chmod "$mode" "$UNSPLICE_TMP"
    mv -f "$UNSPLICE_TMP" "$file"
    echo "took the workbench block out of $file; the rest is unchanged"
  else
    rm -f "$file"
    echo "removed $file, which held only the workbench block"
  fi
}

[ $# -ge 1 ] || usage
command="$1"
shift
require_jq
case "$command" in
  migrate) [ $# -eq 0 ] || usage; cmd_migrate ;;
  write-config) cmd_write_config "$@" ;;
  provision-token) cmd_provision_token "$@" ;;
  leftover-asks) [ $# -eq 0 ] || usage; cmd_leftover_asks ;;
  cap-mcp-output) [ $# -eq 0 ] || usage; cmd_cap_mcp_output ;;
  unsplice-claude-md) [ $# -eq 0 ] || usage; cmd_unsplice_claude_md ;;
  *) usage ;;
esac
