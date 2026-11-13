"""Reference: 60 x 40 x 10 mm plate with four 5 mm through holes. Matches the spec."""
import cadquery as cq

width = 60
depth = 40
height = 10
hole_d = 5

result = (
    cq.Workplane("XY")
    .box(width, depth, height)
    .faces(">Z")
    .workplane()
    .rect(width - 20, depth - 20, forConstruction=True)
    .vertices()
    .hole(hole_d)
)
