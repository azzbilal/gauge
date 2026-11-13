"""Layer 2 verification service — the HTTP wrapper the API calls.

POST /extract reads a task's prompt and spec: body {"prompt": "...", "spec": "..."} (spec
optional) and returns {"version": ..., "requirements": [...], "rubric_items": [...]}. It is
the only requirement extraction there is; the API builds its packets from this answer.
POST /lint runs M7 Packet Lint on a task packet and returns {"findings": [...]}.
POST /verify runs the M8 Verifier Pack on a task packet and returns {"verdicts": [...]},
one per machine-checkable rubric item.
POST /probe runs the M9 Probe Gate: body {"packet": {...}, "model": "...", "rollouts": 3}
(rollouts optional, default 3) and returns {"tier": ..., "rollouts": [...], ...}. It calls
the local Ollama server and answers 502 when that fails.
/health proves the seam works. Uses only the standard library.

One thread per request, so a lint (pure and fast) is never queued behind a verify or a
probe that is waiting on a worker process or on Ollama.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# Make verify/ importable regardless of the directory the service is started from.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lint import PacketError, extract, lint  # noqa: E402
from probe import DEFAULT_ROLLOUTS, OllamaError, probe  # noqa: E402
from verifiers import verify  # noqa: E402

PORT = 4000
MAX_BODY_BYTES = 1_000_000
MAX_ROLLOUTS = 20


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
        if self.path == "/extract":
            body = self._read_json()
            if body is None:
                return
            if not isinstance(body, dict):
                self._json(400, {"error": "body must be a JSON object"})
                return
            prompt, spec = body.get("prompt"), body.get("spec")
            if not isinstance(prompt, str):
                self._json(400, {"error": "'prompt' must be a string"})
                return
            if spec is not None and not isinstance(spec, str):
                self._json(400, {"error": "'spec' must be a string or null"})
                return
            try:
                self._json(200, extract(prompt, spec))
            except PacketError as err:
                self._json(400, {"error": str(err)})
            except Exception:
                self._json(500, {"error": "internal server error"})
        elif self.path == "/lint":
            packet = self._read_json()
            if packet is None:
                return
            try:
                findings = lint(packet)
            except PacketError as err:
                self._json(400, {"error": str(err)})
                return
            except Exception:
                self._json(500, {"error": "internal server error"})
                return
            self._json(200, {"findings": findings})
        elif self.path == "/verify":
            packet = self._read_json()
            if packet is None:
                return
            try:
                verdicts = verify(packet)
            except PacketError as err:
                self._json(400, {"error": str(err)})
                return
            except Exception:
                self._json(500, {"error": "internal server error"})
                return
            self._json(200, {"verdicts": verdicts})
        elif self.path == "/probe":
            body = self._read_json()
            if body is None:
                return
            if not isinstance(body, dict):
                self._json(400, {"error": "body must be a JSON object"})
                return
            model = body.get("model")
            if not isinstance(model, str) or not model.strip():
                self._json(400, {"error": "'model' must be a non-empty string"})
                return
            rollouts = body.get("rollouts", DEFAULT_ROLLOUTS)
            if (isinstance(rollouts, bool) or not isinstance(rollouts, int)
                    or not 1 <= rollouts <= MAX_ROLLOUTS):
                self._json(400, {
                    "error": f"'rollouts' must be an integer from 1 to {MAX_ROLLOUTS}"})
                return
            try:
                result = probe(body.get("packet"), model.strip(), rollouts)
            except PacketError as err:
                self._json(400, {"error": str(err)})
                return
            except OllamaError as err:
                self._json(502, {"error": str(err)})
                return
            except Exception:
                self._json(500, {"error": "internal server error"})
                return
            self._json(200, result)
        else:
            self._json(404, {"error": "not found"})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"verify service listening on http://127.0.0.1:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
