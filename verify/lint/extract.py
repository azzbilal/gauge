"""Requirement extraction: the one place prose is read for numbers.

    from lint.extract import extract
    result = extract(prompt, spec)
    # {"version": ..., "requirements": [...], "rubric_items": [...]}

Everything that parses a prompt or a spec goes through the scanner in this module: the
requirements a task is stored with (`extract`, served as POST /extract), the quantities
the value_contradiction lint rule compares, and the quantities the Verifier Pack reads
back out of a requirement's text (`extract_quantities`). The API does not parse anything.

Three things are read:

    dimensions   a length with a name: "width of 60 ± 0.1 mm", "5 mm diameter holes"
    triples      "60 x 40 x 5 mm", named by axis the way the verifier maps names to axes
    hole counts  "4 holes", "four mounting holes"

A length with no name ("60 mm") is also kept as a requirement, but nothing can check it.

Bump VERSION whenever a change here can alter what is extracted from the same text.
Standard library only.
"""
import re
import uuid
from collections import namedtuple

VERSION = "extract-1"

MACHINE = "machine"
VISUAL = "visual"
MANUAL = "manual"

# ------------------------------------------------------------------------------ vocabulary

# unit -> (physical dimension, factor to that dimension's base unit). Case-sensitive on
# purpose: mV and MV, mΩ and MΩ are different units.
_UNITS = {
    "mm": ("length", 1.0), "cm": ("length", 10.0), "m": ("length", 1000.0),
    "um": ("length", 0.001), "µm": ("length", 0.001), "μm": ("length", 0.001),
    "inch": ("length", 25.4), "inches": ("length", 25.4), '"': ("length", 25.4),
    "deg": ("angle", 1.0), "degree": ("angle", 1.0), "degrees": ("angle", 1.0),
    "°": ("angle", 1.0),
    "mm3": ("volume", 1.0), "mm^3": ("volume", 1.0), "mm³": ("volume", 1.0),
    "cm3": ("volume", 1000.0), "cm^3": ("volume", 1000.0), "cm³": ("volume", 1000.0),
    "ml": ("volume", 1000.0), "mL": ("volume", 1000.0), "L": ("volume", 1e6),
    "g": ("mass", 1.0), "kg": ("mass", 1000.0),
    "ohm": ("resistance", 1.0), "ohms": ("resistance", 1.0), "Ohm": ("resistance", 1.0),
    "Ω": ("resistance", 1.0), "mΩ": ("resistance", 1e-3),
    "kohm": ("resistance", 1e3), "kΩ": ("resistance", 1e3),
    "Mohm": ("resistance", 1e6), "MΩ": ("resistance", 1e6),
    "V": ("voltage", 1.0), "mV": ("voltage", 1e-3), "kV": ("voltage", 1e3),
    "A": ("current", 1.0), "mA": ("current", 1e-3),
    "uA": ("current", 1e-6), "µA": ("current", 1e-6),
    "F": ("capacitance", 1.0), "uF": ("capacitance", 1e-6), "µF": ("capacitance", 1e-6),
    "nF": ("capacitance", 1e-9), "pF": ("capacitance", 1e-12),
    "Hz": ("frequency", 1.0), "kHz": ("frequency", 1e3), "MHz": ("frequency", 1e6),
    "W": ("power", 1.0), "mW": ("power", 1e-3),
    "%": ("percent", 1.0),
}

# Quantity nouns ("width of 40 mm") and their canonical names.
_NOUNS = {
    "width": "width", "length": "length", "height": "height", "depth": "depth",
    "thickness": "thickness", "diameter": "diameter", "dia": "diameter",
    "radius": "radius", "volume": "volume", "mass": "mass", "weight": "mass",
    "angle": "angle", "pitch": "pitch", "spacing": "spacing", "clearance": "clearance",
    "resistance": "resistance", "voltage": "voltage", "current": "current",
    "capacitance": "capacitance", "frequency": "frequency",
}

# Trailing forms ("40 mm wide", "5 mm diameter").
_ADJECTIVES = {
    "wide": "width", "long": "length", "tall": "height", "high": "height",
    "deep": "depth", "thick": "thickness", "width": "width", "length": "length",
    "height": "height", "depth": "depth", "thickness": "thickness",
    "diameter": "diameter", "dia": "diameter", "radius": "radius",
}

# Words that scope a quantity to a feature, so "hole diameter" and "shaft diameter" stay
# separate quantities. Only these words become part of a quantity's label.
_QUALIFIERS = {
    "hole": "hole", "bore": "bore", "slot": "slot", "wall": "wall", "base": "base",
    "flange": "flange", "plate": "plate", "pin": "pin", "shaft": "shaft", "boss": "boss",
    "rib": "rib", "pocket": "pocket", "thread": "thread", "trace": "trace", "pad": "pad",
    "via": "via", "board": "board", "groove": "groove", "counterbore": "counterbore",
    "tube": "tube", "pipe": "pipe", "cylinder": "cylinder", "body": "body",
    "fillet": "fillet", "chamfer": "chamfer", "corner": "corner", "edge": "edge",
    "inner": "inner", "inside": "inner", "internal": "inner",
    "outer": "outer", "outside": "outer", "external": "outer",
    "major": "major", "minor": "minor", "top": "top", "bottom": "bottom",
    "mounting": "mounting", "through": "through",
    "input": "input", "output": "output", "supply": "supply", "load": "load",
    "cutoff": "cutoff",
}

# Things that get counted ("4 holes").
_COUNT_NOUNS = [
    "hole", "slot", "pin", "boss", "rib", "fin", "layer", "via", "resistor", "capacitor",
    "tooth", "leg", "screw", "bolt", "fastener", "pad", "groove", "notch", "tab",
    "blade", "spoke", "port",
]
_NUMBER_WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
    "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
}
# Words between a count and its noun that do not change what is being counted.
_COUNT_FILLER = {
    "the", "a", "an", "of", "x", "equally", "evenly", "spaced", "identical", "total",
    "separate", "round", "circular",
}

# The nouns that name a size the Verifier Pack has a check for. A requirement is tagged
# machine only when it is one of these, or the task's one hole count.
SIZE_NOUNS = ("width", "length", "height", "depth", "thickness", "diameter", "radius")

# Sizes of the part as a whole, as opposed to the size of a feature on it.
_BOX_NOUNS = {"width", "length", "depth", "height", "thickness"}
_BOX_QUALIFIERS = {"plate", "base", "body", "board", "outer"}


def box_noun(label: str):
    """The noun of a label that names an overall size of the part ("plate width" ->
    "width"), or None when the label names something else ("slot length")."""
    *qualifiers, noun = label.split()
    if noun in _BOX_NOUNS and set(qualifiers) <= _BOX_QUALIFIERS:
        return noun
    return None


def uses_length(labels) -> bool:
    """CadQuery calls the X size "length". A text that says "length" means X by it and Y
    by "width"; a text that does not means X by "width" and Y by "depth"."""
    return any(box_noun(label) == "length" for label in labels)


def axis_names(with_length: bool) -> tuple:
    """The names of the X, Y and Z sizes, in the convention `uses_length` describes."""
    return ("length", "width", "height") if with_length else ("width", "depth", "height")


# -------------------------------------------------------------------------------- patterns

def _alt(words) -> str:
    return "|".join(re.escape(w) for w in sorted(words, key=len, reverse=True))


_LENGTH_UNITS = [u for u, (dim, _) in _UNITS.items() if dim == "length"]
# After "A x B x C" these say the three numbers are not lengths. One-letter capitals are
# left out: "60x40x5 L-bracket" is not five litres.
_NOT_A_LENGTH = [
    u for u, (dim, _) in _UNITS.items()
    if dim != "length" and not (len(u) == 1 and u.isupper())
] + ["mm2", "mm^2", "mm²", "cm2", "cm^2", "cm²"]

_NUM = r"(?<![\w.])\d+(?:\.\d+)?"
_PLAIN_NUM = r"\d+(?:\.\d+)?"
_PM = r"(?:±|\+/-|\+-)"
_UNIT_END = r"(?![\w^²³])"  # "mm" is not the unit of "mm²" or "mm2"
_UNIT = rf"(?:{_alt(_UNITS)}){_UNIT_END}"
_LENGTH_UNIT = rf"(?:{_alt(_LENGTH_UNITS)}){_UNIT_END}"
_QUAL_RUN = rf"(?:(?:{_alt(_QUALIFIERS)})s?[\s-]+){{0,2}}"
# A tolerance is not a value. It is written before the unit ("60 ± 0.1 mm") or after it
# ("60 mm ± 0.1 mm").
_TOL = rf"(?:\s*{_PM}\s*(?P<tol>{_PLAIN_NUM}))?"
_TOL_AFTER = rf"(?:\s*{_PM}\s*(?P<tol2>{_PLAIN_NUM})(?:\s*(?P<tolunit>{_UNIT}))?)?"

# "60 x 40 x 5 mm", "60 mm x 40 mm x 5 mm", "60x40x5"
_TRIPLE = re.compile(
    rf"(?P<a>{_NUM})(?:\s*(?P<ua>{_LENGTH_UNIT}))?\s*[x×]\s*"
    rf"(?P<b>{_PLAIN_NUM})(?:\s*(?P<ub>{_LENGTH_UNIT}))?\s*[x×]\s*"
    rf"(?P<c>{_PLAIN_NUM})(?!\.?\d)"
    rf"(?:\s*(?P<uc>{_LENGTH_UNIT})|(?!\s*(?:{_alt(_NOT_A_LENGTH)}){_UNIT_END}))"
)

# "hole diameter: 5 mm", "width of 40 ± 0.1 mm", "wall thickness = 2mm"
_LABEL_FIRST = re.compile(
    rf"\b(?i:(?P<mods>{_QUAL_RUN})(?P<noun>{_alt(_NOUNS)}))\b"
    r"\s*(?i:(?:of|is|are|=|:|shall\s+be|must\s+be|should\s+be|to\s+be|be|at)\s*)?"
    r"(?i:(?:approximately|approx\.?|exactly|about|nominally)\s*)?"
    rf"(?P<num>{_NUM}){_TOL}(?:\s*(?P<unit>{_UNIT}){_TOL_AFTER})?"
)

# "40 mm wide", "5 mm diameter mounting holes", "holes 5 mm deep", "holes of 5 mm diameter"
_VALUE_FIRST = re.compile(
    rf"(?i:(?P<pre>{_QUAL_RUN})(?:(?:of|with)\s+)?)"
    rf"(?P<num>{_NUM}){_TOL}\s*(?P<unit>{_UNIT})[\s-]*"
    rf"(?i:(?P<adj>{_alt(_ADJECTIVES)}))\b"
    rf"(?i:(?P<post>(?:\s+(?:{_alt(_QUALIFIERS)})s?\b){{1,2}}))?"
)

# "4 holes", "four mounting holes", "4 x M4 holes"
_COUNT = re.compile(
    rf"(?<![\w.])(?i:(?P<n>\d+|{_alt(_NUMBER_WORDS)}))\b(?!\.\d)[\s-]*(?:[x×]\s*)?"
    r"(?P<mods>(?:[A-Za-z][\w.]*[\s-]+){0,2}?)"
    rf"(?i:(?P<noun>(?:{_alt(_COUNT_NOUNS)})(?:es|s)?|teeth))\b"
)

# "60 mm" with nothing saying what it measures
_BARE = re.compile(rf"(?P<num>{_NUM}){_TOL}\s*(?P<unit>{_LENGTH_UNIT}){_TOL_AFTER}")

# ---------------------------------------------------------------------------------- scanner

LABELLED = "labelled"
COUNT = "count"
TRIPLE = "triple"
BARE = "bare"

# One number found in a text. `at` orders finds as they are read; `label` is None when
# the text does not say what the number measures; `tolerance` is (number, unit) or None;
# `axis` is the position (0, 1, 2) within a triple.
Found = namedtuple("Found", "at origin label number unit tolerance axis", defaults=(None,))
Quantity = namedtuple("Quantity", "label raw dim base shown")


def _singular(word: str) -> str:
    word = word.lower()
    if word == "teeth":
        return "tooth"
    if word.endswith("sses"):
        return word[:-2]
    if word.endswith("s") and not word.endswith("ss"):
        return word[:-1]
    return word


def _qualifiers(run) -> list:
    out = []
    for word in re.split(r"[\s-]+", (run or "").strip()):
        if word:
            canon = _QUALIFIERS.get(_singular(word)) or _QUALIFIERS.get(word.lower())
            if canon:
                out.append(canon)
    return out


def _tolerance(m, unit):
    groups = m.groupdict()
    if groups.get("tol"):
        return groups["tol"], unit
    if groups.get("tol2"):
        return groups["tol2"], groups.get("tolunit") or unit
    return None


def scan(text: str) -> list:
    """Every number the text states, most specific reading first: a later pattern never
    re-reads a number an earlier one claimed. Finds come back in pattern order (triples,
    labelled sizes, counts, bare lengths); sort on `at` for reading order. A triple's
    label is left None here, since its axis names depend on the rest of the task."""
    text = text or ""
    found = []
    spans = []  # whole matches of triples and labelled quantities
    used = set()  # start offsets of numbers already claimed

    def claimed(start: int) -> bool:
        return start in used or any(s <= start < e for s, e in spans)

    for m in _TRIPLE.finditer(text):
        spans.append(m.span())
        last = m.group("uc") or "mm"
        for axis, (num, unit) in enumerate((("a", "ua"), ("b", "ub"), ("c", "uc"))):
            found.append(Found(
                (m.start(num), axis), TRIPLE, None, m.group(num),
                m.group(unit) or last, None, axis))
    triples = list(spans)

    def in_triple(start: int) -> bool:
        return any(s <= start < e for s, e in triples)

    for m in _LABEL_FIRST.finditer(text):
        if in_triple(m.start("num")):
            continue
        label = " ".join(_qualifiers(m.group("mods")) + [_NOUNS[m.group("noun").lower()]])
        unit = m.group("unit")
        found.append(Found(
            (m.start("num"), 0), LABELLED, label, m.group("num"), unit,
            _tolerance(m, unit)))
        used.add(m.start("num"))
        spans.append(m.span())

    for m in _VALUE_FIRST.finditer(text):
        if m.start("num") in used or in_triple(m.start("num")):
            continue
        quals = _qualifiers(m.group("post")) or _qualifiers(m.group("pre"))
        label = " ".join(quals + [_ADJECTIVES[m.group("adj").lower()]])
        unit = m.group("unit")
        found.append(Found(
            (m.start("num"), 0), LABELLED, label, m.group("num"), unit,
            _tolerance(m, unit)))
        used.add(m.start("num"))
        spans.append((m.start("num"), m.end()))

    for m in _COUNT.finditer(text):
        if claimed(m.start("n")):
            continue
        mods = [w for w in re.split(r"[\s-]+", m.group("mods").strip()) if w]
        # "5 mm holes" and "2 mm thick ribs" are sizes, not counts.
        if any(w in _UNITS or w.lower() in _ADJECTIVES for w in mods):
            continue
        kept = [
            w.lower() for w in mods
            if w.isalpha() and w.lower() not in _COUNT_FILLER  # drops M4-style tokens
        ]
        n = m.group("n").lower()
        label = " ".join(kept + [_singular(m.group("noun")), "count"])
        found.append(Found(
            (m.start("n"), 0), COUNT, label, str(_NUMBER_WORDS.get(n, n)), None, None))
        used.add(m.start("n"))

    for m in _BARE.finditer(text):
        if claimed(m.start("num")):
            continue
        unit = m.group("unit")
        found.append(Found(
            (m.start("num"), 0), BARE, None, m.group("num"), unit, _tolerance(m, unit)))
        spans.append(m.span())

    return found


def _quantity(label: str, number: str, unit) -> Quantity:
    raw = float(number)
    if unit:
        dim, factor = _UNITS[unit]
        return Quantity(label, raw, dim, raw * factor, f"{number} {unit}")
    return Quantity(label, raw, None, raw, number)


def extract_quantities(text: str) -> list:
    """Pull labelled quantities out of prose: dimensions and other values with a name
    ("width of 40 mm", "40 mm wide") and counts ("4 holes"). Bare numbers, tolerances,
    "A x B x C" triples and thread sizes such as M4 are ignored."""
    return [
        _quantity(f.label, f.number, f.unit)
        for f in scan(text) if f.origin in (LABELLED, COUNT)
    ]


# ----------------------------------------------------------------------------- requirements

def _is_length(unit) -> bool:
    return unit in _UNITS and _UNITS[unit][0] == "length"


def _requirement(found: Found, names: tuple):
    """(dedupe key, requirement fields without id and source), or None when the find is
    not a requirement: a voltage, a rib count, a size with no unit."""
    if found.origin == COUNT:
        *mods, noun, _ = found.label.split()
        if noun != "hole":
            return None
        n = int(found.number)
        text = " ".join([found.number, *mods, "hole" if n == 1 else "holes"])
        return (found.label, float(n)), {
            "text": text, "kind": "hole", "value": found.number, "tolerance": None,
            "label": found.label, "check_method": MACHINE,
        }

    if not _is_length(found.unit):
        return None
    label = names[found.axis] if found.origin == TRIPLE else found.label
    value = f"{found.number} {found.unit}"
    tolerance = f"±{found.tolerance[0]} {found.tolerance[1]}" if found.tolerance else None
    machine = label is not None and label.split()[-1] in SIZE_NOUNS
    # "plate width" and "width" are the same size of the same part.
    key = (label and (box_noun(label) or label),
           round(float(found.number) * _UNITS[found.unit][1], 9))
    return key, {
        "text": f"{label} of {value}" if label else value,
        "kind": "dimension", "value": value, "tolerance": tolerance,
        "label": label, "check_method": MACHINE if machine else MANUAL,
    }


def extract_requirements(prompt, spec, new_id=None) -> list:
    """The requirements a task states, each a dict with id, text, kind, value, tolerance,
    label, source and check_method.

    The spec is read first and then the prompt, each in reading order. A quantity both
    state with the same value is one requirement, worded as the spec words it; one they
    state with different values is two, and the value_contradiction lint rule reports
    it. The prompt is looser prose, so a value it gives for a noun the spec gives the
    same value for ("a mounting plate 60 mm wide" against "width of 60 mm") is taken as
    the spec's requirement said again, whatever qualifiers the prompt puts on it, and so
    is a length the prompt gives no name for when the spec states that value.

    The verifier counts every hole the reference makes, so a hole count is tagged machine
    only when it is the one hole count the task states: with several ("4 mounting holes
    and 1 centre hole", "the two holes on the short side") none of them is the total for
    certain, and all are left to the reviewer."""
    new_id = new_id or (lambda: str(uuid.uuid4()))
    scans = [("spec", scan(spec)), ("prompt", scan(prompt))]
    names = axis_names(uses_length(
        f.label for _, finds in scans for f in finds if f.origin == LABELLED))

    def loose(key):  # the noun without its qualifiers: "hole diameter" -> "diameter"
        label, value = key
        return (label and " ".join(label.split()[-2 if label.endswith(" count") else -1:]),
                value)

    by_key = {}
    in_spec = set()  # loose keys, and (None, value) for every length the spec states
    for source, finds in scans:
        for found in sorted(finds, key=lambda f: f.at):
            built = _requirement(found, names)
            if built is None:
                continue
            key, fields = built
            first = by_key.get(key)
            if first is not None:
                if first["tolerance"] is None:
                    first["tolerance"] = fields["tolerance"]
            elif source == "spec":
                by_key[key] = {"id": new_id(), **fields, "source": source}
                in_spec.add(loose(key))
                if fields["kind"] == "dimension":
                    in_spec.add((None, key[1]))
            elif loose(key) not in in_spec:
                by_key[key] = {"id": new_id(), **fields, "source": source}

    requirements = list(by_key.values())
    counts = [r for r in requirements if r["kind"] == "hole"]
    if len(counts) > 1:
        for requirement in counts:
            requirement["check_method"] = MANUAL
    return requirements


# ----------------------------------------------------------------------------- rubric items

# The rubric is the five review criteria (apps/api/src/campaign/review-protocol.ts).
CRITERIA = ("verifiable", "unambiguous", "correct_reference", "complete_constraints",
            "difficulty")

# The wording matters. Every text opens with its criterion key, and the linter re-infers
# the check method from the words dimension, hole, volume and manifold (rules.py), so
# only a machine item may use them.
_MANUAL_TEXT = {
    "verifiable": "verifiable: the result can be checked objectively against the spec.",
    "unambiguous": "unambiguous: two solvers would read the spec the same way.",
    "correct_reference": "correct_reference: the reference solution satisfies the spec.",
    "complete_constraints":
        "complete_constraints: sizes and tolerances are fully specified, with no free "
        "parameters.",
    "difficulty": "difficulty: the task is hard enough to be worth solving.",
}
_MACHINE_TEXT = {
    "correct_reference":
        "correct_reference: the reference solution has every dimension the spec states.",
}


def rubric_items(requirements: list, new_id=None) -> list:
    """One rubric item per criterion, each with its check method.

    `correct_reference` is machine-checked against every machine requirement, listed in
    `requirement_ids`, and manual when there is none. The other criteria are manual."""
    new_id = new_id or (lambda: str(uuid.uuid4()))
    checkable = [r["id"] for r in requirements if r["check_method"] == MACHINE]
    items = []
    for criterion in CRITERIA:
        machine = bool(checkable) and criterion in _MACHINE_TEXT
        items.append({
            "id": new_id(),
            "criterion": criterion,
            "text": _MACHINE_TEXT[criterion] if machine else _MANUAL_TEXT[criterion],
            "check_method": MACHINE if machine else MANUAL,
            "requirement_ids": list(checkable) if machine else [],
            "weight": 1.0,
        })
    return items


def extract(prompt, spec=None, new_id=None) -> dict:
    """Turn a task's prompt and spec into its requirements and rubric items."""
    requirements = extract_requirements(prompt, spec, new_id)
    return {
        "version": VERSION,
        "requirements": requirements,
        "rubric_items": rubric_items(requirements, new_id),
    }


__all__ = [
    "VERSION", "MACHINE", "VISUAL", "MANUAL", "CRITERIA", "SIZE_NOUNS",
    "Found", "Quantity", "scan", "extract_quantities", "extract_requirements",
    "rubric_items", "extract", "box_noun", "uses_length", "axis_names",
]
