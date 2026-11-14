# cad-spec: the task format

spec-version: cad-spec-1.0

This file freezes the format of a Gauge CAD task: the record the synthetic generator writes
(`model/generate.py`) and the benchmark reads (`model/benchmark.py`). Exporting accepted
campaign tasks to it, before they enter the model loop, is planned and not built. The version on the line above is the only
place it is written. Code reads it through `model/cadspec.py` (`spec_version()`), every task
carries it in `spec_version`, and the benchmark refuses tasks whose version differs. Other docs
link here instead of restating it.

## Versioning

`cad-spec-MAJOR.MINOR`.

- **MAJOR** goes up when a field is removed or renamed, or when its meaning changes in a way
  that would change how an existing task is scored.
- **MINOR** goes up when an optional field is added, or when a rule gets stricter without
  changing what an existing valid task means.

The extraction that produced a task's rubric has its own version (`rubric.extract_version`,
from `verify/lint/extract.py`). It is recorded beside the rubric, not folded into this one: a
new extractor can change a rubric without changing the format.

## Task record

A task is one JSON object. A batch file is
`{"spec_version", "generator", "count", "tasks": [task, ...]}`.

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Unique within a batch, stable across runs with the same seed. |
| `spec_version` | string | The version above. |
| `family` | string | Template family (`plate`, `box`, `bracket`, `cutout`, `rounded`), or `campaign` for an expert task. |
| `split` | `"train"` \| `"heldout"` | Benchmark tasks are drawn only from `heldout`. |
| `prompt` | string | The instruction a solver reads. Plain language, self-contained. |
| `spec` | string | The precise requirements: shape, dimensions, hole sizes and counts. |
| `reference` | string | A CadQuery script that satisfies the spec (rules below). |
| `rubric` | object | The requirements and rubric items to score against (below). |
| `params` | object | Optional. The generator's ground-truth parameters. A solver never sees it. |

A solver sees only `prompt` and `spec`, never `reference`, `rubric` or `params`.

### `rubric`

```json
{
  "extract_version": "extract-7",
  "requirements": [{"id", "text", "kind", "value", "tolerance", "check_method", ...}],
  "rubric_items":  [{"id", "criterion", "text", "requirement_id", "check_method", "weight"}]
}
```

- `requirements` are exactly what `verify/lint/extract.py` `extract(prompt, spec)` returns,
  so a synthetic task and a task created through the API have the same requirements for the
  same text. `check_method` is `machine` or `manual`.
- `rubric_items` hold one item per review criterion (`docs/pipeline.md` §2). A machine item
  is repeated once for each requirement it checks, with id `<item id>:<requirement id>` and
  that requirement in `requirement_id`, because the Verifier Pack checks one requirement per
  item. The API's packet builder (`apps/api/src/verify/packet-builder.ts`) does the same.
  A manual item has `requirement_id: null`.
- `prompt`, `spec`, `reference` plus `rubric.requirements` and `rubric.rubric_items` form a
  packet `verify/lint/packet.py` `TaskPacket.from_dict` accepts as it is.

### `reference` rules

1. CadQuery, units in millimetres, literal numbers (or module-level constants).
2. The final solid is assigned to a module-level `result`.
3. Axes: width is X, depth is Y, height is Z, in world coordinates. The part is not rotated.
   Stated sizes are the **overall** extents of the finished solid (its bounding box).
4. Holes are made with `hole()` on a point set the static reader can count: `rect(...,
   forConstruction=True).vertices()`, `pushPoints([...])` with a literal list, `rarray(...)`,
   `polarArray(...)`, or a single centred hole. No loops or comprehensions for holes.
5. A task with a non-circular cut (`rect(...).cutThruAll()`) states no hole count. The
   static reader cannot count holes in a model that has one.
6. The reference must score **solved** (rule below) against its own rubric, with the CAD
   kernel executing it. `python model/generate.py --check` enforces this for a batch.

### Wording rules (so extraction reads what is meant)

- Size the part with a triple `W x D x H mm` in the prompt, restated as `W mm wide, D mm deep,
  H mm tall` in the spec. Do not use `length` (it changes the axis mapping) or `thick`/
  `thickness` for anything but the part's Z size (it always maps to Z).
- State a hole count once per text as `N holes of D mm diameter`. Qualifiers (`through holes`)
  or a second, uncounted mention of holes (`Holes: ...`) turn the count into a manual check.
- Sizes of secondary features (wall, fillet, cutout, pattern pitch) are written as bare
  lengths (`3 mm walls`, `a 5 mm fillet`, `30 mm by 20 mm`). Extraction keeps them as manual
  requirements, so they are listed but not machine-scored.

## Solved

A candidate solution is **solved** when the packet built from the task (with the candidate
as `reference`) has at least one `geometry_cad` or `static_cad` verdict from the Verifier
Pack (`verify/verifiers/`) and all of them pass. This is `verify/probe/probe.py` `score()`.
A candidate is **unjudged** when nothing failed but a check could not run (code the static
reader cannot follow, a timeout), and **failed** when any check failed, including code that
does not parse, raises or builds no solid.

What solved covers in this version: the **overall bounding box** (width, depth, height,
measured on the executed solid) plus **hole diameter** and **hole count** (read statically).
Wall thickness, fillet radius, cutout size and hole positions are **not scored**: a candidate
that omits a fillet or a cutout can still be solved. Benchmark reports say so. Closing that
gap needs new Verifier Pack checks and a MINOR version.

Executed scoring needs an interpreter with `cadquery` (`GAUGE_CAD_PYTHON`, see
`verify/verifiers/README.md`). Without it box sizes fall back to the static reading, which
cannot score a part made of more than one box. Every benchmark report records which mode
was used.
