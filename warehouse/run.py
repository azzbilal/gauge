"""One command: load Postgres -> DuckDB, then dbt build, then dbt test.

Stops at the first failing step. Uses the interpreter it runs under for every step,
so dbt must be installed there (pip install -r warehouse/requirements.txt).

    python warehouse/run.py                       # load + build + test
    python warehouse/run.py --report docs/results/gate3-warehouse-slice-<date>.txt
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import re
import subprocess
import sys
from pathlib import Path

import duckdb

HERE = Path(__file__).resolve().parent
DBT_DIR = HERE / "dbt"
DB_PATH = Path(os.environ.get("GAUGE_DUCKDB_PATH", HERE / "gauge.duckdb")).resolve()


def step(name: str, cmd: list[str], env: dict[str, str]) -> str:
    print(f"\n=== {name} ===", flush=True)
    proc = subprocess.run(cmd, env=env, cwd=HERE, capture_output=True, text=True,
                          encoding="utf-8", errors="replace")
    sys.stdout.write(proc.stdout)
    sys.stderr.write(proc.stderr)
    if proc.returncode != 0:
        sys.exit(f"run: step '{name}' failed (exit {proc.returncode})")
    return proc.stdout


def dbt(*args: str) -> list[str]:
    # Same as the `dbt` console script, but tied to this interpreter (Scripts/ may not be on PATH).
    launcher = "import sys; from dbt.cli.main import cli; sys.argv[0] = 'dbt'; cli()"
    return [sys.executable, "-c", launcher, *args,
            "--project-dir", str(DBT_DIR), "--profiles-dir", str(DBT_DIR)]


def summary(out: str) -> str:
    """dbt's final 'Done. PASS=.. WARN=.. ERROR=.. SKIP=.. TOTAL=..' line."""
    m = re.findall(r"Done\. PASS=\d+.*", out)
    return m[-1].strip() if m else "(no summary line)"


def write_report(path: Path, load_out: str, build_out: str, test_out: str,
                 notes: list[str]) -> None:
    con = duckdb.connect(str(DB_PATH), read_only=True)
    try:
        cols = [
            "campaign_name", "task_count", "gold_task_count", "accepted_count", "rejected_count",
            "accept_rate", "active_days", "tasks_per_day", "multi_reviewed_count",
            "agreed_count", "reviewer_agreement",
        ]
        rows = con.execute(
            f"select {', '.join(cols)} from main_marts.mart_campaign order by task_count desc, campaign_name"
        ).fetchall()
        loaded_at = con.execute("select loaded_at from raw._load_log").fetchone()[0]
    finally:
        con.close()

    fmt = lambda v: "null" if v is None else str(v)  # noqa: E731
    table = [cols] + [[fmt(v) for v in r] for r in rows]
    widths = [max(len(r[i]) for r in table) for i in range(len(cols))]
    lines = ["  " + "  ".join(c.ljust(w) if i == 0 else c.rjust(w)
                              for i, (c, w) in enumerate(zip(r, widths))) for r in table]

    load_lines = [l.replace("load: ", "  ") for l in load_out.splitlines() if "rows" in l]
    text = "\n".join([
        "Gate 3: warehouse vertical slice (Postgres -> DuckDB -> dbt)",
        f"Run {dt.datetime.now().astimezone().isoformat(timespec='seconds')}; "
        f"raw loaded at {loaded_at}",
        *[f"Note: {n}" for n in notes],
        "",
        "Raw tables loaded",
        *load_lines,
        "",
        f"dbt build: {summary(build_out)}",
        f"dbt test:  {summary(test_out)}",
        "",
        "mart_campaign (gold tasks excluded from metrics; see warehouse/dbt/models/marts/marts.yml)",
        *lines,
        "",
        "Definitions",
        "  accept_rate        = accepted / (accepted + rejected); null when nothing is decided",
        "  tasks_per_day      = task_count / calendar days from first to last task (inclusive)",
        "  reviewer_agreement = share of tasks with >=2 identified reviews whose accept/reject",
        "                       verdicts all match; null when no task has two reviews",
        "",
    ])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    print(f"\nrun: wrote {path}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--report", type=Path, help="write a short mart_campaign sample here")
    ap.add_argument("--note", action="append", default=[],
                    help="context line for the report (repeatable), e.g. where the data came from")
    args = ap.parse_args()

    env = {**os.environ, "GAUGE_DUCKDB_PATH": str(DB_PATH), "PYTHONIOENCODING": "utf-8"}
    load_out = step("load", [sys.executable, str(HERE / "load.py"), "--db", str(DB_PATH)], env)
    build_out = step("dbt build", dbt("build"), env)
    test_out = step("dbt test", dbt("test"), env)
    print(f"\nrun: ok  build [{summary(build_out)}]  test [{summary(test_out)}]")
    if args.report:
        write_report(args.report.resolve(), load_out, build_out, test_out, args.note)


if __name__ == "__main__":
    main()
