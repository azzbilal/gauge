"""Tests for the M8 Verifier Pack static checks (the executed geometry check is in
test_geometry.py). Run from the repo root:

    python -m unittest discover -s verify/verifiers/tests -v
"""
import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import HTTPServer
from pathlib import Path
from unittest import mock

VERIFY_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(VERIFY_DIR))
sys.path.insert(0, str(VERIFY_DIR / "service"))

from verifiers import PacketError, VerifierPack, verify  # noqa: E402
from verifiers.cad_static import extract_model  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"


def setUpModule():
    # These tests pin the static path: no reference code is executed here. The executed
    # geometry check has its own tests in test_geometry.py.
    global _static_only
    _static_only = mock.patch.dict(os.environ, {"GAUGE_CAD_EXEC": "0"})
    _static_only.start()


def tearDownModule():
    _static_only.stop()


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
            {"id": "R8", "kind": "finish", "text": "The part looks clean."},
        ],
        "rubricItems": [
            {"id": "width", "requirementId": "R1", "checkMethod": "machine", "text": "Width"},
            {"id": "depth", "requirementId": "R2", "checkMethod": "MACHINE", "text": "Depth"},
            {"id": "height", "requirementId": "R3", "text": "Height dimension"},
            {"id": "holes", "requirementId": "R4", "checkMethod": "machine", "text": "Count"},
            {"id": "hole_d", "requirementId": "R5", "checkMethod": "machine", "text": "Size"},
            {"id": "manifold", "requirementId": "R6", "checkMethod": "machine", "text": ""},
            {"id": "volume", "requirementId": "R7", "checkMethod": "machine", "text": ""},
            {"id": "looks", "requirementId": "R8", "checkMethod": "visual", "text": "Looks"},
        ],
    }


STATIC_ITEMS = ["width", "depth", "height", "holes", "hole_d"]


def by_item(verdicts) -> dict:
    return {v["rubric_item_id"]: v for v in verdicts}


class CorrectReference(unittest.TestCase):
    def setUp(self):
        self.verdicts = verify(packet(reference("plate_ok.py")))
        self.v = by_item(self.verdicts)

    def test_one_verdict_per_machine_item(self):
        self.assertEqual(
            [v["rubric_item_id"] for v in self.verdicts],
            STATIC_ITEMS + ["manifold", "volume"],
        )
        for verdict in self.verdicts:
            self.assertIsInstance(verdict["pass"], bool)
            self.assertIsInstance(verdict["detail"], str)

    def test_static_items_pass(self):
        for item in STATIC_ITEMS:
            self.assertTrue(self.v[item]["pass"], self.v[item])
            self.assertEqual(self.v[item]["status"], "pass")
            self.assertEqual(self.v[item]["check"], "static_cad")

    def test_manifold_and_volume_not_run(self):
        for item in ("manifold", "volume"):
            self.assertEqual(self.v[item]["status"], "not_run")
            self.assertIs(self.v[item]["pass"], False)
            self.assertEqual(self.v[item]["detail"], "needs cadquery")
            self.assertEqual(self.v[item]["check"], "manifold_volume")

    def test_visual_item_gets_no_verdict(self):
        self.assertNotIn("looks", self.v)


class WrongModels(unittest.TestCase):
    def assert_only_fails(self, verdicts, failing):
        v = by_item(verdicts)
        for item in STATIC_ITEMS:
            self.assertEqual(v[item]["pass"], item != failing, v[item])
        return v[failing]

    def test_wrong_dimension(self):
        verdict = self.assert_only_fails(
            verify(packet(reference("plate_wrong_dimension.py"))), "width")
        self.assertEqual(verdict["status"], "fail")
        self.assertEqual(
            verdict["detail"], "width: spec requires 60 mm but reference has 65 mm")

    def test_wrong_hole_count(self):
        verdict = self.assert_only_fails(
            verify(packet(reference("plate_wrong_hole_count.py"))), "holes")
        self.assertEqual(verdict["status"], "fail")
        self.assertEqual(
            verdict["detail"], "mounting hole count: spec requires 4 but reference has 3")


class StaticReader(unittest.TestCase):
    def test_circle_radius_cut_is_a_hole(self):
        model = extract_model(
            "import cadquery as cq\n"
            "r = cq.Workplane('XY').box(60, 40, 10)\n"
            "r = r.faces('>Z').workplane().rarray(20, 20, 2, 2).circle(5 / 2).cutThruAll()\n"
        )
        self.assertEqual(model.boxes[0].dims, (60.0, 40.0, 10.0))
        self.assertEqual(model.hole_count, 4)
        self.assertEqual(model.holes[0].diameter, 5.0)

    def test_rect_circle_extrude(self):
        model = extract_model(
            "import cadquery as cq\n"
            "r = cq.Workplane('XY').rect(60, 40).pushPoints([(0, 0), (10, 0)])"
            ".circle(2.5).extrude(10)\n"
        )
        self.assertEqual(model.boxes[0].dims, (60.0, 40.0, 10.0))
        self.assertEqual(model.hole_count, 2)

    def test_state_carries_across_statements_and_keywords(self):
        model = extract_model(
            "import cadquery as cq\n"
            "wp = cq.Workplane('XY').box(length=60, width=40, height=10)\n"
            "pts = wp.faces('>Z').workplane().polarArray(15, 0, 360, 6)\n"
            "out = pts.hole(diameter=3)\n"
        )
        self.assertEqual(model.hole_count, 6)
        self.assertEqual(model.holes[0].diameter, 3.0)

    def test_extruded_circle_is_a_boss_not_a_hole(self):
        model = extract_model("r = cq.Workplane('XY').circle(10).extrude(5)\n")
        self.assertEqual(model.holes, [])
        self.assertEqual(model.bosses, [10.0])

    def test_selector_and_repeated_rect_vertices(self):
        base = "r = cq.Workplane('XY').box(60, 40, 10).faces('>Z').workplane()"
        subset = extract_model(
            base + ".rect(40, 20, forConstruction=True).vertices('>X').hole(5)\n")
        self.assertIsNone(subset.hole_count)
        repeated = extract_model(
            base + ".pushPoints([(0, 0), (5, 5)]).rect(4, 2, forConstruction=True)"
            ".vertices().hole(1)\n")
        self.assertEqual(repeated.hole_count, 8)

    def test_unknown_chain_root_has_unknown_stack(self):
        model = extract_model("r = base().hole(5)\n")
        self.assertIsNone(model.hole_count)
        bare = extract_model(
            "from cadquery import Workplane\nr = Workplane('XY').box(1, 2, 3).hole(1)\n")
        self.assertEqual(bare.hole_count, 1)
        self.assertFalse(bare.boxes[0].repeated)

    def test_reference_is_never_executed(self):
        model = extract_model("raise SystemExit('executed')\nimport os; os.abort()\n")
        self.assertEqual(model.boxes, [])


class FailClosed(unittest.TestCase):
    def verdicts_for(self, code):
        return by_item(verify(packet(code)))

    def test_holes_in_a_loop_are_not_counted(self):
        v = self.verdicts_for(
            "import cadquery as cq\n"
            "r = cq.Workplane('XY').box(60, 40, 10)\n"
            "for x, y in [(-20, -10), (20, -10), (20, 10), (-20, 10)]:\n"
            "    r = r.faces('>Z').workplane().center(x, y).hole(5)\n"
        )
        self.assertEqual(v["holes"]["status"], "not_run")
        self.assertIs(v["holes"]["pass"], False)
        self.assertIn("not statically resolvable", v["holes"]["detail"])
        self.assertTrue(v["width"]["pass"])
        self.assertTrue(v["hole_d"]["pass"])

    def test_cut_makes_hole_count_unresolvable(self):
        v = self.verdicts_for(
            "import cadquery as cq\n"
            "r = cq.Workplane('XY').box(60, 40, 10)\n"
            "r = r.cut(cq.Workplane('XY').circle(2.5).extrude(20))\n"
        )
        self.assertEqual(v["holes"]["status"], "not_run")
        self.assertIn("cut", v["holes"]["detail"])

    def test_computed_dimension_is_not_run(self):
        v = self.verdicts_for(
            "import cadquery as cq\n"
            "def plate(w):\n"
            "    return cq.Workplane('XY').box(w, 40, 10)\n"
            "r = plate(60)\n"
        )
        self.assertEqual(v["width"]["status"], "not_run")
        self.assertTrue(v["depth"]["pass"])

    def test_missing_box_and_holes_fail(self):
        v = self.verdicts_for("import cadquery as cq\nr = cq.Workplane('XY').sphere(5)\n")
        self.assertEqual(v["width"]["status"], "fail")
        self.assertIn("no box", v["width"]["detail"])
        self.assertEqual(v["holes"]["detail"],
                         "mounting hole count: spec requires 4 but reference has 0")
        self.assertEqual(v["hole_d"]["status"], "fail")

    def test_syntax_error_fails_static_items(self):
        v = self.verdicts_for("result = cq.Workplane('XY').box(60, 40,\n")
        for item in STATIC_ITEMS:
            self.assertEqual(v[item]["status"], "fail")
            self.assertIn("does not parse", v[item]["detail"])
        self.assertEqual(v["manifold"]["detail"], "needs cadquery")

    def test_huge_numbers_do_not_crash_or_pass(self):
        hole = ".faces('>Z').workplane().rarray(10, 10, 1e999, 2).hole(5)\n"
        for code, item in (
            ("r = cq.Workplane('XY').box(" + "9" * 400 + ", 40, 10)\n", "width"),
            ("r = cq.Workplane('XY').box(1e999, 40, 10)\n", "width"),
            ("x = 9**64\nx = x**64\nx = x**64\nr = cq.Workplane('XY').box(x, 40, 10)\n",
             "width"),
            ("r = cq.Workplane('XY').box(60, 40, 10)" + hole, "holes"),
        ):
            v = self.verdicts_for(code)
            self.assertEqual(v[item]["status"], "not_run", code[:40])
            self.assertTrue(v["depth"]["pass"])

    def test_kernel_requirement_with_other_kind_still_needs_cadquery(self):
        p = packet(reference("plate_ok.py"))
        p["requirements"][5]["kind"] = "geometry"
        self.assertEqual(by_item(verify(p))["manifold"]["detail"], "needs cadquery")

    def test_empty_reference_fails(self):
        v = self.verdicts_for("")
        self.assertEqual(v["width"]["detail"], "packet has no reference code")

    def test_unsupported_quantity_is_not_run(self):
        p = packet(reference("plate_ok.py"))
        p["requirements"].append(
            {"id": "R9", "kind": "dimension", "text": "Fillet radius is 2 mm."})
        p["rubricItems"].append({"id": "fillet", "requirementId": "R9"})
        verdict = by_item(verify(p))["fillet"]
        self.assertEqual(verdict["status"], "not_run")
        self.assertIn("fillet radius", verdict["detail"])


class SpecSide(unittest.TestCase):
    def test_tolerance_is_honoured(self):
        p = packet(reference("plate_ok.py").replace("hole_d = 5", "hole_d = 5.05"))
        self.assertTrue(by_item(verify(p))["hole_d"]["pass"])
        p = packet(reference("plate_ok.py").replace("hole_d = 5", "hole_d = 5.2"))
        verdict = by_item(verify(p))["hole_d"]
        self.assertEqual(
            verdict["detail"],
            "hole diameter: spec requires 5 ± 0.1 mm but reference has 5.2 mm")

    def test_unparseable_tolerance_means_exact_match(self):
        for tolerance in ("H7", "ISO 2768-m", "±5%"):
            p = packet(reference("plate_ok.py").replace("hole_d = 5", "hole_d = 5.5"))
            p["requirements"][4]["tolerance"] = tolerance
            verdict = by_item(verify(p))["hole_d"]
            self.assertEqual(verdict["status"], "fail", tolerance)
            self.assertIn("not understood", verdict["detail"])

    def test_radius_and_units(self):
        p = packet(reference("plate_ok.py"))
        p["requirements"][4] = {"id": "R5", "kind": "hole", "text": "Hole radius is 0.25 cm."}
        self.assertTrue(by_item(verify(p))["hole_d"]["pass"])

    def test_value_field_overrides_text(self):
        p = packet(reference("plate_ok.py"))
        p["requirements"][0] = {
            "id": "R1", "kind": "dimension", "text": "Overall width", "value": "62 mm"}
        verdict = by_item(verify(p))["width"]
        self.assertEqual(
            verdict["detail"], "width: spec requires 62 mm but reference has 60 mm")

    def test_length_naming_maps_to_cadquery_axes(self):
        p = packet(reference("plate_ok.py"))
        p["requirements"][0]["text"] = "The plate is 60 mm long."
        p["requirements"][1]["text"] = "The plate is 40 mm wide."
        v = by_item(verify(p))
        self.assertTrue(v["width"]["pass"], v["width"])
        self.assertTrue(v["depth"]["pass"], v["depth"])

    def test_several_quantities_in_one_requirement(self):
        p = packet(reference("plate_wrong_dimension.py"))
        p["requirements"][0]["text"] = "The plate is 60 mm wide and 40 mm deep."
        verdict = by_item(verify(p))["width"]
        self.assertEqual(verdict["status"], "fail")
        self.assertEqual(
            verdict["detail"],
            "width: spec requires 60 mm but reference has 65 mm; "
            "depth 40 mm matches spec")

    def test_bad_packet_raises(self):
        with self.assertRaises(PacketError):
            VerifierPack().verify({"requirements": "nope"})


class Endpoint(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import main  # verify/service/main.py

        cls.server = HTTPServer(("127.0.0.1", 0), main.Handler)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def post(self, path, body: bytes):
        request = urllib.request.Request(
            self.base + path, data=body, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read())

    def post_packet(self, path, name):
        return self.post(path, json.dumps(packet(reference(name))).encode("utf-8"))

    def test_verify_returns_verdicts(self):
        status, body = self.post_packet("/verify", "plate_ok.py")
        self.assertEqual(status, 200)
        v = by_item(body["verdicts"])
        self.assertEqual(len(body["verdicts"]), 7)
        self.assertTrue(all(v[item]["pass"] for item in STATIC_ITEMS))
        self.assertEqual(v["manifold"]["detail"], "needs cadquery")

    def test_verify_wrong_models(self):
        _, body = self.post_packet("/verify", "plate_wrong_dimension.py")
        self.assertEqual(
            by_item(body["verdicts"])["width"]["detail"],
            "width: spec requires 60 mm but reference has 65 mm")
        _, body = self.post_packet("/verify", "plate_wrong_hole_count.py")
        self.assertEqual(
            by_item(body["verdicts"])["holes"]["detail"],
            "mounting hole count: spec requires 4 but reference has 3")

    def test_verify_rejects_bad_input(self):
        self.assertEqual(self.post("/verify", b"{not json")[0], 400)
        status, body = self.post("/verify", b'{"rubricItems": [{"text": "no id"}]}')
        self.assertEqual(status, 400)
        self.assertIn("id", body["error"])
        self.assertEqual(self.post("/verify", b"[]")[0], 400)

    def test_lint_still_works_and_unknown_path_is_404(self):
        status, body = self.post_packet("/lint", "plate_ok.py")
        self.assertEqual(status, 200)
        self.assertIn("findings", body)
        self.assertEqual(self.post("/nope", b"{}")[0], 404)


if __name__ == "__main__":
    unittest.main()
