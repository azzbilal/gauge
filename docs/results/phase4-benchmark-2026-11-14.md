# Phase 4 benchmark: cad-spec-1.0, baseline and few-shot run (2026-11-14)

**Headline.** On the 20 held-out cad-spec-1.0 tasks, local `qwen3.5:9b-q4_K_M` goes from
**0/20 (0 %)** zero-shot to **6/20 (30 %)** with five worked training examples in the prompt.
The gain is narrow. All six solved tasks have **no holes**; every task with holes still
fails (0/14). The "training run" is **in-context few-shot prompting, not weight training**:
no model weights changed.

Everything ran locally (Ollama on this machine). No hosted model was used.

| Raw reports | |
|---|---|
| Baseline (zero-shot) | [`phase4-benchmark-baseline-2026-11-14.txt`](./phase4-benchmark-baseline-2026-11-14.txt) / [`.json`](./phase4-benchmark-baseline-2026-11-14.json) |
| Few-shot, K=5 | [`phase4-benchmark-fewshot5-2026-11-14.txt`](./phase4-benchmark-fewshot5-2026-11-14.txt) / [`.json`](./phase4-benchmark-fewshot5-2026-11-14.json) |

## 1. The benchmark: cad-spec-1.0

The format is frozen in [`model/SPEC.md`](../../model/SPEC.md). A task is a plain-language
`prompt` plus a precise `spec`; a solver sees only those two, never the `reference`,
`rubric` or `params`. The few-shot run also shows it other tasks' solutions, from the train split
only (section 3).

- **Data.** `model/data/synthetic-seed0-n100.json`, from the seeded generator
  (`model/generate.py`, `gauge-synth-1`, seed 0): 100 tasks in five template families
  (`plate`, `box`, `bracket`, `cutout`, `rounded`). 20 % of each family is held out, so the
  benchmark has 20 tasks (4 per family) and the train split has 80. No two tasks share a
  family and parameter set.
- **Solved.** The task's packet, with the candidate as `reference`, gets at least one
  `geometry_cad` / `static_cad` verdict from the M8 Verifier Pack, and all of them pass
  (`verify/probe/probe.py` `score()`). What that covers: the **overall bounding box**
  (measured on the executed solid), **hole diameter** and **hole count** (read statically).
  **Not scored:** wall thickness, open top, fillet radius, cutout size or presence, upright
  position, hole positions.
- **Scoring mode: executed.** CadQuery 2.7.0 on Python 3.10.11 (`GAUGE_CAD_PYTHON`), the same
  versions the Gate 2 report records. Before the model runs, the harness reproduced its
  controls on the held-out split: `--mock oracle` (each task's own reference) scores 20/20
  and `--mock wrong` (every box 7 mm wider) scores 0/20, both `scoring executed`.
- **Same scorer for both runs.** The baseline report doesn't record which interpreter scored
  it. So the 20 baseline answers stored in its JSON were scored again with `probe.score`
  under this interpreter. The result is still 0/20, with the same failure detail on all 20.

## 2. Setup, identical for both runs

| | |
|---|---|
| Model | `qwen3.5:9b-q4_K_M` (Ollama, local) |
| Endpoint | `/api/generate`, `think: false`, temperature 0, `num_ctx` 16384, `num_predict` 4096 |
| Rollouts | 1 per task (temperature 0 is deterministic, so more rollouts repeat the answer) |
| Instructions | probe's `build_prompt`: CadQuery, literal millimetres, assign `result`, code only |
| Only difference | the few-shot run puts 5 worked examples before the task |

**Probe fix shipped with this run.** `verify/probe/probe.py` `rollout()` used to send only
`model`, `prompt` and `stream`. With no `think: false`, qwen3.5 can spend its whole budget
reasoning and return an empty answer. The probe scored that as a failed rollout, which
pushed tasks toward `t2`. `rollout()` now sends what the API's intake provider sends:
`think: false`, temperature 0, `num_ctx` (`OLLAMA_NUM_CTX`, default 16384) and `num_predict`
(`OLLAMA_NUM_PREDICT`, default 2048), built by one shared `generation_body()` that the
benchmark also uses.

Reproduced this session on `plate-002`:
- The **old** request shape (`model`, `prompt` and `stream` only) came back after 65 s with
  an **empty** `response`, 13,531 characters of `thinking` and `done_reason: length` at
  3,950 tokens.
- The **fixed** `rollout()` returns 3,995 characters of code.

The fix is preventive. An empty reply that still arrives is scored as a failed rollout, as
before.
New tests in `verify/probe/tests/test_probe.py` pin the request body.

## 3. The "training run": few-shot examples from the train split

`python model/benchmark.py --num-predict 4096 --fewshot 5`

- **What it does.** `fewshot_prompt()` keeps probe's instructions, then inserts K worked
  examples, each with its task, spec and reference solution in a ```python fence. The
  held-out task follows. With K=0 the prompt is byte-for-byte the baseline prompt (tested),
  so the committed 0/20 is still the valid "before".
- **Which examples.** The rule was fixed before any held-out run: round-robin over the five
  families in file order, so K=5 is the first train task of each family. The examples are
  `plate-001`, `box-001`, `bracket-001`, `cutout-001` and `rounded-001`. They are recorded in
  the report's `generation.fewshot`.
- **Leakage guards.** Selection refuses any task whose split is not `train`, and never picks
  a task from the evaluated set (tested). None of the 20 extracted answers is a verbatim copy
  of an example.
- **One held-out run.** No K, example set or wording was tried on the held-out split before
  this run, and no other held-out run was made. The prompt with examples is about
  1,100–1,160 tokens (Ollama `prompt_eval_count`), far inside `num_ctx`.

## 4. Results

| Family | Baseline | Few-shot K=5 | Held-out tasks with holes | Not scored by the verifier |
|---|---|---|---|---|
| plate | 0/4 | 0/4 | 4 of 4 | hole positions |
| box | 0/4 | **2/4** | 2 of 4 | wall thickness, open top, hole positions |
| bracket | 0/4 | 0/4 | 4 of 4 | plate thickness, upright position, hole positions |
| cutout | 0/4 | **4/4** | 0 of 4 | the cutout (size and presence) |
| rounded | 0/4 | 0/4 | 4 of 4 | fillet radius (and presence), hole positions |
| **Total** | **0/20 (0 %)** | **6/20 (30 %)** | 14 of 20 | |

- **Uncertainty.** Wilson 95 % intervals: about 0–16 % before and 15–52 % after. With
  n = 20 and one rollout per task, the gap is real but its size is not pinned down.
- **Other counters, both runs.** No not-run, unjudged or empty answers. 3 baseline answers
  were cut off at `num_predict`; no few-shot answers were.
- **Shape of the answers.** Median answer length fell from 1,064 generated tokens and 87
  lines to 92 tokens and 12 lines. The model stopped writing long helper code and copied
  the examples' short builder chains.

**Outcome by whether the task has holes:**

| | Baseline | Few-shot K=5 |
|---|---|---|
| Tasks without holes (4 cutout, box-010, box-013) | 0/6 | **6/6** |
| Tasks with holes | 0/14 | **0/14** |

**Spot-check of what the verifier doesn't score.** In all six solved answers the feature
the spec asks for is present and sized correctly. The four cutout answers use
`.rect(w, d).cutThruAll()` with exactly the specified cutout size. The two box answers use
`.shell(-t)` with exactly the specified wall. So none of the six is solved only because
the scorer is blind to a missing feature.

## 5. Failure analysis

### Before: the model invents CadQuery

All 20 baseline answers fail. Each either crashes or doesn't parse; none runs and simply
has wrong numbers. The breakdown:

- 11 raise `AttributeError` on methods that don't exist (`Workplane.moved`,
  `Workplane.toLine`, `Face.normal`, `Workplane.Edges`).
- 4 raise `TypeError` from wrong signatures.
- 3 raise `ValueError`: two null shapes and one vector conversion (`cutout-015`).
- 1 raises `NameError`, and 1 doesn't parse.

### After: real API calls, wrong arguments and arithmetic

With examples in the prompt, no answer calls a non-existent method. Of the 14 failures, 11
run and build the wrong geometry. The other 3 raise: a wrong argument count, zero spacing,
and a failed OpenCascade operation.

1. **`rarray` for every multi-hole plate and rounded task: 8 of 14 failures.**
   - `plate-001`'s example uses `.rarray(45, 81, 3, 2)`, whose signature is
     `rarray(xSpacing, ySpacing, xCount, yCount)`. All 8 plate and rounded held-out tasks
     reached for `rarray`, whatever the pattern.
   - Six of the eight are corner patterns. The prompt already showed corner holes done
     right: `bracket-001` uses `pushPoints` with four corner coordinates. That example did
     not carry over; only the bracket corner task (`bracket-017`) used `pushPoints`. The
     `rounded-001` example has a single centred hole, so the rounded tasks borrowed
     `rarray` from the plate example.
   - The typical slip puts the **hole diameter in `xCount`** and the **total hole count in
     `yCount`**. `plate-002` (4 holes of 8 mm at the corners of 36 × 26) becomes
     `.rarray(36, 26, 8, 4)`, a grid of 32 holes. The same slip gives 48, 40, 24 and 16 holes
     in `rounded-003`, `plate-015`, `rounded-015` and `rounded-012`; the last two also halve
     the spacing.
   - `plate-004` is the same 2-rows-of-3 grid as the `plate-001` example and still fails.
     It writes `.rarray(19, 38, 6, 2)`, with 6 (the hole diameter, and also the total count)
     where the column count 3 belongs: 12 holes.
   - `rounded-007` passes six arguments (`TypeError`) and `plate-011` passes zero spacing
     (`ValueError`).
   - The circle pattern (`rounded-003`) needed `polarArray`, which no example shows.
2. **Bracket upright misplaced: 4 of 4 brackets.**
   - The example's upright sits at `center(0, D/2 - t/2)`. The model doesn't redo that
     arithmetic for new sizes. It writes `D/2`, `D/2 + 0.5` or `D/2 - 1` instead, so the
     upright sticks out past the base and the measured depth is 2–4 mm too large
     (`bracket-007`, `-010`, `-017`).
   - `bracket-004` also offsets the upright in X and uses a zero-spacing `rarray`. Its width
     and depth miss by 35 and 32.5 mm, and it has 20 holes.
   - `bracket-017`'s hole points sit at the edge of the base (±40 on an 80 mm base), but
     hole positions aren't scored.
3. **Box floor holes: 2 of 2 boxes with holes.** The box example has no holes, so nothing
   in the prompt shows holes through a floor.
   - `box-004` cuts one 114 × 50 rectangle through the floor instead of four holes, so it
     has no countable holes.
   - `box-005` puts `.circle(8)` (a radius, so 16 mm holes) on the rectangle's vertices, and
     the script raises `StdFail_NotDone`.

### What the gain is, and isn't

- **It is copying the matching example's call chain.** Train and held-out tasks come from
  the same five generator templates. The six solved answers are, in effect, the family's
  example with new numbers: `.box().faces(">Z").workplane().rect().cutThruAll()` for
  cutouts and `.box().faces(">Z").shell()` for boxes.
- **It doesn't transfer the right pattern.** The prompt teaches which real CadQuery calls
  exist, but not how to pick one for a hole pattern. The `pushPoints` corner example didn't
  reach the plate and rounded tasks, and one exact-pattern example (`plate-004`) still failed.
  Nor does it teach the model to *compute* hole coordinates or the upright offset.
- **It is not evidence of generalization** to new part types, expert campaign tasks, or
  CAD reasoning in general. cad-spec-1.0 holds only templated synthetic tasks.
- **"Solved" is narrow.** It covers bounding box, hole diameter and hole count only. A
  solved bracket with misplaced holes would still count, though this run had none.

### What might move the number next (not run)

These are hypotheses. Each should be tried on train tasks that aren't examples before any
new held-out run.

- **Choose examples by family and pattern**, so each task sees its own family solving its
  own hole pattern. A different family's example did not carry over here, so simply adding
  one example per pattern is a weaker bet than it looks.
- **Spell out the semantics** in the example code: name the `rarray` count arguments, or
  give corner holes as computed `pushPoints` coordinates with comments such as
  `# W/2 - inset`, `# D/2 - t/2`.
- **Add an example of floor holes in a box**, and one of a `polarArray` circle.

Real weight training on the 80 train tasks (LoRA or similar) is still not built.

## 6. Reproduce

```bash
export GAUGE_CAD_PYTHON=/path/to/python-with-cadquery   # cadquery 2.7.0 here
python model/benchmark.py --mock oracle                  # 20/20, scoring executed
python model/benchmark.py --mock wrong                   # 0/20
python model/benchmark.py --model qwen3.5:9b-q4_K_M --num-predict 4096 \
    --out docs/results/phase4-benchmark-baseline-2026-11-14.json          # 0/20
python model/benchmark.py --model qwen3.5:9b-q4_K_M --num-predict 4096 --fewshot 5 \
    --out docs/results/phase4-benchmark-fewshot5-2026-11-14.json          # 6/20
```

The few-shot run took 138 s for 20 tasks on this machine; the baseline took 682 s, mostly
from its long answers.
