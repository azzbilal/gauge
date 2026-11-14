"""The cad-spec release: where its version comes from, and the task-to-packet bridge.

    from cadspec import spec_version, to_packet
    spec_version()          # read from model/SPEC.md, the only place it is written
    to_packet(task, code)   # the M7/M8 packet for a task, with `code` as the reference

Standard library only.
"""
import re
import sys
from functools import lru_cache
from pathlib import Path

MODEL_DIR = Path(__file__).resolve().parent
REPO_DIR = MODEL_DIR.parent
SPEC_PATH = MODEL_DIR / "SPEC.md"
VERIFY_DIR = REPO_DIR / "verify"

_VERSION_LINE = re.compile(r"^spec-version:\s*(cad-spec-\d+\.\d+)\s*$", re.MULTILINE)


class SpecError(ValueError):
    """A task does not match the cad-spec release."""


@lru_cache(maxsize=None)
def spec_version(path: Path = SPEC_PATH) -> str:
    """The `spec-version:` line of SPEC.md. Raises SpecError when there is not exactly one."""
    found = _VERSION_LINE.findall(Path(path).read_text(encoding="utf-8"))
    if len(found) != 1:
        raise SpecError(f"{path} must contain exactly one 'spec-version: cad-spec-X.Y' line")
    return found[0]


def use_verify() -> None:
    """Put verify/ on sys.path so lint, verifiers and probe import as they do in the service."""
    if str(VERIFY_DIR) not in sys.path:
        sys.path.insert(0, str(VERIFY_DIR))


TASK_FIELDS = ("id", "spec_version", "family", "split", "prompt", "spec", "reference", "rubric")
SPLITS = ("train", "heldout")


def check_task(task: dict, version: str = None) -> None:
    """Raise SpecError when `task` is not a cad-spec task of this version."""
    version = version or spec_version()
    if not isinstance(task, dict):
        raise SpecError("a task must be a JSON object")
    missing = [f for f in TASK_FIELDS if f not in task]
    if missing:
        raise SpecError(f"task {task.get('id', '?')} is missing {', '.join(missing)}")
    if task["spec_version"] != version:
        raise SpecError(
            f"task {task['id']} is {task['spec_version']}, this code reads {version}")
    if task["split"] not in SPLITS:
        raise SpecError(f"task {task['id']} has split {task['split']!r}")
    rubric = task["rubric"]
    if not isinstance(rubric, dict) or not all(
            isinstance(rubric.get(k), list) for k in ("requirements", "rubric_items")):
        raise SpecError(f"task {task['id']} rubric needs requirements and rubric_items lists")


def to_packet(task: dict, reference: str = None) -> dict:
    """The packet `verify/lint/packet.py` reads, with `reference` (default: the task's own)."""
    return {
        "prompt": task["prompt"],
        "spec": task["spec"],
        "reference": task["reference"] if reference is None else reference,
        "requirements": task["rubric"]["requirements"],
        "rubric_items": task["rubric"]["rubric_items"],
    }


__all__ = ["spec_version", "check_task", "to_packet", "use_verify", "SpecError",
           "SPEC_PATH", "SPLITS"]
