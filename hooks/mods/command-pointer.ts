import { proseOf } from './question-rule'

export const COMMAND_POINTER_REMINDER =
  'Your final reply points at a command by its position, such as "listed above", ' +
  'and shows no command in a code block. Mike may not see text from earlier in ' +
  'the turn, because the app can fold it. Repeat each command in full: in a bash ' +
  'code block in your reply, or in backticks inside the AskUserQuestion text.'

const FENCE = /^ {0,3}(```|~~~)/m
const POSITION = /\b(above|earlier|previous|listed)\b/i
const COMMAND = /\b(commands?|run|line)\b/i

export const pointsAtUnshownCommand = (reply: string): boolean =>
  !FENCE.test(reply) &&
  proseOf(reply)
    .split(/[.!?\n]+/)
    .some(sentence => POSITION.test(sentence) && COMMAND.test(sentence))
