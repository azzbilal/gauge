"""Layer 2 verification service — the HTTP wrapper the API calls.

Scaffold for Phase 2. POST /lint runs M7 Packet Lint on a task packet. The real /verify
endpoint (Verifier Pack + Probe Gate) lands here later; /health proves the seam works.
Uses only the standard library.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

# Make verify/ importable regardless of the directory the service is started from.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lint import PacketError, lint  # noqa: E402

PORT = 4000
MAX_BODY_BYTES = 1_000_000


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        """Return the parsed JSON body, or None after sending an error response."""
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length < 0:
            self._json(400, {"error": "invalid Content-Length"})
            return None
        if length > MAX_BODY_BYTES:
            self._json(413, {"error": "packet too large"})
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._json(400, {"error": "body must be valid JSON"})
            return None

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"service": "verify", "layer": 2, "status": "ok"})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/lint":
            packet = self._read_json()
            if packet is None:
                return
            try:
                findings = lint(packet)
            except PacketError as err:
                self._json(400, {"error": str(err)})
                return
            self._json(200, {"findings": findings})
        else:
            self._json(501, {"error": "verify endpoint not implemented yet (M8 pending)"})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"verify service listening on http://127.0.0.1:{PORT}")
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
