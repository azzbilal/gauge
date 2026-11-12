# Verify service — HTTP wrapper

The single seam between Layer 1 (NestJS API) and Layer 2 (verification). The API calls this
service instead of importing verification code, so Layer 2 stays a separate deployable.

Runs on `http://127.0.0.1:4000`.

- `GET /health`
- `POST /lint` — M7 Packet Lint; returns `{"findings": [...]}`
- `POST /verify` — M8 Verifier Pack; returns `{"verdicts": [...]}`, one per
  machine-checkable rubric item
- `POST /probe` — M9 Probe Gate; body `{"packet": {...}, "model": "<ollama model>",
  "rollouts": 3}` (`rollouts` optional, default 3, max 20); returns `{"tier", "solve_rate",
  "solved", "verifier_errors", "model", "rollouts": [...]}`. Needs Ollama on
  `localhost:11434` and answers 502 when it cannot be reached. Rollouts run one after
  another, so the call blocks for as long as the model takes.

`/lint` and `/verify` take a task packet as JSON. All POST endpoints answer 400 when the
body is malformed.

```bash
python main.py
```
