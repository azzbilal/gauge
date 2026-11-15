"""Campaign to cad-spec export: accepted expert tasks into the model loop.

    python warehouse/load.py                       # copy Postgres into the warehouse first
    python model/export.py                         # every accepted task, held out
    python model/export.py --campaign "CAD pilot" --out model/data/pilot.json
    python model/benchmark.py --data model/data/pilot.json --mock oracle   # must be 100 %

Reads the ACCEPTED tasks (prompt, spec, reference) of the application database and writes
them as a cad-spec batch (model/SPEC.md) that model/benchmark.py reads. It reads the
warehouse copy (`raw.task`, `raw.campaign` in warehouse/gauge.duckdb, written by
warehouse/load.py), not Postgres itself: everything downstream of the app reads copies.

Which tasks go in:
- status ACCEPTED, and not gold. A gold task (or a reviewer's gold clone) has a known
  answer and may be deliberately broken, so it is never training or evaluation data. Gold
  tasks are counted, not listed.
- a reference. A task with no reference is skipped and listed. A missing spec is read as
  "" (the API's packet builder does the same).
- a reference that scores solved against its own rubric (SPEC.md rule 6). Reviewers
  accepting a task does not make it machine-scorable: free wording can leave only manual
  requirements, or the accepted reference can be wrong. Such a task would count as a model
  failure every time, so it is skipped and listed with the reason.

Each task gets the database id as `id`, family `campaign`, the split from --split (default
heldout: benchmark tasks are drawn only from heldout) and the rubric from
verify/lint/extract.py on its text, as the generator builds it. Provenance (source, the
warehouse load time, campaigns, skipped tasks) is in the batch's `generator` block. Tasks
are ordered by creation time and id, keys are sorted, there are no wall-clock timestamps:
the same warehouse load and scoring mode give a byte-identical file.

Campaign tasks are benchmarked, not used as few-shot examples: --fewshot draws examples
only from the five synthetic families.

The export logic is standard library. Reading the warehouse needs `duckdb`, from
warehouse/requirements.txt. Executed scoring needs GAUGE_CAD_PYTHON, as for
generate.py --check; without it box sizes are read statically, and the batch records which.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cadspec import (MODEL_DIR, REPO_DIR, SpecError, check_task, spec_version,  # noqa: E402
                     to_packet, use_verify)

use_verify()
from lint.extract import VERSION as EXTRACT_VERSION  # noqa: E402
from lint.packet import TaskPacket  # noqa: E402
from probe.probe import score  # noqa: E402

import generate  # noqa: E402  (rubric(), write(), _shown())

EXPORTER = "gauge-campaign-export-1"
FAMILY = "campaign"
ACCEPTED = "ACCEPTED"
DEFAULT_WAREHOUSE = REPO_DIR / "warehouse" / "gauge.duckdb"
DEFAULT_OUT = MODEL_DIR / "data" / "campaign-accepted.json"

TASK_SQL = """
    SELECT id, "campaignId" AS campaign_id, prompt, spec, reference, status,
           "isGold" AS is_gold, "goldSourceId" AS gold_source_id
    FROM raw.task
    WHERE status = 'ACCEPTED'
    ORDER BY "createdAt", id
"""
CAMPAIGN_SQL = 'SELECT id, name, "specVersion" AS spec_label FROM raw.campaign ORDER BY id'


# ----------------------------------------------------------------------------- read

def read_warehouse(path: Path) -> dict:
    """{"tasks": accepted task rows, "campaigns": campaign rows, "loaded_at": str or None}.

    Read-only. Raises RuntimeError when duckdb is missing or the warehouse has no raw copy."""
    try:
        import duckdb
    except ImportError:
        raise RuntimeError("reading the warehouse needs duckdb: pip install -r "
                           "warehouse/requirements.txt (or uv run --with duckdb)")
    if not Path(path).exists():
        raise RuntimeError(f"no warehouse at {path}: run python warehouse/load.py first")
    con = duckdb.connect(str(path), read_only=True)
    try:
        def rows(sql):
            cur = con.execute(sql)
            names = [d[0] for d in cur.description]
            return [dict(zip(names, r)) for r in cur.fetchall()]
        try:
            tasks, campaigns = rows(TASK_SQL), rows(CAMPAIGN_SQL)
        except duckdb.Error as err:
            raise RuntimeError(f"{path} has no raw.task / raw.campaign copy "
                               f"(run python warehouse/load.py): {err}") from None
        try:
            # As a UTC string in SQL: the file does not depend on the machine's time zone,
            # and duckdb needs no pytz to hand back a TIMESTAMPTZ.
            loaded = con.execute(
                "SELECT strftime(max(loaded_at) AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%SZ') "
                "FROM raw._load_log").fetchone()[0]
        except duckdb.Error:
            loaded = None
    finally:
        con.close()
    return {"tasks": tasks, "campaigns": campaigns, "loaded_at": loaded}


# ----------------------------------------------------------------------------- export

def campaign_task(row: dict, split: str, version: str = None) -> dict:
    """The cad-spec task for one accepted task row (id, prompt, spec, reference)."""
    spec = row.get("spec") or ""
    task = {
        "id": row["id"],
        "spec_version": version or spec_version(),
        "family": FAMILY,
        "split": split,
        "prompt": row["prompt"],
        "spec": spec,
        "reference": row["reference"],
        "rubric": generate.rubric(row["id"], row["prompt"], spec),
    }
    check_task(task, task["spec_version"])
    return task


def _why_not_solved(result: dict) -> str:
    if result["error"]:
        return f"reference unjudged against its own rubric: {result['error']}"
    failed = [v["detail"] for v in result["verdicts"] if v["status"] != "pass"]
    return "reference fails its own rubric: " + "; ".join(failed)


def export(rows: list, campaigns: list, split: str = "heldout", only=None,
           scorer=score) -> dict:
    """A cad-spec batch of the accepted, non-gold tasks in `rows` whose references are solved.

    `rows` are task rows in output order; `campaigns` are {id, name, spec_label} rows.
    `only` (ids or names) limits the export to those campaigns. `scorer(packet, code)` is
    probe.score; tests pass a stub."""
    if split not in ("train", "heldout"):
        raise SpecError(f"split must be train or heldout, not {split!r}")
    version = spec_version()
    by_id = {c["id"]: c for c in campaigns}
    if only:
        wanted = set(only)
        chosen = {c["id"] for c in campaigns if c["id"] in wanted or c["name"] in wanted}
        unknown = wanted - {c["id"] for c in campaigns} - {c["name"] for c in campaigns}
        if unknown:
            raise SpecError(f"no campaign named {', '.join(sorted(unknown))}")
    else:
        chosen = set(by_id) | {r["campaign_id"] for r in rows}

    tasks, skipped, modes = [], [], set()
    gold = 0
    counts = {}
    for row in rows:
        if row.get("status") != ACCEPTED or row["campaign_id"] not in chosen:
            continue
        if row.get("is_gold") or row.get("gold_source_id"):
            gold += 1
            continue
        # Non-gold accepted tasks, as the warehouse's mart_campaign counts them.
        tally = counts.setdefault(row["campaign_id"], {"accepted": 0, "exported": 0})
        tally["accepted"] += 1
        reason = None
        if not (row.get("prompt") or "").strip():
            reason = "no prompt"
        elif not (row.get("reference") or "").strip():
            reason = "no reference"
        if reason is None:
            task = campaign_task(row, split, version)
            result = scorer(TaskPacket.from_dict(to_packet(task)), task["reference"])
            modes.update(v["check"] for v in result["verdicts"])
            if not result["solved"]:
                reason = _why_not_solved(result)
        if reason:
            skipped.append({"id": row["id"], "campaign_id": row["campaign_id"],
                            "reason": reason})
            continue
        tally["exported"] += 1
        tasks.append(task)

    campaign_rows = [
        {"id": cid, "name": by_id.get(cid, {}).get("name"),
         "spec_label": by_id.get(cid, {}).get("spec_label"), **counts[cid]}
        for cid in sorted(counts)]
    if not modes:
        scoring = None
    elif "geometry_cad" in modes:
        scoring = "executed"
    else:
        scoring = "static (no cadquery: box sizes read from code)"
    return {
        "spec_version": version,
        "generator": {"name": EXPORTER, "split": split, "extract_version": EXTRACT_VERSION,
                      "scoring": scoring, "campaigns": campaign_rows,
                      "gold_excluded": gold, "skipped": skipped},
        "count": len(tasks),
        "tasks": tasks,
    }


# ----------------------------------------------------------------------------- main

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--warehouse", type=Path, default=DEFAULT_WAREHOUSE,
                    help="DuckDB warehouse written by warehouse/load.py "
                         "(default warehouse/gauge.duckdb)")
    ap.add_argument("--campaign", action="append", default=[], metavar="ID_OR_NAME",
                    help="export only this campaign; repeatable (default: every campaign)")
    ap.add_argument("--split", default="heldout", choices=("heldout", "train"),
                    help="split given to every exported task (default heldout)")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT,
                    help="output file (default model/data/campaign-accepted.json)")
    args = ap.parse_args(argv)
    try:
        source = read_warehouse(args.warehouse)
        batch = export(source["tasks"], source["campaigns"], args.split, args.campaign)
    except (RuntimeError, SpecError, KeyError) as err:
        print(f"error: {err}", file=sys.stderr)
        return 2
    batch["generator"]["source"] = generate._shown(args.warehouse)
    batch["generator"]["loaded_at"] = source["loaded_at"]
    generate.write(batch, args.out)

    meta = batch["generator"]
    print(f"read {len(source['tasks'])} accepted tasks from {meta['source']} "
          f"(warehouse load {meta['loaded_at'] or 'unknown'})")
    for c in meta["campaigns"]:
        print(f"  {c['name'] or c['id']:<28} accepted {c['accepted']:>3}  exported {c['exported']:>3}")
    if meta["gold_excluded"]:
        print(f"  gold tasks left out: {meta['gold_excluded']}")
    for s in meta["skipped"]:
        print(f"  SKIPPED {s['id']}: {s['reason']}")
    print(f"wrote {batch['count']} {batch['spec_version']} tasks (split {args.split}, "
          f"scoring {meta['scoring'] or 'none'}) to {args.out}")
    if not batch["count"]:
        print("warning: nothing to benchmark; no accepted task passed", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
