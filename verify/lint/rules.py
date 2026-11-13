"""Deterministic lint rules for M7 Packet Lint.

Each rule is a pure function of a TaskPacket and returns a list of findings, each a
(rule, severity, detail) tuple with severity one of info | warning | critical.
Standard library only.
"""
import math
import re

# The scanner lives in extract.py, the single source for reading numbers out of prose.
# The names below are re-exported because the Verifier Pack imports them from here.
try:
    from .extract import (MACHINE, MANUAL, VISUAL, Quantity, _UNITS,  # noqa: F401
                          extract_quantities, label_parts, stated_quantities)
    from .packet import TaskPacket
except ImportError:  # imported from inside verify/lint rather than as a package
    from extract import (MACHINE, MANUAL, VISUAL, Quantity, _UNITS,  # noqa: F401
                         extract_quantities, label_parts, stated_quantities)
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


def _same_size(a: str, b: str) -> bool:
    """True when two labels name the same size: the same label, or the same noun where
    one only adds to the other's qualifiers ("mounting hole diameter", "hole diameter").
    A bare noun is never a qualified one: "length" is not "slot length"."""
    if a == b:
        return True
    (a_quals, a_noun), (b_quals, b_noun) = label_parts(a), label_parts(b)
    return a_noun == b_noun and bool(a_quals and b_quals) and (
        a_quals <= b_quals or b_quals <= a_quals)


def value_contradiction(packet: TaskPacket) -> list:
    """Flag a quantity that the prompt and the spec both state, with different values.

    Quantities are grouped the way extraction groups them into requirements
    (`stated_quantities`): "a plate 60 mm wide" and "width of 50 mm" are the same size,
    and so is the first number of "60 x 40 x 5 mm".

    A size is flagged only when no value the prompt gives for it agrees with any value
    the spec gives, so a label that legitimately carries several values (two hole sizes,
    say) is not reported as long as the two texts overlap.

    A count is compared only with the same count, never a qualified one with a total
    ("4 mounting holes" of "5 holes"), and only when each text states it once: "1 hole
    of 5 mm and 1 hole of 6 mm" does not contradict "2 holes"."""
    stated = stated_quantities(packet.prompt, packet.spec)
    in_prompt = _by_label(stated["prompt"])
    in_spec = _by_label(stated["spec"])

    findings = []
    for label, prompt_values in in_prompt.items():
        if label.endswith(" count"):
            spec_values = in_spec.get(label, [])
            if len(prompt_values) != 1 or len(spec_values) != 1:
                continue
        else:
            spec_values = [q for other, qs in in_spec.items() if _same_size(label, other)
                           for q in qs]
            prompt_values = [q for other, qs in in_prompt.items()
                             if _same_size(label, other) for q in qs]
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
