"""Tests for the campaign to cad-spec export (model/export.py). No database, no duckdb, no
model: the export logic runs on fixture rows shaped like the warehouse's raw.task.

    python -m unittest discover -s model/tests -v
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

MODEL_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MODEL_DIR))

import benchmark  # noqa: E402
import cadspec  # noqa: E402
import export  # noqa: E402
import generate  # noqa: E402

GOOD_REF = ('import cadquery as cq\n\nresult = (cq.Workplane("XY").box(60, 40, 10)\n'
            '    .faces(">Z").workplane().rect(40, 20, forConstruction=True).vertices()'
            '.hole(5))\n')
GOOD_PROMPT = "Model a rectangular plate 60 x 40 x 10 mm with 4 holes of 5 mm diameter."

CAMPAIGNS = [{"id": "c1", "name": "Pilot", "spec_label": "v1"},
             {"id": "c2", "name": "Other", "spec_label": "v1"}]


def row(id_, campaign="c1", status="ACCEPTED", prompt=GOOD_PROMPT, spec=None,
        reference=GOOD_REF, is_gold=False, gold_source_id=None):
    return {"id": id_, "campaign_id": campaign, "status": status, "prompt": prompt,
            "spec": spec, "reference": reference, "is_gold": is_gold,
            "gold_source_id": gold_source_id}


def run(rows, **kw):
    with mock.patch.dict(os.environ, {"GAUGE_CAD_EXEC": "0"}):  # static, as test_model
        return export.export(rows, CAMPAIGNS, **kw)


class Export(unittest.TestCase):
    def test_accepted_task_becomes_a_valid_cadspec_task(self):
        batch = run([row("t1")])
        self.assertEqual(batch["count"], 1)
        task = batch["tasks"][0]
        cadspec.check_task(task)
        self.assertEqual((task["id"], task["family"], task["split"], task["spec"]),
                         ("t1", "campaign", "heldout", ""))
        self.assertEqual(task["rubric"], generate.rubric("t1", GOOD_PROMPT, ""))
        self.assertNotIn("params", task)
        self.assertEqual(batch["generator"]["campaigns"],
                         [{"id": "c1", "name": "Pilot", "spec_label": "v1",
                           "accepted": 1, "exported": 1}])

    def test_only_accepted_non_gold_tasks(self):
        rows = [row("t1"), row("draft", status="IN_REVIEW"), row("rej", status="REJECTED"),
                row("gold", is_gold=True), row("clone", is_gold=True, gold_source_id="gold")]
        batch = run(rows)
        self.assertEqual([t["id"] for t in batch["tasks"]], ["t1"])
        self.assertEqual(batch["generator"]["gold_excluded"], 2)
        self.assertNotIn("gold", json.dumps(batch["generator"]["skipped"]))

    def test_missing_reference_is_skipped_and_listed(self):
        batch = run([row("t1", reference=None), row("t2", reference="  ")])
        self.assertEqual(batch["count"], 0)
        self.assertEqual([(s["id"], s["reason"]) for s in batch["generator"]["skipped"]],
                         [("t1", "no reference"), ("t2", "no reference")])

    def test_wrong_reference_is_skipped_with_the_failed_check(self):
        wrong = GOOD_REF.replace("box(60,", "box(65,")
        batch = run([row("t1", reference=wrong)])
        self.assertEqual(batch["count"], 0)
        reason = batch["generator"]["skipped"][0]["reason"]
        self.assertIn("fails its own rubric", reason)
        self.assertIn("65", reason)

    def test_manual_only_wording_is_skipped_as_unjudged(self):
        batch = run([row("t1", prompt="Model a nice bracket for a shelf.")])
        self.assertEqual(batch["count"], 0)
        self.assertIn("unjudged", batch["generator"]["skipped"][0]["reason"])

    def test_campaign_filter_by_name_or_id(self):
        rows = [row("t1"), row("t2", campaign="c2")]
        self.assertEqual([t["id"] for t in run(rows, only=["Other"])["tasks"]], ["t2"])
        self.assertEqual([t["id"] for t in run(rows, only=["c1"])["tasks"]], ["t1"])
        with self.assertRaises(cadspec.SpecError):
            run(rows, only=["nope"])

    def test_split_flag_and_order_kept(self):
        batch = run([row("b"), row("a")], split="train")
        self.assertEqual([(t["id"], t["split"]) for t in batch["tasks"]],
                         [("b", "train"), ("a", "train")])
        with self.assertRaises(cadspec.SpecError):
            run([row("a")], split="test")

    def test_benchmark_reads_the_export_and_oracle_solves_it(self):
        batch = run([row("t1"), row("t2", spec="60 mm wide, 40 mm deep, 10 mm tall")])
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "export.json"
            generate.write(batch, path)
            first = path.read_bytes()
            generate.write(run([row("t1"), row("t2", spec="60 mm wide, 40 mm deep, "
                                                       "10 mm tall")]), path)
            self.assertEqual(path.read_bytes(), first)  # deterministic
            _, tasks = benchmark.load_tasks(path)
        with mock.patch.dict(os.environ, {"GAUGE_CAD_EXEC": "0"}):
            report = benchmark.run(tasks, "mock:oracle", benchmark.oracle)
        self.assertEqual(report["by_family"]["campaign"]["solved"], 2)
        self.assertEqual(report["by_family"]["campaign"]["attempted"], 2)

    def test_read_warehouse_without_duckdb_says_how_to_install(self):
        with mock.patch.dict(sys.modules, {"duckdb": None}):
            with self.assertRaisesRegex(RuntimeError, "duckdb"):
                export.read_warehouse(Path("nowhere.duckdb"))


if __name__ == "__main__":
    unittest.main()
