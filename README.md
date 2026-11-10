# Gauge

A miniature **human-data lab for CAD reasoning**, built end to end in ~3 weeks.

Gauge runs one loop, top to bottom:

```
recruit experts → quality-checked task campaign → warehouse → train + benchmark a small model
```

It's a portfolio project: each module is the first deliverable of a target role, and every
step is measured honestly.

## What's inside

| Module | What it proves | Role it speaks to |
|--------|----------------|-------------------|
| M1 Intake Agent | LLM agent with an eval set + human review path | Talent Automation Lead |
| M2 Task pipeline | Spec a pipeline, run contributors, report quality | Strategic Project Lead |
| M3 Platform | Fullstack app: React, NestJS, PostgreSQL, AWS | Software Engineer |
| M4 Data backbone | Tested warehouse agents can query safely | Data Engineering |
| M5 Model loop | Train a model on your own data, measure it | Research Engineering |
| M6 Proof package | Explain it all in three minutes | All six |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Web app (React) ──► API (NestJS) ──► PostgreSQL (source of truth) │
│                                                │                    │
│                                     Dagster ingestion (scheduled)  │
│                                                ▼                    │
│                                     Warehouse (dbt on DuckDB)       │
│                                                │                    │
│                                     Semantic layer (read-only MCP) │
│                                                │                    │
│  Model loop (cad-spec verifiers + RL) ◄── accepted tasks (export) │
└─────────────────────────────────────────────────────────────┘
```

Data flows **one way**. Nothing downstream writes back into the app database, so a broken
pipeline or training run can never corrupt the campaign.

## Quickstart

Prerequisites: Node 22+, Docker.

```bash
# 1. Install dependencies (one lockfile per app; no symlinks)
npm run setup

# 2. Start PostgreSQL (the source of truth)
npm run db:up

# 3. Run the API (http://localhost:3000)
npm run dev:api

# 4. In another terminal, run the web app (http://localhost:5173)
npm run dev:web
```

Open http://localhost:5173 — the app calls `GET /api/health` to confirm the front end and
back end are wired together.

Other useful commands:

```bash
npm run build      # build web + API
npm run typecheck  # typecheck every workspace
npm run db:down    # stop PostgreSQL
```

## Repository layout

```
gauge/
  apps/web/          React + Vite front end
  apps/api/          NestJS: intake, campaign, core modules
  data/dagster/      ingestion jobs and schedules        (Phase 2)
  data/dbt/          warehouse models, tests, docs       (Phase 2)
  data/mcp/          semantic layer server               (Phase 2)
  model/             cad-spec release, generator, eval   (Phase 3)
  docs/              PRD, architecture, retro
  .github/workflows/ CI for app + dbt + eval
```

## Learn the project

The one-page spec is in [docs/PRD.md](./docs/PRD.md). The roadmap below shows the
three phases and their gates.

## Roadmap

Three phases, three gates, 21 focused days.

| Phase | Days | Builds | Gate |
|-------|------|--------|------|
| 1 · Front door | 1–6 | App, intake agent, campaign | Live URL, green CI, agreement rate, ≥1 task |
| 2 · Data backbone | 7–12 | Ingestion, warehouse, semantic layer | dbt tests pass, dashboard on semantic layer, retro |
| 3 · Model loop | 13–21 | cad-spec release, RL, benchmark | Held-out before/after + failure analysis |

## Rules that hold across every module

- **Your data only.** Nothing from any client project.
- **Version everything that affects a score.** Prompts, rubrics, pipeline spec.
- **Hold out before you train.** The held-out set is split on day 13 and never touched.
- **Publish failures.** A flat result with a clear failure analysis still counts.

## Honest scope

Built in ~3 weeks, used by a handful of people. It proves the **loop**, not years of
experience, people management, production operation, or deep RL — and it says so.
