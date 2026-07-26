#!/usr/bin/env bash
#
# fake-markdown-vault-mcp: a stand-in for the real markdown-vault-mcp `serve`
# binary, used by the hook test suite. It parses the same `serve --transport
# http --host --port --http-path` flags the supervisor passes, binds the port,
# and answers an MCP `initialize` POST with a serverInfo.name taken from
# MARKDOWN_VAULT_MCP_SERVER_NAME — enough for the identity-checked probe to
# classify it. It does NO embedding build, opens NO network, and starts in
# milliseconds, so the suite stays sub-second and offline.
#
# Behavior knobs (env):
#   FAKE_SERVER_BIND_DELAY_MS  sleep this long BEFORE binding the port, to
#                              simulate the real server's ~2.1s bind window
#                              (lets concurrency tests race the readiness gate).
#   FAKE_SERVER_REFUSE=1       never bind; exit non-zero immediately, to
#                              simulate a server that fails to come up.
#   FAKE_SERVER_NAME           override the serverInfo.name reported (defaults to
#                              MARKDOWN_VAULT_MCP_SERVER_NAME, then a constant).
#   FAKE_SERVER_SSE=1          answer initialize as a `text/event-stream` SSE
#                              frame (`event: message\ndata: {json}\n\n`) instead
#                              of a single JSON object, matching the real
#                              Streamable-HTTP transport — exercises the probe's
#                              SSE-aware response parsing.
#   FAKE_SERVER_REQUIRE_TOKEN  when set, answer initialize ONLY if the request's
#                              Authorization header equals "Bearer <value>";
#                              otherwise reject with 401. Lets a test prove the
#                              probe's bearer token actually reaches the server,
#                              not merely that the request succeeds.
#   FAKE_SEARCH_EMPTY=1        answer a `tools/call`/`search` with an empty result
#                              set (a bare `[]`), to exercise the recall hook's
#                              "no hits → no-op" path. Default returns two canned
#                              hits in the real search payload shape.
#   FAKE_SEARCH_NOISE=1        prepend a session-summary hit ranked FIRST, to
#                              exercise the recall hook's curated-type filter.
#   FAKE_SEARCH_SHAPE=...      which envelope carries the search hits: "content"
#                              (default — content[].text bare array), "dual"
#                              (BOTH content[].text AND structuredContent, like
#                              the live server — the hook must inject each hit
#                              once), or "structured" (structuredContent only —
#                              exercises the hook's fallback branch).
#                              These SHAPE/SSE/token knobs only apply to `serve`
#                              — the real CLI `search` subcommand (below) has
#                              none of that Streamable-HTTP transport ceremony.
#   FAKE_SEARCH_HANG_SECONDS=N  (search subcommand only) sleep N seconds before
#                              printing anything — exercises memory-recall.sh's
#                              watchdog kill-on-timeout path.
#   FAKE_SEARCH_EXIT_NONZERO=1  (search subcommand only) exit 1 with no stdout —
#                              simulates a crashed/erroring CLI invocation.
#
# `serve` is a thin bash shim around an inline python3 HTTP server: python3's
# http.server gives a real bound TCP port that bash /dev/tcp and curl can hit,
# with none of the real server's heavy dependency closure. `search` is plain
# bash — it prints a canned JSON array and exits, mirroring the real CLI's
# one-shot shape exactly (no server, no port).

set -u

# The real CLI dispatches on a `search` vs `serve` subcommand; this fixture
# does the same rather than assuming `serve`, so one fixture backs both the
# per-session-stdio/shared-server test suites (serve) and the recall hook's
# test suite (search).
if [ "${1:-}" = "search" ]; then
  shift            # drop "search"
  [ "$#" -gt 0 ] && shift  # drop the QUERY positional — the fixture ignores it
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --mode|--limit|--folder|--source-dir) shift 2 ;;
      *) shift ;;
    esac
  done

  if [ "${FAKE_SEARCH_EXIT_NONZERO:-}" = "1" ]; then
    echo "fake-markdown-vault-mcp: FAKE_SEARCH_EXIT_NONZERO=1 — simulated crash" >&2
    exit 1
  fi
  hang="${FAKE_SEARCH_HANG_SECONDS:-0}"
  [ "$hang" -gt 0 ] 2>/dev/null && sleep "$hang"

  if [ "${FAKE_SEARCH_EMPTY:-}" = "1" ]; then
    echo '[]'
    exit 0
  fi
  if [ "${FAKE_SEARCH_NOISE:-}" = "1" ]; then
    cat <<JSON
[
  {"path":"sessions/2026-01-01/noise-tick.summary.md","title":"Session summary — dispatch (idle)","folder":"sessions/2026-01-01","score":0.99,"search_type":"semantic","frontmatter":{"name":"Session summary — dispatch (idle)","type":"session","summary":"Noise summary that must not be injected."},"sections":[{"heading":null,"content":"noise body"}]},
  {"path":"insights/canned-recall-one.md","title":"Canned recall hit one","folder":"insights","score":0.42,"search_type":"semantic","frontmatter":{"name":"Canned recall hit one","type":"insight","summary":"First canned summary for the recall hook test."},"sections":[{"heading":null,"content":"body one"}]},
  {"path":"decisions/canned-recall-two.md","title":"Canned recall hit two","folder":"decisions","score":0.39,"search_type":"semantic","frontmatter":{"name":"Canned recall hit two","type":"decision","summary":"Second canned summary for the recall hook test."},"sections":[{"heading":null,"content":"body two"}]}
]
JSON
    exit 0
  fi
  cat <<JSON
[
  {"path":"insights/canned-recall-one.md","title":"Canned recall hit one","folder":"insights","score":0.42,"search_type":"semantic","frontmatter":{"name":"Canned recall hit one","type":"insight","summary":"First canned summary for the recall hook test."},"sections":[{"heading":null,"content":"body one"}]},
  {"path":"decisions/canned-recall-two.md","title":"Canned recall hit two","folder":"decisions","score":0.39,"search_type":"semantic","frontmatter":{"name":"Canned recall hit two","type":"decision","summary":"Second canned summary for the recall hook test."},"sections":[{"heading":null,"content":"body two"}]}
]
JSON
  exit 0
fi

# Parse just the flags the supervisor sends; ignore the rest. We only need the
# port to bind. Accept `serve` as argv[1] like the real CLI.
PORT=8765
HTTP_PATH="/mcp"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --http-path|--path) HTTP_PATH="$2"; shift 2 ;;
    --host|--transport) shift 2 ;;
    *) shift ;;
  esac
done

if [ "${FAKE_SERVER_REFUSE:-}" = "1" ]; then
  echo "fake-markdown-vault-mcp: FAKE_SERVER_REFUSE=1 — refusing to bind" >&2
  exit 1
fi

SERVER_NAME="${FAKE_SERVER_NAME:-${MARKDOWN_VAULT_MCP_SERVER_NAME:-fake-vault}}"
BIND_DELAY_MS="${FAKE_SERVER_BIND_DELAY_MS:-0}"
SSE="${FAKE_SERVER_SSE:-0}"
REQUIRE_TOKEN="${FAKE_SERVER_REQUIRE_TOKEN:-}"
SEARCH_EMPTY="${FAKE_SEARCH_EMPTY:-0}"
SEARCH_SHAPE="${FAKE_SEARCH_SHAPE:-content}"
SEARCH_NOISE="${FAKE_SEARCH_NOISE:-0}"

exec python3 - "$PORT" "$HTTP_PATH" "$SERVER_NAME" "$BIND_DELAY_MS" "$SSE" "$REQUIRE_TOKEN" "$SEARCH_EMPTY" "$SEARCH_SHAPE" "$SEARCH_NOISE" <<'PY'
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

port = int(sys.argv[1])
http_path = sys.argv[2]
server_name = sys.argv[3]
bind_delay_ms = int(sys.argv[4])
sse = sys.argv[5] == "1"
require_token = sys.argv[6]
search_empty = sys.argv[7] == "1"
search_shape = sys.argv[8] if len(sys.argv) > 8 else "content"
search_noise = len(sys.argv) > 9 and sys.argv[9] == "1"

# Fixed session id handed back on initialize and required on every later call,
# mirroring the real Streamable-HTTP transport's Mcp-Session-Id contract.
SESSION_ID = "fake-session-0001"

# Simulate the real server's bind window: stay unbound for the delay so
# concurrency tests can race the readiness gate against a not-yet-listening port.
if bind_delay_ms > 0:
    time.sleep(bind_delay_ms / 1000.0)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # silence request logging
        pass

    def _reject(self, code):
        self.send_response(code)
        self.end_headers()

    def _send_result(self, payload_id, result_obj, extra_headers=None):
        # Frame the JSON-RPC result the same way for every method: a single JSON
        # object, or — when sse — a text/event-stream `event: message` frame, so
        # callers that strip SSE framing are exercised on both paths.
        result = json.dumps(
            {"jsonrpc": "2.0", "id": payload_id, "result": result_obj}
        )
        if sse:
            body = ("event: message\ndata: " + result + "\n\n").encode()
            content_type = "text/event-stream"
        else:
            body = result.encode()
            content_type = "application/json"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path.rstrip("/") != http_path.rstrip("/"):
            return self._reject(404)
        # Optional auth gate: when require_token is set, only an exact
        # "Bearer <token>" Authorization header is accepted; anything else is a
        # 401. This lets a test prove the probe's bearer token reaches us, not
        # merely that the request succeeds.
        if require_token and self.headers.get("Authorization") != "Bearer " + require_token:
            return self._reject(401)
        length = int(self.headers.get("Content-Length", 0) or 0)
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self._reject(400)
        method = payload.get("method")
        pid = payload.get("id", 1)

        if method == "initialize":
            # The real Streamable-HTTP transport hands back an Mcp-Session-Id on
            # initialize that every later call must echo. Reproduce that so the
            # recall hook's handshake (init → capture sid → tools/call) is
            # exercised, not bypassed.
            return self._send_result(
                pid,
                {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "serverInfo": {"name": server_name, "version": "fake"},
                },
                extra_headers={"Mcp-Session-Id": SESSION_ID},
            )

        if method == "tools/call" and (payload.get("params") or {}).get("name") == "search":
            # The real server rejects a tools/call that lacks the session id with
            # a JSON-RPC "Missing session ID" error. Mirror that so a hook that
            # forgets the handshake fails the test instead of silently passing.
            if self.headers.get("Mcp-Session-Id") != SESSION_ID:
                return self._reject(400)
            # markdown-vault-mcp returns the search payload as a JSON STRING in
            # result.content[].text — a BARE ARRAY [{path,title,frontmatter,
            # sections,…}] (confirmed against the live server), NOT wrapped in a
            # {"result":…} object. The live server ALSO mirrors the same hits into
            # result.structuredContent. FAKE_SEARCH_SHAPE selects which the
            # fixture emits: "content" (default, content[].text only), "dual"
            # (BOTH — like the live server; the hook must inject each hit ONCE),
            # or "structured" (structuredContent only — exercises the fallback).
            # FAKE_SEARCH_EMPTY → no hits.
            if search_empty:
                hits = []
            else:
                hits = []
                if search_noise:
                    # A session-summary hit RANKED FIRST — exercises the
                    # curated-type filter (must be skipped, not injected).
                    hits.append(
                        {
                            "path": "sessions/2026-01-01/noise-tick.summary.md",
                            "title": "Session summary — dispatch (idle)",
                            "folder": "sessions/2026-01-01",
                            "score": 0.99,
                            "search_type": "semantic",
                            "frontmatter": {
                                "name": "Session summary — dispatch (idle)",
                                "type": "session",
                                "summary": "Noise summary that must not be injected.",
                            },
                            "sections": [{"heading": None, "content": "noise body"}],
                        }
                    )
                hits += [
                    {
                        "path": "insights/canned-recall-one.md",
                        "title": "Canned recall hit one",
                        "folder": "insights",
                        "score": 0.42,
                        "search_type": "semantic",
                        "frontmatter": {
                            "name": "Canned recall hit one",
                            "type": "insight",
                            "summary": "First canned summary for the recall hook test.",
                        },
                        "sections": [{"heading": None, "content": "body one"}],
                    },
                    {
                        "path": "decisions/canned-recall-two.md",
                        "title": "Canned recall hit two",
                        "folder": "decisions",
                        "score": 0.39,
                        "search_type": "semantic",
                        "frontmatter": {
                            "name": "Canned recall hit two",
                            "type": "decision",
                            "summary": "Second canned summary for the recall hook test.",
                        },
                        "sections": [{"heading": None, "content": "body two"}],
                    },
                ]
            inner = json.dumps(hits)
            structured = {"result": hits}
            result_obj = {"_meta": {"index_stale": False}}
            if search_shape == "structured":
                result_obj["content"] = []
                result_obj["structuredContent"] = structured
            elif search_shape == "dual":
                result_obj["content"] = [{"type": "text", "text": inner}]
                result_obj["structuredContent"] = structured
            else:  # "content" — the default bare-array-in-text shape
                result_obj["content"] = [{"type": "text", "text": inner}]
            return self._send_result(pid, result_obj)

        return self._reject(400)


httpd = HTTPServer(("127.0.0.1", port), Handler)
httpd.serve_forever()
PY
