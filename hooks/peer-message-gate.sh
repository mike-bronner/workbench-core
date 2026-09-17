#!/usr/bin/env bash
#
# peer-message-gate: PreToolUse gate on SendMessage that stops a SUB-AGENT from
# messaging anything except its own orchestrator or an agent it spawned.
#
# Claude Code sessions can message each other, and the capability shipped
# ungoverned: `ListAgents` from this repo listed five live peer sessions and
# `SendMessage` reached any of them, with no hook, no skill and no rule anywhere
# in this plugin. The behaviour is wanted — a hand-run cross-session peer review
# between two sessions caught a real shared-script bug — so this gate bounds it
# rather than removing it. The protocol itself is prose, in
# skills/cross-session-messaging/SKILL.md.
#
# THE ONE RULE THIS FILE ENFORCES
#
# A top-level session may reach out to a peer on its own initiative. A sub-agent
# may not: it sends UP to its orchestrator and DOWN to its own children, and
# nowhere else. A sub-agent is unattended by definition, and a model-initiated
# peer send from one is a message nobody chose to send, arriving in a
# conversation nobody warned.
#
# It also does not work. Per the tool's own contract a sub-agent's peer send
# "goes out under your parent session's address, and any reply is delivered to
# the parent session's conversation, not to you", so this closes a channel that
# was already one-way and misattributed.
#
# FOUR BRANCHES, AND THE DEFAULT IS THE DENY
#
#   main caller, any destination        allow, silently
#   sub-agent → the literal "main"      allow, silently
#   sub-agent → an agent-id-shaped id   allow, WITH AN ADVISORY
#   sub-agent → anything else           DENY
#
# The advisory branch exists because the down direction cannot be enforced. It
# was measured three ways against a real transcript and each one failed: spawn
# records carry no spawner identity, `isSidechain` is false on all 722 entries
# so a parentUuid walk cannot even establish that a spawn came from a sub-agent,
# and a sweep for agent-id-shaped values found none that names a spawner. Worse,
# sub-agents SHARE the parent's transcript, so any "is this my child?" check
# would read children spawned by everyone and wave a sibling through. The
# harness enforces nothing here either: a sub-agent sending to a sibling it did
# not spawn was measured succeeding, and it resumed that sibling. So the id case
# is allowed with a note that names the question only the model can answer.
# agent-dispatch-gate.sh already pairs an advisory with a deny; this is that
# file's pattern, not a new one.
#
# WHAT IS MEASURED, AND WHAT IS INFERRED
#
# Measured live on Claude Code 2.1.274 with a logging-only probe, the same
# method agent-dispatch-gate.sh cites in its own header:
#
#   - PreToolUse fires for SendMessage at all, so a gate is possible.
#   - `to: "main"` passes through as the literal string `main`, unrewritten, and
#     a sub-agent sending to it succeeds.
#   - A sub-agent sending to a sibling's id succeeds, so the boundary is not the
#     harness's.
#   - An agent id looks like `a5a2f4470341f9233`: lowercase hex, 17 characters.
#
# INFERRED, never measured: that a peer session's destination does NOT look like
# an agent id. A peer appears in `ListAgents` as a name — `herdr-b5`, or
# `herdr-b5 [72839a]` — and neither form is lowercase hex. No peer send was ever
# captured, because messaging live sessions was forbidden: a probe message
# interrupts somebody's real conversation. The fourth branch rests on that
# inference, which is exactly why it is written as the DEFAULT: every
# destination form nobody has measured falls into it and is refused. If the
# inference is wrong in the safe direction a legitimate child send is denied and
# the sub-agent reports up instead, which costs one message. If the deny were
# the narrow branch instead, being wrong would silently admit the thing this
# gate exists to stop.
#
# WHY `agent_id` ALONE DECIDES THE CALLER, unlike the sibling gates
#
#   main agent (interactive or `claude -p`)  agent_id absent, agent_type absent
#   sub-agent (Agent tool)                   agent_id present, agent_type present
#   top-level `claude -p --agent <name>`     agent_id ABSENT,  agent_type present
#
# Same three rows delegation-gate.sh and agent-dispatch-gate.sh key on. Those
# two allow on `agent_type` as well, to let a scheduled `--agent` run through.
# Here that second branch would be wrong: `agent_type` is present for a real
# sub-agent too, so allowing on it would allow the only case this gate gates.
# Row three needs nothing extra — a top-level `--agent` run carries no
# `agent_id`, so it is already on the allow side of the one test, which is what
# makes a pipeline agent top-level and free to send.
#
# BOTH DESTINATION FIELDS ARE READ, AND THAT IS NOT BELT-AND-BRACES
#
# `tool_input` carries DOUBLED fields. One measured send produced `to` and
# `recipient` holding the same id, plus `message` and `content` holding
# DIFFERENT strings: `message` was the 74-character text actually sent, and
# `content` was an unrelated 50-character string that hash-testing could not
# derive from the message, the summary, or any truncation of either. The pairs
# are therefore not guaranteed to agree, and a gate reading only `to` would be
# checking a field the harness might not be the one to honour. So every
# destination value present is classified, and the strictest verdict wins: one
# `other` among them denies, whatever the other field says.
#
# The body is never read at all. Not because of the doubling, but because
# judging whether a message's stated reason is a good reason is semantic, and
# this plugin measured what that costs: three prompt-classifying heuristics for
# agent-dispatch-gate.sh scored 83% precision at 26% recall against 34% at 84%,
# and the wrong answers were not tunable away. The skill requires a declared
# reason; this gate does not check for one, and does not pretend to.
#
# THE ID TEST IS SPELLED OUT IN CODEPOINTS, NOT WRITTEN AS A REGEX
#
# jq's `test` uses Oniguruma, where `$` matches at the end of the string OR
# before a trailing newline, exactly as in Perl. Measured on jq 1.7.1:
#
#   "a5a2f4470341f9233\n" | test("^[0-9a-f]{16,}$")    true   <- a hole
#   "a5a2f4470341f9233\n" | test("^[0-9a-f]{16,}\\z")  false
#
# A destination with a trailing newline would have passed as an agent id. `\z`
# closes it, and `explode` closes it without depending on a regex engine's
# anchor semantics at all — the same reasoning the sibling guards give for
# spelling their whitespace out in ASCII instead of trusting [[:space:]], which
# is a property of the C library rather than of the pattern. 48-57 is 0-9 and
# 97-102 is a-f, so uppercase hex is NOT an id: it is a form nobody measured,
# and it lands in the deny like every other unmeasured form.
#
# The 16-character floor is below the 17 that was measured and above anything a
# session name plausibly is. Pinning it to exactly 17 would deny every
# legitimate child send the day the harness changes its id width.
#
# `ListAgents` IS DELIBERATELY NOT GATED, though PreToolUse fires for it and it
# is in the same messaging surface. Listing peers is read-only and harms nobody,
# the send is where the harm would land and the send is gated, and its
# `tool_input` arrives EMPTY so any rule about it could only key on the caller.
# A deny there would buy a sub-agent an earlier refusal for the cost of a fork
# on every call, so the matcher in hooks.json names SendMessage only.
#
# NO ESCAPE HATCH, and none is needed. This gate never fires on a human: a
# person types into a top-level session, which is the first allow branch. There
# is nothing here for /workbench-core:orchestrator to stand down, and wiring
# that toggle in would let one unrelated request — "let me edit inline" — also
# open peer messaging from every sub-agent in the session.
#
# Fail-open by design, on the reasoning the sibling guards give rather than the
# one credential-guard.sh gives: the threat is a confidently wrong agent, not a
# crafted payload. A malformed payload, a missing jq, a `tool_input` that is not
# an object, or a send carrying no destination at all each exit 0. The cost is
# real and documented in the README: when this script breaks, enforcement stops
# silently.
#
# THE REFUSAL IS SPLIT ACROSS THE TWO CHANNELS A HOOK HAS. Measured on Claude
# Code 2.1.274 with a probe hook (insights/2026-09-17-hook-message-channels-
# measured.md in the vault): `permissionDecisionReason` becomes the tool_result
# and is the text a PERSON reads, and `additionalContext` survives a deny and
# arrives in its own block, which only the model reads. So the reason is ONE
# line naming the action that was gated, and the reasoning an agent acts on —
# why the channel does not work, and the protocol to read — lives in the
# context instead.
#
# NO MARKDOWN EMPHASIS, ANYWHERE. Whether a client renders the reason as
# Markdown is unsettled, and the model receives the raw source either way. So
# emphasis is carried by POSITION — the action leads the line — and by
# backticks, which read as a quoted command whether or not they are rendered.
#
# Exit 0 with no output = allow (normal permission flow applies).
# Exit 0 with permissionDecision "deny" = the harness refuses the call. The deny
#   carries additionalContext too, and that combination is measured: the context
#   is not dropped when the call is refused.
# Exit 0 with additionalContext and NO permissionDecision = allow, with a note.
#   Omitting permissionDecision is deliberate: the harness only touches
#   permission behaviour when that key is present (verified against the 2.1.263
#   binary), so the advisory cannot silently grant a permission the call would
#   otherwise have had to ask for.

set -u

PAYLOAD=""
if [ ! -t 0 ]; then
  PAYLOAD=$(cat)
fi
[ -n "$PAYLOAD" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

# One jq pass produces everything the branches need, and the destination is
# classified INSIDE jq rather than in bash. That is not a style choice: a
# destination string is the only field here an agent controls, and `read` stops
# at the first newline, so classifying in the shell would let a value like
# "main<newline>herdr-b5" truncate the record and drop the second destination
# field entirely. jq sees the whole string, and the verdict it emits is one of
# four literals this file wrote itself.
#
# Joined on US (0x1f), never on a tab, for the reason measured in
# agent-dispatch-gate.sh: bash collapses runs of IFS whitespace, so a
# tab-separated record whose leading fields are empty — exactly the main-agent
# case — silently shifts every value one slot left. US is not IFS whitespace.
# Neither of the other two fields can contain it: `agent_id` is reduced to a
# presence flag here, and `tool_name` is the harness's own.
#
# `.tool_input // {}` covers an absent or null tool_input. A tool_input that is
# a string or an array makes `.to` a jq error, which exits non-zero and fails
# open below — a payload shape this gate does not understand must not deny.
FIELDS=$(printf '%s' "$PAYLOAD" | jq -r '
  def dest_class:
    if type != "string" then "other"
    elif . == "main" then "main"
    elif (length >= 16)
      and (explode | all(. >= 48 and . <= 57 or . >= 97 and . <= 102)) then "agent"
    else "other"
    end;
  [ (if (.agent_id // "" | tostring) == "" then "" else "1" end),
    (.tool_name // "" | tostring),
    ( [ (.tool_input // {} | .to, .recipient) | select(. != null and . != "") ]
      | if length == 0 then "none"
        elif any(dest_class == "other") then "deny"
        elif any(dest_class == "agent") then "advise"
        else "main"
        end )
  ] | join("\u001f")' 2>/dev/null) || exit 0
IFS=$'\x1f' read -r SUB_AGENT TOOL_NAME DEST <<<"$FIELDS"

# (a) The caller is top-level: a human's session, or a `claude -p --agent` run,
#     which counts as top-level and may reach out. Only a sub-agent is gated.
[ -n "$SUB_AGENT" ] || exit 0

# (b) Defensive: the hooks.json matcher should already scope this to SendMessage.
[ "$TOOL_NAME" = "SendMessage" ] || exit 0

SKILL_LINE="The protocol for a session-to-session message is in /workbench-core:cross-session-messaging."

case "$DEST" in
  # Up to the orchestrator. The documented channel, and the one a sub-agent is
  # meant to use for anything it wants said outside itself.
  main) exit 0 ;;

  # No destination survived at all. Fail open rather than deny on a payload
  # shape this gate does not understand.
  none) exit 0 ;;

  advise)
    NOTE="📡 Peer message note (advisory, nothing was blocked): this send names an agent id. A sub-agent may message an agent it spawned itself. It may not message a sibling or a peer session, and no hook can tell those apart — the harness records no spawner identity anywhere, so this is the one question only you can answer. If you did not spawn this agent, cancel the send and report it up to your orchestrator instead. ${SKILL_LINE}"
    jq -nc --arg c "$NOTE" '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: $c
      }
    }'
    exit 0
    ;;

  deny)
    REASON='🛑 Blocked: a sub-agent messaging a peer session. Send to "main" instead.'
    CONTEXT="Peer message gate (workbench-core). A sub-agent messages its own orchestrator and its own children, and nothing else. This send names a destination that is neither the literal \"main\" nor an agent id. A peer session reached from inside a sub-agent also goes out under your parent session's address, and any reply is delivered to that conversation rather than to you, so the channel does not work even where it is allowed. Send to \"main\" and let the orchestrator decide whether to reach out. ${SKILL_LINE}"
    jq -nc --arg reason "$REASON" --arg context "$CONTEXT" '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: $reason,
        additionalContext: $context
      }
    }'
    exit 0
    ;;

  # Unreachable: jq emits one of the four literals above. Fail open anyway, so a
  # future edit to the classifier cannot turn an unrecognised token into a deny.
  *) exit 0 ;;
esac
