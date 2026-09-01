#!/usr/bin/env bash
#
# memory-install: resolve (and if needed install) the markdown-vault-mcp server
# binary, shared by the stdio launcher (mcp-memory.sh), the lazy-start HTTP
# supervisor (memory-server-spawn.sh), and the per-prompt recall hook
# (memory-recall.sh).
#
# Sourceable and side-effect-free: sourcing only DEFINES functions. Call
# memory_install_server to do the work; on success it sets SERVER_BIN (a path
# the caller can exec / nohup) and returns 0; on unrecoverable failure it
# returns non-zero and the caller decides what to do (the stdio launcher exits,
# the supervisor records .server-failed, the recall hook no-ops).
#
# Why this is shared: Claude Code plugins have no dependency-install lifecycle,
# so the plugin installs its own server. The bundled wheel under hooks/wheels/
# travels with the plugin; we install it into a persistent venv kept under
# CACHE_PATH (outside the plugin tree, so it survives plugin updates, and a
# plugin update shipping a new wheel auto-upgrades the server). All three
# callers need exactly this resolution — only the launch differs (stdio
# `exec serve` vs HTTP `nohup serve --transport http …` vs a one-shot search),
# which stays in each caller.
#
# ── Why the venv is keyed by wheel hash, and why the install takes a lock ────
# Sessions are per-process and start whenever the user starts them, so N of them
# race here concurrently. Two failure modes follow, and both were observed in
# production on 2026-08-28:
#
#   1. TORN VENV. `uv pip install --force-reinstall` uninstalls ~97 packages and
#      reinstalls them. Two of those running at once in one directory leaves a
#      mixture — 4 concurrent installs inside 3 seconds produced a venv holding
#      markdown_vault_mcp 4.0.0's code beside fastmcp-pvl-core 4.4.0's library,
#      and every server booting from it died with
#      `TypeError: build_instructions() got an unexpected keyword argument`.
#      Fix: serialize with a blocking lock, and re-check under it.
#   2. PING-PONG. Orphaned plugin roots stay on disk and keep launching, so an
#      old root's wheel and a current root's wheel alternately reinstalled the
#      one shared venv — 52 full reinstalls in a single day. A lock alone would
#      only make that churn orderly. Fix: key the venv directory by the wheel's
#      content hash, so two different wheels can never touch one environment.
#      Contention then only exists among callers carrying the SAME wheel, where
#      waiting is correct and brief.
#
# Cache key is the wheel's SHA-256 content hash, NOT the version string: a wheel
# rebuilt from the same upstream version still gets its own venv if its bytes
# changed. The in-venv marker (.installed-wheel-hash) is retained as the
# *completion* record — the directory existing proves nothing, a matching marker
# plus an executable entry point proves the install finished. Both must hold or
# we reinstall (fail closed).
#
# Idle venvs are reclaimed by _memory_venv_gc so a long-lived cache does not
# accumulate one ~230MB directory per release forever.
#
# The base wheel declares only fastmcp-pvl-core/typer/frontmatter/requests;
# fastmcp and fastembed live behind extras, so they MUST be named explicitly.
#
# Logging: every caller passes a logger function name as $1; all install/hash
# chatter goes there (the launcher routes it to stderr so the MCP stdio channel
# stays clean; the supervisor routes it to server.log). Required inputs (env or
# pre-set vars): HOOKS_DIR (to find wheels/) and CACHE_PATH (venv location).
#
# Env knobs:
#   WORKBENCH_MEMORY_INSTALL_LOCK_TIMEOUT  seconds to wait for the install lock
#                                          (default 120; 0 = never block, which
#                                          is what the per-prompt recall hook
#                                          passes so a prompt never stalls)
#   WORKBENCH_MEMORY_VENV_GC_IDLE_DAYS     reclaim venvs unused this long
#                                          (default 30; 0 disables the sweep)

# _memory_wheel_path: newest bundled wheel, or empty when none ships. Echoes the
# path; never fails (an absent wheels/ dir is a normal legacy-install case).
_memory_wheel_path() {
  local wheels_dir="${HOOKS_DIR:?HOOKS_DIR must be set}/wheels"
  [ -d "$wheels_dir" ] || return 0
  ls -t "$wheels_dir"/markdown_vault_mcp-*.whl 2>/dev/null | head -n 1
}

# _memory_venv_dir: the venv directory for a (cache, wheel-hash) pair. The single
# expression both the installer and the path reporter derive from, so they can
# never drift. 12 hex chars is ample: these are content hashes of a handful of
# wheels in one directory, not an adversarial namespace.
_memory_venv_dir() { echo "$1/server-venv-${2:0:12}"; }

# memory_venv_path: where the currently bundled wheel's server lives, WITHOUT
# installing anything. Reporting tools (scripts/memory-status.sh) call this so
# they never hard-code a path the installer owns. Echoes the directory; returns
# non-zero when no bundled wheel (or no shasum) exists to key it on.
memory_venv_path() {
  local cache="${CACHE_PATH:?CACHE_PATH must be set}"
  local wheel
  wheel="$(_memory_wheel_path)"
  [ -n "$wheel" ] || return 1
  local wheel_hash
  wheel_hash="$(shasum -a 256 "$wheel" 2>/dev/null | cut -d' ' -f1)"
  [ -n "$wheel_hash" ] || return 1
  _memory_venv_dir "$cache" "$wheel_hash"
}

# _memory_install_lock: claim the install lock for one venv, blocking until the
# holder finishes or the timeout expires. Returns 0 holding the lock, non-zero
# having given up (the caller must NOT install in that case).
#
# WHY blocking, where memory_vacuum_locked is non-blocking: skipping a VACUUM is
# free — the index is merely un-reclaimed. Skipping an *install* is not: the
# loser would have to exec a binary out of a venv it never verified, which is
# exactly the defect this lock exists to prevent. So the loser waits for the
# coherent result instead, and callers that cannot afford to wait (the
# per-prompt recall hook) pass a 0 timeout and fail closed.
#
# Staleness is PID-liveness, never wall-clock (mirrors memory-server-up.sh and
# memory_vacuum_locked): a crashed installer's lock is stolen once its pid is
# dead. Every failed claim — including a steal — costs one second of the budget,
# so the loop is bounded even if mkdir fails for a reason that is not contention.
_memory_install_lock() {
  local lock_dir="$1" logger="$2"
  local timeout="${WORKBENCH_MEMORY_INSTALL_LOCK_TIMEOUT:-120}"
  case "$timeout" in ''|*[!0-9]*) timeout=120 ;; esac
  local pid_file="$lock_dir/pid"
  local waited=0

  while ! mkdir "$lock_dir" 2>/dev/null; do
    local holder=""
    [ -f "$pid_file" ] && holder="$(cat "$pid_file" 2>/dev/null)"
    if [ -z "$holder" ] || ! kill -0 "$holder" 2>/dev/null; then
      "$logger" "install: stealing stale lock (holder '${holder:-none}' not alive)"
      rm -rf "$lock_dir" 2>/dev/null || true
      # Retry at once rather than spending a second of budget: a 0s timeout must
      # still win against a dead holder. If this claim also fails, a concurrent
      # caller took it and we fall through to the wait/timeout below.
      mkdir "$lock_dir" 2>/dev/null && break
    fi
    if [ "$waited" -ge "$timeout" ]; then
      "$logger" "install: venv lock still held after ${timeout}s; not installing"
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done

  echo "$$" > "$pid_file" 2>/dev/null || true
  return 0
}

# _memory_venv_gc: reclaim wheel-keyed venvs nothing has booted in a while, so a
# cache that has seen many releases does not grow without bound (~230MB each).
#
# Conservative by construction: the venv we just resolved is always kept, a venv
# whose install lock is held is always kept, and the idle window is measured from
# a .last-used stamp refreshed on EVERY successful resolve — so a venv still in
# rotation is never a candidate no matter how long ago it was installed. Never
# fails the caller.
_memory_venv_gc() {
  local cache="$1" keep="$2" logger="$3"
  local idle_days="${WORKBENCH_MEMORY_VENV_GC_IDLE_DAYS:-30}"
  case "$idle_days" in ''|*[!0-9]*) idle_days=30 ;; esac
  [ "$idle_days" -eq 0 ] && return 0
  local idle_min=$(( idle_days * 24 * 60 ))

  local dir
  for dir in "$cache"/server-venv*; do
    [ -d "$dir" ] || continue
    [ "$dir" = "$keep" ] && continue
    case "$dir" in *.lock) continue ;; esac
    [ -d "${dir}.lock" ] && continue

    # -maxdepth 0 is load-bearing: without it find descends and any recently
    # written file inside would report the whole venv as fresh forever. The
    # stamp is the truth when present; the directory's own mtime covers venvs
    # created before the stamp existed.
    local probe="$dir/.last-used"
    [ -f "$probe" ] || probe="$dir"
    [ -n "$(find "$probe" -maxdepth 0 -mmin "-${idle_min}" 2>/dev/null)" ] && continue

    "$logger" "install: reclaiming venv unused for >${idle_days}d: $dir"
    rm -rf "$dir" 2>/dev/null || true
  done
  return 0
}

# _memory_install_from_git: legacy resilience path — install the global binary
# from upstream when no bundled wheel is available or uv is missing.
# On success sets SERVER_BIN to the global binary's path and returns 0; returns
# non-zero when the binary cannot be made available. Does NOT exec — the caller
# launches with its own transport flags.
_memory_install_from_git() {
  local logger="$1"
  if ! command -v markdown-vault-mcp >/dev/null 2>&1; then
    "$logger" "markdown-vault-mcp not found; installing from upstream (~60-90s, first run only)"
    if command -v uv >/dev/null 2>&1; then
      if uv tool install --from git+https://github.com/pvliesdonk/markdown-vault-mcp \
          markdown-vault-mcp --with fastmcp --with fastembed 1>&2; then
        "$logger" "installed markdown-vault-mcp via uv"
      else
        "$logger" "ERROR: uv tool install failed (see installer output above)"
        return 1
      fi
    elif command -v pipx >/dev/null 2>&1; then
      if pipx install git+https://github.com/pvliesdonk/markdown-vault-mcp 1>&2; then
        "$logger" "installed markdown-vault-mcp via pipx"
      else
        "$logger" "ERROR: pipx install failed (see installer output above)"
        return 1
      fi
    else
      "$logger" "ERROR: markdown-vault-mcp is not installed and neither uv nor pipx is on PATH."
      "$logger" "Install uv (https://docs.astral.sh/uv/) or pipx (https://pipx.pypa.io/) and restart Claude Code,"
      "$logger" "or install the server manually with one of:"
      "$logger" "  uv tool install --from git+https://github.com/pvliesdonk/markdown-vault-mcp markdown-vault-mcp --with fastmcp --with fastembed"
      "$logger" "  pipx install git+https://github.com/pvliesdonk/markdown-vault-mcp"
      "$logger" "See README.md, section '3. markdown-vault-mcp — the MCP server backing the memory vault'."
      return 1
    fi

    if ! command -v markdown-vault-mcp >/dev/null 2>&1; then
      "$logger" "ERROR: install reported success but markdown-vault-mcp is still not on PATH"
      "$logger" "PATH: $PATH"
      return 1
    fi
    "$logger" "bootstrap complete"
  fi
  # SERVER_BIN is the function's out-parameter, read by the caller after return.
  # shellcheck disable=SC2034
  SERVER_BIN="$(command -v markdown-vault-mcp)"
  return 0
}

# _memory_venv_ready: does this venv hold a FINISHED install of this wheel?
# Marker and entry point must both agree — a directory alone proves nothing.
_memory_venv_ready() {
  local hash_marker="$1" wheel_hash="$2" server_bin="$3"
  [ -x "$server_bin" ] && [ "$(cat "$hash_marker" 2>/dev/null)" = "$wheel_hash" ]
}

# _memory_install_into_venv: the locked critical section. Re-checks readiness
# first (a caller that waited out the lock usually finds the work already done),
# then installs. Returns 0 when the venv holds a finished install of this wheel.
_memory_install_into_venv() {
  local logger="$1" wheel="$2" wheel_hash="$3" venv="$4"
  local hash_marker="$venv/.installed-wheel-hash"
  local server_bin="$venv/bin/markdown-vault-mcp"

  if _memory_venv_ready "$hash_marker" "$wheel_hash" "$server_bin"; then
    "$logger" "server venv installed while we waited for the lock; skipping install"
    return 0
  fi

  "$logger" "installing bundled wheel $(basename "$wheel") into $venv (~2.6s, first run or wheel change)"
  if [ ! -d "$venv" ]; then
    if ! uv venv "$venv" --python ">=3.11" 1>&2; then
      "$logger" "ERROR: uv venv failed"
      return 1
    fi
  fi
  # --force-reinstall still earns its place: a previous install into THIS venv
  # may have died partway, and the wheel-keyed path means we would otherwise
  # inherit its wreckage rather than a clean directory.
  if ! uv pip install --python "$venv/bin/python" --force-reinstall \
      "$wheel" fastmcp fastembed 1>&2; then
    "$logger" "ERROR: uv pip install failed"
    return 1
  fi

  # Marker last: it is the completion record, so it must not exist until the
  # install it describes actually finished.
  echo "$wheel_hash" > "$hash_marker"
  if [ ! -x "$server_bin" ]; then
    "$logger" "ERROR: install reported success but $server_bin is missing"
    return 1
  fi
  "$logger" "installed markdown-vault-mcp into server venv"
  return 0
}

# memory_install_server: ensure a usable server binary, setting SERVER_BIN.
# Args: $1 = logger function name. Returns 0 with SERVER_BIN set, or non-zero.
memory_install_server() {
  local logger="$1"
  local cache="${CACHE_PATH:?CACHE_PATH must be set}"

  local wheel
  wheel="$(_memory_wheel_path)"

  # No bundled wheel or no uv → legacy git/pipx install of the global binary.
  if [ -z "$wheel" ] || ! command -v uv >/dev/null 2>&1; then
    if [ -z "$wheel" ]; then
      "$logger" "no bundled wheel in ${HOOKS_DIR}/wheels; falling back to git install"
    else
      "$logger" "uv not on PATH; falling back to git/pipx install"
    fi
    _memory_install_from_git "$logger"
    return $?
  fi

  # Hash the wheel bytes. shasum ships with macOS base and exists on Linux too.
  local wheel_hash
  wheel_hash="$(shasum -a 256 "$wheel" | cut -d' ' -f1)"
  if [ -z "$wheel_hash" ]; then
    "$logger" "ERROR: could not hash $wheel; falling back to git install"
    _memory_install_from_git "$logger"
    return $?
  fi

  local venv
  venv="$(_memory_venv_dir "$cache" "$wheel_hash")"
  local hash_marker="$venv/.installed-wheel-hash"
  local server_bin="$venv/bin/markdown-vault-mcp"

  # Fast path: already installed. Taken without the lock, because a finished
  # install is immutable — nothing else writes this venv for this wheel.
  if _memory_venv_ready "$hash_marker" "$wheel_hash" "$server_bin"; then
    "$logger" "server venv up to date (wheel hash matches); skipping install"
    touch "$venv/.last-used" 2>/dev/null || true
    # shellcheck disable=SC2034
    SERVER_BIN="$server_bin"
    return 0
  fi

  mkdir -p "$cache" 2>/dev/null || true
  if ! _memory_install_lock "${venv}.lock" "$logger"; then
    return 1
  fi
  _memory_install_into_venv "$logger" "$wheel" "$wheel_hash" "$venv"
  local rc=$?
  # Release inline on every path — the stdio launcher execs the server right
  # after us, where an EXIT trap would fire in the wrong process.
  rm -rf "${venv}.lock" 2>/dev/null || true

  if [ "$rc" -ne 0 ]; then
    "$logger" "ERROR: venv install failed; falling back to git install"
    _memory_install_from_git "$logger"
    return $?
  fi

  touch "$venv/.last-used" 2>/dev/null || true
  _memory_venv_gc "$cache" "$venv" "$logger"
  # SERVER_BIN is the function's out-parameter, read by the caller after return.
  # shellcheck disable=SC2034
  SERVER_BIN="$server_bin"
  return 0
}
