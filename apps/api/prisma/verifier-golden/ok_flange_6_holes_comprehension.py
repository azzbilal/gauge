"""Reference: 120 x 80 x 6 mm flange plate with six 6 mm through holes, two rows of three.
Matches the spec. The hole positions come from a list comprehension, which is ordinary
CadQuery but not a constant the static hole reader can count.
"""
import cadquery as cq

points = [(x, y) for x in (-40, 0, 40) for y in (-25, 25)]

result = (
    cq.Workplane("XY")
    .box(120, 80, 6)
    .faces(">Z")
    .workplane()
    .pushPoints(points)
    .hole(6)
)
