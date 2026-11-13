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

### Auth

Every API route except `GET /health`, `POST /auth/login` and `POST /auth/register` needs
`Authorization: Bearer <jwt>`. Set `JWT_SECRET` (32+ characters) in `apps/api/.env` or the
API will not start. `npm run prisma:seed` creates two logins: `admin@gauge.local` /
`gauge-admin-dev` and `reviewer@gauge.local` / `gauge-reviewer-dev` (override with
`SEED_ADMIN_PASSWORD` / `SEED_REVIEWER_PASSWORD`). Roles: an **author** creates tasks, a
**reviewer** reviews them, an **adjudicator** resolves split reviews, an **admin** may do all
three. Public registration creates authors; an admin's token may register any role:

```bash
curl -X POST http://localhost:3000/auth/register -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Ada","email":"ada@example.com","password":"at-least-8","role":"adjudicator"}'
```

Other useful commands:

```bash
npm run build      # build web + API
npm run typecheck  # typecheck every workspace
npm run db:down    # stop PostgreSQL
```

## M1 — Intake agent (score a CV against a posting)

1. Create the schema and seed a sample rubric + posting:

   ```bash
   docker compose up -d
   cd apps/api
   npx prisma migrate deploy   # applies prisma/migrations
   npm run prisma:seed         # prints a posting id to use below
   ```

2. Choose the scoring backend in `apps/api/.env` (see `.env.example`):

   - **Local (default):** `LLM_PROVIDER=ollama`. Run `ollama serve`, then
     `ollama pull qwen3.5:9b-q4_K_M` (or set `OLLAMA_MODEL`). The local model is
     given four worked scorings from `src/intake/llm/examples.json` as few-shot
     turns, so it follows the same rubric calibration and reasons per criterion
     before scoring. Edit that file to change how the model scores.
   - **Claude:** `LLM_PROVIDER=anthropic` with `ANTHROPIC_API_KEY` (and optionally
     `ANTHROPIC_MODEL`).

3. Run the API and score a CV:

   ```bash
   npm run dev:api             # from apps/api
   TOKEN=$(curl -s -X POST http://localhost:3000/auth/login -H "Content-Type: application/json" \
     -d '{"email":"admin@gauge.local","password":"gauge-admin-dev"}' \
     | node -pe 'JSON.parse(require("fs").readFileSync(0)).accessToken')
   curl -X POST http://localhost:3000/intake/runs \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"cv":"...","postingId":"<id from seed>","expertName":"Bilal"}'
   ```

   The response has per-criterion `{score, evidence, confidence}`, an overall
   `confidence`, and a `needsReview` flag (true when confidence is below 0.7, which
   routes the run to the human review queue in the `review_decisions` table).
   It also returns `provider`, `model` and, for the local model, its `reasoning`.
   `promptVersion` (stored on every run) records provider and model, e.g.
   `intake-v3-fewshot@ollama/qwen3.5:9b-q4_K_M`.

## Repository layout

```
gauge/
  apps/web/          React + Vite front end
  apps/api/          NestJS: intake, campaign, core modules
  data/dagster/      ingestion jobs and schedules        (Phase 2)
  data/dbt/          warehouse models, tests, docs       (Phase 2)
  data/mcp/          semantic layer server               (Phase 2)
  model/             cad-spec release, generator, eval   (Phase 3)
  docs/              PRD, pipeline spec, architecture, retro
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
