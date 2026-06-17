"""Figure: the iterative and incremental development lifecycle (ring)."""
from html_dsl import Diagram

d = Diagram(940, 660, "Development Methodology — Iterative and Incremental")

p = {
    "plan":   (470, 110, "1 · Planning", "scope, risks, schedule", "navy"),
    "anal":   (760, 245, "2 · Analysis", "requirements, use cases", "blue"),
    "design": (760, 470, "3 · Design", "architecture, interfaces", "blue"),
    "impl":   (470, 560, "4 · Implementation", "build the increment", "teal"),
    "test":   (180, 470, "5 · Testing", "unit and end-to-end", "teal"),
    "deploy": (180, 245, "6 · Deployment", "release and feedback", "violet"),
}
b = {k: d.box(x, y, 188, 74, t, s, c) for k, (x, y, t, s, c) in p.items()}

centre = d.box(470, 335, 210, 96, "Each iteration",
               "delivers a working, tested increment of the product", "slate", soft=True)

d.arrow(b["plan"], "r", b["anal"], "t")
d.arrow(b["anal"], "b", b["design"], "t")
d.arrow(b["design"], "l", b["impl"], "r")
d.arrow(b["impl"], "l", b["test"], "r")
d.arrow(b["test"], "t", b["deploy"], "b")
d.arrow(b["deploy"], "t", b["plan"], "l")

d.save("fig_methodology.png")
