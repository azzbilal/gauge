"""M9 Probe Gate entry point.

    from probe import probe
    result = probe(packet_dict, "qwen2.5-coder:7b")   # 3 rollouts by default

Asks a local Ollama model to solve the task N times, scores every attempt with the M8
Verifier Pack dimension and hole checks and turns the solve rate into a difficulty tier:

    t0      solve_rate > 0.8            too easy
    t1      0.4 <= solve_rate <= 0.8    in band
    t2      solve_rate < 0.4            hard
    broken  verifier errors and nothing solved: the task cannot be judged

A rollout is *solved* when the packet has at least one geometry_cad or static_cad verdict
and every one of them passes. manifold_volume verdicts are ignored: they only run when the
CAD kernel is available.
A *verifier error* is a rollout the verifier could not judge: it raised, the packet
produced no geometry_cad or static_cad verdict, or nothing failed but a check came back
not_run (a quantity the checks do not cover, code the static reader cannot resolve, or
generated code that timed out). A rollout with any failed check, including generated code
that does not parse, raises, crashes or builds no solid, is an ordinary failed rollout, not
a verifier error.

The model only ever sees the prompt and the spec, never the reference solution.

Generated code is EXECUTED by the verifier, in a worker process with a timeout, to measure
the solid it builds (see verifiers/cad_exec.py). A timeout is not a sandbox. Set
GAUGE_CAD_EXEC=0 to score from the static reading alone, without running anything.
Standard library only; the worker needs cadquery.
"""
import dataclasses
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

try:
    from lint.packet import PacketError, TaskPacket
except ImportError:  # verify/ is not on sys.path yet
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from lint.packet import PacketError, TaskPacket
from verifiers import VerifierPack
from verifiers.verifiers import FAIL, GEOMETRY_CAD, NOT_RUN, STATIC_CAD

SCORED = (GEOMETRY_CAD, STATIC_CAD)  # the checks a rollout is scored on

T0 = "t0"
T1 = "t1"
T2 = "t2"
BROKEN = "broken"

T0_ABOVE = 0.8
T1_FROM = 0.4

DEFAULT_ROLLOUTS = 3


def _ollama_url() -> str:
    """OLLAMA_BASE_URL (as the API reads it: a trailing /v1 is dropped) + /api/generate."""
    base = os.environ.get("OLLAMA_BASE_URL", "").strip() or "http://localhost:11434"
    base = base.rstrip("/")
    if base.endswith("/v1"):
        base = base[:-3]
    return f"{base}/api/generate"


def _ollama_timeout_s() -> float:
    """OLLAMA_TIMEOUT_MS, as the API reads it, in seconds; 300 when unset or invalid."""
    try:
        value = float(os.environ.get("OLLAMA_TIMEOUT_MS", "")) / 1000
    except ValueError:
        return 300.0
    return value if value > 0 else 300.0


OLLAMA_URL = _ollama_url()
DEFAULT_TIMEOUT_S = _ollama_timeout_s()

_INSTRUCTIONS = (
    "You are a CAD engineer. Write a CadQuery (Python) script that models the part "
    "described below. Use literal numbers in millimetres, assign the final solid to a "
    "variable named `result`, and reply with the Python code only."
)
_FENCE = re.compile(r"```[ \t]*([\w+-]*)[ \t]*\r?\n(.*?)```", re.DOTALL)


class OllamaError(RuntimeError):
    """The Ollama server could not produce a completion (down, unknown model, bad reply).

    Kept apart from a failed rollout so an infrastructure problem never reads as a hard
    task."""


def tier(solve_rate: float, verifier_errors: int = 0) -> str:
    """Map a solve rate (0..1) and a verifier error count to t0, t1, t2 or broken."""
    if not 0.0 <= solve_rate <= 1.0:
        raise ValueError("solve_rate must be between 0 and 1")
    if verifier_errors < 0:
        raise ValueError("verifier_errors must not be negative")
    if verifier_errors > 0 and solve_rate == 0:
        return BROKEN
    if solve_rate > T0_ABOVE:
        return T0
    if solve_rate >= T1_FROM:
        return T1
    return T2


def build_prompt(prompt: str, spec: str) -> str:
    parts = [_INSTRUCTIONS]
    if prompt.strip():
        parts.append(f"Task:\n{prompt.strip()}")
    if spec.strip():
        parts.append(f"Spec:\n{spec.strip()}")
    return "\n\n".join(parts)


def extract_code(text: str) -> str:
    """The code in a model reply: the fenced block when there is one, else the raw text.

    With several fenced blocks the first one tagged python wins, else the first."""
    blocks = _FENCE.findall(text)
    if not blocks:
        return text.strip()
    for language, body in blocks:
        if language.lower() in ("python", "py"):
            return body.strip()
    return blocks[0][1].strip()


def rollout(prompt: str, spec: str, model: str, *, url: str = OLLAMA_URL,
            timeout: float = DEFAULT_TIMEOUT_S) -> str:
    """Ask the local Ollama `model` for one CadQuery solution and return the code.

    Raises OllamaError when the server is unreachable or does not return a completion."""
    body = json.dumps(
        {"model": model, "prompt": build_prompt(prompt, spec), "stream": False}
    ).encode("utf-8")
    request = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            reply = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", "replace").strip()[:200]
        raise OllamaError(f"ollama answered HTTP {err.code}: {detail}") from err
    except (OSError, ValueError) as err:  # URLError, timeout, bad JSON
        raise OllamaError(f"ollama request failed: {err}") from err
    if not isinstance(reply, dict) or not isinstance(reply.get("response"), str):
        error = reply.get("error") if isinstance(reply, dict) else None
        raise OllamaError(f"ollama returned no completion: {error or 'unexpected reply'}")
    return extract_code(reply["response"])


def score(parsed: TaskPacket, code: str) -> dict:
    """Score one generated solution with the Verifier Pack dimension and hole checks."""
    result = {"code": code, "solved": False, "verdicts": [], "error": None}
    try:
        verdicts = VerifierPack().verify(dataclasses.replace(parsed, reference=code))
    except Exception as err:  # a verifier crash is a verifier error, not a failed task
        result["error"] = f"verifier raised {type(err).__name__}: {err}"
        return result
    static = [v for v in verdicts if v["check"] in SCORED]
    result["verdicts"] = static
    statuses = [v["status"] for v in static]
    if not static:
        result["error"] = "packet has no static_cad check to score against"
    elif FAIL in statuses:
        pass  # the solution is wrong: an ordinary failed rollout
    elif NOT_RUN in statuses:
        result["error"] = "check could not run: " + "; ".join(
            v["detail"] for v in static if v["status"] == NOT_RUN)
    else:
        result["solved"] = True
    return result


def probe(packet, model: str, n: int = DEFAULT_ROLLOUTS, rollout_fn=rollout) -> dict:
    """Run `n` rollouts of `model` on a task packet and return its difficulty tier.

    Returns {"tier", "solve_rate", "solved", "verifier_errors", "model", "rollouts"} where
    `rollouts` holds one {"code", "solved", "verdicts", "error"} per attempt.

    Raises PacketError for a malformed packet and OllamaError when generation fails.
    `rollout_fn(prompt, spec, model) -> code` can be replaced in tests."""
    if isinstance(n, bool) or not isinstance(n, int) or n < 1:
        raise ValueError("n must be a positive integer")
    parsed = packet if isinstance(packet, TaskPacket) else TaskPacket.from_dict(packet)

    rollouts = [score(parsed, rollout_fn(parsed.prompt, parsed.spec, model))
                for _ in range(n)]
    solved = sum(r["solved"] for r in rollouts)
    verifier_errors = sum(r["error"] is not None for r in rollouts)
    solve_rate = solved / n
    return {
        "tier": tier(solve_rate, verifier_errors),
        "solve_rate": solve_rate,
        "solved": solved,
        "verifier_errors": verifier_errors,
        "model": model,
        "rollouts": rollouts,
    }


__all__ = [
    "probe", "rollout", "tier", "score", "extract_code", "build_prompt",
    "OllamaError", "PacketError", "T0", "T1", "T2", "BROKEN", "DEFAULT_ROLLOUTS",
]
