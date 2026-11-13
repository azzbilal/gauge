"""Reference: 80 x 50 x 20 mm mounting block with two 8 mm through holes. Matches the spec."""
import cadquery as cq

result = (
    cq.Workplane("XY")
    .box(80, 50, 20)
    .faces(">Z")
    .workplane()
    .pushPoints([(-25, 0), (25, 0)])
    .hole(8)
)
