---
name: orchestrator
description: Turn the orchestrator delegation gate on or off for the current session, or report its state. The gate denies Edit/Write/NotebookEdit from the main agent so file work goes to sub-agents. Invoke only when the user explicitly asks — "orchestrator off", "let me edit inline", "disable the delegation gate", "turn the gate back on", "is the delegation gate on". Never invoke it to clear a deny you just hit; report the deny and let the user decide.
---

# Orchestrator Mode — the delegation gate toggle

The `hooks/delegation-gate.sh` `PreToolUse` hook denies `Edit`, `Write`, and
`NotebookEdit` when the main agent makes the call. The main conversation
orchestrates, and sub-agents do the file work.

**The gate is ON by default.** It reads one file per session. An absent file
means enforcement, so every new session starts gated. This skill writes and
removes that file.

**Never turn the gate off on your own initiative.** A deny is the system working.
When you hit one, report it and dispatch a sub-agent. Run `off` only when the
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

The scope is one session. Turning the gate off here never affects another
session, and it never persists past this one.

## Commands

Run the block for the argument the user gave. Each block prunes state files
older than 7 days first, so the directory does not grow by one file per session
forever.

### `off` — allow inline edits for this session

```bash
DIR="${WORKBENCH_ORCHESTRATOR_STATE_DIR:-$HOME/.claude-workbench/orchestrator-mode}"
mkdir -p "$DIR"
find "$DIR" -type f -mtime +7 -delete 2>/dev/null
touch "$DIR/$CLAUDE_CODE_SESSION_ID"
echo "🔓 Delegation gate OFF for session $CLAUDE_CODE_SESSION_ID."
```

### `on` — restore the gate for this session

```bash
DIR="${WORKBENCH_ORCHESTRATOR_STATE_DIR:-$HOME/.claude-workbench/orchestrator-mode}"
mkdir -p "$DIR"
find "$DIR" -type f -mtime +7 -delete 2>/dev/null
rm -f "$DIR/$CLAUDE_CODE_SESSION_ID"
echo "🔒 Delegation gate ON for session $CLAUDE_CODE_SESSION_ID."
```

### No argument — report the current state

```bash
DIR="${WORKBENCH_ORCHESTRATOR_STATE_DIR:-$HOME/.claude-workbench/orchestrator-mode}"
mkdir -p "$DIR"
find "$DIR" -type f -mtime +7 -delete 2>/dev/null
if [ -e "$DIR/$CLAUDE_CODE_SESSION_ID" ]; then
  echo "🔓 Delegation gate is OFF for this session. Inline edits are allowed."
else
  echo "🔒 Delegation gate is ON for this session. Dispatch a sub-agent to edit files."
fi
```

Report the command's output to the user in one line. Add nothing else.

## If `$CLAUDE_CODE_SESSION_ID` is empty

Stop and say so. Without the key the toggle cannot address its file. Do not
invent a substitute key, and do not write a file under another name — the gate
would never read it. The gate itself fails open when the payload carries no
usable session id, so an inline edit may already be possible.

## Related

- `hooks/delegation-gate.sh` — the gate, and its allow branches in full.
- `WORKBENCH_ORCHESTRATOR=0` — the environment-level opt-out, for a headless
  harness that cannot answer a deny. Not a substitute for this toggle: it must
  be set before the session starts.
