# Gauge — Task Pipeline Spec (M2)

> The spec for the task campaign: how a CAD task is written, reviewed, and accepted.
> Version 1 — Day 4.

## Purpose

Define the rules that turn a volunteer's submission into a **verifiable, reviewed CAD task**
that can later train a model. This document is the "how we keep quality" answer for the
campaign phase (days 7–12).

## 1. Task template

A task is a row in `tasks` with three required pieces:

| Field | Meaning | Rule |
|-------|---------|------|
| `prompt` | The instruction a solver reads | Plain language, self-contained |
| `spec` | Precise requirements: target shape, dimensions, constraints, tolerances | Must be machine-checkable |
| `reference` | A working reference solution (CadQuery) | Must actually satisfy the spec |

**Hard rule:** a task without a verifiable reference solution is not a task. The reference is
what makes the task checkable by the cad-spec verifier (M5) later.

## 2. Task review rubric

Every task is scored 0–5 on five criteria, each with an evidence quote from the task:

1. **Verifiable** — can a deterministic checker decide pass/fail?
2. **Unambiguous** — would two solvers read the spec the same way?
3. **Correct reference** — does the reference actually satisfy the spec?
4. **Complete constraints** — dimensions/tolerances fully specified, no free parameters.
5. **Appropriate difficulty** — in scope, not trivial, not impossible.

**Acceptance bar:** every criterion ≥ 3, and *Verifiable* ≥ 4. Two reviewers per task.

## 3. Gold tasks

A small set of tasks with known-good reference solutions (and a few deliberately broken ones),
mixed into the review queue at ~20%. They measure **reviewer accuracy**: does a reviewer
accept the good ones and reject the broken ones? A reviewer who drifts from the gold answers
is flagged, not fired — the gold set is a calibration instrument, not a test of loyalty.

## 4. QA layers (top to bottom)

1. **Author self-check** — the reference solution must run and satisfy the spec before submit.
2. **Peer review** — two reviewers score the rubric (`task_reviews`).
3. **Gold tasks** — calibrate reviewer accuracy.
4. **Inter-annotator agreement (IAA)** — reviewers' agreement per criterion; low IAA means
   the task or rubric is unclear, not that a reviewer is bad.
5. **(M5) cad-spec verifier** — a deterministic geometry check on every accepted task's
   reference before it enters the training set.

## 5. Throughput math (days 7–12)

Assumptions: 4 contributors, 2 reviewers, 6 active campaign days.

| Step | Rate | Total |
|------|------|-------|
| Task writing | 3 / contributor / day | 4 × 3 × 6 = **72 tasks** |
| Review | 12 / reviewer / day | 72 tasks × 2 reviews = 144 reviews → 6 days |
| Acceptance | ~50% | ~**36 accepted tasks** |

**Fallback:** if fewer than ~100 accepted tasks exist by day 12, the M5 synthetic generator
supplies training data and expert tasks are reserved for the held-out set only.

**Cost per accepted task** = (reviewer hours + compute) ÷ accepted tasks — reported in the
phase-2 retro from the warehouse's `fct_campaign_daily` model.

## 6. Risks

| Risk | Sign | Cut / change |
|------|------|--------------|
| Few contributors | no sign-ups by day 6 | run with 2 people + yourself; report the small sample plainly |
| Low IAA | agreement under ~0.7 on a criterion | tighten the spec template or drop the ambiguous criterion |
| Too few accepted tasks | under ~100 by day 12 | lower the non-verifiable bars; lean on synthetic data |
| Reviewer drift | gold-task accuracy drops | recalibrate with the gold set; add a second reviewer |

## 7. What the dashboard must answer

The phase-2 warehouse models (`fct_tasks`, `fct_agreement`, `fct_campaign_daily`) report:

- tasks written / reviewed / accepted per day,
- inter-annotator agreement per criterion,
- cost per accepted task.

These are the real numbers the phase-2 retro is built on — whatever they are.
