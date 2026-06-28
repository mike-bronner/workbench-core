#!/usr/bin/env bash
#
# memory-probe: identity-checked health probe for the shared HTTP memory server.
#
# Sourceable and side-effect-free: sourcing only DEFINES memory_probe. The probe
# answers one question — "is OUR memory server listening on the configured port,
# and is it the right vault?" — and classifies the answer into one status word.
#
# Why identity-checked, not a bare GET or bare TCP: the port could be held by a
# DIFFERENT markdown-vault-mcp (a stale stdio orphan, a manual run, an unrelated
# squatter pointed at another vault). Connecting blindly would attach the
# session to the WRONG vault. So the positive path POSTs a real MCP `initialize`
# and asserts the handshake's serverInfo.name equals our configured MCP_NAME.
# A bare /dev/tcp connect is used only as a cheap NEGATIVE pre-filter (nothing
# listening → DOWN_NONE without paying for an HTTP round-trip).
#
# Caller contract: source hooks/lib/memory-env.sh and call memory_load_env
# first, so MEMORY_PORT / MCP_NAME / CACHE_PATH are set. memory_probe reads:
#   MEMORY_PORT  port to probe
#   MCP_NAME     expected serverInfo.name (vault identity)
#   CACHE_PATH   for server.port (drift check), server.token (auth),
#                .server-failed (last spawn outcome), vault-index.sqlite (build)
#
# Status words (echoed on stdout, one line):
#   UP           our server answered initialize and identity matched; index built
#   BUILDING     our server answered + identity matched, but the index sqlite is
#                not on disk yet (first embedding build still running; search is
#                already functionally available, keyword-only, per the server)
#   PORT_DRIFT   recorded server.port differs from the configured MEMORY_PORT
#                (settings.json env vs config.json disagree) — the host connects
#                to MEMORY_PORT, so this is a loud "your config drifted" signal
#   DOWN_FOREIGN something is listening on the port but it is NOT our vault
#                (initialize failed, or serverInfo.name mismatched) — a conflict,
#                never silently adopted
#   DOWN_FAILED  a .server-failed marker is present (the last spawn could not
#                bind/initialize); nothing healthy is listening
#   DOWN_NONE    nothing is listening on the port at all (cold; spawn it)
#
# Exit code mirrors health: 0 for UP/BUILDING, 1 for every down/conflict status.

# _memory_probe_tcp_open: cheap negative pre-filter. Return 0 iff a TCP connect
# to 127.0.0.1:$1 succeeds. Uses bash's /dev/tcp (no nc dependency); the connect
# is wrapped so a refused port is a clean non-zero, not a noisy error.
_memory_probe_tcp_open() {
  local port="$1"
  (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null && exec 3>&- 2>/dev/null
}

# _memory_probe_initialize: POST a minimal MCP initialize to the server and echo
# the raw response body, sending the dual Accept header the HTTP/SSE transport
# requires. Echoes nothing on a transport-level failure (curl non-zero).
#
# The bearer token is passed through a curl --config read from stdin (-K -), NOT
# on argv: a -H "Authorization: Bearer ..." argument is world-readable via ps /
# /proc/<pid>/cmdline and would leak the token to other local users — the
# opposite of the 0600 token-file handling everywhere else. The config carries
# the header only when a token exists; with no token the config is empty (a
# no-op), so there is no auth array to expand either — which sidesteps the
# bash 3.2 `set -u` abort on "${arr[@]}" for an empty array (bash 4.4+
# special-cases it, so Linux CI never sees it; the macOS target runs bash 3.2).
_memory_probe_initialize() {
  local port="$1" token="$2"
  local body='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"memory-probe","version":"1"}}}'
  local config=""
  [ -n "$token" ] && config="header = \"Authorization: Bearer $token\""
  printf '%s\n' "$config" \
    | curl -fsS --max-time 5 -K - \
      -H 'Content-Type: application/json' \
      -H 'Accept: application/json, text/event-stream' \
      -X POST "http://127.0.0.1:$port/mcp" \
      -d "$body" 2>/dev/null
}

# _memory_probe_server_name: extract serverInfo.name from an initialize response.
# The Streamable-HTTP transport may answer as a single JSON object OR as an SSE
# stream — `text/event-stream` with named events, e.g.
#   event: message
#   data: {"jsonrpc":"2.0",...,"result":{"serverInfo":{"name":"..."}}}
#   <blank line>
# Only the `data:` lines carry JSON; `event:`/`id:`/`:comment`/blank framing
# lines are NOT JSON and make a bare jq parse error out. So feed jq ONLY the
# `data:` payloads: `sed -n 's/^data: *//; /^{/p'` keeps a line solely when it
# began `data:` AND (after stripping) starts with `{`. A plain single-object
# response (no `data:` prefix, starts with `{`) passes through unchanged. Then
# `jq -R` reads each surviving line as a raw STRING and `fromjson?` parses it,
# silently skipping any straggler that is not valid JSON (a truncated SSE chunk
# can't poison the whole stream the way a bare `jq` top-level parse would).
_memory_probe_server_name() {
  local response="$1"
  command -v jq >/dev/null 2>&1 || return 1
  printf '%s\n' "$response" \
    | sed -n 's/^data: *//; /^{/p' \
    | jq -rR 'fromjson? | select(.result.serverInfo.name != null) | .result.serverInfo.name' 2>/dev/null \
    | head -n 1
}

# memory_probe: classify the configured port's health into one status word.
memory_probe() {
  local port="${MEMORY_PORT:-8765}"
  local expected_name="${MCP_NAME:-workbench-memory}"
  local cache="${CACHE_PATH:-$HOME/.claude-memory-cache}"

  # Recorded-port drift: the host connects to MEMORY_PORT (from settings.json
  # env), but the running server may have bound a different port recorded in
  # server.port. If they disagree, surface it — connecting to MEMORY_PORT would
  # either miss the server or hit a foreign one.
  if [ -f "$cache/server.port" ]; then
    local recorded
    recorded="$(cat "$cache/server.port" 2>/dev/null)"
    if [ -n "$recorded" ] && [ "$recorded" != "$port" ]; then
      echo "PORT_DRIFT"
      return 1
    fi
  fi

  # Negative pre-filter: nothing listening → cold or failed. Distinguish a fresh
  # cold port (DOWN_NONE) from one whose last spawn failed (DOWN_FAILED) via the
  # .server-failed marker.
  if ! _memory_probe_tcp_open "$port"; then
    if [ -f "$cache/.server-failed" ]; then
      echo "DOWN_FAILED"
    else
      echo "DOWN_NONE"
    fi
    return 1
  fi

  # Something is listening. Confirm it is OUR vault via an identity-checked
  # initialize. A token file, when present, gates the request.
  local token=""
  [ -f "$cache/server.token" ] && token="$(cat "$cache/server.token" 2>/dev/null)"

  local response name
  response="$(_memory_probe_initialize "$port" "$token")"
  if [ -z "$response" ]; then
    # Listening but won't complete an authenticated initialize — a foreign
    # squatter, a wrong-auth server, or a non-MCP process. Never adopt it.
    echo "DOWN_FOREIGN"
    return 1
  fi

  name="$(_memory_probe_server_name "$response")"
  if [ "$name" != "$expected_name" ]; then
    echo "DOWN_FOREIGN"
    return 1
  fi

  # Our vault is up. The embedding index builds asynchronously AFTER the port
  # binds; while the sqlite file is not yet on disk, report BUILDING (search is
  # already available keyword-only). Once it exists, report UP.
  if [ -f "$cache/vault-index.sqlite" ]; then
    echo "UP"
  else
    echo "BUILDING"
  fi
  return 0
}
