# Gauge — Product Requirements Document (PRD)

> One page. Version 2: the 28-day, four-phase plan, and what is actually built (2026-11-13).
> Version 1 (day 1) was 21 days / three phases, with no verification layer.

## Problem

Building an AI system that produces **reliable human-labeled data** and uses it to
**improve a model** is hard to demonstrate in an interview. Gauge proves the whole loop at
miniature scale: recruit experts, run a quality-checked task campaign whose tasks are
machine-verified, land the data in a warehouse, train and benchmark a small model.

## Users

- **Authors**: CAD experts who write tasks (prompt, spec, CadQuery reference).
- **Reviewers**: score tasks against the rubric with evidence; also clear the intake queue.
- **Adjudicators**: resolve split reviews. The **lead** may too.
- **Admin**: the builder; runs intake, plants gold tasks, reads agreement and calibration.

## Scope (in)

| Phase | Days | Scope |
|---|---|---|
| 1 · Front door | 1–6 | Two independent npm apps (React web, NestJS API) on PostgreSQL; JWT auth with roles; intake agent (M1) scoring CVs with evidence and confidence, low confidence routed to a human; task campaign (M2): two reviewers with evidence per criterion, IAA, gold calibration, adjudication with a small-team escape. |
| 2 · Verification | 7–13 | Layer 2, additive and behind one HTTP service: requirement extraction and Packet Lint (M7), Verifier Pack (M8: executed CadQuery geometry), Probe Gate (M9: model rollouts → difficulty tier), wired into authoring as a pre-submit check and a server-side gate. |
| 3 · Data backbone | 14–19 | Scheduled ingestion (Dagster), tested warehouse (dbt on DuckDB), read-only semantic layer (MCP). |
| 4 · Model loop | 20–28 | cad-spec release, synthetic generator, two small-model training runs, held-out benchmark page. |

Phase 1 is unchanged from version 1; phases 3 and 4 are version 1's phases 2 and 3, moved back
seven days to make room for verification.

## Scope (out)

- Anything from a client project. Gauge data only.
- Microservices beyond the one verification seam, multi-region, real production operation.
- PCB and circuit verification (in the plan for M8, not built; M8 is CAD only).
- Deep RL research or large-model training.

## Success metrics (gates)

| Gate | Criterion | State (2026-11-13) |
|---|---|---|
| **1 (day 6)** | live URL | **not met**: runs locally only |
| | green CI | CI runs typecheck, API tests, builds and the Python suites |
| | intake-agent agreement rate on the 20-pair golden set | **measured: 4/20 = 20 %** (`npm run golden`; see below) |
| | published pipeline spec | `docs/pipeline.md` |
| | ≥ 1 contributor task submitted | depends on the live database; not recorded here |
| **2 (day 13)** | M7–M9 built and wired into submission and review | pre-submit check, server-side lint gate and stored verdicts built; verdicts are not shown on the Review screen; the probe is a service endpoint the API does not call yet |
| | verifier agreement with human verdicts | **measured on the 10-task Layer 2 golden set: 8/10 = 80 % (seeded, in-sample)**, kappa 0.58 (`npm run verifier-golden`; see below) |
| **3 (day 19)** | all dbt tests pass, dashboard on the semantic layer, retro with real campaign numbers | not started |
| **4 (day 28)** | held-out scores before and after training, with a failure analysis | not started |

The plan gives the verification phase a list of deliverables but no gate of its own; Gate 2
above is that list. Gates 3 and 4 are version 1's Gates 2 and 3, moved to the new phase ends.

**Gate 1 harness.** `apps/api/src/intake/golden/` scores the golden set
(`apps/api/prisma/golden-set.json`) with the configured intake provider, no database needed. A
criterion agrees when the agent is within 1 point of the gold score; a pair passes when all
four agree; a pair the model cannot score is a failure. The agreement rate is passed pairs / 20.
It also reports per-criterion error and bias, routing agreement, and the rate without pairs
that repeat a few-shot example.

**First result and failure analysis.** `intake-v3-fewshot@ollama/qwen3.5:9b-q4_K_M`: 20 %
(17 % without the two leaked pairs); mean bias −2.05 on communication, −1.10 on scripting.
The gold labels credit communication and general programming that the intake prompt's anchors
tell the model not to credit. The rubric definition has to be reconciled (labels or prompt)
before the number means much. Full output: `docs/results/`.

**Gate 2 harness.** `GET /tasks/verifier-agreement` (admin) compares, over decided normal
tasks, the latest stored verifier run on the reference (`passed`: every machine verdict passed)
with the human decision (ACCEPTED / REJECTED, by consensus or adjudication). A decided task
with no verifier run is counted apart, never as a fail. `npm run verifier-golden` (from
`apps/api`) seeds the golden set (`apps/api/prisma/verifier-golden-set.json`, references in
`prisma/verifier-golden/`): ten CAD tasks, four correct references and six broken ones (wrong
dimension, wrong hole size, wrong hole count, dead code twice, a part cut in half). Each goes
through the real create path (extract, lint, verify, store) and gets two peer reviews whose
rubric scores give its label. Labels are objective facts of each reference (correct or broken),
authored by the verifier's author with its known gaps in mind — so this is a smoke test of the
measurement, not a blind or independent accuracy estimate.

**Gate 2 result.** Verifier `m8-static-cad` with executed geometry (cadquery 2.7.0): 8/10 =
80 %, Cohen's kappa 0.58 — a seeded, in-sample number (scripted reviews, author-authored set),
not an accuracy estimate. Confusion (human × verifier): accept/pass 3, accept/no pass 1,
reject/pass 1, reject/no pass 5. Both disagreements are documented gaps of M8. A **false
pass**: holes drilled in a branch that never runs; sizes are measured on the executed solid,
but holes are still read statically. A **false fail**: a correct flange whose hole points come
from a list comprehension; the static hole count is `not_run`, and `not_run` is not a pass.
Ten tasks is a smoke test of the measurement, not an estimate of the verifier's accuracy.
Without cadquery the size checks fall back to static reading, and the dead-code and cut-part
cases would measure nothing real; the harness records the mode it ran in. Full output:
`docs/results/gate2-verifier-agreement-2026-11-13.*`.

## Architecture (one paragraph)

One PostgreSQL database is the **source of truth**. The API (NestJS, JWT) writes to it; the web
app (React) talks only to the API. The API reaches the verification layer (`verify/`, Python
standard library, port 4000) over HTTP only: `/extract`, `/lint`, `/verify`, `/probe`.
Verification stores its results in its own five tables keyed by `taskId`. Later, Dagster copies
the database into a dbt warehouse on a schedule, and the model loop consumes only reviewed,
accepted tasks. Data flows one way, so downstream failure can never corrupt the campaign.

## Non-negotiable rules

Your data only. Version everything that affects a score (prompts, rubrics, extraction
version, pipeline spec). Hold out before training. Publish failures.

## Risks (top four)

- **Few contributors.** Run with two people plus yourself; the adjudication escape keeps
  splits from stalling; report the small sample.
- **Golden labels and rubric disagree.** This has already happened: re-label or re-anchor,
  and version the change.
- **Verification breaks Layer 1.** Keep Layer 2 additive: new tables keyed by `taskId`,
  one HTTP seam, no edits to Layer 1 tables.
- **Flat training result.** Publish it; a clear failure analysis is still a full loop.

---

*Status, quickstart and module detail: `README.md`. Review rules: `docs/pipeline.md`.
Verification: `verify/README.md`.*
