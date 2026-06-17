"""Figure: high-level system architecture of Synapse."""
from dsl import canvas, box, group, arrow, save

fig, ax = canvas(12.5, 7.4)

# Client
client = box(ax, 14, 80, 22, 12, "Web Application\n(Next.js / React)\nbrowser", "blue", bold=True)

# Edge / frontend host
edge = box(ax, 14, 55, 22, 10, "Cloudflare Worker\n(OpenNext host +\nAPI proxy)", "slate")

# Backend group
group(ax, 60, 55, 54, 64, "GPU Application Server (FastAPI, L4)", "slate")
api = box(ax, 44, 80, 20, 10, "API layer\n(chat, agent, kg,\npipeline)", "teal", bold=True)
workers = box(ax, 44, 58, 20, 12, "Worker pool\nsync . layout . OCR/VLM\nchunk . embed . cluster", "teal")
retr = box(ax, 44, 34, 20, 10, "Retrieval +\nagent reasoning\n(CRAG, multi-agent)", "teal")
kg = box(ax, 78, 34, 20, 10, "Knowledge-graph\nbuilder", "violet")
embed = box(ax, 78, 58, 20, 10, "Embedding +\nrerank models\n(BGE)", "violet")

# Data + services
sup = box(ax, 44, 12, 20, 9, "Supabase\n(Postgres + pgvector)", "amber", bold=True)
r2 = box(ax, 78, 12, 20, 9, "Cloudflare R2\n(object storage)", "amber", bold=True)
llm = box(ax, 92, 80, 14, 11, "LLM APIs\nOpenAI /\nOpenRouter\n(Claude)", "rose")

# edges
arrow(ax, client, "b", edge, "t", "HTTPS", double=True)
arrow(ax, edge, "r", api, "l", "REST", double=True)
arrow(ax, api, "b", workers, "t")
arrow(ax, workers, "b", retr, "t")
arrow(ax, retr, "r", kg, "l", dashed=True)
arrow(ax, workers, "r", embed, "l")
arrow(ax, retr, "b", sup, "t", "vectors+text", double=True)
arrow(ax, kg, "b", sup, "t", double=True)
arrow(ax, workers, "b", r2, "t", "files", double=True)
arrow(ax, api, "r", llm, "l", double=True)
arrow(ax, retr, "r", llm, "t", dashed=True)

save(fig, "fig_architecture.png")
