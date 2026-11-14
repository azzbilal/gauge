"""Held-out benchmark harness (M5).

    python model/benchmark.py                                   # OLLAMA_MODEL on the held-out split
    python model/benchmark.py --model qwen3.5:9b-q4_K_M --limit 5 --out report.json
    python model/benchmark.py --mock oracle                     # the reference: must be 100 %
    python model/benchmark.py --mock wrong                      # 7 mm too wide: must be 0 %
    python model/benchmark.py --fewshot 5                       # 5 worked train examples first
    python model/benchmark.py --data model/data/heldout-seed1-n300.json --fewshot 5 \
        --train-data model/data/synthetic-seed0-n100.json       # examples from another batch
    python model/benchmark.py --compare base.json fewshot.json  # paired: exact McNemar

For every held-out task of a cad-spec batch (model/SPEC.md) it asks a candidate for a
CadQuery solution from the task's prompt and spec (never its reference; with --fewshot,
also worked examples from the train split), scores it with the M8 Verifier Pack
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
OllamaCandidate (local Ollama) by default, or a mock. OllamaCandidate builds the prompt with the
probe's own build_prompt (fewshot_prompt adds examples), reads the code with extract_code,
and sends what the API's intake provider sends (apps/api/src/intake/llm/ollama.provider.ts): think off, temperature,
num_ctx and num_predict. Without `think: false` a thinking model such as qwen3.5 spends the
whole budget reasoning and returns an empty answer. An attempt whose reply holds no code is
`failed`, labelled "no code" and counted in the headline.

--fewshot K places K worked examples (prompt, spec, reference) from the train split before
the task (select_examples, fewshot_prompt): in-context examples, no weights change. With
K=0 the prompt is probe's build_prompt unchanged.

Generated code is EXECUTED by the
verifier in a worker process with a timeout; set GAUGE_CAD_PYTHON to an interpreter with
cadquery so sizes are measured on the solid, or GAUGE_CAD_EXEC=0 to read code statically.
Standard library only.
"""
import argparse
import json
import math
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
from probe.probe import (DEFAULT_NUM_CTX, DEFAULT_NUM_PREDICT,  # noqa: E402
                         DEFAULT_TIMEOUT_S, OLLAMA_URL, OllamaError, build_prompt,
                         extract_code, generation_body, score)

import generate  # noqa: E402  (data paths, and fmt() for the wrong mock)

SOLVED, FAILED, UNJUDGED, NOT_RUN = "solved", "failed", "unjudged", "not_run"
DEFAULT_DATA = generate.DATA_DIR / (
    f"synthetic-seed{generate.DEFAULT_SEED}-n{generate.DEFAULT_COUNT}.json")
DEFAULT_MODEL = os.environ.get("OLLAMA_MODEL", "").strip() or "qwen3.5:9b-q4_K_M"
WRONG_BY = 7  # mm the `wrong` mock adds to the width

# What a solved verdict does not look at, per family (model/SPEC.md, "Solved").
NOT_SCORED = {
    "plate": "hole positions",
    "box": "wall thickness, open top, hole positions",
    "bracket": "plate thickness, upright position, hole positions",
    "cutout": "the cutout (size and presence)",
    "rounded": "fillet radius (and presence), hole positions",
}


# ----------------------------------------------------------------------------- statistics

Z95 = 1.959963984540054  # two-sided 95 %


def wilson(k: int, n: int, z: float = Z95):
    """Wilson score interval for k successes in n trials, or None when n is 0."""
    if n <= 0:
        return None
    p = k / n
    centre = (p + z * z / (2 * n)) / (1 + z * z / n)
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return [max(0.0, centre - half), min(1.0, centre + half)]


def mcnemar_exact(b: int, c: int) -> float:
    """Two-sided exact McNemar p-value: the discordant pairs b and c against Binomial(b+c, 1/2)."""
    n = b + c
    if n == 0:
        return 1.0
    tail = sum(math.comb(n, i) for i in range(min(b, c) + 1)) / 2 ** n
    return min(1.0, 2 * tail)


def paired_diff_ci(a: int, b: int, c: int, d: int, z: float = Z95):
    """95 % interval for p2 - p1 from a paired 2x2 table (Newcombe 1998, method 10).

    a: both solved, b: only the first, c: only the second, d: neither. p1 = (a+b)/n,
    p2 = (a+c)/n. Returns None when n is 0."""
    n = a + b + c + d
    if n == 0:
        return None
    p1, p2 = (a + b) / n, (a + c) / n
    l1, u1 = wilson(a + b, n, z)
    l2, u2 = wilson(a + c, n, z)
    denom = (a + b) * (c + d) * (a + c) * (b + d)
    # Newcombe's phi: the numerator shrinks by n/2 (floored at 0) when ad > bc.
    num = max(a * d - b * c - n / 2, 0.0) if a * d > b * c else a * d - b * c
    phi = num / math.sqrt(denom) if denom else 0.0
    delta = p2 - p1
    lower = delta - math.sqrt(max(0.0, (p2 - l2) ** 2 - 2 * phi * (p2 - l2) * (u1 - p1)
                                  + (u1 - p1) ** 2))
    upper = delta + math.sqrt(max(0.0, (u2 - p2) ** 2 - 2 * phi * (u2 - p2) * (p1 - l1)
                                  + (p1 - l1) ** 2))
    return [max(-1.0, lower), min(1.0, upper)]


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


# ----------------------------------------------------------------------------- few-shot

def select_examples(train: list, k: int, exclude_ids=()) -> list:
    """`k` worked examples from the train split, chosen by a fixed rule.

    Round-robin over generate.FAMILIES, taking each family's train tasks in file order, so
    k=5 is the first train task of every family. The rule looks at nothing but the split,
    the family and the order: no held-out task, score or answer goes into the choice.
    Tasks in `exclude_ids` (the evaluated set) are never examples. Raises SpecError if a
    task is not train, or if fewer than k remain."""
    if k < 0:
        raise ValueError("k must not be negative")
    for task in train:
        if task["split"] != "train":
            raise SpecError(f"{task['id']} is {task['split']}, few-shot examples must be train")
    excluded = set(exclude_ids)
    train = [t for t in train if t["id"] not in excluded]
    queues = {f: [t for t in train if t["family"] == f] for f in generate.FAMILIES}
    picked = []
    while len(picked) < k and any(queues.values()):
        for family in generate.FAMILIES:
            if queues[family] and len(picked) < k:
                picked.append(queues[family].pop(0))
    if len(picked) < k:
        raise SpecError(f"asked for {k} few-shot examples, the train split has {len(picked)}")
    return picked


def fewshot_prompt(prompt: str, spec: str, examples=()) -> str:
    """probe's build_prompt with worked examples (task, spec, reference) before the task.

    With no examples it is build_prompt(prompt, spec), byte for byte."""
    base = build_prompt(prompt, spec)
    if not examples:
        return base
    head, _, tail = base.partition("\n\n")  # the instructions, then the task and spec
    shots = ["Worked examples of correct solutions follow. They use only real CadQuery "
             "methods; write your solution the same way."]
    for i, ex in enumerate(examples, 1):
        shots.append(f"Example {i}\nTask:\n{ex['prompt'].strip()}\nSpec:\n{ex['spec'].strip()}"
                     f"\nSolution:\n```python\n{ex['reference'].strip()}\n```")
    shots.append("Now solve this task.")
    return "\n\n".join([head, *shots, tail])


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
                 num_predict=DEFAULT_NUM_PREDICT, think=False, timeout=DEFAULT_TIMEOUT_S,
                 examples=()):
        self.url, self.timeout = url, timeout
        self.examples = list(examples)
        self.settings = {"endpoint": "/api/generate", "think": think,
                         "temperature": temperature, "num_ctx": num_ctx,
                         "num_predict": num_predict}
        if self.examples:
            self.settings["fewshot"] = {"k": len(self.examples),
                                        "example_ids": [e["id"] for e in self.examples]}

    def __call__(self, prompt, spec, model):
        s = self.settings
        body = json.dumps(generation_body(
            model, fewshot_prompt(prompt, spec, self.examples), think=s["think"],
            temperature=s["temperature"], num_ctx=s["num_ctx"],
            num_predict=s["num_predict"])).encode("utf-8")
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
                      "eval_count": reply.get("eval_count"),
                      "prompt_eval_count": reply.get("prompt_eval_count")})


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


def _group(per_task: list, key) -> dict:
    """Solved / attempted, solve rate and its Wilson interval per key(row), sorted by key."""
    groups = {}
    for row in per_task:
        g = groups.setdefault(key(row), {SOLVED: 0, "attempted": 0})
        g[SOLVED] += row[SOLVED]
        g["attempted"] += row[SOLVED] + row[FAILED] + row[UNJUDGED]
    for g in groups.values():
        g["solve_rate"] = g[SOLVED] / g["attempted"] if g["attempted"] else None
        g["ci95"] = wilson(g[SOLVED], g["attempted"])
    return dict(sorted(groups.items()))


def run(tasks: list, model: str, candidate_for, rollouts: int = 1, progress=None,
        done=None, on_row=None) -> dict:
    """Benchmark `tasks`. `candidate_for(task)` returns a rollout_fn for that task.

    `done` maps a task id to a row already run (a resumed log): that task is not run again.
    `on_row(row)` is called with every newly run row (to append it to a log)."""
    if rollouts < 1:
        raise ValueError("rollouts must be at least 1")
    done = done or {}
    per_task = []
    modes = set()
    for i, task in enumerate(tasks, 1):
        if task["id"] in done:
            row = done[task["id"]]
        else:
            candidate = candidate_for(task)
            attempts = [attempt(task, model, candidate) for _ in range(rollouts)]
            counts = {k: sum(a["outcome"] == k for a in attempts)
                      for k in (SOLVED, FAILED, UNJUDGED, NOT_RUN)}
            row = {"id": task["id"], "family": task["family"],
                   "pattern": generate.pattern_of(task), "attempts": attempts, **counts}
            if on_row:
                on_row(row)
        for a in row["attempts"]:
            modes.update(v["check"] for v in a["verdicts"])
        per_task.append(row)
        if progress:
            progress(i, len(tasks), row)

    totals = {k: sum(r[k] for r in per_task) for k in (SOLVED, FAILED, UNJUDGED, NOT_RUN)}
    totals["no_code"] = sum(a["no_code"] for r in per_task for a in r["attempts"])
    totals["truncated"] = sum(a["truncated"] for r in per_task for a in r["attempts"])
    judged = totals[SOLVED] + totals[FAILED] + totals[UNJUDGED]
    if "geometry_cad" in modes:
        mode = "executed"
    elif modes:
        mode = "static"
    else:
        mode = "none"
    return {
        "solve_rate": totals[SOLVED] / judged if judged else None,
        "solve_rate_ci95": wilson(totals[SOLVED], judged),
        "unjudged_rate": totals[UNJUDGED] / judged if judged else None,
        "totals": totals,
        "attempted": judged,
        "tasks": len(per_task),
        "rollouts": rollouts,
        "scoring": mode,
        "by_family": _group(per_task, lambda r: r["family"]),
        "by_pattern": _group(per_task, lambda r: r["pattern"]),
        "by_stratum": _group(per_task, lambda r: f"{r['family']}/{r['pattern']}"),
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


def _pct(x) -> str:
    return "n/a" if x is None else f"{100 * x:.0f} %"


def _ci(ci) -> str:
    return "" if not ci else f"[{100 * ci[0]:.0f}-{100 * ci[1]:.0f} %]"


def render(report: dict) -> str:
    pct = _pct
    t = report["totals"]
    lines = [
        f"cad-spec benchmark  {report['spec_version']}  {report['data']}",
        f"candidate {report['candidate']}  split {report['split']}  "
        f"{report['tasks']} tasks x {report['rollouts']} rollout(s)  scoring {report['scoring']}",
        "",
        f"Solve rate: {t[SOLVED]}/{report['attempted']} = {pct(report['solve_rate'])}  "
        f"95 % Wilson {_ci(report.get('solve_rate_ci95'))}   "
        f"(failed {t[FAILED]}, of which no code {t['no_code']}; unjudged {t[UNJUDGED]} = "
        f"{pct(report['unjudged_rate'])}; not run {t[NOT_RUN]}; "
        f"cut off at num_predict {t['truncated']})",
        ("generation " + json.dumps(report["generation"], sort_keys=True))
        if report.get("generation") else "generation: n/a (mock candidate)",
        "",
        "By family                solved  95 % Wilson   not scored by the verifier",
    ]
    for family, f in sorted(report["by_family"].items()):
        lines.append(f"  {family:<10} {f[SOLVED]:>3}/{f['attempted']:<3} {pct(f['solve_rate']):>6}"
                     f"  {_ci(f.get('ci95')):<12}  {NOT_SCORED.get(family, '')}")
    for title, groups in (("By hole pattern", report.get("by_pattern")),
                          ("By stratum (family/pattern)", report.get("by_stratum"))):
        if not groups:
            continue
        lines += ["", f"{title:<24} solved  95 % Wilson"]
        for name, g in groups.items():
            lines.append(f"  {name:<20} {g[SOLVED]:>3}/{g['attempted']:<3} "
                         f"{pct(g['solve_rate']):>6}  {_ci(g.get('ci95'))}")
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


# ----------------------------------------------------------------------------- logs

def read_log(path, config: dict) -> dict:
    """{task id: row} from a progress log written with the same `config`.

    Rows with a not_run attempt (Ollama was down) are left out, so they run again."""
    if path is None:
        raise ValueError("needs --log or --out to find the progress log")
    lines = Path(path).read_text(encoding="utf-8").splitlines()
    if not lines:
        raise ValueError(f"{path} is empty")
    header = json.loads(lines[0]).get("header")
    if header != json.loads(json.dumps(config)):
        raise ValueError(f"{path} was written by another run: {header} != {config}")
    done = {}
    for line in lines[1:]:
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except ValueError:  # a line cut off by a crash: that task runs again
            continue
        if not row[NOT_RUN]:
            done[row["id"]] = row
    return done


# ----------------------------------------------------------------------------- paired

def check_disjoint(train: list, evaluated: list) -> None:
    """Raise SpecError if a train task is also an evaluated task, by family and parameters
    or by prompt and spec text."""
    keys = {generate.task_key(t["family"], t["params"]) for t in evaluated if "params" in t}
    texts = {(t["prompt"], t["spec"]) for t in evaluated}
    for t in train:
        if ("params" in t and generate.task_key(t["family"], t["params"]) in keys) \
                or (t["prompt"], t["spec"]) in texts:
            raise SpecError(f"train task {t['id']} is also in the evaluated set")


def _solved_by_id(report: dict) -> dict:
    """{task id: (solved, row)} for the judged tasks of a 1-rollout report."""
    if report.get("rollouts") != 1:
        raise ValueError(f"{report.get('candidate')}: --compare needs 1 rollout per task, "
                         f"the report has {report.get('rollouts')}")
    rows = report["per_task"]
    ids = [r["id"] for r in rows]
    if len(set(ids)) != len(ids):
        raise ValueError(f"{report.get('candidate')}: a task id appears twice")
    return {r["id"]: r for r in rows}


def _table(pairs: list) -> dict:
    """The paired 2x2 table, both rates with Wilson intervals, McNemar and the difference."""
    a = sum(x and y for x, y in pairs)
    b = sum(x and not y for x, y in pairs)
    c = sum(y and not x for x, y in pairs)
    d = sum(not x and not y for x, y in pairs)
    n = a + b + c + d
    return {
        "n": n, "both": a, "first_only": b, "second_only": c, "neither": d,
        "first_rate": (a + b) / n if n else None, "first_ci95": wilson(a + b, n),
        "second_rate": (a + c) / n if n else None, "second_ci95": wilson(a + c, n),
        "difference": (c - b) / n if n else None,
        "difference_ci95": paired_diff_ci(a, b, c, d),
        "mcnemar_exact_p": mcnemar_exact(b, c),
    }


def compare(first: dict, second: dict) -> dict:
    """Paired comparison of two benchmark reports on the same tasks.

    Same data file and task set, one rollout each. A task left not_run in either report is
    left out of every pair; unjudged counts as not solved, as in the headline. Reports
    McNemar's exact test on the discordant tasks, overall and per family and stratum (the
    per-group p-values are uncorrected for multiple comparisons)."""
    for key in ("data", "split", "spec_version"):
        if first.get(key) != second.get(key):
            raise ValueError(f"the reports differ in {key}: {first.get(key)} != {second.get(key)}")
    rows1, rows2 = _solved_by_id(first), _solved_by_id(second)
    if set(rows1) != set(rows2):
        only = sorted(set(rows1) ^ set(rows2))
        raise ValueError(f"the reports cover different tasks ({len(only)} differ, e.g. "
                         f"{', '.join(only[:5])}); run both on the same --data and --limit")
    order = [r["id"] for r in first["per_task"]]
    excluded = [i for i in order if rows1[i][NOT_RUN] or rows2[i][NOT_RUN]]
    paired = [i for i in order if i not in set(excluded)]

    def pairs(ids):
        return [(rows1[i][SOLVED] > 0, rows2[i][SOLVED] > 0) for i in ids]

    def grouped(key):
        groups = {}
        for i in paired:
            groups.setdefault(key(rows1[i]), []).append(i)
        return {name: _table(pairs(ids)) for name, ids in sorted(groups.items())}

    has_pattern = all("pattern" in rows1[i] for i in paired)
    g1, g2 = first.get("generation") or {}, second.get("generation") or {}
    differ = sorted(k for k in set(g1) | set(g2) if k != "fewshot" and g1.get(k) != g2.get(k))
    return {
        "data": first["data"], "split": first["split"], "spec_version": first["spec_version"],
        "first": first.get("candidate"), "second": second.get("candidate"),
        "scoring": [first.get("scoring"), second.get("scoring")],
        "generation_differs_in": differ,
        "excluded_not_run": excluded,
        "overall": _table(pairs(paired)),
        "by_family": grouped(lambda r: r["family"]),
        "by_stratum": grouped(lambda r: f"{r['family']}/{r['pattern']}") if has_pattern else None,
        "changed": {"second_only": [i for i in paired if not rows1[i][SOLVED] and rows2[i][SOLVED]],
                    "first_only": [i for i in paired if rows1[i][SOLVED] and not rows2[i][SOLVED]]},
    }


def render_compare(result: dict) -> str:
    o = result["overall"]

    def p_text(p):
        return f"{p:.3g}" if p >= 1e-4 else f"{p:.1e}"

    def diff(t):
        if t["difference"] is None:
            return "n/a"
        lo, hi = t["difference_ci95"]
        return f"{100 * t['difference']:+.1f} pts [{100 * lo:+.1f}, {100 * hi:+.1f}]"

    lines = [
        f"paired comparison  {result['spec_version']}  {result['data']}  split {result['split']}",
        f"first  {result['first']}",
        f"second {result['second']}",
        f"scoring {' / '.join(str(s) for s in result['scoring'])}"
        + (f"   generation also differs in: {', '.join(result['generation_differs_in'])}"
           if result["generation_differs_in"] else ""),
        "",
        f"{o['n']} paired tasks"
        + (f" ({len(result['excluded_not_run'])} left out: not run in a report)"
           if result["excluded_not_run"] else ""),
        f"  first  solved {o['both'] + o['first_only']}/{o['n']} = {_pct(o['first_rate'])}  "
        f"{_ci(o['first_ci95'])}",
        f"  second solved {o['both'] + o['second_only']}/{o['n']} = {_pct(o['second_rate'])}  "
        f"{_ci(o['second_ci95'])}",
        "",
        "                  second solved  second not",
        f"  first solved    {o['both']:>13}  {o['first_only']:>10}",
        f"  first not       {o['second_only']:>13}  {o['neither']:>10}",
        "",
        f"McNemar exact (two-sided): discordant {o['first_only']} vs {o['second_only']}, "
        f"p = {p_text(o['mcnemar_exact_p'])}",
        f"Difference second - first: {diff(o)}  (95 %, Newcombe method 10; unvalidated)",
    ]
    for title, groups in (("By family", result["by_family"]),
                          ("By stratum", result["by_stratum"])):
        if not groups:
            continue
        lines += ["", f"{title:<22}   n  first  second  1-only  2-only  McNemar p"]
        for name, t in groups.items():
            lines.append(f"  {name:<20} {t['n']:>3}  {t['both'] + t['first_only']:>5}  "
                         f"{t['both'] + t['second_only']:>6}  {t['first_only']:>6}  "
                         f"{t['second_only']:>6}  {p_text(t['mcnemar_exact_p']):>9}")
    lines += ["", "Per-group p-values are not corrected for multiple comparisons."]
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
    ap.add_argument("--fewshot", type=int, default=0, metavar="K",
                    help="prepend K worked examples from the train split (default 0: none)")
    ap.add_argument("--train-data", type=Path, default=None, metavar="BATCH",
                    help="take --fewshot examples from this batch's train split instead of "
                         "--data's; it must share no task with the evaluated set")
    ap.add_argument("--out", type=Path, default=None, help="write the JSON report here")
    ap.add_argument("--log", type=Path, default=None,
                    help="append every finished task to this JSONL file "
                         "(default with --out: <out>.progress.jsonl)")
    ap.add_argument("--resume", action="store_true",
                    help="skip tasks already in the log (same data, candidate and settings)")
    ap.add_argument("--compare", type=Path, nargs=2, metavar=("FIRST", "SECOND"),
                    help="compare two reports on the same tasks (paired, exact McNemar); "
                         "runs nothing")
    args = ap.parse_args(argv)

    if args.compare:
        try:
            first, second = (json.loads(p.read_text(encoding="utf-8")) for p in args.compare)
            result = compare(first, second)
        except (OSError, ValueError, KeyError) as err:
            print(f"error: {err}", file=sys.stderr)
            return 2
        result["reports"] = [_shown(p) for p in args.compare]
        print(render_compare(result))
        if args.out:
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n",
                                encoding="utf-8", newline="\n")
        return 0

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
    examples = []
    train_path = args.train_data or args.data
    if args.train_data and not args.fewshot:
        print("error: --train-data only supplies --fewshot examples; add --fewshot K",
              file=sys.stderr)
        return 2
    if args.fewshot:
        if args.mock:
            print("error: --fewshot needs a model, not a mock", file=sys.stderr)
            return 2
        try:
            _, train = load_tasks(train_path, "train")
            if Path(train_path).resolve() == Path(args.data).resolve():
                examples = select_examples(train, args.fewshot, {t["id"] for t in tasks})
            else:
                # Two batches reuse ids (plate-001 ...), so ids say nothing across files:
                # the batches must share no task by content, and no id is excluded.
                check_disjoint(train, tasks)
                examples = select_examples(train, args.fewshot)
        except (OSError, ValueError) as err:
            print(f"error: {err}", file=sys.stderr)
            return 2
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
                                    num_predict=args.num_predict, examples=examples)
        generation = candidate.settings
        candidate_for, label = (lambda task: candidate), f"ollama:{args.model}"

    def progress(i, n, row):
        outcomes = " ".join(a["outcome"] for a in row["attempts"])
        secs = sum(a["seconds"] for a in row["attempts"])
        print(f"[{i}/{n}] {row['id']}: {outcomes} ({secs:.0f} s)", file=sys.stderr, flush=True)

    label += f"+fewshot{len(examples)}" if examples else ""
    config = {"data": _shown(args.data), "split": args.split, "limit": args.limit,
              "candidate": label, "rollouts": args.rollouts, "generation": generation,
              "train_data": _shown(train_path) if examples else None}
    log = args.log or (args.out.with_name(args.out.name + ".progress.jsonl")
                       if args.out else None)
    try:
        done = read_log(log, config) if args.resume else {}
    except (OSError, ValueError) as err:
        print(f"error: --resume: {err}", file=sys.stderr)
        return 2
    if done:
        print(f"resuming: {len(done)} task(s) already run in {log}", file=sys.stderr)
    on_row = None
    if log:
        log.parent.mkdir(parents=True, exist_ok=True)
        if not args.resume:
            log.write_text(json.dumps({"header": config}, sort_keys=True) + "\n",
                           encoding="utf-8", newline="\n")

        def on_row(row):
            with open(log, "a", encoding="utf-8", newline="\n") as fh:
                fh.write(json.dumps(row, sort_keys=True) + "\n")

    report = run(tasks, args.model, candidate_for, args.rollouts, progress, done, on_row)
    report.update({
        "spec_version": batch["spec_version"],
        "extract_version": batch.get("generator", {}).get("extract_version"),
        "data": _shown(args.data),
        "split": args.split,
        "candidate": label,
        "model": None if args.mock else args.model,
        "generation": generation,
        "train_data": config["train_data"],
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
