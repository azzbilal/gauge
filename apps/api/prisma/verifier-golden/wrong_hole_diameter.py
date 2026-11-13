"""Wrong model: the two holes are 6 mm instead of 8 mm. Everything else matches."""
import cadquery as cq

result = (
    cq.Workplane("XY")
    .box(80, 50, 20)
    .faces(">Z")
    .workplane()
    .pushPoints([(-25, 0), (25, 0)])
    .hole(6)
)
