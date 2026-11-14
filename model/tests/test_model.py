"""Tests for the cad-spec release, the synthetic generator and the benchmark harness.
No live Ollama needed. Run from the repo root:

    python -m unittest discover -s model/tests -v

The tests that execute CadQuery skip when the worker interpreter has no cadquery
(set GAUGE_CAD_PYTHON); everything else pins the static path (GAUGE_CAD_EXEC=0).
"""
import contextlib
import io
import json
import os
import sys
import tempfile
import threading
import unittest
from collections import Counter
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

MODEL_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MODEL_DIR))

import benchmark  # noqa: E402
import cadspec  # noqa: E402
import generate  # noqa: E402
from probe.probe import OllamaError  # noqa: E402  (verify/ is on sys.path via cadspec)
from verifiers import cad_exec  # noqa: E402

_PROBE = cad_exec.measure("import cadquery\n")
CADQUERY = _PROBE.cadquery if _PROBE.kind != cad_exec.UNAVAILABLE else None
needs_cadquery = unittest.skipUnless(
    CADQUERY, f"no cadquery in the worker interpreter: {_PROBE.detail}")

BATCH = generate.generate(50, seed=11)
HELDOUT = [t for t in BATCH["tasks"] if t["split"] == "heldout"]
SINGLE_BOX = [t for t in HELDOUT if t["family"] != "bracket"]  # statically readable size


@contextlib.contextmanager
def static_only():
    with mock.patch.dict(os.environ, {"GAUGE_CAD_EXEC": "0"}):
        yield


class Spec(unittest.TestCase):
    def test_version_is_read_from_spec_md(self):
        version = cadspec.spec_version()
        self.assertRegex(version, r"^cad-spec-\d+\.\d+$")
        self.assertIn(f"spec-version: {version}", cadspec.SPEC_PATH.read_text(encoding="utf-8"))

    def test_version_line_must_appear_exactly_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            for body in ("# no version\n", "spec-version: cad-spec-1.0\nspec-version: cad-spec-2.0\n"):
                path = Path(tmp) / "SPEC.md"
                path.write_text(body, encoding="utf-8")
                cadspec.spec_version.cache_clear()
                with self.assertRaises(cadspec.SpecError):
                    cadspec.spec_version(path)
        cadspec.spec_version.cache_clear()

    def test_check_task_refuses_another_version(self):
        task = dict(BATCH["tasks"][0], spec_version="cad-spec-0.9")
        with self.assertRaises(cadspec.SpecError):
            cadspec.check_task(task)

    def test_task_is_a_packet_the_verifier_reads(self):
        from lint.packet import TaskPacket
        packet = TaskPacket.from_dict(cadspec.to_packet(BATCH["tasks"][0]))
        machine = [i for i in packet.rubric_items if i.check_method == "machine"]
        self.assertTrue(machine)
        self.assertTrue(all(i.requirement_id for i in machine))


class Generator(unittest.TestCase):
    def test_same_seed_same_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            a, b = Path(tmp) / "a.json", Path(tmp) / "b.json"
            generate.write(generate.generate(30, seed=5), a)
            generate.write(generate.generate(30, seed=5), b)
            self.assertEqual(a.read_bytes(), b.read_bytes())

    def test_different_seed_different_tasks(self):
        a = [t["params"] for t in generate.generate(20, seed=1)["tasks"]]
        b = [t["params"] for t in generate.generate(20, seed=2)["tasks"]]
        self.assertNotEqual(a, b)

    def test_every_task_is_valid_and_stamped(self):
        version = cadspec.spec_version()
        self.assertEqual(BATCH["spec_version"], version)
        for task in BATCH["tasks"]:
            cadspec.check_task(task, version)
            generate.self_check(task)
            self.assertIn("result", task["reference"])
        self.assertEqual(len({t["id"] for t in BATCH["tasks"]}), len(BATCH["tasks"]))

    def test_families_and_hole_counts_vary(self):
        self.assertEqual({t["family"] for t in BATCH["tasks"]}, set(generate.FAMILIES))
        counts = {t["params"]["holes"] for t in BATCH["tasks"]}
        self.assertGreaterEqual(len(counts), 4, counts)
        widths = {t["params"]["width"] for t in BATCH["tasks"]}
        self.assertGreaterEqual(len(widths), 15)

    def test_split_is_stratified_and_disjoint(self):
        per_family = Counter(t["family"] for t in BATCH["tasks"])
        held = Counter(t["family"] for t in HELDOUT)
        for family, n in per_family.items():
            self.assertEqual(held[family], round(n * generate.HELDOUT_FRACTION), family)
        keys = [(t["family"], json.dumps(t["params"], sort_keys=True)) for t in BATCH["tasks"]]
        self.assertEqual(len(set(keys)), len(keys))

    def test_self_check_catches_a_mismatch(self):
        task = json.loads(json.dumps(BATCH["tasks"][0]))
        task["params"]["width"] += 1
        with self.assertRaises(cadspec.SpecError):
            generate.self_check(task)

    def test_hole_count_is_machine_checked_when_there_are_holes(self):
        for task in BATCH["tasks"]:
            labels = {r["label"] for r in task["rubric"]["requirements"]
                      if r["check_method"] == "machine"}
            self.assertEqual("hole count" in labels, bool(task["params"]["holes"]), task["id"])

    def test_cli_writes_the_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "batch.json"
            with contextlib.redirect_stdout(io.StringIO()):
                code = generate.main(["--count", "10", "--seed", "3", "--out", str(out)])
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(out.read_text(encoding="utf-8"))["count"], 10)


class BenchmarkStatic(unittest.TestCase):
    """Scoring with GAUGE_CAD_EXEC=0: box sizes are read from the code, never executed."""

    def test_oracle_solves_every_single_box_task(self):
        with static_only():
            report = benchmark.run(SINGLE_BOX, "none", benchmark.oracle)
        self.assertEqual(report["solve_rate"], 1.0, benchmark.render(dict(
            report, spec_version="", data="", split="", candidate="")))
        self.assertEqual(report["scoring"], "static")

    def test_wrong_width_fails_every_task(self):
        with static_only():
            report = benchmark.run(SINGLE_BOX, "none", benchmark.wrong)
        self.assertEqual(report["solve_rate"], 0.0)
        self.assertEqual(report["totals"]["failed"], len(SINGLE_BOX))

    def test_ollama_failure_is_not_run_and_left_out_of_the_rate(self):
        def down(prompt, spec, model):
            raise OllamaError("ollama request failed: connection refused")
        calls = iter([down, benchmark.oracle(SINGLE_BOX[1])])
        with static_only():
            report = benchmark.run(SINGLE_BOX[:2], "none", lambda task: next(calls))
        self.assertEqual(report["totals"]["not_run"], 1)
        self.assertEqual(report["attempted"], 1)
        self.assertEqual(report["solve_rate"], 1.0)

    def test_code_the_reader_cannot_follow_is_unjudged_not_failed(self):
        task = next(t for t in SINGLE_BOX if t["params"]["holes"] > 1)
        p = task["params"]
        looped = (
            "import cadquery as cq\n"
            f"result = cq.Workplane('XY').box({p['width']}, {p['depth']}, {p['height']})\n"
            f"for i in range({p['holes']}):\n"
            f"    result = result.faces('>Z').workplane().center(i, 0).hole({p['hole_d']})\n")
        with static_only():
            report = benchmark.run([task], "none", lambda t: lambda *a: looped)
        self.assertEqual(report["totals"]["unjudged"], 1)
        self.assertEqual(report["solve_rate"], 0.0)
        self.assertEqual(report["unjudged_rate"], 1.0)

    def test_the_model_never_sees_the_reference(self):
        seen = []

        def spy(prompt, spec, model):
            seen.append(prompt + spec)
            return "result = None\n"
        with static_only():
            benchmark.run(SINGLE_BOX[:3], "none", lambda task: spy)
        for text, task in zip(seen, SINGLE_BOX[:3]):
            self.assertNotIn("cadquery", text)
            self.assertNotIn(task["reference"], text)

    def test_version_mismatch_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "old.json"
            path.write_text(json.dumps(dict(BATCH, spec_version="cad-spec-0.1")),
                            encoding="utf-8")
            with self.assertRaises(cadspec.SpecError):
                benchmark.load_tasks(path)
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(benchmark.main(["--data", str(path), "--mock", "oracle"]), 2)

    def test_cli_with_a_mock_writes_a_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            data, out = Path(tmp) / "batch.json", Path(tmp) / "report.json"
            batch = dict(BATCH, tasks=SINGLE_BOX[:3] + [
                t for t in BATCH["tasks"] if t["split"] == "train"][:2])
            generate.write(batch, data)
            with static_only(), contextlib.redirect_stdout(io.StringIO()), \
                    contextlib.redirect_stderr(io.StringIO()):
                code = benchmark.main(["--data", str(data), "--mock", "oracle",
                                       "--out", str(out)])
            self.assertEqual(code, 0)
            report = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(report["tasks"], 3)
            self.assertEqual(report["spec_version"], cadspec.spec_version())
            self.assertEqual(report["candidate"], "mock:oracle")


TRAIN = [t for t in BATCH["tasks"] if t["split"] == "train"]


class FewShot(unittest.TestCase):
    def test_no_examples_is_the_zero_shot_prompt_byte_for_byte(self):
        # The committed 0/20 baseline used build_prompt; --fewshot 0 must not change it.
        from probe.probe import build_prompt
        for task in HELDOUT:
            self.assertEqual(benchmark.fewshot_prompt(task["prompt"], task["spec"]),
                             build_prompt(task["prompt"], task["spec"]))

    def test_selection_is_one_per_family_in_file_order(self):
        picked = benchmark.select_examples(TRAIN, 5)
        self.assertEqual([t["family"] for t in picked], list(generate.FAMILIES))
        for t in picked:
            self.assertEqual(t, next(x for x in TRAIN if x["family"] == t["family"]))
        self.assertEqual(benchmark.select_examples(TRAIN, 5), picked)  # deterministic
        self.assertEqual(len(benchmark.select_examples(TRAIN, 7)), 7)
        self.assertEqual(benchmark.select_examples(TRAIN, 0), [])

    def test_held_out_tasks_are_never_examples(self):
        with self.assertRaises(cadspec.SpecError):
            benchmark.select_examples(TRAIN + HELDOUT[:1], 5)
        evaluated = {t["id"] for t in TRAIN[:10]}
        picked = benchmark.select_examples(TRAIN, 5, exclude_ids=evaluated)
        self.assertFalse(evaluated & {t["id"] for t in picked})
        with self.assertRaises(cadspec.SpecError):
            benchmark.select_examples(TRAIN, 5, exclude_ids={t["id"] for t in TRAIN})

    def test_examples_come_before_the_task_and_hide_its_reference(self):
        examples = benchmark.select_examples(TRAIN, 5)
        task = HELDOUT[0]
        text = benchmark.fewshot_prompt(task["prompt"], task["spec"], examples)
        for ex in examples:
            self.assertIn(ex["reference"].strip(), text)
            self.assertLess(text.index(ex["spec"].strip()), text.index(task["spec"].strip()))
        self.assertNotIn(task["reference"].strip(), text)
        self.assertTrue(text.endswith(task["spec"].strip()))

    def test_cli_refuses_fewshot_with_a_mock(self):
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(benchmark.main(["--mock", "oracle", "--fewshot", "3"]), 2)


class _Stub(BaseHTTPRequestHandler):
    reply = {}
    bodies = []

    def do_POST(self):
        _Stub.bodies.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
        data = json.dumps(_Stub.reply).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


class OllamaCandidateStub(unittest.TestCase):
    """OllamaCandidate against a stub Ollama server: no live model."""

    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), _Stub)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}/api/generate"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        _Stub.bodies = []

    def test_request_turns_thinking_off_and_sets_the_options(self):
        _Stub.reply = {"response": "```python\nresult = 1\n```", "done_reason": "stop"}
        candidate = benchmark.OllamaCandidate(url=self.url, num_ctx=8192, num_predict=512)
        code = candidate("Model a plate.", "Plate: 60 mm wide.", "m")
        self.assertEqual(code, "result = 1")
        self.assertEqual(code.meta["done_reason"], "stop")
        body = _Stub.bodies[0]
        self.assertIs(body["think"], False)
        self.assertEqual(body["options"],
                         {"temperature": 0.0, "num_ctx": 8192, "num_predict": 512})
        self.assertNotIn("cadquery as cq", body["prompt"])
        self.assertNotIn("fewshot", candidate.settings)

    def test_fewshot_candidate_sends_the_examples_and_records_them(self):
        _Stub.reply = {"response": "```python\nresult = 1\n```", "done_reason": "stop"}
        examples = benchmark.select_examples(TRAIN, 2)
        candidate = benchmark.OllamaCandidate(url=self.url, examples=examples)
        candidate("Model a plate.", "Plate: 60 mm wide.", "m")
        body = _Stub.bodies[0]
        self.assertIn(examples[0]["reference"].strip(), body["prompt"])
        self.assertIs(body["think"], False)
        self.assertEqual(candidate.settings["fewshot"],
                         {"k": 2, "example_ids": [e["id"] for e in examples]})

    def test_empty_reply_is_failed_and_labelled_no_code(self):
        _Stub.reply = {"response": "", "done_reason": "length"}
        candidate = benchmark.OllamaCandidate(url=self.url)
        with static_only():
            report = benchmark.run(SINGLE_BOX[:1], "m", lambda task: candidate)
        self.assertEqual(report["totals"]["failed"], 1)
        self.assertEqual(report["totals"]["no_code"], 1)
        attempt = report["per_task"][0]["attempts"][0]
        self.assertIn("no code", attempt["error"])
        self.assertIn("length", attempt["error"])

    def test_answer_cut_off_at_num_predict_is_counted(self):
        _Stub.reply = {"response": "import cadquery as cq\nresult = cq.Workplane('XY').box(",
                       "done_reason": "length"}
        candidate = benchmark.OllamaCandidate(url=self.url)
        with static_only():
            report = benchmark.run(SINGLE_BOX[:1], "m", lambda task: candidate)
        self.assertEqual(report["totals"]["truncated"], 1)
        self.assertEqual(report["totals"]["no_code"], 0)
        self.assertEqual(report["totals"]["failed"], 1)

    def test_reply_without_a_completion_is_not_run(self):
        _Stub.reply = {"error": "model 'x' not found"}
        candidate = benchmark.OllamaCandidate(url=self.url)
        with static_only():
            report = benchmark.run(SINGLE_BOX[:1], "x", lambda task: candidate)
        self.assertEqual(report["totals"]["not_run"], 1)
        self.assertIsNone(report["solve_rate"])


@needs_cadquery
class BenchmarkExecuted(unittest.TestCase):
    """The reference oracle on every held-out task, measured on the executed solid."""

    def test_oracle_scores_100_percent(self):
        report = benchmark.run(HELDOUT, "none", benchmark.oracle)
        self.assertEqual(report["scoring"], "executed")
        self.assertEqual(report["totals"]["solved"], len(HELDOUT), report["totals"])

    def test_wrong_width_scores_0_percent(self):
        report = benchmark.run(HELDOUT, "none", benchmark.wrong)
        self.assertEqual(report["totals"]["failed"], len(HELDOUT), report["totals"])


if __name__ == "__main__":
    unittest.main()
