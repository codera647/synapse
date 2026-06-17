"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FiChevronDown, FiCheck, FiShare2, FiRefreshCw, FiAlertTriangle } from "react-icons/fi";
import { isLibraryReady } from "@/components/ChatPanel";
import KnowledgeGraphLoader from "@/components/KnowledgeGraphLoader";
import KnowledgeGraphView, { type KGNode, type KGEdge } from "@/components/KnowledgeGraphView";

type OrgLite = { id: string; name: string };
type LibraryLite = { id: string; name: string; pipeline_status?: string | null; status?: string | null; pipeline_progress_percent?: number | null };
type LogFn = (e: { level: "info" | "warn" | "error" | "success"; message: string; details?: unknown }) => void;

type GraphStatus = {
  id: string; status: string; stage?: string | null;
  progress_current?: number; progress_total?: number; node_count?: number; edge_count?: number; error?: string | null;
};

export default function KnowledgeGraphWorkspace({
  supabase,
  organization,
  libraries,
  onLog,
}: {
  supabase: SupabaseClient;
  organization?: OrgLite | null;
  libraries?: LibraryLite[];
  onLog?: LogFn;
}) {
  const [me, setMe] = useState<string | null>(null);
  const [libId, setLibId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [status, setStatus] = useState<GraphStatus | null>(null);
  const [graph, setGraph] = useState<{ nodes: KGNode[]; edges: KGEdge[] } | null>(null);
  const [checking, setChecking] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const ready = useMemo(() => (libraries || []).filter(isLibraryReady), [libraries]);
  const orgId = organization?.id || null;

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setMe(data.user?.id ?? null));
  }, [supabase]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const stopPoll = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  };

  const fetchGraph = useCallback(async (library: string) => {
    try {
      const r = await fetch(`/api/backend/kg/graph?library_id=${encodeURIComponent(library)}&organization_id=${encodeURIComponent(orgId || "")}`, { cache: "no-store" });
      const j = await r.json();
      if (j.nodes) setGraph({ nodes: j.nodes, edges: j.edges || [] });
    } catch (e) {
      onLog?.({ level: "warn", message: "Graph: failed to load", details: e });
    }
  }, [orgId, onLog]);

  const poll = useCallback((library: string) => {
    stopPoll();
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`/api/backend/kg/status?library_id=${encodeURIComponent(library)}&organization_id=${encodeURIComponent(orgId || "")}`, { cache: "no-store" });
        const j = await r.json();
        const g: GraphStatus | null = j.graph || null;
        setStatus(g);
        if (g && (g.status === "done" || g.status === "error" || g.status === "canceled")) {
          stopPoll();
          if (g.status === "done") void fetchGraph(library);
        }
      } catch {
        /* ignore */
      }
    }, 1500);
  }, [orgId, fetchGraph]);

  const selectLibrary = useCallback(async (library: string) => {
    setLibId(library);
    setMenuOpen(false);
    setGraph(null);
    setStatus(null);
    setChecking(true);
    stopPoll();
    try {
      const r = await fetch(`/api/backend/kg/status?library_id=${encodeURIComponent(library)}&organization_id=${encodeURIComponent(orgId || "")}`, { cache: "no-store" });
      const j = await r.json();
      const g: GraphStatus | null = j.graph || null;
      setStatus(g);
      if (g?.status === "done") void fetchGraph(library);
      else if (g && (g.status === "building" || g.status === "queued")) poll(library);
    } catch (e) {
      onLog?.({ level: "warn", message: "Graph: status check failed", details: e });
    } finally {
      setChecking(false);
    }
  }, [orgId, fetchGraph, poll, onLog]);

  useEffect(() => () => stopPoll(), []);

  const build = useCallback(async (rebuild = false) => {
    if (!orgId || !libId) return;
    setGraph(null);
    setStatus({ id: "", status: "queued", stage: "Queued" });
    try {
      const r = await fetch("/api/backend/kg/build", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organization_id: orgId, library_id: libId, created_by_user_id: me, rebuild }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      if (j.graph_id) setStatus({ id: j.graph_id, status: j.status || "queued", stage: "Queued" });
      poll(libId);
    } catch (e) {
      onLog?.({ level: "error", message: "Graph: build failed to start", details: e });
      setStatus({ id: "", status: "error", error: e instanceof Error ? e.message : "failed to start" });
    }
  }, [orgId, libId, me, poll, onLog]);

  const cancel = useCallback(async () => {
    const gid = status?.id;
    stopPoll();
    setStatus((s) => (s ? { ...s, status: "canceled", stage: "Canceling…" } : s));
    if (orgId && gid) {
      try {
        await fetch("/api/backend/kg/cancel", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ organization_id: orgId, graph_id: gid }),
        });
      } catch (e) {
        onLog?.({ level: "warn", message: "Graph: cancel failed", details: e });
      }
    }
  }, [orgId, status, onLog]);

  const fetchNodeChunks = useCallback(async (chunkIds: string[]) => {
    const out: Array<{ chunk_id: string; text: string; doc_title?: string }> = [];
    await Promise.all(chunkIds.map(async (cid) => {
      try {
        const r = await fetch(`/api/backend/document/chunk?chunk_id=${encodeURIComponent(cid)}`, { cache: "no-store" });
        const j = await r.json();
        const text = String(j.text || j.chunk?.text || "");
        if (text) out.push({ chunk_id: cid, text, doc_title: j.doc_title || j.chunk?.doc_title });
      } catch {
        /* ignore */
      }
    }));
    return out;
  }, []);

  const selectedLib = ready.find((l) => l.id === libId) || null;
  const st = status?.status;

  return (
    <div className="flex h-[calc(100vh-5.25rem)] flex-col">
      {/* Header */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold tracking-tight">
          <span className="gradient-text">Knowledge graph</span>
          <span className="ml-2 text-[11px] font-normal text-white/40">Entities &amp; relationships across a library</span>
        </h1>
        <div className="relative ml-auto" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="inline-flex h-9 items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 text-xs font-medium text-white/80 hover:text-white"
          >
            <FiShare2 className="h-3.5 w-3.5 text-violet-300" />
            <span className="max-w-[14rem] truncate">{selectedLib?.name || "Select a library"}</span>
            <FiChevronDown className={`h-3.5 w-3.5 text-white/40 transition-transform ${menuOpen ? "rotate-180" : ""}`} />
          </button>
          {menuOpen ? (
            <div className="surface-menu absolute right-0 top-11 z-30 max-h-72 w-72 max-w-[calc(100vw-1.5rem)] overflow-auto rounded-xl p-1.5 shadow-2xl shadow-black/50">
              <div className="px-2 py-1 text-[9px] uppercase tracking-wide text-white/35">Processed libraries</div>
              {ready.length === 0 ? (
                <div className="px-2.5 py-2 text-xs text-white/40">No processed libraries yet.</div>
              ) : (
                ready.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => void selectLibrary(l.id)}
                    className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs ${l.id === libId ? "bg-violet-500/20 text-white" : "text-white/70 hover:bg-white/6"}`}
                  >
                    <span className="truncate">{l.name}</span>
                    {l.id === libId ? <FiCheck className="h-3.5 w-3.5 shrink-0 text-violet-300" /> : null}
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>
        {st === "done" ? (
          <button
            type="button"
            onClick={() => void build(true)}
            className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 text-xs text-white/60 hover:text-white"
          >
            <FiRefreshCw className="h-3.5 w-3.5" /> Rebuild
          </button>
        ) : null}
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-hidden rounded-2xl">
        {!libId ? (
          <EmptyState title="Pick a library" sub="Select a processed library above, then create its knowledge graph." />
        ) : checking ? (
          <KnowledgeGraphLoader title="Opening the knowledge graph…" subtitle="Looking for an existing graph" />
        ) : st === "building" || st === "queued" ? (
          <KnowledgeGraphLoader stage={status?.stage || undefined} current={status?.progress_current} total={status?.progress_total} onCancel={() => void cancel()} />
        ) : st === "done" && !graph ? (
          <KnowledgeGraphLoader title="Loading the knowledge graph…" subtitle="Drawing entities &amp; relationships" />
        ) : st === "error" ? (
          <div className="grid h-full place-items-center px-6 text-center">
            <div className="max-w-sm">
              <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-amber-500/15">
                <FiAlertTriangle className="h-6 w-6 text-amber-300" />
              </span>
              <div className="text-sm font-medium text-white/85">Couldn&apos;t build the graph</div>
              <p className="mt-1 text-xs text-white/45">{status?.error || "Something went wrong."}</p>
              <button onClick={() => void build(true)} className="btn-grad mt-3 rounded-xl px-4 py-2 text-xs text-white">Try again</button>
            </div>
          </div>
        ) : st === "done" && graph ? (
          <div className="flex h-full flex-col">
            <div className="mb-1 text-[11px] text-white/40">
              {graph.nodes.length} entities · {graph.edges.length} relationships
            </div>
            <div className="min-h-0 flex-1">
              <KnowledgeGraphView nodes={graph.nodes} edges={graph.edges} onNodeChunks={fetchNodeChunks} />
            </div>
          </div>
        ) : (
          <div className="grid h-full place-items-center px-6 text-center">
            <div className="max-w-sm">
              <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500">
                <FiShare2 className="h-6 w-6 text-white" />
              </span>
              <div className="text-sm font-medium text-white/85">Create a knowledge graph for {selectedLib?.name}</div>
              <p className="mt-1 text-xs text-white/45">
                Synapse reads every document in this library, extracts the key entities and how they connect, and draws an interactive graph.
              </p>
              <button onClick={() => void build(false)} className="btn-grad mt-4 rounded-xl px-5 py-2.5 text-sm text-white">
                Create graph
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="grid h-full place-items-center px-6 text-center">
      <div className="max-w-sm">
        <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-white/5">
          <FiShare2 className="h-6 w-6 text-white/50" />
        </span>
        <div className="text-sm font-medium text-white/80">{title}</div>
        <p className="mt-1 text-xs text-white/45">{sub}</p>
      </div>
    </div>
  );
}
