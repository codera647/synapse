-- Phase 2.2 — per-chunk citation locator (format-aware source position).
-- PDFs already cite by page (page_start/end); multi-format ingestion adds a free-text locator
-- so spreadsheets cite "Sheet!rows a-b", code cites "file.py:10-40", etc. Nullable; PDFs leave
-- it null and keep using page numbers.
--
-- Run once in the Supabase SQL editor (BEFORE deploying the backend that writes it).

alter table public.chunk_embeddings
  add column if not exists locator text;
