# Synapse — Knowledge Graphs (GraphRAG over processed libraries)

## Context & goal
Let a user pick one or more **already-processed libraries** and **generate a knowledge graph** —
entities (nodes) + typed relationships (edges) extracted from the documents. Two payoffs:
1. an **interactive graph visualization** to explore a library's concepts and how they connect, and
2. **graph-augmented retrieval** so multi-hop / cross-document questions answer better.

Motivation is concrete: our DOUBLE-BENCH eval showed Synapse's weak spot is **multi-hop** (evidence
spread across documents). A KG makes those cross-document links explicit so the retriever can *traverse*
them instead of hoping one vector search surfaces everything.

## Architecture decision
- **On-demand, per library** — NOT a mandatory pipeline stage. The user triggers a build on a processed
  library, so the per-chunk LLM cost is only paid when requested.
- Build **on top of existing chunks** (`chunk_embeddings` + text IR) — no re-ingestion.
- Store the graph in **Postgres** (`kg_nodes` / `kg_edges`, pgvector on node embeddings) keyed by
  library — reuse Supabase + RLS, no new graph DB.
- **Every edge keeps its `source_chunk_ids`** so the UI can show the passage behind each relationship
  (trust + verification — the graph is auditable, not a black box).

## Data model — `docs/supabase-knowledge-graph.sql`
RLS via the existing `is_org_member`. Add to the `supabase_realtime` publication for live build status.
- `kg_graphs(id, organization_id, library_id, created_by_user_id, status in
  (queued|building|done|error|stale), node_count, edge_count, error, created_at, updated_at)`
- `kg_nodes(id, graph_id, organization_id, library_id, name, type, description,
  embedding vector(1024), mention_count, source_chunk_ids text[], created_at)`
  — index on (graph_id), ivfflat on embedding.
- `kg_edges(id, graph_id, organization_id, source_node_id, target_node_id, relation, description,
  weight int default 1, source_chunk_ids text[], created_at)` — index on (graph_id), (source_node_id),
  (target_node_id).
- `kg_build_jobs(id, organization_id, library_id, graph_id, status, progress_current, progress_total,
  attempts, last_error, created_at)` — on-demand queue (mirrors `batch_stage_jobs`).

## Backend (new files under `backend/`)
- **`kg_extract.py`** — `extract_triples(chunk_text) -> {entities:[{name,type,description}],
  relations:[{source,relation,target,description}]}` via an LLM. **Configurable model**
  `KG_EXTRACT_MODEL` (default `gpt-4o-mini` through the existing OpenAI client for cost; Claude via
  `agent_llm` for higher quality). Strict JSON (reuse `chat_agents._json_object`); batched.
- **`kg_resolve.py`** — entity resolution (the quality-defining step):
  - normalize names; embed each candidate entity (reuse `chat_runtime._get_embedder` / `embed_query`);
  - merge mentions whose embeddings are near-duplicate (cosine ≥ threshold) **and** an LLM
    canonicalize pass confirms ("ML" == "machine learning", "the company" == "Acme");
  - produce canonical nodes with merged `source_chunk_ids` + `mention_count`.
- **`kg_build.py` / `kg_worker.py`** — orchestration as a **demand-driven worker** (reuse the
  `worker_bootstrap` autoscaler: spawn a `knowledge_graph` worker only when `kg_build_jobs` are
  pending). Steps: load the library's chunks → batch `extract_triples` (progress per batch) →
  `kg_resolve` → upsert `kg_nodes` + `kg_edges` (dedup edges, accumulate `weight`/`source_chunk_ids`)
  → set `kg_graphs.status=done` + counts. Resumable + cancelable like the pipeline.
- **`kg_api.py`** — endpoints (registered in `app.py`, import-guarded):
  - `POST /kg/build` `{organization_id, library_id}` → create `kg_graphs` + enqueue `kg_build_jobs`.
  - `GET  /kg/status?graph_id=` / `?library_id=` → build progress.
  - `GET  /kg/graph?library_id=` → nodes + edges (server-side pruned: top-N by weight/mention,
    `min_weight` filter) for the viz.
  - `POST /kg/delete` → drop a graph.
  - **(Phase 2)** `POST /kg/retrieve` `{library_ids, query, hops}` → graph-walk seeds + connected
    evidence (below).

## Graph-augmented retrieval (Phase 2)
`graph_retrieve(query, library_ids, hops=2)`:
1. embed the query → semantic match against `kg_nodes.embedding` → **seed entities**;
2. walk `kg_edges` out to `hops` → connected entities + the relations between them;
3. gather the `source_chunk_ids` along that subgraph → fetch those chunks;
4. return them (+ a compact "X —relation→ Y" relationship brief) to the answer step.
Wire into `/chat` as an optional mode (`graph=true`) that **unions** graph evidence with the existing
hybrid retrieval — so multi-hop questions get the traversed links plus normal recall.

## Frontend
- **Trigger:** a **"Knowledge graph"** action on a processed library (library card button or an Agent
  action) → `POST /kg/build` → live status (poll `/kg/status`) → opens the graph view.
- **`components/KnowledgeGraphView.tsx`** (new): interactive **force-directed graph**
  (`react-force-graph-2d`, WebGL — handles large graphs). Nodes colored by `type`, sized by
  `mention_count`; edges labeled by `relation`. Interactions: zoom/pan, drag, **click a node → side
  panel** with its description, neighbors, and the **source passages** (via `source_chunk_ids` →
  existing `/document/chunk`); search/filter by entity; a `min_weight` slider to declutter.
- **`components/KnowledgeGraphDrawer.tsx`** / list — saved graphs per library.
- New dep: `react-force-graph-2d` (+ `d3-force`).

## Reuse vs new
- **Reuse:** `chunk_embeddings` + text IR (no re-ingest), the embedder (`chat_runtime`), the OpenAI /
  `agent_llm` clients + `_json_object`, the demand-driven worker autoscaler + job/queue pattern, the
  `/document/chunk` source-passage endpoint, Supabase RLS/realtime patterns.
- **New:** `kg_extract` / `kg_resolve` / `kg_build` / `kg_worker` / `kg_api`, the `kg_*` tables, the
  force-graph component, and (phase 2) graph-walk retrieval.
- **New deps:** frontend `react-force-graph-2d` + `d3-force`. Backend: none (LLM + pgvector already
  present).

## Phasing
- **Phase 1 (MVP):** on-demand build (extract → resolve → store) + **interactive visualization** with
  node → source passages. The graph is **auditable** (every edge cites its chunks).
- **Phase 2:** **graph-augmented retrieval** in chat (multi-hop answers via graph walk) — the
  substance; directly targets the eval weakness.
- **Phase 3:** **community detection** (cluster the graph) + **community summaries** (full
  GraphRAG-style hierarchical answers); incremental graph updates when a library reprocesses.

## Risks & mitigations
1. **Extraction cost** (LLM per chunk, like captioning): on-demand only; default a cheap extraction
   model (`gpt-4o-mini`); batch chunks; show an upfront estimate ("~N chunks → ~$X").
2. **Graph quality / entity resolution** (the make-or-break): embedding-merge + LLM canonicalize;
   keep `source_chunk_ids` on every node/edge so the UI lets users **verify** each link; prune
   low-weight edges. Be honest in the UI that it's model-extracted.
3. **Scale / clutter:** server-side prune (top-N, `min_weight`), WebGL force-graph, lazy node detail.
4. **Staleness:** mark a graph `stale` when its library reprocesses; offer a rebuild.
5. **Cost runaway:** the `kg_build_jobs` are cancelable + the worker checks the cancel flag between
   batches (reuse the pipeline cancel pattern).

## Verification (end-to-end)
1. `POST /kg/build` on a processed library → job runs, `kg_graphs.status` → `done`, sane node/edge
   counts; cancel works mid-build.
2. `GET /kg/graph` → nodes/edges render in `KnowledgeGraphView`; clicking a node shows its real source
   passages; the `min_weight` slider declutters.
3. Spot-check 5 edges against their `source_chunk_ids` — the relation is actually supported by the
   passage (precision sanity).
4. **(Phase 2)** a multi-hop question (evidence across two docs) answers correctly with `graph=true`
   and visibly uses traversed links, where plain hybrid retrieval missed.

## Decisions to confirm
- **v1 lead:** **visualization first** (explore + verify the graph), with **graph-RAG retrieval as
  Phase 2** — *recommended* (visualization validates graph quality before we trust it for answers).
- **v1 graph scope:** **entities + typed relations only** (cleaner, cheaper); communities/summaries →
  Phase 3.
- **Extraction model:** default **`gpt-4o-mini`** (cost) vs **Claude** (quality) — env-configurable;
  start cheap, offer Claude as a "high-quality build" toggle.
- **Trigger surface:** a **per-library "Knowledge graph" button** (vs an Agent action). Recommend the
  library button — it's a property of the library, not a one-off chat turn.
