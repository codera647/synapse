"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  FiArrowUp, FiBarChart2, FiCheck, FiClock, FiFileText, FiFile, FiImage, FiPaperclip, FiPlus, FiX, FiZap,
} from "react-icons/fi";
import AgentArtifact, { type AgentArtifactData } from "@/components/AgentArtifact";
import AgentArtifactsDrawer from "@/components/AgentArtifactsDrawer";
import ChatMarkdown from "@/components/ChatMarkdown";

type OrgLite = { id: string; name: string };
type LibraryLite = { id: string; name: string };
type LogFn = (e: { level: "info" | "warn" | "error" | "success"; message: string; details?: unknown }) => void;

type Upload = { upload_id: string; filename: string; kind: string; preview?: { columns?: string[] } | null };
type AgentMsg = {
  id: string;
  role: "user" | "assistant" | "clarification" | "system";
  content: string;
  artifacts?: AgentArtifactData[];
  questions?: Array<{ question: string; why?: string; options?: string[] }>;
};

const VISUAL_TYPES: Array<{ key: string; label: string }> = [
  { key: "bar", label: "Bar" },
  { key: "line", label: "Line" },
  { key: "pie", label: "Pie" },
  { key: "scatter", label: "Scatter" },
  { key: "area", label: "Area" },
  { key: "flowchart", label: "Flowchart" },
];

type RunLite = { id: string; title: string; status: string; updated_at: string };

export default function AgentPanel({
  supabase,
  organization,
  libraries,
  currentUserId,
  onLog,
}: {
  supabase: SupabaseClient;
  organization: OrgLite | null;
  libraries: LibraryLite[];
  currentUserId: string | null;
  onLog?: LogFn;
}) {
  const [selectedLibs, setSelectedLibs] = useState<string[]>([]);
  const [libMenuOpen, setLibMenuOpen] = useState(false);
  const [visualTypes, setVisualTypes] = useState<Set<string>>(new Set(["bar", "line"]));
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<AgentMsg[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [runs, setRuns] = useState<RunLite[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [drawerMode, setDrawerMode] = useState<"visuals" | "docs" | null>(null);

  const libMenuRef = useRef<HTMLDivElement | null>(null);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (libMenuRef.current && !libMenuRef.current.contains(e.target as Node)) setLibMenuOpen(false);
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) setHistoryOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  // ── Persistence: load past runs, and reload the most recent one on mount (survives refresh). ──
  const mapArtifactRow = (a: Record<string, unknown>): AgentArtifactData => ({
    artifact_id: String(a.id),
    kind: (a.kind as string | null) ?? null,
    format: (a.format as "vega_lite" | "mermaid") ?? "vega_lite",
    title: (a.title as string | null) ?? null,
    alt_text: (a.alt_text as string | null) ?? null,
    spec_key: (a.spec_key as string | null) ?? null,
    png_key: (a.png_key as string | null) ?? null,
    mermaid_text: (a.mermaid_text as string | null) ?? null,
    render_status: (a.render_status as string | null) ?? "ok",
  });

  const loadRuns = useCallback(async () => {
    if (!organization?.id) return;
    const { data } = await supabase
      .from("agent_runs")
      .select("id, title, status, updated_at")
      .eq("organization_id", organization.id)
      .order("updated_at", { ascending: false })
      .limit(40);
    setRuns(
      ((data as Array<Record<string, unknown>>) || []).map((r) => ({
        id: String(r.id),
        title: String(r.title || "Agent run"),
        status: String(r.status || ""),
        updated_at: String(r.updated_at || ""),
      })),
    );
  }, [organization?.id, supabase]);

  const loadRun = useCallback(
    async (id: string) => {
      if (!organization?.id) return;
      const [{ data: msgs }, { data: arts }] = await Promise.all([
        supabase
          .from("agent_messages")
          .select("id, role, content, created_at")
          .eq("run_id", id)
          .eq("organization_id", organization.id)
          .order("created_at", { ascending: true }),
        supabase
          .from("agent_artifacts")
          .select("id, message_id, kind, format, title, alt_text, spec_key, png_key, mermaid_text, render_status, created_at")
          .eq("run_id", id)
          .eq("organization_id", organization.id)
          .order("created_at", { ascending: true }),
      ]);
      const artByMsg: Record<string, AgentArtifactData[]> = {};
      ((arts as Array<Record<string, unknown>>) || []).forEach((a) => {
        const mid = String(a.message_id || "");
        (artByMsg[mid] ||= []).push(mapArtifactRow(a));
      });
      const reconstructed: AgentMsg[] = ((msgs as Array<Record<string, unknown>>) || []).map((m) => ({
        id: String(m.id),
        role: String(m.role || "assistant") as AgentMsg["role"],
        content: String(m.content || ""),
        artifacts: String(m.role) === "assistant" ? artByMsg[String(m.id)] || [] : undefined,
      }));
      setMessages(reconstructed);
      setRunId(id);
      setUploads([]);
    },
    [organization?.id, supabase],
  );

  useEffect(() => {
    if (!organization?.id) return;
    let alive = true;
    (async () => {
      await loadRuns();
      if (!alive) return;
      const { data } = await supabase
        .from("agent_runs")
        .select("id")
        .eq("organization_id", organization.id)
        .order("updated_at", { ascending: false })
        .limit(1);
      const latest = (data as Array<{ id: string }> | null)?.[0]?.id;
      if (alive && latest && messages.length === 0 && !runId) void loadRun(latest);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organization?.id]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  const selectedLibNames = useMemo(
    () => libraries.filter((l) => selectedLibs.includes(l.id)).map((l) => l.name),
    [libraries, selectedLibs],
  );

  const toggleLib = (id: string) =>
    setSelectedLibs((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const toggleType = (k: string) =>
    setVisualTypes((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const uploadFiles = async (files: FileList | File[]) => {
    if (!organization?.id) return;
    for (const file of Array.from(files)) {
      try {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("organization_id", organization.id);
        if (currentUserId) fd.append("created_by_user_id", currentUserId);
        if (runId) fd.append("run_id", runId);
        const res = await fetch("/api/agent/upload", { method: "POST", body: fd });
        const j = (await res.json()) as Upload & { error?: string };
        if (!res.ok || j.error || !j.upload_id) throw new Error(j.error || `upload ${res.status}`);
        setUploads((prev) => [...prev, { upload_id: j.upload_id, filename: j.filename, kind: j.kind, preview: j.preview }]);
      } catch (e) {
        onLog?.({ level: "error", message: "Agent: file upload failed", details: e });
      }
    }
  };

  const newRun = () => {
    setMessages([]);
    setRunId(null);
    setUploads([]);
    setPrompt("");
  };

  const run = async () => {
    const text = prompt.trim();
    if (!text || running || !organization?.id) return;
    const rid = (crypto as { randomUUID?: () => string }).randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    setMessages((prev) => [...prev, { id: `${rid}-u`, role: "user", content: text }]);
    setRunning(true);
    setStatus("Starting…");
    setPrompt("");

    const history = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-10)
      .map((m) => ({ role: m.role, content: m.content }));

    const poll = setInterval(async () => {
      try {
        const r = await fetch(`/api/backend/agent/status?rid=${encodeURIComponent(rid)}`, { cache: "no-store" });
        const j = (await r.json()) as { stage?: string };
        if (j.stage) setStatus(j.stage);
      } catch {
        /* ignore */
      }
    }, 1200);

    try {
      const res = await fetch("/api/backend/agent/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organization_id: organization.id,
          created_by_user_id: currentUserId,
          library_ids: selectedLibs,
          upload_ids: uploads.map((u) => u.upload_id),
          message: text,
          visual_types: Array.from(visualTypes),
          thinking_mode: "high",
          history,
          client_request_id: rid,
          run_id: runId,
        }),
      });
      const j = (await res.json()) as {
        error?: string;
        status?: string;
        run_id?: string;
        message_id?: string;
        narrative?: string;
        artifacts?: AgentArtifactData[];
        clarifying_questions?: Array<{ question: string; why?: string; options?: string[] }>;
      };
      if (!res.ok || j.error) throw new Error(j.error || `run ${res.status}`);
      if (j.run_id) setRunId(j.run_id);
      void loadRuns(); // the backend persisted the run — refresh the history list

      if (j.status === "needs_clarification") {
        setMessages((prev) => [
          ...prev,
          { id: `${rid}-c`, role: "clarification", content: "", questions: j.clarifying_questions || [] },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          {
            id: j.message_id || `${rid}-a`,
            role: "assistant",
            content: j.narrative || "Here are the visuals I created.",
            artifacts: j.artifacts || [],
          },
        ]);
      }
    } catch (e) {
      onLog?.({ level: "error", message: "Agent: run failed", details: e });
      setMessages((prev) => [
        ...prev,
        { id: `${rid}-e`, role: "system", content: `Something went wrong: ${e instanceof Error ? e.message : "unknown error"}` },
      ]);
    } finally {
      clearInterval(poll);
      setRunning(false);
      setStatus("");
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Top controls */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {/* Library picker */}
        <div className="relative" ref={libMenuRef}>
          <button
            type="button"
            onClick={() => setLibMenuOpen((v) => !v)}
            className="inline-flex h-9 items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 text-xs font-medium text-white/80 hover:text-white"
          >
            <FiPlus className="h-3.5 w-3.5 text-violet-300" />
            {selectedLibs.length === 0
              ? "Select libraries"
              : `${selectedLibs.length} librar${selectedLibs.length === 1 ? "y" : "ies"}`}
          </button>
          {libMenuOpen ? (
            <div className="surface-menu absolute left-0 top-11 z-30 max-h-72 w-72 overflow-auto rounded-xl p-1.5 shadow-2xl shadow-black/50">
              <div className="px-2 py-1 text-[9px] uppercase tracking-wide text-white/35">Your processed libraries</div>
              {libraries.length === 0 ? (
                <div className="px-2.5 py-2 text-xs text-white/40">No processed libraries yet.</div>
              ) : (
                libraries.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => toggleLib(l.id)}
                    className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                      selectedLibs.includes(l.id) ? "bg-violet-500/20 text-white" : "text-white/70 hover:bg-white/6"
                    }`}
                  >
                    <span className="truncate">{l.name}</span>
                    {selectedLibs.includes(l.id) ? <FiCheck className="h-3.5 w-3.5 shrink-0 text-violet-300" /> : null}
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>

        {/* Action chips */}
        <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-white/5 p-1">
          <span className="inline-flex items-center gap-1.5 rounded-lg btn-grad px-2.5 py-1.5 text-xs font-medium text-white">
            <FiBarChart2 className="h-3.5 w-3.5" /> Visuals
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-white/30" title="Coming soon">
            <FiFileText className="h-3.5 w-3.5" /> Docs
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-white/30" title="Coming soon">
            <FiFile className="h-3.5 w-3.5" /> PDF
          </span>
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          {/* Run history */}
          <div className="relative" ref={historyRef}>
            <button
              type="button"
              onClick={() => setHistoryOpen((v) => !v)}
              title="Run history"
              className="grid h-9 w-9 place-items-center rounded-xl border border-white/10 bg-white/5 text-white/60 hover:text-white"
            >
              <FiClock className="h-4 w-4" />
            </button>
            {historyOpen ? (
              <div className="surface-menu absolute right-0 top-11 z-30 max-h-80 w-72 overflow-auto rounded-xl p-1.5 shadow-2xl shadow-black/50">
                <div className="px-2 py-1 text-[9px] uppercase tracking-wide text-white/35">Recent runs</div>
                {runs.length === 0 ? (
                  <div className="px-2.5 py-2 text-xs text-white/40">No past runs.</div>
                ) : (
                  runs.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => {
                        setHistoryOpen(false);
                        void loadRun(r.id);
                      }}
                      className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                        r.id === runId ? "bg-violet-500/20 text-white" : "text-white/70 hover:bg-white/6"
                      }`}
                    >
                      <span className="truncate">{r.title}</span>
                      {r.id === runId ? <FiCheck className="h-3.5 w-3.5 shrink-0 text-violet-300" /> : null}
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </div>

          {/* Visuals / Docs drawers */}
          <button
            type="button"
            onClick={() => setDrawerMode("visuals")}
            title="Your visuals"
            className="grid h-9 w-9 place-items-center rounded-xl border border-white/10 bg-white/5 text-white/60 hover:text-white"
          >
            <FiImage className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setDrawerMode("docs")}
            title="Your documents"
            className="grid h-9 w-9 place-items-center rounded-xl border border-white/10 bg-white/5 text-white/60 hover:text-white"
          >
            <FiFileText className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={newRun}
            className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 text-xs text-white/60 hover:text-white"
          >
            New
          </button>
        </div>
      </div>

      <AgentArtifactsDrawer
        supabase={supabase}
        organization={organization}
        open={drawerMode !== null}
        mode={drawerMode ?? "visuals"}
        onClose={() => setDrawerMode(null)}
      />

      {/* Visual type multiselect */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wide text-white/35">Visual types</span>
        {VISUAL_TYPES.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => toggleType(t.key)}
            className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${
              visualTypes.has(t.key)
                ? "bg-violet-500/25 text-white border border-violet-400/40"
                : "border border-white/10 text-white/50 hover:text-white"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Conversation */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto rounded-2xl border border-white/8 bg-white/[0.02] p-4"
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files?.length) void uploadFiles(e.dataTransfer.files);
        }}
      >
        {messages.length === 0 ? (
          <div className="grid h-full place-items-center text-center">
            <div className="max-w-md">
              <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500">
                <FiZap className="h-6 w-6 text-white" />
              </span>
              <div className="text-sm font-medium text-white/85">Create visuals from your data</div>
              <p className="mt-1 text-xs text-white/45">
                Pick libraries or attach a file, choose the chart types, and describe what to visualize.
                {dragOver ? " Drop to attach." : ""}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((m) => (
              <MessageRow key={m.id} m={m} onAnswer={(ans) => { setPrompt(ans); }} />
            ))}
            {running ? (
              <div className="flex items-center gap-2 text-xs text-white/55">
                <span className="h-2 w-2 animate-pulse rounded-full bg-violet-400" />
                {status || "Working…"}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* Attached files */}
      {uploads.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {uploads.map((u) => (
            <span key={u.upload_id} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-white/70">
              <FiPaperclip className="h-3 w-3 text-violet-300" />
              <span className="max-w-[14rem] truncate">{u.filename}</span>
              {u.kind === "structured" && u.preview?.columns ? (
                <span className="text-white/35">({u.preview.columns.length} cols)</span>
              ) : null}
              <button type="button" onClick={() => setUploads((prev) => prev.filter((x) => x.upload_id !== u.upload_id))}>
                <FiX className="h-3 w-3 text-white/40 hover:text-white" />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {/* Composer */}
      <div className="mt-2 rounded-2xl border border-white/10 bg-white/[0.04] p-2">
        <div className="flex items-end gap-2">
          <button
            type="button"
            title="Attach a file"
            onClick={() => fileRef.current?.click()}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-white/10 text-white/60 hover:text-white"
          >
            <FiPaperclip className="h-4 w-4" />
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) void uploadFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void run();
              }
            }}
            rows={1}
            placeholder="Describe the visuals to create — e.g. “bar chart of revenue by quarter and the trend as a line”."
            className="max-h-40 min-h-[2.25rem] flex-1 resize-none bg-transparent px-1 py-2 text-sm text-white/90 outline-none placeholder:text-white/30"
          />
          <button
            type="button"
            onClick={() => void run()}
            disabled={running || !prompt.trim() || !organization?.id}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl btn-grad text-white disabled:opacity-40"
            title="Run"
          >
            <FiArrowUp className="h-4 w-4" />
          </button>
        </div>
        {selectedLibNames.length > 0 ? (
          <div className="px-1 pt-1 text-[10px] text-white/35">Using: {selectedLibNames.join(", ")}</div>
        ) : null}
      </div>
    </div>
  );
}

function MessageRow({ m, onAnswer }: { m: AgentMsg; onAnswer: (ans: string) => void }) {
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl bg-gradient-to-br from-violet-600 to-fuchsia-600 px-4 py-2 text-sm text-white">
          {m.content}
        </div>
      </div>
    );
  }
  if (m.role === "system") {
    return <div className="text-xs text-amber-200/80">{m.content}</div>;
  }
  if (m.role === "clarification") {
    return (
      <div className="rounded-2xl border border-violet-400/25 bg-violet-500/10 p-3">
        <div className="mb-2 text-xs font-medium text-violet-200">A quick clarification before I build this:</div>
        {(!m.questions || m.questions.length === 0) && m.content ? (
          <div className="whitespace-pre-wrap text-sm text-white/85">{m.content}</div>
        ) : null}
        <div className="space-y-2">
          {(m.questions || []).map((q, i) => (
            <div key={i}>
              <div className="text-sm text-white/85">{q.question}</div>
              {q.why ? <div className="text-[11px] text-white/40">{q.why}</div> : null}
              {q.options && q.options.length ? (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {q.options.map((o, j) => (
                    <button
                      key={j}
                      type="button"
                      onClick={() => onAnswer(o)}
                      className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-white/70 hover:text-white"
                    >
                      {o}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
        <div className="mt-2 text-[11px] text-white/40">Answer in the box below to continue.</div>
      </div>
    );
  }
  // assistant
  return (
    <div>
      <div className="text-[11px] font-semibold text-white/50">Agent</div>
      <div className="mt-1 text-sm text-white/85">
        <ChatMarkdown content={m.content} />
      </div>
      {(m.artifacts || []).length > 0 ? (
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {(m.artifacts || []).map((a) => (
            <AgentArtifact key={a.artifact_id} artifact={a} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
