// The hostile-input corpus for the commit approval rule's shell reader
// (hooks/mods/commit-approval.ts). tests/commit-approval.test.ts holds the
// reader to every line here, and runs each caught line through the hooks
// module. workbench-dev-team's commit guard port reads the same corpus, so a
// spelling found missing in either place is added here once.
//
// CAUGHT pairs a line with the commits and pushes it runs. LET_THROUGH holds
// lines that only read or mention git, which must never draw a refusal. The
// reader's inherent limits (an alias in a git config file, merge and its
// kin, text piped into a shell, a here-string's text, a script file) are
// listed in the reader's header and are not in the corpus, because the line
// does not say what they run.

export type Expected = { commits: number; pushes: number }

const C: Expected = { commits: 1, pushes: 0 }
const P: Expected = { commits: 0, pushes: 1 }

export const CAUGHT: readonly (readonly [string, Expected])[] = [
  // Plain.
  ['git commit -m x', C],
  ['git commit -am "fix: x"', C],
  ['git push', P],
  ['git push origin main', P],
  // The outer shell runs a substitution in an unquoted body it feeds b\ash,
  // inside '…' too.
  ["b\\ash <<EOF\necho '$(git commit)'\nEOF", C],
  // Global options before the subcommand.
  ['git -C /repo commit -m x', C],
  ['git -C "/path with space" commit -m x', C],
  ['git -c user.name=x commit -m x', C],
  ['git --no-pager -C x commit', C],
  ['git --git-dir .git push', P],
  ['git --git-dir=.git --work-tree=. push', P],
  // Case: macOS finds GIT on its case-insensitive disk.
  ['GIT commit -m x', C],
  ['Git Push', P],
  ['/usr/local/bin/GIT push', P],
  ['git COMMIT -m x', C],
  // Separators.
  ['cd /repo && git push', P],
  ['git add . ; git commit -m x', C],
  ['git status\ngit push', P],
  ['git status || git push', P],
  ['git add . & git commit -m x', C],
  ['(git commit -m x)', C],
  ['{ git push; }', P],
  // Assignments and wrappers, with options that take values.
  ['HUSKY=0 git commit -m x', C],
  ['A=1 B+=2 git push', P],
  ['env HUSKY=0 git push', P],
  ['env -u X git commit -m x', C],
  ['env -i PATH=/bin git push', P],
  ['nice -n 5 git commit -m x', C],
  ['sudo -u mike git push', P],
  ['doas -u mike git push', P],
  ['timeout -s KILL 5 git push', P],
  ['timeout 30 git push', P],
  ['nohup git push &', P],
  ['command git push', P],
  ['exec git commit -m x', C],
  ['xargs -I{} git push', P],
  ['time git push', P],
  ['caffeinate -i git push', P],
  ['stdbuf -oL git push', P],
  ['if git push; then echo ok; fi', P],
  ['while true; do git push; done', P],
  ['! git push', P],
  ['/usr/bin/git push', P],
  // Redirects, before, between and after the words.
  ['>out git commit -m x', C],
  ['2>/dev/null git push', P],
  ['&>/dev/null git push', P],
  ['<in git commit -F -', C],
  ['git push 2>&1', P],
  ['git commit -m x > /tmp/log 2>&1', C],
  ['git commit -m x >>log', C],
  ['git 2>/dev/null push', P],
  // Substitutions, which neither end the outer command nor hide their own.
  ['git -C $(git rev-parse --show-toplevel) commit -m x', C],
  ['git -C `pwd` push', P],
  ['git -C "$(pwd)" push', P],
  ['echo $(git push)', P],
  ['echo "$(git push)"', P],
  ['x=`git commit -m y`', C],
  ['cat <(git push)', P],
  ['echo $(echo $(git push))', P],
  ['echo "`git push`"', P],
  // Shell scripts and eval.
  ['bash -c "git commit -m x"', C],
  ["sh -lc 'git push'", P],
  ["bash -o pipefail -c 'git push'", P],
  ['zsh -ec "git commit -m x"', C],
  ['eval "git push"', P],
  ['eval git push', P],
  ['sudo bash -c "git push"', P],
  ['env bash -c "git push"', P],
  ['bash <<EOF\ngit push\nEOF', P],
  ["bash <<'EOF'\ngit commit -m x\nEOF", C],
  ['sh <<-EOF\n\tgit commit -m x\n\tEOF', C],
  ['eval "$(cat <<EOF\ngit push\nEOF\n)"', P],
  // Heredoc bodies are text: a commit after one, or around one, is still seen.
  ["cat <<'EOF' > /tmp/m\nfix: Mike's rule\nEOF\ngit commit -F /tmp/m", C],
  ["git commit -m \"$(cat <<'EOF'\nfix: Mike's rule\n\ngit push happens after review\nEOF\n)\"", C],
  ['cat <<"EOF" > m\ndon\'t\nEOF\ngit commit -F m', C],
  ["cat <<\\EOF > m\nit's\nEOF\ngit push", P],
  ["cat <<-EOF > m\n\tit's indented\n\tEOF\ngit push", P],
  ["cat <<A <<B\nit's\nA\nalso's\nB\ngit push", P],
  ["cat <<'EOF' > m && git commit -F m\nfix: it's\nEOF", C],
  // An unquoted delimiter expands its body, so a substitution there runs.
  ['cat <<EOF > m\n$(git push)\nEOF', P],
  // A << inside quotes is not a heredoc, and hides nothing after it.
  ['echo "<<EOF"\ngit push', P],
  ["echo '<<EOF'\ngit push", P],
  // Nor in a quoted string that spans lines, or after a quote opened above.
  ['echo "first\n<<EOF"\ngit push\nEOF', P],
  ["echo 'a\nb <<EOF'\ngit commit -m x\nEOF", C],
  // Nor in a comment: bash never reads it.
  ['ls # <<X\ngit push\nX', P],
  ['ls #<<X\ngit commit -m x\nX', C],
  // Nor in arithmetic, where << is a shift.
  ['echo $((1<<2))\ngit push', P],
  ['((x = 1 << 2))\ngit push', P],
  ['let x=1<<2\ngit push', P],
  ['echo "$((1<<2))"\ngit push', P],
  // A partly quoted delimiter is joined as bash joins it: E'OF' is EOF.
  ["cat <<E'OF' > m\nx\nEOF\ngit push", P],
  ['cat <<"E"OF > m\nit\'s\nEOF\ngit commit -m x', C],
  ['cat <<E\\OF > m\nx\nEOF\ngit push', P],
  // Quoting and escapes.
  ['g\\it push', P],
  ['"git" push', P],
  ["'git' 'commit' -m x", C],
  ['git "commit" -m x', C],
  ["$'git' push", P],
  // $"…" is bash's locale string, read as "…".
  ['$"git" push', P],
  ["bash -c '$\"git\" commit -m x'", C],
  ['git $"push"', P],
  // In $'…' a backslash escapes the quote, so \' does not end the string.
  ["echo $'it\\'s' && git push", P],
  ["echo $'it\\'s'; git commit -m x", C],
  ["cat <<< $'it\\'s'; git push", P],
  ["echo \"$(echo $'it\\'s')\"; git push", P],
  ["x=$(printf $'a\\'b'); git commit -m x", C],
  // A command name, a git option or a subcommand with any $'…' escape may
  // spell anything once bash decodes it, so it counts as a commit and a push.
  ["$'\\x67it' push", { commits: 1, pushes: 1 }],
  ["$'\\147it' commit -m x", { commits: 1, pushes: 1 }],
  ["$'\\u0067it' push", { commits: 1, pushes: 1 }],
  ["$'\\U00000067it' push", { commits: 1, pushes: 1 }],
  ["$'\\cG'it push", { commits: 1, pushes: 1 }],
  ["git $'\\x70ush'", { commits: 1, pushes: 1 }],
  ["git $'commi\\164' -m x", { commits: 1, pushes: 1 }],
  ["git $'-\\x43' /other commit -m x", { commits: 1, pushes: 1 }],
  ["env $'\\u0067it' push", { commits: 1, pushes: 1 }],
  ["sudo -u mike $'\\x67it' push", { commits: 1, pushes: 1 }],
  ["/usr/bin/$'\\x67it' push", { commits: 1, pushes: 1 }],
  ['git \\\n  push', P],
  // An alias set on the line.
  ['git -c alias.ci=commit ci -m x', C],
  ['git -c alias.p=push p', P],
  ["git -c 'alias.sync=!git commit -a && git push' sync", { commits: 1, pushes: 1 }],
  // A comment ends at the line's end.
  ['git status # check\ngit push', P],
  // Several on one line.
  ['git commit -m x && git push', { commits: 1, pushes: 1 }],
  ['git commit -m a; git commit -m b', { commits: 2, pushes: 0 }],
  ['git push && git push --tags', { commits: 0, pushes: 2 }],
  // Misses the shared reader closed (hooks/mods/shell.ts). A redirect takes
  // only a real operator, so `|` and `&` after `>&-` still separate.
  ['echo x >&-|git push', P],
  ['true 2>&-&git push', P],
  ['true 2>&-&&git push', P],
  // A shell reads options before its -c script, `--` included.
  ["bash -c -- 'git push'", P],
  ["bash -c -e 'git commit -m x'", C],
  // Bash removes \` inside backticks before it reads them.
  ['echo `echo \\`git push\\``', P],
  // A function body, a coproc, setsid, and a case inside $( ).
  ['function f { git push; }; f', P],
  ['coproc git push', P],
  ['setsid git push', P],
  ['setsid -f git commit -m x', C],
  ['echo $(case x in x) git push;; esac)', P],
  // A ]] right before an operator ends the test.
  ['[[ a ]]&&git push', P],
  ['[[ a ]]||git push', P],
  // A case pattern's substitutions run.
  ['case x in $(git push)) ;; esac', P],
  ['case x in `git push`) ;; esac', P],
  ['case x in ${y:-$(git push)}) ;; esac', P],
  ['case x in y|$(git push)) ;; esac', P],
  ['case x in "$(git push)") ;; esac', P],
  // A word bash does not read as a reserved word opens no case and no test.
  ['\\case x in|git push', P],
  ['"case" x in|git push', P],
  ['c\\ase x in|git push', P],
  ['> f case x in\ngit push', P],
  ['<<< x [[ a || git push', P],
  // A named coprocess runs its body.
  ['coproc NAME { git push; }', P],
]

// Lines the gate counts on purpose though bash runs no commit or push: bash
// 3.2 and zsh reject each as a syntax error, so nothing on it runs. The
// reader cannot tell a rejected line from a run one, so the gate counts it,
// to be safe. A port reads these as the gate's choice, never as bash
// running git.
export const OVER_COUNTED: readonly (readonly [string, Expected])[] = [
  // A word after an arithmetic command: bash rejects `(()) printf RAN`.
  ['(()) git push', P],
]

export const LET_THROUGH: readonly string[] = [
  'git status',
  'git log --grep commit',
  'git log --grep=push',
  'git diff',
  'git show HEAD:commit.txt',
  'git -C /repo log -1 --format=%s',
  'git commit-tree x',
  'git config alias.ci commit',
  'git help commit',
  'git',
  'man git-commit',
  'grep -rn "git push" .',
  'rg "git commit"',
  'echo git commit',
  'echo "git push"',
  "printf '%s' 'git commit'",
  'gh pr create --title "git push fix"',
  'git log --format="%s" | grep push',
  'echo $(git status)',
  'npm run commit',
  'which git',
  'command -v git',
  'nice grep -rn git .',
  'bash script.sh',
  'cat commit.txt push.txt',
  '# git push later\ngit status',
  'git status > commit.log',
  // Heredoc bodies are the text of a message or a file, not commands.
  "cat <<'EOF' > /tmp/m\nfix: Mike's rule\n\ngit push happens after review\nEOF",
  'cat > /tmp/m <<EOF\ngit commit is wrapped onto this line\nEOF',
  "cat <<'EOF' | tee m\n$(git push)\n`git commit -m x`\nEOF",
  "cat <<'EOF' > m\nit's never closed\ngit push",
  "tee m <<'EOF' >/dev/null\ngit commit -m x\nEOF\ngit status",
  // A $'…' string before a heredoc does not leave a quote open over it.
  "echo $'it\\'s'; cat <<EOF > m\ngit push is wrapped here\nEOF",
  // An escape in an argument of another command is only text.
  "echo $'\\x67it push'",
  "printf $'%s\\n' 'git commit'",
  "git log --format=$'%s\\t%h'",
  // A case pattern is text to match, not a command.
  'case x in git) echo;; esac',
]
