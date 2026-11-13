"""Dagster wiring for the Gauge warehouse: raw_tables -> dbt_models -> dbt_tests, daily.

Each asset shells out to the same commands as warehouse/run.py, under the interpreter
Dagster runs in, so dbt and duckdb must be installed there (warehouse/requirements.txt).
Steps run strictly in order and in one process: DuckDB allows a single writer.

    # from the repo root, with DAGSTER_HOME pointing at an absolute directory
    python -m dagster job execute -m gauge_pipeline -d warehouse/dagster -j gauge_warehouse_job
    python -m dagster dev -m gauge_pipeline -d warehouse/dagster      # UI + schedule toggle
"""
# No `from __future__ import annotations`: Dagster inspects the real `context` annotation.
import importlib.util
import os
import re
import subprocess
import sys
from pathlib import Path

import dagster as dg

WAREHOUSE = Path(__file__).resolve().parents[2]
# Absolute, so dbt never falls back to its relative default and writes a second database.
DB_PATH = Path(os.environ.get("GAUGE_DUCKDB_PATH", WAREHOUSE / "gauge.duckdb")).resolve()


def _load_run_module():
    """warehouse/run.py, loaded by path: reuse its dbt launcher and summary parser."""
    spec = importlib.util.spec_from_file_location("gauge_warehouse_run", WAREHOUSE / "run.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_run = _load_run_module()


def _tail(text: str, lines: int = 40) -> str:
    return "\n".join(text.strip().splitlines()[-lines:])


def _step(context: dg.AssetExecutionContext, name: str, cmd: list[str]) -> str:
    """Run one step; raise (so the run fails and later assets are skipped) on non-zero exit."""
    env = {**os.environ, "GAUGE_DUCKDB_PATH": str(DB_PATH), "PYTHONIOENCODING": "utf-8"}
    proc = subprocess.run(cmd, cwd=WAREHOUSE, env=env, capture_output=True, text=True,
                          encoding="utf-8", errors="replace")
    context.log.info(f"{name}:\n{_tail(proc.stdout)}")
    if proc.returncode != 0:
        raise dg.Failure(
            description=f"{name} failed (exit {proc.returncode})",
            metadata={
                "stdout_tail": dg.MetadataValue.text(_tail(proc.stdout)),
                "stderr_tail": dg.MetadataValue.text(_tail(proc.stderr)),
            },
        )
    return proc.stdout


@dg.asset(group_name="warehouse", description="Postgres app tables copied into DuckDB schema raw (load.py).")
def raw_tables(context: dg.AssetExecutionContext) -> dg.MaterializeResult:
    out = _step(context, "load", [sys.executable, str(WAREHOUSE / "load.py"), "--db", str(DB_PATH)])
    counts = {m.group(1): int(m.group(2)) for m in re.finditer(r"raw\.(\w+)\s+(\d+) rows", out)}
    return dg.MaterializeResult(metadata={"db_path": str(DB_PATH), **{f"rows_{k}": v for k, v in counts.items()}})


@dg.asset(group_name="warehouse", deps=[raw_tables],
          description="dbt build: staging views, mart tables and their tests.")
def dbt_models(context: dg.AssetExecutionContext) -> dg.MaterializeResult:
    out = _step(context, "dbt build", _run.dbt("build"))
    return dg.MaterializeResult(metadata={"dbt_build": _run.summary(out)})


@dg.asset(group_name="warehouse", deps=[dbt_models],
          description="dbt test: re-checks every data and unit test against the built marts.")
def dbt_tests(context: dg.AssetExecutionContext) -> dg.MaterializeResult:
    out = _step(context, "dbt test", _run.dbt("test"))
    return dg.MaterializeResult(metadata={"dbt_test": _run.summary(out)})


gauge_warehouse_job = dg.define_asset_job(
    "gauge_warehouse_job",
    selection=dg.AssetSelection.assets(raw_tables, dbt_models, dbt_tests),
    executor_def=dg.in_process_executor,
)

# Defined, not running: a schedule only fires while `dagster dev` or dagster-daemon is up
# and the schedule is switched on in the UI (it ships STOPPED, Dagster's default).
daily_warehouse_schedule = dg.ScheduleDefinition(
    name="gauge_warehouse_daily",
    job=gauge_warehouse_job,
    cron_schedule="0 6 * * *",
)

defs = dg.Definitions(
    assets=[raw_tables, dbt_models, dbt_tests],
    jobs=[gauge_warehouse_job],
    schedules=[daily_warehouse_schedule],
)
