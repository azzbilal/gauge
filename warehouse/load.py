"""Copy the app tables from Postgres into the DuckDB warehouse (schema `raw`).

Idempotent: each table is rebuilt with CREATE OR REPLACE inside one transaction,
so a rerun leaves exactly one fresh copy. Uses DuckDB's postgres extension
(ATTACH ... READ_ONLY); nothing is written to Postgres.

DATABASE_URL comes from the environment, else from apps/api/.env. It is never
printed or stored.

    python warehouse/load.py [--db PATH]
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import duckdb

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = Path(__file__).resolve().parent / "gauge.duckdb"

# Prisma table name in Postgres -> raw table name in DuckDB.
TABLES = {
    "Campaign": "campaign",
    "Expert": "expert",
    "Task": "task",
    "TaskReview": "task_review",
    "ReviewDecision": "review_decision",
    "Event": "event",
}


def database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        env_file = ROOT / "apps" / "api" / ".env"
        if env_file.exists():
            for line in env_file.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line.startswith("DATABASE_URL="):
                    url = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break
    if not url:
        sys.exit("load: DATABASE_URL is not set and apps/api/.env has none")
    # Prisma-only query params (schema=, connection_limit=, ...) are not libpq options.
    parts = urlsplit(url)
    keep = [(k, v) for k, v in parse_qsl(parts.query) if k in {"sslmode", "application_name"}]
    return urlunsplit(parts._replace(query=urlencode(keep)))


def load(db_path: Path) -> dict[str, int]:
    con = duckdb.connect(str(db_path))
    try:
        con.execute("INSTALL postgres; LOAD postgres;")
        quoted = database_url().replace("'", "''")
        try:
            con.execute(f"ATTACH '{quoted}' AS pg (TYPE postgres, READ_ONLY)")
        except duckdb.Error:
            # DuckDB puts the full connection string (password included) into its error,
            # so re-raise a message that keeps the secret out of terminal and CI logs.
            raise RuntimeError(
                "load: cannot connect to Postgres (check DATABASE_URL and that Postgres is running)"
            ) from None
        con.execute("CREATE SCHEMA IF NOT EXISTS raw")
        counts: dict[str, int] = {}
        con.execute("BEGIN")
        for pg_name, raw_name in TABLES.items():
            con.execute(
                f'CREATE OR REPLACE TABLE raw.{raw_name} AS SELECT * FROM pg.public."{pg_name}"'
            )
            counts[raw_name] = con.execute(f"SELECT count(*) FROM raw.{raw_name}").fetchone()[0]
        con.execute(
            "CREATE OR REPLACE TABLE raw._load_log AS "
            "SELECT now() AS loaded_at, ? AS table_counts",
            [str(counts)],
        )
        con.execute("COMMIT")
        con.execute("DETACH pg")
        return counts
    finally:
        con.close()  # DuckDB allows one writer; dbt opens the file next.


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--db", type=Path, default=Path(os.environ.get("GAUGE_DUCKDB_PATH", DEFAULT_DB)))
    args = ap.parse_args()
    counts = load(args.db)
    for name, n in counts.items():
        print(f"load: raw.{name:<16} {n:>6} rows")
    print(f"load: wrote {args.db}")


if __name__ == "__main__":
    main()
