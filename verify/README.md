# Layer 2 — Verification

The verification layer checks every task automatically before, during and after the
Layer 1 loop. It is **purely additive**: it reads Layer 1 tables and adds its own, keyed by
`task_id`, and Layer 1 reaches it through a single HTTP call.

| Component | Module | What it does |
|---|---|---|
| `lint/` | M7 Packet Lint | Parses a task packet into requirements + rubric items, checks traceability and value contradictions, tags each rubric item machine/visual/manual. |
| `verifiers/` | M8 Verifier Pack | Deterministic checkers (CAD: dimensions, holes, manifold solid, volume; PCB: files + rule-check; circuits: simulated values). |
| `probe/` | M9 Probe Gate | Runs model rollouts per task, scores them with the Verifier Pack, assigns a difficulty tier. |
| `service/` | — | Small HTTP wrapper the NestJS API calls (one call, e.g. `POST /verify`). |

Five new application tables back these (see `apps/api/prisma/schema.prisma`): `requirements`,
`rubric_items`, `lint_findings`, `verifier_runs`, `probe_runs`.
