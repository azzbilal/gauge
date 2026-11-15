"""Load a small synthetic fixture into schema `raw` of a DuckDB file, for CI.

CI has no Postgres, so this stands in for warehouse/load.py: it writes the same six raw
tables (plus raw._load_log) with the column names and types load.py produces from the
Prisma schema (apps/api/prisma/schema.prisma). Every row is invented. The rows cover the
cases the marts treat differently, so dbt's tests have something to bite on: an empty
campaign, every task status, gold tasks expecting accept and reject, a gold clone, a gold
with no answer, agreeing and split reviewer pairs, and a legacy review with no reviewer id.

    python warehouse/fixtures/load_fixture.py --db PATH          # write the fixture
    python warehouse/fixtures/load_fixture.py --db PATH --check  # after dbt build: known answers

--db is required, and the real warehouse file (warehouse/gauge.duckdb) is refused.
If you change the Prisma schema or load.py, change the DDL here to match.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import duckdb

REAL_DB = (Path(__file__).resolve().parent.parent / "gauge.duckdb").resolve()

DDL = """
CREATE SCHEMA IF NOT EXISTS raw;
CREATE OR REPLACE TABLE raw.campaign (
    id VARCHAR, name VARCHAR, "targetCount" INTEGER, "specVersion" VARCHAR,
    "createdAt" TIMESTAMP, "updatedAt" TIMESTAMP);
CREATE OR REPLACE TABLE raw.expert (
    id VARCHAR, name VARCHAR, domain VARCHAR,
    status ENUM('APPLIED', 'SCREENING', 'ACCEPTED', 'REJECTED', 'ACTIVE'),
    "createdAt" TIMESTAMP, "updatedAt" TIMESTAMP);
CREATE OR REPLACE TABLE raw.task (
    id VARCHAR, "campaignId" VARCHAR, "authorId" VARCHAR, prompt VARCHAR, spec VARCHAR,
    reference VARCHAR,
    status ENUM('DRAFT', 'SUBMITTED', 'IN_REVIEW', 'ACCEPTED', 'REJECTED'),
    "isGold" BOOLEAN, "createdAt" TIMESTAMP, "updatedAt" TIMESTAMP,
    "goldExpectedAccept" BOOLEAN, "goldSourceId" VARCHAR, "goldForExpertId" VARCHAR,
    "goldOpenFor" VARCHAR);
CREATE OR REPLACE TABLE raw.task_review (
    id VARCHAR, "taskId" VARCHAR, "reviewerId" VARCHAR, scores VARCHAR, accepted BOOLEAN,
    "createdAt" TIMESTAMP, "reviewerExpertId" VARCHAR, evidence VARCHAR);
CREATE OR REPLACE TABLE raw.review_decision (
    id VARCHAR, "subjectType" VARCHAR, "subjectId" VARCHAR, "reviewerId" VARCHAR,
    verdict ENUM('APPROVE', 'REJECT', 'NEEDS_REVIEW'), reason VARCHAR, "createdAt" TIMESTAMP);
CREATE OR REPLACE TABLE raw.event (
    id VARCHAR, "actorId" VARCHAR, type VARCHAR, payload VARCHAR, "createdAt" TIMESTAMP);
"""

D1, D2, D3 = "2026-01-05 10:00:00", "2026-01-06 10:00:00", "2026-01-07 10:00:00"

CAMPAIGNS = [
    ("c_plates", "Fixture plates", 10, "cad-v1", D1, D3),
    ("c_empty", "Fixture empty", 5, "cad-v1", D1, D1),  # no tasks: every metric 0 or null
]

EXPERTS = [
    ("e_author", "Fixture Author", "cad", "ACTIVE", D1, D1),
    ("e_rev1", "Fixture Reviewer One", "cad", "ACTIVE", D1, D1),
    ("e_rev2", "Fixture Reviewer Two", "cad", "ACTIVE", D1, D1),
]

# id, status, is_gold, created, gold_expected_accept, gold_source_id, gold_for_expert_id
TASKS = [
    ("t_agree_acc", "ACCEPTED", False, D1, None, None, None),
    ("t_agree_rej", "REJECTED", False, D1, None, None, None),
    ("t_split", "ACCEPTED", False, D2, None, None, None),     # reviewers disagree
    ("t_submitted", "SUBMITTED", False, D2, None, None, None),
    ("t_draft", "DRAFT", False, D2, None, None, None),
    ("t_in_review", "IN_REVIEW", False, D3, None, None, None),
    ("t_legacy", "ACCEPTED", False, D3, None, None, None),    # one legacy + one identified review
    ("g_good", "ACCEPTED", True, D1, True, None, None),
    ("g_bad", "REJECTED", True, D1, False, None, None),
    ("g_bad_clone", "IN_REVIEW", True, D2, None, "g_bad", "e_rev2"),  # scores against g_bad
    ("g_no_answer", "SUBMITTED", True, D2, None, None, None),          # unscorable gold
]

CRITERIA = ["verifiable", "unambiguous", "correct_reference", "complete_constraints", "difficulty"]


def scores(*values: int) -> str:
    return json.dumps(dict(zip(CRITERIA, values)))


def evidence(note: str | None) -> str:
    # One blank note per review, which the quality mart must count as "no evidence".
    return json.dumps({c: (note if i < 4 else "  ") for i, c in enumerate(CRITERIA)})


# id, task_id, reviewer_expert_id (None = legacy), accepted, scores, evidence
REVIEWS = [
    ("r1", "t_agree_acc", "e_rev1", True, scores(5, 4, 4, 4, 3), evidence("measured ok")),
    ("r2", "t_agree_acc", "e_rev2", True, scores(4, 4, 5, 3, 3), evidence("matches spec")),
    ("r3", "t_agree_rej", "e_rev1", False, scores(2, 3, 1, 2, 2), evidence("wrong width")),
    ("r4", "t_agree_rej", "e_rev2", False, scores(3, 2, 2, 2, 3), evidence("holes off")),
    ("r5", "t_split", "e_rev1", True, scores(5, 5, 4, 4, 4), evidence("fine")),
    ("r6", "t_split", "e_rev2", False, scores(3, 3, 2, 3, 3), evidence("ambiguous")),
    ("r7", "t_in_review", "e_rev1", True, scores(4, 4, 4, 4, 3), evidence("ok")),
    ("r8", "t_legacy", None, True, scores(4, 3, 4, 3, 3), None),  # pre-protocol row
    ("r9", "t_legacy", "e_rev2", True, scores(5, 4, 4, 4, 4), evidence("ok")),
    ("r10", "g_good", "e_rev1", True, scores(5, 5, 5, 4, 3), evidence("good")),       # correct
    ("r11", "g_bad", "e_rev1", True, scores(4, 4, 4, 4, 3), evidence("looks fine")),  # false accept
    ("r12", "g_bad_clone", "e_rev2", False, scores(2, 2, 1, 2, 3), evidence("broken")),  # correct
    ("r13", "g_no_answer", "e_rev1", True, scores(4, 4, 4, 4, 4), evidence("ok")),    # unscorable
]

EXPECTED_COUNTS = {
    "campaign": len(CAMPAIGNS), "expert": len(EXPERTS), "task": len(TASKS),
    "task_review": len(REVIEWS), "review_decision": 1, "event": 1,
}


def guard(db: Path) -> Path:
    db = db.resolve()
    if db == REAL_DB:
        sys.exit(f"load_fixture: refusing to write the real warehouse file {db}")
    return db


def load(db: Path) -> dict[str, int]:
    con = duckdb.connect(str(db))
    try:
        con.execute("BEGIN")
        con.execute(DDL)
        con.executemany("INSERT INTO raw.campaign VALUES (?, ?, ?, ?, ?, ?)", CAMPAIGNS)
        con.executemany("INSERT INTO raw.expert VALUES (?, ?, ?, ?, ?, ?)", EXPERTS)
        con.executemany(
            "INSERT INTO raw.task VALUES (?, 'c_plates', 'e_author', 'Model a plate.', NULL, "
            "NULL, ?, ?, ?, ?, ?, ?, ?, NULL)",  # goldOpenFor: the clone is already reviewed
            [(tid, status, gold, created, created, expected, source, for_expert)
             for tid, status, gold, created, expected, source, for_expert in TASKS])
        con.executemany(
            "INSERT INTO raw.task_review VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [(rid, task, expert or "legacy-label", sc, acc, D3, expert, ev)
             for rid, task, expert, acc, sc, ev in REVIEWS])
        con.execute("INSERT INTO raw.review_decision VALUES "
                    "('d1', 'task', 't_split', 'e_rev1', 'APPROVE', 'adjudicated', ?)", [D3])
        con.execute("INSERT INTO raw.event VALUES ('ev1', 'e_author', 'task.created', '{}', ?)",
                    [D1])
        counts = {t: con.execute(f"SELECT count(*) FROM raw.{t}").fetchone()[0]
                  for t in EXPECTED_COUNTS}
        con.execute("CREATE OR REPLACE TABLE raw._load_log AS "
                    "SELECT now() AS loaded_at, ? AS table_counts", [str(counts)])
        con.execute("COMMIT")
    finally:
        con.close()  # dbt opens the file next; DuckDB allows one writer.
    if counts != EXPECTED_COUNTS:
        sys.exit(f"load_fixture: row counts {counts} != expected {EXPECTED_COUNTS}")
    return counts


# Known answers for the rows above, worked out by hand from the mart definitions in
# warehouse/dbt/models/marts/marts.yml. dbt's own tests check invariants; these check values.
CHECKS = [
    ("mart_campaign c_plates",
     "select task_count, gold_task_count, accepted_count, rejected_count, accept_rate, "
     "active_days, tasks_per_day, multi_reviewed_count, agreed_count, reviewer_agreement "
     "from main_marts.mart_campaign where campaign_id = 'c_plates'",
     (7, 4, 3, 1, 0.75, 3, 2.33, 3, 2, 0.667)),
    ("mart_campaign c_empty",
     "select task_count, gold_task_count, accept_rate, reviewer_agreement "
     "from main_marts.mart_campaign where campaign_id = 'c_empty'",
     (0, 0, None, None)),
    ("mart_reviewer_calibration e_rev1",
     "select n_reviews, n_task_reviews, n_gold_reviews, n_gold_unscorable, n_gold_correct, "
     "n_false_accepts, n_false_rejects, gold_accuracy, false_accept_rate, false_reject_rate "
     "from main_marts.mart_reviewer_calibration where reviewer_expert_id = 'e_rev1'",
     (7, 4, 2, 1, 1, 1, 0, 0.5, 1.0, 0.0)),
    ("mart_reviewer_calibration e_rev2",
     "select n_reviews, n_task_reviews, n_gold_reviews, n_gold_correct, gold_accuracy, "
     "false_accept_rate, false_reject_rate "
     "from main_marts.mart_reviewer_calibration where reviewer_expert_id = 'e_rev2'",
     (5, 4, 1, 1, 1.0, 0.0, None)),
    ("mart_reviewer_calibration rows",
     "select count(*) from main_marts.mart_reviewer_calibration", (2,)),
    ("mart_task_quality verifiable",
     "select n_tasks, n_scores, n_legacy_scores, n_with_evidence, avg_score, "
     "avg_score_accepted, avg_score_rejected, share_with_evidence "
     "from main_marts.mart_task_quality where criterion = 'verifiable'",
     (4, 8, 1, 7, 3.88, 4.33, 2.5, 0.875)),
    ("mart_task_quality difficulty (blank notes are not evidence)",
     "select n_scores, n_with_evidence from main_marts.mart_task_quality "
     "where criterion = 'difficulty'",
     (8, 0)),
]


def check(db: Path) -> None:
    con = duckdb.connect(str(db), read_only=True)
    failures = []
    try:
        for name, sql, expected in CHECKS:
            row = con.execute(sql).fetchone()
            got = None if row is None else tuple(None if v is None else float(v) for v in row)
            ok = got is not None and len(got) == len(expected) and all(
                g == e if g is None or e is None else abs(g - e) < 1e-9
                for g, e in zip(got, expected))
            print(f"check: {'ok  ' if ok else 'FAIL'} {name}: {got}")
            if not ok:
                failures.append(f"{name}: got {got}, expected {expected}")
    finally:
        con.close()
    if failures:
        sys.exit("load_fixture: known-answer checks failed:\n  " + "\n  ".join(failures))
    print(f"check: all {len(CHECKS)} known-answer checks passed")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--db", type=Path, required=True, help="DuckDB file to write (not gauge.duckdb)")
    ap.add_argument("--check", action="store_true",
                    help="check mart values against the fixture's known answers (run after dbt build)")
    args = ap.parse_args()
    db = guard(args.db)
    if args.check:
        check(db)
        return
    for name, n in load(db).items():
        print(f"load_fixture: raw.{name:<16} {n:>3} rows")
    print(f"load_fixture: wrote {db}")


if __name__ == "__main__":
    main()
