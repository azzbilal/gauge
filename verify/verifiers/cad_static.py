"""Static CadQuery reader for the M8 Verifier Pack.

Parses reference CadQuery source with `ast` (the code is never imported or executed) and
pulls out what can be known without a CAD kernel: box dimensions, circle radii, hole
diameters and how many holes each call makes. Anything that cannot be resolved to a
constant is recorded as None so the verifier can refuse to pass it. Standard library only.

CadQuery signatures relied on:
    box(length, width, height)      length along X, width along Y, height along Z
    circle(radius)                  hole(diameter), cboreHole(diameter, ...), cskHole(...)
    rect(xLen, yLen)                extrude(until)        cylinder(height, radius)
    pushPoints(pntList)             rarray(xSpacing, ySpacing, xCount, yCount)
    polarArray(radius, startAngle, angle, count)
"""
import ast
import math
import operator
from dataclasses import dataclass, field
from typing import Optional


class ReferenceError_(ValueError):
    """The reference code could not be parsed."""


@dataclass
class Box:
    dims: tuple  # (x, y, z); an entry is None when it is not a static constant
    repeated: bool = False  # built in a loop or once per stack point


@dataclass
class HoleGroup:
    count: Optional[int]  # None when the number of holes is not statically known
    diameter: Optional[float]
    via: str = "hole"  # the call that made it, for messages


@dataclass
class CadModel:
    boxes: list = field(default_factory=list)
    holes: list = field(default_factory=list)
    bosses: list = field(default_factory=list)  # radii of extruded circles / cylinders
    opaque: list = field(default_factory=list)  # calls that may add holes we cannot count

    @property
    def hole_count(self) -> Optional[int]:
        if self.opaque or any(g.count is None for g in self.holes):
            return None
        return sum(g.count for g in self.holes)


# ----------------------------------------------------------------- constant evaluation

class _Unresolved(Exception):
    pass


_BINOPS = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
    ast.Div: operator.truediv, ast.FloorDiv: operator.floordiv, ast.Mod: operator.mod,
    ast.Pow: operator.pow,
}


_MAX_MAGNITUDE = 1e12  # nothing a part dimension or a count legitimately reaches


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _bounded(value):
    """Reject inf, nan and absurd magnitudes so later arithmetic stays cheap and safe."""
    if isinstance(value, float) and not math.isfinite(value):
        raise _Unresolved
    if abs(value) > _MAX_MAGNITUDE:
        raise _Unresolved
    return value


def _eval(node, env):
    """Evaluate a constant expression: numbers, names bound to constants, arithmetic,
    and list/tuple literals (unresolved elements become None)."""
    if isinstance(node, ast.Constant):
        if _is_number(node.value):
            return _bounded(node.value)
        raise _Unresolved
    if isinstance(node, ast.Name):
        value = env.get(node.id)
        if value is None:
            raise _Unresolved
        return value
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
        value = _eval(node.operand, env)
        if not _is_number(value):
            raise _Unresolved
        return -value if isinstance(node.op, ast.USub) else value
    if isinstance(node, ast.BinOp) and type(node.op) in _BINOPS:
        left, right = _eval(node.left, env), _eval(node.right, env)
        if not (_is_number(left) and _is_number(right)):
            raise _Unresolved
        if isinstance(node.op, ast.Pow) and (abs(right) > 64 or abs(left) > 1e6):
            raise _Unresolved
        try:
            result = _BINOPS[type(node.op)](left, right)
        except (ArithmeticError, ValueError):
            raise _Unresolved
        if not _is_number(result):  # e.g. complex from a negative base
            raise _Unresolved
        return _bounded(result)
    if isinstance(node, (ast.Tuple, ast.List)):
        if any(isinstance(e, ast.Starred) for e in node.elts):
            raise _Unresolved
        out = []
        for element in node.elts:
            try:
                out.append(_eval(element, env))
            except _Unresolved:
                out.append(None)
        return out
    if (isinstance(node, ast.Attribute) and node.attr == "pi"
            and isinstance(node.value, ast.Name) and node.value.id == "math"):
        return math.pi
    raise _Unresolved


# ------------------------------------------------------------------------- extraction

_HOLE_CALLS = {"hole", "cboreHole", "cskHole"}
_CUT_CALLS = {"cutThruAll", "cutBlind"}
# Selecting geometry puts an unknown number of objects on the stack.
_SELECTORS = {"faces", "edges", "wires", "solids", "shells", "add", "newObject"}
# A fresh workplane has exactly one point on the stack.
_RESETS = {"Workplane", "workplane", "moveTo", "center", "workplaneFromTagged", "copyWorkplane"}
_OTHER_PROFILES = {"polygon", "ellipse", "slot2D", "polyline", "close", "spline", "text"}
# Calls that can add or multiply holes in ways this reader does not follow.
_OPAQUE = {"cut", "cutEach", "eachpoint", "each", "mirror", "intersect"}
_LOOPS = (ast.For, ast.AsyncFor, ast.While)
_COMPREHENSIONS = (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp, ast.Lambda)


def _arg(call, index, *names):
    if index < len(call.args) and not any(
        isinstance(a, ast.Starred) for a in call.args[: index + 1]
    ):
        return call.args[index]
    for keyword in call.keywords:
        if keyword.arg in names:
            return keyword.value
    return None


def _flatten(node):
    """Split `root.a(...).b(...)` into (root, [("a", call), ("b", call)])."""
    steps = []
    cur = node
    while True:
        if isinstance(cur, ast.Call) and isinstance(cur.func, ast.Attribute):
            steps.append((cur.func.attr, cur))
            cur = cur.func.value
        elif isinstance(cur, ast.Attribute):
            cur = cur.value
        else:
            break
    steps.reverse()
    return cur, steps


def _call_census(tree):
    """Names of plain functions called more than once, or called inside a loop."""
    counts, looped = {}, set()

    def walk(node, in_loop):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            counts[node.func.id] = counts.get(node.func.id, 0) + 1
            if in_loop:
                looped.add(node.func.id)
        inner = in_loop or isinstance(node, _LOOPS + _COMPREHENSIONS)
        for child in ast.iter_child_nodes(node):
            walk(child, inner)

    walk(tree, False)
    return {name for name, n in counts.items() if n > 1} | looped


class _Extractor:
    def __init__(self, tree):
        self.model = CadModel()
        self.env = {}  # name -> constant value, or None when not statically known
        self.states = {}  # name -> (points, pending) left by the chain assigned to it
        self.multi_called = _call_census(tree)
        self._block(tree.body, repeat=False, branch=False)

    # ---- helpers

    def _num(self, node) -> Optional[float]:
        if node is None:
            return None
        try:
            value = _eval(node, self.env)
        except _Unresolved:
            return None
        return float(value) if _is_number(value) else None

    def _int(self, node) -> Optional[int]:
        value = self._num(node)
        if value is None or value != int(value) or value < 0:
            return None
        return int(value)

    def _seq_len(self, node) -> Optional[int]:
        if node is None:
            return None
        try:
            value = _eval(node, self.env)
        except _Unresolved:
            return None
        return len(value) if isinstance(value, list) else None

    # ---- statements

    def _block(self, body, repeat, branch):
        for stmt in body:
            self._stmt(stmt, repeat, branch)

    def _stmt(self, stmt, repeat, branch):
        if isinstance(stmt, ast.Assign):
            state = self._expr(stmt.value, repeat)
            for target in stmt.targets:
                self._bind(target, stmt.value, state, repeat or branch)
        elif isinstance(stmt, ast.AnnAssign):
            state = self._expr(stmt.value, repeat) if stmt.value is not None else None
            if stmt.value is not None:
                self._bind(stmt.target, stmt.value, state, repeat or branch)
        elif isinstance(stmt, ast.AugAssign):
            self._expr(stmt.value, repeat)
            self._forget(stmt.target)
        elif isinstance(stmt, _LOOPS):
            self._expr(stmt.test if isinstance(stmt, ast.While) else stmt.iter, repeat)
            if not isinstance(stmt, ast.While):
                self._forget(stmt.target)
            self._block(stmt.body, True, branch)
            self._block(stmt.orelse, repeat, True)
        elif isinstance(stmt, ast.If):
            self._expr(stmt.test, repeat)
            self._block(stmt.body, repeat, True)
            self._block(stmt.orelse, repeat, True)
        elif isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            # Parameters are not constants; shadow any outer name they reuse.
            saved_env, saved_states = dict(self.env), dict(self.states)
            for a in ast.walk(stmt.args):
                if isinstance(a, ast.arg):
                    self.env[a.arg] = None
                    self.states.pop(a.arg, None)
            self._block(stmt.body, repeat or stmt.name in self.multi_called, branch)
            self.env, self.states = saved_env, saved_states
        elif isinstance(stmt, ast.ClassDef):
            self._block(stmt.body, True, branch)
        elif isinstance(stmt, (ast.With, ast.AsyncWith)):
            for item in stmt.items:
                self._expr(item.context_expr, repeat)
                if item.optional_vars is not None:
                    self._forget(item.optional_vars)
            self._block(stmt.body, repeat, branch)
        elif isinstance(stmt, ast.Try) or type(stmt).__name__ == "TryStar":
            self._block(stmt.body, repeat, True)
            for handler in stmt.handlers:
                self._block(handler.body, repeat, True)
            self._block(stmt.orelse, repeat, True)
            self._block(stmt.finalbody, repeat, True)
        else:
            for child in ast.iter_child_nodes(stmt):
                if isinstance(child, ast.expr):
                    self._expr(child, repeat)
                elif isinstance(child, ast.stmt):
                    self._stmt(child, True, True)  # match/case and anything newer

    def _forget(self, target):
        for node in ast.walk(target):
            if isinstance(node, ast.Name):
                self.env[node.id] = None
                self.states.pop(node.id, None)

    def _bind(self, target, value, state, uncertain):
        if isinstance(target, ast.Name):
            resolved = None
            if not uncertain:
                try:
                    resolved = _eval(value, self.env)
                except _Unresolved:
                    resolved = None
            self.env[target.id] = resolved
            if state is not None and not uncertain:
                self.states[target.id] = state
            else:
                self.states.pop(target.id, None)
        elif (isinstance(target, (ast.Tuple, ast.List))
              and isinstance(value, (ast.Tuple, ast.List))
              and len(target.elts) == len(value.elts)
              and not any(isinstance(e, ast.Starred) for e in target.elts + value.elts)):
            for sub_target, sub_value in zip(target.elts, value.elts):
                self._bind(sub_target, sub_value, None, uncertain)
        else:
            self._forget(target)

    # ---- expressions

    def _expr(self, node, repeat):
        """Scan an expression for CadQuery chains. Returns the chain state when the
        expression itself is a chain, else None."""
        if node is None:
            return None
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            return self._chain(node, repeat)
        inner = repeat or isinstance(node, _COMPREHENSIONS)
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.expr):
                self._expr(child, inner)
            elif isinstance(child, ast.comprehension):
                self._expr(child.iter, inner)
                for cond in child.ifs:
                    self._expr(cond, True)
            elif isinstance(child, ast.keyword):
                self._expr(child.value, inner)
        return None

    def _chain(self, node, repeat):
        root, steps = _flatten(node)
        # Only a chain that starts from a Workplane(...) constructor, or from a name
        # whose chain was followed, has a known stack. Anything else (a function result,
        # a parameter, a name bound in a branch) starts unknown.
        points, pending = None, []
        if isinstance(root, ast.Name):
            if root.id in self.states:
                points, pending = self.states[root.id]
                pending = list(pending)
        else:
            self._expr(root, repeat)
            if (isinstance(root, ast.Call) and isinstance(root.func, ast.Name)
                    and root.func.id == "Workplane"):
                points = 1

        model = self.model
        for name, call in steps:
            # Chains nested in arguments, e.g. .union(cq.Workplane().box(...)).
            for sub in list(call.args) + [k.value for k in call.keywords]:
                self._expr(sub, repeat)

            each = None if repeat else points  # how many times this step applies

            if name == "box":
                dims = tuple(
                    self._num(_arg(call, i, kw))
                    for i, kw in enumerate(("length", "width", "height"))
                )
                model.boxes.append(Box(dims, repeated=each != 1))
                points, pending = 1, []
            elif name == "cylinder":
                model.bosses.append(self._num(_arg(call, 1, "radius")))
                points, pending = 1, []
            elif name == "rect":
                pending.append(("rect", self._num(_arg(call, 0, "xLen")),
                                self._num(_arg(call, 1, "yLen")), each))
            elif name == "circle":
                pending.append(("circle", self._num(_arg(call, 0, "radius")), each))
            elif name in _OTHER_PROFILES:
                pending.append(("other", name))
            elif name == "vertices":
                if (pending and pending[-1][0] == "rect"
                        and not call.args and not call.keywords):
                    # The corners of the rectangle, once per point it was drawn at.
                    drawn_at = pending.pop()[3]
                    points = None if drawn_at is None else 4 * drawn_at
                else:
                    points = None  # a selector string picks a subset we cannot count
            elif name == "pushPoints":
                points = self._seq_len(_arg(call, 0, "pntList"))
            elif name == "rarray":
                nx = self._int(_arg(call, 2, "xCount"))
                ny = self._int(_arg(call, 3, "yCount"))
                points = None if nx is None or ny is None else nx * ny
            elif name == "polarArray":
                points = self._int(_arg(call, 3, "count"))
            elif name in _HOLE_CALLS:
                model.holes.append(
                    HoleGroup(each, self._num(_arg(call, 0, "diameter")), name))
                points, pending = 1, []
            elif name in _CUT_CALLS:
                for wire in pending:
                    if wire[0] == "circle":
                        model.holes.append(HoleGroup(wire[2], _double(wire[1]), name))
                    else:
                        model.opaque.append(f"{name} of a non-circular profile")
                points, pending = 1, []
            elif name == "extrude":
                self._extrude(pending, self._num(_arg(call, 0, "until", "distance")))
                points, pending = 1, []
            elif name in _OPAQUE:
                model.opaque.append(name)
            elif name in _RESETS:
                points = 1
                if name == "Workplane":
                    pending = []
            elif name in _SELECTORS:
                points = None
        return points, pending

    def _extrude(self, pending, distance):
        model = self.model
        rects = [w for w in pending if w[0] == "rect"]
        circles = [w for w in pending if w[0] == "circle"]
        height = None if distance is None else abs(distance)
        if rects:
            # rect(...).circle(...).extrude(...): the circles are holes in the plate.
            _, x, y, each = rects[0]
            model.boxes.append(Box((x, y, height), repeated=each != 1))
            for _, radius, each in circles:
                model.holes.append(HoleGroup(each, _double(radius), "circle+extrude"))
            if len(rects) > 1:
                model.opaque.append("nested rect profiles")
        elif len(circles) == 1:
            model.bosses.append(circles[0][1])
        elif circles:
            radii = [c[1] for c in circles]
            if any(r is None for r in radii):
                model.opaque.append("concentric circles with unresolved radii")
            else:
                outer = max(range(len(radii)), key=radii.__getitem__)
                model.bosses.append(radii[outer])
                for i, (_, radius, each) in enumerate(circles):
                    if i != outer:
                        model.holes.append(
                            HoleGroup(each, _double(radius), "circle+extrude"))


def _double(radius):
    return None if radius is None else 2.0 * radius


def extract_model(source: str) -> CadModel:
    """Read CadQuery source statically. Raises ReferenceError_ if it does not parse."""
    try:
        tree = ast.parse(source)
        return _Extractor(tree).model
    except SyntaxError as err:
        raise ReferenceError_(f"line {err.lineno}: {err.msg}") from None
    except (ValueError, ArithmeticError, RecursionError, MemoryError) as err:
        raise ReferenceError_(type(err).__name__) from None
