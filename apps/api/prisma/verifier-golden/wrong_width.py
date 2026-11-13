"""Wrong model: the plate is 65 mm wide instead of 60 mm. Everything else matches."""
import cadquery as cq

width = 65
depth = 40
height = 10
hole_d = 5

result = (
    cq.Workplane("XY")
    .box(width, depth, height)
    .faces(">Z")
    .workplane()
    .rect(40, 20, forConstruction=True)
    .vertices()
    .hole(hole_d)
)
