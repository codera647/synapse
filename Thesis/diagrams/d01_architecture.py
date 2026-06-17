"""Figure: high-level system architecture of Synapse (HTML/CSS render)."""
from html_dsl import Diagram

d = Diagram(1180, 720, "System Architecture of Synapse")

# --- client tier ---
client = d.box(150, 110, 210, 78, "Web Application",
               "Next.js / React, runs in the browser", "navy")

# --- edge tier ---
edge = d.box(150, 320, 210, 84, "Cloudflare Worker",
             "OpenNext host + API proxy (edge)", "slate")

# --- backend group ---
d.group(720, 360, 760, 560, "GPU Application Server  —  FastAPI on an NVIDIA L4")
api = d.box(470, 130, 200, 80, "API Layer",
            "chat, agent, graph, pipeline routes", "blue")
workers = d.box(470, 300, 200, 92, "Worker Pool",
                "sync · layout · OCR/VLM · chunk · embed · cluster", "teal")
retr = d.box(470, 500, 200, 88, "Retrieval & Reasoning",
             "corrective, multi-agent loop", "teal")
embed = d.box(760, 300, 190, 84, "Embedding & Rerank",
              "BGE encoder + reranker", "violet")
kg = d.box(760, 500, 190, 84, "Knowledge-Graph Builder",
           "entity & relation extraction", "violet")

# --- data + external services ---
sup = d.box(470, 650, 200, 70, "Supabase", "Postgres + pgvector", "amber")
r2 = d.box(760, 650, 190, 70, "Cloudflare R2", "object storage", "amber")
llm = d.box(1050, 130, 175, 96, "Model APIs",
            "OpenAI · OpenRouter (Claude, Qwen-VL)", "rose")

# --- edges ---
d.arrow(client, "b", edge, "t", "HTTPS", double=True)
d.arrow(edge, "r", api, "l", "REST", double=True)
d.arrow(api, "b", workers, "t")
d.arrow(workers, "b", retr, "t")
d.arrow(workers, "r", embed, "l")
d.arrow(retr, "r", kg, "l", dashed=True)
d.arrow(retr, "b", sup, "t", "vectors + text", double=True)
d.arrow(kg, "b", r2, "t", double=True, elbow="v")
d.arrow(workers, "b", r2, "t", "files", double=True, elbow="v")
d.arrow(api, "r", llm, "l", double=True)
d.arrow(retr, "r", llm, "l", dashed=True, elbow="h")

d.save("fig_architecture.png")
