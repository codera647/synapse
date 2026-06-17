"""Figure: the corrective, multi-agent grounded-chat retrieval flow."""
from html_dsl import Diagram

d = Diagram(1000, 880, "Grounded Chat — Corrective Retrieval and Answering")

q       = d.box(490, 105, 250, 64, "User question", "asked in plain language", "navy")
analyse = d.box(490, 220, 250, 70, "Analyse the question", "rewrite and expand, plan retrieval", "blue")
retr    = d.box(420, 345, 270, 78, "Hybrid retrieval", "vector + keyword search, fused with RRF", "teal")
store   = d.box(810, 345, 200, 78, "Library index", "chunks, embeddings and full-text index", "amber", soft=True)
rerank  = d.box(420, 470, 270, 70, "Re-rank passages", "cross-encoder selects the top evidence", "teal")
grade   = d.box(420, 590, 270, 70, "Grade the evidence", "is it relevant and sufficient?", "violet")
compose = d.box(255, 740, 250, 76, "Compose the answer", "grounded reply with a citation per claim", "blue")
abstain = d.box(690, 740, 230, 76, "Abstain", "say the library cannot support an answer", "rose")

d.arrow(q, "b", analyse, "t")
d.arrow(analyse, "b", retr, "t")
d.arrow(retr, "r", store, "l", double=True, dashed=True)
d.arrow(retr, "b", rerank, "t")
d.arrow(rerank, "b", grade, "t")
d.arrow(grade, "b", compose, "t", "sufficient", elbow="v")
d.arrow(grade, "b", abstain, "t", "insufficient", elbow="v")

d.note(55, 590, "If the evidence is weak, the\nloop can refine the query\nand retrieve again before\nit decides to abstain.", fs=11.5)

d.save("fig_chat_flow.png")
