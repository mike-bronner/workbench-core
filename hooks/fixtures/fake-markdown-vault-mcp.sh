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
#
# It is intentionally a thin bash shim around an inline python3 HTTP server:
# python3's http.server gives a real bound TCP port that bash /dev/tcp and curl
# can hit, with none of the real server's heavy dependency closure.

set -u

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

exec python3 - "$PORT" "$HTTP_PATH" "$SERVER_NAME" "$BIND_DELAY_MS" "$SSE" <<'PY'
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

port = int(sys.argv[1])
http_path = sys.argv[2]
server_name = sys.argv[3]
bind_delay_ms = int(sys.argv[4])
sse = sys.argv[5] == "1"

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

    def do_POST(self):
        if self.path.rstrip("/") != http_path.rstrip("/"):
            return self._reject(404)
        length = int(self.headers.get("Content-Length", 0) or 0)
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self._reject(400)
        if payload.get("method") != "initialize":
            return self._reject(400)
        result = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": payload.get("id", 1),
                "result": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "serverInfo": {"name": server_name, "version": "fake"},
                },
            }
        )
        if sse:
            # Real Streamable-HTTP framing: text/event-stream with a named event
            # and a `data:` JSON payload, terminated by a blank line. The probe
            # must strip the framing lines before handing the payload to jq.
            body = ("event: message\ndata: " + result + "\n\n").encode()
            content_type = "text/event-stream"
        else:
            body = result.encode()
            content_type = "application/json"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


httpd = HTTPServer(("127.0.0.1", port), Handler)
httpd.serve_forever()
PY
