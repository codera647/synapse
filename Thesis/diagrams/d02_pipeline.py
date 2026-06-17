"""Figure: the document ingestion pipeline (queue-driven stages, HTML render)."""
from html_dsl import Diagram

d = Diagram(1340, 470, "Document Ingestion Pipeline")

stages = [
    ("Sync", "fetch files\nfrom source", "navy"),
    ("Layout Parser", "DocLayout-YOLO\nregion detection", "teal"),
    ("Text Extraction", "born-digital +\nscanned (VLM)", "teal"),
    ("Image Captioning", "figures & tables\nvia VLM", "violet"),
    ("Chunking", "build text IR,\nsplit to chunks", "teal"),
    ("Embedding", "BGE vectors\nto pgvector", "blue"),
    ("Clustering", "topical clusters\n(K-means)", "amber"),
]
n = len(stages)
x0, dx, y = 135, 178, 175
boxes = []
for i, (name, sub, col) in enumerate(stages):
    b = d.box(x0 + i * dx, y, 150, 104, name, sub.replace("\n", "  "), col)
    boxes.append(b)
for i in range(n - 1):
    d.arrow(boxes[i], "r", boxes[i + 1], "l")

store = d.box(670, 360, 760, 66, "Artefacts persisted",
              "text IR, layout and visuals in Cloudflare R2  ·  chunk embeddings in Supabase/pgvector",
              "slate", soft=True)
for i in (2, 4, 5):
    d.arrow(boxes[i], "b", store, "t", dashed=True)

d.note(135, 56, "Queue-driven stages: each stage runs in batches and gates on the previous stage completing.",
       fs=12)

d.save("fig_pipeline.png")
