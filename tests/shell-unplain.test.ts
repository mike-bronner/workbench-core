import { describe, expect, test } from 'claude-code/testing'

import { commandsOf, parseShell } from '../hooks/mods/shell'

const unplain = (line: string) => parseShell(line).unplain
const feeds = (line: string) => parseShell(line).feeds
const hasSubshell = (line: string) => parseShell(line).hasSubshell

const PLACES: readonly ((parameter: string) => string)[] = [
  p => `echo ${p}`,
  p => `echo "${p}"`,
  p => `echo "a ${p} b" c`,
  p => `echo $(( ${p} + 1 ))`,
  p => `(( ${p} ))`,
  p => `echo $[ ${p} ]`,
  p => `echo "$(( ${p} ))"`,
  p => `cat <<E\n${p}\nE`,
  p => `cat <<-E\n\t${p}\nE`,
  p => `echo $(echo ${p})`,
  p => `bash -c 'echo ${p}'`,
]

describe('AC1: a ${…} beyond the parameter grammar is the parameter reason, wherever it expands', () => {
  test('a quote or a brace inside ${…} splits it, in bash and zsh alike', () => {
    for (const line of [
      `echo \${x:-'}'}`,
      `echo "\${x:-'}'}"`,
      `echo "\${x:-'a'}" c`,
      `echo "\${x:-"}"}"`,
      `echo "\${x:-"'"}" c`,
      'echo ${x:-{a,b}}',
      'echo "${x:-{a}"',
      'echo ${x:-\\}}',
      `echo "\${x:-'}"; zap; echo "'}"`,
      `echo \${x:-'}"; zap; echo "'}`,
      `echo $(echo \${x:-'}'} c)`,
    ]) {
      expect([line, unplain(line)]).toEqual([line, ['parameter']])
    }
  })

  test('each place a ${…} expands reads its content against the grammar', () => {
    for (const place of PLACES) {
      expect([place('${a b}'), unplain(place('${a b}'))]).toEqual([place('${a b}'), ['parameter']])
      expect([place('${x}'), unplain(place('${x}'))]).toEqual([place('${x}'), []])
    }
  })

  test('a ${…} with no } is the parameter reason', () => {
    expect(unplain('echo ${x')).toEqual(['parameter'])
    expect(unplain('echo "${x"')).toEqual(['parameter'])
    expect(unplain('cat <<E\n${x\nE')).toEqual(['parameter'])
  })

  test('a word holding anything the grammar refuses is the parameter reason', () => {
    for (const word of ['$1[0]', '$1{', '$@[0]', '$*{', '$#[0]', '$?{', '$$[0]', '$${y}', '$$(id)', '$(id)', '`id`', '${y}', '$y[0]', '$y{', '\\x', "'a'", '"a"', '(a)', '<a', '>a', 'a;b', 'a|b', '{a', 'a\nb']) {
      const line = `echo "\${x:-${word}}"`
      expect([line, unplain(line).includes('parameter')]).toEqual([line, true])
    }
  })

  test('a name the grammar does not know, or a subscript it does not know, is the parameter reason', () => {
    for (const parameter of ['${!}', '${x y}', '${1[0]}', '${x[i]}', '${x[$i]}', '${x[1]:a}', '${#x:-a}', '${x:1:2:3}', '${x:a}', '${x@Q}']) {
      expect([parameter, unplain(`echo ${parameter}`).includes('parameter')]).toEqual([parameter, true])
    }
  })
})

describe('the parameter check skips a $( ), a backtick and a backslash in a heredoc body and in arithmetic', () => {
  const SKIPPED = ["$(echo '${')", "`echo '${'`", '\\${a b}']
  const BODIES: readonly ((text: string) => string)[] = [t => `cat <<E\n${t}\nE`, t => `cat <<-E\n\t${t}\nE`]
  const ARITHMETIC: readonly ((text: string) => string)[] = [
    t => `echo $(( ${t} + 1 ))`,
    t => `(( ${t} + 1 ))`,
    t => `echo $[ ${t} + 1 ]`,
    t => `echo "$(( ${t} + 1 ))"`,
  ]

  test('control: a quoted ${ in a heredoc body is no quote there, so it is the parameter reason', () => {
    for (const place of BODIES) expect([place("'${'"), unplain(place("'${'"))]).toEqual([place("'${'"), ['parameter']])
  })

  test('a ${ the skipped text holds is no parameter reason, in each body and each arithmetic place', () => {
    for (const place of [...BODIES, ...ARITHMETIC]) {
      for (const text of SKIPPED) expect([place(text), unplain(place(text))]).toEqual([place(text), []])
    }
  })

  test('the check goes on after the skipped text, so a ${…} beyond the grammar there is still the parameter reason', () => {
    for (const place of [...BODIES, ...ARITHMETIC]) {
      for (const text of SKIPPED) {
        const line = place(`${text} \${a b}`)
        expect([line, unplain(line)]).toEqual([line, ['parameter']])
      }
    }
  })

  test('a # comment that holds a ) inside a $( ) in arithmetic, or in a body fed to a shell, leaves the line with an unknown', () => {
    for (const line of ['echo $(( $(echo # )\n) + 1 ))', '(( $(echo # )\n) ))', 'echo "$(( $(echo # )\n) ))"', 'bash <<E\n$(echo # )\nzap\n)\nE']) {
      const parse = parseShell(line)
      expect([line, parse.unplain.length + parse.unknowns.length > 0]).toEqual([line, true])
    }
  })
})

describe('AC1: a raw text that can run code from a value is the code-expansion reason, quoted or not', () => {
  test("bash's @ operators and zsh's (e) and (%) flags, in every place, the arithmetic places included", () => {
    for (const place of PLACES) {
      for (const runs of ['${x@P}', '${arr[@]@P}', '${#x@Q}', '${(e)x}', '${(%)x}', '${(%%)x}', '${#(e)x}']) {
        const line = place(runs)
        expect([line, unplain(line).includes('code-expansion')]).toEqual([line, true])
      }
    }
  })

  test('${!, $${ and $$( are the code-expansion reason', () => {
    for (const line of ['echo ${!x}', 'echo ${!x[@]}', 'echo $${x}', 'echo $$(id)', 'echo "$${x}"']) {
      expect([line, unplain(line).includes('code-expansion')]).toEqual([line, true])
    }
  })

  test('quoted text is scanned too: single quotes, a quoted heredoc body and $\'…\'', () => {
    for (const line of [": '${x@P}'", "cat <<'E'\n${x@P}\nE", "echo $'${(e)x}'", "echo '$${x}'"]) {
      expect([line, unplain(line)]).toEqual([line, ['code-expansion']])
    }
  })

  test('a backslash-newline is removed before the scan, and a $ before one is the reason itself', () => {
    expect(unplain('echo ${x\\\n@P}')).toContain('code-expansion')
    expect(unplain("echo '$\\\n{(e)x}'")).toEqual(['code-expansion'])
    expect(unplain('echo $\\\nx')).toEqual(['code-expansion'])
  })

  test('a script the reader decodes is scanned as it decodes', () => {
    expect(unplain("bash -c $'echo \\x24{x@P}'")).toContain('code-expansion')
  })
})

describe('AC1: the word esac or case anywhere is the case reason', () => {
  test('a case statement, and esac quoted, escaped, joined by a backslash-newline or in a body', () => {
    for (const line of ['case x in a) zap;; esac', 'echo esac', "echo 'esac'", 'echo "a esac b"', 'echo es\\\nac', 'cat <<E\nesac\nE', 'echo $(case x in x) :;; esac)']) {
      expect([line, unplain(line)]).toEqual([line, ['case']])
    }
  })

  test('zsh\'s brace form of case, which has no esac, and the word case quoted, escaped, joined by a backslash-newline or in a body', () => {
    for (const line of ['case a { a) zap;; }', 'case a in a) zap;; }', 'echo case', "echo 'case'", 'echo "a case b"', 'echo \\case', 'echo ca\\\nse', 'cat <<E\ncase\nE', 'echo $(case a { a) :;; })']) {
      expect([line, unplain(line)]).toEqual([line, ['case']])
    }
  })

  test('esac or case inside a longer word is not the word, and a line with neither has no case reason', () => {
    for (const line of ['echo esacs', 'echo xesac', 'echo esac_x', 'echo cases', 'echo showcase', 'echo case_x', 'echo a b', 'ls -la', 'echo "{ a) b;; }"']) {
      expect([line, unplain(line)]).toEqual([line, []])
    }
  })
})

describe('AC2: the must-pass lines get no lexer-level reason', () => {
  test('plain parameters, operators and words', () => {
    for (const line of [
      'echo ${x//&/and}',
      'cd "${XDG:-$HOME/.config}"',
      'printf "%s\\n" "${arr[@]}"',
      'echo $$',
      'echo "$$"',
      'echo ${x} ${#x} ${#arr[@]} ${arr[*]} ${arr[0]} ${1} ${10} ${#} ${?} ${$} ${##}',
      'echo ${x:-a} ${x-a} ${x:=a} ${x=a} ${x:+a} ${x+a} ${x:?a} ${x?a}',
      'echo ${x#a} ${x##*/} ${x%.*} ${x%%.*} ${x/a/b} ${x//a/b} ${x/#a/b} ${x/%a/b}',
      'echo ${x^} ${x^^} ${x,} ${x,,} ${arr[@]:-a}',
      'echo ${x:1} ${x:1:2} ${x: -1} ${x:-1} ${x:0:-1}',
      'echo "${HOME}/x" "${x:-a b}" "${x:-$HOME}" "${x:-$y.z}"',
      'mkdir -p "${TMPDIR:-/tmp}/x" && ls "$HOME"',
      'git log --oneline -20',
      'echo "$(git rev-parse HEAD)"',
      'echo $(( x + 1 )) $(( ${#x} * 2 ))',
      'cat <<E\nhello ${USER:-me}\nE',
      "cat <<'E'\n${not plain}\nE",
      "echo '${a b}' \"\\${a b}\"",
    ]) {
      expect([line, unplain(line)]).toEqual([line, []])
    }
  })
})

describe('the special parameters and the positional words are plain, and every hole stays refused', () => {
  test('$@, $* and $- as the name, with # for length and with an operator, get no reason in any place', () => {
    for (const place of PLACES) {
      for (const parameter of ['${@}', '${*}', '${-}', '${#@}', '${#*}', '${#-}', '${@:2}', '${*:-a}', '${@:1:2}', '${-#*i}']) {
        const line = place(parameter)
        expect([line, unplain(line)]).toEqual([line, []])
      }
    }
  })

  test('a word may hold $1 to $9, $@, $*, $#, $? and $$', () => {
    for (const line of ['echo "${@}"', 'echo "${*}"', 'echo ${-}', 'echo ${#@}', 'echo ${x:-$1}', 'echo ${x:-$@}', 'echo ${x:-$?}', 'echo "${x:-$9/$*}"', 'echo ${x:-$#.$$}']) {
      expect([line, unplain(line)]).toEqual([line, []])
    }
  })

  test('a transform needs a name or a subscript before its @, so the raw scan passes ${@} and ${#@} and refuses the rest', () => {
    for (const text of ['${@}', '${*}', '${#@}', '${#*}', '${@:2}', '${x-@}', '${x:-a@b}', '${x@}']) {
      const line = `: '${text}'`
      expect([line, unplain(line)]).toEqual([line, []])
    }
    for (const text of ['${x@P}', '${a[0]@P}', "${a['}']@P}", '${@@P}', '${*@P}', '${#@P}', '${-@P}', '${[0]@P}', '${!x}', '${(e)x}', '$${x}', '$$(x)']) {
      const line = `: '${text}'`
      expect([line, unplain(line)]).toEqual([line, ['code-expansion']])
    }
  })

  test('a subscript that holds a quote, a $, a backtick, a backslash, a { or a [ is the code-expansion reason, because the scan cannot find its ]', () => {
    for (const text of ['${a["]"]@P}', "${a[']']@P}", '${a[${b}]@P}', '${a[$(b)]@P}', '${a[`b`]@P}', '${a[\\]]@P}', '${a[b[0]]@P}', '${a[{]@P}', '${#a["]"]@Q}', '${["]"]@P}', '${a["x"]}']) {
      const line = `: '${text}'`
      expect([line, unplain(line)]).toEqual([line, ['code-expansion']])
    }
  })

  test('a subscript of plain characters is no code-expansion reason', () => {
    for (const line of ['echo "${arr[@]}"', 'echo "${arr[*]}"', 'echo ${arr[0]}', 'echo "${@}"', 'echo ${#@}', 'echo ${#arr[@]} "${arr[@]:-a}"']) {
      expect([line, unplain(line)]).toEqual([line, []])
    }
    for (const text of ['${arr[@]}', '${arr[*]}', '${arr[0]}', '${a[i+1]}', '${a[0]@}']) {
      const line = `: '${text}'`
      expect([line, unplain(line)]).toEqual([line, []])
    }
  })

  test('the holes keep their reasons where they expand', () => {
    for (const line of ['echo ${x@P}', 'echo ${a[0]@P}', 'echo ${!x}', 'echo ${(e)x}', 'echo $${x}', 'echo $$(x)', 'echo "${@@P}"']) {
      expect([line, unplain(line).includes('code-expansion')]).toEqual([line, true])
    }
    for (const line of ['echo ${x:-${y}}', 'echo ${x:-$1[0]}', 'echo "${x:-$@{y}}"']) {
      expect([line, unplain(line)]).toEqual([line, ['parameter']])
    }
  })
})

describe('the feed facts and the subshell fact, for the statement rules', () => {
  test('a | or |& is the pipe feed, and || is none', () => {
    expect(feeds('a | b')).toEqual(['pipe'])
    expect(feeds('a |& b')).toEqual(['pipe'])
    expect(feeds('a || b')).toEqual([])
    expect(feeds('a && b; c')).toEqual([])
  })

  test('a pipe into a subshell is still the pipe feed', () => {
    const parse = parseShell('echo x | (bash)')
    expect(parse.feeds).toEqual(['pipe'])
    expect(parse.hasSubshell).toBe(true)
  })

  test('a | inside a case pattern or ${…} is no pipe', () => {
    expect(feeds('echo ${x:-a|b}')).toEqual([])
    expect(feeds('case x in\na|b) :;;\nesac')).toEqual([])
  })

  test('<( and >( are the process feed, in a test too, and $( is none', () => {
    expect(feeds('diff <(a) <(b)')).toEqual(['process'])
    expect(feeds('tee >(a)')).toEqual(['process'])
    expect(feeds('[[ -n <(a) ]]')).toEqual(['process'])
    expect(feeds('echo $(a)')).toEqual([])
    expect(feeds('echo "<(a)"')).toEqual([])
  })

  test("zsh's =( at the start of a word is the process feed, and its command is read", () => {
    const parse = parseShell('bash =(echo git push)')
    expect(parse.feeds).toEqual(['process'])
    expect(parse.hasSubshell).toBe(false)
    expect(parse.unknowns).not.toContain('expansion')
    expect(commandsOf('bash =(echo git push)')).toContainEqual(['echo', 'git', 'push'])
  })

  test('=( is the process feed in command position, as an argument or redirect target, after an operator, in an assignment, array, ${…} value or case pattern, and in a test', () => {
    const lines = [
      '=(a)',
      'cat =(a)',
      'cat =( a )',
      'cat x =(a)y',
      'cat <=(a)',
      'echo >=(a)',
      'echo 2>=(a)',
      'b; =(a)',
      'b && =(a)',
      'b || =(a)',
      '(=(a))',
      '{ =(a) }',
      'x==(a)',
      'x+==(a)',
      'y=b x==(a)',
      'export x==(a)',
      'local x==(a)',
      'x=(1 =(a))',
      'x=(=(a))',
      'echo ${x:-=(a)}',
      'echo ${x-=(a)}',
      'echo ${x:+=(a)}',
      'echo ${x==(a)}',
      'echo ${x:==(a)}',
      'echo ${x/b/=(a)}',
      'echo ${x:-${y:-=(a)}}',
      'case =(a) in *) :;; esac',
      'case x in =(a)) :;; esac',
      'for f in =(a); do :; done',
      'echo $(cat =(a))',
      "bash -c 'cat =(a)'",
      '[[ x == =(a) ]]',
    ]
    for (const line of lines) expect([line, feeds(line)]).toEqual([line, ['process']])
  })

  test('a quoted or escaped =(, a =( later in a word, an array, the := operator and the == of a test are no process feed', () => {
    const lines = [
      'x=(1 2)',
      'x+=(1 2)',
      'echo "=("',
      "echo '=('",
      'echo "=(a)"',
      "echo '=(a)'",
      'echo \\=(a)',
      'echo ""=(a)',
      'echo "${x:-=(a)}"',
      '[[ x==(y) ]]',
      '[[ x == (a) ]]',
      'echo --f==(a)',
      'echo ${x:=(a)}',
      'echo ${x:-y=(a)}',
      'cat <<E\n=(a)\nE',
    ]
    for (const line of lines) expect([line, feeds(line)]).toEqual([line, []])
  })

  test('an =( whose paren never closes is the process feed with the substitution unknown, and a closed one has no unknown', () => {
    for (const line of ['cat =(echo', 'x==(echo', 'echo ${x:-=(a']) {
      const parse = parseShell(line)
      expect([line, parse.feeds, parse.unknowns]).toEqual([line, ['process'], ['substitution']])
    }
    const closed = parseShell('cat =(echo)')
    expect([closed.feeds, closed.unknowns]).toEqual([['process'], []])
  })

  test('zsh runs the =( in a subscripted assignment, so it is the process feed and its command a substitution, read as a[1]=<( ) is', () => {
    expect([feeds('a[1]=<(echo)'), parseShell('a[1]=<(echo)').unknowns]).toEqual([['process'], ['expansion']])
    for (const line of ['a[1]==(echo)', 'h[k]==(echo)', 'a[1]+==(echo)', 'a[b[i]]==(echo)']) {
      const parse = parseShell(line)
      expect([line, parse.feeds, parse.hasSubshell, parse.unknowns]).toEqual([line, ['process'], false, ['expansion']])
      expect([line, parse.statements.find(s => s.name === 'echo')?.source]).toEqual([line, 'substitution'])
    }
    expect(feeds('a[1]=(echo)')).toEqual([])
    expect(feeds('[[ a[1]==(echo) ]]')).toEqual([])
  })

  test('the frozen compat reading of =( is unchanged', () => {
    expect(commandsOf('bash =(echo git push)', true)).toEqual([['bash', '='], ['echo', 'git', 'push']])
  })

  test('a reserved coproc is the coproc feed, and a quoted one is not', () => {
    expect(feeds('coproc cat')).toEqual(['coproc'])
    expect(feeds('coproc N { cat; }')).toEqual(['coproc'])
    expect(feeds('echo coproc')).toEqual([])
    expect(feeds("'coproc' cat")).toEqual([])
  })

  test('the feeds are read at any depth, sorted, each once', () => {
    expect(feeds("bash -c 'a | b'")).toEqual(['pipe'])
    expect(feeds('echo $(coproc a; b <(c) | d | e)')).toEqual(['coproc', 'pipe', 'process'])
    expect(feeds('bash <<E\na | b\nE')).toEqual(['pipe'])
    expect(feeds('cat <<E\na | b\nE')).toEqual([])
  })

  test('a ( that opens a subshell sets hasSubshell, at any depth', () => {
    for (const line of ['(cd x && y)', 'a; (b)', 'echo $( (a) )', "bash -c '(a)'", 'f() (a)']) {
      expect([line, hasSubshell(line)]).toEqual([line, true])
    }
  })

  test('a substitution, arithmetic, an array, a case pattern and a function name hold no subshell', () => {
    for (const line of ['echo $(a)', 'echo <(a)', '(( x + 1 ))', 'echo $(( 1 ))', 'x=(a b)', 'case x in\n(a) :;;\nesac', 'f() { a; }', 'echo "(a)"', 'echo \\(a\\)']) {
      expect([line, hasSubshell(line)]).toEqual([line, false])
    }
  })
})

describe('the unplain list', () => {
  test('is sorted and names each reason once', () => {
    expect(unplain('echo ${x@P} ${y@P} esac ${a b}')).toEqual(['case', 'code-expansion', 'parameter'])
  })

  test('is empty on a plain line, and parseShell answers it beside the statements and unknowns', () => {
    expect(parseShell('git status')).toMatchObject({ unknowns: [], unplain: [], feeds: [], hasSubshell: false })
  })
})
