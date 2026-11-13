# Layer 2 — Verification

The verification layer checks every task automatically before and during the Layer 1
review loop. It is **purely additive**: it has its own tables keyed by `taskId`, it changes
no Layer 1 table, and the API reaches it only over HTTP (`service/`), so it deploys
separately. Python 3, standard library only; executing CadQuery references additionally
needs an interpreter with `cadquery` (see `verifiers/`).

| Component | Module | What it does | Status |
|---|---|---|---|
| `lint/extract.py` | M7 | The **only** parser of task prose. Reads named dimensions, `A x B x C` triples and hole counts out of a prompt and spec, returns requirements plus one rubric item per review criterion, each tagged machine or manual. Versioned (`extract-7`). | built |
| `lint/` | M7 Packet Lint | Three deterministic rules over a packet: traceability, value contradiction (prompt vs spec), check-method tagging. | built |
| `verifiers/` | M8 Verifier Pack | CAD only. Executes the reference in a worker process and measures the solid (box size, volume); reads hole size and count statically; falls back to a static reading of box size when cadquery is missing. | built (CAD); manifold, PCB and circuit checks not built |
| `probe/` | M9 Probe Gate | Asks a local Ollama model to solve a task N times, scores each attempt with M8 and assigns a difficulty tier. | built as a service endpoint; **not called by the API** yet |
| `service/` | — | HTTP wrapper on `127.0.0.1:4000`: `/health`, `/extract`, `/lint`, `/verify`, `/probe`. | built |

## How the API uses it

| When | Calls | Effect |
|---|---|---|
| Author clicks "Run check" (`POST /tasks/preview`) | `/extract`, then `/lint` and `/verify` | Findings and verdicts shown in the Author view; nothing stored. Either half that cannot run reports `not_run`, never clean. |
| Task create (`POST /tasks`) | `/extract`, `/lint` | **Gate:** a critical lint finding refuses the task (422). A service that answered badly refuses it too. Only an unreachable or timed-out service lets the task through, recorded as unlinted: `linted: false` in the response and the `task.created` event, plus a `lint_not_run` finding row. |
| After create | `/verify` | Requirements, rubric items, lint findings and verifier runs are stored; `GET /tasks/:id/verification` returns them. A verify failure never fails the create. |

The API parses nothing itself (`apps/api/src/verify/packet-builder.ts` only arranges the
`/extract` answer into rows and a packet) and records the extraction version in the
`task.created` event.

## Tables

`Requirement`, `RubricItem`, `LintFinding`, `VerifierRun`, `ProbeRun`
(`apps/api/prisma/schema.prisma`, migration `0003_verification`: `CREATE` only, no `ALTER` on a
Layer 1 table). `ProbeRun` exists but nothing writes to it yet.

## Tests

```bash
python -m unittest discover -s verify/lint/tests -v
python -m unittest discover -s verify/verifiers/tests -v   # geometry tests skip without cadquery
python -m unittest discover -s verify/probe/tests -v       # no live Ollama needed
```

CI runs all three on the runner's own Python, without cadquery.
