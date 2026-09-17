#!/bin/bash
# Tests for hooks/destructive-database-guard.sh — the PreToolUse database guard.
# Run directly: ./test-destructive-database-guard.sh
# Each case feeds the hook one PreToolUse payload on stdin and asserts its
# VERDICT: deny (the call is refused) or allow (nothing is printed, so the normal
# permission flow applies). Pure stdin/stdout checks — no network, no server, no
# database, and nothing is written off disk.
#
# The verdict is read out of the hook's JSON, never out of an exit code. The
# guard used to block by exiting 2, which prefixed the model's message with the
# guard's own absolute filesystem path and threw stdout away; it now returns
# permissionDecision "deny" on exit 0, which refuses the call just as hard and
# leaves the author in control of the first line a person reads.
#
# The suite is weighted towards the ALLOW cases on purpose. A guard that blocks
# every destructive command and also blocks `grep -rn "drop table"` has made
# ordinary code search impossible, which is a worse failure than the one it was
# built to prevent.

set -u
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
GUARD="$HOOKS_DIR/destructive-database-guard.sh"
HOOKS_JSON="$HOOKS_DIR/hooks.json"
RAILS="$(cd "$HOOKS_DIR/.." && pwd)/assets/permissions/rails.json"
PASS=0
FAIL=0

# The three readers every case below goes through. `verdict_of` treats silence
# as an allow, which is what the harness does: only a printed permissionDecision
# changes anything.
verdict_of() {
  local decision
  decision=$(printf '%s' "$1" | jq -r '.hookSpecificOutput.permissionDecision // empty' 2>/dev/null)
  echo "${decision:-allow}"
}
reason_of()  { printf '%s' "$1" | jq -r '.hookSpecificOutput.permissionDecisionReason // empty' 2>/dev/null; }
context_of() { printf '%s' "$1" | jq -r '.hookSpecificOutput.additionalContext // empty' 2>/dev/null; }

# check <deny|allow> <description> <payload-json>
check() {
  local expected="$1" desc="$2" payload="$3" actual
  actual=$(verdict_of "$(printf '%s' "$payload" | bash "$GUARD" 2>/dev/null)")
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected $expected, got $actual"
  fi
}

assert_jq() {
  local desc="$1" file="$2" filter="$3" expected="$4" actual
  actual="$(jq -r "$filter" "$file" 2>/dev/null)"
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected [$expected], got [$actual]"
  fi
}

assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  # `--` matters: a needle such as "--volumes" is otherwise read as a grep flag.
  if printf '%s\n' "$haystack" | grep -qF -- "$needle"; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — output missing: $needle"
  fi
}

bash_json() { jq -nc --arg c "$1" '{tool_name: "Bash", tool_input: {command: $c}}'; }
# The cwd key is what a relative path in the command resolves against, so the
# file-payload cases need it. Note `${2-}` rather than `${2:-}`: an EMPTY cwd is
# a case under test, and it must reach the payload rather than being defaulted.
cwd_json() {
  jq -nc --arg c "$1" --arg d "${2-}" \
    '{tool_name: "Bash", tool_input: {command: $c}, cwd: $d}'
}

# A sandbox of real .sql files. The guard reads contents, not names, so the
# fixtures are named to prove exactly that: reset.sql is destructive, and
# seed.sql merely contains the words "drop table" inside a string literal.
SQLDIR=$(mktemp -d)
trap 'rm -rf "$SQLDIR"' EXIT
mkdir -p "$SQLDIR/db"
printf 'DROP TABLE users;\n'                              > "$SQLDIR/db/reset.sql"
printf "INSERT INTO verses (t) VALUES ('drop table');\n"  > "$SQLDIR/db/seed.sql"
printf 'DELETE FROM sessions WHERE expires < NOW();\n'    > "$SQLDIR/db/prune.sql"

# The command that destroyed several hours of imported data on 2026-09-04.
# `pgsql` was believed to name the testing database. It resolves against .env.
echo "blocks the command from the incident this guard exists for:"
check deny "the exact incident command" \
  "$(bash_json 'php artisan db:wipe --database=pgsql --force')"

echo "blocks every Artisan reset verb on its own:"
check deny "db:wipe"          "$(bash_json 'php artisan db:wipe')"
check deny "migrate:fresh"    "$(bash_json 'php artisan migrate:fresh')"
check deny "migrate:reset"    "$(bash_json 'php artisan migrate:reset')"
check deny "migrate:refresh"  "$(bash_json 'php artisan migrate:refresh')"
check deny "bare ./artisan"   "$(bash_json './artisan migrate:fresh')"
check deny "a --seed run"     "$(bash_json 'php artisan migrate:fresh --seed')"
# A non-testing target is the incident shape, whatever connection it names.
check deny "an explicit non-testing database" \
  "$(bash_json 'php artisan migrate:fresh --database=mysql')"
check deny "an explicit non-testing env" \
  "$(bash_json 'php artisan db:wipe --env=local')"

echo "blocks the destructive shell commands:"
check deny "dropdb"            "$(bash_json 'dropdb myapp')"
check deny "dropdb by path"    "$(bash_json '/usr/local/bin/dropdb myapp')"
check deny "dropuser"          "$(bash_json 'dropuser app_user')"
check deny "mysqladmin drop"   "$(bash_json 'mysqladmin -u root drop myapp')"

# A containerised database keeps its data in a named volume, so the destructive
# Docker commands are the volume-touching ones. The flag that makes them
# destructive sits AFTER the subcommand, which is why only the hook can see it.
echo "blocks the Docker commands that delete a volume:"
check deny "compose down -v"        "$(bash_json 'docker compose down -v')"
check deny "compose down --volumes" "$(bash_json 'docker compose down --volumes')"
check deny "compose down behind -f" "$(bash_json 'docker compose -f docker-compose.yml down -v')"
check deny "legacy docker-compose"  "$(bash_json 'docker-compose down -v')"
check deny "sail down -v"           "$(bash_json 'sail down -v')"
check deny "vendor/bin/sail down"   "$(bash_json './vendor/bin/sail down --volumes')"
check deny "compose rm -v"          "$(bash_json 'docker compose rm -v')"
check deny "docker rm -v"           "$(bash_json 'docker rm -v api')"
check deny "a short flag cluster"   "$(bash_json 'docker rm -fv api')"
check deny "docker volume rm"       "$(bash_json 'docker volume rm app_pgdata')"
check deny "docker volume prune"    "$(bash_json 'docker volume prune -f')"
check deny "system prune --volumes" "$(bash_json 'docker system prune -a --volumes -f')"
check deny "podman volume rm"       "$(bash_json 'podman volume rm app')"
check deny "sudo compose down -v"   "$(bash_json 'sudo docker compose down -v')"
check deny "cd then compose down"   "$(bash_json 'cd /some/repo && docker compose down -v')"
check deny "ssh compose down -v"    "$(bash_json 'ssh box "docker compose down -v"')"

# `docker compose down` keeps named volumes and is how a stack is routinely
# stopped. Blocking the plain form would strand an agent that stopped a stack.
echo "allows the Docker work that keeps the volumes:"
check allow "plain compose down"     "$(bash_json 'docker compose down')"
check allow "down --remove-orphans"  "$(bash_json 'docker compose down --remove-orphans')"
check allow "compose up -d"          "$(bash_json 'docker compose up -d')"
# -V is --renew-anon-volumes on `up`, and the verb is not one this guard reads.
check allow "compose up -d -V"       "$(bash_json 'docker compose up -d -V')"
check allow "docker rm without -v"   "$(bash_json 'docker rm api')"
check allow "compose rm -f"          "$(bash_json 'docker compose rm -f')"
check allow "system prune, no flag"  "$(bash_json 'docker system prune -a')"
check allow "image prune"            "$(bash_json 'docker image prune -f')"
check allow "builder prune"          "$(bash_json 'docker builder prune')"
check allow "network prune"          "$(bash_json 'docker network prune')"
check allow "docker volume ls"       "$(bash_json 'docker volume ls')"
# -v means bind mount on `run`, not volume deletion.
check allow "docker run -v"          "$(bash_json 'docker run -v /host:/app node')"
check allow "compose logs"           "$(bash_json 'docker compose logs -f app')"
check allow "grep for the command"   "$(bash_json 'grep -rn "docker compose down -v" Makefile')"

echo "blocks raw SQL handed to a database client:"
check deny "psql -c DROP DATABASE"   "$(bash_json 'psql -c "DROP DATABASE app"')"
check deny "psql --command= form"    "$(bash_json 'psql --command="DROP SCHEMA public CASCADE"')"
check deny "mysql -e DROP TABLE"     "$(bash_json 'mysql -e "DROP TABLE users"')"
check deny "DROP TABLE IF EXISTS"    "$(bash_json 'mysql -e "DROP TABLE IF EXISTS users"')"
check deny "TRUNCATE TABLE"          "$(bash_json 'psql -c "TRUNCATE TABLE verses"')"
check deny "unqualified DELETE FROM" "$(bash_json 'psql -c "DELETE FROM verses"')"
check deny "sqlite3 positional SQL"  "$(bash_json 'sqlite3 database/app.sqlite "DROP TABLE users"')"
check deny "echo piped into psql"    "$(bash_json 'echo "DROP DATABASE app" | psql')"
check deny "a here-string"           "$(bash_json 'psql <<< "DROP DATABASE app"')"

# ddev, lando, and wp-env manage a project database and drop it with their own
# verbs, so neither the Docker rules nor the Artisan rules ever see them.
echo "blocks the project tools that destroy their own database:"
check deny "ddev delete"            "$(bash_json 'ddev delete')"
check deny "ddev delete a project"  "$(bash_json 'ddev delete -O myproject')"
check deny "ddev stop --remove-data" "$(bash_json 'ddev stop --remove-data')"
check deny "lando destroy"          "$(bash_json 'lando destroy')"
check deny "lando destroy -y"       "$(bash_json 'lando destroy -y')"
check deny "wp-env destroy"         "$(bash_json 'wp-env destroy')"

echo "allows the project tools' ordinary verbs:"
# `ddev delete images` removes Docker images, not project data.
check allow "ddev delete images"     "$(bash_json 'ddev delete images')"
check allow "ddev start"             "$(bash_json 'ddev start')"
check allow "ddev stop"              "$(bash_json 'ddev stop')"
check allow "lando start"            "$(bash_json 'lando start')"
check allow "lando rebuild"          "$(bash_json 'lando rebuild')"
check allow "wp-env start"           "$(bash_json 'wp-env start')"

# The guard reads the FILE CONTENTS. A name settles nothing: reset.sql is
# destructive here, and seed.sql merely mentions "drop table" in a literal.
echo "blocks SQL that arrives from a file:"
check deny "psql -f"          "$(cwd_json 'psql -f db/reset.sql' "$SQLDIR")"
check deny "psql --file="     "$(cwd_json 'psql --file=db/reset.sql' "$SQLDIR")"
check deny "a redirect"       "$(cwd_json 'psql -d app < db/reset.sql' "$SQLDIR")"
check deny "mysql redirect"   "$(cwd_json 'mysql app < db/reset.sql' "$SQLDIR")"
check deny "cat piped in"     "$(cwd_json 'cat db/reset.sql | psql' "$SQLDIR")"
check deny "an absolute path" "$(cwd_json "psql -f $SQLDIR/db/reset.sql" /nowhere)"
# The cd moves where a relative path resolves, which is the incident's shape.
check deny "a cd first"       "$(cwd_json 'cd db && psql -f reset.sql' "$SQLDIR")"

echo "allows files whose contents are not destructive:"
check allow "a seed file"      "$(cwd_json 'psql -f db/seed.sql' "$SQLDIR")"
check allow "a qualified DELETE file" "$(cwd_json 'psql -f db/prune.sql' "$SQLDIR")"
check allow "a missing file"   "$(cwd_json 'psql -f db/gone.sql' "$SQLDIR")"
# mysql reads -f as --force. Treating it as a filename would scan the wrong arg.
check allow "mysql -f is force" "$(cwd_json 'mysql -f app -e "SELECT 1"' "$SQLDIR")"
check allow "cat without a client" "$(cwd_json 'cat db/reset.sql' "$SQLDIR")"
check allow "cat piped to grep" "$(cwd_json 'cat db/reset.sql | grep DROP' "$SQLDIR")"
# The remote machine has its own filesystem, so a local file of the same name is
# the wrong file. Reading it could only ever produce a false block.
check allow "ssh stops the read" "$(cwd_json 'ssh box "psql -f db/reset.sql"' "$SQLDIR")"
# No cwd means no basis for resolving a relative path, so no file is read.
check allow "no cwd in payload" "$(bash_json 'psql -f db/reset.sql')"
check allow "an empty cwd"     "$(cwd_json 'psql -f db/reset.sql' '')"

echo "blocks raw SQL delivered by heredoc:"
check deny "quoted heredoc" "$(bash_json "$(printf 'psql -d app <<%s\nDROP DATABASE app;\nSQL\n' "'SQL'")")"
check deny "bare heredoc"   "$(bash_json "$(printf 'mysql app <<EOF\nTRUNCATE TABLE verses;\nEOF\n')")"
check deny "cat heredoc piped in" \
  "$(bash_json "$(printf 'cat <<EOF | psql -d app\nDROP TABLE verses;\nEOF\n')")"
check deny "double-quoted heredoc" \
  "$(bash_json "$(printf 'psql -d app <<%s\nDROP DATABASE app;\nSQL\n' '"SQL"')")"
check deny "a spaced delimiter" \
  "$(bash_json "$(printf 'psql -d app << SQL\nDROP DATABASE app;\nSQL\n')")"

# THE TAB-STRIPPING FORM, which walked straight through until 2026-09-17.
# `<<-` hides the delimiter behind a dash the heredoc table never stored, since
# extract_heredocs keys bodies by the bare name. The whole-command fallback did
# not rescue it either: `<<` IS in the token list, so saw_heredoc was already
# true and the sweep was skipped. `psql -d app <<-SQL` with a DROP DATABASE in
# the body exited 0 while the identical `<<SQL` form exited 1.
#
# Four spellings, because the dash binds two different ways and both are valid
# bash, verified by running them:
#     <<-SQL  <<-'SQL'  <<-"SQL"   tokenise as ['<<', '-SQL']
#     <<- SQL                      tokenises as ['<<', '-', 'SQL']
# The fourth is the one a single lstrip("-") still misses, which is why the
# lookup also steps over a bare dash.
echo "blocks the tab-stripping heredoc, in every spelling of the dash:"
check deny "<<-SQL"    "$(bash_json "$(printf 'psql -d app <<-SQL\n\tDROP DATABASE app;\n\tSQL\n')")"
check deny "<<-'SQL'"  "$(bash_json "$(printf 'psql -d app <<-%s\n\tDROP DATABASE app;\n\tSQL\n' "'SQL'")")"
check deny '<<-"SQL"'  "$(bash_json "$(printf 'psql -d app <<-%s\n\tDROP DATABASE app;\n\tSQL\n' '"SQL"')")"
check deny "<<- SQL"   "$(bash_json "$(printf 'psql -d app <<- SQL\n\tDROP DATABASE app;\n\tSQL\n')")"
# The same dash form carrying the other two SQL rule classes, so the fix is
# pinned for the whole rule set rather than for DROP alone.
check deny "<<- with TRUNCATE" \
  "$(bash_json "$(printf 'mysql app <<-EOF\n\tTRUNCATE TABLE verses;\n\tEOF\n')")"
check deny "<<- with a bare DELETE" \
  "$(bash_json "$(printf 'psql -d app <<-EOF\n\tDELETE FROM verses;\n\tEOF\n')")"
# And the allow side of the same shape: a dash heredoc that is not destructive
# must still pass, or the fix has simply moved the failure.
check allow "<<- with a SELECT" \
  "$(bash_json "$(printf 'psql -d app <<-SQL\n\tSELECT * FROM verses;\n\tSQL\n')")"
check allow "<<- with a qualified DELETE" \
  "$(bash_json "$(printf 'psql -d app <<-SQL\n\tDELETE FROM verses WHERE id = 1;\n\tSQL\n')")"

# A prefix permission rule sees the first word and nothing else. Every shape
# below hides the verb behind something, which is why the hook exists.
echo "blocks through compound commands and wrappers, where a prefix rule cannot look:"
check deny "cd then artisan"        "$(bash_json 'cd /some/repo && php artisan migrate:fresh')"
check deny "after a semicolon"      "$(bash_json 'echo start; php artisan db:wipe')"
check deny "on the || arm"          "$(bash_json 'test -f .env || php artisan db:wipe')"
check deny "sail"                   "$(bash_json 'sail artisan migrate:fresh')"
check deny "vendor/bin/sail"        "$(bash_json './vendor/bin/sail artisan db:wipe')"
check deny "docker compose exec"    "$(bash_json 'docker compose exec -T app php artisan db:wipe')"
check deny "docker compose w/ user" "$(bash_json 'docker compose exec -u www-data app php artisan migrate:fresh')"
check deny "docker exec"            "$(bash_json 'docker exec -it api php artisan migrate:reset')"
check deny "ssh"                    "$(bash_json 'ssh deploy@box "php artisan migrate:reset"')"
check deny "ssh with a port flag"   "$(bash_json 'ssh -p 2222 box "dropdb myapp"')"
check deny "bash -c"                "$(bash_json 'bash -c "php artisan db:wipe --force"')"
check deny "sh -c wrapping psql"    "$(bash_json 'sh -c "psql -c \"DROP DATABASE app\""')"
check deny "an env assignment"      "$(bash_json 'APP_ENV=local php artisan db:wipe')"
check deny "env with a var"         "$(bash_json 'env APP_ENV=local php artisan migrate:fresh')"
check deny "kubectl exec"           "$(bash_json 'kubectl exec pod/api -- php artisan db:wipe')"

# The incident was a wrong TARGET, not a wrong verb. Rebuilding the testing
# database is ordinary work, so an explicitly scoped reset is allowed. The hole
# is documented in the checker: --env=testing proves intent, not target.
echo "allows an Artisan reset scoped explicitly to the testing database:"
check allow "--env=testing"           "$(bash_json 'php artisan migrate:fresh --env=testing')"
check allow "--env testing"           "$(bash_json 'php artisan migrate:fresh --env testing')"
check allow "--database=testing"      "$(bash_json 'php artisan migrate:fresh --database=testing')"
check allow "--database testing"      "$(bash_json 'php artisan db:wipe --database testing')"
check allow "testing scope with seed" "$(bash_json 'php artisan migrate:fresh --env=testing --seed')"
check allow "scoped inside sail"      "$(bash_json 'sail artisan migrate:fresh --env=testing')"

# The requirement this suite is weighted towards: a guard that stops code search
# has cost more than it saved. Every case below names a destructive verb and
# none of them touches a database.
echo "allows code search and reading that merely mentions a destructive verb:"
check allow "grep for drop table"     "$(bash_json 'grep -rn "drop table" app/')"
check allow "grep for DROP TABLE"     "$(bash_json 'grep -rn "DROP TABLE" database/')"
check allow "grep for the verb"       "$(bash_json 'grep -rn "migrate:fresh" .github/')"
check allow "rg for db:wipe"          "$(bash_json 'rg "db:wipe" --glob "*.php"')"
check allow "cat a drop_ migration"   "$(bash_json 'cat database/migrations/2026_09_04_drop_users_table.php')"
check allow "ls a drop_ migration"    "$(bash_json 'ls database/migrations/*drop_*')"
check allow "cd then grep"            "$(bash_json 'cd /some/repo && grep -rn "TRUNCATE TABLE" app/')"
check allow "echo without a client"   "$(bash_json 'echo "DROP DATABASE app"')"
check allow "a comment about dropdb"  "$(bash_json 'echo "run dropdb by hand if needed"')"

echo "allows the non-destructive database work an agent does constantly:"
check allow "plain migrate"           "$(bash_json 'php artisan migrate')"
check allow "migrate --pretend"       "$(bash_json 'php artisan migrate --pretend')"
check allow "migrate:status"          "$(bash_json 'php artisan migrate:status')"
check allow "migrate:rollback"        "$(bash_json 'php artisan migrate:rollback')"
check allow "artisan test"            "$(bash_json 'php artisan test')"
check allow "artisan db:seed"         "$(bash_json 'php artisan db:seed')"
check allow "a qualified DELETE"      "$(bash_json 'psql -c "DELETE FROM verses WHERE id = 1"')"
check allow "a plain SELECT"          "$(bash_json 'psql -c "SELECT count(*) FROM verses"')"
# A single-quoted SQL literal is data, not a verb.
check allow "a literal saying drop table" \
  "$(bash_json "psql -c \"SELECT * FROM logs WHERE msg = 'drop table'\"")"
# Double quotes are identifiers, not literals, so this must still block.
check deny "a double-quoted identifier" \
  "$(bash_json "psql -c 'DROP TABLE \"users\"'")"
check allow "createdb"                "$(bash_json 'createdb myapp')"
check allow "an unrelated ssh"        "$(bash_json 'ssh box "php artisan migrate --force"')"
# `drop` here is a table name, not the mysqladmin verb.
check allow "mysqladmin status"       "$(bash_json 'mysqladmin -u root status')"

echo "allows anything it cannot parse — this hook is not an OS boundary:"
check allow "malformed json"          'not json at all'
check allow "empty object"            '{}'
check allow "an unmatched tool name"  "$(jq -nc '{tool_name: "Read", tool_input: {file_path: "/tmp/x"}}')"
check allow "an empty command"        "$(bash_json '')"
# An unbalanced quote is shell bash itself would reject. Blocking it would break
# ordinary awk and sed one-liners and stop nothing that could actually run.
check allow "an unbalanced quote"     "$(bash_json 'grep -rn "unclosed app/')"

# The refusal is split across the hook's two channels, and each half is asserted
# on the channel it belongs to. The human line is ONE line that names the ACTION
# and nothing else — that is the whole point of the split, so it is asserted as a
# shape and not only by its words.
echo "the human line names the action, in one line:"
OUT=$(bash_json 'php artisan db:wipe --database=pgsql --force' | bash "$GUARD" 2>/dev/null)
REASON=$(reason_of "$OUT")
assert_contains "leads with the action"  "$REASON" "🛑 Blocked: destroying a database."
assert_contains "offers the ! escape"    "$REASON" "! prefix"
if [ "$(printf '%s' "$REASON" | wc -l | tr -d ' ')" = "0" ] && [ "${#REASON}" -le 120 ]; then
  PASS=$((PASS + 1)); echo "  ✅ is one line and stays short (${#REASON} chars)"
else
  FAIL=$((FAIL + 1)); echo "  ❌ the human line grew past one short line (${#REASON} chars)"
fi
# The command and its flags are the noise a person was asked to stop reading.
if printf '%s' "$REASON" | grep -qF -- "--database=pgsql"; then
  FAIL=$((FAIL + 1)); echo "  ❌ the human line replays the command"
else
  PASS=$((PASS + 1)); echo "  ✅ the human line replays no part of the command"
fi
# No asterisk emphasis: whether the client renders Markdown is unsettled, so the
# action is emphasised by position and by backticks, which read either way.
if printf '%s' "$REASON" | grep -qF -- "**"; then
  FAIL=$((FAIL + 1)); echo "  ❌ the human line uses Markdown emphasis"
else
  PASS=$((PASS + 1)); echo "  ✅ the human line carries no Markdown emphasis"
fi

echo "the detail the model needs survives, in additionalContext:"
CONTEXT=$(context_of "$OUT")
assert_contains "names the guard"        "$CONTEXT" "Destructive-database guard"
assert_contains "names the verb"         "$CONTEXT" "db:wipe"
assert_contains "explains the target"    "$CONTEXT" "development database"
assert_contains "says there is no way round" "$CONTEXT" "no path around this"
OUT=$(bash_json 'psql -c "DROP DATABASE app"' | bash "$GUARD" 2>/dev/null)
CONTEXT=$(context_of "$OUT")
assert_contains "names the SQL verb"     "$CONTEXT" "DROP DATABASE"
assert_contains "names the client"       "$CONTEXT" "psql"
OUT=$(bash_json 'dropdb myapp' | bash "$GUARD" 2>/dev/null)
assert_contains "names dropdb"           "$(context_of "$OUT")" "dropdb"
OUT=$(bash_json 'docker compose down -v' | bash "$GUARD" 2>/dev/null)
CONTEXT=$(context_of "$OUT")
assert_contains "names the volumes flag" "$CONTEXT" "--volumes"
assert_contains "says where data lives"  "$CONTEXT" "named volumes"
OUT=$(cwd_json 'psql -f db/reset.sql' "$SQLDIR" | bash "$GUARD" 2>/dev/null)
assert_contains "names the file"         "$(context_of "$OUT")" "db/reset.sql"
# The guard reads the file to decide, not to quote it. A line of SQL in either
# channel would put file contents into the transcript, so the whole hook output
# is searched rather than one half of it.
if printf '%s\n' "$OUT" | grep -qF -- "DROP TABLE users;"; then
  FAIL=$((FAIL + 1)); echo "  ❌ leaks a line of the file into the message"
else
  PASS=$((PASS + 1)); echo "  ✅ quotes no line of the file"
fi

# This checker's shell parsing moved to hooks/lib/shell_parse.py, shared with
# hooks/lib/vault-git-check.py. That import is the regression the extraction
# could introduce, and it would be invisible: an ImportError leaves the checker
# exiting non-zero with its traceback swallowed, the hook reads that as "not a
# finding", and the guard silently allows everything from then on. A database
# was destroyed on 2026-09-04 because nothing was watching; a guard that stops
# watching is the same failure with a file in the repository to disprove it.
#
# So the incident command is re-run from working directories that have nothing
# to do with the plugin, and once by a relative path. Each asserts the deny.
echo "the shared-parser import survives an arbitrary working directory:"
INCIDENT="$(bash_json 'php artisan db:wipe --database=pgsql --force')"
for DIR in / /tmp "$HOME" "$SQLDIR"; do
  if [ "$(verdict_of "$(printf '%s' "$INCIDENT" | (cd "$DIR" && bash "$GUARD") 2>/dev/null)")" = "deny" ]; then
    PASS=$((PASS + 1)); echo "  ✅ still blocks when invoked from $DIR"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ failed open when invoked from $DIR"
  fi
done
if [ "$(verdict_of "$(printf '%s' "$INCIDENT" | (cd "$HOOKS_DIR" && bash ./destructive-database-guard.sh) 2>/dev/null)")" = "deny" ]; then
  PASS=$((PASS + 1)); echo "  ✅ still blocks when invoked by a relative path"
else
  FAIL=$((FAIL + 1)); echo "  ❌ failed open when invoked by a relative path"
fi
# The file-reading path resolves a relative .sql against the payload's cwd, so it
# is the case most likely to be broken by a cwd-sensitive import or lookup.
if [ "$(verdict_of "$(printf '%s' "$(cwd_json 'psql -f db/reset.sql' "$SQLDIR")" | (cd / && bash "$GUARD") 2>/dev/null)")" = "deny" ]; then
  PASS=$((PASS + 1)); echo "  ✅ still reads a payload-relative .sql from another cwd"
else
  FAIL=$((FAIL + 1)); echo "  ❌ lost the payload-relative file read from another cwd"
fi

# Registration is part of the behaviour: a guard nothing calls guards nothing.
echo "the hook is registered in hooks.json:"
assert_jq "matcher is Bash" "$HOOKS_JSON" \
  '[.hooks.PreToolUse[] | select(.hooks[].command | test("destructive-database-guard.sh")) | .matcher] | join(",")' \
  "Bash"
assert_jq "registered exactly once" "$HOOKS_JSON" \
  '[.hooks.PreToolUse[].hooks[] | select(.command | test("destructive-database-guard.sh"))] | length' "1"
assert_jq "no if condition narrows it" "$HOOKS_JSON" \
  '[.hooks.PreToolUse[] | select(.hooks[].command | test("destructive-database-guard.sh")) | .if // empty] | length' "0"

# The declarative layer. It does not replace the hook — a prefix rule cannot see
# `cd foo && php artisan db:wipe` — but it is what shows up in /config, so the
# boundary is visible to a human reading their own settings.
echo "rails.json denies the shell commands that have no legitimate use:"
for RULE in "Bash(dropdb:*)" "Bash(dropuser:*)" "Bash(mysqladmin drop:*)" \
            "Bash(docker volume rm:*)" "Bash(docker volume prune:*)" \
            "Bash(lando destroy:*)" "Bash(wp-env destroy:*)"; do
  assert_jq "$RULE denied" "$RAILS" \
    "[.deny[] | select(.rule == \"$RULE\")] | length" "1"
done
assert_jq "every database deny explains itself" "$RAILS" \
  '[.deny[] | select(.rule | test("dropdb|dropuser|mysqladmin|docker volume")) | select(.why == null)] | length' "0"

# `docker compose down` keeps named volumes, so only the --volumes form is
# destructive — and that flag sits after the subcommand, where a prefix cannot
# read it. A `Bash(docker compose down:*)` rule would block routine teardown.
echo "no docker compose rule ships — a prefix cannot read the --volumes flag:"
assert_jq "no compose rule in deny" "$RAILS" \
  '[.deny[] | select(.rule | test("docker compose|docker-compose"))] | length' "0"
assert_jq "no compose rule in ask"  "$RAILS" \
  '[.ask[]  | select(.rule | test("docker compose|docker-compose"))] | length' "0"

# `ddev delete images` removes Docker images rather than project data, so a
# prefix rule would block it too. Third instance of the same rule: a deny
# belongs in rails.json only when the FIRST WORDS decide the outcome.
echo "no ddev rule ships — a prefix would also block 'ddev delete images':"
assert_jq "no ddev rule in deny" "$RAILS" \
  '[.deny[] | select(.rule | test("ddev"))] | length' "0"
assert_jq "no ddev rule in ask"  "$RAILS" \
  '[.ask[]  | select(.rule | test("ddev"))] | length' "0"

# A deny rule cannot read a flag that comes later, so it cannot carry the hook's
# --env=testing exemption. Add one and the exemption dies silently: the hook
# exits 0, which is neutral rather than an allow, and the deny blocks anyway.
# permissions.sh merges additively and never removes, so the mistake would stick
# in a user's settings.json after being deleted here. Assert it, do not trust a
# comment — this is the same failure mode the Read() deny rules had.
echo "no Artisan rule ships in either list — a deny would kill the testing exemption:"
assert_jq "no artisan rule in deny" "$RAILS" \
  '[.deny[] | select(.rule | test("artisan"))] | length' "0"
assert_jq "no artisan rule in ask"  "$RAILS" \
  '[.ask[]  | select(.rule | test("artisan"))] | length' "0"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
