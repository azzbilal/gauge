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
| 1 · Front door | 1–6 | App, auth, intake agent (M1), task campaign + review protocol (M2) | **built**; not deployed (no live URL yet) |
| 2 · Verification (Layer 2) | 7–13 | Packet Lint (M7), Verifier Pack (M8), Probe Gate (M9), wired into authoring | **built** except: probe not called by the API, verdicts not on the Review screen, CAD only (no PCB/circuit checks), verifier agreement not measured |
| 3 · Data backbone | 14–19 | Dagster ingestion, dbt warehouse, read-only MCP semantic layer (M4) | planned (`data/` holds placeholders) |
| 4 · Model loop | 20–28 | cad-spec release, synthetic generator, training runs, held-out benchmark (M5) | planned (`model/` holds a placeholder) |

The plan grew from 21 days / 3 phases to 28 / 4 by inserting the verification layer as
Phase 2; Phase 1 is unchanged, and the data backbone and model loop each moved back seven days.

## Gate 1 — measured

Gate 1 asks for an intake-agent **agreement rate on the 20-pair golden set**
(`apps/api/prisma/golden-set.json`: 20 CVs scored by hand on the four rubric criteria).

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
Full output: [docs/results/](./docs/results/).

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

The next step is to reconcile the rubric anchors and the labels (re-label, or change the
prompt) and re-run, keeping the prompt version in the result. Until then Gate 1's number is
20 %.

## Architecture

```
            ┌──────────────── Layer 1 ────────────────┐      ┌──────── Layer 2 ────────┐
 browser ─► │ apps/web (React + Vite)                  │      │ verify/service (Python)  │
            │   └─► apps/api (NestJS, JWT) ───────────────HTTP──► /extract /lint /verify │
            │          │                               │      │ /probe → Ollama          │
            │          ▼                               │      └──────────────────────────┘
            │   PostgreSQL (source of truth)           │
            └──────────┬───────────────────────────────┘
                       ▼  one way, scheduled (planned)
            Dagster → dbt on DuckDB → MCP semantic layer → model loop (accepted tasks only)
```

- **Two independent npm apps.** `apps/web` and `apps/api` each have their own
  `package.json` and lockfile; there are no workspaces and no symlinks. The root
  `package.json` only holds scripts that `cd` into each app, and CI installs each with
  `npm ci` in its own directory.
- **Layer 2 is additive.** It has its own tables keyed by `task_id` (`requirements`,
  `rubric_items`, `lint_findings`, `verifier_runs`, `probe_runs`), its migration only creates,
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
queue (`review_decisions`), and a Slack alert fires when a webhook is set. Every run stores
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
  Available as `POST /probe`; the API does not call it yet.
- **Wiring.** The Author view's "Run check" calls `POST /tasks/preview` (lint + verify,
  nothing stored). `POST /tasks` lints before inserting and refuses a task with a critical
  finding; then verifies and stores the results, readable at `GET /tasks/:id/verification`.

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
npm run golden      # Gate 1 harness (needs the model)
```

CI runs typecheck, the API tests, both builds and the three Python suites on every push to
main and every pull request.

## Repository layout

```
gauge/
  apps/web/          React + Vite: login, campaigns, author, review
  apps/api/          NestJS: auth, intake (M1), campaign + tasks (M2), review queue, verify client
    prisma/          schema, migrations, seed, golden-set.json (Gate 1)
  verify/            Layer 2 (Python): lint/ (M7), verifiers/ (M8), probe/ (M9), service/
  data/              Phase 3 placeholders: dagster/, dbt/, mcp/
  model/             Phase 4 placeholder
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
done: deployment (no live URL, no AWS), the data backbone, the model loop, the probe in the
API, verifier agreement, and an intake agreement rate worth defending.
