# Model loop (M5)

The cad-spec release, the synthetic task generator and the held-out benchmark harness, with
a few-shot prompt as the first "training run". It is in-context examples, not weight
training; no model weights are changed. Results:
[`docs/results/phase4-benchmark-2026-11-14.md`](../docs/results/phase4-benchmark-2026-11-14.md).

| File | What it is |
|---|---|
| [`SPEC.md`](./SPEC.md) | The cad-spec release: the frozen task format (prompt, spec, reference, rubric), its version, the reference and wording rules, and what "solved" covers. The version is written there and nowhere else. |
| `cadspec.py` | Reads the version from SPEC.md (`spec_version()`), validates a task (`check_task`) and turns a task into a Verifier Pack packet (`to_packet`). |
| `generate.py` | Writes a seeded batch of templated tasks to `data/`. |
| `benchmark.py` | Scores a candidate (local Ollama model or a mock) on the held-out split with the M8 Verifier Pack, through the M9 probe's `score()`. |
| `tests/` | `python -m unittest discover -s model/tests -v`. No live Ollama; executed tests skip without cadquery. |

Standard library only. Scoring imports `verify/` (also standard library); executed geometry
needs an interpreter with cadquery in `GAUGE_CAD_PYTHON` (see `verify/verifiers/README.md`).

## Generate

```bash
python model/generate.py                       # 100 tasks, seed 0 -> data/synthetic-seed0-n100.json
python model/generate.py --count 200 --seed 7 --out model/data/batch.json
python model/generate.py --count 300 --seed 1 --heldout 1 --stratify \n    --exclude model/data/synthetic-seed0-n100.json --out model/data/heldout-seed1-n300.json
GAUGE_CAD_PYTHON=/path/to/python python model/generate.py --check   # score every reference too
```

Five families, drawn round-robin: `plate` (hole patterns), `box` (open top, optional holes
in the floor), `bracket` (L-bracket, holes in the base), `cutout` (rectangular through
cutout, no holes) and `rounded` (filleted vertical edges plus holes). Sizes, hole diameters
(3 to 10 mm), hole counts (0 to 8) and patterns (centre, row, corners, 2x3 grid, circle)
vary.

- **Reproducible.** One `random.Random(seed)`, ids derived from the task id, sorted keys, no
  timestamps: the same seed gives a byte-identical file.
- **Split.** 20 % of each family is held out (`--heldout`), and no two tasks share a family
  and parameter set.
- **Held-out batches.** `--stratify` draws fixed quotas per (family, hole pattern) cell
  instead of round-robin: even over the families, then even over each family's patterns
  (300 tasks: 60 per family; plate 5 x 12, box 4 x 15 including no holes, bracket 3 x 20,
  cutout 60, rounded 3 x 20). The cells are interleaved, so any prefix of the file spreads
  over them, and the split is drawn per cell. `--heldout 1` holds out every task.
  `--exclude BATCH` (repeatable) never draws a task (family and parameter set) that is in
  another batch, so a held-out batch cannot repeat the training batch. The default path
  is unchanged: seed 0 still regenerates byte for byte.
- **Self-checked.** The rubric comes from `verify/lint/extract.py` on the task text, exactly
  as for a task created through the API. Generation fails if extraction does not read back
  exactly the overall size plus the hole diameter and count the generator meant.
  `--check` also scores every reference against its own rubric and exits 1 if one is not
  solved.

## Benchmark

```bash
python model/benchmark.py --mock oracle        # the reference itself: must be 100 %
python model/benchmark.py --mock wrong         # every box 7 mm wider: must be 0 %
python model/benchmark.py --model qwen3.5:9b-q4_K_M --out report.json
python model/benchmark.py --limit 5 --rollouts 3
python model/benchmark.py --num-predict 4096 --fewshot 5 --out report.json   # few-shot
python model/benchmark.py --data model/data/heldout-seed1-n300.json --num-predict 4096 \n    --fewshot 5 --train-data model/data/synthetic-seed0-n100.json --out fewshot.json
python model/benchmark.py --compare baseline.json fewshot.json   # paired, McNemar
```

The model gets probe's instructions plus the prompt and spec, never the task's own
reference. With `--fewshot K` the prompt also holds K worked examples (prompt, spec and
reference) from the **train** split, placed before the task: round-robin over the five
families in file order, so K=5 is the first train task of each family. Tasks in the
evaluated set are never examples, and a held-out task passed as an example is refused.
`--fewshot 0` (the default) sends exactly the zero-shot prompt. The report's `generation`
block records K and the example ids. The
request sends `think: false`, temperature 0, `num_ctx` and `num_predict` (`$OLLAMA_NUM_CTX`,
`$OLLAMA_NUM_PREDICT`, as the API's intake provider does). Without `think: false`,
qwen3.5 spends its whole budget reasoning and returns an empty answer. An empty answer is
counted as `failed` and labelled "no code". Each
attempt is `solved`, `failed`, `unjudged` (nothing failed but a check could not run) or
`not_run` (Ollama could not be asked). The solve rate is solved over solved + failed +
unjudged; unjudged is printed beside it and not_run is left out. The report records the
spec and extraction versions, the model and whether scoring was executed or static. It
also lists, per family, what the verifier does not score.

- **Separate training batch.** `--train-data BATCH` takes the few-shot examples from that
  batch's train split. Batches reuse ids (`plate-001` ...), so across files the harness
  checks that no example is an evaluated task by family and parameters or by prompt and
  spec text, and fails if one is.
- **Intervals.** The report gives a 95 % Wilson interval for the solve rate overall, per
  family, per hole pattern and per stratum (family/pattern). With several rollouts the
  interval treats attempts as independent, which they are not at temperature 0: grow the
  task set, not the rollouts.
- **Paired comparison.** `--compare FIRST SECOND` runs nothing. It pairs two 1-rollout
  reports on the same data and task set: the 2x2 table, both solve rates with Wilson
  intervals, McNemar's exact two-sided test on the discordant tasks, and a 95 % interval
  for the difference, overall and per family and stratum. The difference interval is
  Newcombe's (1998) method 10, with the corrected phi as stated in the NCSS manual. It has
  not been checked against a published worked example, so cite McNemar, not this interval.
  Per-group p-values are uncorrected. A task not run in either report is left out of the
  pairs; unjudged counts as not solved.
- **Long runs.** Every finished task is appended to a JSONL log (`--log`, default
  `<out>.progress.jsonl`). `--resume` skips the tasks already logged, but only when the log
  was written with the same data, candidate and settings. Tasks that were not run are
  tried again.
