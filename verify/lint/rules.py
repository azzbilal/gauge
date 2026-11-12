"""Deterministic lint rules for M7 Packet Lint.

Each rule is a pure function of a TaskPacket and returns a list of findings, each a
(rule, severity, detail) tuple with severity one of info | warning | critical.
Standard library only.
"""
import math
import re
from collections import namedtuple

try:
    from .packet import TaskPacket
except ImportError:  # imported from inside verify/lint rather than as a package
    from packet import TaskPacket

INFO = "info"
WARNING = "warning"
CRITICAL = "critical"


# --------------------------------------------------------------------------- traceability

def traceability(packet: TaskPacket) -> list:
    """Every rubric item references an existing requirement, and every requirement is
    referenced by at least one rubric item."""
    findings = []
    known = {r.id for r in packet.requirements}
    referenced = set()

    for item in packet.rubric_items:
        if item.requirement_id is None:
            findings.append((
                "traceability", WARNING,
                f"rubric item {item.id} does not reference any requirement",
            ))
        elif item.requirement_id not in known:
            findings.append((
                "traceability", CRITICAL,
                f"rubric item {item.id} references requirement {item.requirement_id}, "
                "which does not exist",
            ))
        else:
            referenced.add(item.requirement_id)

    for req in packet.requirements:
        if req.id not in referenced:
            findings.append((
                "traceability", WARNING,
                f"requirement {req.id} is not referenced by any rubric item",
            ))
    return findings


# -------------------------------------------------------------------- value_contradiction

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


def _alt(words) -> str:
    return "|".join(re.escape(w) for w in sorted(words, key=len, reverse=True))


_NUM = r"(?<![\w.])\d+(?:\.\d+)?"
_TOL = r"(?:\s*(?:±|\+/-|\+-)\s*\d+(?:\.\d+)?)?"  # a tolerance is not a value
_UNIT = rf"(?:{_alt(_UNITS)})(?![A-Za-z])"
_QUAL_RUN = rf"(?:(?:{_alt(_QUALIFIERS)})s?[\s-]+){{0,2}}"

# "hole diameter: 5 mm", "width of 40 ± 0.1 mm", "wall thickness = 2mm"
_LABEL_FIRST = re.compile(
    rf"\b(?i:(?P<mods>{_QUAL_RUN})(?P<noun>{_alt(_NOUNS)}))\b"
    r"\s*(?i:(?:of|is|are|=|:|shall\s+be|must\s+be|should\s+be|to\s+be|be|at)\s*)?"
    r"(?i:(?:approximately|approx\.?|exactly|about|nominally)\s*)?"
    rf"(?P<num>{_NUM}){_TOL}(?:\s*(?P<unit>{_UNIT}))?"
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


def _quantity(label: str, number: str, unit) -> Quantity:
    raw = float(number)
    if unit:
        dim, factor = _UNITS[unit]
        return Quantity(label, raw, dim, raw * factor, f"{number} {unit}")
    return Quantity(label, raw, None, raw, number)


def extract_quantities(text: str) -> list:
    """Pull labelled quantities out of prose: dimensions and other values with a name
    ("width of 40 mm", "40 mm wide") and counts ("4 holes"). Bare numbers, tolerances and
    thread sizes such as M4 are ignored."""
    text = text or ""
    found = []
    used = set()  # start offsets of numbers already claimed by an earlier pattern

    for m in _LABEL_FIRST.finditer(text):
        label = " ".join(_qualifiers(m.group("mods")) + [_NOUNS[m.group("noun").lower()]])
        found.append(_quantity(label, m.group("num"), m.group("unit")))
        used.add(m.start("num"))

    for m in _VALUE_FIRST.finditer(text):
        if m.start("num") in used:
            continue
        quals = _qualifiers(m.group("post")) or _qualifiers(m.group("pre"))
        label = " ".join(quals + [_ADJECTIVES[m.group("adj").lower()]])
        found.append(_quantity(label, m.group("num"), m.group("unit")))
        used.add(m.start("num"))

    for m in _COUNT.finditer(text):
        if m.start("n") in used:
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
        number = str(_NUMBER_WORDS.get(n, n))
        label = " ".join(kept + [_singular(m.group("noun")), "count"])
        found.append(_quantity(label, number, None))

    return found


def _compatible(a: Quantity, b: Quantity) -> bool:
    """True when two statements of a quantity agree, or cannot be compared."""
    if a.dim and b.dim:
        if a.dim != b.dim:
            return True  # different physical dimensions: not the same measurement
        return math.isclose(a.base, b.base, rel_tol=1e-9, abs_tol=1e-12)
    return math.isclose(a.raw, b.raw, rel_tol=1e-9, abs_tol=1e-12)


def _by_label(quantities) -> dict:
    grouped = {}
    for q in quantities:
        grouped.setdefault(q.label, []).append(q)
    return grouped


def _shown(quantities) -> str:
    return " / ".join(dict.fromkeys(q.shown for q in quantities))


def value_contradiction(packet: TaskPacket) -> list:
    """Flag a quantity that the prompt and the spec both state, with different values.

    A quantity is flagged only when no value the prompt gives for it agrees with any
    value the spec gives, so a label that legitimately carries several values (two hole
    sizes, say) is not reported as long as the two texts overlap."""
    in_prompt = _by_label(extract_quantities(packet.prompt))
    in_spec = _by_label(extract_quantities(packet.spec))

    findings = []
    for label, prompt_values in in_prompt.items():
        spec_values = in_spec.get(label)
        if not spec_values:
            continue
        if any(_compatible(p, s) for p in prompt_values for s in spec_values):
            continue
        findings.append((
            "value_contradiction", CRITICAL,
            f"{label}: prompt says {_shown(prompt_values)} but spec says "
            f"{_shown(spec_values)}",
        ))
    return findings


# --------------------------------------------------------------------------- check_method

MACHINE = "machine"
VISUAL = "visual"
MANUAL = "manual"

_MACHINE_HINT = re.compile(r"\b(?:dimension|hole|volume|manifold)", re.IGNORECASE)
_VISUAL_HINT = re.compile(r"\b(?:looks\b|aesthetic)", re.IGNORECASE)


def infer_check_method(item, requirement=None) -> str:
    """Tag one rubric item machine, visual or manual.

    The requirement kind is consulted first, then the requirement and item text.
    dimension, hole, volume, manifold imply machine; looks, aesthetic imply visual;
    anything else is manual."""
    kind = (requirement.kind or "") if requirement else ""
    text = " ".join(filter(None, [requirement.text if requirement else "", item.text]))
    for source in (kind, text):
        if _MACHINE_HINT.search(source):
            return MACHINE
        if _VISUAL_HINT.search(source):
            return VISUAL
    return MANUAL


def tag_check_methods(packet: TaskPacket) -> dict:
    """Map every rubric item id to its inferred check method."""
    by_id = {r.id: r for r in packet.requirements}
    return {
        item.id: infer_check_method(item, by_id.get(item.requirement_id))
        for item in packet.rubric_items
    }


def check_method(packet: TaskPacket) -> list:
    """Tag each rubric item and report where the packet does not already carry that tag.

    An item with no check method gets an info finding carrying the tag; an item whose
    declared method differs from the inferred one gets a warning. An item already tagged
    correctly produces nothing."""
    findings = []
    tags = tag_check_methods(packet)
    for item in packet.rubric_items:
        inferred = tags[item.id]
        declared = (item.check_method or "").strip().lower()
        if not declared:
            findings.append((
                "check_method", INFO,
                f"rubric item {item.id} has no check method; tagged {inferred}",
            ))
        elif declared not in (MACHINE, VISUAL, MANUAL):
            findings.append((
                "check_method", WARNING,
                f"rubric item {item.id} has unknown check method "
                f"'{item.check_method}'; tagged {inferred}",
            ))
        elif declared != inferred:
            findings.append((
                "check_method", WARNING,
                f"rubric item {item.id} is marked {declared} but its requirement "
                f"implies {inferred}",
            ))
    return findings


RULES = (traceability, value_contradiction, check_method)
