"""Figure: use-case diagram (actors and the main use cases)."""
from html_dsl import Diagram

d = Diagram(1100, 700, "Use-Case Diagram")

owner = d.box(110, 230, 150, 80, "Member", "signed-in user", "navy")
admin = d.box(110, 470, 150, 80, "Team admin", "manages members", "slate")
ext   = d.box(990, 350, 150, 80, "Model APIs", "external services", "rose")

d.group(560, 350, 560, 600, "Synapse platform", "blue")
uc = [
    (560, 90,  "Connect a library"),
    (560, 185, "Process documents"),
    (560, 280, "Ask a grounded question"),
    (560, 375, "Generate an artefact"),
    (560, 470, "Explore the knowledge graph"),
    (560, 565, "Collaborate with a team"),
    (560, 640, "Manage members and access"),
]
boxes = [d.box(x, y, 300, 60, t, "", "teal", soft=True) for (x, y, t) in uc]

for b in boxes[:6]:
    d.arrow(owner, "r", b, "l")
d.arrow(admin, "r", boxes[5], "l")
d.arrow(admin, "r", boxes[6], "l")
# external participation
d.arrow(boxes[2], "r", ext, "l", dashed=True)
d.arrow(boxes[3], "r", ext, "l", dashed=True)

d.save("fig_usecase.png")
