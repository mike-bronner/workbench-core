---
description: Interactive interview to build or refine the user's profile.md. Asks about role, working style, technical stack, collaboration preferences, and what the user explicitly does NOT need from their agent. Keeps asking until the profile is solid or the user opts out.
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

Read the existing profile from the vault via `mcp__plugin_workbench_memory__read` for `identity/profile.md`.

**If it exists:** This is a refinement session. Summarize what you see in 2-3 lines. Ask: "What's accurate? What's changed? Or should we walk through everything?"

**If it doesn't exist:** This is first-time setup. Read the profile template from `${CLAUDE_PLUGIN_ROOT}/assets/templates/profile.template.md` to understand the target structure, but don't show it — keep the conversation natural.

## Step 2 — Conversational interview

Work through the **domains** below. Branch based on answers, skip what's already solid in refinement mode, dig deeper where answers are vague or thin.

For each question: present **three concrete options** that represent meaningfully different working styles, plus the ability to provide a custom answer. Options should be specific and opinionated — not a spectrum.

### Domain: Role & context

Who the user is and what they're working on.

- What's your role? (Not job title — what do you actually do day to day?)
- What kind of work do you primarily use this agent for?
- What's your experience level with the tools/languages in your stack?

**Push back on:** job titles without context ("I'm a senior engineer" — doing what?), vague scope ("various projects" — name one).

### Domain: Working style

How the user thinks and makes decisions.

- Do you plan before coding, or figure it out as you go?
- When you're stuck, do you want to talk it through or have the agent go investigate?
- How do you handle scope — do you tend to expand ("while we're here...") or stay narrow?
- How do you feel about the agent suggesting improvements you didn't ask for?

**Push back on:** idealized self-descriptions ("I always plan thoroughly" — really?), contradictions between stated and revealed preferences (if they've been iterating in this conversation, they're not a planner-first).

### Domain: Communication preferences

How the user wants to interact.

- Terse or detailed responses? When does each apply?
- Should the agent explain its reasoning, or just give the answer?
- How much confirmation before acting? ("I'll edit this file" every time, or just do it?)
- What's the threshold for asking vs deciding? (e.g., "pick the library yourself" vs "show me options")

**Push back on:** "it depends" without saying on *what*, unrealistic expectations ("never ask me anything" but then correcting choices), mismatch between stated preferences and how they've actually communicated during this session.

### Domain: Technical stack

What the user works with.

- Primary languages and frameworks
- Tools: IDE, terminal, CI, deployment
- What they're learning vs what they're expert in
- Strong opinions or anti-preferences ("never suggest X")

**Push back on:** listing everything they've ever touched (focus on what they use *now*), claiming expertise without evidence, missing the tools they actually use daily.

### Domain: Collaboration shape

How the user wants to work *with this specific agent*.

- What does a productive session look like?
- What makes a session feel frustrating?
- Should the agent be proactive (suggest next steps, notice issues) or reactive (wait to be asked)?
- How should the agent handle disagreement? (push back? suggest alternatives? defer?)
- Are there recurring tasks where the agent should just know the drill?

**Push back on:** abstract ideals ("just be helpful"), preferences that conflict with earlier answers, missing the emotional texture (is frustration about wasted time? wrong assumptions? too many questions?).

### Domain: What you DON'T need

Explicit anti-patterns.

- What behaviors from AI assistants annoy you most?
- What does the agent waste time on that you wish it would skip?
- When should the agent definitely NOT act autonomously?
- Is there anything previous AI interactions have gotten consistently wrong?

**Push back on:** politeness-driven non-answers ("it's all fine"), overly broad bans ("don't ever make suggestions" — that contradicts the point of having an agent).

## Step 3 — Convergence check

When you've covered enough ground (or the user signals they're done), pause and play back what you've heard — not as a list of answers, but as a description of how this person works:

> "Here's what I'm taking away: you're a [role] who works [style]. You want [collaboration shape] and get frustrated when [anti-pattern]. You're deep in [stack] and learning [new thing]. The main thing you don't need is [anti-need]."

Ask: "Does this sound right? What's missing or wrong?"

Iterate until the user confirms. Don't rush this step.

## Step 4 — Generate profile.md

Write the profile based on the conversation. Structure:

- **Who I am** — role, background, context (facts, not bio)
- **How I work** — working style, decision style, communication preferences
- **Technical stack** — what I use, what I'm learning, what I avoid
- **Preferences for {agent_name}** — specific behavioral requests
- **What I don't need** — explicit anti-patterns

Use the frontmatter structure from the template. Replace `{{agent_name}}` with the configured agent name. Set `date` to today.

**For refinement sessions:** show a diff of what changed. Let the user approve before writing.

Write via `mcp__plugin_workbench_memory__write` to `identity/profile.md`.

## Step 5 — Confirm

Tell the user the profile is written and will load on next session start.

## Notes

- **Pacing:** One domain at a time. Let answers breathe.
- **Refinement shortcuts:** "Stack is fine, just update my preferences" — go directly there.
- **Abort gracefully:** If the user says "skip" or "enough" — stop. Don't write a half-finished profile.
- **This is about the user, not the agent.** Don't let the profile become a second soul file. It's facts and preferences, not character.
- **Observe the conversation itself.** If the user has been terse throughout, that's data. If they think out loud, that's data. Note revealed preferences, not just stated ones.
