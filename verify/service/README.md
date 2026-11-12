# Verify service — HTTP wrapper

The single seam between Layer 1 (NestJS API) and Layer 2 (verification). The API calls this
service instead of importing verification code, so Layer 2 stays a separate deployable.

Runs on `http://127.0.0.1:4000`.

- `GET /health`
- `POST /lint` — M7 Packet Lint; returns `{"findings": [...]}`
- `POST /verify` — M8 Verifier Pack; returns `{"verdicts": [...]}`, one per
  machine-checkable rubric item

Both POST endpoints take a task packet as JSON and answer 400 when it is malformed.

```bash
python main.py
```
