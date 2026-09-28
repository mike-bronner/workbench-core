#!/usr/bin/env bash
#
# scheduled-origin: tell a scheduled-task session from a human one, from the
# transcript alone.
#
# The harness wraps a scheduled task's prompt in a `<scheduled-task name="..."
# file="...">` element. That wrapper is the only signal there is: no env var and
# no payload field marks a scheduled fire (see the guard in memory-recall.sh).
# A UserPromptSubmit hook sees the prompt directly. A PostToolUse or Stop hook
# does not, so it reads the transcript's first user record instead.
#
# Sourced by memory-scan-recall.sh and memory-capture-stop.sh. Both used to
# carry this logic separately, or depend on a marker another hook left behind.

# ──────────── scheduled_origin <transcript-path> ────────────
# Echo `scheduled` or `human` for the session that owns the transcript. Echo
# nothing when the transcript is missing or holds no user text yet, so the
# caller can tell "not flushed" from "human" and avoid caching a wrong verdict.
#
# `grep -m1` stops at the first user record, so this reads a prefix of the file.
# Content is a bare string on a typed prompt, and an array of blocks when the
# harness attaches anything.
scheduled_origin() {
  local transcript="$1" first
  [ -n "$transcript" ] && [ -f "$transcript" ] || return 0
  first=$(grep -m1 '"type":"user"' "$transcript" 2>/dev/null | jq -r '
    .message.content
    | if type == "array" then (map(select(.type == "text") | .text // "") | join(" "))
      elif type == "string" then .
      else "" end' 2>/dev/null)
  [ -n "$first" ] || return 0
  case "$(printf '%s' "$first" | tr '\n' ' ' | sed 's/^ *//')" in
    '<scheduled-task '*) printf 'scheduled' ;;
    *) printf 'human' ;;
  esac
}
