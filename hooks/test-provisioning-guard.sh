#!/bin/bash
# Tests for hooks/provisioning-guard.sh — the PreToolUse provisioning guard.
# Run directly: ./test-provisioning-guard.sh
# Each case feeds the hook one PreToolUse payload on stdin and asserts its
# VERDICT: deny (the call is refused) or allow (nothing is printed, so the normal
# permission flow applies). Pure stdin/stdout checks — no network, no server, no
# repository is touched, and nothing is created or deleted.
#
# The verdict is read out of the hook's JSON, never out of an exit code. The
# guard used to block by exiting 2, which prefixed the model's message with the
# guard's own absolute filesystem path and threw stdout away; it now returns
# permissionDecision "deny" on exit 0, which refuses the call just as hard and
# leaves the author in control of the first line a person reads.
#
# The suite is weighted towards the ALLOW cases on purpose, on three axes. A
# guard that stops `git worktree list` has broken the only way to see the trees
# it protects. A guard that stops `grep -rn "createdb"` has made code search
# impossible, and a guard people turn off is worse than no guard. And a guard
# that stops `docker compose up` or a migration writing database.sqlite has
# broken the environment an agent is supposed to work inside, which is the whole
# thing this guard exists to keep it in.

set -u
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
GUARD="$HOOKS_DIR/provisioning-guard.sh"
HOOKS_JSON="$HOOKS_DIR/hooks.json"
README="$HOOKS_DIR/../README.md"
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

assert_grep() {
  local desc="$1" needle="$2" file="$3"
  if grep -qF -- "$needle" "$file" 2>/dev/null; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — not found in $file: $needle"
  fi
}

bash_json() { jq -nc --arg c "$1" '{tool_name: "Bash", tool_input: {command: $c}}'; }
# The non-Bash surfaces. tool_input arrives as JSON so a case can omit a field
# entirely, which is a state under test: an Agent dispatch with no `isolation`
# key at all is the ordinary dispatch and must pass.
tool_json() {
  jq -nc --arg t "$1" --argjson i "$2" '{tool_name: $t, tool_input: $i}'
}

# ───────────────────────────────────────────────────────────── worktrees, Bash

echo "blocks a worktree being created, through every shape a prefix rule misses:"
check deny "the plain form"        "$(bash_json 'git worktree add ../feat')"
check deny "with a branch flag"    "$(bash_json 'git worktree add -b feat ../feat')"
check deny "cd then git"           "$(bash_json 'cd /repo && git worktree add x')"
check deny "git -C"                "$(bash_json 'git -C /repo worktree add x')"
check deny "two composed -C flags" "$(bash_json 'git -C /repo -C sub worktree add x')"
check deny "--git-dir before it"   "$(bash_json 'git --git-dir=/repo/.git worktree add x')"
check deny "-c config before it"   "$(bash_json 'git -c user.name=x worktree add y')"
check deny "--no-pager before it"  "$(bash_json 'git --no-pager worktree add x')"
check deny "an absolute git path"  "$(bash_json '/usr/bin/git worktree add x')"
check deny "sudo"                  "$(bash_json 'sudo git worktree add x')"
check deny "nice"                  "$(bash_json 'nice git worktree add x')"
check deny "an env assignment"     "$(bash_json 'GIT_DIR=/repo/.git git worktree add x')"
check deny "env with a var"        "$(bash_json 'env GIT_PAGER=cat git worktree add x')"
check deny "after a semicolon"     "$(bash_json 'echo start; git worktree add x')"
check deny "on the && arm"         "$(bash_json 'true && git worktree add x')"
check deny "on the || arm"         "$(bash_json 'test -d x || git worktree add x')"
check deny "a later pipeline stage" "$(bash_json 'echo x | git worktree add y')"
check deny "bash -c"               "$(bash_json 'bash -c "cd /repo && git worktree add x"')"
check deny "sh -c"                 "$(bash_json 'sh -c "git worktree add x"')"
check deny "ssh"                   "$(bash_json 'ssh box "git worktree add x"')"
check deny "ssh with a port flag"  "$(bash_json 'ssh -p 2222 box "git worktree add x"')"
check deny "ssh, unquoted command" "$(bash_json 'ssh box git worktree add x')"
check deny "docker exec"           "$(bash_json 'docker exec -it api git worktree add x')"
check deny "docker compose exec"   "$(bash_json 'docker compose exec app git worktree add x')"
check deny "kubectl exec"          "$(bash_json 'kubectl exec pod/api -- git worktree add x')"
check deny "a second line"         "$(bash_json 'cd /repo
git worktree add x')"

# The destructive half, and the one with the larger blast radius: these trees
# were set up by hand, so deleting one destroys work rather than leaving litter.
echo "blocks a worktree being destroyed:"
check deny "git worktree remove"    "$(bash_json 'git worktree remove ../feat')"
check deny "remove --force"         "$(bash_json 'git worktree remove --force ../feat')"
check deny "git worktree prune"     "$(bash_json 'git worktree prune')"
check deny "prune with --dry-run"   "$(bash_json 'git worktree prune --dry-run')"
check deny "remove via -C"          "$(bash_json 'git -C /repo worktree remove x')"
check deny "prune after a cd"       "$(bash_json 'cd /repo && git worktree prune')"

# ───────────────────────────────────────────────────────────── databases, Bash

echo "blocks a database being created by its own binary:"
check deny "createdb"               "$(bash_json 'createdb app')"
check deny "createdb with flags"    "$(bash_json 'createdb -O mike -E UTF8 app')"
check deny "createuser"             "$(bash_json 'createuser app')"
check deny "an absolute path"       "$(bash_json '/opt/homebrew/bin/createdb app')"
check deny "mysqladmin create"      "$(bash_json 'mysqladmin create app')"
# The flag form is exactly what a `Bash(mysqladmin create:*)` prefix rule misses,
# and it is the argument for reading the verb SLOT rather than the first words.
check deny "mysqladmin, flags first" "$(bash_json 'mysqladmin -u root -p create app')"
check deny "createdb after a cd"    "$(bash_json 'cd /repo && createdb app')"
check deny "createdb through sail"  "$(bash_json 'sail createdb app')"
check deny "through docker exec"    "$(bash_json 'docker compose exec db createdb app')"
check deny "through ssh"            "$(bash_json 'ssh box "createdb app"')"
check deny "through bash -c"        "$(bash_json 'bash -c "createdb app"')"

echo "blocks a database being created from a SQL client payload:"
check deny "psql -c"                "$(bash_json 'psql -c "CREATE DATABASE app"')"
check deny "psql --command="        "$(bash_json 'psql --command="CREATE DATABASE app"')"
check deny "lowercase sql"          "$(bash_json 'psql -c "create database app"')"
check deny "mysql -e"               "$(bash_json 'mysql -e "CREATE DATABASE app"')"
check deny "mariadb -e"             "$(bash_json 'mariadb -e "CREATE DATABASE app"')"
check deny "CREATE SCHEMA"          "$(bash_json 'psql -d app -c "CREATE SCHEMA reporting"')"
check deny "a quoted identifier"    "$(bash_json 'psql -c "CREATE DATABASE \"app\""')"
check deny "the second statement"   "$(bash_json 'psql -c "SELECT 1; CREATE DATABASE app"')"
check deny "echo piped into psql"   "$(bash_json 'echo "CREATE DATABASE app" | psql')"
check deny "a herestring"           "$(bash_json 'psql <<< "CREATE DATABASE app"')"
check deny "psql through ssh"       "$(bash_json 'ssh box "psql -c \"CREATE DATABASE app\""')"
check deny "a heredoc body" "$(bash_json 'psql -d postgres <<SQL
CREATE DATABASE app;
SQL')"
check deny "a quoted heredoc body" "$(bash_json "psql -d postgres <<'SQL'
CREATE DATABASE app;
SQL")"
check deny "a double-quoted delimiter" "$(bash_json 'psql -d postgres <<"SQL"
CREATE DATABASE app;
SQL')"
# The tab-stripping form hides the delimiter behind a dash the heredoc table
# never stored, and the dash binds two different ways. Both are valid bash,
# verified by running them, so both need a fixture: `<<-SQL` tokenises as
# ['<<', '-SQL'] and `<<- SQL` as ['<<', '-', 'SQL']. The second is the one a
# bare lstrip("-") still misses. The identical gap in the destructive database
# guard let a DROP DATABASE through, and is fixed in the same commit.
check deny "a dash-stripped heredoc" "$(bash_json 'psql -d postgres <<-SQL
	CREATE DATABASE app;
	SQL')"
check deny "a dash-quoted heredoc" "$(bash_json "psql -d postgres <<-'SQL'
	CREATE DATABASE app;
	SQL")"
check deny "a spaced dash heredoc" "$(bash_json 'psql -d postgres <<- SQL
	CREATE DATABASE app;
	SQL')"
check deny "a spaced delimiter" "$(bash_json 'psql -d postgres << SQL
CREATE DATABASE app;
SQL')"
# The allow side of the same shape, so the fix has not simply moved the failure.
check allow "a dash heredoc that only reads" "$(bash_json 'psql -d postgres <<-SQL
	SELECT datname FROM pg_database;
	SQL')"

# A heredoc body belongs to the stage that redirects it, and to no other. This
# command writes a setup file and separately runs a read, which is ordinary
# work. Sweeping every heredoc body in the command whenever a client stands
# anywhere in it blocks this, and that is a false block on a fail-open guard.
echo "does not attribute an unrelated heredoc body to a client standing nearby:"
check allow "a setup file beside a read" "$(bash_json 'cat > setup.sql <<EOF
CREATE DATABASE app;
EOF
psql -c "SELECT 1"')"
check allow "a heredoc with no client at all" "$(bash_json 'cat > setup.sql <<EOF
CREATE DATABASE app;
EOF')"

# ─────────────────────────────────────────────────────── the non-Bash surfaces

# Two of the four paths an agent has are not shell commands at all, which is the
# half of this that no permission rule could ever have reached.
echo "blocks the harness tools that provision or destroy a worktree:"
check deny "EnterWorktree, no args"  "$(tool_json EnterWorktree '{}')"
check deny "EnterWorktree by name"   "$(tool_json EnterWorktree '{"name":"feat"}')"
check deny "EnterWorktree by path"   "$(tool_json EnterWorktree '{"path":".claude/worktrees/x"}')"
check deny "ExitWorktree remove"     "$(tool_json ExitWorktree '{"action":"remove"}')"
check deny "remove, discarding"      "$(tool_json ExitWorktree '{"action":"remove","discard_changes":true}')"

echo "blocks an Agent dispatch that makes the harness provision a worktree:"
check deny "isolation worktree"      "$(tool_json Agent '{"isolation":"worktree","prompt":"x"}')"
check deny "with a subagent_type"    "$(tool_json Agent '{"subagent_type":"Explore","isolation":"worktree","prompt":"x"}')"

# The other half of each tool has to keep working, or the guard traps the agent
# in a state it cannot leave.
echo "allows the harness tools in their non-provisioning form:"
check allow "ExitWorktree keep"       "$(tool_json ExitWorktree '{"action":"keep"}')"
check allow "ExitWorktree, no action" "$(tool_json ExitWorktree '{}')"
check allow "an ordinary Agent"       "$(tool_json Agent '{"prompt":"x","subagent_type":"Explore"}')"
check allow "Agent with a cwd"        "$(tool_json Agent '{"prompt":"x","cwd":"/repo"}')"
# "remote" launches a cloud environment rather than a worktree on this machine,
# and is outside this guard's scope by the same reasoning that leaves container
# startup alone.
check allow "Agent isolation remote"  "$(tool_json Agent '{"prompt":"x","isolation":"remote"}')"
check allow "Agent isolation none"    "$(tool_json Agent '{"prompt":"x","isolation":"none"}')"

# ───────────────────────────────────────────── THE PRIORITY: read-only survives

echo "allows every read-only way of inspecting a worktree:"
check allow "git worktree list"       "$(bash_json 'git worktree list')"
check allow "list --porcelain"        "$(bash_json 'git worktree list --porcelain')"
check allow "list via -C"             "$(bash_json 'git -C /repo worktree list')"
check allow "list after a cd"         "$(bash_json 'cd /repo && git worktree list')"
check allow "bare git worktree"       "$(bash_json 'git worktree')"
check allow "git worktree -h"         "$(bash_json 'git worktree -h')"
check allow "git worktree lock"       "$(bash_json 'git worktree lock ../feat')"
check allow "git worktree unlock"     "$(bash_json 'git worktree unlock ../feat')"
check allow "git worktree repair"     "$(bash_json 'git worktree repair')"
check allow "git worktree move"       "$(bash_json 'git worktree move ../a ../b')"

echo "allows ordinary git, including the write verbs this guard has no opinion on:"
for VERB in status log show diff add commit push pull branch checkout switch; do
  check allow "git $VERB" "$(bash_json "git $VERB")"
done
check allow "git commit with a msg"   "$(bash_json 'git commit -m "feat: add worktree docs"')"
check allow "git log --grep"          "$(bash_json 'git log --grep="worktree add"')"
check allow "git branch -d"           "$(bash_json 'git branch -d feature/worktree')"

echo "allows every read-only way of inspecting a database:"
check allow "psql -c SELECT"          "$(bash_json 'psql -c "SELECT * FROM users"')"
check allow "psql \\l"                "$(bash_json 'psql -c "\l"')"
check allow "psql, a database name"   "$(bash_json 'psql app')"
check allow "mysql -e SELECT"         "$(bash_json 'mysql -e "SELECT 1"')"
check allow "mysql SHOW DATABASES"    "$(bash_json 'mysql -e "SHOW DATABASES"')"
check allow "mysqladmin status"       "$(bash_json 'mysqladmin status')"
check allow "mysqladmin ping"         "$(bash_json 'mysqladmin ping')"
check allow "mysqladmin variables"    "$(bash_json 'mysqladmin -u root variables')"
check allow "pg_dump"                 "$(bash_json 'pg_dump app > /tmp/app.sql')"
# A literal is data, not a verb. Without literal stripping this SELECT blocks.
check allow "a SELECT over the words" \
  "$(bash_json "psql -c \"SELECT * FROM audit WHERE msg = 'create database app'\"")"
check allow "CREATE TABLE"            "$(bash_json 'psql -c "CREATE TABLE users (id int)"')"
check allow "CREATE INDEX"            "$(bash_json 'psql -c "CREATE INDEX ON users (id)"')"
check allow "CREATE EXTENSION"        "$(bash_json 'psql -c "CREATE EXTENSION postgis"')"

# ─────────────────────────────────────────────── the two deliberate exclusions

# A Laravel migration creates database/database.sqlite implicitly. Blocking that
# breaks ordinary test runs and protects nothing: a stray .sqlite file is
# deleted with rm. The exclusion is structural — sqlite3 is not a SQL client
# this guard reads — so these cases pin the structure, not a special case.
echo "allows SQLite file creation, which is the first deliberate exclusion:"
check allow "touch the file"          "$(bash_json 'touch database/database.sqlite')"
check allow "sqlite3 CREATE TABLE"    "$(bash_json 'sqlite3 database/database.sqlite "CREATE TABLE users (id int)"')"
check allow "sqlite3 with -cmd"       "$(bash_json 'sqlite3 app.sqlite ".tables"')"
# The fixture shaped to violate the boundary rather than to be realistic.
# SQLite has no CREATE DATABASE, so nobody types this, and that is exactly the
# problem: every realistic sqlite command is allowed by the CREATE TABLE rule
# too, so none of them can tell the exclusion apart from the rest of the guard.
# This one can. It feeds matching SQL through a pipe, which is the path
# sql_payloads actually reads, so it reddens the moment sqlite3 is added to the
# SQL client list. The first draft passed the SQL as a POSITIONAL argument and
# survived that mutation, because positionals are deliberately never read.
check allow "sqlite3 fed the matching SQL" \
  "$(bash_json 'echo "CREATE DATABASE other" | sqlite3 app.sqlite')"
check allow "php artisan migrate"     "$(bash_json 'php artisan migrate')"
check allow "migrate --seed"          "$(bash_json 'php artisan migrate --seed')"
check allow "the test suite"          "$(bash_json 'php artisan test')"
check allow "pest"                    "$(bash_json './vendor/bin/pest')"

# First run of a stack provisions a database volume, and it is also exactly how
# an agent starts the environment it is meant to work inside. Blocking it
# defeats the purpose of the guard.
echo "allows container and project stack startup, the second deliberate exclusion:"
check allow "docker compose up"       "$(bash_json 'docker compose up -d')"
check allow "docker-compose up"       "$(bash_json 'docker-compose up -d')"
check allow "docker compose create"   "$(bash_json 'docker compose create')"
check allow "docker run postgres"     "$(bash_json 'docker run -d --name pg postgres:16')"
check allow "docker volume create"    "$(bash_json 'docker volume create pgdata')"
check allow "docker network create"   "$(bash_json 'docker network create app-net')"
check allow "podman compose up"       "$(bash_json 'podman-compose up -d')"
check allow "sail up"                 "$(bash_json 'sail up -d')"
check allow "ddev start"              "$(bash_json 'ddev start')"
check allow "lando start"             "$(bash_json 'lando start')"
check allow "wp-env start"            "$(bash_json 'wp-env start')"

# This guard adds no Artisan rule, deliberately: hooks/lib/destructive-db-check.py
# owns the four reset verbs, its exemptions encode a data-loss incident, and a
# second opinion here would be a second place for them to drift.
echo "leaves the destructive database guard's territory entirely alone:"
for VERB in db:wipe migrate:fresh migrate:reset migrate:refresh; do
  check allow "php artisan $VERB" "$(bash_json "php artisan $VERB")"
done
check allow "dropdb"                  "$(bash_json 'dropdb app')"
check allow "DROP DATABASE"           "$(bash_json 'psql -c "DROP DATABASE app"')"
check allow "docker compose down -v"  "$(bash_json 'docker compose down -v')"

# ─────────────────────────────────────────────────── code search and ordinary work

# Naming a creation verb is not running it. A guard that stops code search gets
# turned off, which is a worse outcome than not having one.
echo "allows code search and prose that merely mention a creation verb:"
check allow "grep for worktree add"   "$(bash_json 'grep -rn "git worktree add" hooks/')"
check allow "grep for createdb"       "$(bash_json 'grep -rn createdb .')"
check allow "rg for CREATE DATABASE"  "$(bash_json 'rg "CREATE DATABASE" --glob "*.sql"')"
check allow "rg for worktree"         "$(bash_json 'rg -n "worktree" hooks/')"
check allow "echo about createdb"     "$(bash_json 'echo "never run createdb yourself"')"
check allow "echo about worktrees"    "$(bash_json 'echo "CREATE DATABASE is blocked"')"
check allow "cat a file so named"     "$(bash_json 'cat docs/create-database.md')"
check allow "ls the worktree dir"     "$(bash_json 'ls -la .claude/worktrees')"
check allow "a migration filename"    "$(bash_json 'cat database/migrations/2026_09_17_create_users_table.php')"
check allow "git log -S"              "$(bash_json 'git log -S createdb --oneline')"
check allow "an unrelated command"    "$(bash_json 'npm run build')"
check allow "a create in another tool" "$(bash_json 'gh issue create --title "worktree guard"')"
check allow "mkdir"                   "$(bash_json 'mkdir -p /tmp/worktree-notes')"

echo "allows anything it cannot parse or does not recognise — this is not an OS boundary:"
check allow "malformed json"           'not json at all'
check allow "empty object"             '{}'
check allow "an unmatched tool name"   "$(jq -nc '{tool_name: "Read", tool_input: {file_path: "/tmp/x"}}')"
check allow "an empty command"         "$(bash_json '')"
check allow "a Bash call with no input" "$(jq -nc '{tool_name: "Bash"}')"
# An unbalanced quote is shell bash itself would reject. Blocking it would break
# ordinary one-liners and stop nothing that could actually run.
check allow "an unbalanced quote"      "$(bash_json 'git worktree add "unclosed')"

# ───────────────────────────────────────────────────────────── the messages

# The refusal is split across the hook's two channels. The human line is ONE
# line naming the ACTION, and all four surfaces get their own action word —
# creating, deleting, and dispatching are three different things a person did,
# and the whole point of the split is that they can tell which.
echo "the human line names the action, in one line, on every surface:"
assert_action() { # assert_action <desc> <payload> <expected-lead>
  local reason
  reason=$(reason_of "$(printf '%s' "$2" | bash "$GUARD" 2>/dev/null)")
  assert_contains "$1" "$reason" "$3"
  if [ "$(printf '%s' "$reason" | wc -l | tr -d ' ')" = "0" ] && [ "${#reason}" -le 120 ]; then
    PASS=$((PASS + 1)); echo "  ✅ ...in one short line (${#reason} chars)"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ ...grew past one short line (${#reason} chars)"
  fi
  if printf '%s' "$reason" | grep -qF -- "**"; then
    FAIL=$((FAIL + 1)); echo "  ❌ ...with Markdown emphasis in it"
  else
    PASS=$((PASS + 1)); echo "  ✅ ...with no Markdown emphasis"
  fi
}
assert_action "a worktree being created" "$(bash_json 'git worktree add ../feat')" \
  "🛑 Blocked: creating a git worktree."
assert_action "a worktree being destroyed" "$(bash_json 'git worktree remove ../feat')" \
  "🛑 Blocked: deleting a git worktree."
assert_action "a database being created" "$(bash_json 'createdb app')" \
  "🛑 Blocked: creating a PostgreSQL database."
assert_action "the EnterWorktree tool" "$(tool_json EnterWorktree '{"name":"feat"}')" \
  "🛑 Blocked: creating a git worktree."
assert_action "ExitWorktree with remove" "$(tool_json ExitWorktree '{"action":"remove"}')" \
  "🛑 Blocked: deleting this session's worktree."
assert_action "an isolated Agent dispatch" "$(tool_json Agent '{"isolation":"worktree","prompt":"x"}')" \
  "🛑 Blocked: dispatching a sub-agent into its own worktree."

echo "the detail the model needs survives, in additionalContext, per surface:"
OUT=$(context_of "$(bash_json 'git worktree add ../feat' | bash "$GUARD" 2>/dev/null)")
assert_contains "names the guard"        "$OUT" "Provisioning guard"
assert_contains "names the verb"         "$OUT" "git worktree add"
assert_contains "offers the ! prefix"    "$OUT" "! prefix"
assert_contains "says reads still work"  "$OUT" "git worktree list"

OUT=$(context_of "$(bash_json 'createdb app' | bash "$GUARD" 2>/dev/null)")
assert_contains "names createdb"         "$OUT" "\`createdb\`"
assert_contains "says nothing cleans up" "$OUT" "nothing will clean up"

OUT=$(context_of "$(bash_json 'git worktree remove ../feat' | bash "$GUARD" 2>/dev/null)")
assert_contains "names the deletion"     "$OUT" "git worktree remove"
assert_contains "says they were by hand" "$OUT" "set up by hand"

OUT=$(tool_json EnterWorktree '{"name":"feat"}' | bash "$GUARD" 2>/dev/null)
assert_contains "names EnterWorktree"    "$(context_of "$OUT")" "EnterWorktree"
# The one clause a person acts on stays in the human line, where they see it.
assert_contains "points at the cwd"      "$(reason_of "$OUT")" "Work in the directory you were given"

OUT=$(context_of "$(tool_json ExitWorktree '{"action":"remove"}' | bash "$GUARD" 2>/dev/null)")
assert_contains "names the remove action" "$OUT" "action \"remove\""
assert_contains "offers the keep action"  "$OUT" "action \"keep\""

OUT=$(context_of "$(tool_json Agent '{"isolation":"worktree","prompt":"x"}' | bash "$GUARD" 2>/dev/null)")
assert_contains "names the isolation"    "$OUT" "isolation: \"worktree\""
assert_contains "offers cwd instead"     "$OUT" "pass cwd"

# ─────────────────────────────────────────────────────────────── the plumbing

# The shared parser is imported by path relative to the CHECKER's own file, not
# to the working directory. A PreToolUse hook runs with whatever cwd the tool
# call had, so an import resolved from the cwd would fail everywhere but here —
# and it would fail SILENTLY, because this guard fails open.
echo "the shared-parser import survives an arbitrary working directory:"
BLOCKED="$(bash_json 'git worktree add ../feat')"
for DIR in / /tmp "$HOME"; do
  OUT=$(printf '%s' "$BLOCKED" | (cd "$DIR" && bash "$GUARD") 2>/dev/null)
  if [ "$(verdict_of "$OUT")" = "deny" ]; then
    PASS=$((PASS + 1)); echo "  ✅ still blocks when invoked from $DIR"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ failed open when invoked from $DIR"
  fi
done
OUT=$(printf '%s' "$BLOCKED" | (cd "$HOOKS_DIR" && bash ./provisioning-guard.sh) 2>/dev/null)
if [ "$(verdict_of "$OUT")" = "deny" ]; then
  PASS=$((PASS + 1)); echo "  ✅ still blocks when invoked by a relative path"
else
  FAIL=$((FAIL + 1)); echo "  ❌ failed open when invoked by a relative path"
fi

# A guard nothing calls guards nothing, so registration is part of the behaviour.
# All four surfaces have to be in the matcher: a matcher that lost EnterWorktree
# would leave that tool unguarded and no test above would notice.
echo "the hook is registered in hooks.json, on all four surfaces:"
assert_jq "matcher covers all four" "$HOOKS_JSON" \
  '[.hooks.PreToolUse[] | select(.hooks[].command | test("provisioning-guard.sh")) | .matcher] | join(",")' \
  "Bash|Agent|EnterWorktree|ExitWorktree"
assert_jq "registered exactly once" "$HOOKS_JSON" \
  '[.hooks.PreToolUse[].hooks[] | select(.command | test("provisioning-guard.sh"))] | length' "1"
assert_jq "no if condition narrows it" "$HOOKS_JSON" \
  '[.hooks.PreToolUse[] | select(.hooks[].command | test("provisioning-guard.sh")) | .if // empty] | length' "0"

# A rule with no reasoning attached gets relaxed later, so the README carries
# the argument and this suite holds it there.
echo "the README documents the guard alongside its siblings:"
assert_grep "names the script"         'hooks/provisioning-guard.sh' "$README"
assert_grep "names the checker"        'hooks/lib/provisioning-check.py' "$README"
assert_grep "names the test suite"     'hooks/test-provisioning-guard.sh' "$README"
assert_grep "documents EnterWorktree"  'EnterWorktree' "$README"
assert_grep "documents the Agent path" 'isolation: "worktree"' "$README"
assert_grep "documents the SQLite exclusion" 'database/database.sqlite' "$README"
assert_grep "documents stack startup"  'docker compose up' "$README"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
