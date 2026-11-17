"""Real-task benchmark: the model on real CAD programs, not the synthetic templates.

    python model/bench_real.py fetch   --dir DIR              # prompts + ground-truth code
    python model/bench_real.py prepare --dir DIR --limit 100  # validate refs -> DIR/tasks.json
    python model/bench_real.py run --tasks DIR/tasks.json --mock oracle   # must be 100 %
    python model/bench_real.py run --tasks DIR/tasks.json --mock wrong    # must be 0 %
    python model/bench_real.py run --tasks DIR/tasks.json --fewshot 5 --out report.json
    python model/bench_real.py compare zeroshot.json fewshot5.json        # paired McNemar
    python model/bench_real.py run --tasks DIR/tasks.json --model gpt-oss:20b --reasoning high

--reasoning LEVEL turns thinking on for a reasoning model (Ollama `think: LEVEL`; gpt-oss's
template turns it into "Reasoning: low|medium|high", while `think: true` means medium). The
reasoning tokens come out of num_predict before any code, so with --reasoning the defaults
become num_predict REASONING_NUM_PREDICT and a REASONING_TIMEOUT_S request timeout (a
timeout is `not_run`, left out of the rate, so it must not be hit). Without the flag every
setting is what the qwen3.5 runs used: think false, num_predict 4096, temperature 0.

    python model/bench_real.py subset --tasks DIR/tasks.json --n 40 \\
        --by zeroshot.json fewshot5.json --out ids.json
    python model/bench_real.py run --tasks DIR/tasks.json --ids ids.json ...

`subset` picks a stratified subset for runs too slow for all 100 tasks. The strata are the
joint outcome (solved or not) of earlier reports on the full set, so the subset keeps their
rates; no output of the model about to be run goes into the choice. Seats go to strata in
proportion (largest remainder), and within a stratum the ids, sorted, are taken at evenly
spaced positions. `run --ids` then runs only those tasks, in tasks.json order.

Why: model/benchmark.py measures the model only on held-out tasks drawn from the same five
synthetic templates its few-shot examples come from. This harness asks the same model, with
the same five synthetic worked examples, for CadQuery on real parts it has never seen.

Data (kept outside the repo; pass its directory with --dir):
  prompts    CADTestBench (huggingface.co/datasets/anon-submission-2465453/CADTestBench,
             MIT), the `detailed` split: 200 text prompts that ask for CadQuery code and
             state the dimensions. The HF release ships prompts and tests, not reference
             code.
  reference  CADPrompt (github.com/Kamel773/CAD_Code_Generation), the dataset CADTestBench
             is derived from, same 8-digit sample ids: a ground-truth CadQuery program
             (Python_Code.py) and its measured extents (Ground_Truth.json) per sample.

`prepare` runs every reference through the verifier's own executor (verify/verifiers/
cad_exec.py `measure`), keeps those that build one valid solid whose extents agree with
Ground_Truth.json, and takes the first --limit by sample id. The rule looks at nothing but
the references: no model output goes into the choice.

Scoring (fixed before any model was run). The candidate's code is executed by the same
cad_exec.measure the Verifier Pack uses, then:

    solved     the code builds a solid whose bounding-box extents, sorted, are each within
               1 % (relative) of the reference's sorted extents. Sorted, because the prompts
               do not fix which axis is "length" and the references rotate and translate
               their parts; CADTestBench's own dimension tests also sort and use 1 %.
    failed     no code, a syntax error, code that raises or builds no solid, or wrong extents
    unjudged   the code timed out, or the CAD worker could not run (infrastructure)
    not_run    the model could not be asked (Ollama down): left out of the rate

Reported beside the headline, never in it: strict per-axis (X, Y, Z) extents within 1 %,
and volume within 2 % (bounding box alone passes a plain block for a part with a hole).
This is a weaker check than the synthetic benchmark's "solved" (extents plus hole diameter
plus hole count), so the two rates are not the same metric.

Needs GAUGE_CAD_PYTHON pointing at an interpreter with cadquery. Standard library only.
"""
import argparse
import ast
import json
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cadspec import use_verify  # noqa: E402

use_verify()
from verifiers import cad_exec  # noqa: E402

import benchmark  # noqa: E402  (load_tasks, select_examples, OllamaCandidate, wilson, compare)
from benchmark import FAILED, NOT_RUN, SOLVED, UNJUDGED  # noqa: E402

HF_ROWS = ("https://datasets-server.huggingface.co/rows?dataset=anon-submission-2465453/"
           "CADTestBench&config=samples&split={split}&offset={offset}&length=100")
GT_RAW = ("https://raw.githubusercontent.com/Kamel773/CAD_Code_Generation/main/CADPrompt/"
          "{id}/{name}")
GT_FILES = ("Python_Code.py", "Ground_Truth.json")
BBOX_TOL = 0.01    # relative, per extent: the headline
VOLUME_TOL = 0.02  # relative: secondary column only
WRONG_SCALE = 1.07  # the `wrong` mock scales the reference solid by this
DEFAULT_TRAIN = benchmark.generate.DATA_DIR / "synthetic-seed0-n100.json"
# The 41 % run's few-shot examples (docs/results/phase4-heldout300-fewshot5-2026-11-14.json).
EXPECTED_EXAMPLES = ["plate-001", "box-001", "bracket-001", "cutout-001", "rounded-001"]
# --reasoning defaults. Prompt + reasoning + code share num_ctx (16384, kept from the qwen runs):
# the few-shot prompt is ~2k tokens, so 12288 leaves the whole budget inside the window.
REASONING_LEVELS = ("low", "medium", "high")
REASONING_NUM_PREDICT = 12288
REASONING_TIMEOUT_S = 1800.0
SYNTHETIC_REFERENCE = {"solved": 122, "attempted": 300, "solve_rate": 122 / 300,
                       "report": "docs/results/phase4-heldout300-fewshot5-2026-11-14.json",
                       "metric": "extents + hole diameter + hole count (Verifier Pack)"}


# ----------------------------------------------------------------------------- fetch

def _get(url: str, timeout: float = 60.0) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "gauge-bench-real"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def fetch(directory: Path, split: str = "detailed") -> int:
    """Download the CADTestBench prompts and CADPrompt ground truth into `directory`."""
    directory.mkdir(parents=True, exist_ok=True)
    rows, offset = [], 0
    while True:
        page = json.loads(_get(HF_ROWS.format(split=split, offset=offset)))
        rows += [r["row"] for r in page["rows"]]
        offset += len(page["rows"])
        if not page["rows"] or offset >= page["num_rows_total"]:
            break
    (directory / f"prompts-{split}.json").write_text(
        json.dumps(rows, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    for row in rows:
        sample = directory / "cadprompt" / row["sample_id"]
        sample.mkdir(parents=True, exist_ok=True)
        for name in GT_FILES:
            if not (sample / name).exists():
                (sample / name).write_bytes(_get(GT_RAW.format(id=row["sample_id"], name=name)))
    print(f"fetched {len(rows)} {split} prompts and their ground truth into {directory}")
    return 0


# ----------------------------------------------------------------------------- prepare

def strip_export(code: str) -> str:
    """The reference without its `cq.exporters.export(...)` line (it writes an STL file)."""
    return "\n".join(line for line in code.splitlines()
                     if "cq.exporters.export" not in line).strip() + "\n"


def _close(got, want, tol) -> bool:
    return all(abs(g - w) <= tol * abs(w) for g, w in zip(got, want))


def prepare(directory: Path, limit: int, split: str = "detailed") -> int:
    """Validate every reference with cad_exec.measure and write `tasks.json`."""
    rows = json.loads((directory / f"prompts-{split}.json").read_text(encoding="utf-8"))
    tasks, dropped = [], []
    for row in sorted(rows, key=lambda r: r["sample_id"]):
        sid = row["sample_id"]
        sample = directory / "cadprompt" / sid
        code = strip_export((sample / "Python_Code.py").read_text(encoding="utf-8"))
        m = cad_exec.measure(code)
        if m.kind in (cad_exec.NOT_RUN, cad_exec.UNAVAILABLE):
            print(f"error: the CAD worker cannot run ({m.detail}); set GAUGE_CAD_PYTHON",
                  file=sys.stderr)
            return 1
        why = None
        if m.kind != cad_exec.OK:
            why = f"reference {m.kind}: {m.detail}"
        elif m.solids != 1 or not m.valid:
            why = f"reference builds {m.solids} solid(s), valid={m.valid}"
        else:
            gt = json.loads((sample / "Ground_Truth.json").read_text(encoding="utf-8"))
            gt = gt["Ground_Truth"]
            want = sorted([gt["Width_mm"], gt["Height_mm"], gt["Depth_mm"]])
            if not _close(sorted(m.size), want, BBOX_TOL):
                why = (f"measured extents {sorted(round(v, 5) for v in m.size)} disagree with "
                       f"Ground_Truth.json {want}")
        if why:
            dropped.append({"id": sid, "why": why})
            print(f"  drop {sid}: {why}", file=sys.stderr)
            continue
        tasks.append({"id": sid, "prompt": row["prompt"], "reference": code,
                      "ref_size": list(m.size), "ref_volume": m.volume})
        print(f"  ok   {sid} {[round(v, 5) for v in m.size]}", file=sys.stderr)
    chosen = tasks[:limit]
    out = {"source": {"prompts": f"CADTestBench samples/{split}",
                      "reference": "CADPrompt Python_Code.py (cq.exporters line removed)"},
           "rule": f"first {limit} sample ids (sorted) whose reference builds one valid "
                   f"solid matching Ground_Truth.json extents within {BBOX_TOL:.0%}",
           "examined": len(rows), "valid": len(tasks), "dropped": dropped,
           "count": len(chosen), "tasks": chosen}
    (directory / "tasks.json").write_text(json.dumps(out, indent=1) + "\n", encoding="utf-8")
    print(f"{len(rows)} references examined, {len(tasks)} valid, {len(dropped)} dropped; "
          f"wrote the first {len(chosen)} to {directory / 'tasks.json'}")
    return 0


# ----------------------------------------------------------------------------- scoring

def score(code: str, task: dict) -> dict:
    """Execute `code` with the verifier's executor and compare it with the reference."""
    out = {"stage": None, "detail": "", "size": None, "volume": None,
           "bbox_sorted": False, "bbox_xyz": False, "volume_match": False}
    if not code.strip():
        out.update(stage="no_code", detail="the model returned no code")
        return out
    try:
        ast.parse(code)
    except SyntaxError as err:
        out.update(stage="syntax_error", detail=f"SyntaxError: {err.msg} (line {err.lineno})")
        return out
    m = cad_exec.measure(code)
    out["detail"] = m.detail
    if m.kind in (cad_exec.NOT_RUN, cad_exec.UNAVAILABLE):
        out["stage"] = "worker_" + m.kind
        return out
    if m.kind == cad_exec.TIMEOUT:
        out["stage"] = "timeout"
        return out
    if m.kind == cad_exec.ERROR:
        out["stage"] = "raised"
        return out
    if m.kind == cad_exec.NO_SOLID:
        out["stage"] = "no_solid"
        return out
    ref = task["ref_size"]
    out.update(size=list(m.size), volume=m.volume,
               bbox_sorted=_close(sorted(m.size), sorted(ref), BBOX_TOL),
               bbox_xyz=_close(m.size, ref, BBOX_TOL),
               volume_match=abs(m.volume - task["ref_volume"])
               <= VOLUME_TOL * abs(task["ref_volume"]))
    out["stage"] = "bbox_match" if out["bbox_sorted"] else "bbox_wrong"
    if not out["bbox_sorted"]:
        out["detail"] = (f"extents {[round(v, 5) for v in m.size]} vs reference "
                         f"{[round(v, 5) for v in ref]}")
    return out


def outcome_of(stage: str) -> str:
    if stage == "bbox_match":
        return SOLVED
    if stage in ("timeout", "worker_not_run", "worker_unavailable"):
        return UNJUDGED
    return FAILED


# ----------------------------------------------------------------------------- subset

def stratified_ids(ids: list, strata: dict, n: int) -> list:
    """`n` of `ids`, allocated to `strata` ({id: key}) in proportion, evenly spaced within."""
    groups = {}
    for i in sorted(ids):
        groups.setdefault(strata[i], []).append(i)
    exact = {k: n * len(v) / len(ids) for k, v in groups.items()}
    seats = {k: int(q) for k, q in exact.items()}
    for k in sorted(exact, key=lambda k: (-(exact[k] - seats[k]), str(k)))[:n - sum(seats.values())]:
        seats[k] += 1
    chosen = []
    for k, members in groups.items():
        m = seats[k]
        chosen += [members[int((j + 0.5) * len(members) / m)] for j in range(m)]
    return sorted(chosen)


def subset_cmd(args) -> int:
    tasks = [t["id"] for t in json.loads(args.tasks.read_text(encoding="utf-8"))["tasks"]]
    reports = [json.loads(p.read_text(encoding="utf-8")) for p in args.by]
    solved = [{r["id"]: r["attempts"][0]["outcome"] == SOLVED for r in rep["per_task"]}
              for rep in reports]
    missing = [i for i in tasks if any(i not in s for s in solved)]
    if missing or not 0 < args.n <= len(tasks):
        print(f"error: {len(missing)} task(s) missing from --by reports, or bad --n",
              file=sys.stderr)
        return 2
    strata = {i: "".join("S" if s[i] else "f" for s in solved) for i in tasks}
    ids = stratified_ids(tasks, strata, args.n)
    counts = {}
    for i in ids:
        counts[strata[i]] = counts.get(strata[i], 0) + 1
    out = {"rule": f"{args.n} of {len(tasks)} tasks, stratified on the joint solved (S) / "
                   f"not solved (f) outcome in {[p.name for p in args.by]}, proportional "
                   f"(largest remainder), evenly spaced by sorted id within each stratum",
           "strata_full": {k: sum(v == k for v in strata.values())
                           for k in sorted(set(strata.values()))},
           "strata_subset": dict(sorted(counts.items())),
           "count": len(ids), "ids": ids}
    text = json.dumps(out, indent=1) + "\n"
    if args.out:
        args.out.write_text(text, encoding="utf-8", newline="\n")
    print(text, end="")
    return 0


# ----------------------------------------------------------------------------- run

def oracle(task):
    return lambda prompt, spec, model: task["reference"]


def wrong(task):
    """The reference with its solid scaled by WRONG_SCALE: a known wrong answer."""
    return lambda prompt, spec, model: (
        task["reference"] + f"part = part.val().scale({WRONG_SCALE})\n")


MOCKS = {"oracle": oracle, "wrong": wrong}


def attempt(task: dict, model: str, candidate) -> dict:
    started = time.monotonic()
    try:
        code = candidate(task["prompt"], "", model)
    except benchmark.OllamaError as err:
        return {"outcome": NOT_RUN, "stage": "ollama", "detail": str(err), "code": None,
                "meta": None, "seconds": round(time.monotonic() - started, 1)}
    meta = getattr(code, "meta", None)
    code = str(code)
    s = score(code, task)
    return {"outcome": outcome_of(s["stage"]), **s, "code": code, "meta": meta,
            "truncated": bool(meta) and meta.get("done_reason") == "length",
            "seconds": round(time.monotonic() - started, 1)}


def summarise(per_task: list) -> dict:
    attempts = [r["attempts"][0] for r in per_task]
    totals = {k: sum(a["outcome"] == k for a in attempts)
              for k in (SOLVED, FAILED, UNJUDGED, NOT_RUN)}
    judged = totals[SOLVED] + totals[FAILED] + totals[UNJUDGED]
    stages = {}
    for a in attempts:
        stages[a["stage"]] = stages.get(a["stage"], 0) + 1
    built = sum(a.get("size") is not None for a in attempts)
    xyz = sum(bool(a.get("bbox_xyz")) for a in attempts)
    vol = sum(bool(a.get("bbox_sorted")) and bool(a.get("volume_match")) for a in attempts)
    return {
        "solve_rate": totals[SOLVED] / judged if judged else None,
        "solve_rate_ci95": benchmark.wilson(totals[SOLVED], judged),
        "totals": totals, "attempted": judged, "stages": dict(sorted(stages.items())),
        "built_a_solid": built,
        "secondary": {
            "bbox_xyz_strict": {"solved": xyz, "rate": xyz / judged if judged else None,
                                "ci95": benchmark.wilson(xyz, judged)},
            "bbox_and_volume": {"solved": vol, "rate": vol / judged if judged else None,
                                "ci95": benchmark.wilson(vol, judged)},
        },
    }


def render(report: dict) -> str:
    pct, ci = benchmark._pct, benchmark._ci
    t, sec = report["totals"], report["secondary"]
    syn = SYNTHETIC_REFERENCE
    lines = [
        f"real-task benchmark  {report['data']}  ({report['tasks']} CADTestBench tasks, "
        f"references from CADPrompt)",
        f"candidate {report['candidate']}",
        ("generation " + json.dumps(report["generation"], sort_keys=True))
        if report.get("generation") else "generation: n/a (mock candidate)",
        "",
        f"Solve rate (sorted extents within {BBOX_TOL:.0%}): {t[SOLVED]}/{report['attempted']} "
        f"= {pct(report['solve_rate'])}  95 % Wilson {ci(report['solve_rate_ci95'])}   "
        f"(failed {t[FAILED]}, unjudged {t[UNJUDGED]}, not run {t[NOT_RUN]})",
        f"  strict X/Y/Z extents within {BBOX_TOL:.0%}:   {sec['bbox_xyz_strict']['solved']}/"
        f"{report['attempted']} = {pct(sec['bbox_xyz_strict']['rate'])}  "
        f"{ci(sec['bbox_xyz_strict']['ci95'])}",
        f"  extents and volume within {VOLUME_TOL:.0%}:   {sec['bbox_and_volume']['solved']}/"
        f"{report['attempted']} = {pct(sec['bbox_and_volume']['rate'])}  "
        f"{ci(sec['bbox_and_volume']['ci95'])}",
        f"  built a solid at all:              {report['built_a_solid']}/{report['attempted']}",
        "",
        "Where attempts ended: " + ", ".join(f"{k} {v}" for k, v in report["stages"].items()),
        "",
        f"For comparison, synthetic held-out templates: {syn['solved']}/{syn['attempted']} = "
        f"{pct(syn['solve_rate'])} ({syn['metric']}; a stricter check than the one above).",
        "",
        "Per task",
    ]
    for row in report["per_task"]:
        a = row["attempts"][0]
        extra = "" if a["outcome"] == SOLVED else (a.get("detail") or "")[:100]
        lines.append(f"  {row['id']}  {a['outcome']:<8} {a['stage']:<12} {extra}")
    return "\n".join(lines)


def run_cmd(args) -> int:
    data = json.loads(args.tasks.read_text(encoding="utf-8"))
    tasks = data["tasks"][:args.limit] if args.limit else data["tasks"]
    subset_ids = None
    if args.ids:
        subset_ids = json.loads(args.ids.read_text(encoding="utf-8"))["ids"]
        unknown = set(subset_ids) - {t["id"] for t in tasks}
        if unknown:
            print(f"error: --ids lists {len(unknown)} id(s) not in the tasks, e.g. "
                  f"{sorted(unknown)[0]}", file=sys.stderr)
            return 2
        tasks = [t for t in tasks if t["id"] in set(subset_ids)]
    examples, generation = [], None
    if args.mock:
        if args.fewshot:
            print("error: --fewshot needs a model, not a mock", file=sys.stderr)
            return 2
        candidate_for, label = MOCKS[args.mock], f"mock:{args.mock}"
    else:
        if args.fewshot:
            _, train = benchmark.load_tasks(args.train_data, "train")
            examples = benchmark.select_examples(train, args.fewshot)
            ids = [e["id"] for e in examples]
            if args.fewshot == 5 and ids != EXPECTED_EXAMPLES:
                print(f"error: few-shot examples {ids} are not the 41 % run's "
                      f"{EXPECTED_EXAMPLES}", file=sys.stderr)
                return 2
        try:
            if not benchmark.ollama_has(args.model):
                print(f"error: ollama does not list model {args.model!r}", file=sys.stderr)
                return 2
        except benchmark.OllamaError as err:
            print(f"error: {err}", file=sys.stderr)
            return 1
        reasoning = args.reasoning
        num_predict = args.num_predict or (REASONING_NUM_PREDICT if reasoning else 4096)
        timeout = args.timeout or (REASONING_TIMEOUT_S if reasoning
                                   else benchmark.DEFAULT_TIMEOUT_S)
        if num_predict >= args.num_ctx:
            print(f"error: --num-predict {num_predict} must be below --num-ctx {args.num_ctx} "
                  f"(prompt, reasoning and code share the window)", file=sys.stderr)
            return 2
        candidate = benchmark.OllamaCandidate(
            temperature=args.temperature, num_ctx=args.num_ctx,
            num_predict=num_predict, think=reasoning or False, timeout=timeout,
            examples=examples)
        generation = dict(candidate.settings)
        if reasoning:
            generation["timeout_s"] = timeout
        candidate_for, label = (lambda task: candidate), f"ollama:{args.model}"
        label += f"+fewshot{len(examples)}" if examples else ""

    config = {"data": "cadtestbench-detailed/" + args.tasks.name, "tasks": len(tasks),
              "candidate": label, "generation": generation}
    if subset_ids is not None:
        config["subset"] = {"ids_file": args.ids.name, "count": len(tasks)}
    log = args.out.with_name(args.out.name + ".progress.jsonl") if args.out else None
    done = {}
    if log and args.resume and log.exists():
        lines = log.read_text(encoding="utf-8").splitlines()
        if lines and json.loads(lines[0]).get("header") == json.loads(json.dumps(config)):
            for line in lines[1:]:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if row["attempts"][0]["outcome"] != NOT_RUN:
                    done[row["id"]] = row
            print(f"resuming: {len(done)} task(s) already run", file=sys.stderr)
    if log:
        log.parent.mkdir(parents=True, exist_ok=True)
        if not done:
            log.write_text(json.dumps({"header": config}) + "\n", encoding="utf-8")

    per_task = []
    for i, task in enumerate(tasks, 1):
        row = done.get(task["id"])
        if row is None:
            a = attempt(task, args.model, candidate_for(task))
            row = {"id": task["id"], "family": "cadtestbench", "attempts": [a],
                   **{k: int(a["outcome"] == k) for k in (SOLVED, FAILED, UNJUDGED, NOT_RUN)}}
            if log:
                with open(log, "a", encoding="utf-8") as fh:
                    fh.write(json.dumps(row) + "\n")
        per_task.append(row)
        a = row["attempts"][0]
        print(f"[{i}/{len(tasks)}] {task['id']}: {a['outcome']} ({a['stage']}, "
              f"{a['seconds']:.0f} s)", file=sys.stderr, flush=True)

    report = {**summarise(per_task), "per_task": per_task, "tasks": len(per_task),
              "rollouts": 1, "data": config["data"], "split": "real",
              "subset": config.get("subset"),
              "spec_version": "cadtestbench-detailed", "candidate": label,
              "model": None if args.mock else args.model, "generation": generation,
              "train_data": benchmark._shown(args.train_data) if examples else None,
              "scoring": {"executor": "verify/verifiers/cad_exec.py measure",
                          "cadquery": cad_exec._has_cadquery.get(cad_exec.worker_python()),
                          "headline": f"sorted bounding-box extents within {BBOX_TOL:.0%}",
                          "volume_tol": VOLUME_TOL},
              "synthetic_reference": SYNTHETIC_REFERENCE}
    print(render(report))
    if args.out:
        args.out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n",
                            encoding="utf-8", newline="\n")
    return 1 if report["totals"][NOT_RUN] else 0


def compare_cmd(args) -> int:
    first, second = (json.loads(p.read_text(encoding="utf-8")) for p in args.reports)
    result = benchmark.compare(first, second)
    print(benchmark.render_compare(result))
    if args.out:
        args.out.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n",
                            encoding="utf-8", newline="\n")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch", help="download prompts and ground truth into --dir")
    f.add_argument("--dir", type=Path, required=True)
    p = sub.add_parser("prepare", help="validate references, write --dir/tasks.json")
    p.add_argument("--dir", type=Path, required=True)
    p.add_argument("--limit", type=int, default=100)
    r = sub.add_parser("run", help="benchmark a candidate on the prepared tasks")
    r.add_argument("--tasks", type=Path, required=True)
    r.add_argument("--limit", type=int, default=None)
    r.add_argument("--ids", type=Path, default=None,
                   help="run only the ids in this file (written by `subset`)")
    r.add_argument("--model", default=benchmark.DEFAULT_MODEL)
    r.add_argument("--mock", choices=sorted(MOCKS), default=None)
    r.add_argument("--fewshot", type=int, default=0, metavar="K")
    r.add_argument("--train-data", type=Path, default=DEFAULT_TRAIN)
    r.add_argument("--temperature", type=float, default=0.0)
    r.add_argument("--num-ctx", type=int, default=16384)
    r.add_argument("--num-predict", type=int, default=None,
                   help="default 4096, as in the 41 %% synthetic run; "
                        f"{REASONING_NUM_PREDICT} with --reasoning")
    r.add_argument("--reasoning", "--think", choices=REASONING_LEVELS, default=None,
                   help="enable thinking at this level (Ollama think: LEVEL); default off "
                        "(think false)")
    r.add_argument("--timeout", type=float, default=None,
                   help="seconds per Ollama request; default the probe's (300 s), "
                        f"{REASONING_TIMEOUT_S:.0f} s with --reasoning")
    r.add_argument("--out", type=Path, default=None)
    r.add_argument("--resume", action="store_true")
    s = sub.add_parser("subset", help="stratified subset of task ids for a slow model")
    s.add_argument("--tasks", type=Path, required=True)
    s.add_argument("--n", type=int, required=True)
    s.add_argument("--by", type=Path, nargs="+", required=True,
                   help="earlier full-set reports whose joint outcome is the strata")
    s.add_argument("--out", type=Path, default=None)
    c = sub.add_parser("compare", help="paired comparison of two run reports")
    c.add_argument("reports", type=Path, nargs=2)
    c.add_argument("--out", type=Path, default=None)
    args = ap.parse_args(argv)
    if args.cmd == "fetch":
        return fetch(args.dir)
    if args.cmd == "prepare":
        return prepare(args.dir, args.limit)
    if args.cmd == "compare":
        return compare_cmd(args)
    if args.cmd == "subset":
        return subset_cmd(args)
    return run_cmd(args)


if __name__ == "__main__":
    sys.exit(main())
