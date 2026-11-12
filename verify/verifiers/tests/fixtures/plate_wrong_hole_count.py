"""Wrong model: three holes instead of four. Everything else matches."""
import cadquery as cq

width = 60
depth = 40
height = 10
hole_d = 5

hole_points = [(-20, -10), (20, -10), (20, 10)]

result = (
    cq.Workplane("XY")
    .box(width, depth, height)
    .faces(">Z")
    .workplane()
    .pushPoints(hole_points)
    .hole(hole_d)
)
