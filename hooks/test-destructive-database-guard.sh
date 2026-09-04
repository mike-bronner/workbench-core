#!/bin/bash
# Tests for hooks/destructive-database-guard.sh — the PreToolUse database guard.
# Run directly: ./test-destructive-database-guard.sh
# Each case feeds the hook one PreToolUse payload on stdin and asserts its exit
# code: 2 = blocked, 0 = allowed. Pure stdin/exit-code checks — no network, no
# server, no database, and nothing is ever read off disk.
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

# check <expected-exit> <description> <payload-json>
check() {
  local expected="$1" desc="$2" payload="$3" actual
  printf '%s' "$payload" | bash "$GUARD" >/dev/null 2>&1
  actual=$?
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected exit $expected, got $actual"
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
check 2 "the exact incident command" \
  "$(bash_json 'php artisan db:wipe --database=pgsql --force')"

echo "blocks every Artisan reset verb on its own:"
check 2 "db:wipe"          "$(bash_json 'php artisan db:wipe')"
check 2 "migrate:fresh"    "$(bash_json 'php artisan migrate:fresh')"
check 2 "migrate:reset"    "$(bash_json 'php artisan migrate:reset')"
check 2 "migrate:refresh"  "$(bash_json 'php artisan migrate:refresh')"
check 2 "bare ./artisan"   "$(bash_json './artisan migrate:fresh')"
check 2 "a --seed run"     "$(bash_json 'php artisan migrate:fresh --seed')"
# A non-testing target is the incident shape, whatever connection it names.
check 2 "an explicit non-testing database" \
  "$(bash_json 'php artisan migrate:fresh --database=mysql')"
check 2 "an explicit non-testing env" \
  "$(bash_json 'php artisan db:wipe --env=local')"

echo "blocks the destructive shell commands:"
check 2 "dropdb"            "$(bash_json 'dropdb myapp')"
check 2 "dropdb by path"    "$(bash_json '/usr/local/bin/dropdb myapp')"
check 2 "dropuser"          "$(bash_json 'dropuser app_user')"
check 2 "mysqladmin drop"   "$(bash_json 'mysqladmin -u root drop myapp')"

# A containerised database keeps its data in a named volume, so the destructive
# Docker commands are the volume-touching ones. The flag that makes them
# destructive sits AFTER the subcommand, which is why only the hook can see it.
echo "blocks the Docker commands that delete a volume:"
check 2 "compose down -v"        "$(bash_json 'docker compose down -v')"
check 2 "compose down --volumes" "$(bash_json 'docker compose down --volumes')"
check 2 "compose down behind -f" "$(bash_json 'docker compose -f docker-compose.yml down -v')"
check 2 "legacy docker-compose"  "$(bash_json 'docker-compose down -v')"
check 2 "sail down -v"           "$(bash_json 'sail down -v')"
check 2 "vendor/bin/sail down"   "$(bash_json './vendor/bin/sail down --volumes')"
check 2 "compose rm -v"          "$(bash_json 'docker compose rm -v')"
check 2 "docker rm -v"           "$(bash_json 'docker rm -v api')"
check 2 "a short flag cluster"   "$(bash_json 'docker rm -fv api')"
check 2 "docker volume rm"       "$(bash_json 'docker volume rm app_pgdata')"
check 2 "docker volume prune"    "$(bash_json 'docker volume prune -f')"
check 2 "system prune --volumes" "$(bash_json 'docker system prune -a --volumes -f')"
check 2 "podman volume rm"       "$(bash_json 'podman volume rm app')"
check 2 "sudo compose down -v"   "$(bash_json 'sudo docker compose down -v')"
check 2 "cd then compose down"   "$(bash_json 'cd /some/repo && docker compose down -v')"
check 2 "ssh compose down -v"    "$(bash_json 'ssh box "docker compose down -v"')"

# `docker compose down` keeps named volumes and is how a stack is routinely
# stopped. Blocking the plain form would strand an agent that stopped a stack.
echo "allows the Docker work that keeps the volumes:"
check 0 "plain compose down"     "$(bash_json 'docker compose down')"
check 0 "down --remove-orphans"  "$(bash_json 'docker compose down --remove-orphans')"
check 0 "compose up -d"          "$(bash_json 'docker compose up -d')"
# -V is --renew-anon-volumes on `up`, and the verb is not one this guard reads.
check 0 "compose up -d -V"       "$(bash_json 'docker compose up -d -V')"
check 0 "docker rm without -v"   "$(bash_json 'docker rm api')"
check 0 "compose rm -f"          "$(bash_json 'docker compose rm -f')"
check 0 "system prune, no flag"  "$(bash_json 'docker system prune -a')"
check 0 "image prune"            "$(bash_json 'docker image prune -f')"
check 0 "builder prune"          "$(bash_json 'docker builder prune')"
check 0 "network prune"          "$(bash_json 'docker network prune')"
check 0 "docker volume ls"       "$(bash_json 'docker volume ls')"
# -v means bind mount on `run`, not volume deletion.
check 0 "docker run -v"          "$(bash_json 'docker run -v /host:/app node')"
check 0 "compose logs"           "$(bash_json 'docker compose logs -f app')"
check 0 "grep for the command"   "$(bash_json 'grep -rn "docker compose down -v" Makefile')"

echo "blocks raw SQL handed to a database client:"
check 2 "psql -c DROP DATABASE"   "$(bash_json 'psql -c "DROP DATABASE app"')"
check 2 "psql --command= form"    "$(bash_json 'psql --command="DROP SCHEMA public CASCADE"')"
check 2 "mysql -e DROP TABLE"     "$(bash_json 'mysql -e "DROP TABLE users"')"
check 2 "DROP TABLE IF EXISTS"    "$(bash_json 'mysql -e "DROP TABLE IF EXISTS users"')"
check 2 "TRUNCATE TABLE"          "$(bash_json 'psql -c "TRUNCATE TABLE verses"')"
check 2 "unqualified DELETE FROM" "$(bash_json 'psql -c "DELETE FROM verses"')"
check 2 "sqlite3 positional SQL"  "$(bash_json 'sqlite3 database/app.sqlite "DROP TABLE users"')"
check 2 "echo piped into psql"    "$(bash_json 'echo "DROP DATABASE app" | psql')"
check 2 "a here-string"           "$(bash_json 'psql <<< "DROP DATABASE app"')"

# ddev, lando, and wp-env manage a project database and drop it with their own
# verbs, so neither the Docker rules nor the Artisan rules ever see them.
echo "blocks the project tools that destroy their own database:"
check 2 "ddev delete"            "$(bash_json 'ddev delete')"
check 2 "ddev delete a project"  "$(bash_json 'ddev delete -O myproject')"
check 2 "ddev stop --remove-data" "$(bash_json 'ddev stop --remove-data')"
check 2 "lando destroy"          "$(bash_json 'lando destroy')"
check 2 "lando destroy -y"       "$(bash_json 'lando destroy -y')"
check 2 "wp-env destroy"         "$(bash_json 'wp-env destroy')"

echo "allows the project tools' ordinary verbs:"
# `ddev delete images` removes Docker images, not project data.
check 0 "ddev delete images"     "$(bash_json 'ddev delete images')"
check 0 "ddev start"             "$(bash_json 'ddev start')"
check 0 "ddev stop"              "$(bash_json 'ddev stop')"
check 0 "lando start"            "$(bash_json 'lando start')"
check 0 "lando rebuild"          "$(bash_json 'lando rebuild')"
check 0 "wp-env start"           "$(bash_json 'wp-env start')"

# The guard reads the FILE CONTENTS. A name settles nothing: reset.sql is
# destructive here, and seed.sql merely mentions "drop table" in a literal.
echo "blocks SQL that arrives from a file:"
check 2 "psql -f"          "$(cwd_json 'psql -f db/reset.sql' "$SQLDIR")"
check 2 "psql --file="     "$(cwd_json 'psql --file=db/reset.sql' "$SQLDIR")"
check 2 "a redirect"       "$(cwd_json 'psql -d app < db/reset.sql' "$SQLDIR")"
check 2 "mysql redirect"   "$(cwd_json 'mysql app < db/reset.sql' "$SQLDIR")"
check 2 "cat piped in"     "$(cwd_json 'cat db/reset.sql | psql' "$SQLDIR")"
check 2 "an absolute path" "$(cwd_json "psql -f $SQLDIR/db/reset.sql" /nowhere)"
# The cd moves where a relative path resolves, which is the incident's shape.
check 2 "a cd first"       "$(cwd_json 'cd db && psql -f reset.sql' "$SQLDIR")"

echo "allows files whose contents are not destructive:"
check 0 "a seed file"      "$(cwd_json 'psql -f db/seed.sql' "$SQLDIR")"
check 0 "a qualified DELETE file" "$(cwd_json 'psql -f db/prune.sql' "$SQLDIR")"
check 0 "a missing file"   "$(cwd_json 'psql -f db/gone.sql' "$SQLDIR")"
# mysql reads -f as --force. Treating it as a filename would scan the wrong arg.
check 0 "mysql -f is force" "$(cwd_json 'mysql -f app -e "SELECT 1"' "$SQLDIR")"
check 0 "cat without a client" "$(cwd_json 'cat db/reset.sql' "$SQLDIR")"
check 0 "cat piped to grep" "$(cwd_json 'cat db/reset.sql | grep DROP' "$SQLDIR")"
# The remote machine has its own filesystem, so a local file of the same name is
# the wrong file. Reading it could only ever produce a false block.
check 0 "ssh stops the read" "$(cwd_json 'ssh box "psql -f db/reset.sql"' "$SQLDIR")"
# No cwd means no basis for resolving a relative path, so no file is read.
check 0 "no cwd in payload" "$(bash_json 'psql -f db/reset.sql')"
check 0 "an empty cwd"     "$(cwd_json 'psql -f db/reset.sql' '')"

echo "blocks raw SQL delivered by heredoc:"
check 2 "quoted heredoc" "$(bash_json "$(printf 'psql -d app <<%s\nDROP DATABASE app;\nSQL\n' "'SQL'")")"
check 2 "bare heredoc"   "$(bash_json "$(printf 'mysql app <<EOF\nTRUNCATE TABLE verses;\nEOF\n')")"
check 2 "cat heredoc piped in" \
  "$(bash_json "$(printf 'cat <<EOF | psql -d app\nDROP TABLE verses;\nEOF\n')")"

# A prefix permission rule sees the first word and nothing else. Every shape
# below hides the verb behind something, which is why the hook exists.
echo "blocks through compound commands and wrappers, where a prefix rule cannot look:"
check 2 "cd then artisan"        "$(bash_json 'cd /some/repo && php artisan migrate:fresh')"
check 2 "after a semicolon"      "$(bash_json 'echo start; php artisan db:wipe')"
check 2 "on the || arm"          "$(bash_json 'test -f .env || php artisan db:wipe')"
check 2 "sail"                   "$(bash_json 'sail artisan migrate:fresh')"
check 2 "vendor/bin/sail"        "$(bash_json './vendor/bin/sail artisan db:wipe')"
check 2 "docker compose exec"    "$(bash_json 'docker compose exec -T app php artisan db:wipe')"
check 2 "docker compose w/ user" "$(bash_json 'docker compose exec -u www-data app php artisan migrate:fresh')"
check 2 "docker exec"            "$(bash_json 'docker exec -it api php artisan migrate:reset')"
check 2 "ssh"                    "$(bash_json 'ssh deploy@box "php artisan migrate:reset"')"
check 2 "ssh with a port flag"   "$(bash_json 'ssh -p 2222 box "dropdb myapp"')"
check 2 "bash -c"                "$(bash_json 'bash -c "php artisan db:wipe --force"')"
check 2 "sh -c wrapping psql"    "$(bash_json 'sh -c "psql -c \"DROP DATABASE app\""')"
check 2 "an env assignment"      "$(bash_json 'APP_ENV=local php artisan db:wipe')"
check 2 "env with a var"         "$(bash_json 'env APP_ENV=local php artisan migrate:fresh')"
check 2 "kubectl exec"           "$(bash_json 'kubectl exec pod/api -- php artisan db:wipe')"

# The incident was a wrong TARGET, not a wrong verb. Rebuilding the testing
# database is ordinary work, so an explicitly scoped reset is allowed. The hole
# is documented in the checker: --env=testing proves intent, not target.
echo "allows an Artisan reset scoped explicitly to the testing database:"
check 0 "--env=testing"           "$(bash_json 'php artisan migrate:fresh --env=testing')"
check 0 "--env testing"           "$(bash_json 'php artisan migrate:fresh --env testing')"
check 0 "--database=testing"      "$(bash_json 'php artisan migrate:fresh --database=testing')"
check 0 "--database testing"      "$(bash_json 'php artisan db:wipe --database testing')"
check 0 "testing scope with seed" "$(bash_json 'php artisan migrate:fresh --env=testing --seed')"
check 0 "scoped inside sail"      "$(bash_json 'sail artisan migrate:fresh --env=testing')"

# The requirement this suite is weighted towards: a guard that stops code search
# has cost more than it saved. Every case below names a destructive verb and
# none of them touches a database.
echo "allows code search and reading that merely mentions a destructive verb:"
check 0 "grep for drop table"     "$(bash_json 'grep -rn "drop table" app/')"
check 0 "grep for DROP TABLE"     "$(bash_json 'grep -rn "DROP TABLE" database/')"
check 0 "grep for the verb"       "$(bash_json 'grep -rn "migrate:fresh" .github/')"
check 0 "rg for db:wipe"          "$(bash_json 'rg "db:wipe" --glob "*.php"')"
check 0 "cat a drop_ migration"   "$(bash_json 'cat database/migrations/2026_09_04_drop_users_table.php')"
check 0 "ls a drop_ migration"    "$(bash_json 'ls database/migrations/*drop_*')"
check 0 "cd then grep"            "$(bash_json 'cd /some/repo && grep -rn "TRUNCATE TABLE" app/')"
check 0 "echo without a client"   "$(bash_json 'echo "DROP DATABASE app"')"
check 0 "a comment about dropdb"  "$(bash_json 'echo "run dropdb by hand if needed"')"

echo "allows the non-destructive database work an agent does constantly:"
check 0 "plain migrate"           "$(bash_json 'php artisan migrate')"
check 0 "migrate --pretend"       "$(bash_json 'php artisan migrate --pretend')"
check 0 "migrate:status"          "$(bash_json 'php artisan migrate:status')"
check 0 "migrate:rollback"        "$(bash_json 'php artisan migrate:rollback')"
check 0 "artisan test"            "$(bash_json 'php artisan test')"
check 0 "artisan db:seed"         "$(bash_json 'php artisan db:seed')"
check 0 "a qualified DELETE"      "$(bash_json 'psql -c "DELETE FROM verses WHERE id = 1"')"
check 0 "a plain SELECT"          "$(bash_json 'psql -c "SELECT count(*) FROM verses"')"
# A single-quoted SQL literal is data, not a verb.
check 0 "a literal saying drop table" \
  "$(bash_json "psql -c \"SELECT * FROM logs WHERE msg = 'drop table'\"")"
# Double quotes are identifiers, not literals, so this must still block.
check 2 "a double-quoted identifier" \
  "$(bash_json "psql -c 'DROP TABLE \"users\"'")"
check 0 "createdb"                "$(bash_json 'createdb myapp')"
check 0 "an unrelated ssh"        "$(bash_json 'ssh box "php artisan migrate --force"')"
# `drop` here is a table name, not the mysqladmin verb.
check 0 "mysqladmin status"       "$(bash_json 'mysqladmin -u root status')"

echo "allows anything it cannot parse — this hook is not an OS boundary:"
check 0 "malformed json"          'not json at all'
check 0 "empty object"            '{}'
check 0 "an unmatched tool name"  "$(jq -nc '{tool_name: "Read", tool_input: {file_path: "/tmp/x"}}')"
check 0 "an empty command"        "$(bash_json '')"
# An unbalanced quote is shell bash itself would reject. Blocking it would break
# ordinary awk and sed one-liners and stop nothing that could actually run.
check 0 "an unbalanced quote"     "$(bash_json 'grep -rn "unclosed app/')"

echo "explains the block on stderr:"
OUT=$(bash_json 'php artisan db:wipe --database=pgsql --force' | bash "$GUARD" 2>&1)
assert_contains "names the guard"        "$OUT" "destructive-database-guard"
assert_contains "names the verb"         "$OUT" "db:wipe"
assert_contains "explains the target"    "$OUT" "development database"
assert_contains "offers the ! escape"    "$OUT" "! prefix"
OUT=$(bash_json 'psql -c "DROP DATABASE app"' | bash "$GUARD" 2>&1)
assert_contains "names the SQL verb"     "$OUT" "DROP DATABASE"
assert_contains "names the client"       "$OUT" "psql"
OUT=$(bash_json 'dropdb myapp' | bash "$GUARD" 2>&1)
assert_contains "names dropdb"           "$OUT" "dropdb"
OUT=$(bash_json 'docker compose down -v' | bash "$GUARD" 2>&1)
assert_contains "names the volumes flag" "$OUT" "--volumes"
assert_contains "says where data lives"  "$OUT" "named volumes"
OUT=$(cwd_json 'psql -f db/reset.sql' "$SQLDIR" | bash "$GUARD" 2>&1)
assert_contains "names the file"         "$OUT" "db/reset.sql"
# The guard reads the file to decide, not to quote it. A line of SQL in the
# message would put file contents into the transcript.
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
# to do with the plugin, and once by a relative path. Each asserts exit 2.
echo "the shared-parser import survives an arbitrary working directory:"
INCIDENT="$(bash_json 'php artisan db:wipe --database=pgsql --force')"
for DIR in / /tmp "$HOME" "$SQLDIR"; do
  printf '%s' "$INCIDENT" | (cd "$DIR" && bash "$GUARD") >/dev/null 2>&1
  if [ "$?" = "2" ]; then
    PASS=$((PASS + 1)); echo "  ✅ still blocks when invoked from $DIR"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ failed open when invoked from $DIR"
  fi
done
printf '%s' "$INCIDENT" | (cd "$HOOKS_DIR" && bash ./destructive-database-guard.sh) >/dev/null 2>&1
if [ "$?" = "2" ]; then
  PASS=$((PASS + 1)); echo "  ✅ still blocks when invoked by a relative path"
else
  FAIL=$((FAIL + 1)); echo "  ❌ failed open when invoked by a relative path"
fi
# The file-reading path resolves a relative .sql against the payload's cwd, so it
# is the case most likely to be broken by a cwd-sensitive import or lookup.
printf '%s' "$(cwd_json 'psql -f db/reset.sql' "$SQLDIR")" | (cd / && bash "$GUARD") >/dev/null 2>&1
if [ "$?" = "2" ]; then
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
