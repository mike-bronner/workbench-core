#!/usr/bin/env bash
#
# brief-template: the ONE definition of the five-slot dispatch brief.
#
# Every dispatch from the main session carries this shape, and
# hooks/agent-dispatch-gate.sh refuses one that does not. Before this file the
# template was spelled out in four places with no shared source: the gate's slot
# checks, the gate's deny message, the README, and independently in the
# workbench-dev-team skill. Renaming a slot on either side silently denied every
# compliant brief, and nothing caught it. `Repo:` becoming `Workdir:` is exactly
# that rename, and it is why this file exists.
#
# Core owns the template. workbench-dev-team consumes it. That direction is
# deliberate: core ships standalone and must never gain a build-time dependency
# on a plugin, so the definition lives on the side that has no dependency to
# take.
#
# Sourceable and side-effect-free, matching hooks/lib/memory-env.sh: sourcing
# this file only DEFINES a variable and two functions. It runs no I/O, forks
# nothing, and exports nothing. That matters because the gate sources it on every
# Agent dispatch, and a hook that inspects a prompt body has a measured budget to
# respect (see the quadratic-expansion note in the gate).
#
# WHAT A SLOT RECORD IS
#
#   <header>|<grep -E pattern>|<description>
#
# The header is what a human types and what the deny message names. The pattern
# is what the gate greps for, case-insensitively, anchored at line start. The
# description is the parenthetical in the deny message and the gloss in the
# README.
#
# The pattern is stored beside the header rather than derived from it, because
# "Done when:" needs a whitespace class between its two words and no derivation
# rule would produce that from the header alone without being wrong for the
# others.
#
# ORDER IS THE TEMPLATE'S ORDER. The gate does not enforce slot order in a
# prompt — a brief carrying all five in any order still uses the template — but
# this array is the order a human reads them in, so the deny message and the
# README both present them this way.
#
# WORKDIR CARRIES THE BRANCH, WHEN A BRANCH WAS SETTLED
#
# The slot names the tree to work in, and a branch or worktree is part of naming
# that tree. workbench-dev-team asks the human before it creates either one, and
# the answer has to travel with the dispatch. Widening this slot is what carries
# it: a sixth slot would have to change the gate, this file, and every agent
# that refuses an incomplete brief, and a Constraints: bullet would separate the
# branch from the path it belongs to.
#
# A bare absolute path stays fully valid. Most dispatches settle nothing, and
# skills/process-pending-summaries dispatches into the memory vault, where no
# branch applies.
#
# This is documented meaning only. The gate greps the headers below and never
# reads slot content, so both shapes already pass and no pattern changed here.

# THE WHITESPACE IN THESE PATTERNS IS SPELLED OUT, NEVER [[:space:]]
#
# The five ASCII whitespace characters that can occur inside a line, listed
# rather than matched with [[:space:]], for the reason already measured on the
# bash side in hooks/workbench-stale-bundle-guard.sh: whether a character is
# "space" depends on the C library and not only on the locale. glibc excludes
# U+00A0, U+202F and U+2007 in every locale including en_US.UTF-8, because they
# are non-breaking. Darwin includes all three.
#
# That difference reached this file's patterns, and grep is a second instance of
# it rather than an exception. Measured through the gate on Darwin: a brief
# whose last slot reads "Done<NBSP>when:" satisfied ^[[:space:]]*Done[[:space:]]+when:
# and passed. The identical brief on glibc failed that pattern, went down as a
# missing slot, and was DENIED. One brief, two verdicts, decided by the libc
# under the gate — which is the whole defect: a gate that parses a brief
# differently on two platforms refuses different work on each.
#
# Newline is deliberately absent. grep matches within a line, so \n can never
# appear in the subject, and listing it would suggest this set is a copy of the
# six-character bash set in hooks/outbound-prose-guard.sh rather than the
# line-scoped set it is.
#
# \t is written as a literal tab through $'...' rather than as the two
# characters \t inside the bracket. POSIX gives a backslash no special meaning
# in a bracket expression, so "[\t]" is the set {backslash, t} to a conforming
# grep and a tab only to one with a GNU extension — the same portability trap
# one layer down. bash resolves $'\t' before grep ever sees the pattern.
_brief_ws=$' \t\r\v\f'

# shellcheck disable=SC2034  # consumed by callers that source this file
WORKBENCH_BRIEF_SLOTS=(
  "Workdir:|^[$_brief_ws]*Workdir:|absolute path of the tree to work in, and the branch or worktree if one was settled"
  "Goal:|^[$_brief_ws]*Goal:|one or two sentences, measurable"
  "Context:|^[$_brief_ws]*Context:|why the task exists, and what the agent cannot derive"
  "Constraints:|^[$_brief_ws]*Constraints:|hard limits, or none"
  "Done when:|^[$_brief_ws]*Done[$_brief_ws]+when:|observable finish line"
)

# The records above already hold the expanded characters, so the helper variable
# has done its work. Unsetting it keeps the promise made at the top of this file:
# sourcing defines the array and two functions, and nothing else.
unset _brief_ws

# brief_slot_field <record> <1|2|3> — pull one field out of a slot record.
#
# Splits on the FIRST two pipes only, so a description may contain a pipe. The
# patterns never do.
brief_slot_field() {
  local record="$1" index="$2" rest
  case "$index" in
    1) printf '%s' "${record%%|*}" ;;
    2) rest="${record#*|}"; printf '%s' "${rest%%|*}" ;;
    3) rest="${record#*|}"; printf '%s' "${rest#*|}" ;;
  esac
}

# brief_slot_summary — "Workdir: (absolute path...), Goal: (...), ..."
#
# The slot list the deny message prints, built from the same records the gate
# checks. A slot renamed above changes both at once, which is the entire point
# of this file.
brief_slot_summary() {
  local record out=""
  for record in "${WORKBENCH_BRIEF_SLOTS[@]}"; do
    out="${out:+$out, }$(brief_slot_field "$record" 1) ($(brief_slot_field "$record" 3))"
  done
  printf '%s' "$out"
}
