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
# "Done when:" needs [[:space:]]+ between its two words and no derivation rule
# would produce that from the header alone without being wrong for the others.
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

# shellcheck disable=SC2034  # consumed by callers that source this file
WORKBENCH_BRIEF_SLOTS=(
  'Workdir:|^[[:space:]]*Workdir:|absolute path of the tree to work in, and the branch or worktree if one was settled'
  'Goal:|^[[:space:]]*Goal:|one or two sentences, measurable'
  'Context:|^[[:space:]]*Context:|why the task exists, and what the agent cannot derive'
  'Constraints:|^[[:space:]]*Constraints:|hard limits, or none'
  'Done when:|^[[:space:]]*Done[[:space:]]+when:|observable finish line'
)

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
