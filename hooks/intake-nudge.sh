#!/usr/bin/env bash
#
# intake-nudge: PreToolUse hook on Edit that reminds the main agent, once per
# task, to run the intake routine (skills/intake/SKILL.md) when it starts editing
# with no intake block on screen.
#
# IT NEVER DENIES. The output carries additionalContext and no permission
# verdict of any kind, so the edit goes ahead exactly as it would have without
# this hook. That is the whole design, not a softening of it: the routine's own
# bar says an agent that has what it needs should work, and f18a2f9 removed the
# judgement-call denies because a deny on a judgement call breeds workarounds.
# Whether a task is trivial enough to skip intake is the skill's call. A hook
# cannot make it, so the hook only reminds.
#
# WHAT "A TASK" IS
#
# A task is the latest human prompt in the transcript. Claude Code stamps those
# records with "origin":{"kind":"human"}. That field is undocumented Claude Code
# behaviour. It was checked against 400 recent transcripts on 2026-09-29, and
# nothing else in a record tells a typed prompt from an injected one. If a CLI
# release renames or drops it, this hook finds no prompt and goes silent, with
# no error anywhere. Re-check it after an upgrade if the nudge stops appearing. Tool results, skill bodies, sub-agent
# hand-backs ("kind":"peer"), and background-task notifications
# ("kind":"task-notification") carry no such stamp, so none of them opens a new
# task. The prompt's uuid is kept in a per-session state file, and a prompt that
# was already judged is never judged again. That is what makes it the FIRST edit
# of a task and not every edit.
#
# WHAT "AN INTAKE BLOCK ON SCREEN" IS
#
# A Markdown heading that names "Intake", in assistant text, in one of two
# places:
#
#   after the prompt         the block was shown for this task
#   closing the turn before  the block was shown, the turn ended on a question
#                            such as "proceed?", and this prompt is the answer
#
# The closing text of a turn is the assistant text after that turn's last tool
# call, with one exception. A Stop hook can wake the agent after its closing
# question (the memory capture checkpoint does), and the agent then makes tool
# calls, such as a vault write, before the human answers. Tool calls that follow
# a Stop hook record in the same turn leave the closing text alone, so the
# question and the block before it still count. A Stop hook record is either of
# the two shapes the CLI writes for one: a meta user record whose text starts
# "Stop hook feedback:", or an attachment whose hookEvent is "Stop". Without the second place, the most common flow (show the block, ask, get
# "yes", start editing) would draw a nudge for an intake Mike just approved.
# Text earlier in the previous turn does not count: a long task whose block was
# shown at its start, followed by a fresh request, still gets its nudge.
#
# Assistant text is read from its text blocks only, never from tool input. An
# Edit whose new_string happens to contain "## Intake" is not an intake block.
#
# LANES THAT NEVER SEE IT
#
#   sub-agent (Agent tool)          agent_id present      a brief, not a prompt
#   claude -p --agent <name>        agent_type present    the Index pipeline
#   scheduled task                  the current prompt opens with the
#                                   <scheduled-task> wrapper
#
# Only the current prompt decides. A session that began as a scheduled tick can
# go on to take a typed task (a memory-lint tick, then Mike asks for something),
# and that task is nudged like any other. Reading the session's first record, as
# lib/scheduled-origin.sh does, would silence every later prompt in it.
#
# The main-vs-sub-agent signal is the one delegation-gate.sh documents and
# measured: agent_id and agent_type are both absent only for the main agent.
#
# FAILURE IS SILENCE. A missing jq, an unreadable transcript, a session id that
# cannot address a state file, or a state file that cannot be written all exit
# 0 with no output. For an advisory hook, silence is the closed direction: it
# changes nothing about the call. A state file that cannot be written is silent
# rather than nudging, because without it the nudge would repeat on every edit.

set -u

PAYLOAD=""
if [ ! -t 0 ]; then
  PAYLOAD=$(cat)
fi
[ -n "$PAYLOAD" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

# Joined on US (0x1f), for the reason delegation-gate.sh gives: tab is IFS
# whitespace, and runs of it collapse the empty leading fields of a main-agent
# payload.
FIELDS=$(printf '%s' "$PAYLOAD" | jq -r '
  [ (.agent_id // "" | tostring),
    (.agent_type // "" | tostring),
    (.tool_name // "" | tostring),
    (.session_id // "" | tostring),
    (.transcript_path // "" | tostring) ] | join("\u001f")' 2>/dev/null) || exit 0
IFS=$'\x1f' read -r AGENT_ID AGENT_TYPE TOOL_NAME SESSION_ID TRANSCRIPT <<<"$FIELDS"

[ -n "$AGENT_ID" ] && exit 0
[ -n "$AGENT_TYPE" ] && exit 0
[ "$TOOL_NAME" = "Edit" ] || exit 0
case "$SESSION_ID" in
  '' | *[!A-Za-z0-9._-]*) exit 0 ;;
esac
[ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] && [ -r "$TRANSCRIPT" ] || exit 0

# The last two human prompts, by line number. grep streams the file, so a long
# transcript costs one pass and no parse. Neither needle can match inside a JSON
# string, where its quotes would be escaped. A meta record can carry the human
# stamp (a local-command caveat does), and it is not a prompt.
PROMPT_LINES=$(grep -n -F '"origin":{"kind":"human"}' "$TRANSCRIPT" 2>/dev/null \
  | grep -v -F '"isMeta":true' | cut -d: -f1 | tail -n 2)
LAST=$(printf '%s\n' "$PROMPT_LINES" | tail -n 1)
# With one prompt only, PREV and LAST are the same line: the turn before is
# everything above the first prompt, which holds no assistant text, so the
# window starts at the prompt itself.
PREV=$(printf '%s\n' "$PROMPT_LINES" | head -n 1)
[ -n "$LAST" ] || exit 0

# The prompt's uuid names the task in the state file, and a prompt with none
# cannot be told from the last one, so it is left alone.
PROMPT=$(sed -n "${LAST}p" "$TRANSCRIPT" | jq -r '
  [ .uuid // "",
    (.message.content
      | if type == "string" then .
        elif type == "array" then (map(select(.type == "text") | .text // "") | join(" "))
        else "" end
      | .[0:200]) ] | join("\u001f")' 2>/dev/null)
IFS=$'\x1f' read -r PROMPT_UUID PROMPT_HEAD <<<"$PROMPT"
[ -n "$PROMPT_UUID" ] || exit 0
case "$(printf '%s' "$PROMPT_HEAD" | tr '\n' ' ' | sed 's/^ *//')" in
  '<scheduled-task '*) exit 0 ;;
esac

# One file per session, swept after 3 days like the sibling state dirs
# (memory-scan-recall.sh, lib/memory-recall-core.sh, memory-capture-stop.sh).
STATE_DIR="${HOME:-}/.claude-workbench/intake-nudge"
STATE_FILE="$STATE_DIR/$SESSION_ID"
find "$STATE_DIR" -type f -mtime +3 -delete 2>/dev/null
[ "$(cat "$STATE_FILE" 2>/dev/null)" = "$PROMPT_UUID" ] && exit 0
mkdir -p "$STATE_DIR" 2>/dev/null && printf '%s' "$PROMPT_UUID" > "$STATE_FILE" 2>/dev/null || exit 0

# Read from the previous prompt on. Lines that are not JSON, such as a record
# still being written, are skipped rather than failing the whole read.
FOUND=$(sed -n "${PREV},\$p" "$TRANSCRIPT" | jq -Rrn --arg p "$PROMPT_UUID" '
  def texts: [ .message.content | if type == "array" then .[] | select(.type == "text") | .text // "" else empty end ] | join("\n");
  def tooly: (.message.content | type == "array") and any(.message.content[]; .type == "tool_use" or .type == "tool_result");
  def stophook:
    (.type == "user" and (.isMeta // false) and (.message.content | type == "string")
      and (.message.content | startswith("Stop hook feedback:")))
    or (.type == "attachment" and .attachment.hookEvent? == "Stop");
  reduce (inputs | fromjson? | select(type == "object")) as $r
    ({after: false, stopped: false, closing: "", seen: ""};
     if $r.uuid == $p then .after = true
     elif .after then (if $r.type == "assistant" then .seen += "\n" + ($r | texts) else . end)
     elif ($r | stophook) then .stopped = true
     elif ($r.type != "assistant" and $r.type != "user") then .
     elif ($r | tooly) then (if .stopped then . else .closing = "" end)
     elif $r.type == "assistant" then .closing += "\n" + ($r | texts)
     else . end)
  | (.closing + "\n" + .seen)
  | test("(^|\n)[ \t]*#{1,6}[ \t]+[^\n]*\\bintake\\b"; "i")' 2>/dev/null)
[ "$FOUND" = "false" ] || exit 0

NUDGE="📋 Intake nudge (advisory, nothing was blocked): this is the first Edit for the current task, and no intake block is on screen for it. Before more work, run /workbench-core:intake: show the goal, the context, and the acceptance criteria you are working to, under a heading that names Intake. If the task is trivial, carry on without it."

jq -nc --arg c "$NUDGE" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    additionalContext: $c
  }
}'
