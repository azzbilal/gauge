# Verify service — HTTP wrapper

The single seam between Layer 1 (NestJS API) and Layer 2 (verification). The API calls this
service instead of importing verification code, so Layer 2 stays a separate deployable.
Standard library only (`ThreadingHTTPServer`, one thread per request, so a fast lint is never
queued behind a verify or probe waiting on a worker or on Ollama).

Runs on `http://127.0.0.1:4000`; the API finds it at `VERIFY_SERVICE_URL` (default
`http://localhost:4000`) and gives each call 5 seconds.

| Endpoint | Body | Answer |
|---|---|---|
| `GET /health` | — | `{"service": "verify", "layer": 2, "status": "ok"}` |
| `POST /extract` | `{"prompt": "...", "spec": "..."}` (`spec` optional or null) | `{"version", "requirements", "rubric_items"}` from `lint/extract.py` |
| `POST /lint` | a task packet | `{"findings": [...]}` (M7) |
| `POST /verify` | a task packet | `{"verdicts": [...]}`, one per machine-checkable rubric item (M8) |
| `POST /probe` | `{"packet": {...}, "model": "<ollama model>", "rollouts": 3}` | `{"tier", "solve_rate", "solved", "verifier_errors", "model", "rollouts": [...]}` (M9) |

`rollouts` is optional (default 3, 1 to 20). `/probe` needs Ollama on `localhost:11434` and
runs the rollouts one after another, so it blocks for as long as the model takes; the API does
not call it yet.

Errors, on every POST:

| Status | When |
|---|---|
| 400 | body is not valid JSON, has the wrong shape, or the packet is malformed (`PacketError`) |
| 413 | body over 1 MB |
| 404 | unknown path |
| 500 | the check itself crashed (`{"error": "internal server error"}`) |
| 502 | `/probe` only: Ollama could not be reached or rejected the model |

```bash
python verify/service/main.py
```
