"""Figure: the document ingestion pipeline (queue-driven stages)."""
from dsl import canvas, box, arrow, save, PALETTE
import matplotlib.pyplot as plt

fig, ax = canvas(13.0, 4.6)

stages = [
    ("Sync", "fetch files\nfrom source", "blue"),
    ("Layout\nParser", "DocLayout-YOLO\nregions", "teal"),
    ("Text\nExtraction", "born-digital +\nscanned (VLM)", "teal"),
    ("Image\nCaptioning", "figures/tables\n(skipped if scanned)", "violet"),
    ("Chunking", "build text IR\n-> chunks", "teal"),
    ("Embedding", "BGE vectors\n-> pgvector", "amber"),
    ("Clustering", "topic clusters\n(K-means)", "green"),
]
n = len(stages)
x0, dx, y = 9, 13.0, 60
boxes = []
for i, (name, sub, col) in enumerate(stages):
    b = box(ax, x0 + i * dx, y, 11, 16, f"{name}\n\n{sub}", col, bold=True, fontsize=8)
    boxes.append(b)
for i in range(n - 1):
    arrow(ax, boxes[i], "r", boxes[i + 1], "l")

# data lane
ax.text(50, 88, "Queue-driven stages (batch_stage_jobs): each stage gates on the previous one being done",
        ha="center", fontsize=9, style="italic", color="#4b5563")
store = box(ax, 50, 26, 40, 12, "Artefacts in R2 (text IR, layout, visuals) + chunk_embeddings in Supabase",
            "slate", fontsize=9)
arrow(ax, boxes[2], "b", store, "t", dashed=True)
arrow(ax, boxes[4], "b", store, "t", dashed=True)
arrow(ax, boxes[5], "b", store, "t", dashed=True)

save(fig, "fig_pipeline.png")
