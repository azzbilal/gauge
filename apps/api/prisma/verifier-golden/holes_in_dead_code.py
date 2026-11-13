"""Wrong model: the 60 x 40 x 10 mm plate is built, but the four 5 mm holes are drilled inside
a branch that never runs. The part that comes out is a plain plate with no holes."""
import cadquery as cq

width = 60
depth = 40
height = 10
hole_d = 5
drill = False

result = cq.Workplane("XY").box(width, depth, height)

if drill:
    result = (
        result.faces(">Z")
        .workplane()
        .rect(width - 20, depth - 20, forConstruction=True)
        .vertices()
        .hole(hole_d)
    )
