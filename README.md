# Gauge

A miniature **human-data lab for CAD reasoning**: recruit CAD experts, run a quality-checked
task campaign, land the data in a warehouse, then train and benchmark a small model on it.
Every step is measured, and failures are published with the numbers.

```
recruit experts → verified, reviewed task campaign → warehouse → train + benchmark a small model
```

It is a portfolio project built on a **28-day, four-phase plan**. This README describes what
is built today and what is still a plan; the one-page spec is [docs/PRD.md](./docs/PRD.md),
the review rules are [docs/pipeline.md](./docs/pipeline.md).

## Status at a glance

| Phase | Days | Builds | State |
|---|---|---|---|
| 1 · Front door | 1–6 | App, auth, intake agent (M1), task campaign + review protocol (M2) | **built and deployed**: web on Vercel; API, verify service and Postgres on Render (free tier). Intake agreement **18/20 = 90 %, prompt-tuned on the eval set** (in-sample; see Gate 1) |
| 2 · Verification (Layer 2) | 7–13 | Packet Lint (M7), Verifier Pack (M8), Probe Gate (M9), wired into authoring | **built**. Stored lint and verifier verdicts show on the Review screen once the reviewer has submitted (hidden while scoring). CAD only (no PCB/circuit checks); verifier agreement measured on a 10-task seeded golden set only (8/10, in-sample) |
| 3 · Data backbone | 14–19 | Dagster ingestion, dbt warehouse, read-only MCP semantic layer (M4) | **built except the MCP layer**: `warehouse/` holds the Dagster job, dbt on DuckDB (3 marts, all tests pass) and a static dashboard. The daily schedule is defined, not running; the numbers are dev data, not a real campaign ([retro](./docs/results/gate3-retro-2026-11-13.md)) |
| 4 · Model loop | 20–28 | cad-spec release, synthetic generator, training runs, held-out benchmark (M5) | **built**: [model/SPEC.md](./model/SPEC.md), generator, benchmark harness, and the campaign export (`model/export.py`) that feeds accepted campaign tasks to the benchmark, so the campaign is connected to the benchmark (exercised on dev data only; no real campaign yet; few-shot examples still come only from synthetic tasks). Few-shot run (in-context, **no weight training**): **122/300 = 41 % (Wilson 95 %: 35–46 %)** on 300 held-out tasks; 0/20 → 6/20 against zero-shot on the first 20-task set. The 300-task zero-shot baseline is still pending ([results](./docs/results/phase4-heldout300-2026-11-14.md)) |

The plan grew from 21 days / 3 phases to 28 / 4 by inserting the verification layer as
Phase 2; Phase 1 is unchanged, and the data backbone and model loop each moved back seven days.

## Gate 1 — measured

Gate 1 asks for an intake-agent **agreement rate on the 20-pair golden set**
(`apps/api/prisma/golden-set.json`: 20 CVs scored by hand on the four rubric criteria).

**Current number (2026-11-13, `intake-v5-fewshot@ollama/qwen3.5:9b-q4_K_M`): 18 / 20 pairs
agree (90 %); 16 / 18 (89 %) without the two leaked pairs. It is prompt-tuned on the eval
set:** the v5 prompt was rewritten after reading the first run's misses on these same 20 CVs
(the labels did not change), so 90 % is an in-sample number, not an estimate of agreement on
new CVs. There is no separate held-out CV set yet. Routing agreement did not move: 55 %.
Full output: [gate1-golden-2026-11-13-intake-v5.txt](./docs/results/gate1-golden-2026-11-13-intake-v5.txt).

```bash
npm run golden                                          # from the repo root; needs the model running
npm run golden -- --out report.json --min-agreement 0.8 # JSON report; exit 1 below the bar
```

`--out` is resolved from `apps/api`. Exit code 0 when every pair was scored, 1 when one was
not (or the rate is under `--min-agreement`), 2 on bad input.

The harness (`apps/api/src/intake/golden/`) scores every CV with the configured provider (the
same one `POST /intake/runs` uses), with no database or API. It prints pass/fail per pair:
a criterion agrees when the agent is within 1 point of gold, and a pair passes when all four
criteria agree. A pair the model fails to score counts as a failure, never a pass. It also
reports, per criterion, exact and within-1 rates, mean absolute error and bias, plus routing
agreement (does the agent send a CV to a human exactly when the gold confidence is below
0.7?). Pairs whose CV mostly repeats a few-shot example are flagged as leaked, and the rate
is repeated without them.

**First run (2026-11-13, `intake-v3-fewshot@ollama/qwen3.5:9b-q4_K_M`): 4 / 20 pairs agree
(20 %); 3 / 18 (17 %) without the two leaked pairs.** Routing agrees on 55 %.
Full output: [docs/results/](./docs/results/). The table and the analysis below are for this
first run; they are what led to v5.

| Criterion | exact | within 1 | MAE | bias (agent − gold) |
|---|---|---|---|---|
| cad | 45 % | 85 % | 0.70 | −0.60 |
| geo | 45 % | 80 % | 0.90 | −0.80 |
| code | 30 % | 70 % | 1.30 | −1.10 |
| comm | 0 % | 25 % | 2.15 | −2.05 |

Failure analysis: the agent scores **low on every criterion**, and most of the miss is two
criteria where the **golden labels and the intake prompt disagree about the rubric**, not
noise:

- *Clarity of communication*: the gold set gives almost every CV a 3–5 for communication,
  including CVs that say nothing about writing (a carpenter, a robotics engineer). The
  prompt says to score only what the CV states and to give 0 for no evidence, so the agent
  gives 0–2.
- *Scripting ability*: the gold set gives general programmers with no CAD a 4–5 (backend,
  frontend, data science). The prompt's anchors say "1 = only an adjacent, transferable skill
  (e.g. general Python with no CAD use)", and the agent follows them.
- gold-01 and gold-02 are paraphrases of the first few-shot example's CV, so they measure
  recall rather than judgment.

v5 reconciled the rubric by changing the prompt, not the labels: it credits the
communication a professional technical role implies, and counts programming roles as
scripting ability even when no language is named. That moved agreement from 20 % to 90 % on
the same 20 CVs. To make it a number worth defending, score a fresh set of hand-labelled CVs
the prompt was never tuned on.

## Architecture

```
            ┌──────────────── Layer 1 ────────────────┐      ┌──────── Layer 2 ────────┐
 browser ─► │ apps/web (React + Vite)                  │      │ verify/service (Python)  │
            │   └─► apps/api (NestJS, JWT) ───────────────HTTP──► /extract /lint /verify │
            │          │                               │      │ /probe → Ollama          │
            │          ▼                               │      └──────────────────────────┘
            │   PostgreSQL (source of truth)           │
            └──────────┬───────────────────────────────┘
                       ▼  one way (Dagster job; daily schedule defined, not running)
            Dagster → dbt on DuckDB → dashboard        (warehouse/; MCP semantic layer not built)
                       ▼  model/export.py (from the DuckDB copy): ACCEPTED, non-gold, reference solved
            model/: cad-spec tasks (campaign + synthetic) → local model → M8 scoring → held-out benchmark
```

- **Two independent npm apps.** `apps/web` and `apps/api` each have their own
  `package.json` and lockfile; there are no workspaces and no symlinks. The root
  `package.json` only holds scripts that `cd` into each app, and CI installs each with
  `npm ci` in its own directory.
- **Layer 2 is additive.** It has its own tables keyed by `taskId` (`Requirement`,
  `RubricItem`, `LintFinding`, `VerifierRun`, `ProbeRun`), its migration only creates,
  and the API reaches it only over HTTP. See [verify/README.md](./verify/README.md).
- **Data flows one way.** Nothing downstream writes back into the app database.

## What is built

### Auth and roles

Every route except `GET /health`, `POST /auth/login` and `POST /auth/register` needs
`Authorization: Bearer <jwt>`. The token names the user; the guard reloads them on every
request, so a changed role applies at once. Identity is always taken from the session, never
from a body field.

| Role | May |
|---|---|
| author | create tasks, run the pre-submit check |
| reviewer | review tasks; work the intake review queue |
| adjudicator | resolve split reviews |
| admin | everything above, plus campaigns, experts, intake runs, gold tasks, agreement and calibration reports, CSV export |

Public registration creates authors. An admin's token may register any role and may
designate the **lead** (`"lead": true`, any role), who may also adjudicate.

### M1 — Intake agent

`POST /intake/runs` (admin) scores a CV against a posting's rubric (CAD depth, geometric
reasoning, scripting, communication; 0–5 each) with an evidence quote and a confidence per
criterion. Below 0.7 confidence, overall or on any criterion, the run goes to the human review
queue (`ReviewDecision`), and a Slack alert fires when a webhook is set. Every run stores
its `promptVersion` (provider and model). Backends: local Ollama (default,
`qwen3.5:9b-q4_K_M`, four few-shot worked examples in `src/intake/llm/examples.json`) or
Anthropic (`LLM_PROVIDER=anthropic`).

### M2 — Task campaign and review protocol

A task is a prompt, a machine-checkable spec and a CadQuery reference. The full rules are in
[docs/pipeline.md](./docs/pipeline.md):

- **Two reviewers, with evidence.** Each scores five criteria 0–5 and must give an evidence note
  for every criterion; the API refuses a review with any criterion unscored or unexplained,
  and the form pre-fills nothing. The verdict follows from the acceptance bar (every criterion
  ≥ 3, *verifiable* ≥ 4), never from a checkbox. Reviews stay hidden from the other reviewer
  until the task is decided or split. No self-review, no third peer review.
- **Agreement.** Krippendorff's alpha per criterion over doubly-reviewed tasks; low below
  0.7, reported only from 10 tasks.
- **Gold calibration.** Admin-planted gold tasks with a known answer reach each reviewer as a
  private clone, one review in five, indistinguishable from a normal task (backdated id and
  time, queue position by id hash, hidden marker, blind author). Reviewer accuracy against
  gold flags a reviewer below 0.8 after 5 gold reviews; it never blocks them. Gold never
  becomes accepted or enters IAA.
- **Adjudication and the escape.** A split goes to a third expert who is neither the author
  nor a reviewer. In a small team with no independent adjudicator, the lead or an admin may
  resolve a split they wrote or reviewed; the decision is marked as an escape in its event.

### Phase 2 — Layer 2 verification

- **M7 Packet Lint and extraction.** `verify/lint/extract.py` (`extract-7`) is the only parser
  of task prose: requirements (named lengths, `A x B x C` triples, hole counts) and one rubric
  item per review criterion. Three lint rules: traceability, prompt-vs-spec contradiction,
  check-method tagging.
- **M8 Verifier Pack.** Executes the reference in a CadQuery worker and measures the solid's
  bounding box and volume; reads hole sizes and counts statically; falls back to a static
  reading only when cadquery is missing. A reference that crashes fails; one that times out
  is `not_run`. Never a sandbox: only run references you would run yourself.
- **M9 Probe Gate.** N local-model rollouts per task scored by M8 → tier t0/t1/t2/broken.
  Each rollout samples at temperature 0.7 with its own fixed seed, so the rollouts can
  differ, the middle tier is reachable and a re-run asks for the same samples. (At
  temperature 0 every rollout was the same answer and the rate was always 0 or 1.) This is
  shown with a mock Ollama in the tests; how often a real model lands in t1 is not measured.
  The API runs it from `POST /tasks/:id/probe` (admin only) and stores a `ProbeRun`
  (`OK` with tier and solve rate, or `NOT_RUN`/`FAILED` with a note when Ollama or the
  verify service is unavailable); `GET /tasks/:id/verification` shows admins the latest.
- **Wiring.** The Author view's "Run check" calls `POST /tasks/preview` (lint + verify,
  nothing stored). `POST /tasks` lints before inserting and refuses a task with a critical
  finding; then verifies and stores the results, readable at `GET /tasks/:id/verification`.
  The Review screen shows those stored lint findings and verifier verdicts per criterion
  once the reviewer has submitted (or on a task they can only read), never while they score.
- **Verifier agreement (Gate 2).** `GET /tasks/verifier-agreement` (admin, `?campaignId=`)
  sets the stored verifier result against the human accept/reject on decided tasks: rate,
  Cohen's kappa, confusion matrix, and every disagreement with its verdicts. `npm run
  verifier-golden` seeds the 10-task Layer 2 golden set through the real create and review
  path and reports it: **8/10 (kappa 0.58, seeded/in-sample)** with cadquery execution; see `docs/results/`.

### Phase 3 — Data backbone (`warehouse/`)

A Dagster job (`warehouse/dagster/`) copies the app's Postgres tables into DuckDB, then runs
`dbt build` and `dbt test`. The dbt project (`warehouse/dbt/`) has three marts:
`mart_campaign`, `mart_task_quality` and `mart_reviewer_calibration`; the last run passed
31/31 on build and 26/26 on test. `warehouse/dashboard/` renders a static snapshot of the
marts. Limits: the daily schedule only fires under a running Dagster daemon, the dashboard
reads the marts directly (the MCP semantic layer is not built), and the numbers come from dev
data, not a real campaign. See the [Gate 3 retro](./docs/results/gate3-retro-2026-11-13.md).

### Phase 4 — Model loop (`model/`)

The task format is frozen as cad-spec-1.0 ([model/SPEC.md](./model/SPEC.md)). A seeded
generator (`model/generate.py`) writes templated CAD tasks in five families, and the
benchmark (`model/benchmark.py`) scores a local Ollama model's answers with the M8 Verifier
Pack, with Wilson intervals and a paired McNemar comparison. The "training run" is
**in-context few-shot prompting (five worked examples), not weight training**.

The campaign is connected to this loop: `model/export.py` reads the accepted, non-gold tasks
from the warehouse copy of the database, keeps those whose reference scores solved against
its own rubric, and writes them as a cad-spec batch the benchmark reads. On the dev data it
exports 3 of 6 accepted tasks and lists why the other 3 were left out (one accepted reference
is simply wrong). No real campaign has run, so no benchmark number comes from campaign tasks
yet. How a pilot uses it: [model/README.md](./model/README.md#export-campaign-tasks).

- First 20 held-out tasks: 0/20 zero-shot → 6/20 few-shot
  ([report](./docs/results/phase4-benchmark-2026-11-14.md)).
- 300 new held-out tasks, stratified: few-shot **122/300 = 41 % (35–46 %)**. It solves every
  task with no holes or a single centred hole, except brackets, and no multi-hole task
  (0/158). The 300-task zero-shot baseline and the paired comparison are still pending
  ([report](./docs/results/phase4-heldout300-2026-11-14.md)).

"Solved" covers bounding box, hole diameter and hole count only, and the tasks come from the
same five templates as the examples, so this is not evidence of generalisation.

## Deployment

The web app is deployed on Vercel (`apps/web/vercel.json` forwards `/api/*` to the API). The
API, the verify service and Postgres run on Render as laid out in `render.yaml`, all on free
plans, so the first request after an idle spell is slow. The deployed intake agent is
configured to use Anthropic (`render.yaml`), since neither host runs Ollama, so the probe has
no model there. The deployed verify image has no cadquery, so it scores from the static
reading, not executed geometry. See
[docs/DEPLOY.md](./docs/DEPLOY.md).

## Quickstart

Prerequisites: Node 22+, Docker, Python 3 (standard library only; `cadquery` optional, for executed
geometry), and Ollama for the intake agent and the probe.

```bash
npm run setup                  # npm install in apps/web and apps/api
cp .env.example apps/api/.env  # then set JWT_SECRET (32+ characters)
npm run db:up                  # PostgreSQL in Docker
cd apps/api && npx prisma migrate deploy && npm run prisma:seed && cd ../..

python verify/service/main.py  # Layer 2 on :4000 (terminal 1)
npm run dev:api                # API on :3000 (terminal 2)
npm run dev:web                # web on :5173 (terminal 3)
```

The seed creates `admin@gauge.local` / `gauge-admin-dev` and `reviewer@gauge.local` /
`gauge-reviewer-dev` (override with `SEED_ADMIN_PASSWORD` / `SEED_REVIEWER_PASSWORD`), plus
the rubric and the posting. Register more users with an admin token:

```bash
curl -X POST http://localhost:3000/auth/register -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Ada","email":"ada@example.com","password":"at-least-8","role":"adjudicator"}'
```

For the intake agent run `ollama serve` and `ollama pull qwen3.5:9b-q4_K_M`, or set
`LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`. Executed geometry needs an interpreter with
cadquery: `GAUGE_CAD_PYTHON=/path/to/python` (see `verify/verifiers/README.md`).

### Checks

```bash
npm run typecheck   # web + API
npm test            # API unit tests (vitest)
npm run build       # web + API
python -m unittest discover -s verify/lint/tests
python -m unittest discover -s verify/verifiers/tests   # geometry tests skip without cadquery
python -m unittest discover -s verify/probe/tests
python -m unittest discover -s model/tests        # executed tests skip without cadquery
npm run golden      # Gate 1 harness (needs the model)
cd apps/api && npm run verifier-golden   # Gate 2 harness (needs the database and the verify service)
```

CI runs typecheck, the API tests, both builds and the four Python suites on every push to
main and every pull request. The warehouse's dbt tests run in the Dagster job (or with
`dbt build` / `dbt test` in `warehouse/dbt/`), not in CI.

## Repository layout

```
gauge/
  apps/web/          React + Vite: login, campaigns, author, review
  apps/api/          NestJS: auth, intake (M1), campaign + tasks (M2), review queue, verify client
    prisma/          schema, migrations, seed, golden-set.json (Gate 1)
  verify/            Layer 2 (Python): lint/ (M7), verifiers/ (M8), probe/ (M9), service/
  warehouse/         Phase 3: dagster/ (ingestion job), dbt/ (DuckDB marts), dashboard/
  model/             Phase 4: SPEC.md (cad-spec release), generate.py, export.py, benchmark.py, data/
  docs/              PRD, pipeline spec, results/
  .github/workflows/ CI
```

## Rules that hold across every module

- **Your data only.** Nothing from any client project.
- **Version everything that affects a score.** Prompts, rubrics, extraction, pipeline spec.
- **Hold out before you train.** The held-out set is split before the first training run and
  never touched.
- **Publish failures.** A flat or failing result with a clear analysis still counts.

## Honest scope

Built in weeks and used by a handful of people. It proves the **loop** and the quality
machinery around it, not production operation, scale, people management or deep RL. Not yet
done: an intake agreement rate measured on CVs the prompt was not tuned on (90 % is
in-sample), verifier agreement beyond a 10-task golden set, a real campaign in the
warehouse (the campaign export to the model loop is built but has only seen dev data), the MCP semantic layer, the 300-task zero-shot baseline, any weight training, and
hosting beyond free tiers (no AWS).
