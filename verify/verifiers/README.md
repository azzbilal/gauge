# M8 — Verifier Pack

Deterministic checkers per deliverable type, run in an isolated worker with a timeout.
CAD in depth (dimensions, holes, manifold solid, volume); PCB and simulation get one narrow
check each. Returns one verdict per machine-checkable rubric item. The same code is the
pre-submit gate, the review auto-check and the training reward.

```python
from verifiers import verify
verdicts = verify(packet)   # same packet shape as M7 Packet Lint
# {"rubric_item_id", "requirement_id", "check", "status", "pass", "detail"}
```

`status` is `pass`, `fail` or `not_run`; `pass` is true only for `pass`.

Status: **static checks only** — standard library, no CAD kernel yet. The CAD kernel
(manifold, volume), the isolated worker and the PCB and simulation checks are still to come.

| Check | What it does |
| --- | --- |
| `static_cad` | Parses the reference CadQuery code with `ast` (never executes it), reads box width/depth/height, hole or circle size and hole count, and compares them with the requirement. |
| `manifold_volume` | Returns `not_run` with detail `needs cadquery` until cadquery is installed. |

A rubric item is machine-checkable when its `checkMethod` is `machine`, or when it has none
and M7's inference tags it machine. Requirements whose kind or text mentions manifold,
watertight or volume go to `manifold_volume`; the rest go to `static_cad`.

Axis naming: CadQuery's `box(length, width, height)` is X, Y, Z. A spec that says "width"
and "depth" means X and Y; a spec that says "length" means X by it and Y by "width".

The static check fails closed. A value it cannot resolve to a constant (a hole made in a
loop, a `cut()` of another solid, a function parameter, more than one box) is `not_run`
with the reason in the detail, never a pass.

```bash
python -m unittest discover -s verify/verifiers/tests -v
```

Files: `verifiers.py` (VerifierPack and the spec side), `cad_static.py` (the `ast` reader),
`tests/fixtures/` (one correct reference and two wrong models).
