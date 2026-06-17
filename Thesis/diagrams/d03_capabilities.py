"""Figure: the four capabilities of Synapse around a central platform hub."""
from html_dsl import Diagram

d = Diagram(1020, 620, "What Synapse Does")

hub = d.box(510, 310, 220, 96, "Synapse",
            "one web application over a private document library", "navy")

ingest = d.box(510, 95, 210, 84, "Ingest & Understand",
               "layout, OCR/VLM, chunk, embed, cluster", "teal")
ask = d.box(855, 240, 200, 84, "Ask",
            "grounded, citing RAG chat with abstention", "blue")
create = d.box(745, 520, 200, 84, "Create",
               "agent mode: charts, documents, images", "violet")
mapg = d.box(275, 520, 200, 84, "Map",
             "interactive knowledge graph of the corpus", "amber")
collab = d.box(165, 240, 200, 84, "Collaborate",
               "shared libraries and real-time team chat", "rose")

d.arrow(hub, "t", ingest, "b", double=True)
d.arrow(hub, "r", ask, "l", double=True)
d.arrow(hub, "b", create, "t", double=True)
d.arrow(hub, "b", mapg, "t", double=True)
d.arrow(hub, "l", collab, "r", double=True)

d.save("fig_capabilities.png")
