# Synapse — Agent Dashboards (PowerBI/Tableau-style, NL-generated + editable)

## Context & goal
Extend Agent mode so a user can **upload a business dataset, and Synapse generates an editable,
multi-tile dashboard** (KPIs + charts) from a natural-language goal — a lightweight PowerBI/Tableau.
Reuses the Agent stack (Claude planning, Vega-Lite rendering, artifact persistence) but adds a real
**query engine + text-to-SQL** for exact metrics and an **editable dashboard canvas**.

## The one architectural rule (non-negotiable)
**Dashboard numbers must NOT come from CRAG/embeddings/retrieval.** A dashboard is exact aggregation
over the *full* dataset (`SELECT region, SUM(revenue) GROUP BY region`); retrieval only returns a few
chunks and cannot aggregate (our own eval confirmed aggregate queries fail via RAG). So:
- **Metrics path (deterministic):** load the real table → run **SQL on DuckDB** → exact results → bind
  to Vega-Lite.
- **Claude:** schema + goal → proposes tiles as **{title, SQL, chart type, layout}** (text-to-SQL +
  analytics planning).
- **CRAG (optional, phase 2):** only for *business semantics* — if the user also uploads a data
  dictionary / docs, retrieve them so Claude understands column meanings + KPI definitions. Never for
  the numbers.

## Data model — `docs/supabase-agent-dashboards.sql`
Mirror the chat/agent RLS pattern (`is_org_member`).
- `agent_datasets(id, organization_id, created_by_user_id, name, source_kind in
  (upload|library_doc|db), storage_key (R2 parquet), schema jsonb, row_count, created_at)`
- `agent_dashboards(id, organization_id, created_by_user_id, dataset_id, title,
  layout jsonb, filters jsonb default '[]', status, created_at, updated_at)`
- `agent_dashboard_tiles(id, dashboard_id, organization_id, title, tile_kind in (kpi|chart),
  chart_kind, sql text, vega_spec jsonb, data_binding jsonb, position jsonb {x,y,w,h},
  sort int, last_error text, created_at)`
- Realtime publication on `agent_dashboard_tiles` (live edits across teammates), same as chat.

## Backend (new files under `backend/`)
- **`agent_sql.py`** — DuckDB query engine:
  - `ingest_dataset(raw_bytes, filename, mime) -> {parquet_bytes, schema, row_count}`: CSV/Excel via
    `load_tabular` (reuse) → DuckDB → write Parquet (columnar, fast); SQLite via DuckDB `ATTACH`.
    `schema` = columns + types + sample rows + light stats (distinct count, min/max) for the planner.
  - `run_sql(parquet_key, sql, limit=10000) -> {columns, rows}`: load Parquet from R2 into an
    in-memory DuckDB, run **read-only** SQL (reject non-SELECT / file functions / attach), cap rows.
  - `validate_sql(sql, schema) -> (ok, errors)`: parse, assert single SELECT, columns exist, dry-run
    with `LIMIT 0`.
- **`agent_dashboard.py`** — orchestration:
  - `plan_dashboard(goal, schema) -> {title, tiles[]}` (Claude, via `agent_llm`): each tile =
    `{title, tile_kind, chart_kind, sql, data_binding, position}`. Prompt: use ONLY real columns;
    KPIs as single-value SQL; 4–8 tiles; a sensible grid layout.
  - For each tile: `validate_sql` → `run_sql` → bind data into a Vega-Lite spec (reuse
    `agent_specs.bind_data` + `validate_vega`); one Claude `repair_sql` retry on failure, else mark
    the tile `last_error` (dashboard still renders the rest).
  - Persist `agent_datasets` + `agent_dashboards` + `agent_dashboard_tiles`.
- **`agent_api.py`** additions (reuse progress/error/persistence helpers):
  - `POST /agent/dataset` — ingest an upload (or a library doc / DB conn) → Parquet + schema → row.
  - `POST /agent/dashboard/create` — `{dataset_id, goal, thinking_mode}` → plan → exec tiles →
    persist → return dashboard + tiles (+ data). Long-running (add to the catch-all proxy's long list).
  - `POST /agent/dashboard/tile/run` — `{dashboard_id, sql, chart_kind, filters}` → validate + run →
    `{columns, rows, vega_spec}`. Powers **live tile editing** (edit SQL/type → re-run instantly).
  - `POST /agent/dashboard/save` — persist edited layout/tiles (drag/resize, chart type, SQL).
  - `POST /agent/dashboard/refresh` — re-run all tiles (data changed).
  - `GET  /agent/dashboard/{id}` — load a dashboard + tiles + fresh data.

### Deterministic data flow
```
upload → ingest_dataset (DuckDB → Parquet in R2) + schema
Claude plan_dashboard(goal, schema) → tiles[] {title, sql, chart_kind, position}
per tile: validate_sql → run_sql (exact) → bind_data → Vega-Lite spec
persist dataset + dashboard + tiles ; return for the canvas
```

## Frontend
- **New surface:** a **Dashboards** view. Creation stays NL-driven via Agent mode (a new **"Dashboard"
  action** in `AgentPanel`: pick/upload a dataset + describe the goal → `POST /dashboard/create` →
  opens the canvas). The dashboard itself renders on a dedicated **full-width editable canvas**, and
  past dashboards list in a drawer/section.
- **`components/DashboardCanvas.tsx`** (new): a **`react-grid-layout`** grid of tiles.
  - **Tile**: KPI (big number + label) or chart (reuse `AgentArtifact`'s Vega render). Drag to move,
    handle to resize → `onLayoutChange` updates positions.
  - **Tile toolbar**: change chart type, **edit SQL** (small code box → `tile/run` → live preview),
    duplicate, delete. **Add tile** (blank or NL: "add a chart of X" → Claude makes one tile).
  - **Save** (persist layout/tiles), **Refresh** (re-run data).
  - **Filters bar** (phase 2): slicers (dropdown/date range) → re-run tiles with `WHERE`.
- **`components/DashboardsDrawer.tsx`** / list — open a saved dashboard.
- New deps: `react-grid-layout` (+ `react-resizable`). Vega/mermaid already installed.

## Reuse vs new
- **Reuse:** `agent_llm` (Claude), `agent_specs` (validate/bind/render Vega + PNG), `agent_data`
  (`load_tabular`, R2 helpers, uploads), the agent action/persistence/progress patterns, `react-vega`.
- **New:** DuckDB query engine + text-to-SQL (`agent_sql`), dashboard orchestration
  (`agent_dashboard`), dashboard/tile/dataset tables, the editable `DashboardCanvas`.
- **New deps:** backend `duckdb`, `pyarrow`; frontend `react-grid-layout`.

## Phasing
- **Phase 1 (MVP):** file upload (CSV / Excel / SQLite) → DuckDB/Parquet → Claude proposes 4–8 tiles
  (KPIs + bar/line/pie/area/scatter/table) → exact aggregates → editable grid (drag/resize, change
  chart type, **edit SQL**) → save/reload. Show the SQL per tile (trust + correctness).
- **Phase 2:** global **filters/slicers** + cross-filtering; **refresh**; **add-tile via NL**; CRAG
  **business-context** (upload a data dictionary → better semantics); export dashboard → PDF (reuse
  `agent_docs`).
- **Phase 3:** **live DB connections** (Postgres/MySQL via DuckDB scanner or direct), scheduled
  refresh, drill-down.

## Risks & mitigations
1. **Text-to-SQL correctness** (wrong SQL → wrong numbers): validate against the actual schema, one
   Claude repair retry, **always show the tile's SQL** and let the user edit it; dry-run `LIMIT 0`.
2. **SQL safety** (user data + model SQL): DuckDB **read-only**, single-SELECT allowlist, reject
   `attach`/`copy`/file functions, row cap, per-org Parquet prefix.
3. **Scale:** Parquet + DuckDB stream large data; cap result rows; aggregate server-side (never ship
   raw rows to the browser).
4. **`duckdb` wheel** on the GCP L4 box: verify install; lazy-import so the API boots without it
   (dashboards degrade off) — same pattern as `vl-convert`.
5. **"Editable" = real persistence**: the dashboard *definition* (tiles + SQL + layout) is the source
   of truth; data is recomputed on load/refresh, never frozen.

## Verification (end-to-end)
1. Upload a sales CSV → `/agent/dataset` returns a schema with correct column types + row_count.
2. "Build me a sales overview dashboard" → 4–8 tiles render with **exact** numbers (cross-check a SUM
   against the raw file); each tile shows its SQL.
3. Drag/resize a tile, change a bar→line, edit a tile's SQL → live re-run → **Save** → reload the
   dashboard → edits persisted.
4. Refresh after editing the source data → numbers update.
5. A deliberately hard ask (a metric needing a join/derived column) → either correct SQL or a clean
   per-tile error (no silent wrong number).

## Decisions to confirm
- **v1 data sources:** file uploads only (CSV/Excel/SQLite) — *recommended*; live DB connectors are
  Phase 3.
- **v1 editability:** rearrange/resize + change chart type + **edit SQL** (MVP); filters/slicers in
  Phase 2.
- **Surface:** create via the Agent "Dashboard" action, render/edit on a dedicated canvas — vs a fully
  separate Dashboards page. (Recommend: agent-created, canvas-rendered.)
