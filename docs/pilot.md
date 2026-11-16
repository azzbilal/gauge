# Running a real pilot — hand-labelling a held-out set

This closes the one remaining gap in the loop: **no human-labelled CAD data has reached the
model yet.** Every benchmark number so far is on synthetic templates or public CADTestBench
programs. A real pilot makes the "human data → model improves" claim true, or honestly
retracts it.

## The goal

Produce **N real tasks that human reviewers accepted**, export them, and benchmark the model on
them — so the headline becomes "on tasks humans accepted, the model solves X % (vs a baseline)".

## Step 1 — recruit reviewers (the hard part)

- **Two reviewers minimum** (three lets you run adjudication on splits).
- Each needs an account with the `reviewer` role (an admin creates them, or they self-register
  and you promote them). They must be **people who know CAD** — the labels are only as good as
  the reviewers.

## Step 2 — create ~20 tasks

Either:
- write tasks by hand (a prompt, a spec with dimensions, and a correct CadQuery reference), or
- run `python model/generate.py` and hand-pick a spread across the five families, then edit any
  that look unnatural.

Aim for a **mix**: half straightforward, half with a trap (wrong dimension in the reference,
holes in dead code, a missing fillet) so the accepted set isn't all trivially easy.

## Step 3 — review them (the protocol already does this)

1. Each reviewer scores the five criteria **blind** (the UI hides the other reviewer and the
   verifier until after submit).
2. A task is **accepted** only when every criterion is ≥ 3 and `verifiable` ≥ 4.
3. On a split, an adjudicator (or the lead) decides.
4. **Gold rule: label before you run, never tune after.** The accept/reject decisions are the
   ground truth; don't change them because the model did poorly.

## Step 4 — export the accepted tasks

```bash
# 1. Refresh the warehouse copy of the database
python warehouse/run.py            # load + dbt build + dbt test

# 2. Export accepted tasks to the cad-spec format
GAUGE_CAD_PYTHON=<python-with-cadquery> \
  python model/export.py --campaign <id> --out model/data/pilot-accepted.json
```

`export.py` skips any accepted task whose own reference fails its rubric, and lists the skipped
ones — triage those (they're either a bad reference or a verifier gap).

## Step 5 — benchmark the model on the human-accepted tasks

```bash
GAUGE_CAD_PYTHON=<python-with-cadquery> python model/benchmark.py \
  --model qwen3.5:9b-q4_K_M --data model/data/pilot-accepted.json \
  --num-predict 4096 --temperature 0 --rollouts 1 \
  --out docs/results/pilot-fewshot.json

# and a zero-shot baseline:
GAUGE_CAD_PYTHON=<python-with-cadquery> python model/benchmark.py \
  --model qwen3.5:9b-q4_K_M --data model/data/pilot-accepted.json \
  --num-predict 4096 --temperature 0 --rollouts 1 \
  --out docs/results/pilot-zeroshot.json
```

## Step 6 — report it honestly

State: how many tasks, how many reviewers, the IAA, how many were accepted, and the model's
solve rate on the accepted set — **with the confidence interval** (n will be small, so the
interval will be wide; say so). Compare it to the synthetic-template number and note the gap.

## The honest bar

- If the model solves the human-accepted tasks **at a clearly higher rate than zero-shot**, you
  can finally say the loop works end-to-end.
- If it doesn't (likely, at n ≈ 20), you publish that — a clean negative result with a failure
  analysis is still a complete loop and looks better than overclaiming.

## Hand-labelling fallback (no reviewers available)

If you can't recruit reviewers, hand-label a held-out set yourself:

1. Pick ~20 real part descriptions (from `docs/results/real-cadtestbench-*` or BenchCAD family
   names).
2. For each, write the prompt, the spec, and the expected CadQuery reference.
3. Write the expected `accept`/`reject` **before** you run anything, and commit those labels
   first.
4. Treat them exactly like Step 4–6 above.

This is weaker than real reviewers (it's one author, not independent), so say that plainly in
the report — but it still exercises the export → benchmark path on data a human wrote.
