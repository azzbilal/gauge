"""Wrong model: the 100 x 100 x 8 mm cover plate with its 20 mm hole is built, then half of it
is cut away, leaving a 50 x 100 x 8 mm part with half a hole on its edge."""
import cadquery as cq

plate = cq.Workplane("XY").box(100, 100, 8).faces(">Z").workplane().hole(20)
half = cq.Workplane("XY").box(50, 100, 8).translate((25, 0, 0))

result = plate.cut(half)
