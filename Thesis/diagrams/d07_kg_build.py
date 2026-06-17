"""Figure: the knowledge-graph construction pipeline."""
from html_dsl import Diagram

d = Diagram(1280, 470, "Knowledge-Graph Construction")

src     = d.box(125, 175, 170, 90, "Processed library", "chunks and captions", "navy")
extract = d.box(360, 175, 175, 92, "Extract", "entities & relations from each chunk (LLM)", "teal")
resolve = d.box(600, 175, 175, 92, "Resolve", "merge duplicate entities, normalise names", "teal")
build   = d.box(840, 175, 175, 92, "Build graph", "assemble nodes and edges, score weights", "violet")
api     = d.box(1085, 175, 170, 92, "Serve", "interactive graph in the web application", "blue")

store = d.box(600, 360, 415, 66, "Graph stored in Supabase",
              "nodes, edges and provenance back to the source chunks", "amber", soft=True)

for a, b in [(src, extract), (extract, resolve), (resolve, build), (build, api)]:
    d.arrow(a, "r", b, "l")
d.arrow(resolve, "b", store, "t", dashed=True)
d.arrow(build, "b", store, "t", dashed=True)

d.note(125, 320, "Every node and edge keeps a link back to the passage it came from.", fs=11.5)

d.save("fig_kg_build.png")
