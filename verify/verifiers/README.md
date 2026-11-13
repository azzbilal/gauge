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

Status: **executed geometry for box size and volume, static reading for holes.** The
manifold check, a real sandbox for the worker and the PCB and simulation checks are still
to come.

| Check | What it does |
| --- | --- |
| `geometry_cad` | Runs the reference CadQuery code in a worker process with a timeout and measures the solid it builds. Width/depth/height are compared with the bounding box of that solid. |
| `static_cad` | Parses the reference with `ast` (never executes it). Reads hole or circle size and hole count. Also reads box width/depth/height, as the fallback when cadquery is missing or execution is switched off. |
| `manifold_volume` | Compares the volume of the executed solid with the requirement. `not_run` when the solid could not be measured (`needs cadquery` when cadquery is missing) and for requirements that state no volume: there is no manifold check yet. |

A rubric item is machine-checkable when its `checkMethod` is `machine`, or when it has none
and M7's inference tags it machine. Requirements whose kind or text mentions manifold,
watertight or volume go to `manifold_volume`; the rest go to `geometry_cad` / `static_cad`.

## Executed geometry

`cad_exec.measure(source)` runs the code in a separate Python process and returns the
bounding box (X, Y, Z in mm) and volume (mm3) of the result. The solid measured is the
module-level name `result`, else the last object given to `show_object(...)`, else the
CadQuery object bound by the last module-level assignment.

What a measured size means:

- It is the **overall extent** of the final solid. A 10 mm plate with a 5 mm boss on top
  is 15 mm tall, and fails "10 mm tall".
- It is taken along the **world axes**: width is X, depth is Y, height is Z (see Axis
  naming below). A correct plate drawn on the XZ plane, or rotated, fails.
- Every verdict names the object it measured (``the executed solid `result` ``). Without
  a `result` the last assigned object is used, which can be a helper; assign the final
  solid to `result` to be sure.

Because it measures what the code builds and not what it mentions, it fails models the
static reader passes: a box inside `if False:` when the result is a sphere, a box in a
function that is never called, a box that is cut in half afterwards.

| Outcome of running the code | Box size | Holes | Volume |
| --- | --- | --- | --- |
| built a solid | measured (`geometry_cad`) | static | measured |
| ran cleanly, built no solid | `fail` | `fail` | `fail` |
| raised or crashed | `fail` | `fail` | `not_run` |
| timed out | `not_run` | `not_run` | `not_run` |
| the worker could not be run this time | `not_run` | `not_run` | `not_run` |
| cadquery missing, or execution switched off | static fallback (`static_cad`); when cadquery is missing the detail ends `[static fallback: <reason>]` | static | `not_run`, `needs cadquery` |

The static fallback applies only when nothing was executed. Code that was executed and did
not finish is never read statically: a box in dead code followed by a `raise` would
otherwise pass.

"cadquery missing" is decided by a pre-flight run of the worker that is given no reference
code, once per interpreter. It is never taken from a run that executed a reference, so a
reference cannot talk its way into the static fallback. It is remembered for the life of
the process only when it is definite: the worker reported that the import failed, or the
interpreter file does not exist. A worker that could not be started for any other reason
(or a pre-flight that hung or died) is `not_run`, is not remembered, and is tried again on
the next call.

Tolerances: a measured size may be off by the requirement's tolerance plus 0.0001 mm. A
volume may be off by the requirement's tolerance (`5%`, `10 mm3`), else 0.1 %, since a
stated volume is a rounded figure.

Settings:

| | |
| --- | --- |
| `GAUGE_CAD_PYTHON` | Interpreter for the worker; it needs `cadquery`. Default: the interpreter running the verifier. |
| `GAUGE_CAD_TIMEOUT` | Seconds one reference may run, cadquery import included. Default 30. |
| `GAUGE_CAD_EXEC=0` | Never execute; static checks only. `VerifierPack(execute=False)` does the same in code. |

The timeout bounds run time. It is **not a sandbox**: the code runs with the permissions
of the verifier process, so only run code you would run yourself. Measurements are cached
per source text for the life of the process.

Known gap: holes are still read statically, so a hole written in dead code is counted as
long as some solid is built.

Axis naming: CadQuery's `box(length, width, height)` is X, Y, Z. A spec that says "width"
and "depth" means X and Y; a spec that says "length" means X by it and Y by "width".

The static check fails closed. A value it cannot resolve to a constant (a hole made in a
loop, a `cut()` of another solid, a function parameter, more than one box) is `not_run`
with the reason in the detail, never a pass.

```bash
python -m unittest discover -s verify/verifiers/tests -v
```

The tests that execute code are skipped when the worker interpreter has no cadquery; the
run prints which interpreter and cadquery version it used.

Files: `verifiers.py` (VerifierPack and the spec side), `cad_exec.py` (the worker and its
caller), `cad_static.py` (the `ast` reader), `tests/fixtures/` (one correct reference and
three wrong models; `plate_dead_code.py` is the one only execution catches).
