"""Executed-geometry measurement for the M8 Verifier Pack.

    from cad_exec import measure
    m = measure(source)          # m.kind is ok | no_solid | error | timeout | unavailable

Runs reference CadQuery code in a separate Python process with a timeout, and measures the
solid it actually builds: bounding box (X, Y, Z size in mm) and volume (mm3). Unlike the
`ast` reader in cad_static.py this sees what the code does, not what it mentions, so a box
in dead code or a box that is cut down afterwards is measured as it really ends up.

The solid measured is, in order: the module-level name `result`; the last object passed to
`show_object(...)`; the CadQuery object bound by the last module-level assignment.

The worker is this same file run as a script. It needs cadquery; the parent side is
standard library only. The interpreter is $GAUGE_CAD_PYTHON, else the current one, and the
timeout is $GAUGE_CAD_TIMEOUT seconds, else 30.

A timeout bounds how long the code runs. It is not a sandbox: the code runs with the
permissions of the calling process.
"""
import json
import os
import secrets
import subprocess
import sys
import tempfile
from collections import OrderedDict, namedtuple

OK = "ok"                    # the code ran and built a solid; size and volume are set
NO_SOLID = "no_solid"        # the code ran cleanly but left no solid to measure
ERROR = "error"              # the code raised, crashed, or the measurement was not finite
TIMEOUT = "timeout"          # the code did not finish in time
UNAVAILABLE = "unavailable"  # the worker interpreter is missing or has no cadquery

DEFAULT_TIMEOUT_S = 30.0

# kind    one of the constants above
# detail  why, in words, for every kind but ok
# size    (x, y, z) bounding-box size in mm, ok only
# volume  mm3, ok only
# solids  number of solids in the result, ok only
# valid   OCCT shape validity, ok only
# name    what was measured, e.g. "result", ok only
# cadquery  version of cadquery in the worker, when it imported
Measurement = namedtuple(
    "Measurement", "kind detail size volume solids valid name cadquery",
    defaults=("", None, None, None, None, None, None))

_CACHE_SIZE = 64
_cache = OrderedDict()   # (python, source) -> Measurement, for outcomes that will not change
_no_cadquery = {}        # python -> detail, once an interpreter is known to lack cadquery


def worker_python() -> str:
    """The interpreter the worker runs under."""
    return os.environ.get("GAUGE_CAD_PYTHON") or sys.executable


def default_timeout() -> float:
    try:
        value = float(os.environ.get("GAUGE_CAD_TIMEOUT", ""))
    except ValueError:
        return DEFAULT_TIMEOUT_S
    return value if value > 0 else DEFAULT_TIMEOUT_S


def measure(source: str, timeout=None, python=None) -> Measurement:
    """Execute `source` in a worker process and measure the solid it builds.

    Never raises for anything the reference code does: every outcome is a Measurement."""
    python = python or worker_python()
    timeout = default_timeout() if timeout is None else timeout
    if python in _no_cadquery:
        return Measurement(UNAVAILABLE, _no_cadquery[python])
    key = (python, source)
    if key in _cache:
        _cache.move_to_end(key)
        return _cache[key]

    result = _run_worker(source, timeout, python)
    if result.kind == UNAVAILABLE:
        _no_cadquery[python] = result.detail
    elif result.kind != TIMEOUT:  # a timeout depends on machine load; try again next time
        _cache[key] = result
        while len(_cache) > _CACHE_SIZE:
            _cache.popitem(last=False)
    return result


def _run_worker(source, timeout, python) -> Measurement:
    # The worker answers on one stdout line that starts with a nonce only it was given, so
    # nothing the reference code prints can be mistaken for the answer.
    nonce = secrets.token_hex(16)
    request = json.dumps({"source": source, "nonce": nonce}).encode("utf-8")
    with tempfile.TemporaryDirectory(prefix="gauge-cad-", ignore_cleanup_errors=True) as cwd:
        try:
            done = subprocess.run(
                [python, "-X", "utf8", os.path.abspath(__file__)],
                input=request, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                cwd=cwd, timeout=timeout)
        except subprocess.TimeoutExpired:
            return Measurement(TIMEOUT, f"reference did not finish within {timeout:g} s")
        except OSError as err:
            return Measurement(
                UNAVAILABLE,
                f"the worker interpreter could not be started ({err.strerror or err})")

    for line in reversed(done.stdout.decode("utf-8", "replace").splitlines()):
        if line.startswith(nonce + " "):
            try:
                reply = json.loads(line[len(nonce) + 1:])
                size = reply.get("size")
                return Measurement(
                    reply["kind"], str(reply.get("detail") or ""),
                    tuple(float(v) for v in size) if size else None,
                    reply.get("volume"), reply.get("solids"), reply.get("valid"),
                    reply.get("name"), reply.get("cadquery"))
            except (ValueError, KeyError, TypeError):
                break
    return Measurement(
        ERROR, f"reference crashed the worker (exit code {done.returncode})")


# ------------------------------------------------------------------------------ worker
# Everything below runs in the worker process, possibly under a different Python.

def _assigned_names(source) -> list:
    """Module-level names in the order they were last assigned, latest first."""
    import ast

    last = {}

    def walk(node):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef,
                                  ast.Lambda)):
                continue
            if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Store):
                last[child.id] = (child.lineno, child.col_offset)
            walk(child)

    walk(ast.parse(source))
    return sorted(last, key=last.get, reverse=True)


def _pick_result(cq, source, scope, shown):
    """(name, object) for the CadQuery object the script produced, or (None, None)."""
    kinds = (cq.Workplane, cq.Shape, cq.Assembly)
    if isinstance(scope.get("result"), kinds):
        return "result", scope["result"]
    for obj in reversed(shown):
        if isinstance(obj, kinds):
            return "show_object(...)", obj
    for name in _assigned_names(source):
        if isinstance(scope.get(name), kinds):
            return name, scope[name]
    return None, None


def _solid_of(cq, obj):
    """The solid(s) an object stands for as one Shape, or None when it has none."""
    if isinstance(obj, cq.Assembly):
        obj = obj.toCompound()
    if isinstance(obj, cq.Workplane):
        shapes = [v for v in obj.vals() if isinstance(v, cq.Shape) and v.Solids()]
        if not shapes:  # the stack holds a face, a wire, a point: use the solid in context
            try:
                shapes = [obj.findSolid()]
            except ValueError:
                return None
        obj = shapes[0] if len(shapes) == 1 else cq.Compound.makeCompound(shapes)
    if isinstance(obj, cq.Shape) and obj.Solids():
        return obj
    return None


def _worker():
    import math

    request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    source, nonce = request["source"], request["nonce"]
    out = sys.stdout

    def reply(**payload):
        out.write(nonce + " " + json.dumps(payload) + "\n")
        out.flush()

    # The reference must not import the verifier's own modules by accident.
    here = os.path.dirname(os.path.abspath(__file__))
    sys.path[:] = [p for p in sys.path if os.path.abspath(p or os.curdir) != here]

    try:
        import cadquery as cq
    except Exception as err:  # not installed, or installed but broken
        reply(kind=UNAVAILABLE,
              detail=f"cadquery is not available to the worker ({type(err).__name__})")
        return
    version = getattr(cq, "__version__", None)

    shown = []
    scope = {
        "__name__": "__main__",
        "show_object": lambda obj=None, *args, **kwargs: shown.append(obj),
        "debug": lambda *args, **kwargs: None,
    }
    sink = open(os.devnull, "w")
    sys.stdout = sys.stderr = sink  # the reference's prints are not part of the answer
    sys.stdin = open(os.devnull)
    try:
        exec(compile(source, "<reference>", "exec"), scope)
        name, obj = _pick_result(cq, source, scope, shown)
        if obj is None:
            reply(kind=NO_SOLID, cadquery=version,
                  detail="the reference ran but built no CadQuery object")
            return
        shape = _solid_of(cq, obj)
        if shape is None:
            reply(kind=NO_SOLID, cadquery=version,
                  detail=f"the reference ran but `{name}` holds no solid")
            return
        box = shape.BoundingBox()
        size = [float(box.xlen), float(box.ylen), float(box.zlen)]
        volume = float(shape.Volume())
        if not all(math.isfinite(v) for v in size + [volume]):
            reply(kind=ERROR, cadquery=version,
                  detail=f"`{name}` has a non-finite bounding box or volume")
            return
        reply(kind=OK, cadquery=version, name=name, size=size, volume=volume,
              solids=len(shape.Solids()), valid=bool(shape.isValid()))
    except BaseException as err:  # SystemExit and KeyboardInterrupt included
        message = " ".join(str(err).split())[:160]
        reply(kind=ERROR, cadquery=version,
              detail=f"reference raised {type(err).__name__}" + (f": {message}" if message else ""))


if __name__ == "__main__":
    _worker()
