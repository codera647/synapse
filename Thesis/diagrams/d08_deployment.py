"""Figure: deployment view of Synapse."""
from html_dsl import Diagram

d = Diagram(1120, 600, "Deployment View")

user = d.box(110, 300, 150, 80, "User", "web browser", "navy")

# Cloudflare edge
d.group(430, 300, 300, 470, "Cloudflare", "amber")
worker = d.box(430, 175, 220, 86, "Worker (synapse-web)", "Next.js via OpenNext", "blue")
r2 = d.box(430, 320, 220, 78, "R2 bucket", "documents and artefacts", "amber")
realtime = d.box(430, 455, 220, 78, "Realtime channel", "live chat and updates", "rose")

# GPU VM
d.group(800, 250, 320, 360, "GCP VM (synapse-gpu, NVIDIA L4)", "slate")
api = d.box(800, 175, 240, 80, "FastAPI service", "chat, agent, graph, pipeline", "teal")
workers = d.box(800, 300, 240, 80, "Pipeline workers", "layout, OCR/VLM, embed, cluster", "teal")
models = d.box(800, 420, 240, 80, "Local models", "BGE encoder + reranker", "violet")

# external
sup = d.box(800, 545, 240, 60, "Supabase (Postgres + pgvector)", "", "amber")
ext = d.box(1030, 110, 150, 86, "Model APIs", "OpenAI, OpenRouter", "rose")

d.arrow(user, "r", worker, "l", "HTTPS", double=True)
d.arrow(worker, "r", api, "l", "REST", double=True)
d.arrow(api, "b", workers, "t")
d.arrow(workers, "b", models, "t")
d.arrow(worker, "b", r2, "t", double=True)
d.arrow(api, "b", sup, "t", double=True, elbow="v")
d.arrow(api, "r", ext, "l", double=True, elbow="v")
d.arrow(worker, "b", realtime, "t")

d.save("fig_deployment.png")
