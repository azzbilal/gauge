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
                          extract_quantities)
    from .packet import TaskPacket
except ImportError:  # imported from inside verify/lint rather than as a package
    from extract import (MACHINE, MANUAL, VISUAL, Quantity, _UNITS,  # noqa: F401
                         extract_quantities)
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
