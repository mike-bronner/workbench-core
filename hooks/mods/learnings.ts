// Skill learnings, merged into the skill's own text through skill.prompt.
//
// Every skill can keep learnings in the vault, at skills/<name>.learnings.md:
// corrections, failures and confirmed approaches from past runs. The retired
// hooks/skill-learnings.sh handed the file over as PreToolUse context, an
// extra block beside the call. Merged into the text the skill expands to, it
// is one block, the same bytes for the same file, and no row of its own.
//
// A file past MAX_CHARS is not merged whole: the skill text gets the file's
// vault path instead, with the instruction to read it through the memory MCP.
// The limit is the old hook's: it keeps a skill that ran long from carrying a
// 68 KB file into every run (memory-lint.learnings.md once reached that).
//
// Pure functions only: the engine follows `$` into no imported function.

export const MAX_CHARS = 9000

export const RULE =
  'Add to this file only when this run taught something a future run needs: the user corrected the approach, something failed and you learned why, or the user confirmed a non-obvious approach. Append it through the memory MCP as `## YYYY-MM-DD - short title` followed by what to do next time. A routine run adds nothing.'

// The vault-relative path of a skill's learnings file, by its bare name.
export const learningsPath = (name: string): string => `skills/${name}.learnings.md`

// The skill's text with its learnings after it.
export function withLearnings(text: string, name: string, learnings: string): string {
  const rel = learningsPath(name)
  const body = learnings.trim()
  if (body === '') return text
  const merged =
    body.length > MAX_CHARS
      ? `## Learnings from past runs\n\nThe \`${name}\` skill has learnings from its past runs, too large to include here. Read the whole file with the memory MCP \`read\` tool, at the vault path \`${rel}\`, before you start, and apply it to this run. ${RULE}`
      : `## Learnings from past runs\n\nLearnings for the \`${name}\` skill, recorded from its past runs at \`${rel}\` in the memory vault. Apply them to this run.\n\n${body}\n\n${RULE}`
  return `${text.replace(/\s+$/, '')}\n\n${merged}\n`
}
