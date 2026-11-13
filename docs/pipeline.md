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

### 2.1 Review protocol

Scores are whole numbers. Each review yields a verdict (accept / reject) from the acceptance
bar; the reviewer never sets the verdict directly. A review must score every criterion and
give a non-empty evidence note for each; the API refuses a review with any criterion unscored
or without evidence, and the form pre-fills nothing, so a skipped criterion never enters the
agreement statistic as a default score.

| Reviews in | Task status | What happens |
|------------|-------------|--------------|
| 0 | `SUBMITTED` | waiting for a first reviewer |
| 1 | `IN_REVIEW` | waiting for a second, independent reviewer |
| 2, same verdict | `ACCEPTED` / `REJECTED` | decided |
| 2, different verdicts | `IN_REVIEW` | adjudication opened |
| adjudicated | `ACCEPTED` / `REJECTED` | decided; the adjudicator's verdict is final |

Rules:

- **Identity.** A reviewer is an expert (`experts` row). No anonymous reviews.
- **Independence.** Nobody reviews their own task, and nobody reviews a task twice. The task
  API returns a review only as who wrote it and when, with no scores, evidence or verdict,
  until the task is decided or split and awaiting adjudication. Only the second review can
  move a task into either state, so in practice a reviewer never sees the other review
  before submitting their own. From then on both reviews come back in full (scores, evidence
  and verdict), because the adjudicator needs the dispute. Release depends on the task's
  state, not on who is asking, so anyone who can see the task gets both reviews, including
  the two reviewers once they have split. A gold clone never leaves the redacted form (§3).
  The admin-only agreement and calibration reports read verdicts directly.
- **Exactly two.** A third peer review is refused; a decided task is closed to review.
- **Adjudication.** A split is recorded as a `review_decisions` row (`subject_type = task`,
  verdict `NEEDS_REVIEW`). A third expert — not the author, not either reviewer — resolves
  it to `APPROVE` or `REJECT` with a written reason. Who may adjudicate at all: the
  adjudicator and admin roles, and the designated lead (`users.isLead`, set by an admin at
  registration), whatever the lead's role.
- **Small-team escape.** With one author and two reviewers, or 2 people plus yourself (§6),
  there may be no independent third expert, and a split would stay `IN_REVIEW` for ever. So
  the designated lead or an admin may adjudicate a task they wrote or reviewed, but only
  while nobody who may adjudicate is independent of it. Once an independent adjudicator
  exists, the normal rule applies again. An escaped decision is marked in its
  `task.adjudicated` event (`conflict: author | reviewer`; `null` for an independent one), so
  the report can count and show it. The split appears in the lead's queue only when the
  escape applies, and each task view carries `canAdjudicate` for the signed-in user.

## 3. Gold tasks

A small set of tasks with known-good reference solutions (and a few deliberately broken ones),
mixed into the review queue at ~20%. They measure **reviewer accuracy**: does a reviewer
accept the good ones and reject the broken ones? A reviewer who drifts from the gold answers
is flagged, not fired — the gold set is a calibration instrument, not a test of loyalty.

Each gold task stores its known answer (`gold_expected_accept`). Reviewers cannot tell a gold
task from a normal one: the marker and the answer are never returned by the task API. A gold
review never changes the gold task's status (only its reviewer's clone moves to `IN_REVIEW`,
as a normal task would after one review), is not capped at two reviewers, and is left out of
IAA. A gold task therefore never becomes `ACCEPTED` and never reaches the training set.

A gold task is never shown to a reviewer as itself. One long-lived row shared by every
reviewer cannot pass for a normal task: its visibility and queue place would follow one
reviewer's history while normal rows follow everyone's, so a reviewer could diff views over
time and spot it. Instead, when a gold review falls due for a reviewer (one per block of five
of their reviews, at a point inside the block derived from the reviewer and the block), the API
writes a **clone** for that reviewer alone: a task row with its own id, status `SUBMITTED`, no
reviews, and its own copy of the lint findings and verifier runs (with the requirement and
rubric item ids drawn afresh). To that reviewer it is an ordinary task:

- **Its time says nothing about the request.** Its `createdAt` is a random instant between two
  consecutive real tasks of the gold's campaign, and its id is a cuid minted at that same time
  (borrowing the fingerprint and counter of the real task written just before), so the id's
  timestamp agrees with `createdAt`. The copied lint findings and verifier runs are dated and
  id'd the same way, at the source's offsets from its own `createdAt`.
- **It sits where its review is due.** Its id is drawn so that its hash places it in the
  reviewer's queue exactly as many rows from the head as reviews remain before the block's gold
  point (at the head if they are behind). A reviewer who works the queue from the head meets it
  at that point, so one review in five is gold whatever the backlog. It never moves against
  its neighbours afterwards.
- **It stays after review.** The review is stored on the clone, which then reads as a task with
  one review (`IN_REVIEW`, the reviewer's own redacted review): it stays in their list, leaves
  their queue, and the campaign count does not change. Calibration scores the review against
  the answer on the gold the clone copies.

A reviewer holds at most one unreviewed clone at a time (a unique column set only while the
clone is open), and is never given the same gold twice (unique gold-and-reviewer pair).

Regular tasks and clones are ordered by a hash of their id, not by age. That order is the same
for every reviewer and does not move between reviews. Hiding `createdAt` would not hide age,
because task ids are cuids that carry their creation time. A per-reviewer order redrawn after
each review was tried and dropped: it sent the two reviewers of a task to different tasks, so
second reviews stalled. The cost of the shared order is that the oldest work is no longer
drained first. Task views omit `updatedAt`.

Visibility is decided from the row alone, never from anyone's history. Normal tasks are visible
to everyone, gold tasks to admins only, and a clone only to the reviewer it was written for,
not even to admins. The plain list, the queue, a campaign filter, a single-task read,
`GET /tasks/:id/verification`, `POST /tasks/:id/reviews` and `POST /tasks/:id/adjudication` all
apply that rule first, so a hidden id answers exactly like a missing one. A campaign's task
count is what the viewer can see of it. Review is blind: reviewers and adjudicators do not see a
task's author, since only an admin writes gold and an admin author would mark it.

Known limits:

- A clone is backdated, but it is written when the reviewer fetches their list, so it is absent
  from any copy of the list they saved earlier: a row that appears with an old `createdAt` is a
  signal to a reviewer who diffs snapshots.
- A reviewed clone gets no second review and no decision; a normal task the reviewer reviewed
  goes on to `ACCEPTED`, `REJECTED` or adjudication. A clone that stays `IN_REVIEW` for long is
  a signal.
- A clone always lands within the first five places of the queue. A normal task lands at a
  uniformly random place, so on a large backlog a new row near the head is rare and points at
  gold. The rate is exact only for a reviewer who works from the head; one who skips ahead
  meets the clone later, falls behind, and the next clone goes to the head.
- The gold share is capped by supply: a reviewer is never given the same gold twice, so once
  they have seen every gold task no more clones are written.
- The rate assumes the unfiltered queue (what the web UI fetches). A clone belongs to its
  gold's campaign, so a reviewer who only works one campaign's queue may not meet it, and no
  further clone is written until they review it.
- Clones are written only when the list is fetched. A client that fetches once and then
  reviews many tasks gets no gold in that stretch, then head-placed clones while it catches up.
- A clone's id borrows the counter of the real task written before it, plus one to three, which
  can repeat a counter used by that task's own lint and verifier rows: a reviewer comparing ids
  closely could see a counter out of order.

**Reviewer accuracy** = gold reviews whose verdict matches the known answer ÷ gold reviews.
A reviewer is flagged below **0.8**, once they have at least **5** gold reviews. The flag is
a prompt to recalibrate; it never blocks a reviewer.

## 4. QA layers (top to bottom)

1. **Author self-check** — the reference solution must run and satisfy the spec before submit.
2. **Peer review** — two reviewers score the rubric (`task_reviews`).
3. **Gold tasks** — calibrate reviewer accuracy.
4. **Inter-annotator agreement (IAA)** — reviewers' agreement per criterion; low IAA means
   the task or rubric is unclear, not that a reviewer is bad.
5. **(M5) cad-spec verifier** — a deterministic geometry check on every accepted task's
   reference before it enters the training set.

**How IAA is measured.** Per criterion, over non-gold tasks with two reviews: Krippendorff's
alpha with the interval metric (1 = perfect agreement, 0 = no better than chance). It is used
because the pair of reviewers changes from task to task and because it corrects for chance.
The same statistic is reported for the accept / reject verdict, alongside the plain share of
identical scores and of scores within one point. "Low IAA" means alpha under **0.7**, and is
only called once at least **10** tasks have two reviews — fewer than that is reported as
insufficient data.

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
