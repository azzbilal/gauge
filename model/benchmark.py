"""Held-out benchmark harness (M5).

    python model/benchmark.py                                   # OLLAMA_MODEL on the held-out split
    python model/benchmark.py --model qwen3.5:9b-q4_K_M --limit 5 --out report.json
    python model/benchmark.py --mock oracle                     # the reference: must be 100 %
    python model/benchmark.py --mock wrong                      # 7 mm too wide: must be 0 %

For every held-out task of a cad-spec batch (model/SPEC.md) it asks a candidate for a
CadQuery solution from the prompt and spec alone, scores it with the M8 Verifier Pack
through the M9 probe's own scorer (verify/probe/probe.py), and reports the solve rate plus
a per-task breakdown. Nothing here scores anything itself.

Each attempt has one of four outcomes:

    solved     every geometry_cad / static_cad verdict passes
    failed     a verdict failed (wrong size, wrong hole count, code that raises or builds
               no solid)
    unjudged   nothing failed but a check could not run (a verifier error in probe terms)
    not_run    the model could not be asked (Ollama down, unknown model): never a failure

The headline solve rate is solved / (solved + failed + unjudged); unjudged is reported
beside it, not hidden in it. not_run attempts are left out of the rate and listed.

A candidate is any `fn(prompt, spec, model) -> code`, the probe's rollout_fn signature:
OllamaCandidate (local Ollama) by default, or a mock. OllamaCandidate builds the prompt and
reads the code with the probe's own build_prompt / extract_code, and sends what the API's
intake provider sends (apps/api/src/intake/llm/ollama.provider.ts): think off, temperature,
num_ctx and num_predict. Without `think: false` a thinking model such as qwen3.5 spends the
whole budget reasoning and returns an empty answer. An attempt whose reply holds no code is
`failed`, labelled "no code" and counted in the headline.

Generated code is EXECUTED by the
verifier in a worker process with a timeout; set GAUGE_CAD_PYTHON to an interpreter with
cadquery so sizes are measured on the solid, or GAUGE_CAD_EXEC=0 to read code statically.
Standard library only.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cadspec import SpecError, check_task, spec_version, to_packet, use_verify  # noqa: E402

use_verify()
from lint.packet import TaskPacket  # noqa: E402
from probe.probe import (DEFAULT_TIMEOUT_S, OLLAMA_URL, OllamaError,  # noqa: E402
                         build_prompt, extract_code, score)

import generate  # noqa: E402  (data paths, and fmt() for the wrong mock)

SOLVED, FAILED, UNJUDGED, NOT_RUN = "solved", "failed", "unjudged", "not_run"
DEFAULT_DATA = generate.DATA_DIR / (
    f"synthetic-seed{generate.DEFAULT_SEED}-n{generate.DEFAULT_COUNT}.json")
DEFAULT_MODEL = os.environ.get("OLLAMA_MODEL", "").strip() or "qwen3.5:9b-q4_K_M"


def _env_int(name, default):
    try:
        value = int(os.environ.get(name, ""))
    except ValueError:
        return default
    return value if value > 0 else default


DEFAULT_NUM_CTX = _env_int("OLLAMA_NUM_CTX", 16384)  # read as the API reads them
DEFAULT_NUM_PREDICT = _env_int("OLLAMA_NUM_PREDICT", 2048)
WRONG_BY = 7  # mm the `wrong` mock adds to the width

# What a solved verdict does not look at, per family (model/SPEC.md, "Solved").
NOT_SCORED = {
    "plate": "hole positions",
    "box": "wall thickness, open top, hole positions",
    "bracket": "plate thickness, upright position, hole positions",
    "cutout": "the cutout (size and presence)",
    "rounded": "fillet radius (and presence), hole positions",
}


# ----------------------------------------------------------------------------- data

def load_tasks(path: Path, split: str = "heldout") -> tuple:
    """(batch metadata, tasks of `split`). Raises SpecError on a version or shape mismatch."""
    batch = json.loads(Path(path).read_text(encoding="utf-8"))
    version = spec_version()
    if batch.get("spec_version") != version:
        raise SpecError(f"{path} is {batch.get('spec_version')}, this harness reads {version}")
    tasks = batch.get("tasks")
    if not isinstance(tasks, list):
        raise SpecError(f"{path} has no task list")
    for task in tasks:
        check_task(task, version)
    return batch, [t for t in tasks if split == "all" or t["split"] == split]


# ----------------------------------------------------------------------------- candidates

def oracle(task):
    """The task's own reference."""
    return lambda prompt, spec, model: task["reference"]


def wrong(task):
    """The reference with every box WRONG_BY mm wider along X: a known wrong answer."""
    reference = task["reference"]
    width = generate.fmt(task["params"]["width"])
    wider = generate.fmt(task["params"]["width"] + WRONG_BY)
    edited = reference.replace(f".box({width}, ", f".box({wider}, ")
    if edited == reference:
        raise ValueError(f"{task['id']}: could not find the width in the reference")
    return lambda prompt, spec, model: edited


MOCKS = {"oracle": oracle, "wrong": wrong}


class Reply(str):
    """Code from a model, carrying how generation ended (`meta`: done_reason, eval_count)."""

    def __new__(cls, code, meta):
        reply = super().__new__(cls, code)
        reply.meta = meta
        return reply


class OllamaCandidate:
    """A local Ollama model as a candidate: `fn(prompt, spec, model) -> Reply`."""

    def __init__(self, url=OLLAMA_URL, temperature=0.0, num_ctx=DEFAULT_NUM_CTX,
                 num_predict=DEFAULT_NUM_PREDICT, think=False, timeout=DEFAULT_TIMEOUT_S):
        self.url, self.timeout = url, timeout
        self.settings = {"endpoint": "/api/generate", "think": think,
                         "temperature": temperature, "num_ctx": num_ctx,
                         "num_predict": num_predict}

    def __call__(self, prompt, spec, model):
        s = self.settings
        body = json.dumps({
            "model": model, "prompt": build_prompt(prompt, spec), "stream": False,
            "think": s["think"],
            "options": {"temperature": s["temperature"], "num_ctx": s["num_ctx"],
                        "num_predict": s["num_predict"]},
        }).encode("utf-8")
        request = urllib.request.Request(
            self.url, data=body, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                reply = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            detail = err.read().decode("utf-8", "replace").strip()[:200]
            raise OllamaError(f"ollama answered HTTP {err.code}: {detail}") from err
        except (OSError, ValueError) as err:  # URLError, timeout, bad JSON
            raise OllamaError(f"ollama request failed: {err}") from err
        if not isinstance(reply, dict) or not isinstance(reply.get("response"), str):
            error = reply.get("error") if isinstance(reply, dict) else None
            raise OllamaError(f"ollama returned no completion: {error or 'unexpected reply'}")
        return Reply(extract_code(reply["response"]),
                     {"done_reason": reply.get("done_reason"),
                      "eval_count": reply.get("eval_count")})


def ollama_has(model: str, url: str = OLLAMA_URL, timeout: float = 10.0) -> bool:
    """True when the local Ollama lists `model` (GET /api/tags). Raises OllamaError if down."""
    tags = url.rsplit("/api/", 1)[0] + "/api/tags"
    try:
        with urllib.request.urlopen(tags, timeout=timeout) as response:
            listed = json.loads(response.read().decode("utf-8")).get("models", [])
    except (OSError, ValueError) as err:
        raise OllamaError(f"ollama is not reachable at {tags}: {err}") from err
    names = {m.get("name") for m in listed} | {m.get("model") for m in listed}
    return model in names or f"{model}:latest" in names


# ----------------------------------------------------------------------------- run

def attempt(task: dict, model: str, candidate) -> dict:
    """One candidate solution for `task`, scored by probe.score."""
    started = time.monotonic()
    try:
        code = candidate(task["prompt"], task["spec"], model)
    except OllamaError as err:
        return {"outcome": NOT_RUN, "error": str(err), "code": None, "verdicts": [],
                "no_code": False, "truncated": False, "meta": None,
                "seconds": round(time.monotonic() - started, 1)}
    meta = getattr(code, "meta", None)
    truncated = bool(meta) and meta.get("done_reason") == "length"
    code = str(code)
    if not code.strip():
        ended = f" (done_reason {meta.get('done_reason')})" if meta else ""
        return {"outcome": FAILED, "error": f"no code: the model returned no code{ended}",
                "code": code, "verdicts": [], "no_code": True, "truncated": truncated,
                "meta": meta, "seconds": round(time.monotonic() - started, 1)}
    result = score(TaskPacket.from_dict(to_packet(task, code)), code)
    if result["solved"]:
        outcome = SOLVED
    elif result["error"] is not None:
        outcome = UNJUDGED
    else:
        outcome = FAILED
    return {"outcome": outcome, "error": result["error"], "code": code,
            "verdicts": result["verdicts"], "no_code": False, "truncated": truncated,
            "meta": meta, "seconds": round(time.monotonic() - started, 1)}


def run(tasks: list, model: str, candidate_for, rollouts: int = 1, progress=None) -> dict:
    """Benchmark `tasks`. `candidate_for(task)` returns a rollout_fn for that task."""
    if rollouts < 1:
        raise ValueError("rollouts must be at least 1")
    per_task = []
    modes = set()
    for i, task in enumerate(tasks, 1):
        candidate = candidate_for(task)
        attempts = [attempt(task, model, candidate) for _ in range(rollouts)]
        for a in attempts:
            modes.update(v["check"] for v in a["verdicts"])
        counts = {k: sum(a["outcome"] == k for a in attempts)
                  for k in (SOLVED, FAILED, UNJUDGED, NOT_RUN)}
        row = {"id": task["id"], "family": task["family"], "attempts": attempts, **counts}
        per_task.append(row)
        if progress:
            progress(i, len(tasks), row)

    totals = {k: sum(r[k] for r in per_task) for k in (SOLVED, FAILED, UNJUDGED, NOT_RUN)}
    totals["no_code"] = sum(a["no_code"] for r in per_task for a in r["attempts"])
    totals["truncated"] = sum(a["truncated"] for r in per_task for a in r["attempts"])
    judged = totals[SOLVED] + totals[FAILED] + totals[UNJUDGED]
    families = {}
    for row in per_task:
        f = families.setdefault(row["family"], {SOLVED: 0, "attempted": 0})
        f[SOLVED] += row[SOLVED]
        f["attempted"] += row[SOLVED] + row[FAILED] + row[UNJUDGED]
    for f in families.values():
        f["solve_rate"] = f[SOLVED] / f["attempted"] if f["attempted"] else None
    if "geometry_cad" in modes:
        mode = "executed"
    elif modes:
        mode = "static"
    else:
        mode = "none"
    return {
        "solve_rate": totals[SOLVED] / judged if judged else None,
        "unjudged_rate": totals[UNJUDGED] / judged if judged else None,
        "totals": totals,
        "attempted": judged,
        "tasks": len(per_task),
        "rollouts": rollouts,
        "scoring": mode,
        "by_family": families,
        "per_task": per_task,
    }


def _shown(path: Path) -> str:
    """A path relative to the repo when it is inside it, so reports carry no local paths."""
    try:
        return Path(path).resolve().relative_to(generate.MODEL_DIR.parent).as_posix()
    except ValueError:
        return Path(path).name


def _first_problem(attempt_: dict) -> str:
    if attempt_["outcome"] == NOT_RUN or attempt_["error"]:
        return attempt_["error"] or ""
    bad = [v["detail"] for v in attempt_["verdicts"] if v["status"] != "pass"]
    return bad[0] if bad else ""


def render(report: dict) -> str:
    pct = lambda x: "n/a" if x is None else f"{100 * x:.0f} %"  # noqa: E731
    t = report["totals"]
    lines = [
        f"cad-spec benchmark  {report['spec_version']}  {report['data']}",
        f"candidate {report['candidate']}  split {report['split']}  "
        f"{report['tasks']} tasks x {report['rollouts']} rollout(s)  scoring {report['scoring']}",
        "",
        f"Solve rate: {t[SOLVED]}/{report['attempted']} = {pct(report['solve_rate'])}   "
        f"(failed {t[FAILED]}, of which no code {t['no_code']}; unjudged {t[UNJUDGED]} = "
        f"{pct(report['unjudged_rate'])}; not run {t[NOT_RUN]}; "
        f"cut off at num_predict {t['truncated']})",
        ("generation " + json.dumps(report["generation"], sort_keys=True))
        if report.get("generation") else "generation: n/a (mock candidate)",
        "",
        "By family                solved  not scored by the verifier",
    ]
    for family, f in sorted(report["by_family"].items()):
        lines.append(f"  {family:<10} {f[SOLVED]:>3}/{f['attempted']:<3} {pct(f['solve_rate']):>6}"
                     f"   {NOT_SCORED.get(family, '')}")
    lines += ["", "Per task"]
    for row in report["per_task"]:
        outcomes = " ".join(a["outcome"] + ("*" if a["truncated"] else "")
                            for a in row["attempts"])
        problem = next((_first_problem(a) for a in row["attempts"]
                        if a["outcome"] != SOLVED), "")
        lines.append(f"  {row['id']:<13} {outcomes:<10} {problem[:110]}")
    lines += ["", "* the answer was cut off at num_predict (done_reason length).",
              "Solved covers overall size, hole diameter and hole count only "
              "(model/SPEC.md, 'Solved')."]
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--data", type=Path, default=DEFAULT_DATA)
    ap.add_argument("--split", default="heldout", choices=("heldout", "train", "all"))
    ap.add_argument("--limit", type=int, default=None, help="first N tasks of the split")
    ap.add_argument("--model", default=DEFAULT_MODEL,
                    help="Ollama model (default $OLLAMA_MODEL or qwen3.5:9b-q4_K_M)")
    ap.add_argument("--mock", choices=sorted(MOCKS), default=None,
                    help="score a mock candidate instead of a model")
    ap.add_argument("--rollouts", type=int, default=1,
                    help="attempts per task; at temperature 0 they repeat the same answer")
    ap.add_argument("--temperature", type=float, default=0.0)
    ap.add_argument("--num-ctx", type=int, default=DEFAULT_NUM_CTX,
                    help="default $OLLAMA_NUM_CTX or 16384")
    ap.add_argument("--num-predict", type=int, default=DEFAULT_NUM_PREDICT,
                    help="default $OLLAMA_NUM_PREDICT or 2048")
    ap.add_argument("--out", type=Path, default=None, help="write the JSON report here")
    args = ap.parse_args(argv)

    try:
        batch, tasks = load_tasks(args.data, args.split)
    except (OSError, ValueError) as err:  # SpecError and JSON errors are ValueErrors
        print(f"error: {err}", file=sys.stderr)
        return 2
    if args.limit is not None:
        tasks = tasks[:args.limit]
    if not tasks:
        print(f"error: no {args.split} tasks in {args.data}", file=sys.stderr)
        return 2

    generation = None
    if args.mock:
        candidate_for, label = MOCKS[args.mock], f"mock:{args.mock}"
    else:
        try:
            if not ollama_has(args.model):
                print(f"error: ollama does not list model {args.model!r}", file=sys.stderr)
                return 2
        except OllamaError as err:
            print(f"error: {err}", file=sys.stderr)
            return 1
        candidate = OllamaCandidate(temperature=args.temperature, num_ctx=args.num_ctx,
                                    num_predict=args.num_predict)
        generation = candidate.settings
        candidate_for, label = (lambda task: candidate), f"ollama:{args.model}"

    def progress(i, n, row):
        outcomes = " ".join(a["outcome"] for a in row["attempts"])
        secs = sum(a["seconds"] for a in row["attempts"])
        print(f"[{i}/{n}] {row['id']}: {outcomes} ({secs:.0f} s)", file=sys.stderr, flush=True)

    report = run(tasks, args.model, candidate_for, args.rollouts, progress)
    report.update({
        "spec_version": batch["spec_version"],
        "extract_version": batch.get("generator", {}).get("extract_version"),
        "data": _shown(args.data),
        "split": args.split,
        "candidate": label,
        "model": None if args.mock else args.model,
        "generation": generation,
        "not_scored": {f: NOT_SCORED.get(f) for f in report["by_family"]},
    })
    print(render(report))
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n",
                            encoding="utf-8", newline="\n")
    return 1 if report["totals"][NOT_RUN] else 0


if __name__ == "__main__":
    sys.exit(main())
