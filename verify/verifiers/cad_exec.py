"""Executed-geometry measurement for the M8 Verifier Pack.

    from cad_exec import measure
    m = measure(source)   # m.kind is ok | no_solid | error | timeout | not_run | unavailable

Runs reference CadQuery code in a separate Python process with a timeout, and measures the
solid it actually builds: bounding box (X, Y, Z size in mm) and volume (mm3). Unlike the
`ast` reader in cad_static.py this sees what the code does, not what it mentions, so a box
in dead code or a box that is cut down afterwards is measured as it really ends up.

The solid measured is, in order: the module-level name `result`; the last object passed to
`show_object(...)`; the CadQuery object bound by the last module-level assignment.

The worker is this same file run as a script. It needs cadquery; the parent side is
standard library only. The interpreter is $GAUGE_CAD_PYTHON, else the current one, and the
timeout is $GAUGE_CAD_TIMEOUT seconds, else 30.

Before any reference is run, a pre-flight run of the worker that is given no code finds out
whether the interpreter has cadquery. `unavailable` comes from that run alone, never from a
run that executed a reference, and is remembered for the process only when it is definite:
the worker's import raised ModuleNotFoundError for the module `cadquery` itself, or the
interpreter file does not exist. Any other failure of the import (a missing dependency, a
DLL that would not load, a MemoryError) and a worker that could not be started for another
reason are `not_run`, are never remembered, and are tried again on the next call.

A timeout bounds how long the code runs. It is not a sandbox: the code runs with the
permissions of the calling process.
"""
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
from collections import OrderedDict, namedtuple

OK = "ok"                    # the code ran and built a solid; size and volume are set
NO_SOLID = "no_solid"        # the code ran cleanly but left no solid to measure
ERROR = "error"              # the code raised, crashed, or the measurement was not finite
TIMEOUT = "timeout"          # the code did not finish in time
NOT_RUN = "not_run"          # the worker could not be run this time; nothing is known
UNAVAILABLE = "unavailable"  # the worker interpreter is missing or has no cadquery module

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
# The service answers each request on its own thread. Held for the cache bookkeeping only,
# never while a worker runs.
_cache_lock = threading.Lock()
_has_cadquery = {}       # python -> cadquery version, once a pre-flight has imported it
_no_cadquery = {}        # python -> detail, once a pre-flight has a definite "no"


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
    blocked = _preflight(python, timeout)
    if blocked is not None:
        return blocked
    key = (python, source)
    with _cache_lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]

    result = _run_reference(source, timeout, python)
    # A timeout depends on machine load and not_run on the machine: try again next time.
    if result.kind not in (TIMEOUT, NOT_RUN):
        with _cache_lock:
            _cache[key] = result
            while len(_cache) > _CACHE_SIZE:
                _cache.popitem(last=False)
    return result


def _preflight(python, timeout):
    """None when `python` can run the worker with cadquery, else the Measurement to give.

    Whether cadquery is there is decided here and only here, by a worker run that is given
    no reference code: nothing a reference does can make an interpreter look as if it had
    no cadquery. Only a definite answer is remembered: cadquery imported, the worker's own
    report that there is no module `cadquery` (it says unavailable for nothing else), or
    an interpreter file that does not exist. Anything else (the import failed for another
    reason, the process could not be started, it hung, it died) is not_run, and the next
    call asks again."""
    if python in _has_cadquery:
        return None
    if python in _no_cadquery:
        return Measurement(UNAVAILABLE, _no_cadquery[python])

    # A cold cadquery import can take longer than a short per-reference timeout.
    outcome, value = _spawn(None, max(timeout, DEFAULT_TIMEOUT_S), python)
    if outcome == _REPLIED:
        kind = value.get("kind")
        if kind == OK:
            _has_cadquery[python] = value.get("cadquery")
            return None
        if kind == UNAVAILABLE:
            _no_cadquery[python] = str(
                value.get("detail") or "cadquery is not available to the worker")
            return Measurement(UNAVAILABLE, _no_cadquery[python])
        if kind == NOT_RUN:  # the import failed for a reason that may pass: ask again
            return Measurement(NOT_RUN, str(
                value.get("detail") or "cadquery could not be imported this time"))
        return Measurement(
            NOT_RUN, "the worker gave no usable answer before any reference ran")
    if outcome == _FAILED_TO_START:
        if _interpreter_missing(python):
            _no_cadquery[python] = f"the worker interpreter could not be started ({value})"
            return Measurement(UNAVAILABLE, _no_cadquery[python])
        return Measurement(
            NOT_RUN, f"the worker interpreter could not be started this time ({value})")
    if outcome == _TIMED_OUT:
        return Measurement(
            NOT_RUN, f"the worker did not start within {value:g} s, before any reference ran")
    return Measurement(
        NOT_RUN, f"the worker died before any reference ran (exit code {value})")


def _interpreter_missing(python) -> bool:
    """True when there is no such interpreter: not a file, and not a command on PATH."""
    return not os.path.isfile(python) and shutil.which(python) is None


def _run_reference(source, timeout, python) -> Measurement:
    outcome, value = _spawn(source, timeout, python)
    if outcome == _TIMED_OUT:
        return Measurement(TIMEOUT, f"reference did not finish within {value:g} s")
    if outcome == _FAILED_TO_START:
        return Measurement(
            NOT_RUN, f"the worker interpreter could not be started this time ({value})")
    if outcome == _EXITED:
        return Measurement(ERROR, f"reference crashed the worker (exit code {value})")
    kind = value.get("kind")
    if kind == UNAVAILABLE:
        # The reference was handed to this run, so the answer may be the reference's own:
        # it can read the nonce off the worker's frame. The pre-flight has already seen
        # cadquery import, so this is never taken as "no cadquery" and never remembered.
        return Measurement(
            NOT_RUN, "the worker reported no cadquery in a run that was given the "
                     "reference, which is not accepted")
    if kind == NOT_RUN:
        # cadquery imported in the pre-flight and failed to in this run. Nothing was
        # measured, so nothing is known, and measure() does not remember a not_run.
        return Measurement(
            NOT_RUN, "the worker could not import cadquery in the run that was given "
                     "the reference")
    unusable = Measurement(ERROR, "reference left the worker with an answer it does not give")
    if kind not in (OK, NO_SOLID, ERROR):
        return unusable
    try:
        size = value.get("size")
        return Measurement(
            kind, str(value.get("detail") or ""),
            tuple(float(v) for v in size) if size else None,
            value.get("volume"), value.get("solids"), value.get("valid"),
            value.get("name"), value.get("cadquery"))
    except (ValueError, TypeError):
        return unusable


_REPLIED = "replied"                  # value: the worker's reply, a dict
_EXITED = "exited"                    # value: exit code of a worker that gave no reply
_TIMED_OUT = "timed_out"              # value: the timeout in seconds
_FAILED_TO_START = "failed_to_start"  # value: why, in words, without the path


def _spawn(source, timeout, python) -> tuple:
    """Run the worker once: (outcome, value), outcome being one of the constants above.

    `source` None is the pre-flight: the worker imports cadquery, says how that went and
    executes nothing."""
    # The worker answers on one stdout line that starts with a nonce only it was given, so
    # nothing the reference code prints can be mistaken for the answer.
    nonce = secrets.token_hex(16)
    request = {"nonce": nonce}
    if source is not None:
        request["source"] = source
    try:
        with tempfile.TemporaryDirectory(
                prefix="gauge-cad-", ignore_cleanup_errors=True) as cwd:
            done = subprocess.run(
                [python, "-X", "utf8", os.path.abspath(__file__)],
                input=json.dumps(request).encode("utf-8"), stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, cwd=cwd, timeout=timeout)
    except subprocess.TimeoutExpired:
        return _TIMED_OUT, timeout
    except OSError as err:
        return _FAILED_TO_START, err.strerror or type(err).__name__

    for line in reversed(done.stdout.decode("utf-8", "replace").splitlines()):
        if line.startswith(nonce + " "):
            try:
                reply = json.loads(line[len(nonce) + 1:])
            except ValueError:
                break
            if isinstance(reply, dict):
                return _REPLIED, reply
            break
    return _EXITED, done.returncode


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
    source, nonce = request.get("source"), request["nonce"]
    out = sys.stdout

    def reply(**payload):
        out.write(nonce + " " + json.dumps(payload) + "\n")
        out.flush()

    # The reference must not import the verifier's own modules by accident.
    here = os.path.dirname(os.path.abspath(__file__))
    sys.path[:] = [p for p in sys.path if os.path.abspath(p or os.curdir) != here]

    try:
        import cadquery as cq
    except Exception as err:
        # Only "there is no module called cadquery" says the interpreter has no cadquery.
        # A missing dependency, a DLL that would not load, a MemoryError: cadquery may well
        # import next time, so those are not_run. The type alone is given: messages of
        # import errors carry paths.
        if isinstance(err, ModuleNotFoundError) and err.name == "cadquery":
            reply(kind=UNAVAILABLE,
                  detail=f"cadquery is not available to the worker ({type(err).__name__})")
        else:
            reply(kind=NOT_RUN,
                  detail=f"cadquery could not be imported this time ({type(err).__name__})")
        return
    version = getattr(cq, "__version__", None)
    if source is None:  # the pre-flight: cadquery imports, and there is nothing to run
        reply(kind=OK, cadquery=version)
        return

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
