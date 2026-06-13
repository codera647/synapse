"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  FiChevronLeft,
  FiChevronRight,
  FiMessageSquare,
  FiPlus,
  FiSearch,
  FiSend,
  FiSquare,
  FiTrash2,
  FiCopy,
  FiEdit3,
  FiBookOpen,
  FiX,
  FiArrowUp,
  FiCheck,
} from "react-icons/fi";
import ChatMarkdown from "@/components/ChatMarkdown";
import ChatMessageSources from "@/components/ChatMessageSources";
import ContextMeter from "@/components/ContextMeter";

type LibraryLite = {
  id: string;
  name: string;
  pipeline_status?: string | null;
  pipeline_progress_percent?: number | null;
};

type OrgLite = { id: string; name: string };

type ChatSource = {
  library_id: string;
  doc_id: string;
  doc_title?: string | null;
  path_in_source?: string | null;
  gdrive_file_id?: string | null;
  page_start?: number | null;
  page_end?: number | null;
  chunk_id?: string | null;
  score?: number | null;
  storage_path_raw?: string | null;
};

type ChatResponse = {
  answer: string;
  sources?: ChatSource[];
  followups?: Array<{ hop: number; query: string }>;
  client_request_id?: string | null;
  client_prompt_hash?: string | null;
  server_prompt_hash?: string | null;
};

type Thread = {
  id: string;
  title: string;
  updatedAt: number;
  lastSnippet: string;
  selectedLibraryIds?: string[];
  parentThreadId?: string | null;
  rootThreadId?: string | null;
};

type ThreadRow = {
  id: string;
  title: string | null;
  updated_at: string | null;
  selected_library_ids: string[] | null;
  parent_thread_id?: string | null;
  root_thread_id?: string | null;
};

type MessageRow = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  status: string | null;
  created_at: string | null;
};

type SourceRow = {
  message_id: string;
  library_id: string | null;
  doc_id: string | null;
  doc_title: string | null;
  storage_path_raw: string | null;
  chunk_id: string | null;
  page_start: number | null;
  page_end: number | null;
  score: number | null;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  ts: number;
  status?: "draft" | "streaming" | "typing" | "done" | "stopped" | "error";
  sources?: ChatSource[];
  followups?: Array<{ hop: number; query: string }>;
};

function TypingIndicator() {
  return (
    <div className="synapse-typing" aria-label="Thinking">
      <span className="synapse-typing__dot" />
      <span className="synapse-typing__dot" />
      <span className="synapse-typing__dot" />
    </div>
  );
}

function makeId() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function formatClock(ts: number) {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function isUuid(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function extractDriveFileId(gdriveFileId?: string | null, storageKey?: string | null) {
  const candidates = [gdriveFileId || "", storageKey || ""];
  for (const s of candidates) {
    const text = String(s || "").trim();
    if (!text) continue;

    // Full Google Drive URL
    let m = /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]{10,})/i.exec(text);
    if (m?.[1]) return m[1];
    m = /[?&]id=([a-zA-Z0-9_-]{20,})/i.exec(text);
    if (m?.[1]) return m[1];

    // Raw file id
    if (/^[a-zA-Z0-9_-]{20,}$/.test(text)) return text;

    // Common sync key pattern: "...raw_<fileId>-<filename>.pdf" but fileId itself may contain '-',
    // so use a heuristic on the basename.
    const base = text.split("/").pop() || text;
    const rawIdx = base.toLowerCase().indexOf("raw_");
    if (rawIdx >= 0) {
      const after = base.slice(rawIdx + 4);
      const parts = after.split("-");
      // Build up segments until we have a plausible Drive id (>=25 chars) and the next token looks like a filename.
      const idParts: string[] = [];
      for (let i = 0; i < Math.max(0, parts.length - 1); i++) {
        idParts.push(parts[i] || "");
        const candidate = idParts.join("-");
        const next = parts[i + 1] || "";
        if (candidate.length >= 25 && /\\.pdf$/i.test(next)) return candidate;
        if (candidate.length >= 25 && /\\.[a-z0-9]{2,4}$/i.test(next)) return candidate;
      }
      // Fallback: take a long token prefix
      const fallback = after.match(/[a-zA-Z0-9_-]{25,}/)?.[0];
      if (fallback) return fallback;
    }
  }
  return null;
}

const SUMMARY_MARKER = "[[SYNAPSE_THREAD_SUMMARY]]";

function extractSummary(content: string) {
  if (!content) return null;
  const idx = content.indexOf(SUMMARY_MARKER);
  if (idx === -1) return null;
  return content.slice(idx + SUMMARY_MARKER.length).trim() || null;
}

function approxTokensFromText(text: string) {
  // Rough heuristic used for budgeting (ChatGPT-style).
  // For English text: ~4 chars per token.
  return Math.ceil((text || "").length / 4);
}

export default function ChatPanel({
  supabase,
  organization,
  libraries,
  selectedLibraryIds,
  onChangeSelectedLibraryIds,
  onSources,
  onLog,
}: {
  supabase: SupabaseClient;
  organization: OrgLite | null;
  libraries: LibraryLite[];
  selectedLibraryIds: string[];
  onChangeSelectedLibraryIds: (ids: string[]) => void;
  onSources?: (sources: ChatSource[]) => void;
  onLog?: (e: { level: "info" | "warn" | "error" | "success"; message: string; details?: unknown }) => void;
}) {
  const abortRef = useRef<AbortController | null>(null);
  const assistantDraftIdRef = useRef<string | null>(null);
  const lastAnswerRef = useRef<string | null>(null);
  const lastPromptRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Whether the chat is "stuck" to the bottom — true while the user is near the bottom, so the
  // view follows streaming/typing text. Set false when they scroll up to read history.
  const stickToBottomRef = useRef(true);

  const [prompt, setPrompt] = useState("");
  const [thinking, setThinking] = useState(false);
  // True while context-window auto-compaction is summarizing a full chat and spawning the
  // linked continuation thread — drives the "starting a linked chat…" loading banner.
  const [compacting, setCompacting] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [threadQuery, setThreadQuery] = useState("");
  const [historyOpen, setHistoryOpen] = useState(true);
  const [libraryPickerOpen, setLibraryPickerOpen] = useState(false);

  const [threads, setThreads] = useState<Thread[]>(() => []);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messagesByThread, setMessagesByThread] = useState<Record<string, ChatMessage[]>>({});

  const canSend = prompt.trim().length > 0 && !thinking;

  // Only expose libraries that are fully processed.
  const readyLibraries = useMemo(() => {
    return libraries
      .filter((l) => (l.pipeline_status ?? "").toLowerCase() === "completed")
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [libraries]);

  const activeMessages = useMemo(() => {
    if (!activeThreadId) return [];
    return messagesByThread[activeThreadId] ?? [];
  }, [activeThreadId, messagesByThread]);

  const displayMessages = useMemo(() => {
    return activeMessages.filter((m) => m.role !== "system");
  }, [activeMessages]);

  const filteredThreads = useMemo(() => {
    const q = threadQuery.trim().toLowerCase();
    const list = [...threads].sort((a, b) => b.updatedAt - a.updatedAt);
    if (!q) return list;
    return list.filter((t) => `${t.title} ${t.lastSnippet}`.toLowerCase().includes(q));
  }, [threads, threadQuery]);

  // Group threads into lineages (a chat + the continuation chats auto-spawned when its context
  // filled). Produces a flat, ordered list where each row knows its position in its lineage, so
  // the sidebar can draw a connected timeline (main → child → grandchild).
  const threadTree = useMemo(() => {
    const byId = new Map(threads.map((t) => [t.id, t]));
    const lineageKey = (t: Thread) => t.rootThreadId || t.id;
    const depthOf = (t: Thread) => {
      let d = 0;
      let cur: Thread | undefined = t;
      const seen = new Set<string>();
      while (cur?.parentThreadId && !seen.has(cur.id)) {
        seen.add(cur.id);
        cur = byId.get(cur.parentThreadId);
        d += 1;
        if (d > 50) break;
      }
      return d;
    };

    const groups = new Map<string, Thread[]>();
    for (const t of threads) {
      const k = lineageKey(t);
      const arr = groups.get(k) ?? [];
      arr.push(t);
      groups.set(k, arr);
    }

    const ordered = [...groups.values()].sort(
      (a, b) => Math.max(...b.map((t) => t.updatedAt)) - Math.max(...a.map((t) => t.updatedAt)),
    );

    // One entry per lineage, each a list of its threads ordered root → continuation(s).
    const lineages: { thread: Thread; idxInLineage: number; lineageSize: number }[][] = [];
    for (const arr of ordered) {
      const sorted = [...arr].sort((a, b) => depthOf(a) - depthOf(b) || a.updatedAt - b.updatedAt);
      lineages.push(sorted.map((t, i) => ({ thread: t, idxInLineage: i, lineageSize: sorted.length })));
    }
    return lineages;
  }, [threads]);

  const selectedSet = useMemo(() => new Set(selectedLibraryIds), [selectedLibraryIds]);
  const selectedLibrariesLabel = useMemo(() => {
    if (selectedLibraryIds.length === 0) return "Select libraries";
    if (selectedLibraryIds.length === 1) {
      const l = readyLibraries.find((x) => x.id === selectedLibraryIds[0]);
      return l?.name ?? "1 library selected";
    }
    return `${selectedLibraryIds.length} libraries`;
  }, [readyLibraries, selectedLibraryIds]);

  const toggleLibrary = (id: string) => {
    onChangeSelectedLibraryIds(
      selectedSet.has(id) ? selectedLibraryIds.filter((x) => x !== id) : [...selectedLibraryIds, id]
    );
  };

  const loadThreads = async () => {
    if (!organization?.id) return;
    const { data, error } = await supabase
      .from("chat_threads")
      .select("id, title, updated_at, selected_library_ids, parent_thread_id, root_thread_id")
      .eq("organization_id", organization.id)
      .order("updated_at", { ascending: false })
      .limit(80);

    if (error) {
      onLog?.({ level: "warn", message: "Chat: failed to load threads", details: error });
      return;
    }

    const rows = Array.isArray(data) ? (data as unknown as ThreadRow[]) : [];
    const list: Thread[] = rows.map((r) => ({
      id: String(r.id),
      title: String(r.title || "Chat"),
      updatedAt: new Date(String(r.updated_at || new Date().toISOString())).getTime(),
      lastSnippet: "",
      selectedLibraryIds: Array.isArray(r.selected_library_ids) ? r.selected_library_ids.map(String) : [],
      parentThreadId: r.parent_thread_id ? String(r.parent_thread_id) : null,
      rootThreadId: r.root_thread_id ? String(r.root_thread_id) : null,
    }));
    setThreads(list);
    if (!activeThreadId && list[0]?.id) setActiveThreadId(list[0].id);
  };

  const loadMessages = async (threadId: string) => {
    if (!organization?.id) return;
    const { data, error } = await supabase
      .from("chat_messages")
      .select("id, role, content, status, created_at")
      .eq("organization_id", organization.id)
      .eq("thread_id", threadId)
      .order("created_at", { ascending: true })
      .limit(500);

    if (error) {
      onLog?.({ level: "warn", message: "Chat: failed to load messages", details: error });
      return;
    }

    const rows = Array.isArray(data) ? (data as unknown as MessageRow[]) : [];
    const msgs: ChatMessage[] = rows.map((m) => ({
      id: String(m.id),
      role: m.role,
      content: String(m.content || ""),
      ts: new Date(String(m.created_at || new Date().toISOString())).getTime(),
      status: (String(m.status || "done") as ChatMessage["status"]) || "done",
    }));

    const assistantIds = msgs.filter((m) => m.role === "assistant").map((m) => m.id);
    const sourcesByMsg: Record<string, ChatSource[]> = {};
    if (assistantIds.length > 0) {
      const { data: srcRows, error: srcErr } = await supabase
        .from("chat_message_sources")
        .select("message_id, library_id, doc_id, doc_title, storage_path_raw, chunk_id, page_start, page_end, score")
        .eq("organization_id", organization.id)
        .eq("thread_id", threadId)
        .in("message_id", assistantIds);

      // Hydrate additional doc metadata (e.g. gdrive_file_id) from `documents`.
      const docMetaById: Record<string, { title?: string | null; gdrive_file_id?: string | null; path_in_source?: string | null; storage_path_raw?: string | null }> = {};
      if (!srcErr && Array.isArray(srcRows)) {
        const docIds = Array.from(
          new Set(
            (srcRows as SourceRow[])
              .map((r) => String(r.doc_id || "").trim())
              .filter(Boolean)
          )
        );
        if (docIds.length > 0) {
          const { data: docs, error: docErr } = await supabase
            .from("documents")
            .select("id,title,gdrive_file_id,path_in_source,storage_path_raw")
            .in("id", docIds);
          if (!docErr && Array.isArray(docs)) {
            for (const d of docs as Array<{ id: string; title?: string | null; gdrive_file_id?: string | null; path_in_source?: string | null; storage_path_raw?: string | null }>) {
              docMetaById[String(d.id)] = {
                title: d.title ?? null,
                gdrive_file_id: (d as unknown as { gdrive_file_id?: string | null }).gdrive_file_id ?? null,
                path_in_source: (d as unknown as { path_in_source?: string | null }).path_in_source ?? null,
                storage_path_raw: d.storage_path_raw ?? null,
              };
            }
          }
        }

        for (const r of srcRows as SourceRow[]) {
          const mid = String(r.message_id);
          if (!sourcesByMsg[mid]) sourcesByMsg[mid] = [];
          const did = String(r.doc_id || "");
          const dm = did ? docMetaById[did] : undefined;
          sourcesByMsg[mid].push({
            library_id: String(r.library_id || ""),
            doc_id: String(r.doc_id || ""),
            doc_title: r.doc_title ?? dm?.title ?? null,
            storage_path_raw: r.storage_path_raw ?? dm?.storage_path_raw ?? null,
            gdrive_file_id: dm?.gdrive_file_id ?? null,
            path_in_source: dm?.path_in_source ?? null,
            chunk_id: r.chunk_id ?? null,
            page_start: typeof r.page_start === "number" ? r.page_start : null,
            page_end: typeof r.page_end === "number" ? r.page_end : null,
            score: typeof r.score === "number" ? r.score : null,
          });
        }
      }
    }

    const merged = msgs.map((m) => (m.role === "assistant" ? { ...m, sources: sourcesByMsg[m.id] || [] } : m));
    setMessagesByThread((prev) => ({ ...prev, [threadId]: merged }));

    // Update thread snippet in UI.
    const last = merged[merged.length - 1];
    setThreads((prev) =>
      prev.map((t) =>
        t.id === threadId
          ? { ...t, updatedAt: last?.ts ?? Date.now(), lastSnippet: last?.content?.slice(0, 140) ?? "" }
          : t
      )
    );
  };

  const getThreadSummary = (threadId: string) => {
    const msgs = messagesByThread[threadId] ?? [];
    for (const m of msgs) {
      if (m.role !== "system") continue;
      const s = extractSummary(m.content);
      if (s) return s;
    }
    return null;
  };

  // Live context-window usage — mirrors the exact budget math used in send() so the ring
  // predicts when the thread will auto-summarize. Measures the CUMULATIVE conversation
  // (summary + every turn + the in-progress draft), so it grows monotonically as you chat and
  // only drops when auto-compaction starts a fresh continuation thread — like the Claude meter.
  // (Using a sliding window here made the number fluctuate down on each send.)
  const contextBudgetTokens = Number(process.env.NEXT_PUBLIC_CHAT_CONTEXT_BUDGET_TOKENS || 9000);
  const contextUsedTokens = (() => {
    const tid = activeThreadId;
    const summary = tid ? getThreadSummary(tid) || "" : "";
    const allTurns = tid
      ? (messagesByThread[tid] ?? [])
          .filter((m) => m.role !== "system")
          .map((m) => `${m.role}: ${m.content}`)
          .join("\n")
      : "";
    return (
      approxTokensFromText(summary) +
      approxTokensFromText(allTurns) +
      approxTokensFromText(prompt)
    );
  })();

  const compactThread = async (threadId: string) => {
    if (!organization?.id) return null;
    const msgs = (messagesByThread[threadId] ?? []).slice(-80);
    const toSend = msgs.map((m) => ({ role: m.role, content: m.content }));

    const res = await fetch("/api/backend/chat/compact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organization_id: organization.id, messages: toSend }),
    });
    const raw = await res.text();
    let payload: { summary?: string; title?: string } = {};
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = {};
    }
    if (!res.ok || !payload.summary) {
      onLog?.({ level: "warn", message: "Chat: compaction failed", details: payload });
      return null;
    }
    return { summary: payload.summary, title: payload.title || "Continuation" };
  };

  const createThreadWithTitle = async (
    title: string,
    summary: string | null,
    lineage?: { parentThreadId: string; rootThreadId: string },
  ) => {
    if (!organization?.id) return null;
    const { data: userRes } = await supabase.auth.getUser();
    const uid = userRes?.user?.id;
    if (!uid) return null;

    const { data, error } = await supabase
      .from("chat_threads")
      .insert({
        organization_id: organization.id,
        created_by_user_id: uid,
        title: title || "New chat",
        selected_library_ids: selectedLibraryIds,
        updated_at: new Date().toISOString(),
        parent_thread_id: lineage?.parentThreadId ?? null,
        root_thread_id: lineage?.rootThreadId ?? null,
      })
      .select("id, title, updated_at, selected_library_ids, parent_thread_id, root_thread_id")
      .single();

    if (error || !data?.id) {
      onLog?.({ level: "error", message: "Chat: failed to create thread", details: error });
      return null;
    }

    const tid = String(data.id);
    const t: Thread = {
      id: tid,
      title: String(data.title || "New chat"),
      updatedAt: new Date(String(data.updated_at || new Date().toISOString())).getTime(),
      lastSnippet: "",
      selectedLibraryIds: Array.isArray(data.selected_library_ids) ? data.selected_library_ids.map(String) : [],
      parentThreadId: data.parent_thread_id ? String(data.parent_thread_id) : null,
      rootThreadId: data.root_thread_id ? String(data.root_thread_id) : null,
    };
    setThreads((prev) => [t, ...prev]);
    setActiveThreadId(tid);
    setMessagesByThread((prev) => ({ ...prev, [tid]: [] }));

    if (summary) {
      const sysContent = `${SUMMARY_MARKER}\n${summary}`;
      // Persist system summary (and keep it out of UI).
      await supabase.from("chat_messages").insert({
        organization_id: organization.id,
        thread_id: tid,
        role: "system",
        content: sysContent,
        status: "done",
      });
      setMessagesByThread((prev) => ({
        ...prev,
        [tid]: [
          {
            id: makeId(),
            role: "system",
            content: sysContent,
            ts: Date.now(),
            status: "done",
          },
        ],
      }));
    }

    return tid;
  };

  const createThread = async () => {
    if (!organization?.id) return null;
    const { data: userRes } = await supabase.auth.getUser();
    const uid = userRes?.user?.id;
    if (!uid) return null;

    const { data, error } = await supabase
      .from("chat_threads")
      .insert({
        organization_id: organization.id,
        created_by_user_id: uid,
        title: "New chat",
        selected_library_ids: selectedLibraryIds,
        updated_at: new Date().toISOString(),
      })
      .select("id, title, updated_at, selected_library_ids")
      .single();

    if (error || !data?.id) {
      onLog?.({ level: "error", message: "Chat: failed to create thread", details: error });
      return null;
    }

    const tid = String(data.id);
    const t: Thread = {
      id: tid,
      title: String(data.title || "New chat"),
      updatedAt: new Date(String(data.updated_at || new Date().toISOString())).getTime(),
      lastSnippet: "",
      selectedLibraryIds: Array.isArray(data.selected_library_ids) ? data.selected_library_ids.map(String) : [],
    };
    setThreads((prev) => [t, ...prev]);
    setActiveThreadId(tid);
    setMessagesByThread((prev) => ({ ...prev, [tid]: [] }));
    return tid;
  };

  const newThread = () => {
    void createThread();
  };

  const deleteThread = async (threadId: string) => {
    if (!organization?.id) return;
    const t = threads.find((x) => x.id === threadId);
    const label = t?.title ? `"${t.title}"` : "this chat";
    const ok = window.confirm(`Delete ${label}?\n\nThis removes the entire chat from the database.`);
    if (!ok) return;

    try {
      const { error } = await supabase
        .from("chat_threads")
        .delete()
        .eq("organization_id", organization.id)
        .eq("id", threadId);

      if (error) {
        onLog?.({ level: "error", message: "Chat: failed to delete thread", details: error });
        return;
      }

      setThreads((prev) => prev.filter((x) => x.id !== threadId));
      setMessagesByThread((prev) => {
        const next = { ...prev };
        delete next[threadId];
        return next;
      });

      if (activeThreadId === threadId) {
        const remaining = threads.filter((x) => x.id !== threadId).sort((a, b) => b.updatedAt - a.updatedAt);
        setActiveThreadId(remaining[0]?.id ?? null);
      }

      onLog?.({ level: "success", message: "Chat: deleted thread", details: { thread_id: threadId } });
    } catch (err) {
      onLog?.({ level: "error", message: "Chat: delete thread crashed", details: err });
    }
  };

  const ensureThread = async () => {
    if (activeThreadId && isUuid(activeThreadId)) return activeThreadId;
    return await createThread();
  };

  const pushMessage = (threadId: string, msg: ChatMessage) => {
    setMessagesByThread((prev) => {
      const existing = prev[threadId] ?? [];
      return { ...prev, [threadId]: [...existing, msg] };
    });
    setThreads((prev) =>
      prev.map((t) =>
        t.id === threadId
          ? {
              ...t,
              updatedAt: msg.ts,
              title:
                t.title === "New chat" && msg.role === "user"
                  ? (msg.content.trim().slice(0, 42) || "New chat")
                  : t.title,
              lastSnippet: msg.content.trim().slice(0, 140),
            }
          : t
      )
    );
  };

  const patchMessage = (threadId: string, messageId: string, patch: Partial<ChatMessage>) => {
    setMessagesByThread((prev) => {
      const existing = prev[threadId] ?? [];
      return {
        ...prev,
        [threadId]: existing.map((m) => (m.id === messageId ? { ...m, ...patch } : m)),
      };
    });
  };

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setThinking(false);
    const tid = activeThreadId;
    const mid = assistantDraftIdRef.current;
    if (tid && mid) patchMessage(tid, mid, { status: "stopped", content: "Stopped." });
    assistantDraftIdRef.current = null;
    onLog?.({ level: "info", message: "Stopped generation" });
  };

  const copyMessage = async (messageId: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text || "");
      setCopiedMessageId(messageId);
      window.setTimeout(() => setCopiedMessageId((v) => (v === messageId ? null : v)), 1200);
    } catch (err) {
      onLog?.({ level: "warn", message: "Chat: failed to copy", details: err });
    }
  };

  const openSourcePdf = async (s: ChatSource) => {
    try {
      // Prefer resolving directly from the source row (no DB roundtrip; avoids RLS failures).
      const directFileId = extractDriveFileId(s.gdrive_file_id ?? null, s.storage_path_raw ?? null);
      if (directFileId) {
        const url = `https://drive.google.com/file/d/${encodeURIComponent(directFileId)}/view`;
        window.open(url, "_blank", "noopener,noreferrer");
        return;
      }

      // Fall back to doc lookup (best-effort) to find the Drive file id.
      if (!organization?.id) return;
      const docId = String(s.doc_id || "").trim();
      if (!docId) return;

      const { data, error } = await supabase
        .from("documents")
        .select("id, gdrive_file_id, storage_path_raw")
        .eq("id", docId)
        .single();

      if (error) {
        onLog?.({ level: "warn", message: "Chat: failed to load document metadata", details: error });
        return;
      }

      const fileId = extractDriveFileId(
        (data as unknown as { gdrive_file_id?: string | null })?.gdrive_file_id ?? null,
        (data as unknown as { storage_path_raw?: string | null })?.storage_path_raw ?? null
      );
      if (!fileId) {
        onLog?.({
          level: "warn",
          message: "Chat: could not resolve Google Drive file id for this PDF",
          details: { doc_id: docId, gdrive_file_id: (data as unknown as { gdrive_file_id?: string | null })?.gdrive_file_id, storage_path_raw: (data as unknown as { storage_path_raw?: string | null })?.storage_path_raw },
        });
        return;
      }

      const url = `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      onLog?.({ level: "error", message: "Chat: open PDF crashed", details: err });
    }
  };

  const send = async () => {
    if (!prompt.trim()) return;
    if (thinking) return;

    let tid = await ensureThread();
    if (!tid) {
      onLog?.({ level: "error", message: "Chat: unable to create a thread (auth/org missing)" });
      return;
    }

    // Context window management (ChatGPT-style):
    // If the thread is too long, compact and start a continuation thread automatically.
    // Measure the CUMULATIVE conversation (all turns) so this matches the context ring exactly
    // and compaction triggers when the whole thread — not just a sliding window — gets large.
    const threadMsgs = messagesByThread[tid] ?? [];
    const summary = getThreadSummary(tid);
    const budgetTokens = Number(process.env.NEXT_PUBLIC_CHAT_CONTEXT_BUDGET_TOKENS || 9000);
    const allTurns = threadMsgs
      .filter((m) => m.role !== "system")
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n");
    const sizeTokens =
      approxTokensFromText(summary || "") + approxTokensFromText(allTurns) + approxTokensFromText(prompt);

    if (sizeTokens > budgetTokens && organization?.id) {
      onLog?.({ level: "info", message: "Chat: context budget hit, compacting…" });
      setCompacting(true);
      try {
        const comp = await compactThread(tid);
        if (comp?.summary) {
          const nextTitle = comp.title || "Continuation";
          // Link the new continuation chat to the chat it was spawned from, and to the lineage
          // root (so the sidebar can draw main → child → grandchild).
          const parentThread = threads.find((t) => t.id === tid);
          const rootId = parentThread?.rootThreadId || tid;
          const newTid = await createThreadWithTitle(nextTitle, comp.summary, {
            parentThreadId: tid,
            rootThreadId: rootId,
          });
          if (newTid) {
            tid = newTid;
            onLog?.({
              level: "success",
              message: "Chat: started linked continuation thread",
              details: { thread_id: tid, parent_thread_id: parentThread?.id, root_thread_id: rootId },
            });
          }
        }
      } finally {
        setCompacting(false);
      }
    }

    setThinking(true);
    const ac = new AbortController();
    abortRef.current = ac;

    const userText = prompt.trim();
    setPrompt("");

    // Add the user message in the SAME synchronous batch as setPrompt("") — i.e. BEFORE any
    // await below — so the context ring doesn't briefly dip. Clearing the draft removes its
    // tokens; counting the just-sent message adds them right back in the same render, so the
    // gauge stays steady on Enter and only rises once the answer arrives.
    const userMsg: ChatMessage = {
      id: makeId(),
      role: "user",
      content: userText,
      ts: Date.now(),
      status: "done",
    };
    // Sending always re-arms auto-follow so the user sees their message + the typing answer.
    stickToBottomRef.current = true;
    pushMessage(tid, userMsg);

    const clientRequestId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const clientPromptHash = await (async () => {
      try {
        const enc = new TextEncoder().encode(userText.trim());
        const buf = await crypto.subtle.digest("SHA-1", enc);
        const bytes = Array.from(new Uint8Array(buf));
        return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
      } catch {
        return null;
      }
    })();

    // Persist user message (best effort).
    if (organization?.id) {
      try {
        await supabase.from("chat_messages").insert({
          organization_id: organization.id,
          thread_id: tid,
          role: "user",
          content: userText,
          status: "done",
        });

        // Update thread title on first user message (best effort).
        const currentThread = threads.find((t) => t.id === tid);
        if (currentThread?.title === "New chat") {
          await supabase
            .from("chat_threads")
            .update({ title: userText.slice(0, 42) || "New chat", updated_at: new Date().toISOString() })
            .eq("id", tid)
            .eq("organization_id", organization.id);
        } else {
          await supabase
            .from("chat_threads")
            .update({ updated_at: new Date().toISOString(), selected_library_ids: selectedLibraryIds })
            .eq("id", tid)
            .eq("organization_id", organization.id);
        }
      } catch (err) {
        onLog?.({ level: "warn", message: "Chat: failed to persist user message", details: err });
      }
    }

    const draftId = makeId();
    assistantDraftIdRef.current = draftId;
    pushMessage(tid, {
      id: draftId,
      role: "assistant",
      content: "",
      ts: Date.now(),
      status: "streaming",
    });

    onLog?.({
      level: "info",
      message: "Chat: sending to backend",
      details: {
        organization_id: organization?.id ?? null,
        library_ids: selectedLibraryIds,
        prompt: userText,
        client_request_id: clientRequestId,
      },
    });

    try {
      const doFetch = async () =>
        fetch(`/api/backend/chat?rid=${encodeURIComponent(clientRequestId)}`, {
          method: "POST",
          headers: { "content-type": "application/json", "cache-control": "no-cache" },
          body: JSON.stringify({
            organization_id: organization?.id ?? null,
            library_ids: selectedLibraryIds,
            message: userText,
            client_request_id: clientRequestId,
            client_prompt_hash: clientPromptHash,
            // Context window inputs (summary + last few turns).
            thread_summary: getThreadSummary(tid),
            history: (messagesByThread[tid] ?? [])
              .filter((m) => m.role !== "system")
              .slice(-18)
              .map((m) => ({ role: m.role, content: m.content })),
          }),
          signal: ac.signal,
        });

      let res = await doFetch();

      let raw = await res.text();
      let payload: ChatResponse | { answer: string; [k: string]: unknown } = { answer: raw };
      try {
        payload = JSON.parse(raw) as ChatResponse;
      } catch {
        payload = { answer: raw };
      }

      if (!res.ok) {
        const msg = String((payload as { error?: unknown })?.error || `Chat backend failed (${res.status}).`);
        patchMessage(tid, draftId, { status: "error", content: msg });
        onLog?.({ level: "error", message: "Chat: backend error", details: payload });
        return;
      }

      // Stale-response guard. The backend echoes our client_request_id and a SHA-1 of the exact
      // prompt it processed (server_prompt_hash). A flaky tunnel/proxy can return a buffered,
      // one-behind response — if we render that, the chat shows the PREVIOUS turn's answer. So we
      // retry until the response provably matches THIS request, and refuse to render a mismatched
      // answer rather than silently showing the wrong one.
      const matchesRequest = (p: ChatResponse | { answer: string;[k: string]: unknown }) => {
        const echoed = (p as ChatResponse)?.client_request_id ?? null;
        const serverHash = (p as ChatResponse)?.server_prompt_hash ?? null;
        const idOk = !echoed || echoed === clientRequestId;
        const hashOk = !clientPromptHash || !serverHash || serverHash === clientPromptHash;
        return idOk && hashOk;
      };

      const MAX_STALE_RETRIES = 4;
      let staleAttempts = 0;
      while (!matchesRequest(payload) && staleAttempts < MAX_STALE_RETRIES) {
        staleAttempts += 1;
        onLog?.({
          level: "warn",
          message: `Chat: stale response detected (attempt ${staleAttempts}/${MAX_STALE_RETRIES}); retrying`,
          details: {
            expected_request_id: clientRequestId,
            got_request_id: (payload as ChatResponse)?.client_request_id ?? null,
            expected_prompt_hash: clientPromptHash,
            got_prompt_hash: (payload as ChatResponse)?.server_prompt_hash ?? null,
          },
        });
        // Small backoff so the upstream buffer can flush the stale entry.
        await new Promise((r) => setTimeout(r, 150 * staleAttempts));
        res = await doFetch();
        if (!res.ok) {
          const errText = await res.text();
          patchMessage(tid, draftId, { status: "error", content: `Chat backend failed (${res.status}).` });
          onLog?.({ level: "error", message: "Chat: backend error during stale retry", details: errText });
          return;
        }
        raw = await res.text();
        try {
          payload = JSON.parse(raw) as ChatResponse;
        } catch {
          payload = { answer: raw };
        }
      }

      if (!matchesRequest(payload)) {
        // Never render a one-behind / mismatched answer — surface it instead so the user retries.
        patchMessage(tid, draftId, {
          status: "error",
          content:
            "The server kept returning a stale response meant for a previous message (usually the temporary backend tunnel). Please send your message again.",
        });
        onLog?.({
          level: "error",
          message: "Chat: persistent stale response; refusing to render mismatched answer",
          details: {
            expected_request_id: clientRequestId,
            got_request_id: (payload as ChatResponse)?.client_request_id ?? null,
            expected_prompt_hash: clientPromptHash,
            got_prompt_hash: (payload as ChatResponse)?.server_prompt_hash ?? null,
          },
        });
        return;
      }

      const answer = typeof payload?.answer === "string" ? payload.answer : JSON.stringify(payload, null, 2);
      const sources = Array.isArray(payload?.sources) ? payload.sources : [];
      const followups: Array<{ hop: number; query: string }> = Array.isArray((payload as ChatResponse)?.followups)
        ? ((payload as ChatResponse).followups as Array<{ hop: number; query: string }>)
        : [];

      lastAnswerRef.current = answer;
      lastPromptRef.current = userText;

      // Typewriter reveal (GPT/Claude style). The backend returns the whole answer at once (it's
      // only produced at the final synthesis step), so we animate it in on the client. Reveal in
      // word chunks sized to finish in ~1.2s regardless of length. Sources/followups are attached
      // only on the final "done" patch, so they appear after the text finishes typing.
      const typewriterOn = (process.env.NEXT_PUBLIC_CHAT_TYPEWRITER ?? "1") !== "0";
      if (typewriterOn && answer.trim().length > 0) {
        const tokens = answer.split(/(\s+)/); // keep whitespace tokens so spacing is preserved
        const wordCount = tokens.filter((t) => t.trim().length > 0).length;
        // Smooth, relaxed pace: reveal ~1 word per frame for short/medium answers (so it reads as
        // a steady stream, not jumps), scaling up only for very long answers so they still finish
        // in a few seconds. frameMs and the cap are tunable via env.
        const frameMs = Number(process.env.NEXT_PUBLIC_CHAT_TYPEWRITER_MS || 26);
        const maxDurationMs = Number(process.env.NEXT_PUBLIC_CHAT_TYPEWRITER_MAX_MS || 4000);
        const maxFrames = Math.max(1, Math.floor(maxDurationMs / frameMs));
        const chunk = Math.max(1, Math.ceil(wordCount / maxFrames));
        let shown = "";
        let wordsThisFrame = 0;
        for (let i = 0; i < tokens.length; i++) {
          if (ac.signal.aborted) break;
          shown += tokens[i];
          if (tokens[i].trim().length > 0) wordsThisFrame += 1;
          if (wordsThisFrame >= chunk || i === tokens.length - 1) {
            patchMessage(tid, draftId, { status: "typing", content: shown });
            wordsThisFrame = 0;
            await new Promise((r) => setTimeout(r, frameMs));
          }
        }
      }

      if (ac.signal.aborted) {
        // User hit Stop mid-typing; stop() already set the message. Leave it as-is.
        return;
      }

      onSources?.(sources);
      patchMessage(tid, draftId, { status: "done", content: answer, sources, followups });
      onLog?.({
        level: "success",
        message: "Chat: response received",
        details: { sources: sources.length, followups: followups.length, stale_retries: staleAttempts },
      });

      // Persist assistant message + sources.
      if (organization?.id) {
        try {
          const { data: inserted } = await supabase
            .from("chat_messages")
            .insert({
              organization_id: organization.id,
              thread_id: tid,
              role: "assistant",
              content: answer,
              status: "done",
            })
            .select("id")
            .single();

          const messageId = inserted?.id ? String(inserted.id) : null;
          if (messageId && sources.length > 0) {
            const rows = sources.slice(0, 40).map((s) => ({
              organization_id: organization.id,
              thread_id: tid,
              message_id: messageId,
              library_id: s.library_id || null,
              doc_id: s.doc_id || null,
              doc_title: s.doc_title ?? null,
              storage_path_raw: s.storage_path_raw ?? null,
              chunk_id: s.chunk_id ?? null,
              page_start: s.page_start ?? null,
              page_end: s.page_end ?? null,
              score: s.score ?? null,
            }));
            await supabase.from("chat_message_sources").insert(rows);
          }
        } catch (err) {
          onLog?.({ level: "warn", message: "Chat: failed to persist assistant message", details: err });
        }
      }
    } catch (err) {
      if (ac.signal.aborted) return;
      patchMessage(tid, draftId, { status: "error", content: "Failed to reach backend." });
      onLog?.({ level: "error", message: "Chat: request crashed", details: err });
    } finally {
      abortRef.current = null;
      assistantDraftIdRef.current = null;
      setThinking(false);
    }
  };

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  useEffect(() => {
    // Load persisted threads whenever org changes.
    setThreads([]);
    setActiveThreadId(null);
    setMessagesByThread({});
    if (!organization?.id) return;
    void loadThreads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organization?.id]);

  useEffect(() => {
    if (!activeThreadId) return;
    // If we already have messages loaded, don't refetch.
    if ((messagesByThread[activeThreadId] ?? []).length > 0) return;
    void loadMessages(activeThreadId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadId]);

  // Switching threads always jumps to the bottom and re-arms auto-follow.
  useEffect(() => {
    stickToBottomRef.current = true;
  }, [activeThreadId]);

  // Follow the conversation as it grows — including while the answer types out (content changes,
  // not just message count) — but only if the user is near the bottom (so scrolling up to read
  // history isn't yanked back down).
  const lastMessageContent = displayMessages[displayMessages.length - 1]?.content ?? "";
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [activeThreadId, displayMessages.length, thinking, lastMessageContent]);

  const suggestions = [
    "Summarize the key findings across my documents.",
    "What methods or approaches are compared?",
    "List the main limitations mentioned.",
    "Explain this topic with citations.",
  ];

  // One sidebar chat row. `rail` is the optional left connector column drawn for lineages
  // (a chat + its auto-spawned continuation chats).
  const renderThreadRow = (t: Thread, rail: ReactNode = null) => {
    const active = t.id === activeThreadId;
    return (
      <div
        key={t.id}
        className={`group flex items-center gap-1 rounded-xl px-1 transition-colors ${
          active ? "bg-gradient-to-r from-violet-500/20 to-fuchsia-500/10" : "hover:bg-white/6"
        }`}
      >
        {rail}
        <button
          type="button"
          onClick={() => setActiveThreadId(t.id)}
          className="min-w-0 flex-1 px-2.5 py-2.5 text-left"
        >
          <div className={`truncate text-sm font-medium ${active ? "text-white" : "text-white/80"}`}>
            {t.title}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-white/40">
            {t.lastSnippet || formatClock(t.updatedAt)}
          </div>
        </button>
        <button
          type="button"
          onClick={() => void deleteThread(t.id)}
          className="shrink-0 grid place-items-center h-7 w-7 rounded-lg text-white/30 opacity-0 group-hover:opacity-100 hover:text-rose-300 hover:bg-rose-500/12 transition-all"
          title="Delete chat"
        >
          <FiTrash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  };

  // The left connector rail for a thread inside a multi-chat lineage: a vertical line with a dot.
  // Root chat gets a larger gradient dot; continuation chats get smaller dots, all joined.
  const lineageRail = (idx: number, size: number) => {
    if (size <= 1) return null;
    const isFirst = idx === 0;
    const isLast = idx === size - 1;
    return (
      <div className="relative w-5 shrink-0 self-stretch" aria-hidden>
        {!isFirst && <span className="absolute left-1/2 top-0 h-1/2 w-px -translate-x-1/2 bg-white/15" />}
        {!isLast && <span className="absolute left-1/2 bottom-0 h-1/2 w-px -translate-x-1/2 bg-white/15" />}
        <span
          className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full ${
            isFirst
              ? "h-2.5 w-2.5 bg-gradient-to-br from-violet-400 to-fuchsia-400 shadow-[0_0_0_3px_rgba(167,139,250,0.18)]"
              : "h-2 w-2 bg-violet-300/70"
          }`}
        />
      </div>
    );
  };

  const searching = threadQuery.trim().length > 0;

  return (
    <div className="relative flex h-full overflow-hidden rounded-2xl surface-panel shadow-[0_18px_70px_rgba(0,0,0,0.35)]">
      {/* History rail (ChatGPT-style) */}
      {historyOpen ? (
        <aside className="hidden lg:flex w-64 shrink-0 flex-col border-r border-white/10 bg-black/15">
          <div className="p-3">
            <button
              type="button"
              onClick={newThread}
              className="btn-grad w-full inline-flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium text-white"
            >
              <FiEdit3 className="h-4 w-4" /> New chat
            </button>
            <div className="mt-3 flex items-center gap-2 rounded-xl bg-white/5 border border-white/10 px-3 py-2">
              <FiSearch className="h-4 w-4 text-white/40" />
              <input
                value={threadQuery}
                onChange={(e) => setThreadQuery(e.target.value)}
                placeholder="Search chats"
                className="w-full bg-transparent text-xs text-white/90 placeholder:text-white/40 outline-none"
              />
            </div>
          </div>

          <div className="synapse-scroll flex-1 overflow-auto px-2 pb-3">
            {threads.length === 0 ? (
              <div className="px-3 py-6 text-sm text-white/40">No chats yet.</div>
            ) : searching ? (
              // Flat results while searching (connectors only make sense in the full list).
              filteredThreads.length === 0 ? (
                <div className="px-3 py-6 text-sm text-white/40">No matching chats.</div>
              ) : (
                <div className="space-y-0.5">
                  {filteredThreads.slice(0, 120).map((t) => renderThreadRow(t))}
                </div>
              )
            ) : (
              // Lineage view: each chat + its auto-spawned continuation chats, connected.
              <div className="space-y-1.5">
                {threadTree.slice(0, 60).map((lineage) => (
                  <div key={lineage[0].thread.id}>
                    {lineage.map((item) =>
                      renderThreadRow(item.thread, lineageRail(item.idxInLineage, item.lineageSize)),
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
      ) : null}

      {/* Main column */}
      <div className="flex flex-1 min-w-0 flex-col">
        {/* Slim header */}
        <header className="flex items-center justify-between gap-3 border-b border-white/10 px-3 sm:px-4 py-2.5">
          <button
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            className="hidden lg:grid place-items-center h-8 w-8 rounded-lg text-white/55 hover:text-white hover:bg-white/8 transition-colors"
            title={historyOpen ? "Hide history" : "Show history"}
          >
            {historyOpen ? <FiChevronLeft className="h-4 w-4" /> : <FiChevronRight className="h-4 w-4" />}
          </button>

          <button
            type="button"
            onClick={newThread}
            className="lg:hidden grid place-items-center h-8 w-8 rounded-lg text-white/55 hover:text-white hover:bg-white/8 transition-colors"
            title="New chat"
          >
            <FiEdit3 className="h-4 w-4" />
          </button>

          <div className="flex items-center gap-2 min-w-0">
            <span className="grid place-items-center h-7 w-7 rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500 shrink-0">
              <FiMessageSquare className="h-3.5 w-3.5 text-white" />
            </span>
            <span className="text-sm font-medium text-white/85 truncate">
              {threads.find((t) => t.id === activeThreadId)?.title ?? "New conversation"}
            </span>
          </div>

          {/* library chip */}
          <button
            type="button"
            onClick={() => setLibraryPickerOpen((v) => !v)}
            className="ml-auto inline-flex items-center gap-2 rounded-lg glass px-2.5 py-1.5 text-xs text-white/80 hover:text-white transition-colors"
            title="Choose libraries"
          >
            <FiBookOpen className="h-3.5 w-3.5 text-violet-300" />
            <span className="max-w-[9rem] truncate">{selectedLibrariesLabel}</span>
          </button>
        </header>

        {/* Messages */}
        <div
          ref={scrollRef}
          onScroll={() => {
            const el = scrollRef.current;
            if (!el) return;
            // Re-arm follow only when the user is within ~80px of the bottom.
            stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
          className="synapse-scroll flex-1 min-h-0 overflow-auto px-3 sm:px-6 py-6"
        >
          {activeThreadId && displayMessages.length > 0 ? (
            <div className="mx-auto w-full max-w-3xl space-y-6">
              {displayMessages.map((m) => {
                const isUser = m.role === "user";
                if (isUser) {
                  return (
                    <div key={m.id} className="flex justify-end">
                      <div className="max-w-[80%] rounded-2xl rounded-tr-md bg-gradient-to-br from-violet-600 to-indigo-600 px-4 py-2.5 text-sm text-white shadow-lg shadow-violet-600/25 whitespace-pre-wrap">
                        {m.content}
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={m.id} className="flex gap-3">
                    <span className="mt-0.5 grid place-items-center h-8 w-8 shrink-0 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 shadow-md shadow-violet-500/25">
                      <FiMessageSquare className="h-4 w-4 text-white" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-semibold text-white/80">Synapse</span>
                        <span className="text-[10px] text-white/30">{formatClock(m.ts)}</span>
                      </div>

                      {m.status === "streaming" && (m.content || "").trim().length === 0 ? (
                        <TypingIndicator />
                      ) : (
                        <div className="rounded-2xl rounded-tl-md glass px-4 py-3">
                          <ChatMarkdown content={m.content} />
                          {m.status === "typing" ? (
                            <span className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-[2px] rounded-full bg-violet-300 animate-pulse" />
                          ) : null}
                          {(m.sources?.length || 0) > 0 ? (
                            <ChatMessageSources sources={m.sources || []} onClickSource={(s) => void openSourcePdf(s)} />
                          ) : null}
                          {(m.followups?.length || 0) > 0 ? (
                            <div className="mt-2 text-[11px] text-white/40">
                              Agent hops: {m.followups!.map((f) => `#${f.hop}`).join(", ")}
                            </div>
                          ) : null}
                        </div>
                      )}

                      {m.status !== "streaming" && m.status !== "typing" ? (
                        <div className="mt-2 flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void copyMessage(m.id, m.content)}
                            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] text-white/45 hover:text-white hover:bg-white/8 transition-colors"
                            title="Copy response"
                          >
                            {copiedMessageId === m.id ? <FiCheck className="h-3.5 w-3.5 text-emerald-400" /> : <FiCopy className="h-3.5 w-3.5" />}
                            {copiedMessageId === m.id ? "Copied" : "Copy"}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            /* Welcome / empty state (Claude + Gemini flavored) */
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <span className="grid place-items-center h-16 w-16 rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500 shadow-xl shadow-violet-500/30 animate-float">
                <FiMessageSquare className="h-7 w-7 text-white" />
              </span>
              <h2 className="mt-6 text-2xl font-bold tracking-tight text-white">
                Ask your <span className="gradient-text">knowledge base</span>
              </h2>
              <p className="mt-2 text-sm text-white/55 max-w-md">
                {readyLibraries.length > 0
                  ? "Pose a question and Synapse will answer from your selected libraries — with citations you can open."
                  : "Process a library first, then come back to chat with your documents."}
              </p>

              {readyLibraries.length > 0 ? (
                <div className="mt-7 grid w-full max-w-lg gap-2 sm:grid-cols-2">
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setPrompt(s)}
                      className="rounded-xl glass hover-glow px-4 py-3 text-left text-sm text-white/75 transition-all"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          )}
        </div>

        {/* Composer (bottom — Claude/GPT/Gemini convention) */}
        <div className="relative border-t border-white/10 px-3 sm:px-6 py-4">
          {/* Library picker popup (opens upward, dark surface) */}
          {libraryPickerOpen ? (
            <div className="absolute bottom-[calc(100%-0.5rem)] left-3 sm:left-6 z-40 w-[min(420px,calc(100vw-32px))] overflow-hidden rounded-2xl surface-menu">
              <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                <div className="min-w-0">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-white/40">Libraries</div>
                  <div className="mt-0.5 text-sm font-medium text-white/90 truncate">{selectedLibrariesLabel}</div>
                </div>
                <button
                  type="button"
                  className="grid place-items-center h-7 w-7 rounded-lg text-white/50 hover:text-white hover:bg-white/8 transition-colors"
                  onClick={() => setLibraryPickerOpen(false)}
                >
                  <FiX className="h-4 w-4" />
                </button>
              </div>
              <div className="max-h-64 overflow-auto synapse-scroll p-1.5">
                {readyLibraries.length === 0 ? (
                  <div className="px-3 py-4 text-sm text-white/45">No processed libraries yet.</div>
                ) : (
                  readyLibraries.map((l) => {
                    const checked = selectedSet.has(l.id);
                    return (
                      <button
                        key={l.id}
                        type="button"
                        onClick={() => toggleLibrary(l.id)}
                        className={`w-full flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                          checked ? "bg-white/8 text-white" : "text-white/70 hover:bg-white/6"
                        }`}
                      >
                        <span className="truncate flex items-center gap-2">
                          <FiBookOpen className={`h-3.5 w-3.5 ${checked ? "text-violet-300" : "text-white/35"}`} />
                          {l.name}
                        </span>
                        {checked ? <FiCheck className="h-4 w-4 text-violet-300 shrink-0" /> : null}
                      </button>
                    );
                  })
                )}
              </div>
              <div className="border-t border-white/10 px-4 py-2 text-[11px] text-white/40">
                Pick multiple libraries to broaden context.
              </div>
            </div>
          ) : null}

          {compacting && (
            <div className="mx-auto mb-2 w-full max-w-3xl">
              <div className="flex items-center gap-3 rounded-xl border border-violet-400/25 bg-violet-500/10 px-3.5 py-2.5">
                <span className="h-4 w-4 shrink-0 rounded-full border-2 border-violet-300/40 border-t-violet-300 animate-spin" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium text-violet-100">Context window full — starting a linked chat…</div>
                  <div className="mt-0.5 text-[11px] text-white/45">
                    Summarizing this conversation, then continuing in a new connected thread. Your message will be answered there.
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="mx-auto w-full max-w-3xl">
            <div className="flex items-end gap-2 rounded-2xl glass-strong glass-hi px-3 py-2.5 transition-all focus-within:border-violet-400/40">
              <button
                type="button"
                onClick={() => setLibraryPickerOpen((v) => !v)}
                className="grid place-items-center h-9 w-9 shrink-0 rounded-xl text-white/55 hover:text-white hover:bg-white/8 transition-colors"
                title="Choose libraries"
              >
                <FiPlus className="h-5 w-5" />
              </button>

              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                rows={1}
                placeholder={readyLibraries.length > 0 ? "Ask anything across your libraries…" : "Process a library to start chatting…"}
                className="synapse-scroll min-h-[2.25rem] max-h-40 flex-1 resize-none bg-transparent py-1.5 text-sm text-white placeholder:text-white/40 outline-none"
                disabled={readyLibraries.length === 0}
              />

              {readyLibraries.length > 0 && (
                <ContextMeter used={contextUsedTokens} budget={contextBudgetTokens} />
              )}

              <button
                type="button"
                onClick={() => {
                  if (thinking) stop();
                  else void send();
                }}
                disabled={!thinking && !canSend}
                className={`grid place-items-center h-9 w-9 shrink-0 rounded-xl transition-all ${
                  thinking
                    ? "bg-rose-500/15 text-rose-200 hover:bg-rose-500/25"
                    : canSend
                    ? "btn-grad text-white"
                    : "bg-white/5 text-white/30"
                } disabled:opacity-60`}
                title={thinking ? "Stop" : "Send"}
              >
                {thinking ? <FiSquare className="h-4 w-4" /> : <FiArrowUp className="h-4 w-4" />}
              </button>
            </div>
            <p className="mt-2 text-center text-[11px] text-white/30">
              Synapse can make mistakes. Verify important answers with the cited sources.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
