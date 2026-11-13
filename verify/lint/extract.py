"""Requirement extraction: the one place prose is read for numbers.

    from lint.extract import extract
    result = extract(prompt, spec)
    # {"version": ..., "requirements": [...], "rubric_items": [...]}

Everything that parses a prompt or a spec goes through the scanner in this module: the
requirements a task is stored with (`extract`, served as POST /extract), the quantities
the value_contradiction lint rule compares, and the quantities the Verifier Pack reads
back out of a requirement's text (`extract_quantities`). The API does not parse anything.

Three things are read:

    dimensions   a length with a name: "width of 60 ± 0.1 mm", "5 mm diameter holes"
    triples      "60 x 40 x 5 mm", named by axis the way the verifier maps names to axes
    hole counts  "4 holes", "four mounting holes"

Two statements are one quantity when they have the same key (`quantity_key`). The
requirements and the value_contradiction lint rule both group on it (`stated_quantities`).

A length with no name ("60 mm") is also kept as a requirement, but nothing can check it.

Bump VERSION whenever a change here can alter what is extracted from the same text.
Standard library only.
"""
import re
import uuid
from collections import namedtuple

VERSION = "extract-6"

MACHINE = "machine"
VISUAL = "visual"
MANUAL = "manual"

# ------------------------------------------------------------------------------ vocabulary

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

# A triple adjacent to one of these is a feature (a pocket or slot inside the part), not
# the part itself, so it must not be named width/depth/height and compared with the part.
# Not "hole": a triple does not size a hole, and holes are named all around the part's
# own size ("Plate with four holes. Dimensions: 60 x 40 x 5 mm").
# "cut-out" is read as "cutout" (`_words`).
_FEATURE_NOUNS = frozenset({
    "pocket", "slot", "groove", "cutout", "notch", "recess", "cavity", "channel",
    "keyway", "bore", "counterbore", "countersink", "window", "opening",
})

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
    # The feature nouns, so a feature's size keeps its name when read back: a requirement
    # worded "recess depth of 3 mm" must not read back as the part's depth.
    **{noun: noun for noun in _FEATURE_NOUNS}, "cut-out": "cutout",
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

# The nouns that name a size the Verifier Pack has a check for. A requirement is tagged
# machine only when it is one of these, or a hole count that is certainly the total.
SIZE_NOUNS = ("width", "length", "height", "depth", "thickness", "diameter", "radius")

# The label `scan` gives a triple when another triple in the same text states a different
# size and neither is named as a feature: which one is the part, if either, is left to the
# reviewer.
_RIVAL = "rival triple"

# A clause that is only these and link words ("Dimensions: ...", "Size ...") states the
# size of the part, so no feature named before the previous break is read into it.
_SIZE_HEADINGS = frozenset({"overall", "dimension", "dimensions", "size", "sizes"})

# Words between a subject and the triple that state its size: "the plate is 80 x 50 x 6",
# "a pocket of 20 x 10 x 3", "plate sized to 80 x 50 x 6", "a pocket measuring ...".
_TRIPLE_LINKS = frozenset({
    "is", "are", "was", "were", "be", "of", "to", "at", "measuring", "measures", "measure",
    "sized", "size", "sizes", "dimension", "dimensions", "dimensioned", "overall",
    "nominal", "nominally", "exactly", "about", "around", "approximately", "approx",
    "appr", "ca", "circa", "nom", "roughly", "e.g", "eg", "i.e", "ie", "viz",
})

# The links that make the subject before them what is sized: "the pocket in the plate is
# 20 x 10 x 3 mm" sizes the pocket, the head of "the pocket in the plate".
_COPULAS = frozenset({"is", "are", "was", "were", "be", "measures", "measure"})
# Read past between the subject and its link: "the pocket must be ...".
_MODALS = frozenset({"must", "shall", "should", "will", "would", "can", "may", "to",
                     "need", "needs"})
# A relative pronoun before the link points at the noun just before it: "a plate with a
# pocket that is 20 x 10 x 3 mm" sizes the pocket.
_RELATIVES = frozenset({"that", "which"})

# Prepositions that end the head of a subject: "the pocket [in the plate]", "the plate
# [with a pocket]". Not "of": in "the footprint of the pocket" the pocket is sized.
_PREPOSITIONS = frozenset({
    "in", "on", "with", "for", "by", "into", "from", "at", "inside", "within",
    "near", "along", "across", "under", "below", "above", "beside", "behind", "between",
    "beneath", "onto", "over",
})

# Verbs that put a triple in front of what is made: "cut 80 x 50 x 6 mm plate", "mill a
# 20 x 10 x 3 mm pocket". Neither the verb nor the triple names anything by itself.
_TRIPLE_VERBS = frozenset({
    "cut", "mill", "milled", "machine", "machined", "make", "made", "add", "create",
    "include", "model", "form", "formed", "use",
})

# Words between a triple and the noun it sizes: "a 20 x 10 x 3 mm rectangular pocket".
# Only these are read past; any other word after the triple is taken as its noun.
_TRIPLE_MODIFIERS = frozenset({
    "rectangular", "square", "round", "circular", "rounded", "oblong", "deep", "shallow",
    "blind", "through", "open", "closed", "flat", "central", "centre", "center",
    "centred", "centered", "small", "large", "wide", "narrow", "long", "short",
})

# Words that are not the noun a triple describes: articles, determiners, number words,
# prepositions and connectors.
_NON_NOUNS = frozenset({
    "a", "an", "the", "with", "and", "or", "has", "have", "having", "in", "on", "for",
    "by", "into", "from", "each", "every", "both", "all", "its", "their", "this", "that",
    "these", "those", "x", *_NUMBER_WORDS,
})

# Where the words around a triple stop being about it: a sentence end or a comma. A
# full stop counts only before whitespace or the end of the text, so "6.5" is not one,
# and not after a common abbreviation, so "approx. 20 x 10 x 3 mm" is one clause.
# Each is also a link word (_TRIPLE_LINKS), so it is read past like "about".
_ABBREVIATIONS = ("approx", "appr", "ca", "nom", "e.g", "i.e", "eg", "ie", "viz")
_CLAUSE_BREAK = re.compile(
    r"[,;!?\n]|"
    + "".join(rf"(?<!\b(?i:{re.escape(a)}))" for a in _ABBREVIATIONS)
    + r"\.(?=\s|$)")

# A word of the text: "e.g" and "i.e" are one word each, not "e" and "g".
_WORD = re.compile(r"[A-Za-z](?:\.[A-Za-z])+(?![A-Za-z])|[A-Za-z]+")

# Sizes of the part as a whole, as opposed to the size of a feature on it.
_BOX_NOUNS = {"width", "length", "depth", "height", "thickness"}
_BOX_QUALIFIERS = {"plate", "base", "body", "board", "outer"}


def box_noun(label: str):
    """The noun of a label that names an overall size of the part ("plate width" ->
    "width", "mounting plate width" -> "width"), or None when the label names something
    else ("slot length")."""
    *qualifiers, noun = label.split()
    part = set(qualifiers) - {"mounting"}  # a "mounting plate" is still the plate
    if noun in _BOX_NOUNS and part <= _BOX_QUALIFIERS and (part or not qualifiers):
        return noun
    return None


def quantity_key(label: str) -> str:
    """The name two statements must share to be the same quantity: "plate width" and
    "width" are the same size of the same part, "slot length" and "length" are not."""
    return box_noun(label) or label


def label_parts(label: str) -> tuple:
    """(qualifiers, noun) of a label: "mounting hole diameter" -> ({"mounting", "hole"},
    "diameter"), "mounting hole count" -> ({"mounting"}, "hole count")."""
    words = label.split()
    cut = -2 if words[-1] == "count" else -1
    return frozenset(words[:cut]), " ".join(words[cut:])


def uses_length(labels) -> bool:
    """CadQuery calls the X size "length". A text that says "length" means X by it and Y
    by "width"; a text that does not means X by "width" and Y by "depth"."""
    return any(box_noun(label) == "length" for label in labels)


def axis_names(with_length: bool) -> tuple:
    """The names of the X, Y and Z sizes, in the convention `uses_length` describes."""
    return ("length", "width", "height") if with_length else ("width", "depth", "height")


# -------------------------------------------------------------------------------- patterns

def _alt(words) -> str:
    return "|".join(re.escape(w) for w in sorted(words, key=len, reverse=True))


_LENGTH_UNITS = [u for u, (dim, _) in _UNITS.items() if dim == "length"]
# After "A x B x C" these say the three numbers are not lengths. One-letter capitals are
# left out: "60x40x5 L-bracket" is not five litres.
_NOT_A_LENGTH = [
    u for u, (dim, _) in _UNITS.items()
    if dim != "length" and not (len(u) == 1 and u.isupper())
] + ["mm2", "mm^2", "mm²", "cm2", "cm^2", "cm²"]

_NUM = r"(?<![\w.])\d+(?:\.\d+)?"
_PLAIN_NUM = r"\d+(?:\.\d+)?"
_PM = r"(?:±|\+/-|\+-)"
_UNIT_END = r"(?![\w^²³])"  # "mm" is not the unit of "mm²" or "mm2"
_UNIT = rf"(?:{_alt(_UNITS)}){_UNIT_END}"
_LENGTH_UNIT = rf"(?:{_alt(_LENGTH_UNITS)}){_UNIT_END}"
_QUAL_RUN = rf"(?:(?:{_alt(_QUALIFIERS)})s?[\s-]+){{0,2}}"
# A tolerance is not a value. It is written before the unit ("60 ± 0.1 mm") or after it
# ("60 mm ± 0.1 mm").
_TOL = rf"(?:\s*{_PM}\s*(?P<tol>{_PLAIN_NUM}))?"
_TOL_AFTER = rf"(?:\s*{_PM}\s*(?P<tol2>{_PLAIN_NUM})(?:\s*(?P<tolunit>{_UNIT}))?)?"

# "60 x 40 x 5 mm", "60 mm x 40 mm x 5 mm", "60x40x5"
_TRIPLE = re.compile(
    rf"(?P<a>{_NUM})(?:\s*(?P<ua>{_LENGTH_UNIT}))?\s*[x×]\s*"
    rf"(?P<b>{_PLAIN_NUM})(?:\s*(?P<ub>{_LENGTH_UNIT}))?\s*[x×]\s*"
    rf"(?P<c>{_PLAIN_NUM})(?!\.?\d)"
    rf"(?:\s*(?P<uc>{_LENGTH_UNIT})|(?!\s*(?:{_alt(_NOT_A_LENGTH)}){_UNIT_END}))"
)

# "hole diameter: 5 mm", "width of 40 ± 0.1 mm", "wall thickness = 2mm"
_LABEL_FIRST = re.compile(
    rf"\b(?i:(?P<mods>{_QUAL_RUN})(?P<noun>{_alt(_NOUNS)}))\b"
    r"\s*(?i:(?:of|is|are|=|:|shall\s+be|must\s+be|should\s+be|to\s+be|be|at)\s*)?"
    r"(?i:(?:approximately|approx\.?|exactly|about|nominally)\s*)?"
    rf"(?P<num>{_NUM}){_TOL}(?:\s*(?P<unit>{_UNIT}){_TOL_AFTER})?"
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

# Words right before a count that point back at holes already stated: "each of the 4
# holes", "all four holes".
_BACK_REFERENCE = re.compile(r"\b(?:the|these|those|all|both|same)\s+$", re.IGNORECASE)

# A hole named outside a count: "a central bore", "a 12 mm centre hole", "slotted holes".
# Not "hole diameter 5 mm", which is a size, nor "each hole" and "the holes", which point
# back at the ones counted.
_HOLE_MENTION = re.compile(
    r"\bbores?\b|(?:\b(?P<before>[a-z]+)[\s-]+)?\b(?P<hole>holes?)\b"
    r"(?![\s-]+(?:diameter|dia|radius|depth|size|spacing|pitch|pattern|count|cent(?:er|re)s?"
    r"|positions?|locations?)\b)",
    re.IGNORECASE)
_HOLES_ALREADY_COUNTED = {"the", "these", "those", "all", "both", "each", "every", "per"}

# "60 mm" with nothing saying what it measures
_BARE = re.compile(rf"(?P<num>{_NUM}){_TOL}\s*(?P<unit>{_LENGTH_UNIT}){_TOL_AFTER}")

# ---------------------------------------------------------------------------------- scanner

LABELLED = "labelled"
COUNT = "count"
TRIPLE = "triple"
BARE = "bare"

# One number found in a text. `at` orders finds as they are read; `label` is None when
# the text does not say what the number measures; `tolerance` is (number, unit) or None;
# `axis` is the position (0, 1, 2) within a triple.
Found = namedtuple("Found", "at origin label number unit tolerance axis", defaults=(None,))
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
    for word in re.split(r"[\s-]+", _CUT_OUT.sub(r"\1\2", (run or "").strip())):
        if word:
            canon = _QUALIFIERS.get(_singular(word)) or _QUALIFIERS.get(word.lower())
            if canon:
                out.append(canon)
    return out


def _tolerance(m, unit):
    groups = m.groupdict()
    if groups.get("tol"):
        return groups["tol"], unit
    if groups.get("tol2"):
        return groups["tol2"], groups.get("tolunit") or unit
    return None


def _count_words(m):
    """The words between a count and its noun, or None when the match is not a count:
    "5 mm holes" and "2 mm thick ribs" are sizes."""
    mods = [w for w in re.split(r"[\s-]+", m.group("mods").strip()) if w]
    if any(w in _UNITS or w.lower() in _ADJECTIVES for w in mods):
        return None
    return mods


def mentions_uncounted_hole(text: str) -> bool:
    """True when the text names a hole that no count covers ("4 holes and a 12 mm centre
    hole", "a central bore"), so that no count it states is certainly the total. It errs
    towards True: that only leaves a count to the reviewer."""
    text = text or ""
    counted = [m.span() for m in _COUNT.finditer(text) if _count_words(m) is not None]
    for m in _HOLE_MENTION.finditer(text):
        if m.group("hole") is None:
            return True  # a bore
        if (m.group("before") or "").lower() in _HOLES_ALREADY_COUNTED:
            continue
        if not any(start <= m.start("hole") < end for start, end in counted):
            return True
    return False


def _feature_or_word(word: str) -> str:
    """A feature noun in its singular form ("pockets" -> "pocket", "notches" -> "notch",
    "cavities" -> "cavity"); any other word as it is."""
    for stem in (word, word[:-1] if word.endswith("s") else None,
                 word[:-2] if word.endswith("es") else None,
                 word[:-3] + "y" if word.endswith("ies") else None):
        if stem in _FEATURE_NOUNS:
            return stem
    return word


# "cut-out" is the noun "cutout"; "cut out" in two words stays the verb.
_CUT_OUT = re.compile(r"\b(cut)-(outs?)\b", re.IGNORECASE)


def _words(text) -> list:
    return [w.lower() for w in _WORD.findall(_CUT_OUT.sub(r"\1\2", text))]


def _subject_head(subject) -> str:
    """The head noun of the subject of "... is": the last word before the first
    preposition that follows a word naming something. "the pocket in the plate" ->
    "pocket", "the plate with a pocket" -> "plate", "on the top face the pocket" ->
    "pocket". "of" does not end it: "the footprint of the pocket" -> "pocket"."""
    head = ""
    for word in subject:
        if word in _PREPOSITIONS:
            if head:
                return head
            continue
        if word not in _NON_NOUNS | _TRIPLE_LINKS | _TRIPLE_VERBS:
            head = word
    return head


def _triple_noun(text, start, end, after_previous=0, before_next=None):
    """The noun a triple describes, singular and lower case, or "" when nothing names
    it. The clause the triple is in is read first, never past a sentence end or a comma:

        "Plate 80 x 50 x 6 mm", "two pockets 20 x 10 x 3 mm"     the word before
        "The plate is ...", "a pocket of ...", "... measuring"   the subject before the link
        "The pocket in the plate is ..."                         the head of that subject
        "a 20 x 10 x 3 mm rectangular pocket", "cut 80 x 50 x 6 mm aluminium plate"
                                                                 the noun phrase after

    When that clause names nothing, a feature noun just before the previous break is
    taken ("Pocket, 20 x 10 x 3 mm", "Pocket; 20 x 10 x 3 mm"). Only a feature noun:
    reading a part noun there gains nothing, and taking a part for a feature only leaves
    its sizes to the reviewer, while the reverse checks a feature as the part. Nothing is
    read back when the clause is a size heading ("Dimensions: 80 x 50 x 6 mm").

    Another triple ends the clause too: `after_previous` is where the triple before this
    one ends and `before_next` where the one after it starts, so in "The plate with a
    pocket is 60 x 40 x 10 mm and the pocket is 20 x 10 x 3 mm" the second triple's
    subject is "the pocket", not "the plate with a pocket ... and the pocket". The look
    back past a break is not cut: in "Two pockets, 20 x 10 x 3 mm and 15 x 10 x 3 mm"
    both triples are the pockets.
    """
    limit = len(text) if before_next is None else before_next
    breaks = list(_CLAUSE_BREAK.finditer(text, 0, start))
    clause_start = max(breaks[-1].end() if breaks else 0, after_previous)
    before = _words(text[clause_start:start])
    stop = _CLAUSE_BREAK.search(text, end, limit)
    after = _words(text[end:stop.start() if stop else limit])

    noun = _clause_noun(before, after)
    if noun or not breaks or "overall" in before or "overall" in after:
        # "Overall dimensions 80 x 50 x 6 mm" sizes the part whatever came before.
        return noun
    if (_SIZE_HEADINGS & set(before)) and set(before) <= _TRIPLE_LINKS | _SIZE_HEADINGS:
        # "Plate with a pocket. Dimensions: 80 x 50 x 6 mm" sizes the part. A clause
        # that says more ("Pocket; the size is ...") still looks back.
        return noun
    # The nearest word before the break, past any run of breaks ("Pocket.\n20 x ...").
    for i in range(len(breaks) - 1, -1, -1):
        previous = _words(text[breaks[i - 1].end() if i else 0:breaks[i].start()])
        if previous:
            word = _feature_or_word(previous[-1])
            return word if word in _FEATURE_NOUNS else ""
    return ""


def _clause_noun(before, after) -> str:
    """The noun a triple's own clause gives it: `before` and `after` are the clause's
    words on either side of the triple."""
    nearest = before[-1] if before else ""
    if nearest and nearest not in _NON_NOUNS | _TRIPLE_LINKS | _TRIPLE_VERBS:
        return _feature_or_word(nearest)
    if nearest in _TRIPLE_LINKS:
        # The subject precedes the triple: it is what is sized, whatever follows.
        links = len(before)
        while links and (before[links - 1] in _TRIPLE_LINKS
                         or before[links - 1] in _TRIPLE_VERBS
                         or before[links - 1] in _MODALS):
            links -= 1
        if _COPULAS & set(before[links:]):
            subject = before[:links]
            if subject and subject[-1] in _RELATIVES:
                # "... a pocket that is ...": the noun the pronoun points at.
                subject = [w for w in subject[:-1] if w not in _NON_NOUNS][-1:]
            # "The pocket in the plate is ...": the head of the subject, not its last word.
            head = _subject_head(subject)
            if head:
                return _feature_or_word(head)
        else:
            # "a pocket of ...", "a plate with a pocket measuring ...": the word before.
            word = before[links - 1] if links else ""
            if word and word not in _NON_NOUNS:
                return _feature_or_word(word)
    # The triple sizes the noun after it, read past known modifiers only, so a feature
    # named later ("plate including slots", "plate (slot ...)") is not taken for it.
    for word in after:
        if word in _TRIPLE_MODIFIERS or word in _TRIPLE_VERBS:
            continue
        if word in _NON_NOUNS or word in _TRIPLE_LINKS:
            break
        return _feature_or_word(word)
    return ""


# A comma or semicolon just before a size: what is sized may be named before it.
_LIST_BREAK = re.compile(r"[,;]\s*$")


def _feature_before(text, start) -> list:
    """[feature] for a size with no qualifier of its own that opens a clause after a comma
    or semicolon, when the clause before names a feature: "a 20 x 10 mm pocket, 3 mm deep"
    and "Pocket 20 x 10 mm, 3 mm deep" size the pocket, the last feature noun there. Else
    []. Only a feature noun, as for a triple: "Plate 60 mm wide, 5 mm thick" sizes the
    plate. Not past a sentence end: "Plate with a pocket. 5 mm thick." sizes the plate."""
    comma = _LIST_BREAK.search(text, 0, start)
    if not comma:
        return []
    breaks = list(_CLAUSE_BREAK.finditer(text, 0, comma.start()))
    clause = text[breaks[-1].end() if breaks else 0:comma.start()]
    for word in reversed(_words(clause)):
        word = _feature_or_word(word)
        if word in _FEATURE_NOUNS:
            return [word]
    return []


def _triple_sizes(m) -> tuple:
    """A triple's three sizes in mm."""
    last = m.group("uc") or "mm"
    return tuple(round(float(m.group(num)) * _UNITS[m.group(unit) or last][1], 9)
                 for num, unit in (("a", "ua"), ("b", "ub"), ("c", "uc")))


def _rival_triples(matches, nouns) -> list:
    """The indexes of the triples that would be named as the part but cannot be: one text
    gives the part one size, so when two triples neither named as a feature state
    different sizes, none of them is taken for the part. Not even the largest: an
    L-bracket's base and upright are both smaller than its box, and so is a plate with a
    boss or a post standing on it. The same size stated twice, in any unit, is one size."""
    candidates = [i for i, noun in enumerate(nouns)
                  if not (noun and _feature_or_word(noun) in _FEATURE_NOUNS)]
    if len({_triple_sizes(matches[i]) for i in candidates}) < 2:
        return []
    return candidates


def scan(text: str) -> list:
    """Every number the text states, most specific reading first: a later pattern never
    re-reads a number an earlier one claimed. Finds come back in pattern order (triples,
    labelled sizes, counts, bare lengths); sort on `at` for reading order. A triple's
    label is left None here, since its axis names depend on the rest of the task.

    A count is one find per statement: "4 holes ... 4 holes" is two, because they may be
    two sets of holes. A count that points back at one stated elsewhere ("4 holes. Each
    of the 4 holes is round.") is that statement again and is not a find."""
    text = text or ""
    found = []
    spans = []  # whole matches of triples and labelled quantities
    used = set()  # start offsets of numbers already claimed

    def claimed(start: int) -> bool:
        return start in used or any(s <= start < e for s, e in spans)

    matches = list(_TRIPLE.finditer(text))
    nouns = [
        _triple_noun(text, m.start(), m.end(),
                     matches[i - 1].end() if i else 0,
                     matches[i + 1].start() if i + 1 < len(matches) else None)
        for i, m in enumerate(matches)
    ]
    for i in _rival_triples(matches, nouns):
        nouns[i] = _RIVAL
    for m, noun in zip(matches, nouns):
        spans.append(m.span())
        last = m.group("uc") or "mm"
        for axis, (num, unit) in enumerate((("a", "ua"), ("b", "ub"), ("c", "uc"))):
            found.append(Found(
                (m.start(num), axis), TRIPLE, noun, m.group(num),
                m.group(unit) or last, None, axis))
    triples = list(spans)

    def in_triple(start: int) -> bool:
        return any(s <= start < e for s, e in triples)

    for m in _LABEL_FIRST.finditer(text):
        if in_triple(m.start("num")):
            continue
        quals = _qualifiers(m.group("mods")) or _feature_before(text, m.start())
        label = " ".join(quals + [_NOUNS[m.group("noun").lower()]])
        unit = m.group("unit")
        found.append(Found(
            (m.start("num"), 0), LABELLED, label, m.group("num"), unit,
            _tolerance(m, unit)))
        used.add(m.start("num"))
        spans.append(m.span())

    for m in _VALUE_FIRST.finditer(text):
        if m.start("num") in used or in_triple(m.start("num")):
            continue
        quals = (_qualifiers(m.group("post")) or _qualifiers(m.group("pre"))
                 or _feature_before(text, m.start()))
        label = " ".join(quals + [_ADJECTIVES[m.group("adj").lower()]])
        unit = m.group("unit")
        found.append(Found(
            (m.start("num"), 0), LABELLED, label, m.group("num"), unit,
            _tolerance(m, unit)))
        used.add(m.start("num"))
        spans.append((m.start("num"), m.end()))

    counts = []  # (find, it points back at something already stated)
    for m in _COUNT.finditer(text):
        if claimed(m.start("n")):
            continue
        mods = _count_words(m)
        if mods is None:
            continue
        kept = [
            w.lower() for w in mods
            if w.isalpha() and w.lower() not in _COUNT_FILLER  # drops M4-style tokens
        ]
        n = m.group("n").lower()
        label = " ".join(kept + [_singular(m.group("noun")), "count"])
        counts.append((
            Found((m.start("n"), 0), COUNT, label, str(_NUMBER_WORDS.get(n, n)), None, None),
            bool(_BACK_REFERENCE.search(text, 0, m.start("n")))))
        used.add(m.start("n"))

    def restated(i: int) -> bool:
        """A back-reference to the same number of the same thing, stated elsewhere."""
        find, points_back = counts[i]
        if not points_back:
            return False
        quals, noun = label_parts(find.label)
        for j, (other, other_points_back) in enumerate(counts):
            if j == i or other.number != find.number or (other_points_back and j > i):
                continue
            other_quals, other_noun = label_parts(other.label)
            if noun == other_noun and (quals <= other_quals or other_quals <= quals):
                return True
        return False

    found.extend(find for i, (find, _) in enumerate(counts) if not restated(i))

    for m in _BARE.finditer(text):
        if claimed(m.start("num")):
            continue
        unit = m.group("unit")
        found.append(Found(
            (m.start("num"), 0), BARE, None, m.group("num"), unit, _tolerance(m, unit)))
        spans.append(m.span())

    return found


def _quantity(label: str, number: str, unit) -> Quantity:
    raw = float(number)
    if unit:
        dim, factor = _UNITS[unit]
        return Quantity(label, raw, dim, raw * factor, f"{number} {unit}")
    return Quantity(label, raw, None, raw, number)


def extract_quantities(text: str) -> list:
    """Pull labelled quantities out of prose: dimensions and other values with a name
    ("width of 40 mm", "40 mm wide") and counts ("4 holes"). Bare numbers, tolerances,
    "A x B x C" triples and thread sizes such as M4 are ignored."""
    return [
        _quantity(f.label, f.number, f.unit)
        for f in scan(text) if f.origin in (LABELLED, COUNT)
    ]


# ----------------------------------------------------------------------------- requirements

def _is_length(unit) -> bool:
    return unit in _UNITS and _UNITS[unit][0] == "length"


def _read(prompt, spec) -> list:
    """Both texts, the spec first: [(source, [(label, find), ...])], each in reading
    order. A triple gets its axis names here, from what the whole task calls its sizes."""
    scans = [("spec", scan(spec)), ("prompt", scan(prompt))]
    with_length = uses_length(
        f.label for _, finds in scans for f in finds if f.origin == LABELLED)
    names = axis_names(with_length)
    out = []
    for source, finds in scans:
        overruled = _overruled_triples(finds, with_length)
        out.append((source, [
            (f.label if f.origin != TRIPLE
             else None if f in overruled else _triple_axis(f, names), f)
            for f in sorted(finds, key=lambda f: f.at)]))
    return out


def _triple_axis(f, names):
    """The axis name for a triple, or None when the triple is a feature (a pocket, slots)
    so it does not compete with the part's own width/depth/height."""
    return names[f.axis] if _names_the_part(f) else None


def _names_the_part(f) -> bool:
    """True when `scan` left a triple's find to be named as the part: neither a feature
    nor one of two rival sizes."""
    return not (f.label == _RIVAL
                or (f.label and _feature_or_word(f.label) in _FEATURE_NOUNS))


def _box_axes(with_length: bool) -> dict:
    """The axis (0, 1, 2) each overall size names, as the verifier reads it
    (verifiers.py): thickness is the Z size, and so is depth when X is the length."""
    if with_length:
        return {"length": 0, "width": 1, "height": 2, "thickness": 2, "depth": 2}
    return {"width": 0, "depth": 1, "height": 2, "thickness": 2}


def _mm(f) -> float:
    return round(float(f.number) * _UNITS[f.unit][1], 9)


def _overruled_triples(finds, with_length) -> set:
    """The finds of the part triples a text contradicts in words: "Width 80 mm, depth
    50 mm. Block 60 x 40 x 5 mm" gives the part two widths, and which one is meant is left
    to the reviewer, so the triple is not named as the part. The words keep their names.
    Only within one text: a size the other text states differently is a contradiction
    the value_contradiction rule reports."""
    axes = _box_axes(with_length)
    stated = {}  # axis -> the sizes the text gives it in words, in mm
    for f in finds:
        if f.origin == LABELLED and _is_length(f.unit):
            axis = axes.get(box_noun(f.label))
            if axis is not None:
                stated.setdefault(axis, set()).add(_mm(f))
    if not stated:
        return set()
    triples = []  # each triple's three finds; `scan` gives them in order, X first
    for f in finds:
        if f.origin == TRIPLE:
            if f.axis == 0:
                triples.append([])
            triples[-1].append(f)
    overruled = set()
    for triple in triples:
        if not _names_the_part(triple[0]):
            continue  # not named as the part anyway
        if any(stated.get(f.axis, {_mm(f)}) != {_mm(f)} for f in triple):
            overruled.update(triple)
    return overruled


def stated_quantities(prompt, spec) -> dict:
    """{"spec": [...], "prompt": [...]}: every named quantity each text states, as a
    Quantity labelled with its `quantity_key`, the name the requirements are grouped by.
    Unlike `extract_quantities` this reads triples, which only have names within a task."""
    return {
        source: [_quantity(quantity_key(label), f.number, f.unit)
                 for label, f in finds if label is not None]
        for source, finds in _read(prompt, spec)
    }


def _requirement(found: Found, label):
    """(dedupe key, requirement fields without id and source), or None when the find is
    not a requirement: a voltage, a rib count, a size with no unit."""
    if found.origin == COUNT:
        *mods, noun, _ = label.split()
        if noun != "hole":
            return None
        n = int(found.number)
        text = " ".join([found.number, *mods, "hole" if n == 1 else "holes"])
        return (label, float(n)), {
            "text": text, "kind": "hole", "value": found.number, "tolerance": None,
            "label": label, "check_method": MACHINE,
        }

    if not _is_length(found.unit):
        return None
    value = f"{found.number} {found.unit}"
    tolerance = f"±{found.tolerance[0]} {found.tolerance[1]}" if found.tolerance else None
    machine = label is not None and label.split()[-1] in SIZE_NOUNS
    key = (label and quantity_key(label),
           round(float(found.number) * _UNITS[found.unit][1], 9))
    return key, {
        "text": f"{label} of {value}" if label else value,
        "kind": "dimension", "value": value, "tolerance": tolerance,
        "label": label, "check_method": MACHINE if machine else MANUAL,
    }


def extract_requirements(prompt, spec, new_id=None) -> list:
    """The requirements a task states, each a dict with id, text, kind, value, tolerance,
    label, source and check_method.

    The spec is read first and then the prompt, each in reading order. A quantity both
    state with the same value is one requirement, worded as the spec words it; one they
    state with different values is two, and the value_contradiction lint rule reports
    it. The prompt is looser prose, so a value it gives for a noun the spec gives the
    same value for ("a mounting plate 60 mm wide" against "width of 60 mm") is taken as
    the spec's requirement said again, whatever qualifiers the prompt puts on it, and so
    is a length the prompt gives no name for when the spec states that value.

    A hole count one text states twice is two requirements: "1 hole of 5 mm and 1 hole of
    6 mm" is two holes, not one hole said twice. Only a count that points back at another
    ("each of the 4 holes") is that count again, and `scan` has already dropped it.

    The verifier counts every hole the reference makes, so a hole count is tagged machine
    only when it is certainly that total: the one hole count the task states, with no
    qualifier, in a task that mentions no hole besides. "4 mounting holes" says nothing
    about other holes, "4 holes and a central bore" has a fifth, and with several counts
    ("4 mounting holes and 1 centre hole", "the two holes on the short side") none of
    them is the total for certain. All of those are left to the reviewer."""
    new_id = new_id or (lambda: str(uuid.uuid4()))

    def loose(key):  # the noun without its qualifiers: "hole diameter" -> "diameter"
        label, value = key
        return (label and " ".join(label.split()[-2 if label.endswith(" count") else -1:]),
                value)

    by_key = {}
    in_spec = set()  # loose keys, and (None, value) for every length the spec states
    for source, finds in _read(prompt, spec):
        counted = set()  # the hole counts this text has stated so far
        for label, found in finds:
            built = _requirement(found, label)
            if built is None:
                continue
            key, fields = built
            again = fields["kind"] == "hole" and key in counted
            if again:
                # More holes, not the first count said twice: its own requirement.
                by_key[(*key, len(by_key))] = {"id": new_id(), **fields, "source": source}
                continue
            if fields["kind"] == "hole":
                counted.add(key)
            first = by_key.get(key)
            if first is not None:
                if first["tolerance"] is None:
                    first["tolerance"] = fields["tolerance"]
            elif source == "spec":
                by_key[key] = {"id": new_id(), **fields, "source": source}
                in_spec.add(loose(key))
                if fields["kind"] == "dimension":
                    in_spec.add((None, key[1]))
            elif loose(key) not in in_spec:
                by_key[key] = {"id": new_id(), **fields, "source": source}

    requirements = list(by_key.values())
    counts = [r for r in requirements if r["kind"] == "hole"]
    total = (len(counts) == 1 and counts[0]["label"] == "hole count"
             and not mentions_uncounted_hole(spec) and not mentions_uncounted_hole(prompt))
    if not total:
        for requirement in counts:
            requirement["check_method"] = MANUAL
    return requirements


# ----------------------------------------------------------------------------- rubric items

# The rubric is the five review criteria (apps/api/src/campaign/review-protocol.ts).
CRITERIA = ("verifiable", "unambiguous", "correct_reference", "complete_constraints",
            "difficulty")

# The wording matters. Every text opens with its criterion key, and the linter re-infers
# the check method from the words dimension, hole, volume and manifold (rules.py), so
# only a machine item may use them.
_MANUAL_TEXT = {
    "verifiable": "verifiable: the result can be checked objectively against the spec.",
    "unambiguous": "unambiguous: two solvers would read the spec the same way.",
    "correct_reference": "correct_reference: the reference solution satisfies the spec.",
    "complete_constraints":
        "complete_constraints: sizes and tolerances are fully specified, with no free "
        "parameters.",
    "difficulty": "difficulty: the task is hard enough to be worth solving.",
}
_MACHINE_TEXT = {
    "correct_reference":
        "correct_reference: the reference solution has every dimension the spec states.",
}


def rubric_items(requirements: list, new_id=None) -> list:
    """One rubric item per criterion, each with its check method.

    `correct_reference` is machine-checked against every machine requirement, listed in
    `requirement_ids`, and manual when there is none. The other criteria are manual."""
    new_id = new_id or (lambda: str(uuid.uuid4()))
    checkable = [r["id"] for r in requirements if r["check_method"] == MACHINE]
    items = []
    for criterion in CRITERIA:
        machine = bool(checkable) and criterion in _MACHINE_TEXT
        items.append({
            "id": new_id(),
            "criterion": criterion,
            "text": _MACHINE_TEXT[criterion] if machine else _MANUAL_TEXT[criterion],
            "check_method": MACHINE if machine else MANUAL,
            "requirement_ids": list(checkable) if machine else [],
            "weight": 1.0,
        })
    return items


def extract(prompt, spec=None, new_id=None) -> dict:
    """Turn a task's prompt and spec into its requirements and rubric items."""
    requirements = extract_requirements(prompt, spec, new_id)
    return {
        "version": VERSION,
        "requirements": requirements,
        "rubric_items": rubric_items(requirements, new_id),
    }


__all__ = [
    "VERSION", "MACHINE", "VISUAL", "MANUAL", "CRITERIA", "SIZE_NOUNS",
    "Found", "Quantity", "scan", "extract_quantities", "stated_quantities",
    "extract_requirements", "rubric_items", "extract", "box_noun", "quantity_key",
    "label_parts", "mentions_uncounted_hole", "uses_length", "axis_names",
]
