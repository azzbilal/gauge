"""Task packet shapes for M7 Packet Lint.

Mirrors the Requirement and RubricItem models in apps/api/prisma/schema.prisma.
`TaskPacket.from_dict` accepts both snake_case keys and the camelCase keys Prisma emits
(requirementId, checkMethod, rubricItems). Standard library only.
"""
from dataclasses import dataclass, field
from typing import Optional


class PacketError(ValueError):
    """The packet JSON does not have the expected shape."""


def _pick(d: dict, *keys, default=None):
    for key in keys:
        if key in d and d[key] is not None:
            return d[key]
    return default


def _text(value) -> str:
    return "" if value is None else str(value)


def _opt_text(value) -> Optional[str]:
    return None if value is None else str(value)


def _records(packet: dict, *keys) -> list:
    rows = _pick(packet, *keys, default=[])
    if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
        raise PacketError(f"'{keys[0]}' must be a list of objects")
    return rows


def _require_id(row: dict, where: str) -> str:
    value = row.get("id")
    if value is None or str(value) == "":
        raise PacketError(f"every entry in '{where}' needs an 'id'")
    return str(value)


@dataclass(frozen=True)
class Requirement:
    id: str
    text: str
    kind: Optional[str] = None  # dimension, hole, file, value, ...
    value: Optional[str] = None
    tolerance: Optional[str] = None


@dataclass(frozen=True)
class RubricItem:
    id: str
    text: str
    requirement_id: Optional[str] = None
    check_method: Optional[str] = None  # machine | visual | manual (any case)
    weight: float = 1.0


@dataclass(frozen=True)
class TaskPacket:
    prompt: str = ""
    spec: str = ""
    reference: str = ""
    requirements: list = field(default_factory=list)
    rubric_items: list = field(default_factory=list)

    @classmethod
    def from_dict(cls, packet: dict) -> "TaskPacket":
        if not isinstance(packet, dict):
            raise PacketError("packet must be a JSON object")

        requirements = [
            Requirement(
                id=_require_id(row, "requirements"),
                text=_text(row.get("text")),
                kind=_opt_text(row.get("kind")),
                value=_opt_text(row.get("value")),
                tolerance=_opt_text(row.get("tolerance")),
            )
            for row in _records(packet, "requirements")
        ]

        rubric_items = []
        for row in _records(packet, "rubric_items", "rubricItems"):
            weight = _pick(row, "weight", default=1.0)
            if isinstance(weight, bool) or not isinstance(weight, (int, float)):
                raise PacketError("rubric item 'weight' must be a number")
            rubric_items.append(
                RubricItem(
                    id=_require_id(row, "rubric_items"),
                    text=_text(row.get("text")),
                    requirement_id=_opt_text(_pick(row, "requirement_id", "requirementId")),
                    check_method=_opt_text(_pick(row, "check_method", "checkMethod")),
                    weight=float(weight),
                )
            )

        return cls(
            prompt=_text(packet.get("prompt")),
            spec=_text(packet.get("spec")),
            reference=_text(packet.get("reference")),
            requirements=requirements,
            rubric_items=rubric_items,
        )
