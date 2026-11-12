"""M8 Verifier Pack entry point.

    from verifiers import verify
    verdicts = verify(packet_dict)

Takes a task packet (requirements, rubric items, reference CadQuery code) and returns one
verdict per machine-checkable rubric item:

    {"rubric_item_id", "requirement_id", "check", "status", "pass", "detail"}

`status` is pass | fail | not_run and `pass` is True only when status is pass, so a check
that could not run never reads as a pass. Two checks exist today:

    static_cad       box width/depth/height, hole or circle size and hole count, read from
                     the reference with `ast` and compared to the requirement
    manifold_volume  not run, detail "needs cadquery" (deferred until cadquery is installed)

The reference code is parsed, never executed. Standard library only.
"""
import re
import sys
from collections import namedtuple
from pathlib import Path

try:
    from lint.packet import PacketError, TaskPacket
except ImportError:  # verify/ is not on sys.path yet
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from lint.packet import PacketError, TaskPacket
from lint.rules import MACHINE, MANUAL, VISUAL, _UNITS, extract_quantities, infer_check_method

try:
    from .cad_static import CadModel, ReferenceError_, extract_model
except ImportError:  # imported from inside verify/verifiers rather than as a package
    from cad_static import CadModel, ReferenceError_, extract_model

PASS = "pass"
FAIL = "fail"
NOT_RUN = "not_run"

STATIC_CAD = "static_cad"
MANIFOLD_VOLUME = "manifold_volume"
NEEDS_CADQUERY = "needs cadquery"

_DEFAULT_TOL = 1e-6

# What a spec quantity is expected to be: `value` is in mm for sizes, a plain number for
# counts. `tol` is the allowed absolute deviation.
Expected = namedtuple("Expected", "label value tol note", defaults=("",))

_KERNEL_HINT = re.compile(r"\b(?:manifold|watertight|volume)", re.IGNORECASE)
_VALUE = re.compile(r"^\s*[=≈~]?\s*([-+]?\d+(?:\.\d+)?)\s*(\S+)?")
_TOLERANCE = re.compile(r"(?:±|\+/-|\+-)?\s*(\d+(?:\.\d+)?)\s*(\S+)?")
_SIZE_WORD = re.compile(
    r"\b(width|length|height|depth|thickness|diameter|radius)\b", re.IGNORECASE)
_HOLE_WORD = re.compile(r"\bholes?\b", re.IGNORECASE)

_BOX_NOUNS = {"width", "length", "depth", "height", "thickness"}
_BOX_QUALIFIERS = {"plate", "base", "body", "board", "outer"}
_HOLE_QUALIFIERS = {"hole", "bore", "mounting", "through"}
_COUNT_QUALIFIERS = {"mounting", "through"}
_AXIS_NAMES = ("X", "Y", "Z")


def _g(number) -> str:
    return f"{number:g}"


def _length_mm(number: float, unit) -> float:
    """Convert to mm when the unit is a length; bare numbers are taken as mm."""
    if unit in _UNITS and _UNITS[unit][0] == "length":
        return number * _UNITS[unit][1]
    return number


def _tolerance(requirement) -> tuple:
    """(allowed deviation in mm, note). Only a plain symmetric length tolerance such as
    "±0.1 mm" is understood; a fit class, a standard or a percentage falls back to an
    exact match and says so, rather than being read as a wide band."""
    raw = (requirement.tolerance or "").strip() if requirement else ""
    if not raw:
        return _DEFAULT_TOL, ""
    match = _TOLERANCE.fullmatch(raw)
    unit = match.group(2) if match else None
    if not match or (unit and _UNITS.get(unit, ("",))[0] != "length"):
        return _DEFAULT_TOL, f" (tolerance '{raw}' not understood; exact match required)"
    return _length_mm(float(match.group(1)), unit) + _DEFAULT_TOL, ""


def _expected(item, requirement) -> list:
    """The quantities a rubric item's requirement states, as Expected tuples."""
    text = requirement.text if requirement else ""
    quantities = extract_quantities(text) or extract_quantities(item.text)
    tol, note = _tolerance(requirement)

    out = []
    for q in quantities:
        is_count = q.label.endswith(" count")
        if q.dim not in (None, "length"):
            out.append(Expected(q.label, None, tol))  # an angle, a mass: not ours
        else:
            out.append(
                Expected(q.label, q.raw, _DEFAULT_TOL) if is_count
                else Expected(q.label, q.base, tol, note))

    # The structured value field wins over prose when it is clear what it refers to.
    value = _VALUE.match(requirement.value or "") if requirement else None
    if value:
        number, unit = float(value.group(1)), value.group(2)
        if len(out) == 1 and out[0].value is not None:
            only = out[0]
            is_count = only.label.endswith(" count")
            out = [only._replace(value=number if is_count else _length_mm(number, unit))]
        elif not out:
            words = {w.lower() for w in _SIZE_WORD.findall(f"{text} {item.text}")}
            kind = (requirement.kind or "").lower()
            if len(words) == 1:
                out = [Expected(words.pop(), _length_mm(number, unit), tol, note)]
            elif not words and not unit and number == int(number) and (
                    "hole" in kind or _HOLE_WORD.search(f"{text} {item.text}")):
                out = [Expected("hole count", number, _DEFAULT_TOL)]
    return out


class VerifierPack:
    """Runs the machine checks for one task packet."""

    def verify(self, packet) -> list:
        """Return one verdict per machine-checkable rubric item.

        Raises PacketError (a ValueError) when the packet is not shaped like a task
        packet."""
        parsed = packet if isinstance(packet, TaskPacket) else TaskPacket.from_dict(packet)
        by_id = {r.id: r for r in parsed.requirements}

        model, model_error = None, None
        if not parsed.reference.strip():
            model_error = "packet has no reference code"
        else:
            try:
                model = extract_model(parsed.reference)
            except ReferenceError_ as err:
                model_error = f"reference code does not parse ({err})"

        # CadQuery calls the X size "length". A spec that says "length" means X by it and
        # Y by "width"; a spec that does not means X by "width" and Y by "depth".
        uses_length = any(
            _box_noun(q.label) == "length"
            for r in parsed.requirements for q in extract_quantities(r.text)
        )
        axes = (
            {"length": 0, "width": 1, "height": 2, "thickness": 2, "depth": 2}
            if uses_length else
            {"width": 0, "depth": 1, "height": 2, "thickness": 2}
        )

        verdicts = []
        for item in parsed.rubric_items:
            requirement = by_id.get(item.requirement_id)
            if not self._is_machine(item, requirement):
                continue
            if self._needs_kernel(item, requirement):
                check, (status, detail) = MANIFOLD_VOLUME, self.manifold_volume()
            elif model is None:
                check, (status, detail) = STATIC_CAD, (FAIL, model_error)
            else:
                check = STATIC_CAD
                status, detail = self.static_cad(model, _expected(item, requirement), axes)
            verdicts.append({
                "rubric_item_id": item.id,
                "requirement_id": item.requirement_id,
                "check": check,
                "status": status,
                "pass": status == PASS,
                "detail": detail,
            })
        return verdicts

    # ---- routing

    @staticmethod
    def _is_machine(item, requirement) -> bool:
        declared = (item.check_method or "").strip().lower()
        if declared in (MACHINE, VISUAL, MANUAL):
            return declared == MACHINE
        return infer_check_method(item, requirement) == MACHINE

    @staticmethod
    def _needs_kernel(item, requirement) -> bool:
        kind = (requirement.kind or "") if requirement else ""
        text = " ".join(filter(None, [requirement.text if requirement else "", item.text]))
        return bool(_KERNEL_HINT.search(kind) or _KERNEL_HINT.search(text))

    # ---- checks

    @staticmethod
    def manifold_volume() -> tuple:
        """Manifold-solid and volume checks need the CAD kernel."""
        return NOT_RUN, NEEDS_CADQUERY

    @staticmethod
    def static_cad(model: CadModel, expected: list, axes: dict) -> tuple:
        """Compare every quantity the requirement states with the reference model."""
        if not expected:
            return NOT_RUN, "no checkable dimension or hole count found in the requirement"
        results = [_check_one(model, e, axes) for e in expected]
        statuses = [status for status, _ in results]
        status = FAIL if FAIL in statuses else NOT_RUN if NOT_RUN in statuses else PASS
        return status, "; ".join(detail for _, detail in results)


def _box_noun(label: str):
    *qualifiers, noun = label.split()
    if noun in _BOX_NOUNS and set(qualifiers) <= _BOX_QUALIFIERS:
        return noun
    return None


def _check_one(model: CadModel, e: Expected, axes: dict) -> tuple:
    *qualifiers, noun = e.label.split()
    if e.value is None:
        return NOT_RUN, f"{e.label}: no static check for this quantity"
    if noun == "count":
        if qualifiers and qualifiers[-1] in ("hole", "bore") and (
                set(qualifiers[:-1]) <= _COUNT_QUALIFIERS):
            return _check_hole_count(model, e)
    elif _box_noun(e.label) in axes:
        status, detail = _check_box(model, e, axes[noun])
        return status, detail + e.note
    elif noun in ("diameter", "radius") and set(qualifiers) <= _HOLE_QUALIFIERS:
        status, detail = _check_round(model, e, noun, bool(qualifiers))
        return status, detail + e.note
    return NOT_RUN, f"{e.label}: no static check for this quantity"


def _tol_note(e: Expected) -> str:
    return f" ± {_g(e.tol - _DEFAULT_TOL)}" if e.tol > 2 * _DEFAULT_TOL else ""


def _check_box(model, e, axis) -> tuple:
    want = f"{_g(e.value)}{_tol_note(e)} mm"
    if not model.boxes:
        return FAIL, f"{e.label}: spec requires {want} but the reference has no box"
    if len(model.boxes) > 1 or model.boxes[0].repeated:
        return NOT_RUN, (
            f"{e.label}: the reference builds more than one box; cannot tell statically "
            "which one is the body")
    actual = model.boxes[0].dims[axis]
    if actual is None:
        return NOT_RUN, (
            f"{e.label}: box {_AXIS_NAMES[axis]} size is not a static constant in the "
            "reference")
    if abs(actual - e.value) <= e.tol:
        return PASS, f"{e.label} {_g(actual)} mm matches spec"
    return FAIL, f"{e.label}: spec requires {want} but reference has {_g(actual)} mm"


def _check_hole_count(model, e) -> tuple:
    want = _g(e.value)
    if model.opaque:
        return NOT_RUN, (
            f"{e.label}: reference uses {', '.join(dict.fromkeys(model.opaque))}; "
            "hole count cannot be resolved statically")
    actual = model.hole_count
    if actual is None:
        return NOT_RUN, (
            f"{e.label}: hole pattern is not statically resolvable in the reference "
            "(loop, selector or computed point list)")
    if actual == e.value:
        return PASS, f"{e.label} {actual} matches spec"
    return FAIL, f"{e.label}: spec requires {want} but reference has {actual}"


def _check_round(model, e, noun, hole_only) -> tuple:
    """A hole diameter/radius; an unqualified one falls back to an extruded circle."""
    scale = 1.0 if noun == "diameter" else 0.5
    want = f"{_g(e.value)}{_tol_note(e)} mm"
    if model.holes:
        what, sizes = "hole", [g.diameter for g in model.holes]
    elif model.bosses and not hole_only:
        what, sizes = "circle", [None if r is None else 2.0 * r for r in model.bosses]
    else:
        target = "hole" if hole_only else "hole or circle"
        return FAIL, f"{e.label}: spec requires {want} but the reference has no {target}"
    if any(s is None for s in sizes):
        return NOT_RUN, (
            f"{e.label}: a {what} size is not a static constant in the reference")
    actual = sorted({s * scale for s in sizes})
    if all(abs(a - e.value) <= e.tol for a in actual):
        return PASS, f"{e.label} {_g(actual[0])} mm matches spec"
    found = ", ".join(_g(a) for a in actual)
    return FAIL, f"{e.label}: spec requires {want} but reference has {found} mm"


def verify(packet) -> list:
    """Run the Verifier Pack over a task packet and return the per-rubric verdicts."""
    return VerifierPack().verify(packet)


__all__ = ["VerifierPack", "verify", "PacketError", "PASS", "FAIL", "NOT_RUN"]
