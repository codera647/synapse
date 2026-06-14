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
  FiZap,
  FiAlertTriangle,
  FiRefreshCw,
  FiShare2,
} from "react-icons/fi";

/** Map any chat failure (HTTP status + payload) to a short, friendly user message.
 *  Technical details still go to the log panel; the user only sees this. */
function friendlyChatError(status: number, payload: unknown): string {
  const text = (() => {
    try {
      return JSON.stringify(payload ?? {}).toLowerCase();
    } catch {
      return String(payload ?? "").toLowerCase();
    }
  })();
  const has = (...keys: string[]) => keys.some((k) => text.includes(k));

  if (has("model", "does not exist") || has("invalid model") || has("model_not_found")) {
    return "The AI model is currently unavailable. Please try again shortly.";
  }
  if (status === 429 || has("rate limit", "too many requests", "quota", "insufficient_quota")) {
    return "The service is busy right now. Please wait a few seconds and try again.";
  }
  if (status === 401 || status === 403 || has("api key", "unauthorized", "permission denied")) {
    return "There’s a configuration problem on the server. Please contact the admin.";
  }
  if (status === 0 || status === 502 || status === 503 || status === 504 || has("failed to reach", "unable to reach", "fetch failed", "econnrefused", "network")) {
    if (has("timed out", "timeout", "aborted")) return "The server took too long to respond. Please try again.";
    return "Can’t reach the AI backend right now — it may be starting up. Please try again in a moment.";
  }
  if (has("timed out", "timeout")) return "The request took too long. Please try again.";
  if (status === 400) {
    if (has("library")) return "Please select a processed library to chat with.";
    return "There was a problem with your request. Please try again.";
  }
  return "Something went wrong while generating the answer. Please try again.";
}

type ThinkingMode = "low" | "medium" | "high";
const THINKING_MODE_META: Record<ThinkingMode, { label: string; desc: string }> = {
  high: { label: "Deep", desc: "Decompose + 2 self-checks · most accurate, slower" },
  medium: { label: "Balanced", desc: "Decompose + 1 self-check · good default" },
  low: { label: "Fast", desc: "Single pass · quickest" },
};
import ChatMessageSources from "@/components/ChatMessageSources";
import ChatAnswer, { type ChatVisual, type ChatCitation } from "@/components/ChatAnswer";
import { AgentStatusLine, AgentStepsTrail } from "@/components/AgentStatus";
import ContextMeter from "@/components/ContextMeter";

type LibraryLite = {
  id: string;
  name: string;
  pipeline_status?: string | null;
  status?: string | null;
  pipeline_progress_percent?: number | null;
  ownerLabel?: string | null; // team mode: "by Alice" / "by you"
};

// A library is chat-ready when preprocessing finished. We mirror the dashboard's own
// "done" notion (`pipeline_status || status`, plus 100% progress) instead of requiring
// pipeline_status === "completed" specifically — some libraries record completion in the
// older `status` column while pipeline_status stays null, which used to hide them from chat.
export function isLibraryReady(l: {
  pipeline_status?: string | null;
  status?: string | null;
  pipeline_progress_percent?: number | null;
}): boolean {
  const s = (l.pipeline_status || l.status || "").toLowerCase();
  if (s === "completed" || s === "complete" || s === "ready" || s === "done") return true;
  if ((l.pipeline_progress_percent ?? 0) >= 100) return true;
  return false;
}

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
  snippet?: string | null;
  context_before?: string | null;
  context_after?: string | null;
};

type ChatResponse = {
  answer: string;
  sources?: ChatSource[];
  visuals?: ChatVisual[];
  citations?: ChatCitation[];
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
  visuals?: ChatVisual[];
  citations?: ChatCitation[];
  followups?: Array<{ hop: number; query: string }>;
  stage?: string; // live "what the agent is doing" message while generating
  steps?: string[]; // accumulated distinct stages, for the collapsible activity trail
  startedAt?: number; // generation start (for the elapsed timer)
  retryText?: string; // for error messages: the user prompt to retry
};


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
  scope = "personal",
  shareableLibraries = [],
  onShareLibrary,
  sharingLibraryId = null,
  personalization = null,
}: {
  supabase: SupabaseClient;
  organization: OrgLite | null;
  libraries: LibraryLite[];
  selectedLibraryIds: string[];
  onChangeSelectedLibraryIds: (ids: string[]) => void;
  onSources?: (sources: ChatSource[]) => void;
  onLog?: (e: { level: "info" | "warn" | "error" | "success"; message: string; details?: unknown }) => void;
  // "personal" = your private chats over your libraries; "team" = shared chats over the team's
  // pooled (cross-org) libraries.
  scope?: "personal" | "team";
  // Team mode: your own processed libraries you can share into the team, right from the + picker.
  shareableLibraries?: LibraryLite[];
  onShareLibrary?: (libraryId: string) => void;
  sharingLibraryId?: string | null;
  // User personalization (identity + tone presets) — sent to the backend to shape answer style.
  personalization?: Record<string, unknown> | null;
}) {
  const isTeam = scope === "team";
  const abortRef = useRef<AbortController | null>(null);
  const assistantDraftIdRef = useRef<string | null>(null);
  const lastAnswerRef = useRef<string | null>(null);
  const lastPromptRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Whether the chat is "stuck" to the bottom — true while the user is near the bottom, so the
  // view follows streaming/typing text. Set false when they scroll up to read history.
  const stickToBottomRef = useRef(true);
  // Threads created in THIS session: their optimistic message state is authoritative, so we must
  // not let loadMessages() refetch + overwrite them (which races and drops the just-sent message).
  const createdLocallyRef = useRef<Set<string>>(new Set());

  const [prompt, setPrompt] = useState("");
  const [thinking, setThinking] = useState(false);
  // True while context-window auto-compaction is summarizing a full chat and spawning the
  // linked continuation thread — drives the "starting a linked chat…" loading banner.
  const [compacting, setCompacting] = useState(false);
  const [thinkingMode, setThinkingMode] = useState<ThinkingMode>("medium");
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
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
    return libraries.filter(isLibraryReady).sort((a, b) => a.name.localeCompare(b.name));
  }, [libraries]);

  // Libraries that are present (e.g. shared into the team) but NOT done processing yet —
  // shown disabled with their progress so a shared-but-unprocessed library doesn't just vanish.
  const pendingLibraries = useMemo(() => {
    return libraries.filter((l) => !isLibraryReady(l)).sort((a, b) => a.name.localeCompare(b.name));
  }, [libraries]);

  const activeMessages = useMemo(() => {
    if (!activeThreadId) return [];
    return messagesByThread[activeThreadId] ?? [];
  }, [activeThreadId, messagesByThread]);

  const displayMessages = useMemo(() => {
    return activeMessages.filter((m) => m.role !== "system");
  }, [activeMessages]);

  // Remember the chosen reasoning depth across sessions.
  useEffect(() => {
    try {
      const saved = localStorage.getItem("synapse_thinking_mode");
      if (saved === "low" || saved === "medium" || saved === "high") setThinkingMode(saved);
    } catch {
      /* ignore */
    }
  }, []);

  const changeThinkingMode = (m: ThinkingMode) => {
    setThinkingMode(m);
    setModeMenuOpen(false);
    try {
      localStorage.setItem("synapse_thinking_mode", m);
    } catch {
      /* ignore */
    }
  };

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
    const { data: userRes } = await supabase.auth.getUser();
    const uid = userRes?.user?.id;
    if (!uid) return;
    // Personal = your own private threads across ALL your orgs (not tied to a single org).
    // Team = the selected team's shared threads (all members).
    let qb = supabase
      .from("chat_threads")
      .select("id, title, updated_at, selected_library_ids, parent_thread_id, root_thread_id");
    qb = isTeam
      ? qb.eq("organization_id", organization.id).eq("is_team", true)
      : qb.eq("created_by_user_id", uid).eq("is_team", false);
    const { data, error } = await qb.order("updated_at", { ascending: false }).limit(80);

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
        is_team: isTeam,
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
    createdLocallyRef.current.add(tid);
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
        is_team: isTeam,
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
    createdLocallyRef.current.add(tid);
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

  // Open the source PDF in Google Drive (the in-app viewer was removed — the hover preview shows
  // the cited passage). No-op if there's no resolvable Drive file id.
  const openSourcePdf = (s: ChatSource) => {
    const id = String(s.gdrive_file_id || "").trim();
    if (id) {
      window.open(`https://drive.google.com/file/d/${encodeURIComponent(id)}/view`, "_blank", "noopener,noreferrer");
    }
  };

  const send = async (overrideText?: string) => {
    const sourceText = overrideText ?? prompt;
    if (!sourceText.trim()) return;
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
          // Title the continuation from the CURRENT message that's starting it (not the old summary).
          const nextTitle = sourceText.trim().slice(0, 42) || comp.title || "Continuation";
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

    const userText = sourceText.trim();
    if (!overrideText) setPrompt("");

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

    // NOTE: the user message is persisted only on SUCCESS (see the persist block after the answer),
    // so a failed turn leaves nothing behind on refresh — both the question and the error vanish.

    const draftId = makeId();
    assistantDraftIdRef.current = draftId;
    pushMessage(tid, {
      id: draftId,
      role: "assistant",
      content: "",
      ts: Date.now(),
      status: "streaming",
      startedAt: Date.now(),
      stage: "Thinking",
      steps: [],
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

    let stageTimer: ReturnType<typeof setInterval> | null = null;

    try {
      const doFetch = async () =>
        fetch(`/api/backend/chat?rid=${encodeURIComponent(clientRequestId)}`, {
          method: "POST",
          headers: { "content-type": "application/json", "cache-control": "no-cache" },
          body: JSON.stringify({
            organization_id: organization?.id ?? null,
            library_ids: selectedLibraryIds,
            message: userText,
            thinking_mode: thinkingMode,
            cross_org: isTeam,
            personalization: personalization ?? undefined,
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

      // Poll the backend for the live "what the agent is doing" stage while it generates, and
      // accumulate each DISTINCT stage into a trail (powers the collapsible "Steps" disclosure).
      const seenStages: string[] = [];
      const pollStage = async () => {
        try {
          const r = await fetch(`/api/backend/chat/status?rid=${encodeURIComponent(clientRequestId)}`, {
            cache: "no-store",
          });
          if (!r.ok) return;
          const j = (await r.json()) as { stage?: string };
          if (j?.stage) {
            const s = String(j.stage);
            if (seenStages[seenStages.length - 1] !== s) seenStages.push(s);
            patchMessage(tid, draftId, { stage: s, steps: [...seenStages] });
          }
        } catch {
          /* ignore */
        }
      };
      stageTimer = setInterval(() => void pollStage(), 800);
      void pollStage();

      let res = await doFetch();

      let raw = await res.text();
      let payload: ChatResponse | { answer: string; [k: string]: unknown } = { answer: raw };
      try {
        payload = JSON.parse(raw) as ChatResponse;
      } catch {
        payload = { answer: raw };
      }

      if (!res.ok) {
        patchMessage(tid, draftId, {
          status: "error",
          content: friendlyChatError(res.status, payload),
          retryText: userText,
        });
        onLog?.({ level: "error", message: "Chat: backend error", details: { status: res.status, payload } });
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
          patchMessage(tid, draftId, {
            status: "error",
            content: friendlyChatError(res.status, errText),
            retryText: userText,
          });
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
          content: "The server kept returning an out-of-date response. Please try again.",
          retryText: userText,
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
      const visuals: ChatVisual[] = Array.isArray((payload as ChatResponse)?.visuals)
        ? ((payload as ChatResponse).visuals as ChatVisual[])
        : [];
      const citations: ChatCitation[] = Array.isArray((payload as ChatResponse)?.citations)
        ? ((payload as ChatResponse).citations as ChatCitation[])
        : [];
      const followups: Array<{ hop: number; query: string }> = Array.isArray((payload as ChatResponse)?.followups)
        ? ((payload as ChatResponse).followups as Array<{ hop: number; query: string }>)
        : [];

      // Answer is in hand — stop polling for the agent stage.
      if (stageTimer) {
        clearInterval(stageTimer);
        stageTimer = null;
      }

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
      patchMessage(tid, draftId, { status: "done", content: answer, sources, visuals, citations, followups });
      onLog?.({
        level: "success",
        message: "Chat: response received",
        details: { sources: sources.length, visuals: visuals.length, followups: followups.length, stale_retries: staleAttempts },
      });

      // Persist the user message + assistant message + sources — only now that the turn succeeded.
      if (organization?.id) {
        try {
          // 1) Persist the user message (held back until success so failed turns leave nothing).
          await supabase.from("chat_messages").insert({
            organization_id: organization.id,
            thread_id: tid,
            role: "user",
            content: userText,
            status: "done",
          });

          // 2) Update the thread title (first message) / activity.
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

          // 3) Persist the assistant message + its sources.
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
      patchMessage(tid, draftId, {
        status: "error",
        content: friendlyChatError(0, err instanceof Error ? err.message : err),
        retryText: userText,
      });
      onLog?.({ level: "error", message: "Chat: request crashed", details: err });
    } finally {
      if (stageTimer) clearInterval(stageTimer);
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
    // Load persisted threads whenever the org OR the chat scope (personal/team) changes.
    setThreads([]);
    setActiveThreadId(null);
    setMessagesByThread({});
    createdLocallyRef.current.clear();
    if (!organization?.id) return;
    void loadThreads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organization?.id, scope]);

  useEffect(() => {
    if (!activeThreadId) return;
    // Threads created this session own their optimistic state — never refetch (it races with the
    // in-flight send and would drop the just-sent user message).
    if (createdLocallyRef.current.has(activeThreadId)) return;
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
                  <div key={m.id}>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-semibold text-white/80">Synapse</span>
                        <span className="text-[10px] text-white/30">{formatClock(m.ts)}</span>
                      </div>

                      {m.status === "error" ? (
                        <div className="rounded-2xl rounded-tl-md border border-rose-500/40 bg-rose-500/10 px-4 py-3">
                          <div className="flex items-start gap-2.5">
                            <FiAlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" />
                            <div className="min-w-0">
                              <div className="text-sm font-medium text-rose-100">{m.content}</div>
                              {m.retryText ? (
                                <button
                                  type="button"
                                  onClick={() => void send(m.retryText)}
                                  className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-rose-400/30 bg-rose-500/15 px-2.5 py-1 text-[11px] font-medium text-rose-100 hover:bg-rose-500/25 transition-colors"
                                >
                                  <FiRefreshCw className="h-3 w-3" /> Try again
                                </button>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      ) : m.status === "streaming" && (m.content || "").trim().length === 0 ? (
                        <AgentStatusLine stage={m.stage || "Thinking"} startedAt={m.startedAt} steps={m.steps} />
                      ) : (
                        <div className="rounded-2xl rounded-tl-md glass px-4 py-3">
                          <ChatAnswer content={m.content} visuals={m.visuals} citations={m.citations} />
                          {m.status === "typing" ? (
                            <span className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-[2px] rounded-full bg-violet-300 animate-pulse" />
                          ) : null}
                          {(m.sources?.length || 0) > 0 ? (
                            <ChatMessageSources sources={m.sources || []} onClickSource={(s) => void openSourcePdf(s)} />
                          ) : null}
                          {m.status !== "typing" ? <AgentStepsTrail steps={m.steps} /> : null}
                        </div>
                      )}

                      {m.status !== "streaming" && m.status !== "typing" && m.status !== "error" ? (
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
                {readyLibraries.length === 0 && pendingLibraries.length === 0 ? (
                  <div className="px-3 py-4 text-sm text-white/45">
                    {isTeam
                      ? "No libraries shared with this team yet."
                      : "No processed libraries yet."}
                  </div>
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
                        <span className="min-w-0 flex items-center gap-2">
                          <FiBookOpen className={`h-3.5 w-3.5 shrink-0 ${checked ? "text-violet-300" : "text-white/35"}`} />
                          <span className="truncate">{l.name}</span>
                          {l.ownerLabel ? (
                            <span className="shrink-0 rounded bg-white/8 px-1.5 py-0.5 text-[10px] text-white/45">{l.ownerLabel}</span>
                          ) : null}
                        </span>
                        {checked ? <FiCheck className="h-4 w-4 text-violet-300 shrink-0" /> : null}
                      </button>
                    );
                  })
                )}

                {/* Present but not finished processing — shown disabled with progress so a shared
                    library that's still ingesting doesn't appear to be "missing". */}
                {pendingLibraries.map((l) => {
                  const pct =
                    typeof l.pipeline_progress_percent === "number"
                      ? Math.round(l.pipeline_progress_percent)
                      : null;
                  const state = (l.pipeline_status || l.status || "processing").toLowerCase();
                  const label = state === "failed" || state === "error" ? "failed" : `processing${pct != null ? ` ${pct}%` : "…"}`;
                  return (
                    <div
                      key={l.id}
                      title="This library is still being processed and can't be used for chat yet."
                      className="w-full flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-sm text-white/35 cursor-not-allowed"
                    >
                      <span className="min-w-0 flex items-center gap-2">
                        <FiBookOpen className="h-3.5 w-3.5 shrink-0 text-white/20" />
                        <span className="truncate">{l.name}</span>
                        {l.ownerLabel ? (
                          <span className="shrink-0 rounded bg-white/6 px-1.5 py-0.5 text-[10px] text-white/30">{l.ownerLabel}</span>
                        ) : null}
                      </span>
                      <span
                        className={`shrink-0 inline-flex items-center gap-1.5 text-[11px] ${
                          label === "failed" ? "text-rose-300/80" : "text-amber-300/80"
                        }`}
                      >
                        {label !== "failed" ? (
                          <span className="h-3 w-3 rounded-full border-2 border-amber-300/30 border-t-amber-300 animate-spin" />
                        ) : null}
                        {label}
                      </span>
                    </div>
                  );
                })}

                {/* Team mode: share your own processed libraries into this team, right here. */}
                {isTeam && shareableLibraries.length > 0 ? (
                  <div className="mt-1.5 border-t border-white/10 pt-2">
                    <div className="px-3 pb-1 text-[10px] uppercase tracking-[0.18em] text-white/35">
                      Share your library with this team
                    </div>
                    {shareableLibraries.map((l) => {
                      const sharing = sharingLibraryId === l.id;
                      return (
                        <button
                          key={l.id}
                          type="button"
                          disabled={sharing || !onShareLibrary}
                          onClick={() => onShareLibrary?.(l.id)}
                          className="w-full flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-sm text-white/70 hover:bg-white/6 transition-colors disabled:opacity-60"
                        >
                          <span className="min-w-0 flex items-center gap-2">
                            <FiBookOpen className="h-3.5 w-3.5 shrink-0 text-white/35" />
                            <span className="truncate">{l.name}</span>
                          </span>
                          <span className="shrink-0 inline-flex items-center gap-1.5 text-[11px] font-medium text-violet-300">
                            {sharing ? (
                              <span className="h-3.5 w-3.5 rounded-full border-2 border-violet-300/40 border-t-violet-300 animate-spin" />
                            ) : (
                              <FiShare2 className="h-3.5 w-3.5" />
                            )}
                            {sharing ? "Sharing…" : "Share"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
              <div className="border-t border-white/10 px-4 py-2 text-[11px] text-white/40">
                {isTeam
                  ? "Shared libraries are visible to everyone on the team."
                  : "Pick multiple libraries to broaden context."}
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

              {/* Thinking-depth selector */}
              <div className="relative shrink-0">
                <button
                  type="button"
                  onClick={() => setModeMenuOpen((v) => !v)}
                  className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-2.5 text-[11px] font-medium text-white/70 hover:text-white hover:border-violet-400/30 transition-colors"
                  title={`Thinking depth: ${THINKING_MODE_META[thinkingMode].label}`}
                >
                  <FiZap className={`h-3.5 w-3.5 ${thinkingMode === "high" ? "text-fuchsia-300" : thinkingMode === "medium" ? "text-violet-300" : "text-white/45"}`} />
                  <span className="hidden sm:inline">{THINKING_MODE_META[thinkingMode].label}</span>
                </button>
                {modeMenuOpen && (
                  <>
                    <button
                      type="button"
                      aria-hidden
                      onClick={() => setModeMenuOpen(false)}
                      className="fixed inset-0 z-20 cursor-default"
                      tabIndex={-1}
                    />
                    <div className="surface-menu absolute bottom-full left-0 z-30 mb-2 w-60 rounded-xl p-1.5 shadow-2xl shadow-black/50">
                      <div className="px-2 py-1 text-[9px] uppercase tracking-wide text-white/35">Thinking depth</div>
                      {(["high", "medium", "low"] as ThinkingMode[]).map((m) => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => changeThinkingMode(m)}
                          className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
                            thinkingMode === m ? "bg-violet-500/20" : "hover:bg-white/6"
                          }`}
                        >
                          <FiZap className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${m === "high" ? "text-fuchsia-300" : m === "medium" ? "text-violet-300" : "text-white/45"}`} />
                          <span className="min-w-0">
                            <span className="flex items-center gap-1.5 text-xs font-medium text-white/90">
                              {THINKING_MODE_META[m].label}
                              {thinkingMode === m ? <FiCheck className="h-3 w-3 text-violet-300" /> : null}
                            </span>
                            <span className="block text-[10px] leading-snug text-white/45">{THINKING_MODE_META[m].desc}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>

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
