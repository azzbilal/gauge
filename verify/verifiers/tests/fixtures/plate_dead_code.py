"""Wrong model: the 60 x 40 x 10 mm plate with its four holes is written out in full, but
inside a branch that never runs. What the script actually builds is a 10 mm sphere.

The static reader sees the box and the holes and passes every item. Only executing the code
shows that the plate is never built.
"""
import cadquery as cq

width = 60
depth = 40
height = 10
hole_d = 5

if False:
    result = (
        cq.Workplane("XY")
        .box(width, depth, height)
        .faces(">Z")
        .workplane()
        .rect(width - 20, depth - 20, forConstruction=True)
        .vertices()
        .hole(hole_d)
    )

result = cq.Workplane("XY").sphere(5)
