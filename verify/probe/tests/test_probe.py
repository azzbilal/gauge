"""Tests for the M9 Probe Gate. No live Ollama needed. Run from the repo root:

    python -m unittest discover -s verify/probe/tests -v
"""
import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

VERIFY_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(VERIFY_DIR))
sys.path.insert(0, str(VERIFY_DIR / "service"))

from probe import OllamaError, PacketError, probe, rollout, tier  # noqa: E402
from probe.probe import build_prompt, extract_code  # noqa: E402

FIXTURES = VERIFY_DIR / "verifiers" / "tests" / "fixtures"
OK = (FIXTURES / "plate_ok.py").read_text(encoding="utf-8")
WRONG = (FIXTURES / "plate_wrong_dimension.py").read_text(encoding="utf-8")
SECRET = "REFERENCE_SOLUTION_MARKER"


def setUpModule():
    # These tests pin the static path: no reference code is executed here. The executed
    # geometry check has its own tests in ExecutedRollouts below.
    global _static_only
    _static_only = mock.patch.dict(os.environ, {"GAUGE_CAD_EXEC": "0"})
    _static_only.start()


def tearDownModule():
    _static_only.stop()


def packet() -> dict:
    """A 60 x 40 x 10 mm plate with four 5 mm holes, plus a kernel-only item."""
    return {
        "prompt": "Model a mounting plate.",
        "spec": "Plate 60 mm wide, 40 mm deep, 10 mm tall with 4 holes of 5 mm diameter.",
        "reference": f"# {SECRET}\n{OK}",
        "requirements": [
            {"id": "R1", "kind": "dimension", "text": "The plate is 60 mm wide."},
            {"id": "R2", "kind": "hole", "text": "The plate has 4 mounting holes."},
            {"id": "R3", "kind": "manifold", "text": "The solid is manifold."},
        ],
        "rubricItems": [
            {"id": "width", "requirementId": "R1", "checkMethod": "machine", "text": "Width"},
            {"id": "holes", "requirementId": "R2", "checkMethod": "machine", "text": "Count"},
            {"id": "manifold", "requirementId": "R3", "checkMethod": "machine", "text": ""},
        ],
    }


def fake_rollouts(*codes):
    """A rollout_fn that returns the given solutions in order and records its calls."""
    queue, calls = list(codes), []

    def fn(prompt, spec, model):
        calls.append((prompt, spec, model))
        return queue.pop(0)

    fn.calls = calls
    return fn


class Tier(unittest.TestCase):
    def test_mock_solve_rates(self):
        for rate, expected in (
            (1.0, "t0"), (0.9, "t0"), (0.81, "t0"),
            (0.8, "t1"), (2 / 3, "t1"), (0.5, "t1"), (0.4, "t1"),
            (0.39, "t2"), (1 / 3, "t2"), (0.1, "t2"), (0.0, "t2"),
        ):
            self.assertEqual(tier(rate, 0), expected, rate)
            self.assertEqual(tier(rate), expected, rate)

    def test_broken_needs_errors_and_nothing_solved(self):
        self.assertEqual(tier(0.0, 1), "broken")
        self.assertEqual(tier(0, 3), "broken")
        self.assertEqual(tier(0.0, 0), "t2")

    def test_errors_with_some_solved_keep_the_rate_tier(self):
        self.assertEqual(tier(1 / 3, 2), "t2")
        self.assertEqual(tier(0.5, 1), "t1")
        self.assertEqual(tier(0.9, 1), "t0")

    def test_out_of_range_inputs_raise(self):
        for rate in (-0.1, 1.1, float("nan")):
            with self.assertRaises(ValueError):
                tier(rate, 0)
        with self.assertRaises(ValueError):
            tier(0.5, -1)


class ExtractCode(unittest.TestCase):
    def test_fenced_block_is_unwrapped(self):
        self.assertEqual(
            extract_code("Here you go:\n```python\nx = 1\ny = 2\n```\nDone."), "x = 1\ny = 2")
        self.assertEqual(extract_code("```\nx = 1\n```"), "x = 1")

    def test_python_block_wins_over_others(self):
        text = "```bash\npip install cadquery\n```\n```py\nx = 1\n```"
        self.assertEqual(extract_code(text), "x = 1")

    def test_plain_reply_is_kept(self):
        self.assertEqual(extract_code("  x = 1\n"), "x = 1")


class Probe(unittest.TestCase):
    def test_all_solved_is_t0(self):
        fn = fake_rollouts(OK, OK, OK)
        result = probe(packet(), "tiny", rollout_fn=fn)
        self.assertEqual(result["tier"], "t0")
        self.assertEqual(result["solve_rate"], 1.0)
        self.assertEqual(result["verifier_errors"], 0)
        self.assertEqual(len(result["rollouts"]), 3)  # default
        self.assertEqual(fn.calls[0][2], "tiny")
        for r in result["rollouts"]:
            self.assertTrue(r["solved"])
            self.assertIsNone(r["error"])
            # the kernel-only item is not part of the score
            self.assertEqual([v["rubric_item_id"] for v in r["verdicts"]], ["width", "holes"])

    def test_mixed_rollouts(self):
        result = probe(packet(), "tiny", rollout_fn=fake_rollouts(OK, WRONG, OK))
        self.assertAlmostEqual(result["solve_rate"], 2 / 3)
        self.assertEqual(result["tier"], "t1")
        self.assertEqual([r["solved"] for r in result["rollouts"]], [True, False, True])
        self.assertEqual(result["rollouts"][1]["code"], WRONG)

        result = probe(packet(), "tiny", rollout_fn=fake_rollouts(WRONG, WRONG, OK))
        self.assertEqual(result["tier"], "t2")

    def test_unparseable_code_is_a_failed_rollout_not_a_verifier_error(self):
        result = probe(packet(), "tiny", n=2, rollout_fn=fake_rollouts("def (:", "nope("))
        self.assertEqual(result["solve_rate"], 0.0)
        self.assertEqual(result["verifier_errors"], 0)
        self.assertEqual(result["tier"], "t2")
        self.assertIn("does not parse", result["rollouts"][0]["verdicts"][0]["detail"])

    def test_not_run_static_check_is_not_solved(self):
        looped = (
            "import cadquery as cq\n"
            "r = cq.Workplane('XY').box(60, 40, 10)\n"
            "for x in (-20, 20):\n"
            "    r = r.faces('>Z').workplane().center(x, 0).hole(5)\n"
        )
        result = probe(packet(), "tiny", n=1, rollout_fn=fake_rollouts(looped))
        self.assertFalse(result["rollouts"][0]["solved"])
        self.assertEqual(result["verifier_errors"], 1)
        self.assertIn("not statically resolvable", result["rollouts"][0]["error"])
        self.assertEqual(result["tier"], "broken")

    def test_unsupported_requirement_is_broken_not_hard(self):
        p = packet()
        p["requirements"].append(
            {"id": "R9", "kind": "dimension", "text": "Fillet radius is 2 mm."})
        p["rubricItems"].append({"id": "fillet", "requirementId": "R9"})
        result = probe(p, "tiny", rollout_fn=fake_rollouts(OK, OK, OK))
        self.assertEqual(result["tier"], "broken")
        self.assertEqual(result["verifier_errors"], 3)
        self.assertIn("fillet radius", result["rollouts"][0]["error"])

    def test_a_failed_check_outranks_a_not_run_one(self):
        p = packet()
        p["requirements"].append(
            {"id": "R9", "kind": "dimension", "text": "Fillet radius is 2 mm."})
        p["rubricItems"].append({"id": "fillet", "requirementId": "R9"})
        result = probe(p, "tiny", n=1, rollout_fn=fake_rollouts(WRONG))
        self.assertIsNone(result["rollouts"][0]["error"])
        self.assertEqual(result["tier"], "t2")

    def test_packet_without_static_checks_is_broken(self):
        p = packet()
        p["rubricItems"] = [p["rubricItems"][2]]  # manifold only
        result = probe(p, "tiny", rollout_fn=fake_rollouts(OK, OK, OK))
        self.assertEqual(result["tier"], "broken")
        self.assertEqual(result["verifier_errors"], 3)
        self.assertIn("no static_cad check", result["rollouts"][0]["error"])

    def test_verifier_crash_is_broken(self):
        with mock.patch("probe.probe.VerifierPack.verify", side_effect=RuntimeError("boom")):
            result = probe(packet(), "tiny", rollout_fn=fake_rollouts(OK, OK, OK))
        self.assertEqual(result["tier"], "broken")
        self.assertIn("boom", result["rollouts"][0]["error"])

    def test_model_never_sees_the_reference(self):
        fn = fake_rollouts(OK)
        probe(packet(), "tiny", n=1, rollout_fn=fn)
        prompt, spec, _ = fn.calls[0]
        text = build_prompt(prompt, spec)
        self.assertIn("mounting plate", text)
        self.assertIn("60 mm wide", text)
        self.assertNotIn(SECRET, text)

    def test_bad_inputs_raise_before_any_rollout(self):
        fn = fake_rollouts(OK)
        with self.assertRaises(PacketError):
            probe({"requirements": "nope"}, "tiny", rollout_fn=fn)
        for n in (0, -1, True, 1.5):
            with self.assertRaises(ValueError):
                probe(packet(), "tiny", n=n, rollout_fn=fn)
        self.assertEqual(fn.calls, [])


class ExecutedRollouts(unittest.TestCase):
    """Rollouts are executed and measured when cadquery is available to the worker."""

    DEAD_CODE = (FIXTURES / "plate_dead_code.py").read_text(encoding="utf-8")

    def setUp(self):
        from verifiers import cad_exec

        available = cad_exec.measure("import cadquery")
        if available.kind == cad_exec.UNAVAILABLE:
            self.skipTest(f"no cadquery in the worker interpreter: {available.detail}")
        patch = mock.patch.dict(os.environ, {"GAUGE_CAD_EXEC": "1"})
        patch.start()
        self.addCleanup(patch.stop)

    def test_dead_code_rollout_is_not_solved(self):
        result = probe(packet(), "tiny", n=2, rollout_fn=fake_rollouts(OK, self.DEAD_CODE))
        good, dead = result["rollouts"]
        self.assertTrue(good["solved"])
        self.assertEqual([v["check"] for v in good["verdicts"]],
                         ["geometry_cad", "static_cad"])
        self.assertFalse(dead["solved"])
        self.assertIsNone(dead["error"])  # a wrong solution, not a verifier error
        self.assertIn("`result` measures 10 mm", dead["verdicts"][0]["detail"])
        self.assertEqual(result["solve_rate"], 0.5)

    def test_dead_code_rollout_that_crashes_is_not_solved(self):
        for ending, reason in (
            ("raise RuntimeError('boom')\n", "reference raised RuntimeError: boom"),
            ("import os\nos._exit(3)\n", "reference crashed the worker (exit code 3)"),
        ):
            with self.subTest(ending=ending):
                code = self.DEAD_CODE + "\n" + ending
                with mock.patch.dict(os.environ, {"GAUGE_CAD_EXEC": "0"}):
                    unexecuted = probe(packet(), "tiny", n=1, rollout_fn=fake_rollouts(code))
                self.assertTrue(unexecuted["rollouts"][0]["solved"])  # the static reading

                result = probe(packet(), "tiny", n=2, rollout_fn=fake_rollouts(OK, code))
                good, dead = result["rollouts"]
                self.assertTrue(good["solved"])
                self.assertFalse(dead["solved"])
                self.assertIsNone(dead["error"])  # a wrong solution, not a verifier error
                for verdict in dead["verdicts"]:
                    self.assertEqual(verdict["status"], "fail", verdict)
                    self.assertEqual(verdict["check"], "geometry_cad")
                    self.assertIn(reason, verdict["detail"])
                    self.assertNotIn("static fallback", verdict["detail"])
                self.assertEqual(result["solve_rate"], 0.5)
                self.assertEqual(result["verifier_errors"], 0)

    def test_static_only_scoring_would_have_solved_it(self):
        with mock.patch.dict(os.environ, {"GAUGE_CAD_EXEC": "0"}):
            result = probe(packet(), "tiny", n=1, rollout_fn=fake_rollouts(self.DEAD_CODE))
        self.assertTrue(result["rollouts"][0]["solved"])


class FakeOllama(BaseHTTPRequestHandler):
    """Stands in for the Ollama /api/generate endpoint."""
    reply = (200, {"response": "```python\nx = 1\n```"})
    seen = []

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        type(self).seen.append((self.path, json.loads(self.rfile.read(length))))
        code, obj = type(self).reply
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def serve(handler):
    server = HTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


class Rollout(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server, base = serve(FakeOllama)
        cls.url = base + "/api/generate"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        FakeOllama.seen = []
        FakeOllama.reply = (200, {"response": "```python\nx = 1\n```"})

    def test_request_shape_and_returned_code(self):
        code = rollout("Model a plate.", "60 mm wide.", "qwen2.5-coder:7b", url=self.url)
        self.assertEqual(code, "x = 1")
        path, body = FakeOllama.seen[0]
        self.assertEqual(path, "/api/generate")
        self.assertEqual(body["model"], "qwen2.5-coder:7b")
        self.assertIs(body["stream"], False)
        self.assertIn("Model a plate.", body["prompt"])
        self.assertIn("60 mm wide.", body["prompt"])

    def test_http_error_raises_ollama_error(self):
        FakeOllama.reply = (404, {"error": "model 'nope' not found"})
        with self.assertRaises(OllamaError) as ctx:
            rollout("p", "s", "nope", url=self.url)
        self.assertIn("404", str(ctx.exception))
        self.assertIn("not found", str(ctx.exception))

    def test_reply_without_completion_raises(self):
        FakeOllama.reply = (200, {"error": "something odd"})
        with self.assertRaises(OllamaError):
            rollout("p", "s", "m", url=self.url)

    def test_unreachable_server_raises(self):
        dead = HTTPServer(("127.0.0.1", 0), FakeOllama)
        port = dead.server_address[1]
        dead.server_close()
        with self.assertRaises(OllamaError):
            rollout("p", "s", "m", url=f"http://127.0.0.1:{port}/api/generate", timeout=5)


class Endpoint(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import main  # verify/service/main.py

        cls.main = main
        cls.server, cls.base = serve(main.Handler)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def post(self, body):
        data = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            self.base + "/probe", data=data, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read())

    def patched(self, *codes, error=None):
        """Replace the Ollama call the service's probe() makes."""
        fn = fake_rollouts(*codes)
        if error:
            fn = mock.Mock(side_effect=error)
        real = self.main.probe

        def wrapped(packet, model, n):
            return real(packet, model, n, rollout_fn=fn)

        wrapped.fn = fn
        return mock.patch.object(self.main, "probe", wrapped), fn

    def test_default_is_three_rollouts(self):
        patch, fn = self.patched(OK, WRONG, OK)
        with patch:
            status, body = self.post({"packet": packet(), "model": "tiny"})
        self.assertEqual(status, 200)
        self.assertEqual(body["tier"], "t1")
        self.assertEqual(len(body["rollouts"]), 3)
        self.assertEqual([r["solved"] for r in body["rollouts"]], [True, False, True])
        self.assertEqual(fn.calls[0][2], "tiny")

    def test_rollouts_can_be_set(self):
        patch, _ = self.patched(OK, OK, OK, OK, OK)
        with patch:
            status, body = self.post({"packet": packet(), "model": "tiny", "rollouts": 5})
        self.assertEqual(status, 200)
        self.assertEqual(body["tier"], "t0")
        self.assertEqual(len(body["rollouts"]), 5)

    def test_bad_requests(self):
        patch, fn = self.patched()
        with patch:
            for body in (
                b"{not json",
                [],
                {"packet": packet()},
                {"packet": packet(), "model": ""},
                {"packet": packet(), "model": 7},
                {"packet": packet(), "model": "tiny", "rollouts": 0},
                {"packet": packet(), "model": "tiny", "rollouts": 21},
                {"packet": packet(), "model": "tiny", "rollouts": "3"},
                {"packet": packet(), "model": "tiny", "rollouts": True},
                {"model": "tiny"},
                {"packet": {"requirements": "nope"}, "model": "tiny"},
            ):
                status, reply = self.post(body)
                self.assertEqual(status, 400, body)
                self.assertIn("error", reply)
        self.assertEqual(fn.calls, [])

    def test_ollama_failure_is_502_not_a_tier(self):
        patch, _ = self.patched(error=OllamaError("ollama request failed: refused"))
        with patch:
            status, body = self.post({"packet": packet(), "model": "tiny"})
        self.assertEqual(status, 502)
        self.assertNotIn("tier", body)
        self.assertIn("ollama", body["error"])


if __name__ == "__main__":
    unittest.main()
