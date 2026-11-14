"""Synthetic cad-spec task generator (M5).

    python model/generate.py                         # 100 tasks, seed 0
    python model/generate.py --count 200 --seed 7 --out model/data/my-batch.json
    python model/generate.py --check                 # also score every reference with M8

Writes a batch of templated CAD tasks in the cad-spec format (model/SPEC.md): a prompt, a
spec, a CadQuery reference that satisfies it, and the rubric the Verifier Pack scores
against. Five families: plates with hole patterns, open-top boxes, L-brackets with holes in
the base, plates with rectangular cutouts, and plates with rounded corners. Dimensions, hole
counts, hole sizes and hole patterns vary.

The same seed gives a byte-identical file: one random.Random(seed) drives every choice,
requirement ids are derived from the task id, keys are sorted, there are no timestamps.

The split (train / heldout) is assigned here, stratified per family, and stored in each
task. No two tasks share a family and parameter set, so a held-out task never duplicates a
training task.

Every task is self-checked as it is made: the requirements extraction finds must be exactly
the overall size plus the hole diameter and count, with the generator's values. --check
additionally scores every reference with the M8 Verifier Pack (verify/probe score()) and
fails the run if one is not solved; set GAUGE_CAD_PYTHON to an interpreter with cadquery
so box sizes are measured on the executed solid. The generator itself is standard library
only.
"""
import argparse
import itertools
import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cadspec import (MODEL_DIR, SpecError, check_task, spec_version,  # noqa: E402
                     to_packet, use_verify)

use_verify()
from lint.extract import VERSION as EXTRACT_VERSION, extract  # noqa: E402

GENERATOR = "gauge-synth-1"
FAMILIES = ("plate", "box", "bracket", "cutout", "rounded")
DEFAULT_COUNT = 100
DEFAULT_SEED = 0
HELDOUT_FRACTION = 0.2
DATA_DIR = MODEL_DIR / "data"

HOLE_SIZES = (3, 4, 5, 6, 8, 10)
EDGE = 3  # minimum material between a hole and an edge, fillet or wall, mm


def fmt(x) -> str:
    """A length as written in prompts and code: 12, 2.5."""
    x = round(float(x), 3)
    return str(int(x)) if x == int(x) else f"{x:g}"


def _step(rng, lo, hi, step=1):
    return rng.randrange(lo, hi + 1, step)


# ------------------------------------------------------------------------- hole patterns
#
# A pattern is placed in a rectangle of usable width x depth (already inset from edges,
# fillets and walls). Each returns (params, the CadQuery point call, the spec phrase), or
# None when it does not fit. The point calls are the ones the M8 static reader can count.

def _corners(rng, w, d, dia):
    px, py = w - dia - 2 * EDGE, d - dia - 2 * EDGE
    px, py = int(px) - int(px) % 2, int(py) - int(py) % 2
    if px < dia + EDGE or py < dia + EDGE:
        return None
    return ({"pattern": "corners", "holes": 4, "pitch_x": px, "pitch_y": py},
            f".rect({fmt(px)}, {fmt(py)}, forConstruction=True).vertices()",
            f"one at each corner of a {fmt(px)} mm by {fmt(py)} mm rectangle centred on the part")


def _row(rng, w, d, dia):
    n = rng.choice((2, 3, 4))
    span = int(w - dia - 2 * EDGE)
    pitch = span // (n - 1)
    if pitch < dia + EDGE:
        return None
    return ({"pattern": "row", "holes": n, "pitch_x": pitch},
            f".rarray({fmt(pitch)}, 1, {n}, 1)",
            f"in a row along the width, {fmt(pitch)} mm apart, centred on the part")


def _grid(rng, w, d, dia):
    px = int((w - dia - 2 * EDGE) // 2)
    py = int(d - dia - 2 * EDGE)
    if px < dia + EDGE or py < dia + EDGE:
        return None
    return ({"pattern": "grid", "holes": 6, "pitch_x": px, "pitch_y": py},
            f".rarray({fmt(px)}, {fmt(py)}, 3, 2)",
            f"in 2 rows of 3, {fmt(px)} mm apart along the width and {fmt(py)} mm apart "
            "along the depth, centred on the part")


def _circle(rng, w, d, dia):
    n = rng.choice((3, 4, 5, 6, 8))
    radius = int((min(w, d) - dia) / 2 - EDGE)
    if radius < dia * 1.5 or 2 * radius * 3.14159 / n < dia + EDGE:
        return None
    return ({"pattern": "circle", "holes": n, "circle_d": 2 * radius},
            f".polarArray({fmt(radius)}, 0, 360, {n})",
            f"equally spaced on a {fmt(2 * radius)} mm circle centred on the part")


def _centre(rng, w, d, dia):
    if min(w, d) < dia + 2 * EDGE:
        return None
    return ({"pattern": "centre", "holes": 1}, "", "at the centre of the part")


PATTERNS = {"corners": _corners, "row": _row, "grid": _grid, "circle": _circle,
            "centre": _centre}


class _NoFit(Exception):
    """The drawn part has no room for a hole pattern; draw the part again."""


def _holes(rng, w, d, choices):
    """Pick a hole size and a pattern that fits a w x d area; raise _NoFit if none fits."""
    for _ in range(20):
        dia = rng.choice(HOLE_SIZES)
        made = PATTERNS[rng.choice(choices)](rng, w, d, dia)
        if made:
            params, points, where = made
            return dict(params, hole_d=dia), points, where
    raise _NoFit


def _hole_count_phrase(n, dia):
    return f"{n} hole{'s' if n != 1 else ''} of {fmt(dia)} mm diameter"


# ------------------------------------------------------------------------------ families
#
# Each family returns (params, prompt, spec, reference). Overall size is always width (X)
# x depth (Y) x height (Z), stated as a triple in the prompt and restated in the spec.

def _size(w, d, h):
    return f"{fmt(w)} x {fmt(d)} x {fmt(h)} mm"


def _size_spec(w, d, h):
    return f"{fmt(w)} mm wide, {fmt(d)} mm deep, {fmt(h)} mm tall"


def plate(rng):
    w = _step(rng, 40, 160, 5)
    d = _step(rng, 30, w, 5)
    h = rng.choice((3, 4, 5, 6, 8, 10, 12))
    params, points, where = _holes(rng, w, d, tuple(PATTERNS))
    n, dia = params["holes"], params["hole_d"]
    params = dict(params, width=w, depth=d, height=h)
    prompt = f"Model a rectangular mounting plate {_size(w, d, h)} with {_hole_count_phrase(n, dia)}."
    spec = (f"Plate: {_size_spec(w, d, h)}. {_hole_count_phrase(n, dia)}, through the plate, "
            f"{where}.")
    reference = (
        "import cadquery as cq\n\n"
        f"result = (\n    cq.Workplane(\"XY\")\n    .box({fmt(w)}, {fmt(d)}, {fmt(h)})\n"
        f"    .faces(\">Z\")\n    .workplane()\n"
        + (f"    {points}\n" if points else "")
        + f"    .hole({fmt(dia)})\n)\n")
    return params, prompt, spec, reference


def box(rng):
    w = _step(rng, 40, 150, 5)
    d = _step(rng, 30, w, 5)
    h = _step(rng, 15, 60, 5)
    t = rng.choice((2, 2.5, 3, 4))
    params = {"width": w, "depth": d, "height": h, "wall": t, "holes": 0}
    prompt = f"Model an open-top box {_size(w, d, h)} with {fmt(t)} mm walls"
    spec = f"Box: {_size_spec(w, d, h)}, open at the top. Walls and floor are {fmt(t)} mm."
    reference = (
        "import cadquery as cq\n\n"
        f"result = (\n    cq.Workplane(\"XY\")\n    .box({fmt(w)}, {fmt(d)}, {fmt(h)})\n"
        f"    .faces(\">Z\")\n    .shell(-{fmt(t)})\n")
    if rng.random() < 0.6:
        try:
            hp, points, where = _holes(rng, w - 2 * t, d - 2 * t, ("corners", "row", "centre"))
        except _NoFit:
            hp = None
        if hp:
            params.update(hp)
            n, dia = hp["holes"], hp["hole_d"]
            prompt += f" and {_hole_count_phrase(n, dia)} in the floor"
            spec += f" {_hole_count_phrase(n, dia)}, through the floor, {where}."
            reference += (f"    .faces(\"<Z\")\n    .workplane()\n"
                          + (f"    {points}\n" if points else "")
                          + f"    .hole({fmt(dia)})\n")
    prompt += "."
    reference += ")\n"
    return params, prompt, spec, reference


def bracket(rng):
    w = _step(rng, 30, 120, 5)
    d = _step(rng, 30, 80, 5)
    h = _step(rng, 25, 80, 5)
    t = rng.choice((3, 4, 5, 6, 8))
    # Holes go in the base, clear of the upright: usable depth runs from the front edge
    # to the upright's inner face, centred at y = -t/2.
    usable_d = d - t
    hp, _, where = _holes(rng, w, usable_d, ("row", "corners", "centre"))
    n, dia = hp["holes"], hp["hole_d"]
    yc = -t / 2
    if hp["pattern"] == "centre":
        pts = [(0, yc)]
    elif hp["pattern"] == "row":
        x0 = -hp["pitch_x"] * (n - 1) / 2
        pts = [(x0 + i * hp["pitch_x"], yc) for i in range(n)]
    else:  # corners
        px, py = hp["pitch_x"] / 2, hp["pitch_y"] / 2
        pts = [(-px, yc - py), (px, yc - py), (-px, yc + py), (px, yc + py)]
    where = where.replace("centred on the part", "centred on the base in front of the upright")
    where = where.replace("at the centre of the part",
                          "at the centre of the base in front of the upright")
    params = dict(hp, width=w, depth=d, height=h, plate=t)
    prompt = (f"Model an L-bracket {_size(w, d, h)} overall with "
              f"{_hole_count_phrase(n, dia)} in the base.")
    spec = (f"L-bracket: overall {_size_spec(w, d, h)}. A horizontal base and a vertical "
            f"upright along the back edge, both made of {fmt(t)} mm plate. "
            f"{_hole_count_phrase(n, dia)}, through the base, {where}.")
    point_list = ", ".join(f"({fmt(x)}, {fmt(y)})" for x, y in pts)
    reference = (
        "import cadquery as cq\n\n"
        f"base = (\n    cq.Workplane(\"XY\")\n"
        f"    .box({fmt(w)}, {fmt(d)}, {fmt(t)}, centered=(True, True, False))\n"
        f"    .faces(\">Z\")\n    .workplane()\n"
        f"    .pushPoints([{point_list}])\n    .hole({fmt(dia)})\n)\n"
        f"upright = (\n    cq.Workplane(\"XY\")\n    .center(0, {fmt(d / 2 - t / 2)})\n"
        f"    .box({fmt(w)}, {fmt(t)}, {fmt(h)}, centered=(True, True, False))\n)\n"
        "result = base.union(upright)\n")
    return params, prompt, spec, reference


def cutout(rng):
    w = _step(rng, 50, 160, 5)
    d = _step(rng, 40, w, 5)
    h = rng.choice((3, 4, 5, 6, 8, 10))
    cw = _step(rng, 10, int(w * 0.6), 2)
    ch = _step(rng, 8, int(d * 0.6), 2)
    params = {"width": w, "depth": d, "height": h, "cutout_w": cw, "cutout_d": ch,
              "holes": 0}
    prompt = f"Model a plate {_size(w, d, h)} with a rectangular cutout through its centre."
    spec = (f"Plate: {_size_spec(w, d, h)}. A rectangular through cutout {fmt(cw)} mm by "
            f"{fmt(ch)} mm, its long sides parallel to the plate's "
            f"{'width' if cw >= ch else 'depth'}, centred on the plate.")
    reference = (
        "import cadquery as cq\n\n"
        f"result = (\n    cq.Workplane(\"XY\")\n    .box({fmt(w)}, {fmt(d)}, {fmt(h)})\n"
        f"    .faces(\">Z\")\n    .workplane()\n    .rect({fmt(cw)}, {fmt(ch)})\n"
        "    .cutThruAll()\n)\n")
    return params, prompt, spec, reference


def rounded(rng):
    w = _step(rng, 50, 160, 5)
    d = _step(rng, 40, w, 5)
    h = rng.choice((4, 5, 6, 8, 10, 12))
    r = rng.choice((2, 3, 4, 5, 6, 8))
    # Keep holes clear of the fillets.
    hp, points, where = _holes(rng, w - 2 * r, d - 2 * r, ("corners", "circle", "centre"))
    n, dia = hp["holes"], hp["hole_d"]
    params = dict(hp, width=w, depth=d, height=h, fillet=r)
    prompt = (f"Model a plate {_size(w, d, h)} with rounded corners and "
              f"{_hole_count_phrase(n, dia)}.")
    spec = (f"Plate: {_size_spec(w, d, h)}. The four vertical edges are rounded with a "
            f"{fmt(r)} mm fillet. {_hole_count_phrase(n, dia)}, through the plate, {where}.")
    reference = (
        "import cadquery as cq\n\n"
        f"result = (\n    cq.Workplane(\"XY\")\n    .box({fmt(w)}, {fmt(d)}, {fmt(h)})\n"
        f"    .edges(\"|Z\")\n    .fillet({fmt(r)})\n"
        f"    .faces(\">Z\")\n    .workplane()\n"
        + (f"    {points}\n" if points else "")
        + f"    .hole({fmt(dia)})\n)\n")
    return params, prompt, spec, reference


BUILDERS = {"plate": plate, "box": box, "bracket": bracket, "cutout": cutout,
            "rounded": rounded}


# ------------------------------------------------------------------------------ rubric

def rubric(task_id: str, prompt: str, spec: str) -> dict:
    """extract() on the task text, arranged into packet rows like the API's packet builder."""
    counter = itertools.count(1)
    extraction = extract(prompt, spec, new_id=lambda: f"{task_id}-{next(counter)}")
    items = []
    for item in extraction["rubric_items"]:
        base = {"criterion": item["criterion"], "text": item["text"],
                "check_method": item["check_method"], "weight": item["weight"]}
        if item["check_method"] == "machine":
            items.extend(dict(base, id=f"{item['id']}:{rid}", requirement_id=rid)
                         for rid in item["requirement_ids"])
        else:
            items.append(dict(base, id=item["id"], requirement_id=None))
    return {"extract_version": extraction["version"],
            "requirements": extraction["requirements"], "rubric_items": items}


def _number(value: str) -> float:
    return float(str(value).split()[0])


def expected_machine(params: dict) -> dict:
    """The machine-checked quantities a task must have: overall size, hole size and count."""
    want = {"width": params["width"], "depth": params["depth"], "height": params["height"]}
    if params.get("holes"):
        want["hole diameter"] = params["hole_d"]
        want["hole count"] = params["holes"]
    return {k: float(v) for k, v in want.items()}


def self_check(task: dict) -> None:
    """Raise SpecError unless extraction read exactly the generator's machine quantities."""
    got = {}
    for r in task["rubric"]["requirements"]:
        if r["check_method"] != "machine":
            continue
        label = "hole diameter" if r["label"] in ("diameter", "hole diameter") else r["label"]
        if label in got:
            raise SpecError(f"{task['id']}: {label} extracted twice")
        got[label] = _number(r["value"])
    want = expected_machine(task["params"])
    if got != want:
        raise SpecError(f"{task['id']}: extraction read {got}, generator meant {want}")


# ------------------------------------------------------------------------------ batch

def generate(count: int = DEFAULT_COUNT, seed: int = DEFAULT_SEED,
             heldout: float = HELDOUT_FRACTION) -> dict:
    """A batch of `count` tasks, round-robin over the families, split per family."""
    if count < 1:
        raise ValueError("count must be at least 1")
    if not 0 <= heldout < 1:
        raise ValueError("heldout fraction must be in [0, 1)")
    rng = random.Random(seed)
    version = spec_version()
    seen = set()
    per_family = {f: [] for f in FAMILIES}
    for i in range(count):
        family = FAMILIES[i % len(FAMILIES)]
        for _ in range(200):
            try:
                params, prompt, spec, reference = BUILDERS[family](rng)
            except _NoFit:
                continue
            key = (family, json.dumps(params, sort_keys=True))
            if key not in seen:
                seen.add(key)
                break
        else:
            raise RuntimeError(f"could not draw a new {family} task; the family is exhausted")
        task_id = f"{family}-{len(per_family[family]) + 1:03d}"
        task = {"id": task_id, "spec_version": version, "family": family, "split": "train",
                "prompt": prompt, "spec": spec, "reference": reference,
                "rubric": rubric(task_id, prompt, spec), "params": params}
        self_check(task)
        per_family[family].append(task)

    for tasks in per_family.values():  # stratified split, drawn from the same rng
        k = round(len(tasks) * heldout)
        for task in rng.sample(tasks, k):
            task["split"] = "heldout"

    tasks = [t for i in range(count) for t in
             [per_family[FAMILIES[i % len(FAMILIES)]][i // len(FAMILIES)]]]
    for task in tasks:
        check_task(task, version)
    return {
        "spec_version": version,
        "generator": {"name": GENERATOR, "seed": seed, "heldout_fraction": heldout,
                      "extract_version": EXTRACT_VERSION},
        "count": len(tasks),
        "tasks": tasks,
    }


def write(batch: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(batch, fh, indent=2, sort_keys=True, ensure_ascii=False)
        fh.write("\n")


def verify_references(batch: dict, out=sys.stdout) -> int:
    """Score every reference against its own rubric with M8; return how many are not solved."""
    from lint.packet import TaskPacket
    from probe.probe import score

    bad = 0
    modes = set()
    for task in batch["tasks"]:
        result = score(TaskPacket.from_dict(to_packet(task)), task["reference"])
        modes.update(v["check"] for v in result["verdicts"])
        if not result["solved"]:
            bad += 1
            why = result["error"] or "; ".join(
                v["detail"] for v in result["verdicts"] if v["status"] != "pass")
            print(f"  NOT SOLVED {task['id']}: {why}", file=out)
    mode = "executed" if "geometry_cad" in modes else "static (no cadquery: box sizes read from code)"
    print(f"reference check: {len(batch['tasks']) - bad}/{len(batch['tasks'])} solved, "
          f"scoring {mode}", file=out)
    return bad


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--count", type=int, default=DEFAULT_COUNT)
    ap.add_argument("--seed", type=int, default=DEFAULT_SEED)
    ap.add_argument("--heldout", type=float, default=HELDOUT_FRACTION,
                    help="fraction of each family held out (default 0.2)")
    ap.add_argument("--out", type=Path, default=None,
                    help="output file (default model/data/synthetic-seed<SEED>-n<COUNT>.json)")
    ap.add_argument("--check", action="store_true",
                    help="score every reference with the M8 Verifier Pack; exit 1 if one fails")
    args = ap.parse_args(argv)
    try:
        batch = generate(args.count, args.seed, args.heldout)
    except (ValueError, SpecError, RuntimeError) as err:
        print(f"error: {err}", file=sys.stderr)
        return 2
    out = args.out or DATA_DIR / f"synthetic-seed{args.seed}-n{args.count}.json"
    write(batch, out)
    held = sum(t["split"] == "heldout" for t in batch["tasks"])
    print(f"wrote {batch['count']} {batch['spec_version']} tasks ({held} held out) to {out}")
    if args.check and verify_references(batch):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
