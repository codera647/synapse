"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
} from "react-icons/fi";
import ChatMarkdown from "@/components/ChatMarkdown";
import ChatMessageSources from "@/components/ChatMessageSources";

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
};

type ThreadRow = {
  id: string;
  title: string | null;
  updated_at: string | null;
  selected_library_ids: string[] | null;
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
  status?: "draft" | "streaming" | "done" | "stopped" | "error";
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

  const [prompt, setPrompt] = useState("");
  const [thinking, setThinking] = useState(false);
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
      .select("id, title, updated_at, selected_library_ids")
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

  const createThreadWithTitle = async (title: string, summary: string | null) => {
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
    const threadMsgs = messagesByThread[tid] ?? [];
    const summary = getThreadSummary(tid);
    const budgetTokens = Number(process.env.NEXT_PUBLIC_CHAT_CONTEXT_BUDGET_TOKENS || 9000);
    const recentTurns = threadMsgs
      .filter((m) => m.role !== "system")
      .slice(-18)
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n");
    const sizeTokens =
      approxTokensFromText(summary || "") + approxTokensFromText(recentTurns) + approxTokensFromText(prompt);

    if (sizeTokens > budgetTokens && organization?.id) {
      onLog?.({ level: "info", message: "Chat: context budget hit, compacting…" });
      const comp = await compactThread(tid);
      if (comp?.summary) {
        const nextTitle = comp.title || "Continuation";
        const newTid = await createThreadWithTitle(nextTitle, comp.summary);
        if (newTid) {
          tid = newTid;
          onLog?.({ level: "success", message: "Chat: started continuation thread", details: { thread_id: tid } });
        }
      }
    }

    setThinking(true);
    const ac = new AbortController();
    abortRef.current = ac;

    const userText = prompt.trim();
    setPrompt("");
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

    const userMsg: ChatMessage = {
      id: makeId(),
      role: "user",
      content: userText,
      ts: Date.now(),
      status: "done",
    };
    pushMessage(tid, userMsg);

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

      const echoed = (payload as ChatResponse)?.client_request_id ?? null;
      if (echoed && echoed !== clientRequestId) {
        onLog?.({
          level: "warn",
          message: "Chat: stale response detected; retrying once",
          details: { expected: clientRequestId, got: echoed },
        });
        res = await doFetch();
        raw = await res.text();
        try {
          payload = JSON.parse(raw) as ChatResponse;
        } catch {
          payload = { answer: raw };
        }
      }

      // Strong stale-response guard: ensure backend processed the prompt we sent.
      const serverHash = (payload as ChatResponse)?.server_prompt_hash ?? null;
      if (clientPromptHash && serverHash && clientPromptHash !== serverHash) {
        onLog?.({
          level: "warn",
          message: "Chat: prompt hash mismatch; retrying once",
          details: { expected: clientPromptHash, got: serverHash },
        });
        res = await doFetch();
        raw = await res.text();
        try {
          payload = JSON.parse(raw) as ChatResponse;
        } catch {
          payload = { answer: raw };
        }
      }

      const answer = typeof payload?.answer === "string" ? payload.answer : JSON.stringify(payload, null, 2);
      const sources = Array.isArray(payload?.sources) ? payload.sources : [];
      const followups: Array<{ hop: number; query: string }> = Array.isArray((payload as ChatResponse)?.followups)
        ? ((payload as ChatResponse).followups as Array<{ hop: number; query: string }>)
        : [];

      // Extra guardrail: if we get the exact same answer as the previous turn but the prompt changed,
      // assume tunnel/proxy staleness and retry once.
      if (
        lastAnswerRef.current &&
        lastPromptRef.current &&
        lastAnswerRef.current.trim() === answer.trim() &&
        lastPromptRef.current.trim() !== userText.trim()
      ) {
        onLog?.({
          level: "warn",
          message: "Chat: duplicate answer detected; retrying once",
          details: { previous_prompt: lastPromptRef.current, current_prompt: userText },
        });
        res = await doFetch();
        raw = await res.text();
        try {
          payload = JSON.parse(raw) as ChatResponse;
        } catch {
          payload = { answer: raw };
        }
      }

      const finalAnswer = typeof payload?.answer === "string" ? payload.answer : JSON.stringify(payload, null, 2);
      const finalSources = Array.isArray(payload?.sources) ? payload.sources : [];
      const finalFollowups: Array<{ hop: number; query: string }> = Array.isArray((payload as ChatResponse)?.followups)
        ? ((payload as ChatResponse).followups as Array<{ hop: number; query: string }>)
        : [];

      lastAnswerRef.current = finalAnswer;
      lastPromptRef.current = userText;
      onSources?.(sources);
      patchMessage(tid, draftId, { status: "done", content: finalAnswer, sources: finalSources, followups: finalFollowups });
      onLog?.({
        level: "success",
        message: "Chat: response received",
        details: { sources: finalSources.length, followups: finalFollowups.length },
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

  useEffect(() => {
    // Keep chat pinned to bottom for the active thread.
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [activeThreadId, displayMessages.length, thinking]);

  return (
    <div
      className="relative flex h-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-[color:var(--bg-secondary)]/40 shadow-[0_18px_70px_rgba(0,0,0,0.35)]"
    >
      {/* Top “browser bar” */}
      <div className="rounded-t-2xl border-b border-white/10 bg-black/20 px-4 py-3">
        <div className="flex items-center gap-2">
          {/* Address-style prompt bar */}
          <div
            className="group relative flex flex-1 items-center gap-2 rounded-full border border-white/10 bg-[radial-gradient(circle_at_20%_15%,rgba(184,127,217,0.12),transparent_55%)] px-2.5 py-2 shadow-inner transition-all focus-within:border-white/20"
            style={{ boxShadow: "0 10px 30px rgba(0,0,0,0.30) inset" }}
          >
            <button
              type="button"
              onClick={newThread}
              className="relative inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/5 text-gray-200 transition-colors hover:bg-white/10"
              title="New chat"
            >
              <FiMessageSquare className="h-4 w-4" />
            </button>

            <button
              type="button"
              onClick={() => setHistoryOpen((v) => !v)}
              className="hidden lg:inline-flex relative h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/5 text-gray-200 transition-colors hover:bg-white/10"
              title={historyOpen ? "Hide history" : "Show history"}
            >
              {historyOpen ? <FiChevronLeft className="h-4 w-4" /> : <FiChevronRight className="h-4 w-4" />}
            </button>

            <button
              type="button"
              onClick={() => setLibraryPickerOpen((v) => !v)}
              className="relative inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/5 text-gray-200 transition-colors hover:bg-white/10"
              title="Choose libraries"
            >
              <FiPlus className="h-4 w-4" />
            </button>

            {libraryPickerOpen ? (
              <div className="absolute left-2 top-[54px] z-30 w-[min(520px,calc(100vw-32px))] overflow-hidden rounded-2xl border border-white/10 bg-[#05060C] shadow-2xl shadow-black/60">
                <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-black/30 px-4 py-3">
                  <div className="min-w-0">
                    <div className="text-[11px] uppercase tracking-[0.22em] text-gray-500">Libraries</div>
                    <div className="mt-0.5 text-sm font-medium text-gray-100 truncate">{selectedLibrariesLabel}</div>
                  </div>
                  <button
                    type="button"
                    className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
                    onClick={() => setLibraryPickerOpen(false)}
                  >
                    Close
                  </button>
                </div>
                <div className="max-h-72 overflow-auto p-2">
                  {readyLibraries.length === 0 ? (
                    <div className="px-3 py-4 text-sm text-gray-400">No processed libraries yet.</div>
                  ) : (
                    readyLibraries.map((l) => {
                      const checked = selectedSet.has(l.id);
                      return (
                        <button
                          key={l.id}
                          type="button"
                          onClick={() => toggleLibrary(l.id)}
                          className={`w-full flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm transition-colors ${
                            checked ? "bg-white/10 text-gray-100" : "text-gray-300 hover:bg-white/5 hover:text-gray-100"
                          }`}
                        >
                          <span className="truncate">{l.name}</span>
                          <span
                            className={`rounded-full border px-2 py-0.5 text-[10px] ${
                              checked
                                ? "border-[#b87fd9]/45 bg-[#884ab4]/15 text-gray-100"
                                : "border-white/10 bg-white/5 text-gray-400"
                            }`}
                          >
                            {checked ? "Selected" : "Select"}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
                <div className="border-t border-white/10 bg-black/30 px-4 py-2 text-[11px] text-gray-500">
                  Pick multiple libraries to broaden context.
                </div>
              </div>
            ) : null}

            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={readyLibraries.length > 0 ? "Ask anything…" : "Process a library to start chatting…"}
              className="min-w-0 flex-1 bg-transparent px-1 text-sm text-gray-100 placeholder:text-gray-500 outline-none"
              disabled={readyLibraries.length === 0}
              style={{
                fontFamily:
                  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
              }}
            />

            <button
              type="button"
              onClick={() => {
                if (thinking) stop();
                else void send();
              }}
              disabled={!thinking && !canSend}
              className={`relative inline-flex h-9 w-9 items-center justify-center rounded-full border transition-all ${
                thinking
                  ? "border-red-500/30 bg-red-500/10 text-red-100 hover:bg-red-500/15"
                  : canSend
                  ? "border-[#b87fd9]/45 bg-[#884ab4] text-white shadow-[0_16px_50px_rgba(136,74,180,0.28)] hover:bg-[#9d5fc9]"
                  : "border-white/10 bg-white/5 text-gray-500"
              } disabled:opacity-60`}
              title={thinking ? "Stop" : "Send"}
            >
              <span className="absolute inset-0 opacity-0 transition-opacity duration-200 hover:opacity-100 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.20),transparent_55%)]" />
              {thinking ? <FiSquare className="relative h-4 w-4" /> : <FiSend className="relative h-4 w-4" />}
            </button>
          </div>
        </div>


      </div>

      {/* Content area */}
      <div className="flex-1 min-h-0 rounded-b-2xl bg-[linear-gradient(180deg,rgba(0,0,0,0.02),rgba(0,0,0,0.10))]">
        <div
          className={`grid h-full min-h-0 grid-cols-1 ${
            historyOpen ? "lg:grid-cols-[240px_minmax(0,1fr)]" : "lg:grid-cols-[minmax(0,1fr)]"
          }`}
        >
          {/* History rail */}
          {historyOpen ? (
            <div className="hidden lg:flex h-full min-h-0 flex-col border-r border-white/10 bg-black/10">
            <div className="px-4 pt-4 pb-3">
              <div className="text-[11px] uppercase tracking-[0.22em] text-gray-500">History</div>
              <div className="mt-2 flex items-center gap-2 rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                <FiSearch className="h-4 w-4 text-gray-500" />
                <input
                  value={threadQuery}
                  onChange={(e) => setThreadQuery(e.target.value)}
                  placeholder="Search chats"
                  className="w-full bg-transparent text-xs text-gray-100 placeholder:text-gray-500 outline-none"
                />
              </div>
            </div>

            <div className="synapse-scroll flex-1 overflow-auto px-2 pb-3">
              {filteredThreads.length === 0 ? (
                <div className="px-3 py-6 text-sm text-gray-500">
                  No chats yet. Start by sending a prompt.
                </div>
              ) : (
                <div className="space-y-1">
                  {filteredThreads.slice(0, 120).map((t) => {
                    const active = t.id === activeThreadId;
                    return (
                      <div key={t.id} className="flex items-stretch gap-2">
                        <button
                          type="button"
                          onClick={() => setActiveThreadId(t.id)}
                          className={`min-w-0 flex-1 rounded-xl border px-3 py-2 text-left transition-colors ${
                            active
                              ? "border-[#b87fd9]/45 bg-[#884ab4]/15 text-gray-100"
                              : "border-white/10 bg-white/4 text-gray-200 hover:bg-white/6"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-semibold">{t.title}</div>
                              <div className="mt-1 truncate text-[11px] text-gray-400">{t.lastSnippet || " "}</div>
                            </div>
                            <div className="shrink-0 text-[10px] text-gray-500">{formatClock(t.updatedAt)}</div>
                          </div>
                        </button>

                        <button
                          type="button"
                          onClick={() => void deleteThread(t.id)}
                          className={`shrink-0 rounded-xl border px-2.5 text-gray-300 transition-colors ${
                            active
                              ? "border-[#b87fd9]/30 bg-black/10 hover:bg-red-500/10 hover:border-red-500/25 hover:text-red-100"
                              : "border-white/10 bg-white/4 hover:bg-red-500/10 hover:border-red-500/25 hover:text-red-100"
                          }`}
                          title="Delete chat"
                        >
                          <FiTrash2 className="h-4 w-4" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
          ) : null}

          {/* Conversation */}
          <div className="h-full min-h-0 min-w-0 overflow-hidden">
            <div ref={scrollRef} className="synapse-scroll h-full overflow-auto p-4">
              {activeThreadId && displayMessages.length > 0 ? (
                <div className="mx-auto w-full max-w-[980px] space-y-3">
                  {displayMessages.map((m) => {
                    const isUser = m.role === "user";
                    return (
                      <div key={m.id} className={`flex justify-start`}>
                        <div
                          className={`max-w-[78%] ${isUser ? "mr-auto w-fit rounded-2xl px-4 py-3 border border-[#b87fd9]/30 bg-[#884ab4]/15 text-gray-100" : "w-full px-1 text-gray-100"}`}
                          style={isUser ? { boxShadow: "0 14px 40px rgba(0,0,0,0.14)" } : undefined}
                        >
                          <div className="mb-2 flex items-center justify-between text-[10px] text-gray-500">
                            <span className="uppercase tracking-[0.16em]">{isUser ? "You" : "Synapse"}</span>
                            <span>{formatClock(m.ts)}</span>
                          </div>

                          {m.role === "assistant" ? (
                            m.status === "streaming" && (m.content || "").trim().length === 0 ? (
                              <TypingIndicator />
                            ) : (
                              <ChatMarkdown content={m.content} />
                            )
                          ) : (
                            <div className="whitespace-pre-wrap text-left">{m.content}</div>
                          )}

                          {m.role === "assistant" && (m.sources?.length || 0) > 0 ? (
                            <ChatMessageSources sources={m.sources || []} onClickSource={(s) => void openSourcePdf(s)} />
                          ) : null}
                          {m.role === "assistant" && (m.followups?.length || 0) > 0 ? (
                            <div className="mt-2 text-[11px] text-gray-500">
                              Agent hops: {m.followups!.map((f) => `#${f.hop}`).join(", ")}
                            </div>
                          ) : null}

                          {m.role === "assistant" && m.status !== "streaming" ? (
                            <div className="mt-3 flex items-center justify-end">
                              <button
                                type="button"
                                onClick={() => void copyMessage(m.id, m.content)}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
                                title="Copy response"
                              >
                                <FiCopy className="h-3.5 w-3.5" />
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
                <div className="flex h-full items-center justify-center px-6 text-center">
                  <div className="max-w-md">
                    <div className="text-[11px] uppercase tracking-[0.22em] text-gray-500">Chat</div>
                    <div className="mt-2 text-sm text-gray-300">
                      Type a prompt in the bar above to start a new conversation.
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
