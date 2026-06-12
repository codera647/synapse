# Synapse Retrieval Pipeline Design (MA-RAG + CuriousLLM + Coverage Critic)

This document defines the next-generation **multi-agent retrieval layer** for Synapse chat.
It refines the current ad-hoc "curious hop" loop into an explicit, agentic pipeline that produces a
**consolidated, source-anchored context document** for the LLM, and returns the **source PDFs** each
answer was grounded in (from the user's selected library).

It is derived from an analytical reading of five papers and adapted to Synapse's real infrastructure:

- **MA-RAG** (2505.20096) — multi-agent collaborative RAG (Planner / Step Definer / Extractor / QA).
- **CuriousLLM** (2404.09077) — curiosity-driven follow-up questions + early-termination.
- **Loong** (2406.17419) — RAG can *hurt* comprehensiveness; retrieval must adapt to task type.
- **Multi-Document Financial QA** (2411.07264) — semantic tagging + KG triples beat plain RAG.
- **MEBench** (2502.18993) — *completeness* (all entities/attributes) is the real failure mode.

---

## 0. What we already have (reuse, don't rebuild)

| Capability | Where | Notes |
|---|---|---|
| BGE-large query embedding (1024-d) | `chat_runtime.embed_query` | matches `chunk_embeddings.embedding vector(1024)` |
| Vector search (pgvector cosine) | `match_chunk_embeddings` RPC + `chat_runtime.retrieve_chunks` | scoped by org + library_ids |
| Lexical fallback | `chat_runtime.keyword_search_chunks` | ilike; upgrade target = Postgres FTS/BM25 |
| Cross-encoder rerank | `chat_retriever_worker` | `BAAI/bge-reranker-base` |
| Neighbor-chunk expansion | `chat_runtime.expand_neighbor_chunks` | adjacent `<doc>_cNNNN` chunks |
| Source hydration | `chat_runtime.hydrate_doc_titles` | `doc_id → title, gdrive_file_id, storage_path_raw` |
| Evidence brief | `chat_runtime.build_evidence_brief` | becomes the Context-Doc builder |
| Partial curious loop | `chat_api._chat_impl` | becomes the explicit orchestrator |
| Durable retrieval queue | `chat_queue` + `chat_retriever_worker` | enables parallel sub-query fan-out |

**Chunk metadata already available** (critical for novelty): `section_heading`, `context_prefix`,
**`visual_ids` / `visual_keys`** (links each chunk to captioned figures/tables/charts/formulas),
`page_start/end`, `chunk_index`, `doc_id`, `library_id`.

---

## 1. Research synthesis → what Synapse adopts

| Paper | Core insight | Adopted as |
|---|---|---|
| MA-RAG | Decompose query; **distill evidence** (Extractor) before answering; invoke agents on-demand; give strong models to Planner/Extractor/QA, weak to Step Definer | Planner, Step Definer, **Extractor**, Synthesizer agents; single-hop fast path for simple queries |
| CuriousLLM | Generate a **follow-up question** to bridge unrelated passages for multi-hop; **stop early** when evidence is sufficient | Hop Controller: follow-up sub-queries + `SUFFICIENT` early-stop, bounded hops |
| Loong | Plain top-k RAG **degrades** on comparison/aggregation (evidence scattered across all docs); deep top-k helps spotlight; high-k helps long context | **Query-class router** picks strategy per query |
| Financial QA | Semantic tags (entities/dates/orgs) route retrieval; numbers live in **tables** | Optional entity/modality tags; table/figure-aware retrieval |
| MEBench | **Completeness** is the failure mode; must cover *all* entities/attributes; entity density hurts | **Coverage/Completeness critic** that gap-fills before synthesis; EA-F1 eval |

---

## 2. Target pipeline (the requested flow, concretely)

```
user prompt
   │
   ▼
[1] Planner Agent (GPT, chain-of-thought)
     • classify query class: SPOTLIGHT | MULTI_HOP | COMPARISON/AGGREGATION/MULTI_ENTITY | CONVERSATIONAL
     • decompose into a plan = [step_1 … step_n]; simple → 1 step (on-demand, MA-RAG)
   │
   ▼
[2] Router → choose retrieval strategy from the class (Loong)
   │
   ▼
   ┌──────────────────────────── per step / per hop ────────────────────────────┐
   │ [3] Step Definer (cheap GPT): step → concrete sub-query, conditioned on     │
   │     accumulated notes (history)                                            │
   │ [4] Retriever Workers (GPU, PARALLEL fan-out over sub-queries):             │
   │     hybrid(vector pgvector + keyword/FTS) → cross-encoder rerank →          │
   │     neighbor expansion → modality boost (visual_ids/section_heading)        │
   │ [5] Extractor Agent (GPT/local): distill ONLY relevant sentences/spans into │
   │     structured NOTES, each carrying {doc_id, pages, visual refs, snippet}   │
   │ [6] CuriousLLM Hop Controller (GPT): sufficient? → STOP (early term)        │
   │     else → emit follow-up sub-query (bridge) and loop (≤ MAX_HOPS)          │
   └────────────────────────────────────────────────────────────────────────────┘
   │
   ▼
[7] Coverage / Completeness Critic (GPT)  ← only for COMPARISON/AGGREGATION/MULTI_ENTITY
     • are all target entities/docs represented? if gaps → targeted gap-fill retrieval
   │
   ▼
[8] Context-Doc Builder: dedup + consolidate NOTES into a structured, source-anchored
     context document (grouped by sub-question/entity), capped to token budget
   │
   ▼
[9] Synthesizer (GPT via API): final answer grounded ONLY in the context doc
   │
   ▼
answer  +  source PDFs (cited notes → doc_id → documents.gdrive_file_id → Drive link)
```

### Agent roles, model tier, runtime

| # | Agent | Runs on | Model tier (MA-RAG allocation) | Reuses |
|---|-------|---------|-------------------------------|--------|
| 1 | Planner | OpenAI API | strong (gpt-4o / 4o-mini) | new prompt |
| 3 | Step Definer | OpenAI API | cheap (4o-mini) | existing followup prompt |
| 4 | Retriever workers | GPU pool | — | `retrieve_chunks`, rerank, `expand_neighbor_chunks` |
| 5 | Extractor | OpenAI API or local SLM | strong-ish | new |
| 6 | Hop Controller | OpenAI API | cheap | existing `_followup_decision_prompt` |
| 7 | Coverage Critic | OpenAI API | strong | new |
| 9 | Synthesizer | OpenAI API | strong | existing `_final_answer_prompt` |

> **Decision (locked):** use **`gpt-4o-mini` for every agent** for now (cheapest; MA-RAG shows small
> models suffice for most roles). Each agent's model is read from an env var (e.g. `CHAT_PLANNER_MODEL`,
> `CHAT_EXTRACTOR_MODEL`, `CHAT_SYNTH_MODEL`, all defaulting to `CHAT_GPT_MODEL=gpt-4o-mini`) so we can
> upgrade individual roles to `gpt-4o`/Claude later without code changes.

---

## 3. Retrieval strategy per query class (Loong-driven router)

| Class | Strategy | top_k | Hops | Coverage critic |
|-------|----------|-------|------|-----------------|
| **SPOTLIGHT** (factoid / single fact) | one sub-query, deep retrieve, rerank to ~8 | 12→8 | 1 | no |
| **MULTI_HOP** (bridge / "X of the Y that…") | iterative CuriousLLM hops; each hop refines sub-query from prior notes | 8 / hop | ≤4 | no |
| **COMPARISON / AGGREGATION / MULTI_ENTITY** | enumerate entities; **per-entity / per-doc** retrieval (breadth, not just global top-k) | per entity | 1–2 | **yes** |
| **CONVERSATIONAL** (no library evidence needed) | skip retrieval; answer from history | — | 0 | no |

Loong's key warning: a single global top-k starves comparison/aggregation because evidence is spread
across *every* document. The router fixes this by switching to **breadth-first per-entity coverage**.

---

## 4. The Context Document (what GPT actually sees)

Not raw chunks — **distilled, deduplicated, source-anchored notes** (MA-RAG Extractor + MEBench
completeness). Example shape:

```
## Sub-question: "What method does Faster R-CNN use for region proposals?"
- [N1] Region Proposal Network (RPN) shares full-image conv features with the detection network.
      (src: Faster_R-CNN.pdf p.3, fig=F2)
- [N2] RPN enables near cost-free region proposals.  (src: Faster_R-CNN.pdf p.1)

## Sub-question: "Which company has the highest non-current assets?"  [AGGREGATION]
- [N3] BLUE DOLPHIN ENERGY CO — total non-current assets $56,787,000  (src: bluedolphin_10k.pdf p.12, table=T4)
- [N4] CIRTRAN CORP — …  (src: cirtran_10k.pdf p.9, table=T2)
- coverage: 6/6 target companies represented
```

- Each note keeps `{doc_id, page_start/end, visual refs, snippet, score}`.
- The Synthesizer cites notes; we map cited notes → `doc_id` → `gdrive_file_id` → the response's
  `sources[]` (the frontend already renders these as openable PDFs).
- Token-budgeted (`build_evidence_brief` becomes `build_context_document`).

---

## 5. Novelty (claimable for the FYP)

1. **Adaptive query-class router** — most RAG systems run one fixed strategy. Synapse classifies each
   query (Planner) and switches between *deep-spotlight*, *iterative multi-hop (CuriousLLM)*, and
   *breadth-first multi-entity coverage* — directly operationalizing Loong's finding that one strategy
   can't serve all task types.
2. **Extract-then-consolidate context document** — the retriever returns distilled, entity-attributed
   notes (MA-RAG Extractor), not raw chunks. Mitigates "lost-in-the-middle", shrinks tokens, and yields
   precise, verifiable citations.
3. **Completeness / coverage critic loop** — a dedicated agent verifies *all* required entities/docs are
   represented before synthesis and spawns gap-fill retrieval (MEBench's EA-F1 failure mode turned into
   a control loop). Rare in applied tools.
4. **Layout- & modality-aware retrieval (Synapse-unique)** — chunks carry `visual_ids`/`section_heading`
   linking to **captioned figures/tables/formulas**. For quantitative/aggregation/figure queries the
   router boosts table/figure-linked chunks and surfaces the actual visual as evidence. Competitors'
   RAG is text-only; Synapse ingests and reasons over visual content.
5. **Curiosity hops + early termination on a durable, multi-tenant queue** — CuriousLLM's stop-early
   mechanism implemented over `chat_queue`/`batch_stage_jobs` with bounded hops, cutting token cost and
   latency in production (not just a benchmark).

Optional extension: a lightweight **semantic-tag / mini knowledge-graph index** (Financial-QA paper) —
tag chunks with entities/dates/orgs at embedding time to route retrieval and answer multi-entity
queries faster.

---

## 6. Data-model additions (optional, for observability + FYP evaluation)

```sql
-- Log every retrieval run for debugging + evaluation (EA-F1, coverage, hop counts).
create table if not exists public.chat_retrieval_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  thread_id uuid, message_id uuid,
  query_class text, plan jsonb, hops int,
  notes jsonb,            -- distilled notes with source attribution
  coverage jsonb,         -- {target: n, covered: m, missing: [...]}
  source_doc_ids jsonb,   -- final cited docs
  latency_ms int, token_in int, token_out int,
  created_at timestamptz default now()
);

-- Optional: precomputed routing tags (entities / modality) per chunk.
alter table public.chunk_embeddings
  add column if not exists modality text,        -- text | table | figure | formula | caption
  add column if not exists entities jsonb;       -- ["Faster R-CNN","RPN", ...]
```

---

## 7. Evaluation (so the report has numbers)

- **EA-F1** (MEBench): predicted vs gold `(entity, attribute, value)` tuples — measures completeness.
- **Coverage** (Loong): fraction of required source docs actually represented in the context doc.
- **Answer accuracy**: GPT-4 judge vs gold (Loong/MEBench protocol).
- **Cost/latency**: hops, tokens, wall-clock — show CuriousLLM early-termination wins.
- Build a small Synapse eval set from `Test_Samples/Research_pdf` (you already have ~50 papers):
  spotlight, multi-hop, comparison, and a figure/table question for the modality novelty.

---

## 8. Implementation phases

**Phase 1 — Refactor the loop into explicit agents (highest value, low risk).**
Turn `chat_api._chat_impl` into: Planner → Router → (Step Definer → parallel Retriever workers →
Extractor) × hops → Synthesizer. Add `build_context_document` (from `build_evidence_brief`) and keep a
single-hop fast path. New module `backend/chat_agents.py` holds the agent prompts. Source attachment
already works — keep it.

**Phase 2 — Coverage critic + breadth strategy** for COMPARISON/AGGREGATION/MULTI_ENTITY.

**Phase 3 — Layout/modality-aware retrieval** using `visual_ids`/`section_heading` (+ optional entity
tags at embedding time); surface figures/tables as evidence.

**Phase 4 — Eval harness** (`chat_retrieval_runs` + a scored test set) for the report.

### Files touched
- `backend/chat_api.py` — orchestration (`_chat_impl`).
- `backend/chat_runtime.py` — `build_context_document`, extractor/coverage helpers, FTS upgrade.
- `backend/chat_retriever_worker.py` — parallel multi-sub-query fan-out.
- `backend/chat_agents.py` *(new)* — Planner / Step Definer / Extractor / Hop / Coverage prompts.
- `docs/supabase-*.sql` — optional `chat_retrieval_runs`, chunk tags.
```
