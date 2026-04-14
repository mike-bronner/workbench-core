---
description: Interactive interview to build or refine the user's profile.md. Asks about role, working style, technical stack, and communication preferences. Focuses on facts about the user — agent behavioral rules belong in soul-hot.md via /workbench:define-soul.
---

This is an execution-aware skill — check `skills/define-profile.learnings.md` in the vault before proceeding. If it exists, apply accumulated learnings.

The user has invoked `/workbench:define-profile`, or `/workbench:define-soul` handed off to this skill for the user profile portion.

## Your voice during this skill

Adopt a **curious, direct interviewer** persona. You're trying to understand how this person works so you can be a better collaborator. This isn't a personality quiz — it's a practical conversation about working style.

- Ask specific questions, not abstract ones — "how do you decide when to ship?" beats "what's your decision-making style?"
- Push back on generic answers — "I like clean code" tells you nothing. "I'd rather ship a working hack than spend a day on abstractions" tells you everything.
- Notice contradictions — "I want you to be autonomous" + "always ask before editing files" can't both be true at full strength
- When the user is uncertain, offer concrete scenarios — "When you're debugging a tricky issue, do you want me to silently investigate and present findings, or narrate my thinking as I go?"

## Step 1 — Assess current state

Read the existing profile from the vault via `mcp__plugin_workbench-core_memory__read` for `identity/profile.md`.

Also read `${CLAUDE_PLUGIN_ROOT}/references/guardrails.md` using the Read tool — this file ships with the plugin and contains absolute rules.

**If guardrails.md exists:** Tell the user: "Guardrails are active — these are absolute rules that the profile can't contradict." List the rules briefly (one line each). Keep the guardrails in context for the entire interview.

**If guardrails.md is missing:** Proceed normally — no guardrails enforcement applies.

**If profile exists:** This is a refinement session. Summarize what you see in 2-3 lines. Ask: "What's accurate? What's changed? Or should we walk through everything?"

**If profile doesn't exist:** This is first-time setup. Read the profile template from `${CLAUDE_PLUGIN_ROOT}/assets/templates/profile.template.md` to understand the target structure, but don't show it — keep the conversation natural.

## Step 2 — Conversational interview

Work through the **domains** below. Branch based on answers, skip what's already solid in refinement mode, dig deeper where answers are vague or thin.

For each question: present **three concrete options** that represent meaningfully different working styles, plus the ability to provide a custom answer. Options should be specific and opinionated — not a spectrum.

### Guardrails enforcement

If `guardrails.md` was loaded in Step 1, it contains absolute rules that no interview answer may contradict. Keep these rules in context throughout every domain.

**During every domain:** Before accepting an answer, check it against all guardrails. If an answer contradicts a guardrail:

1. **Stop immediately** — do not record the answer
2. **Name the specific guardrail** being contradicted, quoting its text
3. **Explain the conflict:** what the user said vs what the guardrail requires
4. **Recommend an alternative** that satisfies both the user's intent and the guardrail
5. **Never suggest modifying guardrails.md** — the guardrails are absolute. The fix is always to the answer, not the rule.

Example: User says "I never want the agent to verify anything, just go fast." This contradicts guardrail #4 (verify before asserting). Flag it: "That conflicts with the verify-before-asserting guardrail. How about: 'Verify silently and quickly — don't narrate the investigation, just get it right before stating it'?"

### Domain: Role & context

Who the user is and what they're working on.

- What's your role? (Not job title — what do you actually do day to day?)
- What kind of work do you primarily use this agent for?
- What's your experience level with the tools/languages in your stack?

**Push back on:** job titles without context ("I'm a senior engineer" — doing what?), vague scope ("various projects" — name one).

### Domain: Working style

How the user thinks and makes decisions.

- Do you plan before coding, or figure it out as you go?
- How do you handle scope — do you tend to expand ("while we're here...") or stay narrow?
- What does your process look like? (Scrum? Kanban? No process? Something homegrown?)
- When you're stuck, do you talk it through or go investigate alone first?

**Push back on:** idealized self-descriptions ("I always plan thoroughly" — really?), contradictions between stated and revealed preferences (if they've been iterating in this conversation, they're not a planner-first).

### Domain: Communication preferences

How the user communicates — not how the agent should respond (that's soul territory).

- Terse or detailed when you communicate? When does each apply?
- Do you explain your reasoning when you make a request, or just state what you want?
- How do you signal "I'm done discussing, just do it" vs "let's keep exploring"?

**Push back on:** "it depends" without saying on *what*, mismatch between stated preferences and how they've actually communicated during this session.

### Domain: Technical stack

What the user works with.

- Primary languages and frameworks
- Tools: IDE, terminal, CI, deployment
- What they're learning vs what they're expert in
- Strong opinions or anti-preferences ("never suggest X")

**Push back on:** listing everything they've ever touched (focus on what they use *now*), claiming expertise without evidence, missing the tools they actually use daily.

### Domain: Privacy & external actions

How the user thinks about privacy and the boundary between internal and external actions.

- What counts as sensitive in your world? (Code? Contacts? Financial? All external-facing actions?)
- How do you feel about the agent acting internally — reading files, organizing notes, searching your codebase — without asking?
- Where's the hard line for external actions? (Sending messages, posting, emailing, sharing)

**Push back on:** blanket "ask me everything" (that contradicts wanting an autonomous agent), overly permissive ("do whatever" — until the first unwanted email), not distinguishing internal from external risk.

### Domain: What makes a good / bad session

The user's experience — what success and failure feel like *to them*.

- Think of a time working with an AI went really well. What made it work?
- Think of a time it went badly. What went wrong?
- What's the single biggest time-waster in your AI interactions?

**Push back on:** abstract answers ("it was helpful" — *how?*), blaming only the AI without naming what the user wanted differently.

## Step 3 — Convergence check

When you've covered enough ground (or the user signals they're done), pause and play back what you've heard — not as a list of answers, but as a description of how this person works:

> "Here's what I'm taking away: you're a [role] who works [style]. You communicate [way], your privacy line is [boundary], and a good session for you looks like [description]. You're deep in [stack] and learning [new thing]."

Ask: "Does this sound right? What's missing or wrong?"

Iterate until the user confirms. Don't rush this step.

## Step 4 — Generate profile.md

Write the profile based on the conversation. Structure:

- **Who I am** — role, background, context (facts, not bio)
- **How I work** — working style, decision style, process
- **Communication** — how the user communicates, not how the agent should respond
- **Technical stack** — what I use, what I'm learning, what I avoid
- **Privacy & external actions** — what's sensitive, internal vs external comfort level
- **What makes a good/bad session** — the user's experience of success and failure

Use the frontmatter structure from the template. Replace `{{agent_name}}` with the configured agent name. Set `date` to today.

**Guardrails validation (before writing):** If guardrails.md exists, review every section of the generated profile against the guardrails. If any preference or working style contradicts a guardrail, fix it before presenting to the user. Show the user what was adjusted and why.

**For refinement sessions:** show a diff of what changed. Let the user approve before writing.

Write via `mcp__plugin_workbench-core_memory__write` to `identity/profile.md`.

## Step 5 — Confirm

Tell the user the profile is written and will load on next session start.

## Notes

- **Pacing:** One domain at a time. Let answers breathe. **One question per message.** After asking a question, STOP and wait for the user's response before asking a follow-up or moving to the next question. Never stack a follow-up question after processing an answer in the same message.
- **Refinement shortcuts:** "Stack is fine, just update my preferences" — go directly there.
- **Abort gracefully:** If the user says "skip" or "enough" — stop. Don't write a half-finished profile.
- **This is about the user, not the agent.** Don't let the profile become a second soul file. It's facts and preferences, not character.
- **Observe the conversation itself.** If the user has been terse throughout, that's data. If they think out loud, that's data. Note revealed preferences, not just stated ones.
