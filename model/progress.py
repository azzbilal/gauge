"""Live progress bar for a benchmark run, read from its --log file.

Usage:
    python model/progress.py <log.jsonl> [--total 300] [--watch] [--every 5]

--watch refreshes in place every --every seconds until the run finishes.
"""
import argparse
import time
from pathlib import Path


def _count(log: Path) -> int:
    if not log.exists():
        return 0
    n = 0
    for line in log.open(encoding="utf-8"):
        if line.strip() and not line.lstrip().startswith('{"header"'):
            n += 1
    return n


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("log", type=Path, help="the --log file, e.g. .../baseline.progress.jsonl")
    ap.add_argument("--total", type=int, default=300)
    ap.add_argument("--watch", action="store_true", help="refresh until the run finishes")
    ap.add_argument("--every", type=float, default=5.0)
    args = ap.parse_args()

    width = 30
    while True:
        done = _count(args.log)
        pct = done / max(args.total, 1)
        filled = round(width * pct)
        bar = "#" * filled + "." * (width - filled)
        print(f"\r[{bar}] {done}/{args.total} ({pct * 100:.0f}%)", end="", flush=True)
        if not args.watch or done >= args.total:
            print()
            break
        time.sleep(args.every)


if __name__ == "__main__":
    main()
