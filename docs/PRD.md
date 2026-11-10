# Gauge — Product Requirements Document (PRD)

> One page. Version 1 — Day 1.

## Problem

Building an AI system that produces **reliable human-labeled data** and uses it to
**improve a model** is hard to demonstrate in an interview. Gauge proves the whole
loop — recruit experts, run a quality-checked task campaign, land data in a
warehouse, train and benchmark a small model — at miniature scale.

## Users

- **Contributors** — CAD experts who write tasks against a rubric.
- **Reviewers** — grade tasks (and intake decisions) to keep quality high.
- **Me** — the builder; the person who must explain and defend the whole thing.

## Scope (in)

- An intake agent that scores a CV against a posting with evidence + confidence,
  routing low-confidence cases to a human.
- A task campaign: templates, assignment, review, gold tasks, agreement metrics.
- A fullstack platform (React + NestJS + PostgreSQL + AWS).
- A data backbone: scheduled ingestion, a tested warehouse, a read-only semantic layer.
- A model loop: cad-spec release, synthetic generator, two small-model training runs,
  a public benchmark page.

## Scope (out)

- Anything from a client project (Phoenix, Titan Chrome, etc.). Gauge data only.
- Microservices, multi-region, real production operation.
- Deep RL research or large-model training.

## Success metrics (the three gates)

1. **Gate 1 (day 6):** live URL, green CI, an intake-agent agreement rate on a
   20-pair golden set, a published pipeline spec, ≥1 contributor task submitted.
2. **Gate 2 (day 12):** all dbt tests pass, dashboard reads from the semantic layer,
   retro reports real campaign numbers.
3. **Gate 3 (day 21):** held-out scores before/after training, published with a
   failure analysis. A flat result still counts if explained.

## Architecture (one paragraph)

One PostgreSQL database is the **source of truth**. The app writes to it; Dagster
copies it into a warehouse (dbt on DuckDB) on a schedule; the model loop consumes
only reviewed, accepted tasks. Data flows one way, top to bottom, so downstream
failure can never corrupt the campaign.

## Non-negotiable rules

- Your data only. Version everything that affects a score. Hold out before training.
  Publish failures.

## Risks (top three)

- **Few contributors** → run with 2 people + yourself, report the small sample.
- **AWS eats day 1** → deploy API on a simpler host, move to AWS in Phase 2.
- **Flat training result** → publish it; a clear failure analysis is still a full loop.

## Timeline

Three phases (front door → data backbone → model loop), 21 focused days, one gate each.

---

*Detailed day-by-day plan: see `README.md`.*
