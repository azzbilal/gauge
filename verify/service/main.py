"""Layer 2 verification service — the HTTP wrapper the API calls.

Scaffold for Phase 2. The real /verify endpoint (Packet Lint + Verifier Pack + Probe Gate)
lands here; for now /health proves the seam works. Uses only the standard library.
"""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 4000


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"service": "verify", "layer": 2, "status": "ok"})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        self._json(501, {"error": "verify endpoint not implemented yet (M7/M8 pending)"})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"verify service listening on http://127.0.0.1:{PORT}")
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
