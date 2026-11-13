# M7 — Packet Lint

Deterministic rules first; an LLM only extracts requirements from prose (and the author
confirms them). Lint checks that every rubric item traces to a stated requirement and that
numbers in the prompt match the spec, then tags each rubric item with a check method.

## Extraction

`extract.py` is the single place a prompt or a spec is parsed. `extract(prompt, spec)`
returns the requirements (named dimensions, `A x B x C` triples, hole counts), one rubric
item per review criterion with its check method, and `VERSION`. The lint rules and the
Verifier Pack read quantities through the same scanner, and the API gets its packets from
it over `POST /extract`; it has no parser of its own. Bump `VERSION` when a change can
alter what is extracted from the same text.

Tests: `python -m unittest discover -s verify/lint/tests -v`
