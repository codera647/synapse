"""Figure: simplified data model (main entities and relationships)."""
from html_dsl import Diagram

d = Diagram(1160, 640, "Core Data Model (simplified)")

org   = d.box(180, 110, 200, 70, "organization", "tenant boundary", "navy")
user  = d.box(180, 300, 200, 70, "user", "member of an organisation", "blue")
lib   = d.box(560, 110, 210, 70, "library", "a connected collection", "teal")
doc   = d.box(560, 300, 210, 78, "document", "one file and its status", "teal")
chunk = d.box(560, 500, 210, 78, "chunk_embedding", "text chunk + vector", "violet")
chat  = d.box(940, 110, 190, 78, "chat_thread", "a conversation", "amber")
msg   = d.box(940, 300, 190, 78, "chat_message", "with citations", "amber")
node  = d.box(940, 500, 190, 78, "graph_node / edge", "entities & relations", "rose")

def rel(a, sa, b, sb, label):
    d.arrow(a, sa, b, sb, label)

rel(org, "b", user, "t", "has")
rel(org, "r", lib, "l", "owns")
rel(lib, "b", doc, "t", "contains")
rel(doc, "b", chunk, "t", "split into")
rel(lib, "r", chat, "l", "queried by")
rel(chat, "b", msg, "t", "has")
rel(doc, "r", node, "l", "yields", )
d.arrow(chunk, "r", node, "l", "grounds", elbow="h")

d.note(120, 600, "All rows are scoped to an organisation; access is enforced by row-level security in the database.", fs=11.5)

d.save("fig_data_model.png")
