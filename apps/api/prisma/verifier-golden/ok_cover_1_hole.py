"""Reference: 100 x 100 x 8 mm cover plate with one central 20 mm through hole. Matches the spec."""
import cadquery as cq

result = cq.Workplane("XY").box(100, 100, 8).faces(">Z").workplane().hole(20)
