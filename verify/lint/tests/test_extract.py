"""Tests for requirement extraction (verify/lint/extract.py) and POST /extract. Run from the
repo root:

    python -m unittest discover -s verify/lint/tests -v
"""
import itertools
import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import HTTPServer
from pathlib import Path
from unittest import mock

VERIFY_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(VERIFY_DIR))
sys.path.insert(0, str(VERIFY_DIR / "service"))

from lint import EXTRACT_VERSION, extract, lint  # noqa: E402
from lint.extract import CRITERIA, extract_quantities  # noqa: E402
from lint.packet import Requirement, RubricItem  # noqa: E402
from verifiers import verify  # noqa: E402
from verifiers.verifiers import _expected  # noqa: E402

PLATE = (VERIFY_DIR / "verifiers" / "tests" / "fixtures" / "plate_ok.py").read_text(
    encoding="utf-8")
# The same plate with a fifth hole through its centre.
FIVE_HOLES = PLATE + "\nresult = result.faces('>Z').workplane().hole(12)\n"


def counter():
    ids = itertools.count(1)
    return lambda: f"id{next(ids)}"


def reqs(spec, prompt=""):
    """(text, tolerance) of every requirement, in order."""
    return [(r["text"], r["tolerance"])
            for r in extract(prompt, spec, counter())["requirements"]]


def texts(spec, prompt=""):
    return [text for text, _ in reqs(spec, prompt)]


def packet(prompt, spec, reference=""):
    """The packet the API assembles from an extraction (apps/api/src/verify/
    packet-builder.ts): a machine rubric item is repeated once per requirement it checks."""
    result = extract(prompt, spec, counter())
    by_id = {r["id"]: r for r in result["requirements"]}
    items = []
    for item in result["rubric_items"]:
        ids = item["requirement_ids"] if item["check_method"] == "machine" else [None]
        for req_id in ids:
            items.append({
                "id": f"{item['id']}:{req_id}" if req_id else item["id"],
                "text": f"{item['text']} ({by_id[req_id]['text']})" if req_id else item["text"],
                "requirementId": req_id,
                "checkMethod": item["check_method"],
                "weight": item["weight"] / len(ids),
            })
    return {"prompt": prompt, "spec": spec, "reference": reference,
            "requirements": result["requirements"], "rubricItems": items}


class Dimensions(unittest.TestCase):
    """The cases the TypeScript engine this module replaced was built around."""

    def test_label_first(self):
        self.assertEqual(texts("diameter 8 mm"), ["diameter of 8 mm"])
        self.assertEqual(texts("hole diameter: 8 mm"), ["hole diameter of 8 mm"])

    def test_tolerance_before_the_unit(self):
        self.assertEqual(reqs("width of 60 ± 0.1 mm"), [("width of 60 mm", "±0.1 mm")])
        self.assertEqual(reqs("Width: 60 +/- 0.2 mm"), [("width of 60 mm", "±0.2 mm")])

    def test_tolerance_after_the_unit(self):
        self.assertEqual(reqs("width of 60 mm ± 0.1 mm"), [("width of 60 mm", "±0.1 mm")])
        self.assertEqual(reqs("a 60 mm ± 0.5 mm spacer"), [("60 mm", "±0.5 mm")])

    def test_value_first(self):
        self.assertEqual(
            texts("60 mm wide, 40 mm long, 5 mm thick"),
            ["width of 60 mm", "length of 40 mm", "thickness of 5 mm"])
        self.assertEqual(texts("5 mm diameter holes"), ["hole diameter of 5 mm"])
        self.assertEqual(texts("holes 5 mm deep"), ["hole depth of 5 mm"])

    def test_qualifiers_are_canonical(self):
        self.assertEqual(
            texts("inside diameter 10 mm, external diameter of 20 mm, "
                  "mounting holes diameter 4 mm"),
            ["inner diameter of 10 mm", "outer diameter of 20 mm",
             "mounting hole diameter of 4 mm"])

    def test_a_length_with_no_name_is_kept_but_not_machine(self):
        result = extract("", "A spacer 60 mm in size", counter())
        self.assertEqual([r["text"] for r in result["requirements"]], ["60 mm"])
        self.assertEqual(result["requirements"][0]["check_method"], "manual")
        self.assertEqual({i["check_method"] for i in result["rubric_items"]}, {"manual"})

    def test_areas_and_volumes_are_not_lengths(self):
        self.assertEqual(
            texts("Area 200 mm² and volume 12000 mm^3, width 60 mm"), ["width of 60 mm"])
        self.assertEqual(texts("cross-section 200 mm2"), [])

    def test_other_length_units(self):
        self.assertEqual(texts("width of 6 cm"), ["width of 6 cm"])

    def test_other_quantities_are_not_requirements(self):
        self.assertEqual(texts("supply voltage of 5 V, angle of 30 deg, width 12"), [])

    def test_a_named_length_without_a_check_is_manual(self):
        result = extract("", "pitch of 2 mm", counter())
        self.assertEqual(
            [(r["text"], r["check_method"]) for r in result["requirements"]],
            [("pitch of 2 mm", "manual")])

    def test_the_same_statement_twice_is_one_requirement(self):
        self.assertEqual(
            reqs("Width 60 mm. The width of 60 mm is final. Width: 60 +/- 0.2 mm"),
            [("width of 60 mm", "±0.2 mm")])
        self.assertEqual(texts("width of 6 cm, 60 mm wide"), ["width of 6 cm"])

    def test_empty(self):
        self.assertEqual(texts(""), [])
        self.assertEqual(extract(None, None)["requirements"], [])


class Triples(unittest.TestCase):
    def test_named_width_depth_height(self):
        want = ["width of 60 mm", "depth of 40 mm", "height of 5 mm"]
        self.assertEqual(texts("Plate 60 x 40 x 5 mm."), want)
        self.assertEqual(texts("Plate 60 mm x 40 mm x 5 mm."), want)
        self.assertEqual(texts("Block 60x40x5"), want)
        self.assertEqual(texts("Block 60 × 40 × 5 mm"), want)

    def test_named_length_width_height_when_the_task_says_length(self):
        self.assertEqual(
            texts("Plate 80 x 50 x 6 mm, length of 80 mm, slot length 20 mm, "
                  "fillet radius 2 mm"),
            ["length of 80 mm", "width of 50 mm", "height of 6 mm",
             "slot length of 20 mm", "fillet radius of 2 mm"])
        # The prompt saying it is enough.
        self.assertEqual(
            texts("Plate 80 x 50 x 6 mm", prompt="Keep the length of 80 mm."),
            ["length of 80 mm", "width of 50 mm", "height of 6 mm"])
        # A feature's length is not the length of the part.
        self.assertEqual(
            texts("Plate 80 x 50 x 6 mm, slot length 20 mm")[:3],
            ["width of 80 mm", "depth of 50 mm", "height of 6 mm"])

    def test_feature_triple_is_not_named_as_the_part(self):
        # A pocket triple must not become the part's width/depth/height.
        self.assertEqual(
            texts("width of 60 mm, depth of 40 mm, height of 5 mm",
                  prompt="A bracket with a 20 x 10 x 3 mm pocket."),
            ["width of 60 mm", "depth of 40 mm", "height of 5 mm",
             "20 mm", "10 mm", "3 mm"])

    PART = ["width of 80 mm", "depth of 50 mm", "height of 6 mm"]
    PART_SPEC = "width of 60 mm, depth of 40 mm, height of 5 mm"

    def test_part_triples_stay_named(self):
        # Each phrasing alone, then with a feature noun just past a sentence or comma
        # boundary: the look-around must stop at the boundary.
        for phrase in ("The plate is 80 x 50 x 6 mm",
                       "Plate sized to 80 x 50 x 6 mm",
                       "Cut 80 x 50 x 6 mm aluminium plate"):
            for tail in (".", ". Pocket near the edge.", ", slot along the centre."):
                with self.subTest(text=phrase + tail):
                    self.assertEqual(texts(phrase + tail)[:3], self.PART)

    def test_part_triple_followed_by_a_feature_in_the_same_clause(self):
        for text in ("a 80 x 50 x 6 mm plate with a pocket",
                     "Plate 80 x 50 x 6 mm with a slot",
                     "a 80 x 50 x 6 mm plate including slots",
                     "an 80 x 50 x 6 mm plate (slot along the centre)",
                     "Cut 80 x 50 x 6 mm plate - slot down the middle",
                     "Cut 80 x 50 x 6 mm plate then pocket the centre"):
            with self.subTest(text=text):
                self.assertEqual(texts(text)[:3], self.PART)

    def test_feature_triples_are_not_named_as_the_part(self):
        # "two pockets" carries no triple of its own, so it is tested with one both ways.
        for phrase in ("a pocket of 20 x 10 x 3 mm",
                       "a 20 x 10 x 3 mm rectangular pocket",
                       "20 x 10 x 3 mm deep pocket",
                       "two pockets 20 x 10 x 3 mm",
                       "two 20 x 10 x 3 mm pockets",
                       "a pocket measuring 20 x 10 x 3 mm",
                       "Cut 20 x 10 x 3 mm pocket",
                       "Cut a 20 x 10 x 3 mm pocket",
                       "three notches 20 x 10 x 3 mm",
                       "two 20 x 10 x 3 mm cavities"):
            with self.subTest(prompt=phrase):
                self.assertEqual(
                    texts(self.PART_SPEC, prompt=phrase),
                    ["width of 60 mm", "depth of 40 mm", "height of 5 mm",
                     "20 mm", "10 mm", "3 mm"])

    FEATURE = ["width of 60 mm", "depth of 40 mm", "height of 5 mm", "20 mm", "10 mm",
               "3 mm"]

    def assertFeature(self, prompt):
        with self.subTest(prompt=prompt):
            self.assertEqual(texts(self.PART_SPEC, prompt=prompt), self.FEATURE)

    def assertPart(self, text):
        with self.subTest(text=text):
            self.assertEqual(texts(text)[:3], self.PART)

    def test_a_feature_noun_before_a_clause_break_still_names_the_triple(self):
        for prompt in ("Pocket, 20 x 10 x 3 mm",
                       "Pocket; 20 x 10 x 3 mm",
                       "Pocket. 20 x 10 x 3 mm",
                       "Pocket\n20 x 10 x 3 mm",
                       "Pocket.\n20 x 10 x 3 mm",
                       "Pocket,\n20 x 10 x 3 mm",
                       "Two pockets, 20 x 10 x 3 mm",
                       "Pocket, about 20 x 10 x 3 mm",
                       "Pocket; the size is 20 x 10 x 3 mm"):
            self.assertFeature(prompt)

    def test_a_part_noun_before_a_clause_break_does_not_name_the_triple(self):
        # Only a feature noun is read back past a break; the triple stays the part's.
        for text in ("Plate, 80 x 50 x 6 mm",
                     "Plate; 80 x 50 x 6 mm",
                     "A pocket. 80 x 50 x 6 mm plate",
                     # "overall" sizes the part whatever was named before the break.
                     "A plate with a pocket. Overall dimensions 80 x 50 x 6 mm",
                     "Plate with a slot, 80 x 50 x 6 mm overall"):
            self.assertPart(text)
        self.assertEqual(texts("Four mounting holes, 80 x 50 x 6 mm plate"),
                         ["4 mounting holes", *self.PART])

    def test_a_feature_named_last_before_a_break_wins_over_the_part(self):
        # Known limit: the look-back takes the last word before the break, so the plate
        # here is read as the pocket. That fails safe: the sizes go to the reviewer.
        self.assertEqual(texts("Plate with a pocket, 80 x 50 x 6 mm"),
                         ["80 mm", "50 mm", "6 mm"])

    def test_an_abbreviation_does_not_end_the_clause(self):
        for abbreviation in ("approx.", "Approx.", "ca.", "e.g.", "i.e.", "eg.", "ie.",
                             "viz."):
            self.assertFeature(f"A pocket {abbreviation} 20 x 10 x 3 mm")
            self.assertPart(f"Plate {abbreviation} 80 x 50 x 6 mm")
        self.assertFeature("Pocket, approx. 20 x 10 x 3 mm")
        # A word that only ends like one still ends the sentence, so the triple is not
        # read as part of "Made of mica" and takes the noun after it.
        self.assertFeature("Made of mica. 20 x 10 x 3 mm pocket")

    def test_the_head_of_the_subject_is_what_is_sized(self):
        for prompt in ("The pocket in the plate is 20 x 10 x 3 mm",
                       "The pocket on the top face is 20 x 10 x 3 mm",
                       "On the top face the pocket is 20 x 10 x 3 mm",
                       "The size of the pocket is 20 x 10 x 3 mm",
                       "The footprint of the pocket is 20 x 10 x 3 mm",
                       "The outline of the pocket is 20 x 10 x 3 mm",
                       "The pocket must be 20 x 10 x 3 mm",
                       "The pocket in the plate shall be 20 x 10 x 3 mm",
                       "The pocket in the plate measures 20 x 10 x 3 mm",
                       "The pocket needs to be 20 x 10 x 3 mm",
                       "A plate with a pocket that is 20 x 10 x 3 mm",
                       "A plate with a pocket which is 20 x 10 x 3 mm",
                       "The pockets in the plate are 20 x 10 x 3 mm"):
            self.assertFeature(prompt)
        for text in ("The plate with a pocket is 80 x 50 x 6 mm",
                     "The plate with two slots is 80 x 50 x 6 mm",
                     "The dimensions of the plate are 80 x 50 x 6 mm",
                     "The plate with a pocket must be 80 x 50 x 6 mm",
                     "The plate with a pocket measures 80 x 50 x 6 mm"):
            self.assertPart(text)

    def test_a_preceding_triple_ends_the_subject(self):
        # The subject of the second "is" starts after the first triple, so the plate
        # before it does not name the pocket's triple.
        self.assertEqual(
            texts("The plate with a pocket is 60 x 40 x 10 mm and the pocket is "
                  "20 x 10 x 3 mm"),
            ["width of 60 mm", "depth of 40 mm", "height of 10 mm",
             "20 mm", "10 mm", "3 mm"])
        # Only the cut can name the plate here: read from the start of the sentence,
        # its subject is "the pocket in the plate ... and the plate", headed by pocket.
        self.assertEqual(
            texts("The pocket in the plate is 20 x 10 x 3 mm and the plate is "
                  "60 x 40 x 10 mm"),
            ["20 mm", "10 mm", "3 mm",
             "width of 60 mm", "depth of 40 mm", "height of 10 mm"])
        # The cut ends the subject only: the look back past a break still reaches the
        # feature named before both triples.
        self.assertEqual(
            texts(self.PART_SPEC, prompt="Two pockets, 20 x 10 x 3 mm and 15 x 10 x 3 mm"),
            self.FEATURE + ["15 mm"])

    def test_two_different_triples_in_one_text_are_not_both_the_part(self):
        # Neither "block" nor "plate" is a feature noun, so neither is taken for the part:
        # the larger one is not always the part (an L-bracket's base and upright).
        part = ["width of 60 mm", "depth of 40 mm", "height of 5 mm"]
        self.assertEqual(texts("Plate 60 x 40 x 5 mm. Block 20 x 10 x 3 mm"),
                         ["60 mm", "40 mm", "5 mm", "20 mm", "10 mm", "3 mm"])
        self.assertEqual(texts("Block 20 x 10 x 3 mm. Plate 60 x 40 x 5 mm"),
                         ["20 mm", "10 mm", "3 mm", "60 mm", "40 mm", "5 mm"])
        # The same size stated twice, in any unit, is still the part.
        self.assertEqual(texts("Plate 60 x 40 x 5 mm. Plate 60 x 40 x 5 mm"), part)
        self.assertEqual(texts("Plate 6 x 4 x 0.5 cm. Plate 60 x 40 x 5 mm"),
                         ["width of 6 cm", "depth of 4 cm", "height of 0.5 cm"])
        # The same three sizes in another order are a different size: the axes differ.
        self.assertEqual(texts("Plate 60 x 40 x 5 mm. Plate 40 x 60 x 5 mm"),
                         ["60 mm", "40 mm", "5 mm"])
        self.assertEqual(texts("Plate 0.7 x 1.1 x 2.5 mm. Plate 2.5 x 0.7 x 1.1 mm"),
                         ["0.7 mm", "1.1 mm", "2.5 mm"])
        # A triple named as a feature does not compete with the part.
        self.assertEqual(texts("Plate 60 x 40 x 5 mm with a 80 x 50 x 1 mm pocket"),
                         part + ["80 mm", "50 mm", "1 mm"])

    def assertAllManual(self, spec, want):
        with self.subTest(spec=spec):
            result = extract("", spec, counter())
            self.assertEqual([r["text"] for r in result["requirements"]], want)
            self.assertEqual({r["check_method"] for r in result["requirements"]},
                             {"manual"})
            self.assertEqual({i["check_method"] for i in result["rubric_items"]},
                             {"manual"})

    def test_two_part_triples_both_go_to_the_reviewer(self):
        # The base is not the bracket's box, and neither is the plate once a boss or a
        # post stands on it: no triple is machine-checked as the part.
        self.assertAllManual("L-bracket: base 60 x 40 x 5 mm, upright 40 x 30 x 5 mm",
                             ["60 mm", "40 mm", "5 mm", "30 mm"])
        self.assertAllManual("Plate 60 x 40 x 5 mm with a boss 10 x 10 x 8 mm",
                             ["60 mm", "40 mm", "5 mm", "10 mm", "8 mm"])
        self.assertAllManual("Plate 60 x 40 x 5 mm with a 10 x 10 x 20 mm post",
                             ["60 mm", "40 mm", "5 mm", "10 mm", "20 mm"])

    def test_part_sizes_in_words_that_disagree_send_both_to_the_reviewer(self):
        self.assertAllManual("Width 80 mm, depth 50 mm. Block 60 x 40 x 5 mm",
                             ["80 mm", "50 mm", "60 mm", "40 mm", "5 mm"])
        self.assertAllManual("Plate 60 x 40 x 10 mm. Width 80 mm.",
                             ["60 mm", "40 mm", "10 mm", "80 mm"])
        # A feature size that does not keep its name still goes to the reviewer: "it".
        self.assertAllManual("Plate 60 x 40 x 10 mm with a slot. It is 5 mm wide.",
                             ["60 mm", "40 mm", "10 mm", "5 mm"])
        # Thickness is the Z size, as the verifier reads it.
        self.assertAllManual("Plate 60 x 40 x 5 mm, thickness 6 mm",
                             ["60 mm", "40 mm", "5 mm", "6 mm"])
        # With "length", width is the Y size. Only the words that disagree lose their
        # name: "length of 80 mm" agrees, so it is still checked.
        self.assertEqual(
            [(r["text"], r["check_method"]) for r in
             extract("", "Plate 80 x 50 x 6 mm, length of 80 mm, width of 60 mm",
                     counter())["requirements"]],
            [("80 mm", "manual"), ("50 mm", "manual"), ("6 mm", "manual"),
             ("length of 80 mm", "machine"), ("60 mm", "manual")])
        # A word size equal to another axis of the triple is the same number, unnamed.
        self.assertAllManual("Plate 60 x 40 x 5 mm, width 40 mm", ["60 mm", "40 mm", "5 mm"])
        # The prompt saying either size again does not bring a check back.
        for prompt in ("Plate 80 mm wide", "60 mm wide", "Width of 80 mm"):
            with self.subTest(prompt=prompt):
                result = extract(prompt, "Plate 60 x 40 x 10 mm. Width 80 mm.", counter())
                self.assertEqual([r["text"] for r in result["requirements"]],
                                 ["60 mm", "40 mm", "10 mm", "80 mm"])
                self.assertEqual({r["check_method"] for r in result["requirements"]},
                                 {"manual"})
        # A size in words left to the reviewer still contradicts the other text.
        self.assertEqual(
            contradictions("60 mm wide", "Plate 60 x 40 x 10 mm. Width 80 mm."),
            [("critical", "width: prompt says 60 mm but spec says 80 mm")])
        self.assertEqual(
            contradictions("Plate 80 mm wide", "Plate 60 x 40 x 10 mm. Width 80 mm."), [])
        # A feature size in words is not the part's, so it does not disagree.
        self.assertEqual(
            texts("Plate 60 x 40 x 5 mm. The pocket is 3 mm deep.", prompt="Width 60 mm"),
            ["width of 60 mm", "depth of 40 mm", "height of 5 mm", "pocket depth of 3 mm"])
        # Words that agree keep the triple the part.
        self.assertEqual(texts("Plate 60 x 40 x 5 mm, 60 mm wide, 5 mm thick"),
                         ["width of 60 mm", "depth of 40 mm", "height of 5 mm",
                          "thickness of 5 mm"])
        # A feature's size is not the part's.
        self.assertEqual(texts("Plate 60 x 40 x 5 mm, slot width 6 mm")[:3],
                         ["width of 60 mm", "depth of 40 mm", "height of 5 mm"])

    def test_part_sizes_in_the_other_text_are_a_contradiction_not_an_unnaming(self):
        self.assertEqual(texts("Plate 60 x 40 x 5 mm", prompt="width of 80 mm"),
                         ["width of 60 mm", "depth of 40 mm", "height of 5 mm",
                          "width of 80 mm"])
        self.assertEqual(
            contradictions("width of 80 mm", "Plate 60 x 40 x 5 mm"),
            [("critical", "width: prompt says 80 mm but spec says 60 mm")])

    def test_cut_outs_windows_and_openings_are_features(self):
        for prompt in ("a 20 x 10 x 3 mm cut-out", "two 20 x 10 x 3 mm cut-outs",
                       "a cutout of 20 x 10 x 3 mm", "a window 20 x 10 x 3 mm",
                       "two 20 x 10 x 3 mm windows", "an opening of 20 x 10 x 3 mm",
                       "Opening, 20 x 10 x 3 mm"):
            self.assertFeature(prompt)
        # Beside the part in one text, the plate stays the part.
        for feature in ("a 20 x 10 x 3 mm cut-out", "a window 20 x 10 x 3 mm",
                        "an opening of 20 x 10 x 3 mm"):
            with self.subTest(feature=feature):
                self.assertEqual(texts(f"Plate 60 x 40 x 5 mm with {feature}"),
                                 ["width of 60 mm", "depth of 40 mm", "height of 5 mm",
                                  "20 mm", "10 mm", "3 mm"])
        # "Cut out" in two words is the verb.
        self.assertPart("Cut out 80 x 50 x 6 mm plate")

    def test_a_feature_size_after_a_comma_is_the_feature_size(self):
        part = ["width of 60 mm", "depth of 40 mm", "height of 5 mm"]
        self.assertEqual(
            texts("Plate 60 x 40 x 5 mm with a 20 x 10 mm pocket, 3 mm deep"),
            part + ["10 mm", "pocket depth of 3 mm"])
        self.assertEqual(texts("Plate 60 x 40 x 5 mm with a pocket, 3 mm deep"),
                         part + ["pocket depth of 3 mm"])
        self.assertEqual(texts("Plate 60 x 40 x 5 mm with a pocket, depth 3 mm"),
                         part + ["pocket depth of 3 mm"])
        self.assertEqual(texts("Pocket 20 x 10 mm, 3 mm deep"),
                         ["10 mm", "pocket depth of 3 mm"])
        self.assertEqual(texts("Plate with a recess; 3 mm deep"), ["recess depth of 3 mm"])
        self.assertEqual(texts("Plate with a 20 mm cut-out, 3 mm deep"),
                         ["20 mm", "cutout depth of 3 mm"])
        # "cut-out" names the size it qualifies, hyphen or not.
        for text in ("Plate 60 x 40 x 5 mm with a cut-out 3 mm deep",
                     "Plate 60 x 40 x 5 mm, cut-out depth 3 mm",
                     "Plate 60 x 40 x 5 mm with a 3 mm deep cut-out",
                     "Plate 60 x 40 x 5 mm with a cutout 3 mm deep"):
            with self.subTest(text=text):
                self.assertEqual(texts(text), part + ["cutout depth of 3 mm"])
        # The lint scanner reads it the same way.
        self.assertEqual([q.label for q in extract_quantities("a pocket, 3 mm deep")],
                         ["pocket depth"])
        # A part noun before the comma, or a feature before a sentence end, does not.
        self.assertEqual(texts("Plate 60 mm wide, 5 mm thick"),
                         ["plate width of 60 mm", "thickness of 5 mm"])
        self.assertEqual(texts("Plate with four holes, 5 mm thick"),
                         ["4 holes", "thickness of 5 mm"])
        self.assertEqual(texts("Plate with a pocket. 5 mm thick."), ["thickness of 5 mm"])

    def test_a_feature_named_before_a_comma_takes_a_part_size_after_it(self):
        # Known limit: the look-back takes the last feature noun before the comma, so the
        # plate's width here is read as the slot's. That fails safe: no part check.
        self.assertEqual(texts("Plate with a slot, 60 mm wide"), ["slot width of 60 mm"])

    def test_a_feature_size_after_and_keeps_the_feature_name(self):
        part = ["width of 60 mm", "depth of 40 mm", "height of 10 mm"]
        self.assertEqual(texts("Plate 60 x 40 x 10 mm with a slot 40 mm long and 5 mm wide."),
                         part + ["slot length of 40 mm", "slot width of 5 mm"])
        self.assertEqual(texts("Plate 60 x 40 x 10 mm with a groove 2 mm deep and 3 mm wide."),
                         part + ["groove depth of 2 mm", "groove width of 3 mm"])
        self.assertEqual(texts("a slot 40 mm long and 5 mm wide"),
                         ["slot length of 40 mm", "slot width of 5 mm"])
        self.assertEqual(texts("a groove 2 mm deep and 3 mm wide"),
                         ["groove depth of 2 mm", "groove width of 3 mm"])
        # Along a chain, past a comma, and with the noun first.
        self.assertEqual(
            texts("Plate 60 x 40 x 10 mm with a slot 20 mm long, 6 mm wide and 3 mm deep"),
            part + ["slot length of 20 mm", "slot width of 6 mm", "slot depth of 3 mm"])
        self.assertEqual(texts("slot 20 mm long and 6 mm wide, and 3 mm deep"),
                         ["slot length of 20 mm", "slot width of 6 mm", "slot depth of 3 mm"])
        self.assertEqual(texts("slot length 20 mm and width 6 mm"),
                         ["slot length of 20 mm", "slot width of 6 mm"])
        # With link words after "and".
        self.assertEqual(texts("The pocket has a depth of 3 mm and a width of 20 mm."),
                         ["pocket depth of 3 mm", "pocket width of 20 mm"])
        self.assertEqual(texts("The slot is 40 mm long and is 5 mm wide."),
                         ["slot length of 40 mm", "slot width of 5 mm"])
        # The lint scanner reads it the same way.
        self.assertEqual([q.label for q in extract_quantities("a slot 40 mm long and 5 mm wide")],
                         ["slot length", "slot width"])

    def test_and_carries_only_a_feature_and_only_from_the_size_just_before(self):
        # A part size does not carry: these are the plate's.
        self.assertEqual(texts("Plate 60 mm wide and 40 mm deep"),
                         ["plate width of 60 mm", "depth of 40 mm"])
        # Not when "and" starts a new subject.
        self.assertEqual(texts("a slot 40 mm long and the plate is 5 mm thick"),
                         ["slot length of 40 mm", "thickness of 5 mm"])
        # Not across a sentence end.
        self.assertEqual(texts("A slot 40 mm long. And 5 mm thick."),
                         ["slot length of 40 mm", "thickness of 5 mm"])
        # Not across a triple.
        self.assertEqual(texts("a slot 40 mm long and 60 x 40 x 10 mm and 10 mm thick")[-1],
                         "thickness of 10 mm")

    def test_a_sentence_about_a_feature_sizes_the_feature(self):
        part = ["width of 60 mm", "depth of 40 mm", "height of 10 mm"]
        self.assertEqual(texts("Plate 60 x 40 x 10 mm. The pocket is 3 mm deep."),
                         part + ["pocket depth of 3 mm"])
        self.assertEqual(texts("The pocket is 3 mm deep."), ["pocket depth of 3 mm"])
        for sentence in ("The pocket must be 3 mm deep.", "The pocket shall be 3 mm deep.",
                         "The pocket in the plate is 3 mm deep.",
                         "The pocket has a depth of 3 mm.", "The pocket is to be 3 mm deep.",
                         "The pocket depth is 3 mm.", "The pockets are 3 mm deep.",
                         "A plate with a pocket that is 3 mm deep."):
            with self.subTest(sentence=sentence):
                self.assertEqual(texts(f"Plate 60 x 40 x 10 mm. {sentence}"),
                                 part + ["pocket depth of 3 mm"])
        # With "and" after it, both sizes are the pocket's.
        self.assertEqual(texts("Plate 60 x 40 x 10 mm. The pocket is 3 mm deep and 20 mm wide."),
                         part + ["pocket depth of 3 mm", "pocket width of 20 mm"])
        # Mid-sentence, after the triple.
        self.assertEqual(texts("Plate 60 x 40 x 10 mm and the pocket is 3 mm deep."),
                         part + ["pocket depth of 3 mm"])
        # The lint scanner reads it the same way.
        self.assertEqual([q.label for q in extract_quantities("The pocket is 3 mm deep.")],
                         ["pocket depth"])

    def test_a_sentence_about_the_part_sizes_the_part(self):
        self.assertEqual(texts("The plate with a pocket is 10 mm thick."),
                         ["thickness of 10 mm"])
        self.assertEqual(texts("A plate that is 10 mm thick with a pocket."),
                         ["thickness of 10 mm"])
        self.assertEqual(texts("The plate is 10 mm thick and the pocket is 3 mm deep."),
                         ["thickness of 10 mm", "pocket depth of 3 mm"])
        self.assertEqual(texts("The pocket is 3 mm deep and the plate is 10 mm thick."),
                         ["pocket depth of 3 mm", "thickness of 10 mm"])
        # The subject is read only in the size's own sentence.
        self.assertEqual(texts("The pocket is square. 3 mm thick."), ["thickness of 3 mm"])

    def test_a_feature_size_that_keeps_no_name_is_read_as_the_part(self):
        # Known limits: the subject is read only across link words ("is", "must be",
        # "has a"), the head of a compound is its last word, and "hole" is not a feature
        # noun, so these sizes are read as the part's. With a plate triple they disagree
        # with, both go to the reviewer; with none, nothing catches them.
        self.assertEqual(texts("The slot is centred and 5 mm wide."), ["width of 5 mm"])
        self.assertEqual(texts("The pocket floor is 3 mm thick."), ["thickness of 3 mm"])
        self.assertEqual(texts("Holes 5 mm deep and 3 mm wide"),
                         ["hole depth of 5 mm", "width of 3 mm"])
        self.assertAllManual("Plate 60 x 40 x 10 mm. The slot is centred and 5 mm wide.",
                             ["60 mm", "40 mm", "10 mm", "5 mm"])

    def test_a_size_heading_does_not_look_back(self):
        for text in ("Plate with a pocket. Dimensions: 80 x 50 x 6 mm",
                     "Plate with a slot. Size: 80 x 50 x 6 mm",
                     "Plate with a pocket. Dimensions 80 x 50 x 6 mm",
                     "Plate with a pocket.\nSize 80 x 50 x 6 mm"):
            self.assertPart(text)
        # A clause that says more than the heading still looks back.
        self.assertFeature("Pocket; the size is 20 x 10 x 3 mm")

    def test_holes_are_not_what_a_triple_sizes(self):
        for text in ("Plate with four holes. Dimensions: 80 x 50 x 6 mm",
                     "Plate with four holes, 80 x 50 x 6 mm",
                     "Plate with four holes. 80 x 50 x 6 mm",
                     "A plate with four holes that is 80 x 50 x 6 mm"):
            with self.subTest(text=text):
                self.assertEqual(texts(text), ["4 holes", *self.PART])

    def test_without_a_copula_the_word_before_the_link_is_sized(self):
        for prompt in ("A bracket with a pocket of 20 x 10 x 3 mm",
                       "A plate with a pocket measuring 20 x 10 x 3 mm",
                       "A plate with a pocket sized to 20 x 10 x 3 mm"):
            self.assertFeature(prompt)

    def test_a_cut_is_read_as_the_verb(self):
        # Known limit: "cut" reads as the verb ("cut 80 x 50 x 6 mm plate"), so a
        # rectangular cut with no noun after it is taken for the part.
        self.assertEqual(texts("rectangular cut 20 x 10 x 3 mm"),
                         ["width of 20 mm", "depth of 10 mm", "height of 3 mm"])

    def test_a_number_in_a_triple_is_read_once(self):
        self.assertEqual(
            texts("Rectangular plate 60 x 40 x 5 mm thick with four mounting holes of "
                  "5 mm diameter."),
            ["width of 60 mm", "depth of 40 mm", "height of 5 mm", "4 mounting holes",
             "mounting hole diameter of 5 mm"])

    def test_units(self):
        self.assertEqual(
            texts("Block 6 x 4 x 0.5 cm"),
            ["width of 6 cm", "depth of 4 cm", "height of 0.5 cm"])
        self.assertEqual(texts("mix 60 x 40 x 5 kg"), [])
        self.assertEqual(texts("section 60 x 40 x 5 mm²"), [])
        self.assertEqual(len(texts("a 60x40x5 L-bracket")), 3)

    def test_the_lint_scanner_does_not_read_triples(self):
        self.assertEqual(extract_quantities("Plate 60 x 40 x 5 mm"), [])


class HoleCounts(unittest.TestCase):
    def test_counts(self):
        self.assertEqual(texts("Plate with 4 holes."), ["4 holes"])
        self.assertEqual(texts("four mounting holes"), ["4 mounting holes"])
        self.assertEqual(texts("4 x M4 through holes"), ["4 through holes"])
        self.assertEqual(texts("one hole"), ["1 hole"])

    def test_kind_and_value(self):
        (req,) = extract("", "4 holes", counter())["requirements"]
        self.assertEqual(
            (req["kind"], req["value"], req["label"], req["check_method"]),
            ("hole", "4", "hole count", "machine"))

    def test_a_qualified_count_is_not_the_total(self):
        # "4 mounting holes" does not say there are no other holes.
        (req,) = extract("", "4 mounting holes", counter())["requirements"]
        self.assertEqual(
            (req["kind"], req["value"], req["label"], req["check_method"]),
            ("hole", "4", "mounting hole count", "manual"))

    def test_a_count_beside_an_uncounted_hole_is_not_the_total(self):
        for spec in ("Plate 60 x 40 x 10 mm with 4 mounting holes plus a central bore.",
                     "Plate 60 x 40 x 10 mm with 4 holes plus a central bore.",
                     "Plate 60 x 40 x 10 mm with 4 holes and an additional hole in the "
                     "middle.",
                     "Plate 60 x 40 x 10 mm with 4 holes and a 12 mm centre hole",
                     "Plate 60 x 40 x 10 mm with 4 holes. The centre hole is larger."):
            with self.subTest(spec=spec):
                result = extract("", spec, counter())
                (count,) = [r for r in result["requirements"] if r["kind"] == "hole"]
                self.assertEqual(count["check_method"], "manual")
                with mock.patch.dict(os.environ, {"GAUGE_CAD_EXEC": "0"}):
                    verdicts = verify(packet("", spec, FIVE_HOLES))
                self.assertEqual([v["status"] for v in verdicts], ["pass"] * 3)

    def test_the_counted_holes_mentioned_again_are_not_more_holes(self):
        for spec in ("Plate with 4 holes, hole diameter 5 mm. Each hole is 10 mm from "
                     "the edge and the holes are round.",
                     "4 holes of 5 mm diameter; all holes on a 40 mm hole pattern"):
            with self.subTest(spec=spec):
                (count,) = [r for r in extract("", spec, counter())["requirements"]
                            if r["kind"] == "hole"]
                self.assertEqual((count["text"], count["check_method"]),
                                 ("4 holes", "machine"))

    def test_the_same_count_stated_twice_is_two_sets_of_holes(self):
        result = extract("", "1 hole of 5 mm diameter plus 1 hole of 6 mm diameter",
                         counter())
        self.assertEqual(
            [(r["text"], r["check_method"]) for r in result["requirements"]
             if r["kind"] == "hole"],
            [("1 hole", "manual"), ("1 hole", "manual")])
        # In the prompt too, and whatever the spec says.
        result = extract("1 hole of 5 mm plus 1 hole of 6 mm", "2 holes", counter())
        self.assertEqual(
            [(r["text"], r["check_method"]) for r in result["requirements"]
             if r["kind"] == "hole"],
            [("2 holes", "manual"), ("1 hole", "manual"), ("1 hole", "manual")])

    def test_a_count_that_points_back_is_the_same_count(self):
        for spec in ("4 holes. Each of the 4 holes is round.",
                     "All four holes are round. Plate with 4 holes.",
                     "4 holes, and these 4 holes are equally spaced"):
            with self.subTest(spec=spec):
                result = extract("", spec, counter())
                self.assertEqual(
                    [(r["text"], r["check_method"]) for r in result["requirements"]],
                    [("4 holes", "machine")])
        # A different number is not the same count.
        self.assertEqual(texts("4 holes; the 2 holes on the left"), ["4 holes", "2 holes"])

    def test_a_size_is_not_a_count(self):
        self.assertEqual(texts("5 mm holes"), ["5 mm"])

    def test_several_counts_are_left_to_the_reviewer(self):
        # The verifier counts every hole in the reference: neither number is that total
        # for certain, so neither may fail a correct reference.
        for spec in ("4 mounting holes of 5 mm diameter and 1 center hole",
                     "4 holes; the two holes on the short side are 20 mm apart"):
            with self.subTest(spec=spec):
                result = extract("", spec, counter())
                counts = [r for r in result["requirements"] if r["kind"] == "hole"]
                self.assertEqual(len(counts), 2)
                self.assertEqual({r["check_method"] for r in counts}, {"manual"})
                with mock.patch.dict(os.environ, {"GAUGE_CAD_EXEC": "0"}):
                    verdicts = verify(packet("", spec, PLATE))
                self.assertNotIn("fail", [v["status"] for v in verdicts])
                self.assertFalse([v for v in verdicts if "count" in v["detail"]])

    def test_one_count_said_twice_is_still_machine(self):
        result = extract("four mounting holes", "4 holes. Each of the 4 holes is round.",
                         counter())
        self.assertEqual(
            [(r["text"], r["check_method"]) for r in result["requirements"]],
            [("4 holes", "machine")])

    def test_only_holes_are_counted(self):
        self.assertEqual(texts("3 ribs and 2 slots"), [])


class PromptAndSpec(unittest.TestCase):
    def test_the_prompt_is_read_when_there_is_no_spec(self):
        result = extract("A plate 60 mm wide with 4 holes.", None, counter())
        self.assertEqual(
            [(r["text"], r["source"]) for r in result["requirements"]],
            [("plate width of 60 mm", "prompt"), ("4 holes", "prompt")])

    def test_the_spec_comes_first_and_the_prompt_adds_what_it_lacks(self):
        result = extract(
            "A plate 60 mm wide with 4 holes.", "width of 60 ± 0.1 mm, depth of 40 mm",
            counter())
        self.assertEqual(
            [(r["text"], r["tolerance"], r["source"]) for r in result["requirements"]],
            [("width of 60 mm", "±0.1 mm", "spec"), ("depth of 40 mm", None, "spec"),
             ("4 holes", None, "prompt")])

    def test_a_tolerance_only_the_prompt_gives_is_kept(self):
        self.assertEqual(
            reqs("width of 60 mm", prompt="width of 60 ± 0.1 mm"),
            [("width of 60 mm", "±0.1 mm")])

    def test_the_prompt_restating_the_spec_in_other_words_adds_nothing(self):
        spec = "Plate 60 x 40 x 10 mm with 4 holes of 5 mm diameter."
        self.assertEqual(
            texts(spec, prompt="Model a mounting plate 60 mm wide with four mounting "
                               "holes, 5 mm diameter, and a fillet radius of 2 mm."),
            texts(spec) + ["fillet radius of 2 mm"])

    def test_a_nameless_length_the_spec_already_states_adds_nothing(self):
        spec = "width of 60 mm, depth of 40 mm"
        self.assertEqual(
            texts(spec, prompt="Model a 60 mm plate, 40 mm across, 3 mm chamfers."),
            texts(spec) + ["3 mm"])

    def test_a_contradiction_stays_two_requirements(self):
        self.assertEqual(
            texts("width of 50 mm", prompt="width of 60 mm"),
            ["width of 50 mm", "width of 60 mm"])
        findings = lint(packet("width of 60 mm", "width of 50 mm"))
        self.assertIn("value_contradiction", [f["rule"] for f in findings])


def contradictions(prompt, spec):
    return [(f["severity"], f["detail"]) for f in lint(packet(prompt, spec))
            if f["rule"] == "value_contradiction"]


class Contradictions(unittest.TestCase):
    """value_contradiction groups quantities the way extraction does."""

    def test_a_qualified_box_size_is_the_box_size(self):
        self.assertEqual(
            contradictions("A plate 60 mm wide", "width of 50 mm"),
            [("critical", "width: prompt says 60 mm but spec says 50 mm")])
        self.assertEqual(
            len(contradictions("a mounting plate 60 mm wide", "plate width of 50 mm")), 1)

    def test_a_triple_is_compared_by_axis(self):
        self.assertEqual(
            contradictions("Plate 60 x 40 x 5 mm", "Plate 60 x 45 x 5 mm"),
            [("critical", "depth: prompt says 40 mm but spec says 45 mm")])
        self.assertEqual(
            contradictions("Plate 60 x 40 x 5 mm", "width of 50 mm, depth of 40 mm"),
            [("critical", "width: prompt says 60 mm but spec says 50 mm")])
        self.assertEqual(
            contradictions("A plate 55 mm wide", "Plate 60 x 40 x 5 mm"),
            [("critical", "width: prompt says 55 mm but spec says 60 mm")])
        # The axis names follow what the task calls its sizes.
        self.assertEqual(
            contradictions("Plate 80 x 50 x 6 mm", "length of 80 mm, width of 60 mm"),
            [("critical", "width: prompt says 50 mm but spec says 60 mm")])

    def test_added_qualifiers_are_the_same_size(self):
        self.assertEqual(
            contradictions("four mounting holes of 6 mm diameter",
                           "4 holes, hole diameter 5 mm"),
            [("critical", "mounting hole diameter: prompt says 6 mm but spec says 5 mm")])

    def test_agreement_is_not_flagged(self):
        for prompt, spec in (
                ("A plate 60 mm wide", "width of 60 mm"),
                ("A plate 6 cm wide", "Plate 60 x 40 x 5 mm"),
                ("Plate 60 x 40 x 5 mm", "Plate 60 mm x 40 mm x 5 mm"),
                ("mounting hole diameter 5 mm",
                 "hole diameter 5 mm, counterbore hole diameter 9 mm"),
        ):
            with self.subTest(prompt=prompt, spec=spec):
                self.assertEqual(contradictions(prompt, spec), [])

    def test_a_feature_size_is_not_the_part_size(self):
        for prompt, spec in (
                ("slot length 20 mm", "length of 80 mm"),
                ("Plate 80 x 50 x 6 mm with a slot", "slot length 20 mm, slot width 6 mm"),
                ("shaft diameter 10 mm", "hole diameter 5 mm"),
                ("wall thickness 2 mm", "thickness of 5 mm"),
        ):
            with self.subTest(prompt=prompt, spec=spec):
                self.assertEqual(contradictions(prompt, spec), [])

    def test_counts(self):
        self.assertEqual(
            contradictions("4 holes", "5 holes"),
            [("critical", "hole count: prompt says 4 but spec says 5")])
        for prompt, spec in (
                ("1 hole of 5 mm plus 1 hole of 6 mm", "2 holes"),
                ("4 mounting holes", "5 holes"),
                ("4 holes. Each of the 4 holes is round.", "4 holes"),
        ):
            with self.subTest(prompt=prompt, spec=spec):
                self.assertEqual(contradictions(prompt, spec), [])


class Rubric(unittest.TestCase):
    def test_one_item_per_criterion(self):
        for spec in ("", "width of 60 mm"):
            items = extract("", spec)["rubric_items"]
            self.assertEqual([i["criterion"] for i in items], list(CRITERIA))
            for item in items:
                self.assertTrue(item["text"].startswith(item["criterion"] + ":"))
                self.assertIn(item["check_method"], ("machine", "manual"))

    def test_correct_reference_is_machine_over_every_machine_requirement(self):
        result = extract("", "Plate 60 x 40 x 5 mm with 4 holes, 12 mm, pitch 2 mm",
                         counter())
        machine = [r["id"] for r in result["requirements"] if r["check_method"] == "machine"]
        self.assertEqual(len(machine), 4)
        self.assertEqual(len(result["requirements"]), 6)
        for item in result["rubric_items"]:
            if item["criterion"] == "correct_reference":
                self.assertEqual(item["check_method"], "machine")
                self.assertEqual(item["requirement_ids"], machine)
            else:
                self.assertEqual(item["check_method"], "manual")
                self.assertEqual(item["requirement_ids"], [])

    def test_ids_are_unique(self):
        result = extract("", "Plate 60 x 40 x 5 mm with 4 holes")
        ids = [x["id"] for x in result["requirements"] + result["rubric_items"]]
        self.assertEqual(len(set(ids)), len(ids))

    def test_version(self):
        self.assertEqual(extract("", "")["version"], EXTRACT_VERSION)
        self.assertTrue(EXTRACT_VERSION)


SPECS = [
    "Plate 60 x 40 x 10 mm with 4 holes of 5 mm diameter.",
    "Plate 60 mm wide, 40 mm deep, 10 mm tall, four mounting holes, hole diameter 5 ± 0.1 mm",
    "Block 80 x 50 x 6 mm, length of 80 mm, slot length 20 mm, fillet radius 2 mm",
    "inside diameter 10 mm, external diameter of 20 mm, wall thickness = 2mm, 6 cm long",
    "2 through holes, 1 hole, holes 5 mm deep, 12 mm, pitch 2 mm",
    "Plate 60 x 40 x 10 mm with a 20 x 10 mm pocket, 3 mm deep",
    "Plate 60 x 40 x 10 mm with a recess, depth 3 mm",
    "Plate 60 x 40 x 10 mm. The pocket is 3 mm deep.",
    "Plate 60 x 40 x 10 mm with a slot 40 mm long and 5 mm wide.",
    "Plate 60 x 40 x 10 mm with a groove 2 mm deep and 3 mm wide.",
]


class RoundTrip(unittest.TestCase):
    """What is extracted is read back by the linter and the verifier as it was meant."""

    def test_the_verifier_reads_back_each_machine_requirement(self):
        for spec in SPECS:
            for req in extract("", spec, counter())["requirements"]:
                if req["check_method"] != "machine":
                    continue
                with self.subTest(spec=spec, requirement=req["text"]):
                    requirement = Requirement(
                        req["id"], req["text"], req["kind"], req["value"], req["tolerance"])
                    (expected,) = _expected(RubricItem("i", "", req["id"]), requirement)
                    self.assertEqual(expected.label, req["label"])
                    (quantity,) = extract_quantities(req["text"])
                    self.assertAlmostEqual(expected.value, quantity.base)

    def test_the_linter_agrees_with_every_check_method(self):
        for spec in SPECS:
            with self.subTest(spec=spec):
                rules = [f["rule"] for f in lint(packet("", spec))]
                self.assertNotIn("check_method", rules)
                self.assertNotIn("value_contradiction", rules)

    def test_the_verifier_passes_a_matching_reference(self):
        with mock.patch.dict(os.environ, {"GAUGE_CAD_EXEC": "0"}):
            verdicts = verify(packet("", SPECS[0], PLATE))
        self.assertEqual(len(verdicts), 5)  # width, depth, height, count, diameter
        for verdict in verdicts:
            self.assertEqual(verdict["status"], "pass", verdict["detail"])

    def test_a_feature_depth_after_a_comma_is_not_checked_as_the_part(self):
        spec = "Plate 60 x 40 x 10 mm with a 20 x 10 mm pocket, 3 mm deep"
        with mock.patch.dict(os.environ, {"GAUGE_CAD_EXEC": "0"}):
            verdicts = verify(packet("", spec, PLATE))
        # The plate's three sizes pass; the pocket depth has no check, so it is not run.
        self.assertEqual([v["status"] for v in verdicts],
                         ["pass", "pass", "pass", "not_run"])
        self.assertIn("pocket depth", verdicts[3]["detail"])

    def test_feature_sizes_in_words_are_not_checked_as_the_part(self):
        for spec, features in (
                ("Plate 60 x 40 x 10 mm. The pocket is 3 mm deep.", ["pocket depth"]),
                ("Plate 60 x 40 x 10 mm with a slot 40 mm long and 5 mm wide.",
                 ["slot length", "slot width"]),
                ("Plate 60 x 40 x 10 mm with a groove 2 mm deep and 3 mm wide.",
                 ["groove depth", "groove width"])):
            with self.subTest(spec=spec):
                with mock.patch.dict(os.environ, {"GAUGE_CAD_EXEC": "0"}):
                    verdicts = verify(packet("", spec, PLATE))
                # The plate's three sizes pass; the feature sizes have no check.
                self.assertEqual([v["status"] for v in verdicts],
                                 ["pass"] * 3 + ["not_run"] * len(features))
                for verdict, feature in zip(verdicts[3:], features):
                    self.assertIn(feature, verdict["detail"])

    def test_the_verifier_fails_a_wrong_size(self):
        spec = "Plate 60 x 45 x 10 mm with 3 holes."
        with mock.patch.dict(os.environ, {"GAUGE_CAD_EXEC": "0"}):
            verdicts = verify(packet("", spec, PLATE))
        self.assertEqual(
            [v["status"] for v in verdicts], ["pass", "fail", "pass", "fail"])


class Service(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import main  # verify/service/main.py

        cls.server = HTTPServer(("127.0.0.1", 0), main.Handler)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def post(self, body):
        data = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            self.base + "/extract", data=data, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read())

    def test_extract(self):
        status, body = self.post(
            {"prompt": "Model a plate.", "spec": "Plate 60 x 40 x 5 mm with 4 holes."})
        self.assertEqual(status, 200)
        self.assertEqual(set(body), {"version", "requirements", "rubric_items"})
        self.assertEqual(body["version"], EXTRACT_VERSION)
        self.assertEqual(
            [r["text"] for r in body["requirements"]],
            ["width of 60 mm", "depth of 40 mm", "height of 5 mm", "4 holes"])
        self.assertEqual(
            {i["criterion"]: i["check_method"] for i in body["rubric_items"]},
            {c: "machine" if c == "correct_reference" else "manual" for c in CRITERIA})

    def test_spec_is_optional(self):
        for body in ({"prompt": "60 mm wide"}, {"prompt": "60 mm wide", "spec": None}):
            status, answer = self.post(body)
            self.assertEqual(status, 200)
            self.assertEqual([r["text"] for r in answer["requirements"]], ["width of 60 mm"])

    def test_bad_bodies(self):
        for body in (b"not json", [], {}, {"prompt": 5}, {"prompt": "x", "spec": 5}):
            with self.subTest(body=body):
                status, answer = self.post(body)
                self.assertEqual(status, 400)
                self.assertIn("error", answer)


if __name__ == "__main__":
    unittest.main()
