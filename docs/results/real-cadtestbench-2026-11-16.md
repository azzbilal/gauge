# Real-task benchmark: CADTestBench, 2026-11-16

The Phase 4 headline (few-shot 122/300 = 41 %) was measured only on held-out tasks drawn from
the same five synthetic templates as the five few-shot examples. This run asks the same model,
with the same five synthetic examples, for CadQuery on **100 real parts** it has never seen.

## Result

| Arm | Data | Solved | 95 % Wilson |
|---|---|---|---|
| few-shot (5 synthetic examples) | synthetic templates, 300 held-out | **122/300 = 41 %** | 35–46 % |
| zero-shot | synthetic templates, 300 held-out | 14/300 = 4.7 % | 3–8 % |
| few-shot (same 5 synthetic examples) | **real CADTestBench, 100 tasks** | **24/100 = 24 %** | 17–33 % |
| zero-shot | **real CADTestBench, 100 tasks** | 15/100 = 15 % | 9–23 % |

Like for like on bounding box alone, few-shot:

| Check | Synthetic templates (300) | Real parts (100) |
|---|---|---|
| bounding box only, per axis | **189/300 = 63 %** (exact to 1e-6 mm; recomputed from the stored verdicts of the 41 % run, hole checks ignored) | **19/100 = 19 %** (within 1 %) |
| headline metric | 122/300 = 41 % (bbox + hole diameter + hole count) | 24/100 = 24 % (sorted bbox within 1 %) |

Paired on the 100 real tasks: few-shot minus zero-shot = **+9 points (95 %: −0.5 to +18.5)**,
discordant 16 vs 7, **exact McNemar p = 0.093**. On synthetic templates the same comparison was
+36 points, p = 6.2e-33.

Secondary columns on the real tasks (not in the headline):

| | zero-shot | few-shot |
|---|---|---|
| strict X/Y/Z extents within 1 % | 12/100 | 19/100 |
| extents and volume within 2 % | 13/100 | 21/100 |
| built any solid at all | 18/100 | 40/100 |

Where the few-shot attempts ended: bounding box matched 24, wrong extents 16, code raised 45
(mostly CadQuery methods or arguments that do not exist), syntax error 15 (13 of them are
answers cut off at `num_predict` 4096, see below). Zero-shot: matched 15, wrong extents 3,
raised 79, syntax error 3 (7 zero-shot answers cut off in all).

Neither arm used any human-labelled data: the few-shot examples are synthetic. These numbers
therefore say nothing yet about whether campaign data improves the model.

## What it means

- **The 41 % is a synthetic-template number, not general CAD ability.** On real parts the same
  few-shot setup solves 24 %, under a check that is *weaker* than the synthetic one (bounding box
  only, against extents + hole diameter + hole count), so 41 % and 24 % are not the same metric.
  On the same metric (bounding box per axis) the gap is larger: 63 % on templates, 19 % on real
  parts, and the synthetic check was the stricter of the two (exact against 1 %).
- **The few-shot lift on real parts is much smaller and not significant at n = 100.** On
  templates the examples lift the model by 36 points (p = 6.2e-33). On real parts they lift it by
  9 points (95 %: −0.5 to +18.5, p = 0.093). That is underpowered, not proof of no transfer. The
  arms are also confounded by truncation: 13 few-shot answers were cut off at `num_predict`
  against 7 zero-shot, mostly long comments about units (see Caveats). The visible gain is that
  more answers run at all (40 vs 18 build a solid). Our reading, not measured here: the examples
  mainly teach the CadQuery idiom of the five templates.
- **Zero-shot is higher on real tasks (15 %) than on templates (4.7 %).** The real `detailed`
  prompts are simple DeepCAD parts and state every extent, and bounding-box-only scoring is
  lenient. Do not read this as the model being better at real parts.
- The dominant failure on real parts is invented API (code that raises), not wrong geometry.

## Setup

- **Prompts:** CADTestBench (`anon-submission-2465453/CADTestBench` on HuggingFace, MIT),
  `samples/detailed` split. The prompts ask for CadQuery code and state the dimensions. The HF
  release has no reference code, only executable tests, so the references come from
  **CADPrompt** (`github.com/Kamel773/CAD_Code_Generation`), the dataset CADTestBench is derived
  from, which has the same 8-digit sample ids: `Python_Code.py` with the `cq.exporters.export`
  line removed.
- **Subset:** every reference was executed by `verify/verifiers/cad_exec.py` `measure`. 190 of
  200 build one valid solid whose extents agree with CADPrompt's `Ground_Truth.json` within 1 %.
  10 were dropped: 5 build 2–3 solids, 5 disagree with their own `Ground_Truth.json`. The
  benchmark is the first 100 valid sample ids in sorted order. No model output went into the
  choice. Data lives outside the repo; `model/bench_real.py fetch` and `prepare` rebuild it.
- **Scoring**, fixed before any model was run. The candidate code is executed by the same
  `cad_exec.measure` the Verifier Pack uses (cadquery 2.7.0). It counts as solved when the solid's
  bounding-box extents, sorted, are each within 1 % (relative) of the reference's. They are
  sorted because the prompts do not fix the axes and the references rotate their parts.
  CADTestBench's own dimension tests also sort and use 1 %. Timeouts and worker failures would
  count as unjudged; there were none.
- **Checks on the scorer:** the reference as candidate scores 100/100, and the reference scaled
  by 1.07 scores 0/100.
- **Generation:** identical to the 41 % run. Model `qwen3.5:9b-q4_K_M` on local Ollama, think
  off, temperature 0, `num_ctx` 16384, `num_predict` 4096, prompt built by probe `build_prompt`
  plus `benchmark.fewshot_prompt`. The few-shot examples are plate-001, box-001, bracket-001,
  cutout-001 and rounded-001 from `model/data/synthetic-seed0-n100.json`, and the harness checks
  the ids.

## Caveats

- The probe instructions say "literal numbers in millimetres" while CADTestBench prompts say
  "units". CadQuery has no units, so a correct answer copies the numbers either way. Still, 13
  few-shot answers ran past the 4096-token budget writing long comments, and 9 of them mention
  both "units" and millimetres (a keyword match; the two read in full argue about the units). They count as failed, as they would in the synthetic run. A
  real-task prompt without the millimetre wording might score higher. It was not tried, to keep
  the setup identical.
- Bounding box is a weak check: a plain block with the right extents passes for a part with
  holes or cut-outs. The extents-and-volume column (21 % few-shot) is the stricter reading.
- One rollout per task at temperature 0. n = 100, so the intervals are wide.

## Reproduce

```
export GAUGE_CAD_PYTHON=/path/to/python-with-cadquery
python model/bench_real.py fetch   --dir ../hf-download/real
python model/bench_real.py prepare --dir ../hf-download/real --limit 100
python model/bench_real.py run --tasks ../hf-download/real/tasks.json --mock oracle   # 100 %
python model/bench_real.py run --tasks ../hf-download/real/tasks.json --mock wrong    # 0 %
python model/bench_real.py run --tasks ../hf-download/real/tasks.json --fewshot 5 \
    --out docs/results/real-cadtestbench-fewshot5-2026-11-16.json
python model/bench_real.py run --tasks ../hf-download/real/tasks.json \
    --out docs/results/real-cadtestbench-zeroshot-2026-11-16.json
python model/bench_real.py compare docs/results/real-cadtestbench-zeroshot-2026-11-16.json \
    docs/results/real-cadtestbench-fewshot5-2026-11-16.json
```

Reports: `real-cadtestbench-fewshot5-2026-11-16.{json,txt}`,
`real-cadtestbench-zeroshot-2026-11-16.{json,txt}`, `real-cadtestbench-compare-2026-11-16.json`.
