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
