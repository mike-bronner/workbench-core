#!/bin/bash
# Tests for hooks/lib/memory-install.sh — wheel-keyed venv resolution, the
# blocking install lock, and idle-venv GC.
# Run directly: ./test-memory-install.sh
#
# No network and no real uv: a stub `uv` on a controlled PATH creates the venv
# and its entry point, so every branch is exercised in milliseconds. The PATH is
# built from scratch (not inherited) so a real markdown-vault-mcp on the
# developer's machine can't make the git-fallback path silently succeed.

set -u
LIB="$(cd "$(dirname "$0")" && pwd)/lib/memory-install.sh"
PASS=0
FAIL=0

SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

# ──────────── Controlled PATH with a stub uv ────────────
STUBBIN="$SANDBOX/bin"; mkdir -p "$STUBBIN"
for tool in bash cat chmod cut env find grep head kill ls mkdir rm sh sleep shasum touch basename dirname sed; do
  src=$(command -v "$tool"); [ -n "$src" ] && ln -sf "$src" "$STUBBIN/$tool"
done

cat > "$STUBBIN/uv" <<'UVEOF'
#!/bin/bash
# Stub uv. `venv <dir>` makes the dir; `pip install --python <dir>/bin/python …`
# writes the entry point. UV_FAIL=1 makes `pip install` fail; `tool install`
# (the git fallback) always fails, so fallback never silently rescues a test.
case "$1" in
  venv) mkdir -p "$2/bin"; exit 0 ;;
  pip)
    [ -n "${UV_FAIL:-}" ] && exit 1
    py=""
    while [ $# -gt 0 ]; do
      if [ "$1" = "--python" ]; then py="$2"; break; fi
      shift
    done
    venv="${py%/bin/python}"
    mkdir -p "$venv/bin"
    printf '#!/bin/bash\necho fake-server\n' > "$venv/bin/markdown-vault-mcp"
    chmod +x "$venv/bin/markdown-vault-mcp"
    exit 0 ;;
esac
exit 1
UVEOF
chmod +x "$STUBBIN/uv"

# ──────────── Helpers ────────────
# make_wheels <hooks_dir> <content> — a plugin tree whose wheels/ holds one
# wheel with the given bytes (distinct bytes ⇒ distinct hash ⇒ distinct venv).
make_wheels() {
  local hooks="$1" content="$2"
  mkdir -p "$hooks/wheels"
  rm -f "$hooks"/wheels/*.whl
  printf '%s' "$content" > "$hooks/wheels/markdown_vault_mcp-9.9.9-py3-none-any.whl"
}

# venv_for <hooks_dir> <cache> — the venv path the lib derives for that wheel.
venv_for() {
  env -i PATH="$STUBBIN" HOOKS_DIR="$1" CACHE_PATH="$2" \
    bash -c '. "'"$LIB"'"; memory_venv_path'
}

# run_install <hooks_dir> <cache> [env assignments…] — call memory_install_server
# with a stderr logger, echoing the resolved SERVER_BIN on stdout. Output of
# both streams is captured together by the caller.
run_install() {
  local hooks="$1" cache="$2"; shift 2
  env -i PATH="$STUBBIN" HOOKS_DIR="$hooks" CACHE_PATH="$cache" "$@" \
    bash -c '_log() { echo "log: $*" >&2; }
             . "'"$LIB"'"
             memory_install_server _log
             rc=$?
             echo "SERVER_BIN=${SERVER_BIN:-}"
             exit $rc' 2>&1
}

assert_contains() {
  local desc="$1" output="$2" needle="$3"
  if printf '%s' "$output" | grep -qF "$needle"; then
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  else
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — expected: $needle — got: $output"
  fi
}

assert_not_contains() {
  local desc="$1" output="$2" needle="$3"
  if printf '%s' "$output" | grep -qF "$needle"; then
    FAIL=$((FAIL + 1)); echo "  ❌ $desc — unexpected: $needle — got: $output"
  else
    PASS=$((PASS + 1)); echo "  ✅ $desc"
  fi
}

assert_dir()    { [ -d "$2" ] && { PASS=$((PASS+1)); echo "  ✅ $1"; } || { FAIL=$((FAIL+1)); echo "  ❌ $1 — missing dir: $2"; }; }
assert_no_dir() { [ ! -d "$2" ] && { PASS=$((PASS+1)); echo "  ✅ $1"; } || { FAIL=$((FAIL+1)); echo "  ❌ $1 — dir should be absent: $2"; }; }
assert_file()   { [ -f "$2" ] && { PASS=$((PASS+1)); echo "  ✅ $1"; } || { FAIL=$((FAIL+1)); echo "  ❌ $1 — missing file: $2"; }; }
assert_no_file(){ [ ! -f "$2" ] && { PASS=$((PASS+1)); echo "  ✅ $1"; } || { FAIL=$((FAIL+1)); echo "  ❌ $1 — file should be absent: $2"; }; }
assert_rc()     { [ "$2" -eq "$3" ] && { PASS=$((PASS+1)); echo "  ✅ $1"; } || { FAIL=$((FAIL+1)); echo "  ❌ $1 — rc $2, expected $3"; }; }

# ──────────── Wheel-keyed venv ────────────
echo "wheel-keyed venv: install lands in a hash-named dir and sets SERVER_BIN:"
H="$SANDBOX/p1/hooks"; C="$SANDBOX/c1"; mkdir -p "$C"
make_wheels "$H" "WHEEL-A"
VENV_A="$(venv_for "$H" "$C")"
OUT=$(run_install "$H" "$C")
assert_contains "logs the install"            "$OUT" "installing bundled wheel"
assert_contains "SERVER_BIN inside that venv" "$OUT" "SERVER_BIN=$VENV_A/bin/markdown-vault-mcp"
assert_dir      "venv dir created"            "$VENV_A"
assert_file     "completion marker written"   "$VENV_A/.installed-wheel-hash"
assert_file     "last-used stamped"           "$VENV_A/.last-used"
case "$VENV_A" in
  "$C"/server-venv-*) PASS=$((PASS+1)); echo "  ✅ venv name is hash-keyed ($(basename "$VENV_A"))" ;;
  *) FAIL=$((FAIL+1)); echo "  ❌ venv name not hash-keyed: $VENV_A" ;;
esac

echo "a DIFFERENT wheel gets its own venv and leaves the first untouched:"
MARKER_A_BEFORE=$(cat "$VENV_A/.installed-wheel-hash")
make_wheels "$H" "WHEEL-B-DIFFERENT-BYTES"
VENV_B="$(venv_for "$H" "$C")"
OUT=$(run_install "$H" "$C")
if [ "$VENV_A" != "$VENV_B" ]; then PASS=$((PASS+1)); echo "  ✅ second wheel resolves to a different venv"; else FAIL=$((FAIL+1)); echo "  ❌ both wheels shared one venv: $VENV_A"; fi
assert_dir  "second venv created"                  "$VENV_B"
assert_dir  "first venv still present"             "$VENV_A"
assert_file "first venv's binary intact"           "$VENV_A/bin/markdown-vault-mcp"
if [ "$(cat "$VENV_A/.installed-wheel-hash")" = "$MARKER_A_BEFORE" ]; then
  PASS=$((PASS+1)); echo "  ✅ first venv's marker unchanged by the second install"
else
  FAIL=$((FAIL+1)); echo "  ❌ first venv's marker was rewritten"
fi

# ──────────── Fast path and its fail-closed guards ────────────
echo "fast path: an already-installed venv skips uv entirely (uv would fail):"
OUT=$(run_install "$H" "$C" UV_FAIL=1); RC=$?
assert_rc       "returns 0 without touching uv" "$RC" 0
assert_contains "logs the skip"                 "$OUT" "skipping install"
assert_not_contains "does not reinstall"        "$OUT" "installing bundled wheel"

echo "fast path refreshes .last-used (so an in-rotation venv is never GC'd):"
touch -t 202001010000 "$VENV_B/.last-used"
run_install "$H" "$C" >/dev/null 2>&1
if [ -n "$(find "$VENV_B/.last-used" -maxdepth 0 -mmin -5 2>/dev/null)" ]; then
  PASS=$((PASS+1)); echo "  ✅ .last-used refreshed on the fast path"
else
  FAIL=$((FAIL+1)); echo "  ❌ .last-used not refreshed"
fi

echo "marker present but binary MISSING → reinstalls (fail closed):"
rm -f "$VENV_B/bin/markdown-vault-mcp"
OUT=$(run_install "$H" "$C")
assert_contains "reinstalls when the entry point is gone" "$OUT" "installing bundled wheel"
assert_file     "binary restored" "$VENV_B/bin/markdown-vault-mcp"

echo "marker WRONG but binary present → reinstalls (fail closed):"
echo "not-the-right-hash" > "$VENV_B/.installed-wheel-hash"
OUT=$(run_install "$H" "$C")
assert_contains "reinstalls on marker mismatch" "$OUT" "installing bundled wheel"

echo "install failure → no completion marker, non-zero rc:"
H2="$SANDBOX/p2/hooks"; C2="$SANDBOX/c2"; mkdir -p "$C2"
make_wheels "$H2" "WHEEL-FAILS"
VENV_F="$(venv_for "$H2" "$C2")"
OUT=$(run_install "$H2" "$C2" UV_FAIL=1); RC=$?
assert_rc      "non-zero when the install fails"      "$RC" 1
assert_no_file "marker absent after a failed install" "$VENV_F/.installed-wheel-hash"
assert_no_dir  "lock released after a failed install" "${VENV_F}.lock"

# ──────────── The install lock ────────────
echo "lock: released after a successful install:"
assert_no_dir "no lock dir left behind" "${VENV_A}.lock"

echo "lock: held by a LIVE pid + 0s timeout → gives up, installs nothing:"
H3="$SANDBOX/p3/hooks"; C3="$SANDBOX/c3"; mkdir -p "$C3"
make_wheels "$H3" "WHEEL-LOCKED"
VENV_L="$(venv_for "$H3" "$C3")"
mkdir -p "${VENV_L}.lock"
sleep 60 & HOLDER=$!
disown 2>/dev/null || true
echo "$HOLDER" > "${VENV_L}.lock/pid"
OUT=$(run_install "$H3" "$C3" WORKBENCH_MEMORY_INSTALL_LOCK_TIMEOUT=0); RC=$?
assert_rc           "non-zero when the lock is held"   "$RC" 1
assert_contains     "logs the give-up"                 "$OUT" "still held after 0s"
assert_not_contains "does not install under the lock"  "$OUT" "installing bundled wheel"
assert_no_dir       "no venv created"                  "$VENV_L"
assert_file         "live holder's lock left intact"   "${VENV_L}.lock/pid"
kill "$HOLDER" 2>/dev/null

echo "lock: STALE lock (dead pid) → stolen, install proceeds even at 0s timeout:"
sh -c 'exit 0' & DEAD=$!; wait "$DEAD" 2>/dev/null
echo "$DEAD" > "${VENV_L}.lock/pid"
OUT=$(run_install "$H3" "$C3" WORKBENCH_MEMORY_INSTALL_LOCK_TIMEOUT=0); RC=$?
assert_rc       "succeeds after stealing a dead lock" "$RC" 0
assert_contains "logs the steal"                      "$OUT" "stealing stale lock"
assert_contains "installs after the steal"            "$OUT" "installing bundled wheel"
assert_no_dir   "lock released after the stolen run"  "${VENV_L}.lock"

echo "lock: a waiter BLOCKS, then finds the work done and skips installing:"
# The real concurrency case: the venv does not exist, so the fast path can't
# short-circuit; a live holder owns the lock and completes the install while we
# wait. UV_FAIL makes any install attempt by the waiter a loud failure, so the
# only way this passes is the re-check under the lock.
H4="$SANDBOX/p4/hooks"; C4="$SANDBOX/c4"; mkdir -p "$C4"
make_wheels "$H4" "WHEEL-WAITER"
VENV_W="$(venv_for "$H4" "$C4")"
WHEEL_HASH=$(shasum -a 256 "$H4"/wheels/*.whl | cut -d' ' -f1)
mkdir -p "${VENV_W}.lock"
sleep 30 & KEEPALIVE=$!                  # a guaranteed-live holder pid
disown 2>/dev/null || true
echo "$KEEPALIVE" > "${VENV_W}.lock/pid"
(
  sleep 2
  mkdir -p "$VENV_W/bin"
  printf '#!/bin/bash\necho fake-server\n' > "$VENV_W/bin/markdown-vault-mcp"
  chmod +x "$VENV_W/bin/markdown-vault-mcp"
  echo "$WHEEL_HASH" > "$VENV_W/.installed-wheel-hash"
  rm -rf "${VENV_W}.lock"
) & INSTALLER=$!
OUT=$(run_install "$H4" "$C4" UV_FAIL=1 WORKBENCH_MEMORY_INSTALL_LOCK_TIMEOUT=30); RC=$?
wait "$INSTALLER" 2>/dev/null          # the holder is done; don't race the sandbox teardown
kill "$KEEPALIVE" 2>/dev/null
assert_rc           "succeeds via the under-lock re-check" "$RC" 0
assert_contains     "logs the re-check skip"               "$OUT" "installed while we waited"
assert_not_contains "does not reinstall"                   "$OUT" "installing bundled wheel"
assert_contains     "resolves the binary the holder built" "$OUT" "SERVER_BIN=$VENV_W/bin/markdown-vault-mcp"
assert_no_dir       "lock released by the waiter too"      "${VENV_W}.lock"

# ──────────── Idle-venv GC ────────────
echo "GC: an idle venv is reclaimed; fresh and current ones are kept:"
H5="$SANDBOX/p5/hooks"; C5="$SANDBOX/c5"; mkdir -p "$C5"
IDLE="$C5/server-venv-000000000000";  mkdir -p "$IDLE/bin";  touch -t 202001010000 "$IDLE/.last-used"
FRESH="$C5/server-venv-111111111111"; mkdir -p "$FRESH/bin"; touch "$FRESH/.last-used"
NOSTAMP="$C5/server-venv-222222222222"; mkdir -p "$NOSTAMP/bin"; touch -t 202001010000 "$NOSTAMP"
mkdir -p "$C5/server-venv-333333333333.lock"     # a lock dir, not a venv
make_wheels "$H5" "WHEEL-GC"
VENV_G="$(venv_for "$H5" "$C5")"
OUT=$(run_install "$H5" "$C5" WORKBENCH_MEMORY_VENV_GC_IDLE_DAYS=1)
assert_no_dir   "idle venv reclaimed"                    "$IDLE"
assert_no_dir   "stampless idle venv reclaimed by mtime" "$NOSTAMP"
assert_dir      "fresh venv kept"                        "$FRESH"
assert_dir      "current venv kept"                      "$VENV_G"
assert_dir      "a .lock dir is not mistaken for a venv" "$C5/server-venv-333333333333.lock"
assert_contains "logs what it reclaimed"                 "$OUT" "reclaiming venv unused"

echo "GC: a venv whose install lock is held is never reclaimed:"
H6="$SANDBOX/p6/hooks"; C6="$SANDBOX/c6"; mkdir -p "$C6"
BUSY="$C6/server-venv-444444444444"; mkdir -p "$BUSY/bin"; touch -t 202001010000 "$BUSY/.last-used"
mkdir -p "${BUSY}.lock"
make_wheels "$H6" "WHEEL-GC2"
run_install "$H6" "$C6" WORKBENCH_MEMORY_VENV_GC_IDLE_DAYS=1 >/dev/null 2>&1
assert_dir "locked venv survives GC" "$BUSY"

echo "GC: idle-days 0 disables the sweep:"
H7="$SANDBOX/p7/hooks"; C7="$SANDBOX/c7"; mkdir -p "$C7"
OLD="$C7/server-venv-555555555555"; mkdir -p "$OLD/bin"; touch -t 202001010000 "$OLD/.last-used"
make_wheels "$H7" "WHEEL-GC3"
run_install "$H7" "$C7" WORKBENCH_MEMORY_VENV_GC_IDLE_DAYS=0 >/dev/null 2>&1
assert_dir "sweep disabled leaves the idle venv" "$OLD"

# ──────────── Path reporting + legacy fallback ────────────
echo "memory_venv_path: agrees with the installer, fails without a wheel:"
H8="$SANDBOX/p8/hooks"; C8="$SANDBOX/c8"; mkdir -p "$C8" "$H8/wheels"
OUT=$(venv_for "$H8" "$C8"); RC=$?
assert_rc "non-zero when no wheel ships" "$RC" 1
if [ -z "$OUT" ]; then PASS=$((PASS+1)); echo "  ✅ echoes nothing when no wheel ships"; else FAIL=$((FAIL+1)); echo "  ❌ echoed '$OUT'"; fi

echo "no bundled wheel → legacy git/pipx fallback (which fails here, closed):"
OUT=$(run_install "$H8" "$C8"); RC=$?
assert_rc       "non-zero when nothing can be resolved" "$RC" 1
assert_contains "logs the git fallback"                 "$OUT" "falling back to git install"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
