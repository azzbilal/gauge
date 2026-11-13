"""Tests for the executed geometry check of the M8 Verifier Pack. Run from the repo root:

    python -m unittest discover -s verify/verifiers/tests -v

The tests that execute reference code need cadquery in the worker interpreter
($GAUGE_CAD_PYTHON, else the one running the tests) and are SKIPPED without it. The
fallback tests run everywhere.
"""
import json
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

VERIFY_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(VERIFY_DIR))

from verifiers import VerifierPack  # noqa: E402
from verifiers import cad_exec  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"
DIMENSIONS = ["width", "depth", "height"]

_PROBE = cad_exec.measure("import cadquery\n")
CADQUERY = _PROBE.cadquery if _PROBE.kind != cad_exec.UNAVAILABLE else None
needs_cadquery = unittest.skipUnless(
    CADQUERY, f"no cadquery in the worker interpreter: {_PROBE.detail}")

# The three models the static check wrongly passes.
IF_FALSE = (FIXTURES / "plate_dead_code.py").read_text(encoding="utf-8")
NEVER_CALLED = (
    "import cadquery as cq\n"
    "def plate():\n"
    "    return cq.Workplane('XY').box(60, 40, 10)\n"
    "result = cq.Workplane('XY').sphere(5)\n"
)
CUT_IN_HALF = (
    "import cadquery as cq\n"
    "result = cq.Workplane('XY').box(60, 40, 10)\n"
    "result = result.faces('>X').workplane(-30).split(keepBottom=True)\n"
)


def setUpModule():
    print(f"\n[test_geometry] worker: {cad_exec.worker_python()}  "
          f"cadquery: {CADQUERY or 'NOT AVAILABLE, executed tests are skipped'}",
          file=sys.stderr)


def reference(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def packet(reference_code: str) -> dict:
    """A 60 x 40 x 10 mm plate with four 5 mm holes."""
    return {
        "prompt": "Model a mounting plate.",
        "spec": "Plate 60 mm wide, 40 mm deep, 10 mm tall with 4 holes of 5 mm diameter.",
        "reference": reference_code,
        "requirements": [
            {"id": "R1", "kind": "dimension", "text": "The plate is 60 mm wide."},
            {"id": "R2", "kind": "dimension", "text": "The plate is 40 mm deep."},
            {"id": "R3", "kind": "dimension", "text": "The plate is 10 mm tall."},
            {"id": "R4", "kind": "hole", "text": "The plate has 4 mounting holes."},
            {"id": "R5", "kind": "hole", "text": "Hole diameter is 5 mm.",
             "tolerance": "±0.1 mm"},
            {"id": "R6", "kind": "manifold", "text": "The solid is manifold."},
            {"id": "R7", "kind": "volume", "text": "Volume is about 23215 mm3."},
        ],
        "rubricItems": [
            {"id": "width", "requirementId": "R1", "checkMethod": "machine", "text": "Width"},
            {"id": "depth", "requirementId": "R2", "checkMethod": "machine", "text": "Depth"},
            {"id": "height", "requirementId": "R3", "checkMethod": "machine", "text": "H"},
            {"id": "holes", "requirementId": "R4", "checkMethod": "machine", "text": "Count"},
            {"id": "hole_d", "requirementId": "R5", "checkMethod": "machine", "text": "Size"},
            {"id": "manifold", "requirementId": "R6", "checkMethod": "machine", "text": ""},
            {"id": "volume", "requirementId": "R7", "checkMethod": "machine", "text": ""},
        ],
    }


def executed(code, **kwargs) -> dict:
    verdicts = VerifierPack(execute=True, **kwargs).verify(packet(code))
    return {v["rubric_item_id"]: v for v in verdicts}


def static(code) -> dict:
    verdicts = VerifierPack(execute=False).verify(packet(code))
    return {v["rubric_item_id"]: v for v in verdicts}


@needs_cadquery
class Measure(unittest.TestCase):
    def test_bounding_box_and_volume_of_the_reference(self):
        m = cad_exec.measure(reference("plate_ok.py"))
        self.assertEqual(m.kind, "ok", m)
        self.assertEqual(m.name, "result")
        for got, want in zip(m.size, (60, 40, 10)):
            self.assertAlmostEqual(got, want, places=6)
        # 60 * 40 * 10 minus four 5 mm through holes
        self.assertAlmostEqual(m.volume, 24000 - 4 * 3.141592653589793 * 2.5 ** 2 * 10, 3)
        self.assertEqual(m.solids, 1)
        self.assertTrue(m.valid)

    def test_result_is_found_without_the_name_result(self):
        m = cad_exec.measure(
            "import cadquery as cq\n"
            "print('noise on stdout')\n"
            "part = cq.Workplane('XY').box(60, 40, 10)\n"
            "part = part.faces('>Z').workplane()\n"  # the stack holds a plane, not a solid
        )
        self.assertEqual((m.kind, m.name), ("ok", "part"), m)
        self.assertAlmostEqual(m.size[0], 60, places=6)
        shown = cad_exec.measure(
            "import cadquery as cq\nshow_object(cq.Workplane('XY').box(1, 2, 3))\n")
        self.assertEqual(shown.kind, "ok", shown)
        self.assertAlmostEqual(shown.volume, 6, places=6)

    def test_outcomes_that_are_not_a_measurement(self):
        for code, kind in (
            ("import cadquery as cq\nresult = cq.Workplane('XY').rect(60, 40)\n", "no_solid"),
            ("x = 1\n", "no_solid"),
            ("raise RuntimeError('boom')\n", "error"),
            ("raise SystemExit(0)\n", "error"),
            ("import os\nos._exit(3)\n", "error"),
            ("import cadquery as cq\nr = cq.Workplane('XY').box(1e999, 40, 10)\n", "error"),
        ):
            self.assertEqual(cad_exec.measure(code).kind, kind, code)

    def test_timeout(self):
        m = cad_exec.measure("while True:\n    pass\n", timeout=3)
        self.assertEqual(m.kind, "timeout", m)
        self.assertIn("3 s", m.detail)


@needs_cadquery
class CorrectReference(unittest.TestCase):
    def setUp(self):
        self.v = executed(reference("plate_ok.py"))

    def test_dimensions_pass_on_the_measured_solid(self):
        for item in DIMENSIONS:
            self.assertEqual(self.v[item]["status"], "pass", self.v[item])
            self.assertEqual(self.v[item]["check"], "geometry_cad")
        self.assertEqual(
            self.v["width"]["detail"],
            "width 60 mm matches spec, measured on the executed solid `result`")

    def test_holes_are_still_read_statically(self):
        for item in ("holes", "hole_d"):
            self.assertEqual(self.v[item]["status"], "pass", self.v[item])
            self.assertEqual(self.v[item]["check"], "static_cad")

    def test_volume_is_measured(self):
        self.assertEqual(self.v["volume"]["status"], "pass", self.v["volume"])
        self.assertEqual(self.v["volume"]["check"], "manifold_volume")
        self.assertIn("23214.6 mm3", self.v["volume"]["detail"])

    def test_manifold_alone_is_not_claimed(self):
        self.assertEqual(self.v["manifold"]["status"], "not_run")
        self.assertIn("not implemented", self.v["manifold"]["detail"])


@needs_cadquery
class WrongModels(unittest.TestCase):
    def test_wrong_dimension_fails_on_the_measured_solid(self):
        v = executed(reference("plate_wrong_dimension.py"))
        self.assertEqual(v["width"]["status"], "fail")
        self.assertEqual(
            v["width"]["detail"],
            "width: spec requires 60 mm but the executed solid `result` measures 65 mm "
            "along X")
        self.assertTrue(v["depth"]["pass"])
        self.assertTrue(v["height"]["pass"])
        self.assertEqual(v["volume"]["status"], "fail")

    def test_wrong_volume_fails(self):
        p = packet(reference("plate_ok.py"))
        p["requirements"][6]["text"] = "Volume is about 24000 mm3."
        v = {x["rubric_item_id"]: x for x in VerifierPack(execute=True).verify(p)}
        self.assertEqual(v["volume"]["status"], "fail")
        self.assertEqual(
            v["volume"]["detail"],
            "volume: spec requires 24000 ± 24 mm3 but the executed solid `result` has "
            "23214.6 mm3")
        p["requirements"][6]["tolerance"] = "5%"
        v = {x["rubric_item_id"]: x for x in VerifierPack(execute=True).verify(p)}
        self.assertEqual(v["volume"]["status"], "pass")


@needs_cadquery
class StaticCheckWronglyPassed(unittest.TestCase):
    """Each model mentions a 60 x 40 x 10 box, so the static check passes it. None of them
    builds one, so the executed check must fail it."""

    def assert_static_passes_but_executed_fails(self, code, failing, measures):
        before, after = static(code), executed(code)
        for item in failing:
            self.assertEqual(before[item]["status"], "pass", before[item])  # the old bug
            self.assertEqual(after[item]["status"], "fail", after[item])
            self.assertIs(after[item]["pass"], False)
            self.assertEqual(after[item]["check"], "geometry_cad")
        self.assertIn(measures, after[failing[0]]["detail"])
        return after

    def test_box_inside_if_false_result_is_a_sphere(self):
        v = self.assert_static_passes_but_executed_fails(
            IF_FALSE, ["width", "depth"], "`result` measures 10 mm along X")
        self.assertTrue(v["height"]["pass"])  # a 10 mm sphere is 10 mm tall
        self.assertEqual(v["volume"]["status"], "fail")

    def test_box_in_a_function_that_is_never_called(self):
        self.assert_static_passes_but_executed_fails(
            NEVER_CALLED, ["width", "depth"], "`result` measures 10 mm along X")

    def test_never_called_function_and_nothing_else_built(self):
        code = NEVER_CALLED.rsplit("result", 1)[0]  # drop the sphere: no solid at all
        v = self.assert_static_passes_but_executed_fails(
            code, DIMENSIONS, "built no CadQuery object")
        self.assertEqual(v["volume"]["status"], "fail")

    def test_box_cut_in_half_afterwards(self):
        v = self.assert_static_passes_but_executed_fails(
            CUT_IN_HALF, ["width"], "`result` measures 30 mm along X")
        self.assertTrue(v["depth"]["pass"])
        self.assertTrue(v["height"]["pass"])


@needs_cadquery
class ExecutionBeatsStaticLimits(unittest.TestCase):
    def test_computed_dimension_is_measured(self):
        code = (
            "import cadquery as cq\n"
            "def plate(w):\n"
            "    return cq.Workplane('XY').box(w, 40, 10)\n"
            "r = plate(60)\n"
        )
        self.assertEqual(static(code)["width"]["status"], "not_run")
        self.assertEqual(executed(code)["width"]["status"], "pass")
        self.assertEqual(executed(code.replace("plate(60)", "plate(61)"))["width"]["status"],
                         "fail")


@needs_cadquery
class WhatTheBoundingBoxMeans(unittest.TestCase):
    """Rules a correct-looking reference can trip over. They are deliberate."""

    def test_sizes_are_overall_extents_along_world_axes(self):
        on_xz = executed("import cadquery as cq\n"
                         "result = cq.Workplane('XZ').box(60, 40, 10)\n")
        self.assertTrue(on_xz["width"]["pass"])
        self.assertEqual(on_xz["height"]["status"], "fail")  # 40 mm along world Z
        with_boss = executed(
            "import cadquery as cq\n"
            "result = cq.Workplane('XY').box(60, 40, 10).faces('>Z').workplane()"
            ".circle(5).extrude(5)\n")
        self.assertTrue(with_boss["width"]["pass"])
        self.assertIn("measures 15 mm along Z", with_boss["height"]["detail"])

    def test_without_result_the_last_assigned_object_is_measured_and_named(self):
        v = executed(
            "import cadquery as cq\n"
            "plate = cq.Workplane('XY').box(60, 40, 10)\n"
            "cutter = cq.Workplane('XY').circle(2.5).extrude(20)\n")
        self.assertEqual(v["width"]["status"], "fail")
        self.assertIn("`cutter`", v["width"]["detail"])


@needs_cadquery
class ReferenceThatDoesNotFinish(unittest.TestCase):
    """A reference that raises, crashes or times out is never read statically: the source
    says what was written, not what was built."""

    PLATE = "import cadquery as cq\nresult = cq.Workplane('XY').box(60, 40, 10)\n"
    CAD_ITEMS = DIMENSIONS + ["holes", "hole_d"]

    def assert_no_static_reading(self, v, status, reason):
        for item in self.CAD_ITEMS:
            self.assertEqual(v[item]["status"], status, v[item])
            self.assertIs(v[item]["pass"], False)
            self.assertEqual(v[item]["check"], "geometry_cad")
            self.assertIn(reason, v[item]["detail"])
            self.assertNotIn("static fallback", v[item]["detail"])
            self.assertNotIn("matches spec", v[item]["detail"])

    def test_reference_that_raises_fails(self):
        v = executed(self.PLATE + "raise RuntimeError('boom')\n")
        self.assert_no_static_reading(v, "fail", "reference raised RuntimeError: boom")
        self.assertEqual(v["volume"]["status"], "not_run")
        self.assertIn("reference raised RuntimeError: boom", v["volume"]["detail"])

    def test_reference_that_times_out_is_not_run(self):
        v = executed(self.PLATE + "while True:\n    pass\n", timeout=3)
        self.assert_no_static_reading(v, "not_run", "did not finish within 3 s")
        self.assertEqual(v["volume"]["status"], "not_run")
        self.assertIn("did not finish within 3 s", v["volume"]["detail"])

    def test_dead_code_followed_by_a_crash_fails(self):
        # The plate and its holes sit in a branch that never runs, so the static reader
        # passes every item. The script then dies: nothing it mentions was delivered.
        for ending, reason in (
            ("raise RuntimeError('boom')\n", "reference raised RuntimeError: boom"),
            ("raise SystemExit(0)\n", "reference raised SystemExit"),
            ("import os\nos._exit(3)\n", "reference crashed the worker (exit code 3)"),
        ):
            with self.subTest(ending=ending):
                code = IF_FALSE + "\n" + ending
                before = static(code)
                for item in self.CAD_ITEMS:
                    self.assertEqual(before[item]["status"], "pass", before[item])
                self.assert_no_static_reading(executed(code), "fail", reason)

    def test_dead_code_followed_by_a_hang_is_not_run(self):
        v = executed(IF_FALSE + "\nwhile True:\n    pass\n", timeout=3)
        self.assert_no_static_reading(v, "not_run", "did not finish within 3 s")

    def test_a_raise_fails_whatever_the_source_says(self):
        v = executed(self.PLATE.replace("60", "65") + "raise RuntimeError('boom')\n")
        self.assertEqual(v["width"]["status"], "fail")
        self.assertIn("reference raised RuntimeError: boom", v["width"]["detail"])
        self.assertNotIn("65 mm", v["width"]["detail"])

    def test_huge_numbers_do_not_crash_or_pass(self):
        for code in (
            "import cadquery as cq\nr = cq.Workplane('XY').box(" + "9" * 400 + ", 40, 10)\n",
            "import cadquery as cq\nr = cq.Workplane('XY').box(1e999, 40, 10)\n",
        ):
            self.assertEqual(cad_exec.measure(code).kind, "error", code)
            v = executed(code)
            self.assertEqual(v["width"]["status"], "fail", v["width"])
            self.assertIs(v["width"]["pass"], False)


class FallbackWithoutCadquery(unittest.TestCase):
    """Runs everywhere: the worker interpreter does not exist, so nothing is executed."""

    MISSING = str(Path(__file__).parent / "no-such-python")

    def test_static_check_is_used_and_says_why(self):
        v = executed(reference("plate_ok.py"), python=self.MISSING)
        for item in DIMENSIONS:
            self.assertEqual(v[item]["status"], "pass", v[item])
            self.assertEqual(v[item]["check"], "static_cad")
            self.assertIn(
                "[static fallback: the worker interpreter could not be started",
                v[item]["detail"])
            self.assertNotIn("no-such-python", v[item]["detail"])  # no paths in verdicts
        self.assertEqual(v["holes"]["detail"], "mounting hole count 4 matches spec")
        self.assertEqual(v["volume"]["status"], "not_run")
        self.assertEqual(v["volume"]["detail"], "needs cadquery")

    def test_static_check_still_fails_a_wrong_dimension(self):
        v = executed(reference("plate_wrong_dimension.py"), python=self.MISSING)
        self.assertEqual(v["width"]["status"], "fail")
        self.assertIn("spec requires 60 mm but reference has 65 mm", v["width"]["detail"])

    def test_execute_false_runs_nothing(self):
        v = static("raise SystemExit('executed')\n")
        self.assertEqual(v["width"]["status"], "fail")
        self.assertIn("no box", v["width"]["detail"])
        self.assertEqual(v["volume"]["detail"], "needs cadquery")


class _Caches:
    """Gives a test empty cad_exec caches and puts the real ones back afterwards."""

    def setUp(self):
        for cache in (cad_exec._cache, cad_exec._has_cadquery, cad_exec._no_cadquery):
            patch = mock.patch.dict(cache, clear=True)
            patch.start()
            self.addCleanup(patch.stop)


def worker_run(reply=None, returncode=0):
    """A stand-in for subprocess.run: the worker answers `reply` to whatever it is sent.
    `reply` may be a function of the request. The requests are kept in `.requests`."""
    requests = []

    def run(argv, input=None, **kwargs):
        request = json.loads(input.decode("utf-8"))
        requests.append(request)
        answer = reply(request) if callable(reply) else reply
        if isinstance(answer, BaseException):
            raise answer
        line = "" if answer is None else request["nonce"] + " " + json.dumps(answer) + "\n"
        return subprocess.CompletedProcess(argv, returncode, line.encode("utf-8"), b"")

    run.requests = requests
    return run


class WorkerThatCannotBeStarted(_Caches, unittest.TestCase):
    """Runs everywhere. A spawn failure is remembered only when it is definite."""

    PLATE = "import cadquery as cq\nresult = cq.Workplane('XY').box(60, 40, 10)\n"
    DENIED = PermissionError(13, "Permission denied")

    def test_transient_spawn_failure_is_not_run_and_not_remembered(self):
        python = sys.executable  # the file exists: the failure says nothing definite
        with mock.patch("subprocess.run", worker_run(self.DENIED)) as run:
            m = cad_exec.measure(self.PLATE, python=python)
            self.assertEqual(m.kind, "not_run", m)
            self.assertIn("could not be started this time (Permission denied)", m.detail)
            self.assertNotIn(python, m.detail)
            self.assertEqual(len(run.requests), 1)
        self.assertEqual(cad_exec._no_cadquery, {})
        self.assertEqual(cad_exec._has_cadquery, {})
        self.assertEqual(cad_exec._cache, {})

        # The next call asks again, and a worker that now starts is used.
        ok = {"kind": "ok", "cadquery": "9.9", "name": "result",
              "size": [60, 40, 10], "volume": 24000.0, "solids": 1, "valid": True}
        with mock.patch("subprocess.run", worker_run(ok)) as run:
            m = cad_exec.measure(self.PLATE, python=python)
            self.assertEqual((m.kind, m.size), ("ok", (60.0, 40.0, 10.0)), m)
            self.assertEqual(["source" in r for r in run.requests], [False, True])

    def test_transient_spawn_failure_gives_not_run_verdicts_not_a_static_pass(self):
        with mock.patch("subprocess.run", worker_run(self.DENIED)):
            v = executed(reference("plate_ok.py"), python=sys.executable)
        for item in DIMENSIONS + ["holes", "hole_d"]:
            self.assertEqual(v[item]["status"], "not_run", v[item])
            self.assertEqual(v[item]["check"], "geometry_cad")
            self.assertIn("could not be started this time", v[item]["detail"])
            self.assertNotIn("static fallback", v[item]["detail"])
        self.assertEqual(v["volume"]["status"], "not_run")
        self.assertNotEqual(v["volume"]["detail"], "needs cadquery")

    def test_spawn_failure_after_the_preflight_is_not_run_and_not_remembered(self):
        def reply(request):
            return self.DENIED if "source" in request else {"kind": "ok", "cadquery": "9.9"}

        with mock.patch("subprocess.run", worker_run(reply)):
            m = cad_exec.measure(self.PLATE, python=sys.executable)
        self.assertEqual(m.kind, "not_run", m)
        self.assertEqual(cad_exec._no_cadquery, {})
        self.assertEqual(cad_exec._cache, {})

    def test_preflight_that_hangs_or_dies_is_not_run_and_not_remembered(self):
        hang = subprocess.TimeoutExpired("python", 30)
        for reply, code, reason in ((hang, 0, "did not start within"),
                                    (None, 3, "died before any reference ran (exit code 3)"),
                                    ({"kind": "error"}, 0, "no usable answer")):
            with self.subTest(reason=reason):
                with mock.patch("subprocess.run", worker_run(reply, code)) as run:
                    m = cad_exec.measure(self.PLATE, python=sys.executable)
                    self.assertEqual(m.kind, "not_run", m)
                    self.assertIn(reason, m.detail)
                    self.assertEqual(["source" in r for r in run.requests], [False])
                self.assertEqual(cad_exec._no_cadquery, {})
                self.assertEqual(cad_exec._has_cadquery, {})

    def test_missing_interpreter_is_unavailable_and_remembered(self):
        missing = FallbackWithoutCadquery.MISSING
        m = cad_exec.measure(self.PLATE, python=missing)
        self.assertEqual(m.kind, "unavailable", m)
        self.assertIn("the worker interpreter could not be started", m.detail)
        self.assertEqual(list(cad_exec._no_cadquery), [missing])
        with mock.patch("subprocess.run", worker_run(self.DENIED)) as run:
            self.assertEqual(cad_exec.measure(self.PLATE, python=missing), m)
            self.assertEqual(run.requests, [])  # remembered: not asked again

    def test_import_failure_reported_by_the_preflight_is_remembered(self):
        no = {"kind": "unavailable",
              "detail": "cadquery is not available to the worker (ModuleNotFoundError)"}
        with mock.patch("subprocess.run", worker_run(no)) as run:
            first = cad_exec.measure(self.PLATE, python=sys.executable)
            second = cad_exec.measure("x = 1\n", python=sys.executable)
            self.assertEqual(run.requests, [{"nonce": run.requests[0]["nonce"]}])
        self.assertEqual((first.kind, second), ("unavailable", first))
        self.assertIn("ModuleNotFoundError", first.detail)
        v = executed(reference("plate_ok.py"), python=sys.executable)
        self.assertEqual(v["width"]["check"], "static_cad")
        self.assertIn("[static fallback: cadquery is not available", v["width"]["detail"])


# The reference finds the worker's nonce in the frame that called it, answers in the
# worker's place that there is no cadquery, and leaves before the worker can answer.
FORGED_UNAVAILABLE = (
    "import json, os, sys\n"
    "nonce = sys._getframe(1).f_locals['nonce']\n"
    "os.write(1, (nonce + ' ' + json.dumps({'kind': 'unavailable',"
    " 'detail': 'cadquery is not available to the worker (forged)'}) + '\\n').encode())\n"
    "os._exit(0)\n"
)


class ForgedUnavailableReply(_Caches, unittest.TestCase):
    """`unavailable` opens the static fallback, which passes a box in dead code. A
    reference must not be able to say it for the worker."""

    def test_unavailable_from_a_run_given_the_reference_is_refused(self):
        # Runs everywhere: the pre-flight sees cadquery, the reference run says otherwise.
        def reply(request):
            if "source" in request:
                return {"kind": "unavailable", "detail": "forged"}
            return {"kind": "ok", "cadquery": "9.9"}

        with mock.patch("subprocess.run", worker_run(reply)) as run:
            m = cad_exec.measure(IF_FALSE, python=sys.executable)
            v = executed(IF_FALSE, python=sys.executable)
            self.assertEqual(["source" in r for r in run.requests], [False, True, True])
        self.assertEqual(m.kind, "not_run", m)
        self.assertNotIn("forged", m.detail)
        self.assertEqual(cad_exec._no_cadquery, {})
        self.assertEqual(cad_exec._cache, {})
        for item in DIMENSIONS + ["holes", "hole_d"]:
            self.assertEqual(v[item]["status"], "not_run", v[item])
            self.assertEqual(v[item]["check"], "geometry_cad")
            self.assertNotIn("static fallback", v[item]["detail"])
        self.assertNotEqual(v["volume"]["detail"], "needs cadquery")

    def test_unknown_kind_from_a_reference_run_is_an_error(self):
        def reply(request):
            return {"kind": "skip" if "source" in request else "ok"}

        with mock.patch("subprocess.run", worker_run(reply)):
            self.assertEqual(cad_exec.measure("x = 1\n", python=sys.executable).kind, "error")

    @needs_cadquery
    def test_reference_that_forges_the_reply_for_real(self):
        python = cad_exec.worker_python()
        code = IF_FALSE + "\n" + FORGED_UNAVAILABLE
        for item in DIMENSIONS:  # what the forgery is after: the static reading passes
            self.assertEqual(static(code)[item]["status"], "pass")

        m = cad_exec.measure(code)
        self.assertEqual(m.kind, "not_run", m)
        self.assertNotIn("forged", m.detail)
        v = executed(code)
        for item in DIMENSIONS + ["holes", "hole_d"]:
            self.assertEqual(v[item]["status"], "not_run", v[item])
            self.assertIs(v[item]["pass"], False)
            self.assertEqual(v[item]["check"], "geometry_cad")
            self.assertNotIn("static fallback", v[item]["detail"])
        self.assertEqual(v["volume"]["status"], "not_run")
        self.assertNotEqual(v["volume"]["detail"], "needs cadquery")

        # The interpreter is not poisoned for the references that follow.
        self.assertEqual(cad_exec._no_cadquery, {})
        self.assertEqual(list(cad_exec._has_cadquery), [python])
        self.assertEqual(cad_exec.measure(reference("plate_ok.py")).kind, "ok")
        self.assertEqual(executed(reference("plate_ok.py"))["width"]["check"], "geometry_cad")


if __name__ == "__main__":
    unittest.main()
