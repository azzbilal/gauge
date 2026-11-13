# M7 — Packet Lint and requirement extraction

Deterministic, standard library only, no LLM. Two parts:

- `extract.py` reads a task's prompt and spec and returns the **requirements** it states and
  the **rubric items** that check them. It is the only parser of task prose in Gauge: the API
  gets every packet from it over `POST /extract`, the lint rules read quantities through it,
  and the Verifier Pack reads each requirement's numbers back through it.
- `lint.py` / `rules.py` run three rules over a packet and return findings.

## Extraction (`extract-7`)

```python
from lint import extract
extract(prompt, spec)
# {"version": "extract-7", "requirements": [...], "rubric_items": [...]}
```

Each requirement is `{id, text, kind, value, tolerance, label, source, check_method}` with
`kind` `dimension` or `hole` and `check_method` `machine` or `manual`.

**What is read.**

| Form | Example | Requirement |
|---|---|---|
| A named length, label first or value first, tolerance before or after the unit | `width of 60 ± 0.1 mm`, `Width: 60 +/- 0.2 mm`, `5 mm diameter holes` | `width of 60 mm`, tolerance `±0.1 mm` |
| A triple, named by axis | `Plate 60 x 40 x 5 mm`, `60x40x5`, `60 × 40 × 5 mm` | width, depth, height (length, width, height when the task says "length") |
| A hole count, in digits or words | `4 holes`, `four mounting holes` | `4 holes` / `4 mounting holes`, kind `hole` |
| A length with no name | `A spacer 60 mm in size` | `60 mm`, always manual |

Lengths in mm, cm, m, µm and inches are read. Areas, volumes, angles, voltages and other
quantities are scanned (the contradiction rule compares them) but **never become
requirements**: extraction makes length and hole-count requirements only.

**Machine or manual.** A requirement is `machine` only when the verifier can check it for
certain; everything else goes to the reviewer:

- A named length is machine when its noun is a size noun (width, length, height, depth,
  thickness, diameter, radius). `pitch of 2 mm` is manual.
- A triple names the part only when nothing says it sizes something else. A triple that
  sizes a feature (`a 20 x 10 x 3 mm pocket`, a cut-out, window or opening, a size after a
  comma or an "and" that carries the feature) keeps the feature's name and is not the part's
  width/depth/height. When the text states two part-like triples (an L-bracket's base and
  upright, a plate with a boss or post) or a triple disagrees with the sizes stated in words,
  every one of them goes to the reviewer.
- A hole count is machine only when it is certainly the total the reference must make: the
  only hole count stated, unqualified, in a task that mentions no other hole. `4 mounting
  holes`, `4 holes and a central bore`, or several counts are manual.

**Prompt and spec.** The spec is read first, then the prompt. A quantity both state with the
same value is one requirement (worded as the spec words it); with different values it is two,
and the `value_contradiction` rule reports them. The prompt restating the spec in looser words
adds nothing. The same statement twice is one requirement, except a hole count: `1 hole of
5 mm and 1 hole of 6 mm` is two holes.

**Rubric items.** One per review criterion (`verifiable`, `unambiguous`,
`correct_reference`, `complete_constraints`, `difficulty`, the same five as
`apps/api/src/campaign/review-protocol.ts`). `correct_reference` is machine and lists every
machine requirement in `requirement_ids`; it is manual when there is none. The other four are
always manual.

Bump `VERSION` whenever a change can alter what is extracted from the same text. The API
stores the version in each `task.created` event.

## Lint rules

```python
from lint import lint
lint(packet)   # [{"rule", "severity", "detail"}], severity info | warning | critical
```

| Rule | Finding |
|---|---|
| `traceability` | critical: a rubric item references a requirement that does not exist. warning: a rubric item references none, or a requirement is referenced by no rubric item. |
| `value_contradiction` | critical: the prompt and the spec state the same quantity with values that never agree (grouped as extraction groups them, so `a plate 60 mm wide` and `width of 50 mm` collide). A count is compared only with the same count, stated once in each text. |
| `check_method` | Re-infers each rubric item's method from its requirement's kind and text (dimension, hole, volume, manifold → machine; looks, aesthetic → visual; else manual). info: the item had no method. warning: the declared method differs or is unknown. |

A critical finding blocks task creation in the API. The four manual rubric items always
produce a traceability warning (they reference no requirement); the Author view hides that
noise, the stored findings keep it.

`PacketError` (a `ValueError`) is raised for a packet that is not shaped like one; the service
answers 400.

## Tests

```bash
python -m unittest discover -s verify/lint/tests -v
```

`tests/test_extract.py` is the specification of the cases above (dimensions, triples, hole
counts, prompt vs spec, contradictions).
