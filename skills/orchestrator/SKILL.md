---
name: orchestrator
description: Turn orchestrator mode on or off for the current session, or report its state. Off silences the delegation gate's reminder and stands down the agent dispatch gate. The delegation gate never denies. It lets a main-agent Write/NotebookEdit through with a once-per-session reminder to delegate whole-file work. Invoke only when the user explicitly asks — "orchestrator off", "stop the delegation reminder", "disable the delegation gate", "turn the gate back on", "is the delegation gate on". Never invoke it to clear a deny you just hit; report the deny and let the user decide.
---

# Orchestrator Mode — the delegation gate toggle

The `hooks/delegation-gate.sh` `PreToolUse` hook is advisory. When the main
agent calls `Write` or `NotebookEdit`, the write goes ahead, and the first one
in a session carries a reminder that whole-file work belongs in a sub-agent.
Plans under `~/.claude/plans/` and files in a scratch root draw no reminder.
`Edit` never does: a small change costs about 200 tokens inline and tens of
thousands delegated, so the main agent makes it itself.

The same state file also stands down `hooks/agent-dispatch-gate.sh`, which
still denies a main-agent `Agent` dispatch that lacks the six-slot brief.

**Orchestrator mode is ON by default.** Both hooks read one file per session.
An absent file means they are active, so every new session starts with them on.
This skill writes and removes that file.

**Never turn it off on your own initiative.** A dispatch-gate deny is the system
working. When you hit one, add the missing brief slots. Run `off` only when the
user asks for it in words.

## The state file

| Piece | Value |
|---|---|
| Directory | `$WORKBENCH_ORCHESTRATOR_STATE_DIR`, defaulting to `$HOME/.claude-workbench/orchestrator-mode` |
| File name | `$CLAUDE_CODE_SESSION_ID` |

`$CLAUDE_CODE_SESSION_ID` is exported into Bash tool calls, and it equals the
`.session_id` field the hook reads from its payload. Verified live on Claude
Code 2.1.260, in a main session, in a Task sub-agent, and under
`claude -p --agent`. The toggle and the gate therefore agree on the key without
passing anything between them.

The scope is one session. Turning it off here never affects another session,
and it never persists past this one.

## Commands

Run the block for the argument the user gave. Each block prunes state files
older than 7 days first, so the directory does not grow by one file per session
forever.

### `off` — silence the reminder and the dispatch gate for this session

```bash
DIR="${WORKBENCH_ORCHESTRATOR_STATE_DIR:-$HOME/.claude-workbench/orchestrator-mode}"
mkdir -p "$DIR"
find "$DIR" -type f -mtime +7 -delete 2>/dev/null
touch "$DIR/$CLAUDE_CODE_SESSION_ID"
echo "🔓 Orchestrator mode OFF for session $CLAUDE_CODE_SESSION_ID. No delegation reminder, and no dispatch gate."
```

### `on` — restore both for this session

```bash
DIR="${WORKBENCH_ORCHESTRATOR_STATE_DIR:-$HOME/.claude-workbench/orchestrator-mode}"
mkdir -p "$DIR"
find "$DIR" -type f -mtime +7 -delete 2>/dev/null
rm -f "$DIR/$CLAUDE_CODE_SESSION_ID"
echo "🔒 Orchestrator mode ON for session $CLAUDE_CODE_SESSION_ID."
```

### No argument — report the current state

```bash
DIR="${WORKBENCH_ORCHESTRATOR_STATE_DIR:-$HOME/.claude-workbench/orchestrator-mode}"
mkdir -p "$DIR"
find "$DIR" -type f -mtime +7 -delete 2>/dev/null
if [ -e "$DIR/$CLAUDE_CODE_SESSION_ID" ]; then
  echo "🔓 Orchestrator mode is OFF for this session. No delegation reminder, and no dispatch gate."
else
  echo "🔒 Orchestrator mode is ON for this session. The first whole-file write draws a reminder, and Agent dispatches need the brief."
fi
```

Report the command's output to the user in one line. Add nothing else.

## If `$CLAUDE_CODE_SESSION_ID` is empty

Stop and say so. Without the key the toggle cannot address its file. Do not
invent a substitute key, and do not write a file under another name — the
hooks would never read it. Both hooks stand down when the payload carries no
usable session id.

## Related

- `hooks/delegation-gate.sh` — the reminder, and its silent branches in full.
- `hooks/agent-dispatch-gate.sh` — the dispatch gate this toggle also stands down.
- `WORKBENCH_ORCHESTRATOR=0` — the environment-level opt-out, for a headless
  harness. Not a substitute for this toggle: it must be set before the session
  starts.
