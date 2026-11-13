# M9 — Probe Gate

Asks a local Ollama model to solve a task N times, scores each attempt with the M8 Verifier
Pack dimension and hole checks and returns a difficulty tier.

```python
from probe import probe
result = probe(packet, "qwen2.5-coder:7b")  # 3 rollouts by default
# {"tier", "solve_rate", "solved", "verifier_errors", "model", "rollouts": [...]}
```

| tier   | rule                                   |
| ------ | -------------------------------------- |
| t0     | solve_rate > 0.8 (too easy)            |
| t1     | 0.4 <= solve_rate <= 0.8 (in band)     |
| t2     | solve_rate < 0.4 (hard)                |
| broken | verifier errors and solve_rate == 0    |

- **Solved**: the packet has at least one `geometry_cad` or `static_cad` verdict and all
  of them pass. `manifold_volume` verdicts are ignored.
- **Verifier error**: a rollout the verifier could not judge — it raised, the packet has
  no `geometry_cad` or `static_cad` check, or nothing failed but a check came back
  `not_run` (a quantity the checks do not cover, or code the static reader cannot
  resolve). A rollout with any failed check, including code that does not parse or that
  builds no solid, is a failed rollout, not a verifier error.
- The model sees only the packet's `prompt` and `spec`, never `reference`.
- **Generated code is executed** by the verifier, in a worker process with a timeout, to
  measure the solid it builds. A timeout is not a sandbox: the code runs with your
  permissions. Set `GAUGE_CAD_EXEC=0` to score from the static reading alone, without
  running anything.
- `rollout()` posts to `$OLLAMA_BASE_URL/api/generate` (default `http://localhost:11434`,
  timeout `OLLAMA_TIMEOUT_MS`, default 300 s, both read when the module loads) and raises
  `OllamaError` when the server is down or the model is unknown, so an infrastructure
  failure is never reported as a tier.

Standard library only (the worker needs cadquery, see the M8 README). Tests need no
live Ollama:

```bash
python -m unittest discover -s verify/probe/tests -v
```

The API runs it with `POST /tasks/:id/probe` (admin only, body `{"rollouts": 3, "model": "..."}`,
both optional; the model defaults to `OLLAMA_MODEL`). It stores one `ProbeRun` per call,
with `status` `OK` (tier and solve rate set), `NOT_RUN` (verify service or Ollama
unreachable) or `FAILED` (an unusable answer), and `GET /tasks/:id/verification` returns
the latest one to admins as `probeRun`.

Not yet built: running two models per task, and writing the tier back to the task record.
